import { existsSync } from "node:fs";
import { join } from "node:path";

export function opencodeConfigPath(workspaceRoot: string): string {
  // 优先查找 .tron/ 目录（统一管理位置）
  const tronDirJsonc = join(workspaceRoot, ".tron", "tron.jsonc");
  const tronDirJson = join(workspaceRoot, ".tron", "tron.json");
  if (existsSync(tronDirJsonc)) return tronDirJsonc;
  if (existsSync(tronDirJson)) return tronDirJson;
  // 向后兼容：根目录
  const rootJsonc = join(workspaceRoot, "tron.jsonc");
  const rootJson = join(workspaceRoot, "tron.json");
  if (existsSync(rootJsonc)) return rootJsonc;
  if (existsSync(rootJson)) return rootJson;
  // 默认创建到 .tron/
  return tronDirJsonc;
}

export function openworkConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".tron", "openwork.json");
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
