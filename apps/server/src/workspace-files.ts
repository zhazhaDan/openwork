import { existsSync } from "node:fs";
import { join } from "node:path";

export function opencodeConfigPath(workspaceRoot: string): string {
  const jsoncPath = join(workspaceRoot, "tron.jsonc");
  const jsonPath = join(workspaceRoot, "tron.json");
  const hiddenJsoncPath = join(workspaceRoot, ".tron", "tron.jsonc");
  const hiddenJsonPath = join(workspaceRoot, ".tron", "tron.json");
  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  if (existsSync(hiddenJsoncPath)) return hiddenJsoncPath;
  if (existsSync(hiddenJsonPath)) return hiddenJsonPath;
  return jsoncPath;
}

export function openworkConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".tron", "wudongwork.json");
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
