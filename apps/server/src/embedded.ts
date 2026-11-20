/**
 * Shared CLI and desktop startup: one Server and one local Tron child.
 */
import { stopTaskRecovery } from "./task-recovery.js";
import { mkdir } from "node:fs/promises";
import { resolveServerConfig, type CliArgs } from "./config.js";
import type { EnginePoolSnapshot } from "./engine-pool.js";
import type { OpencodeExecutionSnapshot } from "./managed-opencode.js";
import { createServerLogger, startServer } from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { shouldStartManagedEngine } from "./workspaces.js";
import { migrateOpenworkCloudMcpRuntimeConfig } from "./cloud-mcp-health.js";
import { migrateWorkspaceRuntimeConfigToEngineGlobal } from "./runtime-opencode-config-store.js";
import { configuredTron, importConfiguredTronRuntime } from "./local-tron.js";
import { setInstalledOpencodeVersion } from "./routes/core.js";
import type { LocalManagedMcpVaultKeyProvider, ServerConfig } from "./types.js";

export type EmbeddedServerOptions = CliArgs & {
  /** When true, start the Tron engine supplied by the host. */
  manageOpencode?: boolean;
  /** Tron executable supplied by the host. Falls back to OPENWORK_OPENCODE_BIN. */
  opencodeBin?: string;
  /** Working directory supplied by the host. */
  opencodeCwd?: string;
  localManagedMcpVaultKey?: LocalManagedMcpVaultKeyProvider;
  driveFileApproval?: ServerConfig["driveFileApproval"];
  resumeInterruptedTasks?: boolean;
  anonymousInference?: ServerConfig["anonymousInference"];
  freshInstallEngine?: ServerConfig["freshInstallEngine"];
  engineAutoUpgrade?: boolean;
};

export type EmbeddedServerHandle = {
  port: number;
  url: string;
  config: ServerConfig;
  /** Legacy desktop diagnostic fields retained for the host API. */
  managedOpencodeExecution: OpencodeExecutionSnapshot | null;
  managedOpencode: { pid: number | null; isAlive: () => boolean } | null;
  managedOpencodePool: () => EnginePoolSnapshot | null;
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options, { preserveRegisteredWorkspaces: options.manageOpencode === true });
  config.localManagedMcpVaultKey = options.localManagedMcpVaultKey;
  config.driveFileApproval = options.driveFileApproval;
  config.anonymousInference = options.anonymousInference;
  config.freshInstallEngine = options.freshInstallEngine;
  config.engineAutoUpgrade = false;
  const manageEngine = options.manageOpencode === true && !config.externalOpencode
    && !config.opencodeBaseUrl && shouldStartManagedEngine(config.workspaces);
  if (manageEngine) {
    config.localTron = {
      ...configuredTron({ bin: options.opencodeBin }),
      cwd: options.opencodeCwd || process.env.OPENWORK_MANAGED_OPENCODE_CWD,
    };
    if (config.localTron.cwd) await mkdir(config.localTron.cwd, { recursive: true });
  }
  config.resumeInterruptedTasks = options.resumeInterruptedTasks === true && manageEngine;
  const logger = createServerLogger(config);
  if (!config.readOnly) {
    await ensureLocalWorkspaceFiles(config.workspaces);
    await migrateOpenworkCloudMcpRuntimeConfig(config);
    await migrateWorkspaceRuntimeConfigToEngineGlobal(config);
    if (config.localTron) await importConfiguredTronRuntime(config);
  }
  const server = await startServer(config);
  config.port = server.port;
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      try { await stopTaskRecovery(config); }
      finally { await server.stop(); }
    })();
    return stopPromise;
  };
  if (config.localTron) {
    try {
      await server.readyLocalTron();
      setInstalledOpencodeVersion(server.localTronStatus().version ?? null);
      logger.log("info", `Local Tron listening (PID ${server.localTronStatus().pid}, ${config.localTron.bin})`);
    } catch (error) {
      await stop();
      throw error;
    }
  }
  return {
    port: server.port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`,
    config,
    managedOpencodeExecution: null,
    managedOpencode: config.localTron ? {
      get pid() { return server.localTronStatus().pid ?? null; },
      isAlive: () => server.localTronStatus().running,
    } : null,
    managedOpencodePool: () => null,
    stop,
  };
}
