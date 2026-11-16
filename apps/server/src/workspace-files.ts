import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceOpencodeConfigPath } from "@openwork/paths";

export function opencodeConfigPath(workspaceRoot: string): string {
  const tronCandidates = [
    join(workspaceRoot, ".tron", "tron.jsonc"),
    join(workspaceRoot, ".tron", "tron.json"),
    join(workspaceRoot, "tron.jsonc"),
    join(workspaceRoot, "tron.json"),
  ];
  const tronConfig = tronCandidates.find((candidate) => existsSync(candidate));
  if (tronConfig) return tronConfig;
  return resolveWorkspaceOpencodeConfigPath(workspaceRoot);
}

export function openworkConfigPath(workspaceRoot: string): string {
  const candidates = [
    join(workspaceRoot, ".tron", "wudong.json"),
    join(workspaceRoot, ".tron", "tron.json"),
    join(workspaceRoot, ".opencode", "openwork.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function projectRuntimeDir(workspaceRoot: string): string {
  const tronRoot = join(workspaceRoot, ".tron");
  return existsSync(tronRoot) ? tronRoot : join(workspaceRoot, ".opencode");
}

export function projectSkillsDir(workspaceRoot: string): string {
  return join(projectRuntimeDir(workspaceRoot), "skills");
}

export function projectCommandsDir(workspaceRoot: string): string {
  return join(projectRuntimeDir(workspaceRoot), "commands");
}

export function projectPluginsDir(workspaceRoot: string): string {
  return join(projectRuntimeDir(workspaceRoot), "plugins");
}
