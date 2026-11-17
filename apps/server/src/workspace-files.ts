import { join } from "node:path";

export function opencodeConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".tron", "tron.jsonc");
}

export function openworkConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".tron", "wudong.json");
}

export function projectSkillsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".tron", "skills");
}

export function projectCommandsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".tron", "commands");
}

export function projectPluginsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".tron", "plugins");
}
