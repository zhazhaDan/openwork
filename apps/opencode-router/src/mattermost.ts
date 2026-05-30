import type { Logger } from "pino";

import type { Config, MattermostIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import type { InboundMessagePart, MessageDeliveryResult, OutboundMessagePart } from "./media.js";
import type { MediaStore } from "./media-store.js";
import { chunkText } from "./text.js";

export type InboundMessage = {
  channel: "mattermost";
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
  fromMe?: boolean;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type MattermostAdapter = {
  name: "mattermost";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }): Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
  sendTyping?(peerId: string): Promise<void>;
};

const MAX_TEXT_LENGTH = 16_383;

// Mattermost IDs are 26 alphanumeric characters.
const MM_ID_PATTERN = /^[a-z0-9]{26}$/i;

export function isMattermostPeerId(peerId: string): boolean {
  return MM_ID_PATTERN.test(peerId.trim());
}

export function parseMattermostPeerId(peerId: string): string | null {
  const trimmed = peerId.trim();
  return isMattermostPeerId(trimmed) ? trimmed : null;
}

export function createMattermostAdapter(
  identity: MattermostIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  mediaStore?: MediaStore,
): MattermostAdapter {
  const serverUrl = identity.serverUrl?.trim() ?? "";
  const accessToken = identity.accessToken?.trim() ?? "";
  if (!serverUrl) {
    throw new Error("Mattermost serverUrl is required for Mattermost adapter");
  }
  if (!accessToken) {
    throw new Error("Mattermost accessToken is required for Mattermost adapter");
  }

  const log = logger.child({ channel: "mattermost", identityId: identity.id });
  log.debug({ serverUrl }, "mattermost adapter init");

  // Normalise the base URL (strip trailing slash).
  const baseUrl = serverUrl.replace(/\/+$/, "");
  let botUserId: string | null = null;
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------
  // REST helpers
  // ---------------------------------------------------------------------------

  const apiHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  });

  const apiGet = async (path: string) => {
    const res = await fetch(`${baseUrl}/api/v4${path}`, { headers: apiHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const error = new Error(`Mattermost GET ${path}: ${res.status} ${body}`) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    return res.json();
  };

  const apiPost = async (path: string, body: unknown) => {
    const res = await fetch(`${baseUrl}/api/v4${path}`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const error = new Error(`Mattermost POST ${path}: ${res.status} ${text}`) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    return res.json();
  };

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  const connectWebSocket = () => {
    if (stopped) return;

    const wsScheme = baseUrl.startsWith("https") ? "wss" : "ws";
    const wsHost = baseUrl.replace(/^https?:\/\//, "");
    const wsUrl = `${wsScheme}://${wsHost}/api/v4/websocket`;

    log.debug({ wsUrl }, "mattermost ws connecting");

    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      log.error({ error }, "mattermost ws construction failed");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      log.debug("mattermost ws open, authenticating");
      ws?.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: accessToken } }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.event === "posted") {
          void handlePosted(data);
        }
      } catch (error) {
        log.warn({ error }, "mattermost ws message parse failed");
      }
    };

    ws.onerror = (event) => {
      log.warn({ error: (event as any)?.message ?? "ws error" }, "mattermost ws error");
    };

    ws.onclose = () => {
      log.debug("mattermost ws closed");
      if (!stopped) {
        scheduleReconnect();
      }
    };
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, 3000);
  };

  // ---------------------------------------------------------------------------
  // Inbound message handling
  // ---------------------------------------------------------------------------

  const handlePosted = async (wsEvent: any) => {
    try {
      const postStr = typeof wsEvent.data?.post === "string" ? wsEvent.data.post : "";
      if (!postStr) return;
      const post = JSON.parse(postStr);

      // Ignore own messages.
      if (post.user_id === botUserId) return;

      // Ignore system messages.
      if (post.type && post.type !== "") return;

      const channelId = typeof post.channel_id === "string" ? post.channel_id : "";
      const text = typeof post.message === "string" ? post.message : "";
      if (!channelId || !text.trim()) return;

      const parts: InboundMessagePart[] = [];
      if (text.trim()) {
        parts.push({ type: "text", text: text.trim() });
      }

      // File attachments
      if (Array.isArray(post.file_ids) && post.file_ids.length > 0 && mediaStore) {
        for (const fileId of post.file_ids) {
          try {
            const fileMeta = await apiGet(`/files/${fileId}/info`) as any;
            const filename = fileMeta.name || `file-${fileId}`;
            const mimeType = fileMeta.mime_type || undefined;
            const fileUrl = `${baseUrl}/api/v4/files/${fileId}`;
            const stored = await mediaStore.downloadInbound({
              channel: "mattermost",
              identityId: identity.id,
              peerId: channelId,
              kind: mimeType?.startsWith("image/") ? "image" : mimeType?.startsWith("audio/") ? "audio" : "file",
              url: fileUrl,
              headers: { Authorization: `Bearer ${accessToken}` },
              filename,
              mimeType,
            });
            parts.push({
              type: "media",
              media: {
                id: fileId,
                kind: stored.mimeType?.startsWith("image/") ? "image" : stored.mimeType?.startsWith("audio/") ? "audio" : "file",
                source: "mattermost",
                status: "ready",
                filePath: stored.filePath,
                filename: stored.filename,
                ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
                sizeBytes: stored.sizeBytes,
                providerFileId: fileId,
              },
            });
          } catch (error) {
            const classified = classifyDeliveryError(error);
            parts.push({
              type: "media",
              media: {
                id: fileId,
                kind: "file",
                source: "mattermost",
                status: "failed",
                providerFileId: fileId,
                error: `${classified.code}: ${classified.message}`,
              },
            });
          }
        }
      }

      const promptText = parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();

      log.debug(
        { channelId, length: promptText.length, preview: promptText.slice(0, 120) },
        "mattermost message received",
      );

      await onMessage({
        channel: "mattermost",
        identityId: identity.id,
        peerId: channelId,
        text: promptText,
        parts,
        raw: post,
        fromMe: false,
      });
    } catch (error) {
      log.error({ error }, "mattermost inbound handler failed");
    }
  };

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  const sendMessageInternal = async (
    peerId: string,
    message: { parts: OutboundMessagePart[] },
  ): Promise<MessageDeliveryResult> => {
    const channelId = parseMattermostPeerId(peerId);
    if (!channelId) {
      const error = new Error("Invalid Mattermost peerId (expected 26-char channel_id)") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const partResults: MessageDeliveryResult["partResults"] = [];
    let sentParts = 0;

    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      try {
        if (part.type === "text") {
          const chunks = chunkText(part.text, MAX_TEXT_LENGTH);
          for (const chunk of chunks) {
            await withDeliveryRetry(
              "mattermost.createPost",
              () => apiPost("/posts", { channel_id: channelId, message: chunk }),
              { logger: log },
            );
          }
        } else {
          // File upload via multipart form.
          const { readFile } = await import("node:fs/promises");
          const { basename } = await import("node:path");
          const fileData = await readFile(part.filePath);
          const filename = part.filename || basename(part.filePath);

          const form = new FormData();
          form.append("channel_id", channelId);
          form.append("files", new Blob([fileData]), filename);

          const uploadRes = await fetch(`${baseUrl}/api/v4/files`, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}` },
            body: form,
          });
          if (!uploadRes.ok) {
            const text = await uploadRes.text().catch(() => "");
            throw new Error(`Mattermost file upload failed: ${uploadRes.status} ${text}`);
          }
          const uploadResult = (await uploadRes.json()) as any;
          const fileInfos = Array.isArray(uploadResult?.file_infos) ? uploadResult.file_infos : [];
          const fileIds = fileInfos.map((f: any) => f.id).filter(Boolean);

          await withDeliveryRetry(
            "mattermost.createPost",
            () =>
              apiPost("/posts", {
                channel_id: channelId,
                message: part.caption?.trim() || "",
                file_ids: fileIds,
              }),
            { logger: log },
          );
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
    name: "mattermost",
    identityId: identity.id,
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
      log.debug("mattermost adapter starting");
      stopped = false;
      const me = (await apiGet("/users/me")) as any;
      botUserId = typeof me?.id === "string" ? me.id : null;
      log.debug({ botUserId }, "mattermost bot user resolved");
      connectWebSocket();
      log.info({ botUserId }, "mattermost adapter started");
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch (_) {}
        ws = null;
      }
      log.info("mattermost adapter stopped");
    },
    async sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }) {
      return sendMessageInternal(peerId, message);
    },
    async sendText(peerId: string, text: string) {
      const result = await sendMessageInternal(peerId, { parts: [{ type: "text", text }] });
      if (result.sentParts === 0) {
        const firstError = result.partResults.find((p) => !p.sent)?.error;
        throw new Error(firstError || "Failed to deliver Mattermost text message");
      }
    },
    async sendTyping(peerId: string) {
      const channelId = parseMattermostPeerId(peerId);
      if (!channelId) return;
      try {
        await apiPost(`/users/me/typing`, { channel_id: channelId });
      } catch (error) {
        log.debug({ error, channelId }, "mattermost typing indicator failed");
      }
    },
  };
}
