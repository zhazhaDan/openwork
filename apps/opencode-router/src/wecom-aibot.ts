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

      // 群聊只在 @ 机器人时才会触发，本身就该响应；单聊全部响应
      if (parts.length === 0) {
        log.debug({ msgtype: body.msgtype, peerId }, "wecom-aibot 不支持的入站消息类型，已跳过");
        return;
      }

      log.info(
        { msgtype: body.msgtype, peerId, chattype: body.chattype, preview: text.slice(0, 120) },
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
          // TODO: 用 wsClient.uploadMedia + replyMedia / sendMediaMessage
          log.warn({ type: part.type }, "wecom-aibot 媒体发送暂未实现");
          throw new Error(`wecom-aibot 媒体类型 ${part.type} 暂未实现`);
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
