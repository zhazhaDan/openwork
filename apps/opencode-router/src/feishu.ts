import type { Logger } from "pino";

import * as lark from "@larksuiteoapi/node-sdk";

import type { Config, FeishuIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import type { InboundMessagePart, MessageDeliveryResult, OutboundMessagePart } from "./media.js";
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
  sendTyping?(peerId: string): Promise<void>;
};

const MAX_TEXT_LENGTH = 30_000;

// Feishu chat_id: oc_ prefix (group) or ou_ prefix (user open_id).
const FEISHU_PEER_ID_PATTERN = /^(oc|ou)_[a-zA-Z0-9_]+$/;

export function isFeishuPeerId(peerId: string): boolean {
  return FEISHU_PEER_ID_PATTERN.test(peerId.trim());
}

export function parseFeishuPeerId(peerId: string): string | null {
  const trimmed = peerId.trim();
  return isFeishuPeerId(trimmed) ? trimmed : null;
}

export function createFeishuAdapter(
  identity: FeishuIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  mediaStore?: MediaStore,
): FeishuAdapter {
  const appId = identity.appId?.trim() ?? "";
  const appSecret = identity.appSecret?.trim() ?? "";
  if (!appId || !appSecret) {
    throw new Error("Feishu appId and appSecret are required for Feishu adapter");
  }

  const log = logger.child({ channel: "feishu", identityId: identity.id });
  log.debug({ appId }, "feishu adapter init");

  const domain = identity.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

  const client = new lark.Client({
    appId,
    appSecret,
    domain,
  });

  let wsClient: any = null;
  let botOpenId: string | null = null;

  // ---------------------------------------------------------------------------
  // Message content parsing
  // ---------------------------------------------------------------------------

  const parseMessageContent = (msgType: string, contentStr: string): { text: string; imageKeys: string[] } => {
    try {
      const content = JSON.parse(contentStr);
      if (msgType === "text") {
        return { text: content.text ?? "", imageKeys: [] };
      }
      if (msgType === "rich_text" || msgType === "post") {
        // Rich text: extract all text elements.
        const texts: string[] = [];
        const imageKeys: string[] = [];
        const walkContent = (node: any) => {
          if (Array.isArray(node)) {
            for (const item of node) walkContent(item);
            return;
          }
          if (node && typeof node === "object") {
            if (node.tag === "text" && node.text) texts.push(node.text);
            if (node.tag === "a" && node.text) texts.push(node.text);
            if (node.tag === "at" && node.user_id) texts.push(`@${node.user_id}`);
            if (node.tag === "img" && node.image_key) imageKeys.push(node.image_key);
            if (node.content) walkContent(node.content);
          }
        };
        // Post format: { zh_cn: { title, content: [[...]] } }
        const lang = content.zh_cn || content.en_us || content.ja_jp || Object.values(content)[0];
        if (lang && typeof lang === "object") {
          const title = typeof lang.title === "string" ? lang.title : "";
          if (title) texts.push(title);
          walkContent(lang.content);
        } else {
          walkContent(content);
        }
        return { text: texts.join(" ").trim(), imageKeys };
      }
      if (msgType === "image") {
        return { text: "", imageKeys: content.image_key ? [content.image_key] : [] };
      }
      return { text: `[${msgType}]`, imageKeys: [] };
    } catch {
      return { text: contentStr, imageKeys: [] };
    }
  };

  // ---------------------------------------------------------------------------
  // Inbound message handling
  // ---------------------------------------------------------------------------

  const handleMessage = async (event: any) => {
    try {
      const message = event?.message;
      if (!message) return;

      const chatId = typeof message.chat_id === "string" ? message.chat_id : "";
      const msgType = typeof message.message_type === "string" ? message.message_type : "";
      const contentStr = typeof message.content === "string" ? message.content : "";
      const senderId = typeof event?.sender?.sender_id?.open_id === "string" ? event.sender.sender_id.open_id : "";

      if (!chatId) return;

      // Ignore own messages.
      if (senderId && botOpenId && senderId === botOpenId) return;

      // Chat type: p2p or group.
      const chatType = typeof message.chat_type === "string" ? message.chat_type : "";
      const isGroup = chatType === "group";

      // In groups, only respond if @mentioned.
      if (isGroup) {
        if (!config.groupsEnabled) {
          log.debug({ chatId, chatType }, "feishu message ignored (groups disabled)");
          return;
        }

        const mentions = Array.isArray(message.mentions) ? message.mentions : [];
        const mentioned = mentions.some((m: any) => {
          const mentionId = typeof m?.id?.open_id === "string" ? m.id.open_id : "";
          return mentionId === botOpenId;
        });
        if (!mentioned) {
          log.debug({ chatId }, "feishu message ignored (not mentioned in group)");
          return;
        }
      }

      const { text: rawText, imageKeys } = parseMessageContent(msgType, contentStr);

      // Strip @bot mention from text.
      let text = rawText;
      if (botOpenId) {
        text = text.replace(new RegExp(`@${botOpenId}\\b`, "g"), "").trim();
      }
      // Also strip @_user_X style mentions that Feishu uses.
      text = text.replace(/@_user_\d+/g, "").trim();

      const parts: InboundMessagePart[] = [];
      if (text) {
        parts.push({ type: "text", text });
      }

      // Handle image attachments.
      for (const imageKey of imageKeys) {
        if (mediaStore) {
          try {
            const imageRes = await (client.im.messageResource.get as any)({
              path: { message_id: message.message_id, file_key: imageKey },
              params: { type: "image" },
            });
            if (imageRes?.data) {
              const stored = await mediaStore.saveInboundBuffer({
                channel: "feishu",
                identityId: identity.id,
                peerId: chatId,
                kind: "image",
                buffer: Buffer.isBuffer(imageRes.data) ? imageRes.data : Buffer.from(imageRes.data),
                filename: `${imageKey}.png`,
                mimeType: "image/png",
              });
              parts.push({
                type: "media",
                media: {
                  id: imageKey,
                  kind: "image",
                  source: "feishu",
                  status: "ready",
                  filePath: stored.filePath,
                  filename: stored.filename,
                  mimeType: stored.mimeType || "image/png",
                  sizeBytes: stored.sizeBytes,
                  providerFileId: imageKey,
                },
              });
            }
          } catch (error) {
            const classified = classifyDeliveryError(error);
            parts.push({
              type: "media",
              media: {
                id: imageKey,
                kind: "image",
                source: "feishu",
                status: "failed",
                providerFileId: imageKey,
                error: `${classified.code}: ${classified.message}`,
              },
            });
          }
        }
      }

      if (parts.length === 0) return;

      const promptText = parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();

      log.debug(
        { chatId, chatType, isGroup, length: promptText.length, preview: promptText.slice(0, 120) },
        "feishu message received",
      );

      await onMessage({
        channel: "feishu",
        identityId: identity.id,
        peerId: chatId,
        text: promptText,
        parts,
        raw: event,
        fromMe: false,
      });
    } catch (error) {
      log.error({ error }, "feishu inbound handler failed");
    }
  };

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  const sendMessageInternal = async (
    peerId: string,
    message: { parts: OutboundMessagePart[] },
  ): Promise<MessageDeliveryResult> => {
    const chatId = parseFeishuPeerId(peerId);
    if (!chatId) {
      const error = new Error("Invalid Feishu peerId (expected oc_ or ou_ prefix)") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    // Determine receive_id_type from prefix.
    const receiveIdType = chatId.startsWith("oc_") ? "chat_id" : "open_id";

    const partResults: MessageDeliveryResult["partResults"] = [];
    let sentParts = 0;

    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      try {
        if (part.type === "text") {
          const chunks = chunkText(part.text, MAX_TEXT_LENGTH);
          for (const chunk of chunks) {
            await withDeliveryRetry(
              "feishu.sendMessage",
              () =>
                client.im.message.create({
                  params: { receive_id_type: receiveIdType },
                  data: {
                    receive_id: chatId,
                    msg_type: "text",
                    content: JSON.stringify({ text: chunk }),
                  },
                }),
              { logger: log },
            );
          }
        } else {
          // File upload: first upload to Feishu, then send as message.
          const { readFile } = await import("node:fs/promises");
          const { basename } = await import("node:path");
          const fileData = await readFile(part.filePath);
          const filename = part.filename || basename(part.filePath);

          const isImage = part.type === "image";

          if (isImage) {
            // Upload as image.
            const uploadRes: any = await withDeliveryRetry(
              "feishu.uploadImage",
              () =>
                (client.im.image.create as any)({
                  data: {
                    image_type: "message",
                    image: {
                      data: fileData,
                      name: filename,
                    },
                  },
                }),
              { logger: log },
            );
            const imageKey = uploadRes?.data?.image_key ?? uploadRes?.image_key;
            if (imageKey) {
              await withDeliveryRetry(
                "feishu.sendImage",
                () =>
                  client.im.message.create({
                    params: { receive_id_type: receiveIdType },
                    data: {
                      receive_id: chatId,
                      msg_type: "image",
                      content: JSON.stringify({ image_key: imageKey }),
                    },
                  }),
                { logger: log },
              );
            }
          } else {
            // Upload as file.
            const uploadRes: any = await withDeliveryRetry(
              "feishu.uploadFile",
              () =>
                (client.im.file.create as any)({
                  data: {
                    file_type: "stream",
                    file_name: filename,
                    file: {
                      data: fileData,
                      name: filename,
                    },
                  },
                }),
              { logger: log },
            );
            const fileKey = uploadRes?.data?.file_key ?? uploadRes?.file_key;
            if (fileKey) {
              await withDeliveryRetry(
                "feishu.sendFile",
                () =>
                  client.im.message.create({
                    params: { receive_id_type: receiveIdType },
                    data: {
                      receive_id: chatId,
                      msg_type: "file",
                      content: JSON.stringify({ file_key: fileKey }),
                    },
                  }),
                { logger: log },
              );
            }
          }

          // If there is a caption, send it as a follow-up text.
          if (part.caption?.trim()) {
            await withDeliveryRetry(
              "feishu.sendCaption",
              () =>
                client.im.message.create({
                  params: { receive_id_type: receiveIdType },
                  data: {
                    receive_id: chatId,
                    msg_type: "text",
                    content: JSON.stringify({ text: part.caption!.trim() }),
                  },
                }),
              { logger: log },
            );
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

    return { attemptedParts: message.parts.length, sentParts, partResults };
  };

  // ---------------------------------------------------------------------------
  // Adapter interface
  // ---------------------------------------------------------------------------

  return {
    name: "feishu",
    identityId: identity.id,
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
      log.debug("feishu adapter starting");

      // Resolve bot open_id.
      try {
        const botInfo = await (client.contact.user.get as any)({
          path: { user_id: "me" },
          params: { user_id_type: "open_id" },
        });
        botOpenId = botInfo?.data?.user?.open_id ?? null;
      } catch {
        // Some SDK versions use a different API. Fallback: leave botOpenId as null.
        log.warn("feishu could not resolve bot open_id; self-message filtering may not work");
      }

      // Start WebSocket long connection.
      const eventDispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: any) => {
          await handleMessage(data);
          return {};
        },
      });

      wsClient = new lark.WSClient({
        appId,
        appSecret,
        domain,
        loggerLevel: lark.LoggerLevel.warn,
      });

      await wsClient.start({ eventDispatcher });
      log.info({ botOpenId }, "feishu adapter started");
    },
    async stop() {
      if (wsClient) {
        try {
          // The WSClient may not have an explicit stop method in all versions.
          if (typeof wsClient.stop === "function") {
            await wsClient.stop();
          } else if (typeof wsClient.close === "function") {
            await wsClient.close();
          }
        } catch (error) {
          log.warn({ error }, "feishu adapter stop failed");
        }
        wsClient = null;
      }
      log.info("feishu adapter stopped");
    },
    async sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }) {
      return sendMessageInternal(peerId, message);
    },
    async sendText(peerId: string, text: string) {
      const result = await sendMessageInternal(peerId, { parts: [{ type: "text", text }] });
      if (result.sentParts === 0) {
        const firstError = result.partResults.find((p) => !p.sent)?.error;
        throw new Error(firstError || "Failed to deliver Feishu text message");
      }
    },
    async sendTyping(_peerId: string) {
      // Feishu does not have a native typing indicator API.
      log.debug("feishu sendTyping: no-op (not supported)");
    },
  };
}
