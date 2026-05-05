import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export function opencodeConfigPath(workspaceRoot: string): string {
  const jsoncPath = join(workspaceRoot, "tron.jsonc");
  const jsonPath = join(workspaceRoot, "tron.json");
  const hiddenJsoncPath = join(workspaceRoot, ".tron", "tron.jsonc");
  const hiddenJsonPath = join(workspaceRoot, ".tron", "tron.json");
  if (existsSync(hiddenJsoncPath)) return hiddenJsoncPath;
  if (existsSync(hiddenJsonPath)) return hiddenJsonPath;
  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  return hiddenJsoncPath;
}

export function openworkConfigPath(workspaceRoot: string): string {
  const newPath = join(workspaceRoot, ".tron", "wudong.json");
  // 向后兼容：如果当前 workspace 还有老的 openwork.json 且没有 wudong.json，自动迁移
  const legacyPath = join(workspaceRoot, ".tron", "openwork.json");
  if (!existsSync(newPath) && existsSync(legacyPath)) {
    try {
      renameSync(legacyPath, newPath);
    } catch {
      // 迁移失败则回退用老路径，避免功能中断
      return legacyPath;
    }
  }
  return newPath;
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
