import * as lark from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";

import type { Config, FeishuIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import type { InboundMessagePart, MediaKind, MessageDeliveryResult, OutboundMessagePart } from "./media.js";
import type { MediaStore } from "./media-store.js";
import { chunkText } from "./text.js";

export type InboundMessage = {
  channel: "feishu";
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
  fromMe?: boolean;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type FeishuAdapter = {
  name: "feishu";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }): Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
};

// Feishu text messages allow ~150KB per content, but we chunk conservatively
// to leave headroom and keep UX readable. 4000 chars mirrors Telegram flow.
const MAX_TEXT_LENGTH = 4000;

// Feishu IDs are prefixed: "ou_" for users (open_id), "oc_" for chats (chat_id).
const FEISHU_PEER_ID_PATTERN = /^(ou_|oc_)[A-Za-z0-9_-]+$/;

export function isFeishuPeerId(peerId: string): boolean {
  return FEISHU_PEER_ID_PATTERN.test(peerId.trim());
}

function receiveIdTypeFor(peerId: string): "open_id" | "chat_id" {
  return peerId.trim().startsWith("oc_") ? "chat_id" : "open_id";
}

function invalidFeishuPeerIdError(): Error & { status?: number } {
  const error = new Error(
    "Feishu peerId must start with 'ou_' (open_id) or 'oc_' (chat_id).",
  ) as Error & { status?: number };
  error.status = 400;
  return error;
}

type FeishuMediaCandidate = {
  kind: MediaKind;
  fileKey: string;
  filename?: string;
  mimeType?: string;
};

/**
 * Strip @mentions from inbound text using the `mentions` array provided by
 * Feishu. Feishu substitutes mentions with `@_user_N` placeholders in the
 * `text` field, matched by the `key` property in each mention object.
 */
function stripMentions(text: string, mentions: Array<{ key: string }> | undefined): string {
  if (!mentions || mentions.length === 0) return text;
  let result = text;
  for (const mention of mentions) {
    if (!mention?.key) continue;
    result = result.split(mention.key).join("");
  }
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Extract plaintext from a Feishu "post" (rich text) message.
 * Structure: `{ post: { <lang>: { title, content: [[{ tag, text }, ...], ...] } } }`
 */
function extractPostText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const post = (content as any).post;
  if (!post || typeof post !== "object") return "";
  // Pick the first available locale
  const langKey = Object.keys(post)[0];
  if (!langKey) return "";
  const doc = post[langKey];
  if (!doc || typeof doc !== "object") return "";
  const title = typeof doc.title === "string" ? doc.title : "";
  const blocks = Array.isArray(doc.content) ? doc.content : [];
  const lines: string[] = [];
  for (const line of blocks) {
    if (!Array.isArray(line)) continue;
    const parts: string[] = [];
    for (const node of line) {
      if (node && typeof node === "object" && typeof (node as any).text === "string") {
        parts.push((node as any).text);
      }
    }
    if (parts.length) lines.push(parts.join(""));
  }
  const body = lines.join("\n").trim();
  return [title, body].filter(Boolean).join("\n").trim();
}

export function createFeishuAdapter(
  identity: FeishuIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  mediaStore?: MediaStore,
  deps: { Client?: typeof lark.Client; WSClient?: typeof lark.WSClient; EventDispatcher?: typeof lark.EventDispatcher } = {},
): FeishuAdapter {
  const appId = identity.appId?.trim() ?? "";
  const appSecret = identity.appSecret?.trim() ?? "";
  if (!appId || !appSecret) {
    throw new Error("Feishu appId and appSecret are required for Feishu adapter");
  }

  const log = logger.child({ channel: "feishu", identityId: identity.id });
  log.debug({ hasCredentials: true }, "feishu adapter init");

  const domain = identity.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

  const ClientImpl = deps.Client ?? lark.Client;
  const WSClientImpl = deps.WSClient ?? lark.WSClient;
  const EventDispatcherImpl = deps.EventDispatcher ?? lark.EventDispatcher;

  const client = new ClientImpl({
    appId,
    appSecret,
    domain,
    loggerLevel: lark.LoggerLevel.warn,
  });

  const wsClient = new WSClientImpl({
    appId,
    appSecret,
    domain,
    loggerLevel: lark.LoggerLevel.warn,
  });

  // Cache bot's own open_id lazily so we can detect self-@mentions reliably
  // without an extra synchronous request at startup (which is known to flake
  // under multi-identity concurrent startup).
  let botOpenId: string | null = null;

  const isBotMention = (mention: { id?: { open_id?: string } }): boolean => {
    if (!mention?.id?.open_id) return false;
    if (botOpenId === null) {
      // First mention we ever see in a group is treated as the bot itself (best-effort).
      // The ACL on Feishu side ensures we only receive events from chats the bot is in,
      // and in practice the first inbound mention in a group chat is always to the bot.
      return true;
    }
    return mention.id.open_id === botOpenId;
  };

  const downloadCandidate = async (
    messageId: string,
    peerId: string,
    candidate: FeishuMediaCandidate,
  ): Promise<InboundMessagePart> => {
    if (!mediaStore) {
      return {
        type: "media",
        media: {
          id: candidate.fileKey,
          kind: candidate.kind,
          source: "feishu",
          status: "failed",
          providerFileId: candidate.fileKey,
          ...(candidate.filename ? { filename: candidate.filename } : {}),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          error: "media store unavailable",
        },
      };
    }

    try {
      // Feishu returns an object exposing getReadableStream() — we drain it
      // to a buffer and persist via mediaStore.saveInboundBuffer.
      const resource = await withDeliveryRetry(
        "feishu.messageResource.get",
        () =>
          client.im.messageResource.get({
            path: { message_id: messageId, file_key: candidate.fileKey },
            params: { type: candidate.kind === "image" ? "image" : "file" },
          }),
        { logger: log },
      );

      const stream = resource.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const buffer = Buffer.concat(chunks);

      const stored = await mediaStore.saveInboundBuffer({
        channel: "feishu",
        identityId: identity.id,
        peerId,
        kind: candidate.kind,
        buffer: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        ...(candidate.filename ? { filename: candidate.filename } : {}),
        ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
      });

      return {
        type: "media",
        media: {
          id: candidate.fileKey,
          kind: candidate.kind,
          source: "feishu",
          status: "ready",
          filePath: stored.filePath,
          filename: stored.filename,
          ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
          sizeBytes: stored.sizeBytes,
          providerFileId: candidate.fileKey,
        },
      };
    } catch (error) {
      const classified = classifyDeliveryError(error);
      return {
        type: "media",
        media: {
          id: candidate.fileKey,
          kind: candidate.kind,
          source: "feishu",
          status: "failed",
          providerFileId: candidate.fileKey,
          ...(candidate.filename ? { filename: candidate.filename } : {}),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          error: `${classified.code}: ${classified.message}`,
        },
      };
    }
  };

  const handleIncomingMessage = async (data: any) => {
    const msg = data?.message;
    const sender = data?.sender;
    if (!msg || !sender) return;

    // Ignore messages from other bots / apps
    if (sender.sender_type === "app") {
      log.debug({ messageId: msg.message_id }, "feishu message ignored (app-originated)");
      return;
    }

    const isP2P = msg.chat_type === "p2p";
    const mentions: Array<{ key: string; id?: { open_id?: string }; name?: string }> =
      Array.isArray(msg.mentions) ? msg.mentions : [];

    // Group messages require the bot to be @mentioned. We use the first-seen
    // mention heuristic (see isBotMention) until we learn our open_id.
    if (!isP2P) {
      const mentionedBot = mentions.some(isBotMention);
      if (!mentionedBot) {
        log.debug({ chatId: msg.chat_id }, "feishu group message ignored (not mentioned)");
        return;
      }
      // Record our own open_id from the matching mention so future filtering is exact.
      if (botOpenId === null) {
        const first = mentions[0];
        if (first?.id?.open_id) {
          botOpenId = first.id.open_id;
          log.debug({ botOpenId }, "feishu bot open_id learned");
        }
      }
    }

    // Parse content (Feishu wraps content in a JSON string)
    let contentObj: any = {};
    try {
      contentObj = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content ?? {};
    } catch (error) {
      log.warn({ error, messageId: msg.message_id }, "feishu failed to parse message content");
      return;
    }

    let text = "";
    const mediaCandidates: FeishuMediaCandidate[] = [];

    switch (msg.message_type) {
      case "text": {
        const rawText = typeof contentObj.text === "string" ? contentObj.text : "";
        text = stripMentions(rawText, mentions);
        break;
      }
      case "post": {
        text = stripMentions(extractPostText(contentObj), mentions);
        break;
      }
      case "image": {
        const imageKey = typeof contentObj.image_key === "string" ? contentObj.image_key : "";
        if (imageKey) {
          mediaCandidates.push({ kind: "image", fileKey: imageKey, mimeType: "image/jpeg" });
        }
        break;
      }
      case "file": {
        const fileKey = typeof contentObj.file_key === "string" ? contentObj.file_key : "";
        const fileName = typeof contentObj.file_name === "string" ? contentObj.file_name : undefined;
        if (fileKey) {
          mediaCandidates.push({ kind: "file", fileKey, filename: fileName });
        }
        break;
      }
      case "audio": {
        const fileKey = typeof contentObj.file_key === "string" ? contentObj.file_key : "";
        if (fileKey) {
          mediaCandidates.push({ kind: "audio", fileKey });
        }
        break;
      }
      case "media": {
        // Video message; store as file
        const fileKey = typeof contentObj.file_key === "string" ? contentObj.file_key : "";
        const fileName = typeof contentObj.file_name === "string" ? contentObj.file_name : undefined;
        if (fileKey) {
          mediaCandidates.push({ kind: "file", fileKey, filename: fileName });
        }
        break;
      }
      default: {
        log.debug({ messageType: msg.message_type }, "feishu message type not handled");
        return;
      }
    }

    const trimmedText = text.trim();
    if (!trimmedText && mediaCandidates.length === 0) {
      return;
    }

    const peerId = isP2P
      ? String(sender.sender_id?.open_id ?? msg.chat_id ?? "")
      : String(msg.chat_id ?? "");
    if (!peerId) {
      log.warn({ messageId: msg.message_id }, "feishu inbound missing peer id");
      return;
    }

    const parts: InboundMessagePart[] = [];
    if (trimmedText) parts.push({ type: "text", text: trimmedText });

    for (const candidate of mediaCandidates) {
      const part = await downloadCandidate(String(msg.message_id), peerId, candidate);
      parts.push(part);
    }

    log.debug(
      {
        chatId: msg.chat_id,
        chatType: msg.chat_type,
        length: trimmedText.length,
        preview: trimmedText.slice(0, 120),
        mediaCount: mediaCandidates.length,
      },
      "feishu message received",
    );

    try {
      await onMessage({
        channel: "feishu",
        identityId: identity.id,
        peerId,
        text: trimmedText,
        parts,
        raw: data,
      });
    } catch (error) {
      log.error({ error, peerId }, "feishu inbound handler failed");
    }
  };

  const eventDispatcher = new EventDispatcherImpl({
    loggerLevel: lark.LoggerLevel.warn,
  }).register({
    "im.message.receive_v1": async (data: any) => {
      try {
        await handleIncomingMessage(data);
      } catch (error) {
        log.error({ error }, "feishu dispatcher error");
      }
      return { code: 0 };
    },
  });

  const sendTextChunked = async (
    peerId: string,
    text: string,
    idType: "open_id" | "chat_id",
  ): Promise<void> => {
    const chunks = chunkText(text, MAX_TEXT_LENGTH);
    for (const chunk of chunks) {
      await withDeliveryRetry(
        "feishu.im.message.create.text",
        () =>
          client.im.message.create({
            params: { receive_id_type: idType },
            data: {
              receive_id: peerId,
              msg_type: "text",
              content: JSON.stringify({ text: chunk }),
            },
          }),
        { logger: log },
      );
    }
  };

  const uploadImage = async (filePath: string): Promise<string> => {
    const fs = await import("node:fs");
    const stream = fs.createReadStream(filePath);
    const response = await withDeliveryRetry(
      "feishu.im.image.create",
      () =>
        client.im.image.create({
          data: {
            image_type: "message",
            image: stream,
          },
        }),
      { logger: log },
    );
    const key = response?.image_key;
    if (!key) {
      throw new Error("Feishu image upload returned no image_key");
    }
    return key;
  };

  const feishuFileTypeForExtension = (
    filename: string | undefined,
  ): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" => {
    const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
    if (ext === "opus") return "opus";
    if (ext === "mp4") return "mp4";
    if (ext === "pdf") return "pdf";
    if (ext === "doc" || ext === "docx") return "doc";
    if (ext === "xls" || ext === "xlsx") return "xls";
    if (ext === "ppt" || ext === "pptx") return "ppt";
    return "stream";
  };

  const uploadFile = async (
    filePath: string,
    filename: string | undefined,
    kind: MediaKind,
  ): Promise<string> => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const stream = fs.createReadStream(filePath);
    const fileName = filename || path.basename(filePath);
    const fileType = kind === "audio" ? "opus" : feishuFileTypeForExtension(fileName);
    const response = await withDeliveryRetry(
      "feishu.im.file.create",
      () =>
        client.im.file.create({
          data: {
            file_type: fileType,
            file_name: fileName,
            file: stream,
          },
        }),
      { logger: log },
    );
    const key = response?.file_key;
    if (!key) {
      throw new Error("Feishu file upload returned no file_key");
    }
    return key;
  };

  const sendMessageInternal = async (
    peerId: string,
    message: { parts: OutboundMessagePart[] },
  ): Promise<MessageDeliveryResult> => {
    if (!isFeishuPeerId(peerId)) {
      throw invalidFeishuPeerIdError();
    }
    const idType = receiveIdTypeFor(peerId);

    const partResults: MessageDeliveryResult["partResults"] = [];
    let sentParts = 0;

    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      try {
        if (part.type === "text") {
          await sendTextChunked(peerId, part.text, idType);
        } else if (part.type === "image") {
          const imageKey = await uploadImage(part.filePath);
          await withDeliveryRetry(
            "feishu.im.message.create.image",
            () =>
              client.im.message.create({
                params: { receive_id_type: idType },
                data: {
                  receive_id: peerId,
                  msg_type: "image",
                  content: JSON.stringify({ image_key: imageKey }),
                },
              }),
            { logger: log },
          );
          if (part.caption?.trim()) {
            await sendTextChunked(peerId, part.caption.trim(), idType);
          }
        } else {
          // audio / file → uploaded via im.file.create
          const fileKey = await uploadFile(part.filePath, part.filename, part.type);
          const msgType = part.type === "audio" ? "audio" : "file";
          await withDeliveryRetry(
            `feishu.im.message.create.${msgType}`,
            () =>
              client.im.message.create({
                params: { receive_id_type: idType },
                data: {
                  receive_id: peerId,
                  msg_type: msgType,
                  content: JSON.stringify({ file_key: fileKey }),
                },
              }),
            { logger: log },
          );
          if (part.caption?.trim()) {
            await sendTextChunked(peerId, part.caption.trim(), idType);
          }
        }

        sentParts += 1;
        partResults.push({ index, type: part.type, sent: true });
      } catch (error) {
        const classified = classifyDeliveryError(error);
        partResults.push({
          index,
          type: part.type,
          sent: false,
          error: classified.message,
          code: classified.code,
          retryable: classified.retryable,
        });
      }
    }

    return {
      attemptedParts: message.parts.length,
      sentParts,
      partResults,
    };
  };

  return {
    name: "feishu",
    identityId: identity.id,
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
      log.debug("feishu adapter starting");
      // Known issue: wsClient.start() occasionally hangs on newer Node versions.
      // Apply a 30s startup timeout so misconfigurations surface quickly instead
      // of silently stalling the whole bridge boot-up.
      const startPromise = wsClient.start({ eventDispatcher });
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("feishu wsClient.start timeout after 30s")),
          30_000,
        );
      });
      try {
        await Promise.race([startPromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      log.info("feishu adapter started");
    },
    async stop() {
      try {
        wsClient.close({ force: true });
      } catch (error) {
        log.warn({ error }, "feishu wsClient close threw");
      }
      log.info("feishu adapter stopped");
    },
    async sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }) {
      return sendMessageInternal(peerId, message);
    },
    async sendText(peerId: string, text: string) {
      const result = await sendMessageInternal(peerId, {
        parts: [{ type: "text", text }],
      });
      if (result.sentParts === 0) {
        const firstError = result.partResults.find((part) => !part.sent)?.error;
        throw new Error(firstError || "Failed to deliver Feishu text message");
      }
    },
  };
}
