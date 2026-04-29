/**
 * channels-ext.ts — Extension registry for Feishu & Mattermost channels.
 *
 * All new channel logic lives in this file and the adapter files (feishu.ts, mattermost.ts).
 * Existing source files (config.ts, bridge.ts, health.ts, cli.ts) only import thin hooks
 * from here, keeping their diffs minimal for upstream sync.
 */

import type http from "node:http";
import type { Logger } from "pino";
import type { Command } from "commander";

import type {
  ChannelName,
  Config,
  FeishuIdentity,
  MattermostIdentity,
  OpenCodeRouterConfigFile,
} from "./config.js";
import { readConfigFile, writeConfigFile } from "./config.js";
import type { InboundMessagePart, MessageDeliveryResult, OutboundMessagePart } from "./media.js";
import type { MediaStore } from "./media-store.js";

import { createFeishuAdapter, isFeishuPeerId } from "./feishu.js";
import { createMattermostAdapter, isMattermostPeerId } from "./mattermost.js";

// Re-export peer ID helpers for bridge.ts.
export { isFeishuPeerId, isMattermostPeerId };

// ---------------------------------------------------------------------------
// Channel validation
// ---------------------------------------------------------------------------

const EXT_CHANNELS = new Set<string>(["feishu", "mattermost"]);

export function isExtChannel(name: string): name is "feishu" | "mattermost" {
  return EXT_CHANNELS.has(name);
}

export function isValidChannel(name: string): name is ChannelName {
  return name === "telegram" || name === "slack" || isExtChannel(name);
}

// ---------------------------------------------------------------------------
// Types shared with health.ts
// ---------------------------------------------------------------------------

export type FeishuIdentityItem = {
  id: string;
  enabled: boolean;
  running: boolean;
};

export type MattermostIdentityItem = {
  id: string;
  enabled: boolean;
  running: boolean;
};

export type FeishuIdentitiesResult = { items: FeishuIdentityItem[] };
export type MattermostIdentitiesResult = { items: MattermostIdentityItem[] };

export type FeishuIdentityUpsertInput = {
  id?: string;
  appId: string;
  appSecret: string;
  enabled?: boolean;
  directory?: string;
  domain?: "feishu" | "lark";
};

export type MattermostIdentityUpsertInput = {
  id?: string;
  serverUrl: string;
  accessToken: string;
  enabled?: boolean;
  directory?: string;
};

export type UpsertIdentityResult = {
  id: string;
  enabled: boolean;
  applied?: boolean;
  starting?: boolean;
  error?: string;
};

export type DeleteIdentityResult = {
  id: string;
  deleted: boolean;
  applied?: boolean;
  starting?: boolean;
  error?: string;
};

export type ExtHealthHandlers = {
  listFeishuIdentities?: () => Promise<FeishuIdentitiesResult>;
  upsertFeishuIdentity?: (input: FeishuIdentityUpsertInput) => Promise<UpsertIdentityResult>;
  deleteFeishuIdentity?: (id: string) => Promise<DeleteIdentityResult>;
  listMattermostIdentities?: () => Promise<MattermostIdentitiesResult>;
  upsertMattermostIdentity?: (input: MattermostIdentityUpsertInput) => Promise<UpsertIdentityResult>;
  deleteMattermostIdentity?: (id: string) => Promise<DeleteIdentityResult>;
};

// ---------------------------------------------------------------------------
// Adapter type (mirrors bridge.ts Adapter)
// ---------------------------------------------------------------------------

type SendMeta = {
  kind?: "reply" | "system" | "tool";
  model?: string;
  agent?: string;
};

type Adapter = {
  key: string;
  name: ChannelName;
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage?: (peerId: string, message: { parts: OutboundMessagePart[]; meta?: SendMeta }) => Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
  sendFile?: (peerId: string, filePath: string, caption?: string) => Promise<void>;
  sendTyping?: (peerId: string) => Promise<void>;
  getBotName?: () => string | null;
};

type AdapterStartResult =
  | { status: "started" }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

type InboundMessage = {
  channel: ChannelName;
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
  fromMe?: boolean;
};

type HandleInbound = (message: InboundMessage) => void;

// ---------------------------------------------------------------------------
// Adapter registration (called from bridge.ts)
// ---------------------------------------------------------------------------

export function registerExtAdapters(
  config: Config,
  adapters: Map<string, Adapter>,
  logger: Logger,
  handleInbound: HandleInbound,
  mediaStore: MediaStore,
) {
  const adapterKey = (channel: string, id: string) => `${channel}:${id}`;

  // Feishu adapters.
  const enabledFeishu = config.feishuApps.filter((a) => a.enabled !== false);
  if (enabledFeishu.length === 0) {
    logger.info("feishu adapters disabled");
  }
  for (const app of enabledFeishu) {
    const key = adapterKey("feishu", app.id);
    logger.debug({ identityId: app.id }, "feishu adapter enabled");
    const base = createFeishuAdapter(app, config, logger, handleInbound, mediaStore);
    adapters.set(key, { ...base, key });
  }

  // Mattermost adapters.
  const enabledMattermost = config.mattermostBots.filter((b) => b.enabled !== false);
  if (enabledMattermost.length === 0) {
    logger.info("mattermost adapters disabled");
  }
  for (const bot of enabledMattermost) {
    const key = adapterKey("mattermost", bot.id);
    logger.debug({ identityId: bot.id }, "mattermost adapter enabled");
    const base = createMattermostAdapter(bot, config, logger, handleInbound, mediaStore);
    adapters.set(key, { ...base, key });
  }
}

// ---------------------------------------------------------------------------
// Bridge handlers (called from bridge.ts health server setup)
// ---------------------------------------------------------------------------

export function createExtBridgeHandlers(
  config: Config,
  adapters: Map<string, Adapter>,
  logger: Logger,
  handleInbound: HandleInbound,
  mediaStore: MediaStore,
  normalizeIdentityId: (value: string | undefined) => string,
  startAdapterBounded: (adapter: Adapter, options: { timeoutMs: number; onError?: (error: unknown) => void }) => Promise<AdapterStartResult>,
): ExtHealthHandlers {
  const adapterKey = (channel: string, id: string) => `${channel}:${id}`;

  return {
    // -------------------------------------------------------------------------
    // Feishu
    // -------------------------------------------------------------------------
    listFeishuIdentities: async () => {
      return {
        items: config.feishuApps.map((app) => ({
          id: app.id,
          enabled: app.enabled !== false,
          running: adapters.has(adapterKey("feishu", app.id)),
        })),
      };
    },

    upsertFeishuIdentity: async (input: FeishuIdentityUpsertInput) => {
      const appId = input.appId?.trim() ?? "";
      const appSecret = input.appSecret?.trim() ?? "";
      if (!appId || !appSecret) throw new Error("appId and appSecret are required");
      const id = normalizeIdentityId(input.id);
      if (id === "env") throw new Error("identity id 'env' is reserved");
      const enabled = input.enabled !== false;
      const directoryInput = typeof input.directory === "string" ? input.directory.trim() : "";
      const domainInput = input.domain === "lark" ? "lark" : "feishu";

      // Persist to config file.
      const { config: current } = readConfigFile(config.configPath);
      const feishu = current.channels?.feishu;
      const apps = Array.isArray((feishu as any)?.apps) ? (((feishu as any).apps as unknown[]) ?? []) : [];
      const nextApps: any[] = [];
      let found = false;
      for (const entry of apps) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
        if (entryId !== id) {
          nextApps.push(entry);
          continue;
        }
        found = true;
        const existingDirectory = typeof record.directory === "string" ? record.directory.trim() : "";
        const directory = directoryInput || existingDirectory;
        nextApps.push({ id, appId, appSecret, enabled, domain: domainInput, ...(directory ? { directory } : {}) });
      }
      if (!found) {
        nextApps.push({ id, appId, appSecret, enabled, domain: domainInput, ...(directoryInput ? { directory: directoryInput } : {}) });
      }

      const next: OpenCodeRouterConfigFile = {
        ...current,
        channels: {
          ...current.channels,
          feishu: { ...(current.channels?.feishu ?? {}), enabled: true, apps: nextApps },
        },
      };
      next.version = next.version ?? 1;
      writeConfigFile(config.configPath, next);
      config.configFile = next;

      // Update runtime identity list.
      const existingIdx = config.feishuApps.findIndex((a) => a.id === id);
      const runtimeIdentity: FeishuIdentity = {
        id,
        appId,
        appSecret,
        enabled,
        domain: domainInput,
        ...(directoryInput ? { directory: directoryInput } : existingIdx >= 0 && config.feishuApps[existingIdx]?.directory ? { directory: config.feishuApps[existingIdx].directory } : {}),
      };
      if (existingIdx >= 0) {
        config.feishuApps[existingIdx] = runtimeIdentity;
      } else {
        config.feishuApps.push(runtimeIdentity);
      }

      // Start/stop adapter.
      const key = adapterKey("feishu", id);
      const existing = adapters.get(key);
      if (!enabled) {
        if (existing) {
          try { await existing.stop(); } catch (error) {
            logger.warn({ error, channel: "feishu", identityId: id }, "failed to stop feishu adapter");
          }
          adapters.delete(key);
        }
        return { id, enabled: false, applied: true };
      }

      if (existing) {
        try { await existing.stop(); } catch (error) {
          logger.warn({ error, channel: "feishu", identityId: id }, "failed to stop existing feishu adapter");
        }
        adapters.delete(key);
      }
      const base = createFeishuAdapter(runtimeIdentity, config, logger, handleInbound, mediaStore);
      const adapter = { ...base, key };
      adapters.set(key, adapter);

      const startResult = await startAdapterBounded(adapter, {
        timeoutMs: 5_000,
        onError: (error) => {
          logger.error({ error, channel: "feishu", identityId: id }, "feishu adapter start failed");
          adapters.delete(key);
        },
      });

      if (startResult.status === "timeout") return { id, enabled: true, applied: false, starting: true };
      if (startResult.status === "error") return { id, enabled: true, applied: false, error: String(startResult.error) };
      return { id, enabled: true, applied: true };
    },

    deleteFeishuIdentity: async (rawId: string) => {
      const id = normalizeIdentityId(rawId);
      if (id === "env") throw new Error("env identity cannot be deleted");

      const { config: current } = readConfigFile(config.configPath);
      const feishu = current.channels?.feishu;
      const apps = Array.isArray((feishu as any)?.apps) ? (((feishu as any).apps as unknown[]) ?? []) : [];
      const nextApps: any[] = [];
      let deleted = false;
      for (const entry of apps) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
        if (entryId === id) { deleted = true; continue; }
        nextApps.push(entry);
      }
      const next: OpenCodeRouterConfigFile = {
        ...current,
        channels: { ...current.channels, feishu: { ...(current.channels?.feishu ?? {}), apps: nextApps } },
      };
      next.version = next.version ?? 1;
      writeConfigFile(config.configPath, next);
      config.configFile = next;

      config.feishuApps.splice(0, config.feishuApps.length, ...config.feishuApps.filter((a) => a.id !== id));

      const key = adapterKey("feishu", id);
      const existing = adapters.get(key);
      if (existing) {
        try { await existing.stop(); } catch (error) {
          logger.warn({ error, channel: "feishu", identityId: id }, "failed to stop feishu adapter");
        }
        adapters.delete(key);
      }
      return { id, deleted };
    },

    // -------------------------------------------------------------------------
    // Mattermost
    // -------------------------------------------------------------------------
    listMattermostIdentities: async () => {
      return {
        items: config.mattermostBots.map((bot) => ({
          id: bot.id,
          enabled: bot.enabled !== false,
          running: adapters.has(adapterKey("mattermost", bot.id)),
        })),
      };
    },

    upsertMattermostIdentity: async (input: MattermostIdentityUpsertInput) => {
      const serverUrl = input.serverUrl?.trim() ?? "";
      const accessToken = input.accessToken?.trim() ?? "";
      if (!serverUrl || !accessToken) throw new Error("serverUrl and accessToken are required");
      const id = normalizeIdentityId(input.id);
      if (id === "env") throw new Error("identity id 'env' is reserved");
      const enabled = input.enabled !== false;
      const directoryInput = typeof input.directory === "string" ? input.directory.trim() : "";

      // Persist to config file.
      const { config: current } = readConfigFile(config.configPath);
      const mattermost = current.channels?.mattermost;
      const bots = Array.isArray((mattermost as any)?.bots) ? (((mattermost as any).bots as unknown[]) ?? []) : [];
      const nextBots: any[] = [];
      let found = false;
      for (const entry of bots) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
        if (entryId !== id) {
          nextBots.push(entry);
          continue;
        }
        found = true;
        const existingDirectory = typeof record.directory === "string" ? record.directory.trim() : "";
        const directory = directoryInput || existingDirectory;
        nextBots.push({ id, serverUrl, accessToken, enabled, ...(directory ? { directory } : {}) });
      }
      if (!found) {
        nextBots.push({ id, serverUrl, accessToken, enabled, ...(directoryInput ? { directory: directoryInput } : {}) });
      }

      const next: OpenCodeRouterConfigFile = {
        ...current,
        channels: {
          ...current.channels,
          mattermost: { ...(current.channels?.mattermost ?? {}), enabled: true, bots: nextBots },
        },
      };
      next.version = next.version ?? 1;
      writeConfigFile(config.configPath, next);
      config.configFile = next;

      // Update runtime identity list.
      const existingIdx = config.mattermostBots.findIndex((b) => b.id === id);
      const runtimeIdentity: MattermostIdentity = {
        id,
        serverUrl,
        accessToken,
        enabled,
        ...(directoryInput ? { directory: directoryInput } : existingIdx >= 0 && config.mattermostBots[existingIdx]?.directory ? { directory: config.mattermostBots[existingIdx].directory } : {}),
      };
      if (existingIdx >= 0) {
        config.mattermostBots[existingIdx] = runtimeIdentity;
      } else {
        config.mattermostBots.push(runtimeIdentity);
      }

      // Start/stop adapter.
      const key = adapterKey("mattermost", id);
      const existing = adapters.get(key);
      if (!enabled) {
        if (existing) {
          try { await existing.stop(); } catch (error) {
            logger.warn({ error, channel: "mattermost", identityId: id }, "failed to stop mattermost adapter");
          }
          adapters.delete(key);
        }
        return { id, enabled: false, applied: true };
      }

      if (existing) {
        try { await existing.stop(); } catch (error) {
          logger.warn({ error, channel: "mattermost", identityId: id }, "failed to stop existing mattermost adapter");
        }
        adapters.delete(key);
      }
      const base = createMattermostAdapter(runtimeIdentity, config, logger, handleInbound, mediaStore);
      const adapter = { ...base, key };
      adapters.set(key, adapter);

      const startResult = await startAdapterBounded(adapter, {
        timeoutMs: 5_000,
        onError: (error) => {
          logger.error({ error, channel: "mattermost", identityId: id }, "mattermost adapter start failed");
          adapters.delete(key);
        },
      });

      if (startResult.status === "timeout") return { id, enabled: true, applied: false, starting: true };
      if (startResult.status === "error") return { id, enabled: true, applied: false, error: String(startResult.error) };
      return { id, enabled: true, applied: true };
    },

    deleteMattermostIdentity: async (rawId: string) => {
      const id = normalizeIdentityId(rawId);
      if (id === "env") throw new Error("env identity cannot be deleted");

      const { config: current } = readConfigFile(config.configPath);
      const mattermost = current.channels?.mattermost;
      const bots = Array.isArray((mattermost as any)?.bots) ? (((mattermost as any).bots as unknown[]) ?? []) : [];
      const nextBots: any[] = [];
      let deleted = false;
      for (const entry of bots) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
        if (entryId === id) { deleted = true; continue; }
        nextBots.push(entry);
      }
      const next: OpenCodeRouterConfigFile = {
        ...current,
        channels: { ...current.channels, mattermost: { ...(current.channels?.mattermost ?? {}), bots: nextBots } },
      };
      next.version = next.version ?? 1;
      writeConfigFile(config.configPath, next);
      config.configFile = next;

      config.mattermostBots.splice(0, config.mattermostBots.length, ...config.mattermostBots.filter((b) => b.id !== id));

      const key = adapterKey("mattermost", id);
      const existing = adapters.get(key);
      if (existing) {
        try { await existing.stop(); } catch (error) {
          logger.warn({ error, channel: "mattermost", identityId: id }, "failed to stop mattermost adapter");
        }
        adapters.delete(key);
      }
      return { id, deleted };
    },
  };
}

// ---------------------------------------------------------------------------
// Health HTTP route handler (called from health.ts)
// ---------------------------------------------------------------------------

async function readBody(req: http.IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 1024 * 1024) throw Object.assign(new Error("Payload too large"), { status: 413 });
  }
  return raw;
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorStatus(error: unknown): number {
  const s = (error as any)?.status;
  return typeof s === "number" && s >= 400 && s < 600 ? s : 500;
}

/**
 * Handle HTTP routes for extended channels.
 * Returns true if the request was handled, false to fall through to the next handler.
 */
export async function handleExtChannelRoute(
  pathname: string,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handlers: ExtHealthHandlers,
): Promise<boolean> {

  // GET /identities/feishu
  if (pathname === "/identities/feishu" && method === "GET") {
    if (!handlers.listFeishuIdentities) { jsonResponse(res, 404, { ok: false, error: "Not supported" }); return true; }
    try {
      const result = await handlers.listFeishuIdentities();
      jsonResponse(res, 200, { ok: true, ...result });
    } catch (error) {
      jsonResponse(res, errorStatus(error), { ok: false, error: String(error instanceof Error ? error.message : error) });
    }
    return true;
  }

  // POST /identities/feishu
  if (pathname === "/identities/feishu" && method === "POST") {
    if (!handlers.upsertFeishuIdentity) { jsonResponse(res, 404, { ok: false, error: "Not supported" }); return true; }
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const appId = typeof payload.appId === "string" ? payload.appId.trim() : "";
      const appSecret = typeof payload.appSecret === "string" ? payload.appSecret.trim() : "";
      if (!appId || !appSecret) { jsonResponse(res, 400, { ok: false, error: "appId and appSecret are required" }); return true; }
      const id = typeof payload.id === "string" ? payload.id.trim() : undefined;
      const directory = typeof payload.directory === "string" ? payload.directory.trim() : undefined;
      const domain = typeof payload.domain === "string" ? payload.domain.trim() : undefined;
      const enabled = payload.enabled === undefined ? undefined : payload.enabled === true || payload.enabled === "true";
      const result = await handlers.upsertFeishuIdentity({
        ...(id ? { id } : {}),
        appId,
        appSecret,
        ...(enabled === undefined ? {} : { enabled }),
        ...(directory ? { directory } : {}),
        ...(domain === "lark" ? { domain: "lark" } : domain === "feishu" ? { domain: "feishu" } : {}),
      });
      jsonResponse(res, 200, { ok: true, feishu: result });
    } catch (error) {
      jsonResponse(res, errorStatus(error), { ok: false, error: String(error instanceof Error ? error.message : error) });
    }
    return true;
  }

  // DELETE /identities/feishu/:id
  if (pathname.startsWith("/identities/feishu/") && method === "DELETE") {
    if (!handlers.deleteFeishuIdentity) { jsonResponse(res, 404, { ok: false, error: "Not supported" }); return true; }
    const id = pathname.slice("/identities/feishu/".length).trim();
    if (!id) { jsonResponse(res, 400, { ok: false, error: "id is required" }); return true; }
    try {
      const result = await handlers.deleteFeishuIdentity(id);
      jsonResponse(res, 200, { ok: true, feishu: result });
    } catch (error) {
      jsonResponse(res, 500, { ok: false, error: String(error) });
    }
    return true;
  }

  // GET /identities/mattermost
  if (pathname === "/identities/mattermost" && method === "GET") {
    if (!handlers.listMattermostIdentities) { jsonResponse(res, 404, { ok: false, error: "Not supported" }); return true; }
    try {
      const result = await handlers.listMattermostIdentities();
      jsonResponse(res, 200, { ok: true, ...result });
    } catch (error) {
      jsonResponse(res, errorStatus(error), { ok: false, error: String(error instanceof Error ? error.message : error) });
    }
    return true;
  }

  // POST /identities/mattermost
  if (pathname === "/identities/mattermost" && method === "POST") {
    if (!handlers.upsertMattermostIdentity) { jsonResponse(res, 404, { ok: false, error: "Not supported" }); return true; }
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const serverUrl = typeof payload.serverUrl === "string" ? payload.serverUrl.trim() : "";
      const accessToken = typeof payload.accessToken === "string" ? payload.accessToken.trim() : "";
      if (!serverUrl || !accessToken) { jsonResponse(res, 400, { ok: false, error: "serverUrl and accessToken are required" }); return true; }
      const id = typeof payload.id === "string" ? payload.id.trim() : undefined;
      const directory = typeof payload.directory === "string" ? payload.directory.trim() : undefined;
      const enabled = payload.enabled === undefined ? undefined : payload.enabled === true || payload.enabled === "true";
      const result = await handlers.upsertMattermostIdentity({
        ...(id ? { id } : {}),
        serverUrl,
        accessToken,
        ...(enabled === undefined ? {} : { enabled }),
        ...(directory ? { directory } : {}),
      });
      jsonResponse(res, 200, { ok: true, mattermost: result });
    } catch (error) {
      jsonResponse(res, errorStatus(error), { ok: false, error: String(error instanceof Error ? error.message : error) });
    }
    return true;
  }

  // DELETE /identities/mattermost/:id
  if (pathname.startsWith("/identities/mattermost/") && method === "DELETE") {
    if (!handlers.deleteMattermostIdentity) { jsonResponse(res, 404, { ok: false, error: "Not supported" }); return true; }
    const id = pathname.slice("/identities/mattermost/".length).trim();
    if (!id) { jsonResponse(res, 400, { ok: false, error: "id is required" }); return true; }
    try {
      const result = await handlers.deleteMattermostIdentity(id);
      jsonResponse(res, 200, { ok: true, mattermost: result });
    } catch (error) {
      jsonResponse(res, 500, { ok: false, error: String(error) });
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// CLI command registration (called from cli.ts)
// ---------------------------------------------------------------------------

export function registerExtCommands(
  program: Command,
  loadConfig: (env?: NodeJS.ProcessEnv, options?: { requireOpencode?: boolean }) => Config,
  _readConfigFile: typeof readConfigFile,
  _writeConfigFile: typeof writeConfigFile,
  normalizeIdentityId: (value: string | undefined) => string,
  outputJson: (data: unknown) => void,
  _outputError: (message: string) => void,
) {
  const updateConfig = (configPath: string, updater: (cfg: OpenCodeRouterConfigFile) => OpenCodeRouterConfigFile) => {
    const { config } = _readConfigFile(configPath);
    const base = config ?? { version: 1 };
    const next = updater(base);
    next.version = next.version ?? 1;
    _writeConfigFile(configPath, next);
    return next;
  };

  // ---- Feishu commands ----
  const feishu = program.command("feishu").description("Feishu identities");

  feishu
    .command("list")
    .description("List Feishu app identities")
    .action(() => {
      const useJson = program.opts().json;
      const config = loadConfig(process.env, { requireOpencode: false });
      const items = config.feishuApps.map((a) => ({ id: a.id, enabled: a.enabled !== false }));
      if (useJson) outputJson({ items });
      else for (const item of items) console.log(`${item.id} ${item.enabled ? "enabled" : "disabled"}`);
    });

  feishu
    .command("add")
    .requiredOption("--app-id <appId>", "Feishu App ID")
    .requiredOption("--app-secret <appSecret>", "Feishu App Secret")
    .option("--id <id>", "Identity id (default: default)")
    .option("--domain <domain>", "feishu or lark", "feishu")
    .option("--disabled", "Add identity but disable it", false)
    .description("Add or update a Feishu app identity")
    .action((opts: { appId: string; appSecret: string; id?: string; domain?: string; disabled?: boolean }) => {
      const useJson = program.opts().json;
      const config = loadConfig(process.env, { requireOpencode: false });
      const id = normalizeIdentityId(opts.id);
      const enabled = !opts.disabled;
      const domain: "feishu" | "lark" = opts.domain === "lark" ? "lark" : "feishu";
      updateConfig(config.configPath, (cfg) => upsertFeishuApp(cfg, { id, appId: opts.appId.trim(), appSecret: opts.appSecret.trim(), enabled, domain }, normalizeIdentityId));
      if (useJson) outputJson({ success: true, id, enabled });
      else console.log(`Saved Feishu identity: ${id}`);
    });

  feishu
    .command("remove")
    .argument("<id>", "Identity id")
    .description("Remove a Feishu identity")
    .action((idRaw: string) => {
      const useJson = program.opts().json;
      const config = loadConfig(process.env, { requireOpencode: false });
      const { next, deleted } = deleteFeishuApp(_readConfigFile(config.configPath).config, idRaw, normalizeIdentityId);
      _writeConfigFile(config.configPath, next);
      if (useJson) outputJson({ success: deleted, id: normalizeIdentityId(idRaw) });
      else console.log(deleted ? `Removed Feishu identity: ${normalizeIdentityId(idRaw)}` : "Identity not found.");
      process.exit(deleted ? 0 : 1);
    });

  // ---- Mattermost commands ----
  const mattermost = program.command("mattermost").description("Mattermost identities");

  mattermost
    .command("list")
    .description("List Mattermost bot identities")
    .action(() => {
      const useJson = program.opts().json;
      const config = loadConfig(process.env, { requireOpencode: false });
      const items = config.mattermostBots.map((b) => ({ id: b.id, enabled: b.enabled !== false }));
      if (useJson) outputJson({ items });
      else for (const item of items) console.log(`${item.id} ${item.enabled ? "enabled" : "disabled"}`);
    });

  mattermost
    .command("add")
    .requiredOption("--server-url <serverUrl>", "Mattermost server URL")
    .requiredOption("--access-token <accessToken>", "Bot access token")
    .option("--id <id>", "Identity id (default: default)")
    .option("--disabled", "Add identity but disable it", false)
    .description("Add or update a Mattermost bot identity")
    .action((opts: { serverUrl: string; accessToken: string; id?: string; disabled?: boolean }) => {
      const useJson = program.opts().json;
      const config = loadConfig(process.env, { requireOpencode: false });
      const id = normalizeIdentityId(opts.id);
      const enabled = !opts.disabled;
      updateConfig(config.configPath, (cfg) => upsertMattermostBot(cfg, { id, serverUrl: opts.serverUrl.trim(), accessToken: opts.accessToken.trim(), enabled }, normalizeIdentityId));
      if (useJson) outputJson({ success: true, id, enabled });
      else console.log(`Saved Mattermost identity: ${id}`);
    });

  mattermost
    .command("remove")
    .argument("<id>", "Identity id")
    .description("Remove a Mattermost identity")
    .action((idRaw: string) => {
      const useJson = program.opts().json;
      const config = loadConfig(process.env, { requireOpencode: false });
      const { next, deleted } = deleteMattermostBot(_readConfigFile(config.configPath).config, idRaw, normalizeIdentityId);
      _writeConfigFile(config.configPath, next);
      if (useJson) outputJson({ success: deleted, id: normalizeIdentityId(idRaw) });
      else console.log(deleted ? `Removed Mattermost identity: ${normalizeIdentityId(idRaw)}` : "Identity not found.");
      process.exit(deleted ? 0 : 1);
    });
}

// ---------------------------------------------------------------------------
// Config file helpers (used by CLI)
// ---------------------------------------------------------------------------

function upsertFeishuApp(
  cfg: OpenCodeRouterConfigFile,
  identity: FeishuIdentity,
  normalizeIdentityId: (v: string | undefined) => string,
): OpenCodeRouterConfigFile {
  const next = { ...cfg };
  next.channels = next.channels ?? {};
  const existing = next.channels.feishu ?? {};
  const apps = Array.isArray(existing.apps) ? existing.apps.slice() : [];
  const id = normalizeIdentityId(identity.id);
  const filtered = apps.filter((a) => normalizeIdentityId(a.id) !== id);
  filtered.push({ id, appId: identity.appId, appSecret: identity.appSecret, enabled: identity.enabled !== false, domain: identity.domain ?? "feishu" });
  next.channels.feishu = { ...existing, enabled: true, apps: filtered };
  return next;
}

function deleteFeishuApp(
  cfg: OpenCodeRouterConfigFile,
  idRaw: string,
  normalizeIdentityId: (v: string | undefined) => string,
): { next: OpenCodeRouterConfigFile; deleted: boolean } {
  const id = normalizeIdentityId(idRaw);
  const next = { ...cfg };
  next.channels = next.channels ?? {};
  const existing = next.channels.feishu ?? {};
  const apps = Array.isArray(existing.apps) ? existing.apps.slice() : [];
  const filtered = apps.filter((a) => normalizeIdentityId(a.id) !== id);
  const deleted = filtered.length !== apps.length;
  next.channels.feishu = { ...existing, apps: filtered };
  return { next, deleted };
}

function upsertMattermostBot(
  cfg: OpenCodeRouterConfigFile,
  identity: MattermostIdentity,
  normalizeIdentityId: (v: string | undefined) => string,
): OpenCodeRouterConfigFile {
  const next = { ...cfg };
  next.channels = next.channels ?? {};
  const existing = next.channels.mattermost ?? {};
  const bots = Array.isArray(existing.bots) ? existing.bots.slice() : [];
  const id = normalizeIdentityId(identity.id);
  const filtered = bots.filter((b) => normalizeIdentityId(b.id) !== id);
  filtered.push({ id, serverUrl: identity.serverUrl, accessToken: identity.accessToken, enabled: identity.enabled !== false });
  next.channels.mattermost = { ...existing, enabled: true, bots: filtered };
  return next;
}

function deleteMattermostBot(
  cfg: OpenCodeRouterConfigFile,
  idRaw: string,
  normalizeIdentityId: (v: string | undefined) => string,
): { next: OpenCodeRouterConfigFile; deleted: boolean } {
  const id = normalizeIdentityId(idRaw);
  const next = { ...cfg };
  next.channels = next.channels ?? {};
  const existing = next.channels.mattermost ?? {};
  const bots = Array.isArray(existing.bots) ? existing.bots.slice() : [];
  const filtered = bots.filter((b) => normalizeIdentityId(b.id) !== id);
  const deleted = filtered.length !== bots.length;
  next.channels.mattermost = { ...existing, bots: filtered };
  return { next, deleted };
}
