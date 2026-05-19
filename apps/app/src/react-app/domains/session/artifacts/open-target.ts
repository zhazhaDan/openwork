/** @jsxImportSource react */
import type { UIMessage } from "ai";

export type OpenTargetKind = "url" | "file";
export type OpenTargetPreview = "browser" | "markdown" | "sheet" | "image" | "pdf" | "html" | "text" | "external";

export type OpenTarget = {
  id: string;
  kind: OpenTargetKind;
  value: string;
  name: string;
  preview: OpenTargetPreview;
  confidence: number;
  reason: string;
  exists?: boolean;
  size?: number;
  updatedAt?: number;
};

const WORKSPACES_PREFIX_PATTERN = /^workspaces\/[^/]+\//i;
const WORKSPACE_ID_PREFIX_PATTERN = /^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i;

const FILE_PATTERN = /(?:^|[\s"'`([{])((?:\.{1,2}[/\\]|~[/\\]|[/\\])?[\w.\-]+(?:[/\\][\w.\-]+)+\.[a-z][a-z0-9]{0,9}|[\w.\-]+\.[a-z][a-z0-9]{0,9})/gi;
const URL_PATTERN = /https?:\/\/[^\s)\]}>"'`]+/gi;
const SOCKET_PATTERN = /(?:ws|wss):\/\/[^\s)\]}>"'`]+/gi;
const ARTIFACT_FILE_PREVIEWS = new Set<OpenTargetPreview>(["markdown", "sheet", "image", "pdf", "html"]);

function normalizePath(path: string) {
  return path
    .trim()
    .replace(/[\\]+/g, "/")
    .replace(/^\.\//, "")
    .replace(WORKSPACES_PREFIX_PATTERN, "")
    .replace(WORKSPACE_ID_PREFIX_PATTERN, "");
}

function basename(value: string) {
  const clean = value.split(/[?#]/)[0] ?? value;
  return clean.split("/").filter(Boolean).pop() ?? value;
}

function extname(value: string) {
  const name = basename(value).toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

export function classifyOpenTarget(value: string, kind: OpenTargetKind): OpenTargetPreview {
  if (kind === "url") return "browser";
  const ext = extname(value);
  if ([".md", ".markdown", ".mdx"].includes(ext)) return "markdown";
  if ([".csv", ".tsv", ".xlsx", ".xls", ".ods"].includes(ext)) return "sheet";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".html", ".htm"].includes(ext)) return "html";
  if ([".txt", ".log", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".ts", ".tsx", ".js", ".jsx", ".css", ".scss"].includes(ext)) return "text";
  return "external";
}

function targetFromFile(path: string, confidence: number, reason: string): OpenTarget | null {
  const normalized = normalizePath(path).replace(/[.,;:]+$/, "");
  if (!normalized || normalized.length > 500 || !normalized.includes(".")) return null;
  return {
    id: `file:${normalized.toLowerCase()}`,
    kind: "file",
    value: normalized,
    name: basename(normalized),
    preview: classifyOpenTarget(normalized, "file"),
    confidence,
    reason,
  };
}

function targetFromUrl(url: string, confidence: number, reason: string): OpenTarget | null {
  const stripped = url.trim().replace(/[.,;:`\\]+$/, "");
  let clean = stripped;
  try {
    const parsed = new URL(stripped);
    if (/^\/+$/i.test(parsed.pathname) && !parsed.search && !parsed.hash) {
      clean = parsed.origin;
    }
  } catch {
    // Keep the stripped value; regex extraction already validated the shape.
  }
  if (!clean) return null;
  return {
    id: `url:${clean}`,
    kind: "url",
    value: clean,
    name: basename(clean) || clean,
    preview: "browser",
    confidence,
    reason,
  };
}

function addTarget(map: Map<string, OpenTarget>, target: OpenTarget | null) {
  if (!target) return;
  const existing = map.get(target.id);
  if (!existing || target.confidence >= existing.confidence) map.set(target.id, target);
}

function isArtifactTarget(target: OpenTarget) {
  return target.kind === "url" || ARTIFACT_FILE_PREVIEWS.has(target.preview);
}

export function isCollectibleArtifactTarget(target: OpenTarget) {
  return target.kind === "file" && target.exists === true && ARTIFACT_FILE_PREVIEWS.has(target.preview);
}

export function isLocalhostBrowserTarget(target: OpenTarget) {
  return target.kind === "url" && /(?:https?|wss?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(target.value);
}

function browserTargetScore(target: OpenTarget) {
  if (!isLocalhostBrowserTarget(target)) return -1;
  try {
    const url = new URL(target.value);
    let score = target.confidence;
    if (url.protocol === "http:" || url.protocol === "https:") score += 20;
    if ((url.pathname === "" || url.pathname === "/") && !url.search && !url.hash) score += 40;
    if (!url.pathname.startsWith("/api/")) score += 10;
    return score;
  } catch {
    return target.confidence;
  }
}

export function selectAutoOpenTarget(targets: OpenTarget[]): OpenTarget | null {
  const browserTargets = targets.filter(isLocalhostBrowserTarget);
  if (browserTargets.length > 0) {
    return [...browserTargets].sort((left, right) => browserTargetScore(right) - browserTargetScore(left))[0] ?? null;
  }
  return targets.find(shouldAutoOpenTarget) ?? null;
}

function scanText(map: Map<string, OpenTarget>, text: string, confidence: number, reason: string) {
  if (!text) return;
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match[0]) addTarget(map, targetFromUrl(match[0], confidence, reason));
  }
  SOCKET_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(SOCKET_PATTERN)) {
    if (match[0]) addTarget(map, targetFromUrl(match[0], confidence, reason));
  }
  FILE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(FILE_PATTERN)) {
    if (match[1]) addTarget(map, targetFromFile(match[1], confidence, reason));
  }
}

function isDiscoveryTool(toolName: unknown) {
  if (typeof toolName !== "string") return false;
  return ["glob", "grep", "search", "find"].includes(toolName.toLowerCase());
}

export function deriveOpenTargets(messages: UIMessage[]): OpenTarget[] {
  const targets = new Map<string, OpenTarget>();

  for (const message of messages) {
    for (const part of message.parts) {
      const record = part as any;
      if (part.type === "text" && typeof record.text === "string") {
        scanText(targets, record.text, message.role === "assistant" ? 65 : 40, "message");
        continue;
      }
      if (part.type === "dynamic-tool") {
        const discoveryTool = isDiscoveryTool(record.toolName);
        const values = [record.input, record.output].flatMap((value) => {
          if (discoveryTool || !value || typeof value !== "object") return [];
          const entries = value as Record<string, unknown>;
          return [entries.path, entries.file, ...(Array.isArray(entries.files) ? entries.files : [])];
        });
        for (const value of values) {
          if (typeof value === "string") addTarget(targets, targetFromFile(value, 95, "tool metadata"));
        }
        if (!discoveryTool) {
          scanText(targets, JSON.stringify(record.output ?? record.input ?? ""), 75, "tool output");
        }
      }
    }
  }

  return Array.from(targets.values())
    .filter(isArtifactTarget)
    .sort((left, right) => right.confidence - left.confidence);
}

export function shouldAutoOpenTarget(target: OpenTarget): boolean {
  if (target.kind === "url") return isLocalhostBrowserTarget(target);
  return target.exists === true && target.confidence >= 65 && ["markdown", "sheet", "image", "pdf", "html"].includes(target.preview);
}
