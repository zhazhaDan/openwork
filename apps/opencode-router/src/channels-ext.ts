/**
 * channels-ext.ts — Declarative channel registry for extension channels.
 *
 * Each channel defines itself with a ChannelDef describing:
 *  - Where its identities live in runtime Config and config-file OpenCodeRouterConfigFile
 *  - How to create its adapter
 *  - How to validate/construct identities from upsert input
 *  - CLI options for the `add` command
 *
 * Adding a new channel only requires a ChannelDef entry in CHANNEL_DEFINITIONS.
 * All adapter registration, health handlers, HTTP routes, and CLI commands
 * are generated automatically.
 */
import type http from "node:http";
import type { Logger } from "pino";
import type { Command } from "commander";

import type {
  ChannelName,
  Config,
  FeishuIdentity,
  MattermostIdentity,
  ModelRef,
  OpenCodeRouterConfigFile,
} from "./config.js";
import { readConfigFile, writeConfigFile } from "./config.js";
import type { InboundMessagePart, MessageDeliveryResult, OutboundMessagePart } from "./media.js";
import type { MediaStore } from "./media-store.js";

import { createFeishuAdapter, isFeishuPeerId, type FeishuAdapter } from "./feishu.js";
import { createMattermostAdapter, isMattermostPeerId, type MattermostAdapter } from "./mattermost.js";

// Re-export peer ID helpers for bridge.ts.
export { isFeishuPeerId, isMattermostPeerId };

function parseModelString(value: unknown): ModelRef | undefined {
  if (!value || typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const sep = trimmed.indexOf("/");
  if (sep <= 0 || sep === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, sep), modelID: trimmed.slice(sep + 1) };
}

function extractDefaults(
  input: Record<string, unknown>,
  existing?: { defaultAgent?: string; defaultModel?: ModelRef },
): { defaultAgent?: string; defaultModel?: ModelRef } {
  const out: { defaultAgent?: string; defaultModel?: ModelRef } = {};

  if ("defaultAgent" in input) {
    const v = typeof input.defaultAgent === "string" ? input.defaultAgent.trim() : "";
    if (v) out.defaultAgent = v;
  } else if (existing?.defaultAgent) {
    out.defaultAgent = existing.defaultAgent;
  }

  if ("defaultModel" in input) {
    const raw = input.defaultModel;
    if (raw && typeof raw === "object") {
      const m = raw as { providerID?: unknown; modelID?: unknown };
      if (typeof m.providerID === "string" && typeof m.modelID === "string" && m.providerID.trim() && m.modelID.trim()) {
        out.defaultModel = { providerID: m.providerID.trim(), modelID: m.modelID.trim() };
      }
    } else if (typeof raw === "string") {
      const parsed = parseModelString(raw);
      if (parsed) out.defaultModel = parsed;
    }
  } else if (existing?.defaultModel) {
    out.defaultModel = existing.defaultModel;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Generic Channel Definition
// ---------------------------------------------------------------------------

type CliAddOption = {
  flag: string;
  arg: string;
  desc: string;
  required: boolean;
};

type ChannelDef<I extends { id: string; enabled?: boolean; directory?: string }> = {
  /** Channel name literal */
  channel: "feishu" | "mattermost";
  /** Key in channels.<channel> config file block (e.g. "apps" or "bots") */
  listKey: string;

  /** Runtime Config identity list getter */
  runtimeList: (config: Config) => I[];
  /** Runtime Config identity list setter */
  setRuntimeList: (config: Config, identities: I[]) => void;
  /** Config file identity list getter */
  configList: (cfg: OpenCodeRouterConfigFile) => Record<string, unknown>[];
  /** Config file identity list setter (returns updated config file) */
  setConfigList: (cfg: OpenCodeRouterConfigFile, identities: Record<string, unknown>[]) => OpenCodeRouterConfigFile;

  /** Adapter factory */
  createAdapter: (
    identity: I,
    config: Config,
    logger: Logger,
    onMessage: (msg: InboundMessage) => void,
    mediaStore: MediaStore,
  ) => FeishuAdapter | MattermostAdapter;

  /** Required fields for upsert (fieldName → label) */
  requiredFields: [string, string][];

  /** Construct an identity from parsed upsert input + existing identity (for directory merge) */
  buildIdentity: (input: Record<string, unknown>, id: string, existingIdentity?: I) => I;

  /** Derive a default identity id from input fields when user leaves id empty */
  deriveDefaultId: (input: Record<string, unknown>) => string;

  /** Non-secret fields to expose in list responses (for UI prefill on edit) */
  listFields: (keyof I)[];

  /** CLI options for the `add` subcommand */
  cliAddOptions: CliAddOption[];
};

// ---------------------------------------------------------------------------
// Shared types
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
// Health handler types
// ---------------------------------------------------------------------------

export type ExtHealthHandlers = {
  listFeishuIdentities?: () => Promise<{ items: Array<{ id: string; enabled: boolean; running: boolean }> }>;
  upsertFeishuIdentity?: (input: { id?: string; appId: string; appSecret: string; enabled?: boolean; directory?: string; domain?: "feishu" | "lark" }) => Promise<UpsertIdentityResult>;
  deleteFeishuIdentity?: (id: string) => Promise<DeleteIdentityResult>;
  listMattermostIdentities?: () => Promise<{ items: Array<{ id: string; enabled: boolean; running: boolean }> }>;
  upsertMattermostIdentity?: (input: { id?: string; serverUrl: string; accessToken: string; enabled?: boolean; directory?: string }) => Promise<UpsertIdentityResult>;
  deleteMattermostIdentity?: (id: string) => Promise<DeleteIdentityResult>;
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

export function isValidChannel(name: string): name is ChannelName {
  return name === "telegram" || name === "slack" || name === "feishu" || name === "mattermost";
}

// ---------------------------------------------------------------------------
// Channel definitions (the ONLY place channel-specific config lives)
// ---------------------------------------------------------------------------

const FEISHU_DEF: ChannelDef<FeishuIdentity> = {
  channel: "feishu",
  listKey: "apps",

  runtimeList: (c) => c.feishuApps,
  setRuntimeList: (c, v) => {
    c.feishuApps.splice(0, c.feishuApps.length, ...(v as FeishuIdentity[]));
  },
  configList: (cfg) => {
    const ch = cfg.channels?.feishu;
    return Array.isArray((ch as any)?.apps) ? ((ch as any).apps as Record<string, unknown>[]) : [];
  },
  setConfigList: (cfg, identities) => {
    const next = { ...cfg };
    next.channels = next.channels ?? {};
    const existing = next.channels?.feishu ?? {};
    next.channels.feishu = { ...existing, enabled: true, apps: identities as FeishuIdentity[] };
    return next;
  },

  createAdapter: (identity, config, logger, onMessage, mediaStore) =>
    createFeishuAdapter(identity, config, logger, onMessage as any, mediaStore),

  requiredFields: [
    ["appId", "App ID"],
    ["appSecret", "App Secret"],
  ],

  buildIdentity: (input, id, existing): FeishuIdentity => ({
    id,
    appId: String(input.appId ?? "").trim(),
    appSecret: String(input.appSecret ?? "").trim(),
    enabled: input.enabled !== false,
    domain: (input.domain === "lark" ? "lark" : "feishu") as "feishu" | "lark",
    ...(typeof input.directory === "string" && input.directory.trim()
      ? { directory: String(input.directory).trim() }
      : existing?.directory
        ? { directory: existing.directory }
        : {}),
    ...extractDefaults(input, existing),
  }),

  deriveDefaultId: (input) => {
    const appId = typeof input.appId === "string" ? input.appId.trim() : "";
    return appId || "default";
  },

  listFields: ["appId", "domain"],

  cliAddOptions: [
    { flag: "--app-id", arg: "<appId>", desc: "Feishu App ID", required: true },
    { flag: "--app-secret", arg: "<appSecret>", desc: "Feishu App Secret", required: true },
    { flag: "--domain", arg: "<domain>", desc: "feishu or lark (default: feishu)", required: false },
    { flag: "--default-agent", arg: "<agent>", desc: "Default OpenCode agent name", required: false },
    { flag: "--default-model", arg: "<provider/model>", desc: "Default model (providerID/modelID)", required: false },
  ],
};

const MATTERMOST_DEF: ChannelDef<MattermostIdentity> = {
  channel: "mattermost",
  listKey: "bots",

  runtimeList: (c) => c.mattermostBots,
  setRuntimeList: (c, v) => {
    c.mattermostBots.splice(0, c.mattermostBots.length, ...(v as MattermostIdentity[]));
  },
  configList: (cfg) => {
    const ch = cfg.channels?.mattermost;
    return Array.isArray((ch as any)?.bots) ? ((ch as any).bots as Record<string, unknown>[]) : [];
  },
  setConfigList: (cfg, identities) => {
    const next = { ...cfg };
    next.channels = next.channels ?? {};
    const existing = next.channels?.mattermost ?? {};
    next.channels.mattermost = { ...existing, enabled: true, bots: identities as MattermostIdentity[] };
    return next;
  },

  createAdapter: (identity, config, logger, onMessage, mediaStore) =>
    createMattermostAdapter(identity, config, logger, onMessage as any, mediaStore),

  requiredFields: [
    ["serverUrl", "Server URL"],
    ["accessToken", "Access Token"],
  ],

  buildIdentity: (input, id, existing): MattermostIdentity => ({
    id,
    serverUrl: String(input.serverUrl ?? "").trim(),
    accessToken: String(input.accessToken ?? "").trim(),
    enabled: input.enabled !== false,
    ...(typeof input.directory === "string" && input.directory.trim()
      ? { directory: String(input.directory).trim() }
      : existing?.directory
        ? { directory: existing.directory }
        : {}),
    ...extractDefaults(input, existing),
  }),

  deriveDefaultId: (input) => {
    const url = typeof input.serverUrl === "string" ? input.serverUrl.trim() : "";
    try {
      const host = new URL(url).host;
      return host ? `mm-${host}` : "default";
    } catch {
      return "default";
    }
  },

  listFields: ["serverUrl"],

  cliAddOptions: [
    { flag: "--server-url", arg: "<serverUrl>", desc: "Mattermost server URL", required: true },
    { flag: "--access-token", arg: "<accessToken>", desc: "Bot access token", required: true },
    { flag: "--default-agent", arg: "<agent>", desc: "Default OpenCode agent name", required: false },
    { flag: "--default-model", arg: "<provider/model>", desc: "Default model (providerID/modelID)", required: false },
  ],
};

/**
 * All registered channel definitions. Adding a new channel means:
 * 1. Define its ChannelDef here
 * 2. Add its identity type to config.ts (ChannelName, Config, OpenCodeRouterConfigFile)
 * 3. Add coercion function in config.ts
 * Everything else (adapters, health, HTTP, CLI) is automatic.
 */
const CHANNEL_DEFS = [FEISHU_DEF, MATTERMOST_DEF] as ChannelDef<any>[];

// ---------------------------------------------------------------------------
// Generic: adapter registration
// ---------------------------------------------------------------------------

export function registerExtAdapters(
  config: Config,
  adapters: Map<string, Adapter>,
  logger: Logger,
  handleInbound: HandleInbound,
  mediaStore: MediaStore,
) {
  const adapterKey = (channel: string, id: string) => `${channel}:${id}`;

  for (const def of CHANNEL_DEFS) {
    const identities = def.runtimeList(config).filter((a: any) => a.enabled !== false);
    if (identities.length === 0) {
      logger.info(`${def.channel} adapters disabled`);
      continue;
    }
    for (const identity of identities) {
      const key = adapterKey(def.channel, identity.id);
      logger.debug({ identityId: identity.id }, `${def.channel} adapter enabled`);
      const base = def.createAdapter(identity, config, logger, handleInbound, mediaStore);
      adapters.set(key, { ...base, key });
    }
  }
}

// ---------------------------------------------------------------------------
// Generic: health handlers factory
// ---------------------------------------------------------------------------

export function createExtBridgeHandlers(
  config: Config,
  adapters: Map<string, Adapter>,
  logger: Logger,
  handleInbound: HandleInbound,
  mediaStore: MediaStore,
  normalizeIdentityId: (value: string | undefined) => string,
  startAdapterBounded: (
    adapter: Adapter,
    options: { timeoutMs: number; onError?: (error: unknown) => void },
  ) => Promise<AdapterStartResult>,
): ExtHealthHandlers {
  const adapterKey = (channel: string, id: string) => `${channel}:${id}`;

  function channelCap(def: ChannelDef<any>): string {
    return def.channel.charAt(0).toUpperCase() + def.channel.slice(1);
  }

  function makeListHandler(def: ChannelDef<any>) {
    return async () => ({
      items: def.runtimeList(config).map((item: any) => {
        const extras: Record<string, unknown> = {};
        for (const f of def.listFields) {
          const v = item[f];
          if (v !== undefined && v !== "") extras[f as string] = v;
        }
        return {
          id: item.id,
          enabled: item.enabled !== false,
          running: adapters.has(adapterKey(def.channel, item.id)),
          ...(item.directory ? { directory: item.directory } : {}),
          ...(item.defaultAgent ? { defaultAgent: item.defaultAgent } : {}),
          ...(item.defaultModel ? { defaultModel: item.defaultModel } : {}),
          ...extras,
        };
      }),
    });
  }

  function makeUpsertHandler(def: ChannelDef<any>) {
    return async (input: Record<string, unknown>) => {
      // Validate required fields
      for (const [field, label] of def.requiredFields) {
        const val = typeof input[field] === "string" ? String(input[field]).trim() : "";
        if (!val) throw new Error(`${label} is required`);
      }

      const id = normalizeIdentityId(
        typeof input.id === "string" && input.id.trim() ? input.id : def.deriveDefaultId(input),
      );
      if (id === "env") throw new Error("identity id 'env' is reserved");
      const directoryInput = typeof input.directory === "string" ? String(input.directory).trim() : "";

      // Read existing identity from runtime list (for directory merge)
      const existingIdentity = def.runtimeList(config).find((a: any) => a.id === id);

      // Persist to config file
      const { config: current } = readConfigFile(config.configPath);
      const entries = def.configList(current);
      const nextEntries: Record<string, unknown>[] = [];
      let found = false;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const entryId = normalizeIdentityId(typeof entry.id === "string" ? entry.id : "default");
        if (entryId !== id) {
          nextEntries.push(entry);
          continue;
        }
        found = true;
        const existingDirectory = typeof entry.directory === "string" ? String(entry.directory).trim() : "";
        const mergedInput = {
          ...input,
          directory: directoryInput || existingDirectory,
        };
        nextEntries.push(def.buildIdentity(mergedInput, id, existingIdentity) as Record<string, unknown>);
      }
      if (!found) {
        nextEntries.push(def.buildIdentity(input, id) as Record<string, unknown>);
      }

      const next = def.setConfigList(current, nextEntries);
      next.version = next.version ?? 1;
      writeConfigFile(config.configPath, next);
      config.configFile = next;

      // Rebuild runtime list from config entries
      const rebuilt: any[] = nextEntries.map((e) =>
        def.buildIdentity(e, normalizeIdentityId(typeof e.id === "string" ? e.id : undefined)),
      );
      def.setRuntimeList(config, rebuilt);

      // Start/stop adapter
      const runtimeIdentity = def.runtimeList(config).find((a: any) => a.id === id)!;
      const key = adapterKey(def.channel, id);
      const existing = adapters.get(key);
      const enabled = runtimeIdentity.enabled !== false;

      if (!enabled) {
        if (existing) {
          try { await existing.stop(); } catch (error) {
            logger.warn({ error, channel: def.channel, identityId: id }, `failed to stop ${def.channel} adapter`);
          }
          adapters.delete(key);
        }
        return { id, enabled: false, applied: true } satisfies UpsertIdentityResult;
      }

      if (existing) {
        try { await existing.stop(); } catch (error) {
          logger.warn({ error, channel: def.channel, identityId: id }, `failed to stop existing ${def.channel} adapter`);
        }
        adapters.delete(key);
      }
      const base = def.createAdapter(runtimeIdentity, config, logger, handleInbound, mediaStore);
      const adapter = { ...base, key };
      adapters.set(key, adapter);

      const startResult = await startAdapterBounded(adapter, {
        timeoutMs: 5_000,
        onError: (error) => {
          logger.error({ error, channel: def.channel, identityId: id }, `${def.channel} adapter start failed`);
          adapters.delete(key);
        },
      });

      if (startResult.status === "timeout") return { id, enabled: true, applied: false, starting: true } satisfies UpsertIdentityResult;
      if (startResult.status === "error") return { id, enabled: true, applied: false, error: String(startResult.error) } satisfies UpsertIdentityResult;
      return { id, enabled: true, applied: true } satisfies UpsertIdentityResult;
    };
  }

  function makeDeleteHandler(def: ChannelDef<any>) {
    return async (rawId: string) => {
      const id = normalizeIdentityId(rawId);
      if (id === "env") throw new Error("env identity cannot be deleted");

      const { config: current } = readConfigFile(config.configPath);
      const entries = def.configList(current);
      const nextEntries = entries.filter((e) => {
        if (!e || typeof e !== "object") return false;
        return normalizeIdentityId(typeof e.id === "string" ? e.id : "default") !== id;
      });
      const deleted = nextEntries.length !== entries.length;

      const next = def.setConfigList(current, nextEntries);
      next.version = next.version ?? 1;
      writeConfigFile(config.configPath, next);
      config.configFile = next;

      def.setRuntimeList(config, def.runtimeList(config).filter((a: any) => a.id !== id));

      const key = adapterKey(def.channel, id);
      const existing = adapters.get(key);
      if (existing) {
        try { await existing.stop(); } catch (error) {
          logger.warn({ error, channel: def.channel, identityId: id }, `failed to stop ${def.channel} adapter`);
        }
        adapters.delete(key);
      }
      return { id, deleted } satisfies DeleteIdentityResult;
    };
  }

  const handlers: ExtHealthHandlers = {};
  for (const def of CHANNEL_DEFS) {
    const cap = channelCap(def);
    (handlers as any)[`list${cap}Identities`] = makeListHandler(def);
    (handlers as any)[`upsert${cap}Identity`] = makeUpsertHandler(def);
    (handlers as any)[`delete${cap}Identity`] = makeDeleteHandler(def);
  }

  return handlers;
}

// ---------------------------------------------------------------------------
// Generic: HTTP route handler
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
 * Handle HTTP routes for all extension channels defined in CHANNEL_DEFS.
 * Returns true if the request was handled, false to fall through to the next handler.
 */
export async function handleExtChannelRoute(
  pathname: string,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handlers: ExtHealthHandlers,
): Promise<boolean> {
  for (const def of CHANNEL_DEFS) {
    const { channel } = def;
    const cap = channel.charAt(0).toUpperCase() + channel.slice(1);
    const listKey = `list${cap}Identities` as keyof ExtHealthHandlers;
    const upsertKey = `upsert${cap}Identity` as keyof ExtHealthHandlers;
    const deleteKey = `delete${cap}Identity` as keyof ExtHealthHandlers;

    // GET /identities/<channel>
    if (pathname === `/identities/${channel}` && method === "GET") {
      if (!handlers[listKey]) { jsonResponse(res, 404, { ok: false, error: "Not supported" }); return true; }
      try {
        const result = await (handlers[listKey] as any)();
        jsonResponse(res, 200, { ok: true, ...result });
      } catch (error) {
        jsonResponse(res, errorStatus(error), { ok: false, error: String(error instanceof Error ? error.message : error) });
      }
      return true;
    }

    // POST /identities/<channel>
    if (pathname === `/identities/${channel}` && method === "POST") {
      if (!handlers[upsertKey]) { jsonResponse(res, 404, { ok: false, error: "Not supported" }); return true; }
      try {
        const raw = await readBody(req);
        const payload = JSON.parse(raw || "{}");

        // Validate required fields
        for (const [field, label] of def.requiredFields) {
          const val = typeof payload[field] === "string" ? String(payload[field]).trim() : "";
          if (!val) {
            jsonResponse(res, 400, { ok: false, error: `${label} is required` });
            return true;
          }
        }

        const id = typeof payload.id === "string" ? payload.id.trim() : undefined;
        const directory = typeof payload.directory === "string" ? payload.directory.trim() : undefined;
        const enabled = payload.enabled === undefined ? undefined : payload.enabled === true || payload.enabled === "true";

        const upsertPayload: Record<string, unknown> = {
          ...payload,
          ...(id ? { id } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          ...(directory ? { directory } : {}),
        };

        const result = await (handlers[upsertKey] as any)(upsertPayload);
        jsonResponse(res, 200, { ok: true, [channel]: result });
      } catch (error) {
        jsonResponse(res, errorStatus(error), { ok: false, error: String(error instanceof Error ? error.message : error) });
      }
      return true;
    }

    // DELETE /identities/<channel>/:id
    const deletePrefix = `/identities/${channel}/`;
    if (pathname.startsWith(deletePrefix) && method === "DELETE") {
      if (!handlers[deleteKey]) { jsonResponse(res, 404, { ok: false, error: "Not supported" }); return true; }
      const identityId = pathname.slice(deletePrefix.length).trim();
      if (!identityId) { jsonResponse(res, 400, { ok: false, error: "id is required" }); return true; }
      try {
        const result = await (handlers[deleteKey] as any)(identityId);
        jsonResponse(res, 200, { ok: true, [channel]: result });
      } catch (error) {
        jsonResponse(res, 500, { ok: false, error: String(error) });
      }
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Generic: CLI command registration
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

  for (const def of CHANNEL_DEFS) {
    const { channel } = def;

    // Parent command
    const parent = program.command(channel).description(`${channel} identities`);

    // list
    parent
      .command("list")
      .description(`List ${channel} identities`)
      .action(() => {
        const useJson = program.opts().json;
        const config = loadConfig(process.env, { requireOpencode: false });
        const items = def.runtimeList(config).map((a: any) => ({ id: a.id, enabled: a.enabled !== false }));
        if (useJson) outputJson({ items });
        else for (const item of items) console.log(`${item.id} ${item.enabled ? "enabled" : "disabled"}`);
      });

    // add — with dynamically declared required/optional options
    const requiredOpts = def.cliAddOptions.filter((o) => o.required);
    const optionalOpts = def.cliAddOptions.filter((o) => !o.required);

    // Commander only supports `requiredOption` during command creation.
    // Workaround: create the command with a dummy action, then overwrite.
    let addActionSet = false;
    const addCmd = parent
      .command("add")
      .option("--id <id>", "Identity id (default: default)")
      .option("--disabled", "Add identity but disable it", false)
      .option("--directory <directory>", "Optional default workspace directory")
      .description(`Add or update a ${channel} identity`);

    // Add required options by calling option() and then validating manually
    for (const opt of requiredOpts) {
      addCmd.option(opt.flag, opt.desc);
    }

    // Add optional options
    for (const opt of optionalOpts) {
      addCmd.option(opt.flag, opt.desc);
    }

    addCmd.action((opts: Record<string, unknown>) => {
      const useJson = program.opts().json;
      const config = loadConfig(process.env, { requireOpencode: false });
      const id = normalizeIdentityId(typeof opts.id === "string" ? opts.id : undefined);
      const enabled = !opts.disabled;

      // Validate required fields manually
      const missing: string[] = [];
      for (const opt of requiredOpts) {
        const key = opt.flag.replace(/^--/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        const val = typeof opts[key] === "string" ? String(opts[key]).trim() : "";
        if (!val) missing.push(opt.flag);
      }
      if (missing.length > 0) {
        console.error(`Missing required options: ${missing.join(", ")}`);
        process.exit(1);
      }

      // Build identity config entry
      const entry: Record<string, unknown> = { id, enabled };
      for (const opt of [...requiredOpts, ...optionalOpts]) {
        const key = opt.flag.replace(/^--/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        const val = opts[key];
        if (typeof val === "string" && val.trim()) {
          entry[key] = val.trim();
        }
      }
      if (typeof opts.directory === "string" && opts.directory.trim()) {
        entry.directory = opts.directory.trim();
      }

      const identity = def.buildIdentity(entry, id);
      const existingEntries = def.configList(config.configFile);
      const filtered = existingEntries.filter(
        (e: Record<string, unknown>) => normalizeIdentityId(typeof e.id === "string" ? e.id : undefined) !== id,
      );
      filtered.push(identity as Record<string, unknown>);

      updateConfig(config.configPath, (cfg) => def.setConfigList(cfg, filtered));
      if (useJson) outputJson({ success: true, id, enabled });
      else console.log(`Saved ${channel} identity: ${id}`);
    });

    // remove
    parent
      .command("remove")
      .argument("<id>", "Identity id")
      .description(`Remove a ${channel} identity`)
      .action((idRaw: string) => {
        const useJson = program.opts().json;
        const config = loadConfig(process.env, { requireOpencode: false });
        const id = normalizeIdentityId(idRaw);
        const entries = def.configList(config.configFile);
        const next = entries.filter(
          (e: Record<string, unknown>) => normalizeIdentityId(typeof e.id === "string" ? e.id : undefined) !== id,
        );
        const deleted = next.length !== entries.length;
        updateConfig(config.configPath, (cfg) => def.setConfigList(cfg, next));
        if (useJson) outputJson({ success: deleted, id });
        else console.log(deleted ? `Removed ${channel} identity: ${id}` : "Identity not found.");
        process.exit(deleted ? 0 : 1);
      });
  }
}
