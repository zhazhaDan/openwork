import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Keep the host's existing engine launch contract. */
export function configuredTron(options: { bin?: string; env?: NodeJS.ProcessEnv } = {}): {
  bin: string;
  source: "env";
} {
  const env = options.env ?? process.env;
  const bin = options.bin?.trim() || env.OPENWORK_OPENCODE_BIN?.trim();
  if (!bin) throw new Error("Tron engine path is missing. Supply opencodeBin or OPENWORK_OPENCODE_BIN in the startup configuration.");
  return { bin, source: "env" };
}

export function tronHistoryDatabase(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRON_DB?.trim()) return env.TRON_DB === ":memory:" ? ":memory:" : resolve(env.TRON_DB);
  return join(env.XDG_DATA_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".local", "share"), "tron", "tron.db");
}

const imports = new WeakMap<import('./types.js').ServerConfig, Promise<void>>();

/** Serialize host reads and reconciliation across timer and explicit sync requests. */
export function importConfiguredTronRuntime(config: import('./types.js').ServerConfig): Promise<void> {
  const pending = (imports.get(config) ?? Promise.resolve()).catch(() => {}).then(() => importTronRuntime(config));
  imports.set(config, pending);
  return pending;
}

/** Desktop employee profiles live outside the engine's private config directory. */
export async function readConfiguredEmployeeAgents(): Promise<Record<string, unknown>> {
  const { resolveGlobalOpencodeConfigPath } = await import('@openwork/paths');
  const { readJsoncFile } = await import('./jsonc.js');
  const { data } = await readJsoncFile<Record<string, unknown>>(resolveGlobalOpencodeConfigPath(), {});
  const agents = data.agents;
  if (agents === null || typeof agents !== 'object' || Array.isArray(agents)) return {};
  return Object.fromEntries(Object.entries(agents).filter(([id]) => /^wudong-employee-[a-zA-Z0-9_-]+$/.test(id)));
}

async function importTronRuntime(config: import('./types.js').ServerConfig): Promise<void> {
  const { resolveGlobalOpencodeConfigPath, resolveWorkspaceOpencodeConfigPath } = await import('@openwork/paths');
  const { readJsoncFile } = await import('./jsonc.js');
  const { ENGINE_GLOBAL_RUNTIME_CONFIG_ID, reconcileTronRuntimeConfig } = await import('./runtime-opencode-config-store.js');
  const sources = [{ id: ENGINE_GLOBAL_RUNTIME_CONFIG_ID, path: resolveGlobalOpencodeConfigPath() },
    ...config.workspaces.map(workspace => ({ id: workspace.id, path: resolveWorkspaceOpencodeConfigPath(workspace.path) }))];
  for (const source of sources) {
    const { data } = await readJsoncFile<Record<string, unknown>>(source.path, {});
    const { provider, mcp } = normalizeTronHostConfig(data);
    const resolvedProviders = provider ? await (await import('./provider-config-templates.js')).resolveProviderConfigTemplates(provider, {
      directory: dirname(source.path), environment: new Map(), inheritedEnvironment: process.env,
      localProviderIds: new Set(Object.keys(provider)), remoteEnvironmentNames: new Map(),
    }) : undefined;
    if (!config.readOnly) await reconcileTronRuntimeConfig(config, source.id, {
      provider: resolvedProviders?.providers ?? {}, mcp,
    });
  }
}

export function normalizeTronHostConfig(data: Record<string, unknown>) {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : {};
  const nativeMcp = record(data.mcp);
  const mcp = Object.fromEntries(Object.entries('servers' in nativeMcp ? record(nativeMcp.servers) : nativeMcp)
    .filter(([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value))
    .map(([name, value]) => [name, record(value)]));
  const provider = { ...record(data.provider), ...Object.fromEntries(Object.entries(record(data.providers)).map(([name, input]) => {
    const value = record(input);
    return [name, { ...value, ...(typeof value.package === 'string' ? { npm: value.package } : {}),
      ...(value.settings ? { options: record(value.settings) } : {}),
      ...(value.models ? { models: Object.fromEntries(Object.entries(record(value.models)).map(([id, inputModel]) => {
        const model = record(inputModel), capabilities = record(model.capabilities);
        return [id, { ...model, ...(typeof capabilities.tools === 'boolean' ? { tool_call: capabilities.tools } : {}),
          ...(Array.isArray(capabilities.input) || Array.isArray(capabilities.output) ? { modalities: {
            input: capabilities.input ?? ['text'], output: capabilities.output ?? ['text'],
          } } : {}) }];
      })) } : {}) }];
  })) };
  return { provider, mcp };
}
