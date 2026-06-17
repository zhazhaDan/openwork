/**
 * wecom.ts - 企业微信 (WeChat Work) Channel Adapter
 *
 * 基于 Webhook + API 实现双向通信，接口与 feishu.ts 保持一致
 * 官方文档: https://developer.work.weixin.qq.com/document/
 */
import type { Logger } from "pino";
import crypto from "node:crypto";
// @ts-ignore - fast-xml-parser types may not be fully compatible
import { XMLParser } from "fast-xml-parser";

import type { Config, WeComIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import type { InboundMessagePart, MessageDeliveryResult, OutboundMessagePart, PartDeliveryResult } from "./media.js";
import type { MediaStore } from "./media-store.js";
import { chunkText } from "./text.js";

export type InboundMessage = {
  channel: "wecom";
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
  fromMe?: boolean;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type WeComOutboundMeta = {
  kind?: "reply" | "system" | "tool";
  model?: string;
  agent?: string;
  replyToMessageId?: string;
};

export type WeComAdapter = {
  name: "wecom";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(
    peerId: string,
    message: { parts: OutboundMessagePart[]; meta?: WeComOutboundMeta },
  ): Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
  sendTyping?(peerId: string): Promise<void>;
  markComplete?(messageId: string): Promise<void>;
  getBotName?(): string | null;
};

const MAX_TEXT_LENGTH = 2048; // 企微文本消息限制 2048 字符

// 企微 UserId 格式（企业通讯录中的成员 ID）
const WECOM_PEER_ID_PATTERN = /^[a-zA-Z0-9_@.-]+$/;

export function isWeComPeerId(peerId: string): boolean {
  return WECOM_PEER_ID_PATTERN.test(peerId.trim());
}

export function parseWeComPeerId(peerId: string): string | null {
  const trimmed = peerId.trim();
  return isWeComPeerId(trimmed) ? trimmed : null;
}

/**
 * 企业微信消息加解密
 * 参考: https://developer.work.weixin.qq.com/document/path/90968
 */
class WeComCrypto {
  private aesKey: Buffer;
  private token: string;
  private corpId: string;

  constructor(encodingAESKey: string, token: string, corpId: string) {
    // EncodingAESKey 是 Base64 编码的 43 位字符串，需要补齐 padding
    this.aesKey = Buffer.from(encodingAESKey + "=", "base64");
    this.token = token;
    this.corpId = corpId;
  }

  /**
   * 验证签名
   */
  verifySignature(signature: string, timestamp: string, nonce: string, encrypt: string): boolean {
    const arr = [this.token, timestamp, nonce, encrypt].sort();
    const str = arr.join("");
    const hash = crypto.createHash("sha1").update(str).digest("hex");
    return hash === signature;
  }

  /**
   * 解密消息
   */
  decrypt(encrypted: string): string {
    const buffer = Buffer.from(encrypted, "base64");

    // AES-256-CBC 解密
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, this.aesKey.slice(0, 16));
    decipher.setAutoPadding(false);

    let decrypted = Buffer.concat([decipher.update(buffer), decipher.final()]);

    // 去除补位字符（PKCS7）
    const pad = decrypted[decrypted.length - 1];
    decrypted = decrypted.slice(0, decrypted.length - pad);

    // 格式: 16字节随机数 + 4字节消息长度 + 消息内容 + corpId
    const content = decrypted.slice(16);
    const length = content.readUInt32BE(0);
    const message = content.slice(4, 4 + length).toString("utf8");

    return message;
  }

  /**
   * 加密消息（用于被动回复，实际企微应用不需要）
   */
  encrypt(text: string): string {
    const random = crypto.randomBytes(16);
    const msgLen = Buffer.alloc(4);
    msgLen.writeUInt32BE(Buffer.byteLength(text), 0);

    const corpIdBuffer = Buffer.from(this.corpId, "utf8");
    const content = Buffer.concat([random, msgLen, Buffer.from(text, "utf8"), corpIdBuffer]);

    // PKCS7 padding
    const blockSize = 32;
    const pad = blockSize - (content.length % blockSize);
    const padded = Buffer.concat([content, Buffer.alloc(pad, pad)]);

    // AES-256-CBC 加密
    const cipher = crypto.createCipheriv("aes-256-cbc", this.aesKey, this.aesKey.slice(0, 16));
    cipher.setAutoPadding(false);

    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    return encrypted.toString("base64");
  }
}

/**
 * 企业微信 API 客户端
 */
class WeComClient {
  private corpId: string;
  private agentSecret: string;
  private agentId: number;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private logger: Logger;

  constructor(corpId: string, agentSecret: string, agentId: number, logger: Logger) {
    this.corpId = corpId;
    this.agentSecret = agentSecret;
    this.agentId = agentId;
    this.logger = logger;
  }

  /**
   * 获取 access_token
   * 有效期 7200 秒，需缓存
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiry) {
      return this.accessToken;
    }

    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${this.agentSecret}`;

    try {
      const response = await fetch(url);
      const data = (await response.json()) as any;

      if (data.errcode !== 0) {
        throw new Error(`获取 access_token 失败: ${data.errmsg} (${data.errcode})`);
      }

      this.accessToken = data.access_token;
      // 提前 5 分钟刷新，避免临界点失效
      this.tokenExpiry = now + (data.expires_in - 300) * 1000;

      this.logger.debug({ expiresIn: data.expires_in }, "企微 access_token 已更新");
      return this.accessToken as string;
    } catch (error) {
      this.logger.error({ error }, "获取企微 access_token 失败");
      throw error;
    }
  }

  /**
   * 发送文本消息
   */
  async sendText(userId: string, text: string): Promise<void> {
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    const payload = {
      touser: userId,
      msgtype: "text",
      agentid: this.agentId,
      text: {
        content: text,
      },
      safe: 0, // 0=不保密 1=保密（阅后即焚）
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as any;

    if (data.errcode !== 0) {
      // 40001/42001: token 失效，清除缓存并抛出特殊错误
      if (data.errcode === 40001 || data.errcode === 42001) {
        this.accessToken = null;
        this.tokenExpiry = 0;
        const error: any = new Error("TOKEN_EXPIRED");
        error.retryable = true;
        throw error;
      }

      // 45009: 触发限流
      if (data.errcode === 45009) {
        const error: any = new Error(`API 限流: ${data.errmsg}`);
        error.retryable = true;
        throw error;
      }

      throw new Error(`发送消息失败: ${data.errmsg} (${data.errcode})`);
    }

    this.logger.debug({ userId, textPreview: text.slice(0, 50) }, "企微消息已发送");
  }

  /**
   * 上传临时素材（图片/文件）
   * 返回 media_id，有效期 3 天
   */
  async uploadMedia(
    type: "image" | "voice" | "video" | "file",
    filePath: string,
  ): Promise<string> {
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=${type}`;

    // TODO: 实现文件上传逻辑
    // 需要使用 FormData 上传文件
    throw new Error("uploadMedia not implemented yet");
  }

  /**
   * 发送图片消息
   */
  async sendImage(userId: string, mediaId: string): Promise<void> {
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    const payload = {
      touser: userId,
      msgtype: "image",
      agentid: this.agentId,
      image: {
        media_id: mediaId,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as any;

    if (data.errcode !== 0) {
      if (data.errcode === 40001 || data.errcode === 42001) {
        this.accessToken = null;
        this.tokenExpiry = 0;
        const error: any = new Error("TOKEN_EXPIRED");
        error.retryable = true;
        throw error;
      }
      throw new Error(`发送图片失败: ${data.errmsg} (${data.errcode})`);
    }
  }
}

/**
 * 创建企业微信适配器
 */
export function createWeComAdapter(
  identity: WeComIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  mediaStore?: MediaStore,
): WeComAdapter {
  const corpId = identity.corpId?.trim() ?? "";
  const agentSecret = identity.agentSecret?.trim() ?? "";
  const agentId = identity.agentId ?? 0;
  const token = identity.token?.trim() ?? "";
  const aesKey = identity.aesKey?.trim() ?? "";

  if (!corpId || !agentSecret || !agentId) {
    throw new Error("企微 corpId, agentSecret, agentId 必填");
  }

  const log = logger.child({ channel: "wecom", identityId: identity.id });
  log.debug({ corpId, agentId }, "wecom adapter init");

  const client = new WeComClient(corpId, agentSecret, agentId, log);
  const crypto = token && aesKey ? new WeComCrypto(aesKey, token, corpId) : null;
  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "_text",
    cdataPropName: "_cdata",
  });

  let isRunning = false;

  // ---------------------------------------------------------------------------
  // Webhook 消息解析
  // ---------------------------------------------------------------------------

  /**
   * 解析企微 XML 消息
   */
  const parseWeComMessage = (xml: string): {
    fromUserName: string;
    toUserName: string;
    createTime: number;
    msgType: string;
    content: string;
    msgId: string;
    agentId: number;
  } | null => {
    try {
      const parsed = xmlParser.parse(xml);
      const msg = parsed?.xml || parsed;

      const fromUserName = msg?.FromUserName?._cdata || msg?.FromUserName || "";
      const toUserName = msg?.ToUserName?._cdata || msg?.ToUserName || "";
      const msgType = msg?.MsgType?._cdata || msg?.MsgType || "";
      const content = msg?.Content?._cdata || msg?.Content || "";
      const msgId = msg?.MsgId?._text || msg?.MsgId || "";
      const createTime = parseInt(msg?.CreateTime?._text || msg?.CreateTime || "0");
      const agentIdValue = parseInt(msg?.AgentID?._text || msg?.AgentID || "0");

      if (!fromUserName || !msgType) {
        log.warn({ xml: xml.slice(0, 200) }, "企微消息缺少必要字段");
        return null;
      }

      return {
        fromUserName,
        toUserName,
        createTime,
        msgType,
        content,
        msgId,
        agentId: agentIdValue,
      };
    } catch (error) {
      log.error({ error, xml: xml.slice(0, 200) }, "企微 XML 解析失败");
      return null;
    }
  };

  /**
   * Webhook URL 验证（GET 请求）
   * 企微会发送 GET 请求验证 URL 有效性
   */
  const handleWebhookVerify = (query: Record<string, string>): string | null => {
    if (!crypto) {
      log.warn("企微 Webhook crypto 未配置，无法验证");
      return null;
    }

    const { msg_signature, timestamp, nonce, echostr } = query;
    if (!msg_signature || !timestamp || !nonce || !echostr) {
      log.warn({ query }, "企微 Webhook 验证参数不全");
      return null;
    }

    // 验证签名
    if (!crypto.verifySignature(msg_signature, timestamp, nonce, echostr)) {
      log.warn("企微 Webhook 签名验证失败");
      return null;
    }

    // 解密 echostr
    try {
      const decrypted = crypto.decrypt(echostr);
      log.info("企微 Webhook URL 验证成功");
      return decrypted;
    } catch (error) {
      log.error({ error }, "企微 echostr 解密失败");
      return null;
    }
  };

  /**
   * Webhook 消息接收（POST 请求）
   */
  const handleWebhookMessage = async (
    query: Record<string, string>,
    body: string,
  ): Promise<void> => {
    if (!crypto) {
      log.warn("企微 Webhook crypto 未配置，无法处理消息");
      return;
    }

    const { msg_signature, timestamp, nonce } = query;

    // 1. 解析 XML 提取加密字段
    let encrypted: string;
    try {
      const parsed = xmlParser.parse(body);
      const encryptNode = parsed?.xml?.Encrypt || parsed?.Encrypt;
      encrypted = encryptNode?._cdata || encryptNode || "";

      if (!encrypted) {
        log.warn({ body: body.slice(0, 200) }, "企微消息未找到 Encrypt 节点");
        return;
      }
    } catch (error) {
      log.error({ error, body: body.slice(0, 200) }, "企微消息 XML 解析失败");
      return;
    }

    // 2. 验证签名
    if (!crypto.verifySignature(msg_signature, timestamp, nonce, encrypted)) {
      log.warn("企微消息签名验证失败");
      return;
    }

    // 3. 解密消息
    let decryptedXML: string;
    try {
      decryptedXML = crypto.decrypt(encrypted);
    } catch (error) {
      log.error({ error }, "企微消息解密失败");
      return;
    }

    // 4. 解析消息内容
    const message = parseWeComMessage(decryptedXML);
    if (!message) {
      return;
    }

    const { fromUserName, msgType, content, msgId, createTime } = message;

    log.info(
      {
        fromUserName,
        msgType,
        msgId,
        contentPreview: content.slice(0, 100),
      },
      "企微收到消息",
    );

    // 5. 忽略自己发的消息（如果有机制可以判断）
    // 企微没有明确的 bot open_id，暂时跳过

    // 6. 群聊支持（可选）
    // 企微群聊消息需要额外配置，暂时只支持私聊

    // 7. 构造 InboundMessage
    const parts: InboundMessagePart[] = [];

    if (msgType === "text" && content) {
      parts.push({ type: "text", text: content });
    } else if (msgType === "image") {
      // TODO: 处理图片消息
      log.debug({ msgId }, "企微图片消息暂不支持");
    } else if (msgType === "voice") {
      // TODO: 处理语音消息
      log.debug({ msgId }, "企微语音消息暂不支持");
    } else if (msgType === "file") {
      // TODO: 处理文件消息
      log.debug({ msgId }, "企微文件消息暂不支持");
    } else {
      log.debug({ msgType, msgId }, "企微不支持的消息类型");
      return;
    }

    if (parts.length === 0) return;

    const promptText = parts
      .filter((p) => p.type === "text")
      .map((p) => (p as any).text)
      .join(" ");

    // 8. 调用消息处理器
    await onMessage({
      channel: "wecom",
      identityId: identity.id,
      peerId: fromUserName,
      text: promptText,
      parts,
      raw: { decryptedXML, message },
    });
  };

  // ---------------------------------------------------------------------------
  // 发送消息
  // ---------------------------------------------------------------------------

  const sendMessage = async (
    peerId: string,
    message: { parts: OutboundMessagePart[]; meta?: WeComOutboundMeta },
  ): Promise<MessageDeliveryResult> => {
    const userId = parseWeComPeerId(peerId);
    if (!userId) {
      const error = new Error("Invalid WeChat Work userId") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const partResults: PartDeliveryResult[] = [];
    let sentParts = 0;

    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index];
      try {
        if (part.type === "text") {
          // 企微文本消息限制 2048 字符，需要分片
          const chunks = chunkText(part.text, MAX_TEXT_LENGTH);
          for (const chunk of chunks) {
            await withDeliveryRetry(
              "wecom.sendText",
              () => client.sendText(userId, chunk),
              { logger: log },
            );
          }
        } else if (part.type === "image" || part.type === "file" || part.type === "audio") {
          // TODO: 实现图片/文件上传
          log.warn({ type: part.type }, "企微图片/文件发送暂未实现");
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
      const firstError = result.partResults.find((r) => !r.sent);
      throw new Error(firstError?.error || "发送失败");
    }
  };

  // ---------------------------------------------------------------------------
  // Adapter 接口（与 feishu.ts 保持一致）
  // ---------------------------------------------------------------------------

  const adapter: WeComAdapter = {
    name: "wecom",
    identityId: identity.id,
    maxTextLength: MAX_TEXT_LENGTH,

    async start() {
      if (isRunning) {
        log.warn("企微适配器已在运行");
        return;
      }

      // 测试 access_token 获取
      try {
        await client.getAccessToken();
        isRunning = true;
        log.info("企微适配器已启动");
      } catch (error) {
        log.error({ error }, "企微适配器启动失败");
        throw error;
      }
    },

    async stop() {
      if (!isRunning) return;
      isRunning = false;
      log.info("企微适配器已停止");
    },

    sendMessage,
    sendText,

    // 企微不支持 typing 状态
    sendTyping: undefined,

    // 企微不支持消息状态标记（类似飞书的 reaction）
    markComplete: undefined,

    getBotName() {
      return `企微应用 ${agentId}`;
    },
  };

  // 注意：Webhook 路由需要在 bridge.ts 中注册
  // 这里只提供处理函数，实际 HTTP 路由由外部管理
  // @ts-ignore - 附加内部方法供 bridge.ts 调用
  adapter._handleWebhookVerify = handleWebhookVerify;
  // @ts-ignore
  adapter._handleWebhookMessage = handleWebhookMessage;

  return adapter;
}
