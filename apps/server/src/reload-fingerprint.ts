import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import type { ReloadReason } from "./types.js";
import { exists } from "./utils.js";

export const fingerprintedReloadReasons: ReloadReason[] = [
  "config",
  "agents",
  "skills",
  "commands",
  "plugins",
  "mcp",
];

function shouldSkipDir(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (trimmed === ".git" || trimmed === "node_modules") return true;
  return false;
}

function shouldIgnoreFile(name: string): boolean {
  if (!name) return true;
  if (name === ".DS_Store" || name === "Thumbs.db") return true;
  if (name.startsWith(".") || name.endsWith("~") || name.endsWith(".tmp") || name.endsWith(".swp")) return true;
  return false;
}

async function addIfExists(files: Set<string>, path: string): Promise<void> {
  if (await exists(path)) {
    files.add(resolve(path));
  }
}

async function collectTreeFiles(
  files: Set<string>,
  rootDir: string,
  shouldInclude: (absPath: string) => boolean,
  maxDepth: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  const resolvedRoot = resolve(rootDir);
  if (!(await exists(resolvedRoot))) return;

  const stack: Array<{ dir: string; depth: number }> = [{ dir: resolvedRoot, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (!dir) continue;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name) && depth < maxDepth) {
          stack.push({ dir: absPath, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldIgnoreFile(entry.name)) continue;
      if (shouldInclude(absPath)) files.add(resolve(absPath));
    }
  }
}

async function collectFiles(workspaceRoot: string, reason: ReloadReason): Promise<string[]> {
  const root = resolve(workspaceRoot);
  const files = new Set<string>();

  if (reason === "config" || reason === "mcp") {
    await addIfExists(files, join(root, "tron.jsonc"));
    await addIfExists(files, join(root, "tron.json"));
    await addIfExists(files, join(root, ".wudong", "tron.jsonc"));
    await addIfExists(files, join(root, ".wudong", "tron.json"));
  }

  if (reason === "agents") {
    await addIfExists(files, join(root, "AGENTS.md"));
    const isAgentFile = (absPath: string) => /\.(md|json|jsonc)$/i.test(basename(absPath));
    await collectTreeFiles(files, join(root, ".tron", "agents"), isAgentFile, 1);
    await collectTreeFiles(files, join(root, ".tron", "agent"), isAgentFile, 1);
  }

  if (reason === "skills") {
    await collectTreeFiles(
      files,
      join(root, ".tron", "skills"),
      (absPath) => /^SKILL\.md$/i.test(basename(absPath)),
      2,
    );
  }

  if (reason === "commands") {
    await collectTreeFiles(
      files,
      join(root, ".tron", "commands"),
      (absPath) => /\.md$/i.test(basename(absPath)),
      0,
    );
  }

  if (reason === "plugins") {
    await collectTreeFiles(files, join(root, ".tron", "plugins"), () => true, 0);
  }

  return Array.from(files).sort((a, b) => a.localeCompare(b));
}

export async function computeReloadFingerprint(workspaceRoot: string, reason: ReloadReason): Promise<string> {
  const root = resolve(workspaceRoot);
  const hash = createHash("sha256");
  hash.update(`reason:${reason}\0`);

  const files = await collectFiles(root, reason);
  for (const file of files) {
    let content: Buffer;
    try {
      content = await readFile(file);
    } catch {
      continue;
    }

    const relPath = relative(root, file).split(/[\\/]+/).join("/");
    hash.update("file\0");
    hash.update(relPath);
    hash.update("\0");
    hash.update(String(content.length));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  return hash.digest("hex");
}
