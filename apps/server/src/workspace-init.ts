import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { ensureDir, exists } from "./utils.js";
import { ApiError } from "./errors.js";
import { openworkConfigPath, opencodeConfigPath } from "./workspace-files.js";
import { readJsoncFile, writeJsoncFile } from "./jsonc.js";
import type { ReloadReason } from "./types.js";

const OPENWORK_ARTIFACT_GUIDANCE = `<!-- OPENWORK_ARTIFACTS_START -->
## OpenWork Artifacts

OpenWork can preview, edit, and download standard artifacts when you create or update them in the workspace.

- Prefer standard output files for user-visible deliverables: Markdown (\`.md\`), CSV (\`.csv\`), Excel workbooks (\`.xlsx\`), and browser previews (\`index.html\` or a local \`http://localhost:<port>\` URL).
- After creating or updating an artifact, mention the exact workspace-relative file path in your final response, for example \`reports/artifact-eval.md\` or \`reports/artifact-eval.xlsx\`.
- Do not invent \`Workspace/<id>/...\` paths unless a tool returns them; prefer clean workspace-relative paths.
- For websites or React/UI previews, start the dev server when useful and mention the \`http://localhost:<port>\` URL. Socket URLs such as \`ws://localhost:<port>/...\` are diagnostic hints, not primary preview links.
- For spreadsheets, use \`.csv\` for simple tabular data and \`.xlsx\` when the user asks for Excel/XLS specifically.
<!-- OPENWORK_ARTIFACTS_END -->`;

const OPENWORK_AGENT = `---
description: OpenWork default agent
mode: primary
temperature: 0.2
---

You are OpenWork.

When the user refers to "you", they mean the OpenWork app and the current workspace.

Your job:
- Help the user work on files safely.
- Automate repeatable work.
- Keep behavior portable and reproducible.

## Browser

OpenWork has a built-in browser and can also control the user's external Chrome.

Two MCP tool sets are available:

1. **openwork-browser** — Built-in browser panel inside the app.
   - The panel opens automatically when you call any openwork-browser tool.
   - Use this for general browsing tasks ("go to facebook.com", "search for X").
   - Call \`openwork-browser_hide_browser\` when the browsing task is done.
   - The user can see what you're doing in real time.

2. **chrome** — The user's real Chrome browser (external).
   - Use this when the user needs their real cookies, sign-ins, or extensions
     ("check my gmail", "open my github notifications").
   - **Always call \`chrome_chrome_status\` first** before using any other chrome tool.
   - If status is unavailable, tell the user:
     "Enable remote debugging in Chrome: go to chrome://inspect/#remote-debugging,
     turn it on, and allow incoming connections. No restart needed on Chrome 144+."
   - Do NOT attempt to kill, restart, or relaunch Chrome yourself.
   - Do NOT run bash commands to start Chrome with --remote-debugging-port.
   - If the user cannot enable debugging, offer the built-in browser as a fallback.

Default to **openwork-browser** unless the user explicitly needs their real
browser session (cookies, sign-ins, extensions). If the user says "go to X"
without specifying, use the built-in browser.

## Memory

Two kinds:
1. Behavior memory (shareable, in git): \`.opencode/skills/**\`, \`.opencode/agents/**\`, repo docs
2. Private memory (never commit): tokens, credentials, local config, logs

Hard rule: never copy private memory into repo files. Store only redacted summaries, schemas, and stable pointers.

## Working style

- If required setup or credentials are missing, ask one targeted question and continue once provided.
- If you change code, run the smallest meaningful test.
- If steps repeat, factor them into a skill.
- Prefer clear, practical steps over abstract explanations.

${OPENWORK_ARTIFACT_GUIDANCE}
`;

type WorkspaceOpenworkConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

type EnsureWorkspaceFilesResult = {
  changed: boolean;
  reloadReasons: ReloadReason[];
};

function normalizePreset(preset: string | null | undefined): string {
  const trimmed = preset?.trim() ?? "";
  if (!trimmed) return "starter";
  return trimmed;
}

async function ensureWorkspaceOpenworkConfig(workspaceRoot: string, preset: string): Promise<boolean> {
  const path = openworkConfigPath(workspaceRoot);
  if (await exists(path)) return false;
  const now = Date.now();
  const config: WorkspaceOpenworkConfig = {
    version: 1,
    workspace: {
      name: basename(workspaceRoot) || "Workspace",
      createdAt: now,
      preset,
    },
    authorizedRoots: [workspaceRoot],
    reload: null,
  };
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return true;
}

async function ensureOpencodeConfig(workspaceRoot: string): Promise<boolean> {
  const path = opencodeConfigPath(workspaceRoot);
  if (await exists(path)) {
    await readJsoncFile<Record<string, unknown>>(path, {});
    return false;
  }

  await writeJsoncFile(path, {
    $schema: "https://opencode.ai/config.json",
    default_agent: "openwork",
  });
  return true;
}

async function ensureOpenworkAgent(workspaceRoot: string): Promise<boolean> {
  const agentsDir = join(workspaceRoot, ".opencode", "agents");
  const agentPath = join(agentsDir, "openwork.md");
  await ensureDir(agentsDir);
  if (!(await exists(agentPath))) {
    await writeFile(agentPath, OPENWORK_AGENT.endsWith("\n") ? OPENWORK_AGENT : `${OPENWORK_AGENT}\n`, "utf8");
    return true;
  }
  const current = await readFile(agentPath, "utf8");
  const start = "<!-- OPENWORK_ARTIFACTS_START -->";
  const end = "<!-- OPENWORK_ARTIFACTS_END -->";
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  const next = startIndex >= 0 && endIndex > startIndex
    ? `${current.slice(0, startIndex)}${OPENWORK_ARTIFACT_GUIDANCE}${current.slice(endIndex + end.length)}`
    : `${current.trimEnd()}\n\n${OPENWORK_ARTIFACT_GUIDANCE}\n`;
  if (next !== current) {
    await writeFile(agentPath, next, "utf8");
    return true;
  }
  return false;
}

export async function ensureWorkspaceFiles(workspaceRoot: string, presetInput: string): Promise<EnsureWorkspaceFilesResult> {
  const preset = normalizePreset(presetInput);
  if (!workspaceRoot.trim()) {
    throw new ApiError(400, "invalid_workspace_path", "workspace path is required");
  }
  await ensureDir(workspaceRoot);
  const reloadReasons = new Set<ReloadReason>();
  if (await ensureOpencodeConfig(workspaceRoot)) reloadReasons.add("config");
  if (await ensureOpenworkAgent(workspaceRoot)) reloadReasons.add("agents");
  const openworkConfigChanged = await ensureWorkspaceOpenworkConfig(workspaceRoot, preset);
  return {
    changed: openworkConfigChanged || reloadReasons.size > 0,
    reloadReasons: Array.from(reloadReasons),
  };
}

export async function readRawOpencodeConfig(path: string): Promise<{ exists: boolean; content: string | null }> {
  const hasFile = await exists(path);
  if (!hasFile) {
    return { exists: false, content: null };
  }
  const content = await readFile(path, "utf8");
  return { exists: true, content };
}
