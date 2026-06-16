/**
 * wecom-aibot.ts — 企业微信智能机器人 Channel Adapter
 *
 * 基于官方 @wecom/aibot-node-sdk WebSocket 长连接通道：
 *   - 客户端主动连企微，不需要公网 URL / 域名 / IP 白名单
 *   - 凭证：botId + secret
 *   - 流式回复支持（aibot_respond_msg with finish=false/true）
 *
 * 接口形状与 feishu/wecom adapter 一致，对上层完全透明。
 *
 * 官方文档：https://developer.work.weixin.qq.com/document/path/101463
 */
import type { Logger } from "pino";
import { WSClient, MessageType, EventType, generateRandomString } from "@wecom/aibot-node-sdk";
import type {
  WsFrame,
  WsFrameHeaders,
  BaseMessage,
  TextMessage,
  EventMessage,
  EventMessageWith,
  EnterChatEvent,
  DisconnectedEventData,
  TemplateCard,
} from "@wecom/aibot-node-sdk";

import type { Config, WeComBotIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import type {
  InboundMessagePart,
  MessageDeliveryResult,
  OutboundMessagePart,
  PartDeliveryResult,
} from "./media.js";
import type { MediaStore } from "./media-store.js";
import { chunkText } from "./text.js";

// ---------------------------------------------------------------------------
// 公共类型（保持与 feishu/wecom 一致）
// ---------------------------------------------------------------------------

export type InboundMessage = {
  channel: "wecom-aibot";
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
  fromMe?: boolean;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type WeComBotOutboundMeta = {
  kind?: "reply" | "system" | "tool";
  model?: string;
  agent?: string;
  /** 流式消息 ID。提供时走流式更新，否则按整段文本一次性发送（仍是流式协议，finish=true） */
  streamId?: string;
  /** 显式覆盖回复用的 WsFrame（多用户场景下，业务层需要把"待回复"的入站帧透传给发送方） */
  replyFrame?: WsFrameHeaders;
  /** finish 标志，仅在 streamId 提供时有效；默认 true */
  finish?: boolean;
  /**
   * 企微模板卡片对象。提供时在所有 parts 发送后附加发送卡片。
   * 支持文本卡片、图文展示、关键数据、投票选择、多项选择等类型。
   * 结构参考：https://developer.work.weixin.qq.com/document/path/101463#模板卡片消息
   */
  templateCard?: TemplateCard;
};

export type WeComBotAdapter = {
  name: "wecom-aibot";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(
    peerId: string,
    message: { parts: OutboundMessagePart[]; meta?: WeComBotOutboundMeta },
  ): Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
  sendTyping?(peerId: string): Promise<void>;
  markComplete?(messageId: string): Promise<void>;
  getBotName?(): string | null;
};

// 流式回复内容长度上限（来自 SDK 协议）。
const MAX_TEXT_LENGTH = 20480;

// peerId 设计：single 单聊用 userid，group 群聊用 chatid；为消歧加前缀。
const SINGLE_PREFIX = "single:";
const GROUP_PREFIX = "group:";

const WECOM_BOT_PEER_PATTERN = /^(single|group):[a-zA-Z0-9_@.\-]+$/;

export function isWeComBotPeerId(peerId: string): boolean {
  return WECOM_BOT_PEER_PATTERN.test(peerId.trim());
}

export function parseWeComBotPeerId(
  peerId: string,
): { scope: "single" | "group"; chatid: string } | null {
  const trimmed = peerId.trim();
  if (!WECOM_BOT_PEER_PATTERN.test(trimmed)) return null;
  const [scope, ...rest] = trimmed.split(":");
  return { scope: scope as "single" | "group", chatid: rest.join(":") };
}

function buildPeerId(message: BaseMessage): string {
  if (message.chattype === "group" && message.chatid) {
    return `${GROUP_PREFIX}${message.chatid}`;
  }
  return `${SINGLE_PREFIX}${message.from?.userid ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Adapter 工厂
// ---------------------------------------------------------------------------

export function createWeComBotAdapter(
  identity: WeComBotIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  _mediaStore?: MediaStore,
): WeComBotAdapter {
  const botId = identity.botId?.trim() ?? "";
  const secret = identity.secret?.trim() ?? "";

  if (!botId || !secret) {
    throw new Error("wecom-aibot: botId 和 secret 必填");
  }

  const log = logger.child({ channel: "wecom-aibot", identityId: identity.id });
  log.debug({ botId }, "wecom-aibot adapter init");

  /**
   * 入站消息记录：用同一 peerId 的最近一帧作为"回复目标"，
   * 这样上层 sendMessage(peerId, ...) 不传 replyFrame 时也能找到正确的 req_id。
   * 注意：SDK 文档要求 5 秒内回复事件帧；超时后用 sendMessage（主动推送）兜底。
   */
  const lastInboundFrame = new Map<string, WsFrameHeaders>();

  let wsClient: WSClient | null = null;
  let started = false;

  // -------------------------------------------------------------------------
  // 解析入站消息 → 上层 InboundMessage
  // -------------------------------------------------------------------------

  const extractText = (msg: BaseMessage): string => {
    if (msg.msgtype === MessageType.Text) {
      return (msg as TextMessage).text?.content ?? "";
    }
    if (msg.msgtype === MessageType.Voice) {
      // 语音转文字
      return (msg as any).voice?.content ?? "";
    }
    if (msg.msgtype === MessageType.Mixed) {
      const items = (msg as any).mixed?.msg_item ?? [];
      return items
        .filter((it: any) => it.msgtype === "text" && it.text?.content)
        .map((it: any) => it.text.content)
        .join(" ")
        .trim();
    }
    // 其他类型暂时不解析为文本
    return "";
  };

  const handleInbound = async (frame: WsFrame<BaseMessage>) => {
    const body = frame.body;
    if (!body) return;
    try {
      const peerId = buildPeerId(body);

      // 记录回复目标帧
      lastInboundFrame.set(peerId, { headers: frame.headers });

      const text = extractText(body);
      const parts: InboundMessagePart[] = [];
      if (text) parts.push({ type: "text", text });

      // 处理媒体附件（图片/文件/语音/视频/混排里的图片）
      const mediaTargets: Array<{
        url: string;
        aeskey?: string;
        kind: "image" | "file" | "audio";
        providerFileId: string;
      }> = [];

      if (body.msgtype === MessageType.Image) {
        const img = (body as any).image;
        if (img?.url) {
          mediaTargets.push({
            url: img.url,
            aeskey: img.aeskey,
            kind: "image",
            providerFileId: `wecom-aibot-image-${frame.headers.req_id}`,
          });
        }
      } else if (body.msgtype === MessageType.File) {
        const f = (body as any).file;
        if (f?.url) {
          mediaTargets.push({
            url: f.url,
            aeskey: f.aeskey,
            kind: "file",
            providerFileId: `wecom-aibot-file-${frame.headers.req_id}`,
          });
        }
      } else if (body.msgtype === MessageType.Voice) {
        // 语音文本已通过 extractText 提取；这里再附带原始音频文件供 Agent 处理
        const v = (body as any).voice;
        if (v?.url) {
          mediaTargets.push({
            url: v.url,
            aeskey: v.aeskey,
            kind: "audio",
            providerFileId: `wecom-aibot-voice-${frame.headers.req_id}`,
          });
        }
      } else if (body.msgtype === MessageType.Mixed) {
        const items = (body as any).mixed?.msg_item ?? [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (it.msgtype === "image" && it.image?.url) {
            mediaTargets.push({
              url: it.image.url,
              aeskey: it.image.aeskey,
              kind: "image",
              providerFileId: `wecom-aibot-mixed-${frame.headers.req_id}-${i}`,
            });
          }
        }
      }

      // 下载并入库到 mediaStore（若提供）
      if (mediaTargets.length > 0 && _mediaStore && wsClient) {
        for (const target of mediaTargets) {
          try {
            const { buffer, filename } = await wsClient.downloadFile(target.url, target.aeskey);
            const stored = await _mediaStore.saveInboundBuffer({
              channel: "wecom-aibot",
              identityId: identity.id,
              peerId,
              kind: target.kind,
              buffer,
              filename: filename ?? `${target.providerFileId}.bin`,
              mimeType:
                target.kind === "image"
                  ? "image/png"
                  : target.kind === "audio"
                    ? "audio/amr"
                    : "application/octet-stream",
            });
            parts.push({
              type: "media",
              media: {
                id: target.providerFileId,
                kind: target.kind,
                source: "wecom-aibot",
                status: "ready",
                filePath: stored.filePath,
                filename: stored.filename,
                mimeType: stored.mimeType,
                sizeBytes: stored.sizeBytes,
                providerFileId: target.providerFileId,
              },
            });
            log.debug(
              { providerFileId: target.providerFileId, kind: target.kind, sizeBytes: stored.sizeBytes },
              "wecom-aibot 入站媒体已保存",
            );
          } catch (error) {
            const classified = classifyDeliveryError(error);
            log.warn(
              { error, providerFileId: target.providerFileId, code: classified.code },
              "wecom-aibot 入站媒体下载失败",
            );
            parts.push({
              type: "media",
              media: {
                id: target.providerFileId,
                kind: target.kind,
                source: "wecom-aibot",
                status: "failed",
                providerFileId: target.providerFileId,
                error: `${classified.code}: ${classified.message}`,
              },
            });
          }
        }
      }

      // 群聊只在 @ 机器人时才会触发，本身就该响应；单聊全部响应
      if (parts.length === 0) {
        log.debug({ msgtype: body.msgtype, peerId }, "wecom-aibot 不支持的入站消息类型，已跳过");
        return;
      }

      log.info(
        {
          msgtype: body.msgtype,
          peerId,
          chattype: body.chattype,
          preview: text.slice(0, 120),
          mediaCount: mediaTargets.length,
        },
        "wecom-aibot 收到消息",
      );

      await onMessage({
        channel: "wecom-aibot",
        identityId: identity.id,
        peerId,
        text,
        parts,
        raw: frame,
      });
    } catch (error) {
      log.error({ error }, "wecom-aibot handleInbound 失败");
    }
  };

  // -------------------------------------------------------------------------
  // 事件回调（进入会话 / 断连 / 卡片点击）
  // -------------------------------------------------------------------------

  const handleEnterChat = async (frame: WsFrame<EventMessageWith<EnterChatEvent>>) => {
    // 用户首次进入机器人单聊：回欢迎语
    if (!wsClient) return;
    try {
      await wsClient.replyWelcome(
        { headers: frame.headers },
        {
          msgtype: "text",
          text: { content: "你好，我是悟东 AI 助手，发消息即可对话。" },
        },
      );
    } catch (error) {
      log.warn({ error }, "wecom-aibot 欢迎语回复失败（可能已超时）");
    }
  };

  const handleDisconnected = (frame: WsFrame<EventMessageWith<DisconnectedEventData>>) => {
    log.warn({ reqId: frame.headers.req_id }, "wecom-aibot 收到 disconnected 事件，服务端主动断开旧连接");
  };

  /**
   * 用户点击模板卡片按钮事件。
   * 把它作为特殊的入站消息上报：text 形如 "[card:<event_key>]"，
   * raw 中保留完整事件对象，业务层可据此做交互逻辑（如多轮对话状态机）。
   */
  const handleTemplateCardEvent = async (
    frame: WsFrame<EventMessageWith<import("@wecom/aibot-node-sdk").TemplateCardEventData>>,
  ) => {
    const body = frame.body;
    if (!body) return;
    try {
      const peerId = buildPeerId(body as unknown as BaseMessage);
      // 卡片点击也算"待回复"事件，记录帧用于 5 秒内更新卡片或回复
      lastInboundFrame.set(peerId, { headers: frame.headers });

      const eventKey = body.event?.event_key ?? "";
      const taskId = body.event?.task_id ?? "";
      const text = `[card:${eventKey || taskId || "unknown"}]`;

      log.info({ peerId, eventKey, taskId }, "wecom-aibot 卡片按钮事件");

      await onMessage({
        channel: "wecom-aibot",
        identityId: identity.id,
        peerId,
        text,
        parts: [{ type: "text", text }],
        raw: frame,
      });
    } catch (error) {
      log.error({ error }, "wecom-aibot handleTemplateCardEvent 失败");
    }
  };

  // -------------------------------------------------------------------------
  // 发送消息
  // -------------------------------------------------------------------------

  const sendMessage = async (
    peerId: string,
    message: { parts: OutboundMessagePart[]; meta?: WeComBotOutboundMeta },
  ): Promise<MessageDeliveryResult> => {
    const parsed = parseWeComBotPeerId(peerId);
    if (!parsed) {
      const error = new Error(
        `Invalid wecom-aibot peerId（应为 single:<userid> 或 group:<chatid>）: ${peerId}`,
      ) as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    if (!wsClient) {
      const error = new Error("wecom-aibot adapter not started") as Error & { status?: number };
      error.status = 503;
      throw error;
    }

    const partResults: PartDeliveryResult[] = [];
    let sentParts = 0;

    // 优先用 meta.replyFrame；否则用 lastInboundFrame；都没有则只能走主动推送 sendMessage
    const replyFrame: WsFrameHeaders | undefined =
      message.meta?.replyFrame ?? lastInboundFrame.get(peerId);

    const streamId = message.meta?.streamId ?? generateRandomString(16);
    const finish = message.meta?.finish ?? true;

    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index];
      try {
        if (part.type === "text") {
          const chunks = chunkText(part.text, MAX_TEXT_LENGTH);
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const isLast = i === chunks.length - 1;
            if (replyFrame) {
              // 被动回复（5 秒内必须发首帧）
              await withDeliveryRetry(
                "wecom-aibot.replyStream",
                () => wsClient!.replyStream(replyFrame, streamId, chunk, isLast && finish),
                { logger: log },
              );
            } else {
              // 主动推送：peer 是 single 时填 userid，group 时填 chatid（SDK 都用 chatid 参数）
              await withDeliveryRetry(
                "wecom-aibot.sendMessage",
                () =>
                  wsClient!.sendMessage(parsed.chatid, {
                    msgtype: "markdown",
                    markdown: { content: chunk },
                  }),
                { logger: log },
              );
            }
          }
        } else if (part.type === "image" || part.type === "file" || part.type === "audio") {
          // 上传到企微临时素材（3 天有效），再用 media_id 发送
          // 类型映射：image→image, file→file, audio→voice
          const wecomMediaType = part.type === "audio" ? "voice" : part.type;
          const filePath = (part as { filePath: string }).filePath;
          const filename =
            (part as { filename?: string }).filename ??
            (filePath ? filePath.split(/[/\\]/).pop() ?? "file" : "file");

          if (!filePath) {
            throw new Error(`wecom-aibot ${part.type} 缺少 filePath`);
          }

          // 读文件
          const { readFile } = await import("node:fs/promises");
          const fileBuffer = await readFile(filePath);

          // 上传（SDK 内部分片）
          const uploadResult = await withDeliveryRetry(
            "wecom-aibot.uploadMedia",
            () =>
              wsClient!.uploadMedia(fileBuffer, {
                type: wecomMediaType as "image" | "file" | "voice",
                filename,
              }),
            { logger: log },
          );
          const mediaId = uploadResult.media_id;
          log.debug({ mediaId, filename, type: wecomMediaType }, "wecom-aibot 媒体上传成功");

          // 发送（被动回复或主动推送）
          if (replyFrame) {
            await withDeliveryRetry(
              "wecom-aibot.replyMedia",
              () => wsClient!.replyMedia(replyFrame, wecomMediaType as any, mediaId),
              { logger: log },
            );
          } else {
            await withDeliveryRetry(
              "wecom-aibot.sendMediaMessage",
              () => wsClient!.sendMediaMessage(parsed.chatid, wecomMediaType as any, mediaId),
              { logger: log },
            );
          }

          // caption 作为附加文本消息
          const caption = (part as { caption?: string }).caption;
          if (caption?.trim()) {
            if (replyFrame) {
              await withDeliveryRetry(
                "wecom-aibot.replyStreamCaption",
                () => wsClient!.replyStream(replyFrame, generateRandomString(16), caption, true),
                { logger: log },
              );
            } else {
              await withDeliveryRetry(
                "wecom-aibot.sendMessageCaption",
                () =>
                  wsClient!.sendMessage(parsed.chatid, {
                    msgtype: "markdown",
                    markdown: { content: caption },
                  }),
                { logger: log },
              );
            }
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

    // 处理模板卡片（如果提供）
    if (message.meta?.templateCard) {
      try {
        if (replyFrame) {
          await withDeliveryRetry(
            "wecom-aibot.replyTemplateCard",
            () => wsClient!.replyTemplateCard(replyFrame, message.meta!.templateCard!),
            { logger: log },
          );
        } else {
          await withDeliveryRetry(
            "wecom-aibot.sendTemplateCard",
            () =>
              wsClient!.sendMessage(parsed.chatid, {
                msgtype: "template_card",
                template_card: message.meta!.templateCard!,
              }),
            { logger: log },
          );
        }
        log.debug({ cardType: message.meta.templateCard.card_type }, "wecom-aibot 模板卡片已发送");
      } catch (error) {
        const classified = classifyDeliveryError(error);
        log.warn({ error, code: classified.code }, "wecom-aibot 模板卡片发送失败");
      }
    }

    return { attemptedParts: message.parts.length, sentParts, partResults };
  };

  const sendText = async (peerId: string, text: string): Promise<void> => {
    const result = await sendMessage(peerId, { parts: [{ type: "text", text }] });
    if (result.sentParts === 0) {
      const first = result.partResults.find((r) => !r.sent);
      throw new Error(first?.error || "wecom-aibot send failed");
    }
  };

  // -------------------------------------------------------------------------
  // Adapter 接口
  // -------------------------------------------------------------------------

  const adapter: WeComBotAdapter = {
    name: "wecom-aibot",
    identityId: identity.id,
    maxTextLength: MAX_TEXT_LENGTH,

    async start() {
      if (started) {
        log.warn("wecom-aibot adapter 已在运行");
        return;
      }

      wsClient = new WSClient({
        botId,
        secret,
        logger: {
          debug: (m: string, ...a: any[]) => log.debug({ args: a }, m),
          info: (m: string, ...a: any[]) => log.info({ args: a }, m),
          warn: (m: string, ...a: any[]) => log.warn({ args: a }, m),
          error: (m: string, ...a: any[]) => log.error({ args: a }, m),
        },
      });

      wsClient.on("authenticated", () => {
        log.info("wecom-aibot WebSocket 认证成功");
      });
      wsClient.on("disconnected", (reason: string) => {
        log.warn({ reason }, "wecom-aibot WebSocket 断开");
      });
      wsClient.on("reconnecting", (attempt: number) => {
        log.info({ attempt }, "wecom-aibot WebSocket 重连中");
      });
      wsClient.on("error", (error: Error) => {
        log.error({ error }, "wecom-aibot WebSocket 错误");
      });

      // 入站消息（所有类型走 message 事件，按 msgtype 分流）
      wsClient.on("message", (frame: WsFrame<BaseMessage>) => {
        void handleInbound(frame);
      });
      // 事件回调
      wsClient.on("event.enter_chat", (frame: WsFrame<EventMessageWith<EnterChatEvent>>) => {
        void handleEnterChat(frame);
      });
      wsClient.on(
        "event.disconnected_event",
        (frame: WsFrame<EventMessageWith<DisconnectedEventData>>) => {
          handleDisconnected(frame);
        },
      );
      wsClient.on(
        "event.template_card_event",
        (frame: WsFrame<EventMessageWith<import("@wecom/aibot-node-sdk").TemplateCardEventData>>) => {
          void handleTemplateCardEvent(frame);
        },
      );

      wsClient.connect();
      started = true;
      log.info("wecom-aibot adapter 已启动");
    },

    async stop() {
      if (!started) return;
      try {
        wsClient?.disconnect();
      } catch (error) {
        log.warn({ error }, "wecom-aibot disconnect 失败");
      }
      wsClient = null;
      started = false;
      log.info("wecom-aibot adapter 已停止");
    },

    sendMessage,
    sendText,

    getBotName() {
      return `企微智能机器人 ${botId}`;
    },
  };

  return adapter;
}
