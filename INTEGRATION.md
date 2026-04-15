# OpenWork 对接文档

## 在第三方应用中嵌入「聊天控制 Agent 操控电脑」的能力

本文档面向**需要在自己的产品里集成 OpenWork 的 agent 能力、但要完全自定义 UI** 的开发者。跟着本文从零到跑通一个端到端的自定义前端只需几百行胶水代码，OpenWork 本身一行都不用改。

目标读者：

- 已有 Electron / Tauri / Web / 其他桌面应用的工程团队
- 希望让用户通过"聊天"驱动 agent 执行完整 computer use 任务（浏览器自动化、终端命令、文件读写、调用自定义 MCP 工具）
- 不打算复用 OpenWork 的 UI，只需要其后端能力

---

## 目录

1. [概述与架构](#1-概述与架构)
2. [前置条件](#2-前置条件)
3. [快速开始（5 步跑通）](#3-快速开始5-步跑通)
4. [详细集成步骤](#4-详细集成步骤)
5. [HTTP API 参考](#5-http-api-参考)
6. [SSE 事件参考](#6-sse-事件参考)
7. [opencode.json 配置参考](#7-opencodejson-配置参考)
8. [认证与权限](#8-认证与权限)
9. [模型凭证配置](#9-模型凭证配置)
10. [错误处理](#10-错误处理)
11. [Electron 完整示例](#11-electron-完整示例)
12. [常见陷阱与 FAQ](#12-常见陷阱与-faq)
13. [附录：关键源码位置](#13-附录关键源码位置)

---

## 1. 概述与架构

### 1.1 OpenWork 提供的能力

集成之后，你的应用可以：

- **完整 computer use**：agent 可以执行 bash 命令、读写编辑文件、grep/glob 搜索、调用任意 MCP 工具
- **浏览器自动化**：通过 Chrome DevTools MCP 让 agent 打开网页、点击、输入、截图、导航
- **自定义 MCP 工具**：接入任何符合 MCP 协议的本地或远程工具服务器
- **多 session 管理**：持久化的会话历史、撤销、todo 追踪
- **权限审批**：可配置的"ask / allow / deny"流程，阻断敏感操作等待用户确认
- **流式响应**：text / reasoning / tool call 实时推送到你的 UI

### 1.2 进程拓扑

OpenWork 对外表现为**单一可执行文件** `openwork-orchestrator`，它内部管理三个子进程：

```
┌─────────── 用户机器 ───────────────────────────────┐
│                                                    │
│ 你的应用（Electron / Tauri / Web / 原生）         │
│   ├─ main / backend: 进程监督                     │
│   │   └─ spawn openwork-orchestrator serve        │
│   │                                                │
│   └─ renderer / frontend: 你的自定义 UI           │
│       │                                            │
│       │ HTTP + SSE (Authorization: Bearer token)  │
│       ▼                                            │
│                                                    │
│ openwork-orchestrator (supervisor)                 │
│   │                                                │
│   ├─ openwork-server  127.0.0.1:<port>            │
│   │   ├─ /workspaces/*, /workspace/:id/*          │
│   │   ├─ /w/:id/opencode/*  (透明代理到 OpenCode) │
│   │   └─ /approvals/*                             │
│   │                                                │
│   ├─ opencode serve   127.0.0.1:<random>          │
│   │   ├─ Session / Prompt / Abort                 │
│   │   ├─ Event stream (SSE)                       │
│   │   ├─ 内置工具：bash / read / write / edit ... │
│   │   └─ MCP 客户端 → 各 MCP 子进程               │
│   │                                                │
│   └─ opencode-router  (可选，用于 Slack/Telegram) │
│                                                    │
└────────────────────────────────────────────────────┘
```

**为什么是这个设计？**

- `openwork-server` 把 `/w/:id/opencode/*` 作为**透明代理**暴露 OpenCode 的 API，屏蔽了 OpenCode 内部的 basic-auth 和随机端口
- 你的前端**只**需要一个 bearer token 对接 openwork-server，不需要知道 OpenCode 的端口和凭证
- 会话创建、消息发送、事件订阅全部通过代理路径走 OpenCode，但生命周期、MCP CRUD、权限、审计由 openwork-server 统一管理

### 1.3 数据流（一次对话）

```
用户输入                     你的 UI
    ↓                           ↑ 渲染
你的前端 → HTTP POST /w/:id/opencode/session/<sid>/prompt_async
            ↓
      openwork-server (代理 + 注入认证头)
            ↓
      opencode serve (agent 循环)
            ↓
      Claude API ←→ Tool Calls (bash / chrome / file / 自定义 MCP)
            ↓
      SSE 事件流 → 你的前端订阅
            ↓                       ↑
      openwork-server ← 你的前端 HTTP GET (via SDK)
```

---

## 2. 前置条件

### 2.1 用户机器上需要有的东西

| 项 | 说明 | 必需？ |
|---|---|---|
| `openwork-orchestrator` 可执行文件 | 由你的应用打包分发或首次启动时下载 | 必需 |
| `openwork-server` 二进制 | orchestrator 的 sidecar，打包在同目录 | 必需 |
| `opencode` 二进制 | orchestrator 的 sidecar，打包在同目录 | 必需 |
| Google Chrome | 仅使用浏览器自动化时需要 | 可选 |
| Node.js (含 `npx`) | 如果通过 `npx -y chrome-devtools-mcp@latest` 启动 MCP | 可选 |
| 模型 API key | Anthropic / OpenAI / 其他 provider 的密钥 | 必需 |

### 2.2 分发 orchestrator 的方式（推荐：完整打包）

你需要把 3 个二进制打包进你的 Electron 应用：

| 二进制 | 来源 | 说明 |
|---|---|---|
| `openwork-orchestrator` | 本仓库构建 | 进程监督器，你 spawn 这一个 |
| `openwork-server` | 本仓库构建 | HTTP API 层 |
| `opencode` | 从 GitHub 下载 | AI agent 运行时（[anomalyco/opencode](https://github.com/anomalyco/opencode)） |

启动时：

```
openwork-orchestrator serve --sidecar-source bundled --sidecar-dir <path/to/sidecars>
```

### 2.3 获取二进制的 3 种途径

#### 途径 A：在 OpenWork 仓库中运行 prepare-sidecar 脚本（推荐）

这是 OpenWork 自己的 Tauri 桌面应用使用的同一套构建流程。**前提：你的构建机器上需要有 `bun` 和 `pnpm`。**

```bash
# 1. clone openwork（如果还没有）
git clone https://github.com/different-ai/openwork.git
cd openwork
pnpm install

# 2. 运行 prepare-sidecar 脚本，指定输出目录
#    这会：构建 orchestrator + server + router，下载 opencode
node apps/desktop/scripts/prepare-sidecar.mjs --outdir /path/to/your-electron-app/resources/sidecars
```

脚本会自动：
- 检测当前平台和架构
- 用 `bun build --compile` 编译 `openwork-orchestrator`、`openwork-server`、`opencode-router`
- 从 `https://github.com/anomalyco/opencode/releases` 下载对应平台的 `opencode` 二进制
- 全部输出到你指定的 `--outdir` 目录

产出的文件（以 macOS arm64 为例）：

```
your-electron-app/resources/sidecars/
├── openwork-orchestrator          # orchestrator 二进制
├── openwork-server                # server 二进制
├── opencode                       # opencode 二进制（从 GitHub 下载）
├── opencode-router                # router 二进制（可选）
└── versions.json                  # 各组件版本和 SHA256
```

> 如果要**跨平台构建**（比如在 macOS 上为 Linux 打包），需要分别在每个目标平台上运行，或使用 CI 矩阵。

#### 途径 B：分步手动构建

```bash
cd openwork

# 构建 orchestrator（仅当前平台）
pnpm --filter openwork-orchestrator build:bin
# 产出：apps/orchestrator/dist/bin/openwork

# 构建 server（仅当前平台）
pnpm --filter openwork-server build:bin
# 产出：apps/server/dist/bin/openwork-server

# 下载 opencode（以 macOS arm64 为例）
curl -fsSL -o /tmp/opencode.zip \
  "https://github.com/anomalyco/opencode/releases/download/v1.2.27/opencode-darwin-arm64.zip"
unzip -q /tmp/opencode.zip -d /tmp/opencode-extract
cp /tmp/opencode-extract/opencode your-electron-app/resources/sidecars/

# 复制构建产物
cp apps/orchestrator/dist/bin/openwork your-electron-app/resources/sidecars/openwork-orchestrator
cp apps/server/dist/bin/openwork-server your-electron-app/resources/sidecars/openwork-server

# 赋予执行权限
chmod +x your-electron-app/resources/sidecars/*
```

**所有平台构建**（用于 CI）：

```bash
# 一次性构建所有平台
pnpm --filter openwork-orchestrator build:bin:all
pnpm --filter openwork-server build:bin:all

# 产出名称格式：
# openwork-bun-darwin-arm64, openwork-bun-darwin-x64-baseline,
# openwork-bun-linux-x64-baseline, openwork-bun-linux-arm64,
# openwork-bun-windows-x64
```

然后按平台分目录存放：

```
resources/sidecars/
├── darwin-arm64/
│   ├── openwork-orchestrator
│   ├── openwork-server
│   └── opencode
├── darwin-x64/
│   ├── openwork-orchestrator
│   ├── openwork-server
│   └── opencode
├── linux-x64/
│   └── ...
└── win32-x64/
    ├── openwork-orchestrator.exe
    ├── openwork-server.exe
    └── opencode.exe
```

#### 途径 C：从 GitHub Releases 下载预构建产物

```bash
VERSION="0.11.206"

# orchestrator（二进制名格式：openwork-bun-<platform>）
curl -fsSL -o resources/sidecars/openwork-orchestrator \
  "https://github.com/different-ai/openwork/releases/download/openwork-orchestrator-v${VERSION}/openwork-bun-darwin-arm64"

# openwork-server（同上）
curl -fsSL -o resources/sidecars/openwork-server \
  "https://github.com/different-ai/openwork/releases/download/openwork-orchestrator-v${VERSION}/openwork-server-bun-darwin-arm64"

# opencode（从 anomalyco/opencode 仓库）
OPENCODE_VERSION="1.2.27"
curl -fsSL -o /tmp/opencode.zip \
  "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-darwin-arm64.zip"
unzip -q /tmp/opencode.zip -d /tmp/opencode-extract
cp /tmp/opencode-extract/opencode resources/sidecars/

chmod +x resources/sidecars/*
```

**各平台的 opencode 资产名**：

| 平台 | 资产文件名 |
|---|---|
| macOS arm64 | `opencode-darwin-arm64.zip` |
| macOS x64 | `opencode-darwin-x64-baseline.zip` |
| Linux x64 | `opencode-linux-x64-baseline.tar.gz` |
| Linux arm64 | `opencode-linux-arm64.tar.gz` |
| Windows x64 | `opencode-windows-x64-baseline.zip` |
| Windows arm64 | `opencode-windows-arm64.zip` |

### 2.4 Electron 打包配置

把 sidecar 目录配置到 Electron 的 `extraResources`（以 electron-builder 为例）：

```json
{
  "extraResources": [
    {
      "from": "resources/sidecars/",
      "to": "sidecars/",
      "filter": ["**/*"]
    }
  ],
  "mac": {
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.inherit.plist"
  },
  "asarUnpack": ["resources/sidecars/**"]
}
```

macOS entitlements 需要允许子进程执行：

```xml
<!-- build/entitlements.mac.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
</dict>
</plist>
```

在 main 进程中定位 sidecar 路径：

```ts
import { app } from "electron";
import path from "node:path";

function getSidecarDir(): string {
  // electron-builder 会把 extraResources 放到 resources/ 下
  // 开发时在项目根目录，打包后在 app.asar.unpacked/../
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "sidecars");
  } else {
    return path.join(app.getAppPath(), "resources", "sidecars");
  }
}

function getOrchestratorBin(): string {
  const dir = getSidecarDir();
  const name = process.platform === "win32" ? "openwork-orchestrator.exe" : "openwork-orchestrator";
  return path.join(dir, name);
}
```

### 2.5 CI 自动化构建脚本参考

在你的 Electron 项目中创建一个构建脚本，自动从 OpenWork 源码生成 sidecar：

```bash
#!/bin/bash
# scripts/prepare-sidecars.sh
# 从 OpenWork 仓库构建 sidecar 二进制

set -euo pipefail

OPENWORK_DIR="${OPENWORK_DIR:-../openwork}"   # OpenWork 仓库路径
OUTDIR="resources/sidecars"

echo "==> Building sidecars from ${OPENWORK_DIR}"

# 方式 1：使用现有的 prepare-sidecar 脚本（最省心）
node "${OPENWORK_DIR}/apps/desktop/scripts/prepare-sidecar.mjs" --outdir "${OUTDIR}"

# 方式 2：分步构建（更可控）
# cd "${OPENWORK_DIR}"
# pnpm --filter openwork-orchestrator build:bin
# pnpm --filter openwork-server build:bin
# cp apps/orchestrator/dist/bin/openwork "${OUTDIR}/openwork-orchestrator"
# cp apps/server/dist/bin/openwork-server "${OUTDIR}/openwork-server"
# # opencode 需要单独下载...

echo "==> Sidecars ready in ${OUTDIR}:"
ls -lh "${OUTDIR}/"
```

在 `package.json` 的构建流程里调用：

```json
{
  "scripts": {
    "prepare:sidecars": "bash scripts/prepare-sidecars.sh",
    "build": "npm run prepare:sidecars && electron-builder"
  }
}
```

---

## 3. 快速开始（5 步跑通）

在开始写复杂的 Electron 集成前，强烈建议先用一个 Node 脚本跑通最小链路。这能在 30 分钟内验证方案可行，并让你熟悉 API 的 shape。

### 第 1 步：安装 SDK

在你的项目里：

```bash
npm install @opencode-ai/sdk
# 或
pnpm add @opencode-ai/sdk
```

> **重要**：浏览器/renderer 环境只能用 `@opencode-ai/sdk/v2/client`（纯 fetch 实现）。不要用 `@opencode-ai/sdk/v2`（会拉 Node-only 代码）。

### 第 2 步：启动 orchestrator

在一个新终端：

```bash
# 假设你已经有 openwork-orchestrator 可执行文件
openwork-orchestrator serve \
  --workspace /absolute/path/to/your-workspace \
  --openwork-port 48787 \
  --openwork-token dev-client-token-change-me \
  --openwork-host-token dev-host-token-change-me \
  --approval auto \
  --log-format json
```

看到类似这样的日志表示就绪：

```json
{"body":"Ready","attributes":{"workspace":"...","opencode":{"baseUrl":"http://127.0.0.1:52847"},"openwork":{"baseUrl":"http://127.0.0.1:48787"}},...}
```

### 第 3 步：创建工作区

在另一个终端：

```bash
curl -X POST http://127.0.0.1:48787/workspaces/local \
  -H "X-OpenWork-Host-Token: dev-host-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"folderPath":"/absolute/path/to/your-workspace","name":"demo","preset":"starter"}'
```

返回里的 `activeId` 就是你后续要用的 `workspaceId`（它是路径哈希，确定性）。

### 第 4 步：跑最小 Node 脚本

```ts
// test-integration.mjs
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const BASE_URL = "http://127.0.0.1:48787";
const TOKEN = "dev-client-token-change-me";
const WORKSPACE_ID = "<从上一步拿到的 activeId>";
const WORKSPACE_DIR = "/absolute/path/to/your-workspace";

const client = createOpencodeClient({
  baseUrl: `${BASE_URL}/w/${WORKSPACE_ID}/opencode`,
  headers: { Authorization: `Bearer ${TOKEN}` },
  fetch: globalThis.fetch,
});

// 1. 健康检查
const health = await client.global.health();
console.log("health:", health);

// 2. 创建会话
const { id: sessionID } = await client.session.create({ directory: WORKSPACE_DIR });
console.log("session:", sessionID);

// 3. 订阅事件（开始在后台监听）
const controller = new AbortController();
const sub = await client.event.subscribe(undefined, { signal: controller.signal });
(async () => {
  for await (const event of sub.stream) {
    console.log("event:", event.type, JSON.stringify(event.properties).slice(0, 200));
    if (event.type === "session.idle" && event.properties?.sessionID === sessionID) {
      controller.abort();
      break;
    }
  }
})();

// 4. 发送 prompt（立即返回）
await client.session.promptAsync({
  sessionID,
  directory: WORKSPACE_DIR,
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  parts: [{ type: "text", text: "用 bash 列出 /tmp 下的前 5 个文件" }],
});

console.log("prompt sent, waiting for events...");
```

运行：

```bash
node test-integration.mjs
```

你应该看到事件流打印出 `message.updated`、`message.part.delta`、`message.part.updated`（tool 类型，tool=`bash`）和 `session.idle`。

### 第 5 步：验证浏览器自动化

```bash
# 添加 chrome-devtools MCP
curl -X POST "http://127.0.0.1:48787/workspace/${WORKSPACE_ID}/mcp" \
  -H "Authorization: Bearer dev-client-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"name":"control-chrome","config":{"type":"local","command":["npx","-y","chrome-devtools-mcp@latest"]}}'

# 重载引擎让 MCP 生效
curl -X POST "http://127.0.0.1:48787/workspace/${WORKSPACE_ID}/engine/reload" \
  -H "Authorization: Bearer dev-client-token-change-me"
```

然后再发一次 prompt：`"打开 google.com 告诉我页面标题"`，事件流里应该出现 `chrome-devtools_*` 工具调用。

至此你已经验证了整条链路可用。**下面进入生产级集成的细节**。

---

## 4. 详细集成步骤

### Step 1：启动 Orchestrator（由你的应用 main 进程负责）

在 Electron 里这个动作在主进程，在 Web 后端里是你的 Node 服务。目标是：用子进程方式运行 `openwork-orchestrator serve`，拿到它就绪后的 `baseUrl`，把 `baseUrl + token` 传给你的 UI 层。

#### 1.1 需要你填写的配置

建立一个配置对象：

```ts
interface OrchestratorConfig {
  // 必需：orchestrator 可执行文件绝对路径
  binaryPath: string;               // 示例: "/Applications/YourApp.app/Contents/Resources/sidecars/darwin-arm64/openwork-orchestrator"

  // 必需：工作区目录（agent 能操作的根目录）
  workspacePath: string;            // 示例: "/Users/alice/Documents/my-project"

  // 必需：自己生成的 tokens（建议用 crypto.randomBytes(32).toString("hex")）
  clientToken: string;              // 用于 renderer 所有 API 调用
  hostToken: string;                // 仅 main 进程用，用于审批回复

  // 必需：openwork-server 端口。传 0 让系统分配；否则你自己挑一个 8000-65535 的空闲端口
  openworkPort: number;             // 示例: 48787 或 0（自动）

  // 必需：sidecar 来源。bundled = 你打包好了；downloaded = 让 orchestrator 自己拉
  sidecarSource: "bundled" | "downloaded";
  sidecarDir: string;               // bundled 时指向你 app resources 里的目录

  // 可选：审批模式。auto = 免审批（适合受控桌面应用），manual = 需要人工点同意
  approvalMode: "auto" | "manual";  // 推荐: "auto"

  // 可选：是否启动 opencode-router（Slack/Telegram 集成，多数场景不需要）
  enableRouter?: boolean;           // 默认 false

  // 可选：log 目录（orchestrator 的 stdout/stderr 会写到这里）
  logDir: string;                   // 示例: app.getPath("logs") + "/orchestrator"
}
```

#### 1.2 生成 token 的示例代码

```ts
import crypto from "node:crypto";

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

const clientToken = generateToken();  // 每次启动生成新的
const hostToken = generateToken();
```

推荐每次启动生成新 token（而不是持久化），避免泄漏风险。

#### 1.3 Spawn 命令完整参数

```ts
import { spawn } from "node:child_process";

const args = [
  "serve",
  "--workspace", config.workspacePath,
  "--openwork-port", String(config.openworkPort),
  "--openwork-token", config.clientToken,
  "--openwork-host-token", config.hostToken,
  "--approval", config.approvalMode,
  "--log-format", "json",
  "--sidecar-source", config.sidecarSource,
  "--sidecar-dir", config.sidecarDir,
];

if (!config.enableRouter) {
  args.push("--no-opencode-router");
}

const child = spawn(config.binaryPath, args, {
  cwd: config.workspacePath,
  env: {
    ...process.env,
    // 确保 GUI 应用能找到 npx / node 等命令（macOS 常见坑）
    PATH: [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      process.env.PATH ?? "",
    ].filter(Boolean).join(":"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
```

#### 1.4 全部可用 CLI flag 清单（源码核对）

源码：[apps/orchestrator/src/cli.ts](apps/orchestrator/src/cli.ts)

| Flag | 默认 | 说明 |
|---|---|---|
| `--workspace <path>` | `cwd` | 工作区目录，agent 能看到的根 |
| `--openwork-port <n>` | 自动 | openwork-server 端口；传 0 或省略由系统分配 |
| `--openwork-token <str>` | 随机生成 | 客户端 bearer token |
| `--openwork-host-token <str>` | 随机生成 | Host admin token（审批、workspace 管理） |
| `--approval <mode>` | `manual` | `manual` 或 `auto` |
| `--approval-timeout <ms>` | 内置默认 | 审批等待超时 |
| `--remote-access` | `false` | 监听 `0.0.0.0`（否则仅 `127.0.0.1`） |
| `--read-only` | `false` | 启动为只读模式 |
| `--opencode-port <n>` | 自动 | OpenCode 端口 |
| `--opencode-host <host>` | `127.0.0.1` | OpenCode 绑定地址 |
| `--opencode-hot-reload <bool>` | `true` | 文件变化时是否热重载 opencode |
| `--sidecar-source <mode>` | `auto` | `auto`/`bundled`/`downloaded`/`external` |
| `--sidecar-dir <path>` | 系统缓存 | sidecar 存放目录 |
| `--sidecar-base-url <url>` | 默认 CDN | 自定义下载基地址 |
| `--sidecar-manifest <url>` | 默认 | 自定义 manifest |
| `--opencode-source <mode>` | `auto` | 同 sidecar-source 但只针对 opencode |
| `--allow-external` | `false` | 允许用外部二进制路径（开发时） |
| `--openwork-server-bin <path>` | 自动 | 外部二进制路径（需 `--allow-external`） |
| `--opencode-bin <path>` | 自动 | 同上 |
| `--opencode-router-bin <path>` | 自动 | 同上 |
| `--opencode-router` / `--no-opencode-router` | 读配置 | 启动或禁用 Slack/Telegram router |
| `--sandbox <mode>` | `none` | `none`/`auto`/`docker`/`container` |
| `--cors <origins>` | `*` | CORS 允许源 |
| `--log-format <fmt>` | `pretty` | `json`/`pretty`/`text` |
| `--no-tui` | - | 强制禁用 TUI（`serve` 命令已自动设置） |
| `--detach` | `false` | fork 后独立运行 |
| `--verbose` | `false` | 额外诊断 |
| `--check` | `false` | 运行健康检查后退出（用于 CI） |

**环境变量**：上面所有 flag 都有对应的 `OPENWORK_*` 环境变量替代，例如 `--openwork-port` 对应 `OPENWORK_PORT`。完整列表见 [apps/orchestrator/src/cli.ts](apps/orchestrator/src/cli.ts) 中的 `readNumber`/`readString` 调用。

### Step 2：等待服务就绪

orchestrator 启动是异步的，你**必须**等健康检查 200 后再发送业务请求。

#### 2.1 通过日志判断

`--log-format json` 下，每行 stdout 是一个 OpenTelemetry LogRecord。关键的"就绪"信号是 `body === "Ready"` 的那条记录，它的 `attributes.openwork.baseUrl` 就是 openwork-server 的 URL：

```ts
import readline from "node:readline";

function waitForReady(child: ChildProcess): Promise<{ baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout! });
    const timeout = setTimeout(() => reject(new Error("orchestrator ready timeout")), 30_000);

    rl.on("line", (line) => {
      let record: any;
      try { record = JSON.parse(line); } catch { return; }
      if (record.body === "Ready" && record.attributes?.openwork?.baseUrl) {
        clearTimeout(timeout);
        rl.close();
        resolve({ baseUrl: record.attributes.openwork.baseUrl });
      }
    });

    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`orchestrator exited with code ${code}`));
    });
  });
}
```

#### 2.2 通过健康检查 HTTP 判断（备选）

如果你已经知道端口（自己指定了 `--openwork-port`），可以直接轮询：

```ts
async function waitForHealth(baseUrl: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("health check timeout");
}
```

`GET /health` 无需认证，返回 `{ ok: true, version: "...", uptimeMs: number }`。

### Step 3：创建工作区

orchestrator 启动时传的 `--workspace` 只是告诉它"从这里开始"，实际要让 openwork-server 追踪这个目录你还需要发一次：

```
POST http://127.0.0.1:<port>/workspaces/local
X-OpenWork-Host-Token: <hostToken>      ← 注意用 host token，不是 client token
Content-Type: application/json

{
  "folderPath": "/absolute/path/to/your-workspace",  // 必需
  "name": "My Project",                              // 可选，默认用 basename
  "preset": "starter"                                // 可选，默认 "starter"
}
```

**返回**：

```json
{
  "activeId": "<workspaceId>",
  "workspaces": [{ "id": "...", "name": "...", "path": "...", ... }],
  "persisted": true
}
```

`activeId` 就是你后面所有 `/w/:id/*` 路径里的 `:id`。它是路径的确定性哈希，同一个 `folderPath` 会永远得到同一个 id，所以无需持久化存储。

**preset 的作用**：`"starter"` 会在工作区根目录写一份默认的 [opencode.json](#7-opencodejson-配置参考)，并预装 `control-chrome` MCP。如果你想完全自定义初始化内容，可以先发一次 `preset: "empty"`（如果支持），然后自己 POST MCP。

### Step 4：配置 MCP 工具

#### 4.1 已经开箱即用的内置工具

**不需要任何配置**，agent 默认就能使用：

- `bash` — 执行 shell 命令
- `read` / `write` / `edit` / `multiedit` — 文件读写
- `grep` / `glob` — 搜索
- `webfetch` — 抓取 URL
- `todowrite` — 管理 todo 列表

**权限控制**：默认这些工具首次执行会触发权限审批。要免审批，修改工作区根目录的 `opencode.json`（见 [第 7 节](#7-opencodejson-配置参考)）或调用 `client.permission.reply` 回复 `"always"`。

#### 4.2 添加 Chrome DevTools MCP（浏览器自动化）

如果 workspace 是用 `preset: "starter"` 创建的，`control-chrome` 已经写入。否则：

```http
POST /workspace/{workspaceId}/mcp
Authorization: Bearer {clientToken}
Content-Type: application/json

{
  "name": "control-chrome",
  "config": {
    "type": "local",
    "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
  }
}
```

然后**必须 reload**：

```http
POST /workspace/{workspaceId}/engine/reload
Authorization: Bearer {clientToken}
```

reload 后 agent 会自动发现 `chrome-devtools_*` 系列工具（点击、输入、截图、导航等）。

> **为什么用 npx 而不是直接 `chrome-devtools-mcp`？** 因为 GUI 应用不继承 shell PATH，直接调用会 `ENOENT`。`npx` 会帮你处理。

#### 4.3 添加自定义 MCP

**本地子进程 MCP**：

```json
{
  "name": "my-custom-tools",
  "config": {
    "type": "local",
    "command": ["node", "/absolute/path/to/my-mcp-server.js"],
    "environment": { "MY_API_KEY": "..." }
  }
}
```

**远程 HTTP/SSE MCP**：

```json
{
  "name": "my-remote-tools",
  "config": {
    "type": "remote",
    "url": "https://mcp.example.com/sse",
    "headers": { "Authorization": "Bearer abc123" }
  }
}
```

添加后同样需要 `POST /workspace/:id/engine/reload` 才会生效。

#### 4.4 列出 / 删除 MCP

```
GET    /workspace/{workspaceId}/mcp
DELETE /workspace/{workspaceId}/mcp/{name}
```

#### 4.5 哪些能力属于哪个工具

集成时 agent 会自动选择工具。你不需要"告诉 agent 用哪个工具"，只要在 prompt 里描述目标即可：

| 用户意图 | agent 会调用的工具 |
|---|---|
| "列出 /tmp 下的文件" | `bash` |
| "读 README.md 的前 20 行" | `read` |
| "把 app.ts 里的 foo 改成 bar" | `edit` |
| "在代码里搜 TODO 注释" | `grep` |
| "打开 google.com 搜 xxx" | `chrome-devtools_*` |
| "调用天气 API 查北京天气" | 你的自定义 MCP tool |

### Step 5：创建 SDK 客户端（UI 层）

在 renderer / frontend 里安装并初始化 SDK：

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

// 这些值从你的 main 进程通过 contextBridge (Electron) 或启动参数注入
const config = {
  baseUrl: "http://127.0.0.1:48787",    // openwork-server base URL
  clientToken: "...",                   // 从 main 进程传入
  workspaceId: "...",                   // 从第 3 步拿到
  workspaceDir: "/absolute/path",       // 工作区绝对路径
};

export const client = createOpencodeClient({
  // 关键：baseUrl 指向 openwork-server 的代理路径，SDK 所有方法都会走这里
  baseUrl: `${config.baseUrl}/w/${config.workspaceId}/opencode`,
  headers: { Authorization: `Bearer ${config.clientToken}` },
  fetch: globalThis.fetch,
});
```

**重要**：`baseUrl` 一定是 `{serverUrl}/w/{workspaceId}/opencode`（带 `/opencode` 后缀），这样 SDK 发出的 `/session`、`/event`、`/permission` 等请求都会经过 openwork-server 的代理，自动加上 OpenCode 的 basic-auth 和 `x-opencode-directory` header。

如果你用原始 fetch 调用 openwork-server 原生路由（如 `/workspaces/local`、`/workspace/:id/mcp`），那是另一个 baseUrl，不带 `/w/:id/opencode` 后缀。

### Step 6：创建会话

```ts
const { id: sessionID } = await client.session.create({
  directory: config.workspaceDir,   // 必需：告诉 OpenCode 会话绑定到哪个目录
});
```

返回值结构：

```ts
{
  id: string;
  title: string | null;
  directory: string;
  time: { created: number; updated: number };
  parentID?: string;
}
```

你应该把 `sessionID` 存到你的应用状态里（redux/zustand/其他），后续所有消息操作都带上它。

### Step 7：发送消息

**核心 API**：`client.session.promptAsync`。

```ts
await client.session.promptAsync({
  sessionID,                                  // 必需
  directory: config.workspaceDir,             // 必需
  model: {                                    // 必需
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
  },
  parts: [                                    // 必需：消息的组成部分
    { type: "text", text: "用 bash 列出 /tmp 下的文件" },
  ],
  // 以下是可选：
  agent: "openwork",                          // 使用哪个 agent 配置（默认 default_agent）
  system: "...",                              // override system prompt
  reasoning_effort: "medium",                 // "low" | "medium" | "high" | "xhigh" | "max"
  tools: { bash: true, edit: false },         // 按名字禁用/启用工具
});
```

> **⚠️ 关键**：`promptAsync` **立即返回空对象 `{}`**。真正的结果（文本、工具调用、错误）全部通过 SSE 事件流推送。**不要 `await` 它期待拿到结果**，也不要用 `try/catch` 捕获业务错误——错误会作为 `session.error` 事件到达。只有参数/网络错误会 throw。

#### 7.1 parts 的所有合法形态

```ts
type PartInput =
  // 纯文本
  | { type: "text"; text: string }

  // 文件（图片、PDF、任意附件）
  | {
      type: "file";
      url: string;         // file://, data:, http(s)://, 或 base64 data url
      filename?: string;
      mime?: string;       // "image/png", "application/pdf", ...
    }

  // @ 提及某个 agent（消息里的 agent 块）
  | { type: "agent"; name: string };
```

**带图片的消息示例**：

```ts
parts: [
  { type: "text", text: "这张截图里有什么？" },
  {
    type: "file",
    url: "data:image/png;base64,iVBORw0KGgo...",
    filename: "screenshot.png",
    mime: "image/png",
  },
],
```

#### 7.2 中止进行中的会话

```ts
await client.session.abort({ sessionID, directory: config.workspaceDir });
```

注意：abort 只会停止下一步工具调用，**已经执行的副作用不会回滚**（例如已写入的文件不会被删除）。

### Step 8：订阅事件流

这是整个集成里最复杂的部分。你要：

1. 建立一个长连 SSE 订阅
2. 过滤出你关心的会话（订阅是 workspace 级广播）
3. 处理各种事件类型，更新 UI 状态
4. 处理断线重连，并在重连后从 snapshot 补齐可能丢失的状态

#### 8.1 建立订阅

```ts
const controller = new AbortController();
const sub = await client.event.subscribe(undefined, { signal: controller.signal });

try {
  for await (const rawEvent of sub.stream) {
    handleEvent(rawEvent);
  }
} catch (err) {
  if (!controller.signal.aborted) {
    // 网络或服务端错误：走重连逻辑
    scheduleReconnect();
  }
}
```

#### 8.2 事件分发

```ts
function handleEvent(event: { type: string; properties?: any }) {
  const sid = event.properties?.sessionID;
  if (sid && sid !== currentSessionID) return; // 过滤掉其他会话

  switch (event.type) {
    case "message.updated":
      // 新建或更新一条消息，properties.info 里有 id/role/sessionID
      upsertMessage(event.properties.info);
      break;

    case "message.part.updated":
      // 新建或更新一个 part（text/reasoning/tool/file）
      upsertPart(event.properties.part);
      break;

    case "message.part.delta":
      // 文本增量追加
      // properties: { sessionID, messageID, partID, field: "text"|"reasoning", delta }
      appendDelta(
        event.properties.messageID,
        event.properties.partID,
        event.properties.field,
        event.properties.delta,
      );
      break;

    case "session.status":
      // properties.status = { type: "idle"|"busy"|"retry" }
      setSessionStatus(sid, event.properties.status);
      break;

    case "session.idle":
      // 一轮对话结束，可以让 UI 显示「完成」
      setSessionStatus(sid, { type: "idle" });
      break;

    case "session.error":
      // 会话出错（非参数错误），properties.error 含消息
      showError(event.properties.error);
      break;

    case "todo.updated":
      // properties.todos: Todo[]
      setTodos(sid, event.properties.todos);
      break;

    case "permission.asked":
      // 有工具需要审批，properties 含 requestID
      showPermissionPrompt(event.properties);
      break;

    case "permission.replied":
      dismissPermissionPrompt(event.properties.requestID);
      break;
  }
}
```

#### 8.3 处理乱序 delta

关键细节：`message.part.delta` 有时会**先于** `message.part.updated` 到达（该 part 还没创建就收到了增量）。你必须缓存这些孤儿 delta，直到对应 part 出现：

```ts
const pendingDeltas = new Map<string, Array<{ field: string; delta: string }>>();

function appendDelta(messageID: string, partID: string, field: string, delta: string) {
  const part = findPart(messageID, partID);
  if (!part) {
    // Part 还没到，先缓存
    const key = `${messageID}:${partID}`;
    const queue = pendingDeltas.get(key) ?? [];
    queue.push({ field, delta });
    pendingDeltas.set(key, queue);
    return;
  }
  applyDeltaToPart(part, field, delta);
}

function upsertPart(part: Part) {
  savePart(part);
  const key = `${part.messageID}:${part.id}`;
  const queue = pendingDeltas.get(key);
  if (queue) {
    for (const { field, delta } of queue) applyDeltaToPart(part, field, delta);
    pendingDeltas.delete(key);
  }
}
```

参考实现：[apps/app/src/react/session/session-sync.ts:138-173](apps/app/src/react/session/session-sync.ts)

#### 8.4 断线重连

```ts
let reconnectAttempt = 0;

async function scheduleReconnect() {
  const delay = Math.min(250 * Math.pow(2, reconnectAttempt), 5000);
  reconnectAttempt++;
  await new Promise((r) => setTimeout(r, delay));

  // 关键：重连后先拉一次当前会话的 snapshot，补齐断线期间错过的状态
  const snapshot = await fetch(
    `${config.baseUrl}/workspace/${config.workspaceId}/sessions/${currentSessionID}/snapshot`,
    { headers: { Authorization: `Bearer ${config.clientToken}` } },
  ).then((r) => r.json());

  replaceSessionState(snapshot);    // 用最新快照覆盖本地状态
  await startSubscription();        // 重新订阅
  reconnectAttempt = 0;
}
```

### Step 9：渲染消息与工具调用

从 SSE 和 snapshot 拿到的 Part 是这样的形态：

```ts
type Part =
  | { id: string; messageID: string; type: "text"; text: string }
  | { id: string; messageID: string; type: "reasoning"; text: string }
  | { id: string; messageID: string; type: "file"; url: string; filename?: string; mime?: string }
  | {
      id: string;
      messageID: string;
      type: "tool";
      tool: string;                  // 工具名，如 "bash", "edit", "chrome-devtools_click"
      state: {
        input?: unknown;             // 工具入参（JSON）
        output?: unknown;            // 工具返回（input-available 阶段没有）
        error?: string;              // 出错时有
        title?: string;              // 工具提供的人读标题
        metadata?: Record<string, unknown>;
      };
    }
  | { id: string; messageID: string; type: "step-start" }
  | { id: string; messageID: string; type: "step-finish"; reason?: string };
```

UI 渲染建议：

- `text` — 直接渲染 markdown
- `reasoning` — 可折叠的"思考过程"块
- `tool` — 工具调用卡片，显示 tool 名、input（折叠）、output/error、状态徽章（running/done/error）
- `file` — 预览图片/下载文件
- `step-start/finish` — 步骤分隔符（多数情况下可以不显示）

参考：[apps/app/src/react/session/tool-call.react.tsx](apps/app/src/react/session/tool-call.react.tsx) 和 [apps/app/src/react/session/message-list.react.tsx](apps/app/src/react/session/message-list.react.tsx)

### Step 10：加载历史会话

用户重新打开应用时，你要恢复之前的会话：

```ts
// 列出所有会话（按更新时间排序）
const res = await fetch(
  `${config.baseUrl}/workspace/${config.workspaceId}/sessions?limit=50`,
  { headers: { Authorization: `Bearer ${config.clientToken}` } },
);
const { items } = await res.json();

// 加载单个会话的完整快照
const snapshot = await fetch(
  `${config.baseUrl}/workspace/${config.workspaceId}/sessions/${sessionID}/snapshot`,
  { headers: { Authorization: `Bearer ${config.clientToken}` } },
).then((r) => r.json());

// snapshot 包含 session / messages / todos / status
```

---

## 5. HTTP API 参考

以下是对接常用的端点**精确契约**。所有路径前缀为 `http://127.0.0.1:<openworkPort>`。所有示例都假设你已经有 `clientToken`、`hostToken`、`workspaceId`、`workspaceDir`。

> 源码真值：[apps/server/src/server.ts](apps/server/src/server.ts)

### 5.1 认证头说明

| Header | 值 | 用途 |
|---|---|---|
| `Authorization: Bearer {clientToken}` | 客户端 token | 所有 `client` 标记的端点 |
| `X-OpenWork-Host-Token: {hostToken}` | host token | 所有 `host` 标记的端点（workspace CRUD、审批） |
| `X-OpenWork-Client-Id: {optional}` | 任意字符串 | 可选的客户端标识（日志用） |
| `X-Opencode-Directory: {workspaceDir}` | 绝对路径 | 仅在直连 OpenCode 时需要；走代理时 openwork-server 自动注入 |

### 5.2 健康与元信息（无需认证）

```
GET /health
→ 200 { "ok": true, "version": "...", "uptimeMs": 123456 }

GET /w/{workspaceId}/health
→ 200 { "ok": true, "version": "...", "uptimeMs": 123456 }
```

### 5.3 工作区管理

#### 创建本地工作区（host 认证）

```
POST /workspaces/local
X-OpenWork-Host-Token: {hostToken}
Content-Type: application/json

{
  "folderPath": "/absolute/path/to/workspace",  // 必需
  "name": "My Project",                          // 可选
  "preset": "starter"                            // 可选，默认 "starter"
}

→ 201 {
  "activeId": "<workspaceId>",
  "workspaces": [{ "id", "name", "path", ... }],
  "persisted": true
}
```

#### 列出工作区（client 认证）

```
GET /workspaces
Authorization: Bearer {clientToken}

→ 200 {
  "items": [...],
  "workspaces": [...],
  "activeId": "..."
}
```

#### 激活 / 删除 / 改名（host 认证）

```
POST   /workspaces/{id}/activate     → { activeId, workspace, persisted }
DELETE /workspaces/{id}              → { ok, deleted, activeId, items }
PATCH  /workspaces/{id}/display-name Body: { "displayName": "New Name" }
```

#### 查询工作区状态

```
GET /w/{workspaceId}/status
Authorization: Bearer {clientToken}

→ 200 {
  "ok": true,
  "version": "...",
  "readOnly": false,
  "approval": { "mode": "auto", "timeoutMs": 60000 },
  "activeWorkspaceId": "...",
  "workspace": { ... },
  "authorizedRoots": ["/path/to/workspace"],
  "server": { "host": "127.0.0.1", "port": 48787, "configPath": "..." },
  "tokenSource": { "client": "cli", "host": "cli" }
}

GET /w/{workspaceId}/capabilities
→ 200 { schemaVersion, mcp: {...}, approvals: {...}, toolProviders: {...}, ... }
```

### 5.4 会话读取（openwork-server 原生，client 认证）

```
GET /workspace/{workspaceId}/sessions?limit=50&search=xxx
→ { items: SessionInfo[] }

GET /workspace/{workspaceId}/sessions/{sessionId}
→ { item: SessionInfo }

GET /workspace/{workspaceId}/sessions/{sessionId}/messages?limit=140
→ { items: Array<{ info, parts }> }

GET /workspace/{workspaceId}/sessions/{sessionId}/snapshot?limit=140
→ {
  session: SessionInfo,
  messages: Array<{ info, parts }>,
  todos: Todo[],
  status: { type: "idle" | "busy" | "retry" }
}

DELETE /workspace/{workspaceId}/sessions/{sessionId}
→ { ok: true }   (需要 collaborator 及以上)
```

### 5.5 OpenCode 代理路径（会话写入）

这些路径**不要直接手写 fetch**，用 SDK 更安全。列在这里是为了调试时看流量：

```
POST   /w/{workspaceId}/opencode/session                              → 创建会话
POST   /w/{workspaceId}/opencode/session/{sessionID}/prompt_async     → 发送 prompt
POST   /w/{workspaceId}/opencode/session/{sessionID}/abort            → 中止
DELETE /w/{workspaceId}/opencode/session/{sessionID}                  → 删除
GET    /w/{workspaceId}/opencode/event                                → SSE 事件流
```

openwork-server 的代理会自动：
- 转发 `Authorization` header（做 scope 校验）
- 加上 OpenCode basic-auth
- 注入 `X-Opencode-Directory` header

### 5.6 MCP 管理

```
GET /workspace/{workspaceId}/mcp
Authorization: Bearer {clientToken}

→ 200 {
  items: [
    {
      name: "control-chrome",
      config: { type: "local", command: [...] },
      source: "config.project"  // 或 "config.global" / "config.remote"
    }
  ]
}
```

```
POST /workspace/{workspaceId}/mcp
Authorization: Bearer {clientToken}     (需要 collaborator)
Content-Type: application/json

{
  "name": "my-tools",                    // 必需
  "config": {                             // 必需
    "type": "local",                     // "local" | "remote"
    "command": ["node", "server.js"],    // local 时必需
    // "url": "https://...",             // remote 时必需
    // "environment": { ... },           // local 可选
    // "headers": { ... }                // remote 可选
  }
}

→ 200 { items: [...] }
```

```
DELETE /workspace/{workspaceId}/mcp/{name}                → { items: [...] }
DELETE /workspace/{workspaceId}/mcp/{name}/auth           → { ok: true }
```

### 5.7 引擎重载

```
POST /workspace/{workspaceId}/engine/reload
Authorization: Bearer {clientToken}     (需要 collaborator)

→ 200 { ok: true, reloadedAt: 1713000000 }
```

**什么时候需要**：改了 `opencode.json`、添加/删除 MCP、修改 skills/plugins 后都需要 reload。reload 会中断进行中的会话，UI 层要提示用户。

### 5.8 审批（host 认证）

```
GET /approvals
X-OpenWork-Host-Token: {hostToken}

→ {
  items: [
    {
      id: "req_xxx",
      workspaceId: "...",
      action: "mcp.add",
      summary: "Add MCP server 'control-chrome'",
      paths: [],
      createdAt: 1713000000,
      actor: { type: "remote", scope: "collaborator", tokenHash: "..." }
    }
  ]
}
```

```
POST /approvals/{id}
X-OpenWork-Host-Token: {hostToken}
Content-Type: application/json

{ "reply": "allow" }   // 或 "deny"

→ { ok: true, allowed: true }
```

> `--approval auto` 模式下这些端点基本不会被触发，所有修改直接通过。

### 5.9 重载事件轮询

```
GET /workspace/{workspaceId}/events?since={lastSeq}
Authorization: Bearer {clientToken}

→ {
  items: [
    {
      id: "evt_xxx",
      seq: 42,
      reason: "mcp",         // "plugins" | "skills" | "mcp" | "config" | "agents" | "commands"
      trigger: { type: "mcp", name: "control-chrome", action: "added" },
      timestamp: 1713000000
    }
  ],
  cursor: 42,
  workspaceId: "...",
  disabled: false
}
```

这是**轮询**端点（非 SSE），用来在你改了配置后让 UI 知道"有东西变了，该 reload 了"。

---

## 6. SSE 事件参考

SDK 的 `client.event.subscribe()` 返回一个 `{ stream }`，其中 `stream` 是 `AsyncIterable<Event>`。所有事件的基础结构：

```ts
type Event = {
  type: string;
  properties?: Record<string, any>;
};
```

**重要：订阅是 workspace 级广播**，同一个订阅会收到该 workspace 所有 session 的事件。请按 `event.properties.sessionID` 过滤。

### 6.1 完整事件类型表

| `event.type` | `properties` 字段 | 用途 |
|---|---|---|
| `server.connected` | - | 连接建立 |
| `session.created` | `{ info: Session }` | 新会话创建 |
| `session.updated` | `{ info: Session }` | 会话元信息变化 |
| `session.deleted` | `{ sessionID }` | 会话被删除 |
| `session.status` | `{ sessionID, status: { type: "idle"\|"busy"\|"retry"; ... } }` | 状态机变化 |
| `session.idle` | `{ sessionID }` | 一轮对话结束 |
| `session.error` | `{ sessionID, error: { message, ... } }` | 运行时错误 |
| `session.compacted` | `{ sessionID }` | 历史被压缩 |
| `message.updated` | `{ info: { id, role, sessionID, parentID, time } }` | 新消息/消息头更新 |
| `message.part.updated` | `{ part: Part }` | Part 创建或最终化 |
| `message.part.delta` | `{ sessionID, messageID, partID, field: "text"\|"reasoning", delta: string }` | 增量文本 |
| `todo.updated` | `{ sessionID, todos: Todo[] }` | Todo 列表变化 |
| `permission.asked` | `{ requestID, sessionID, tool, action, ... }` | 需要审批 |
| `permission.replied` | `{ requestID, reply }` | 审批已回复 |
| `permission.updated` | (同上两者的混合) | 审批状态变化 |
| `lsp.updated` | `{ directory }` | LSP 诊断变化（通常忽略） |
| `mcp.tools.changed` | `{ server, directory }` | MCP 工具列表变化 |

### 6.2 Part 类型完整定义

```ts
type Part =
  | {
      id: string;
      messageID: string;
      sessionID: string;
      type: "text";
      text: string;
    }
  | {
      id: string;
      messageID: string;
      sessionID: string;
      type: "reasoning";
      text: string;
    }
  | {
      id: string;
      messageID: string;
      sessionID: string;
      type: "file";
      url: string;
      filename?: string;
      mime?: string;
    }
  | {
      id: string;
      messageID: string;
      sessionID: string;
      type: "tool";
      tool: string;                    // 工具名
      state: {
        input?: unknown;               // 仅 input-available / output-* 阶段存在
        output?: unknown;              // 仅 output-available 阶段存在
        error?: string;                // 仅 output-error 阶段存在
        title?: string;
        metadata?: Record<string, unknown>;
      };
    }
  | {
      id: string;
      messageID: string;
      sessionID: string;
      type: "step-start";
    }
  | {
      id: string;
      messageID: string;
      sessionID: string;
      type: "step-finish";
      reason?: string;
    };
```

**Tool part 的状态演化**：

```
input-available    (input 已定，output/error 未定)   — UI 显示 "running"
      ↓
output-available   (output 已定)                      — UI 显示 "done"
      或
output-error       (error 已定)                       — UI 显示 "error"
```

同一个 `part.id` 在事件流里会被 `message.part.updated` 多次推送，每次 state 都在演化。你应该用 `part.id` 作为 key 做 upsert。

### 6.3 事件合并优化建议

生产环境下事件频率很高。[apps/app/src/react/session/session-sync.ts](apps/app/src/react/session/session-sync.ts) 的做法：

- 把事件 push 进队列，用 16ms（普通）/ 48ms（delta）的节流定时器批处理
- 同 key 的 `session.status` / `message.part.updated` 事件合并（后到覆盖先到）
- key 定义：`${event.type}:${sessionID}` 或 `${event.type}:${messageID}:${partID}`

这能把 UI 的重渲染频率压到可接受范围。

---

## 7. opencode.json 配置参考

位于工作区根目录。`POST /workspaces/local` with `preset: "starter"` 会自动创建。

### 7.1 完整 schema 示例

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // 默认使用哪个 agent（.opencode/agent/*.md 下定义的）
  "default_agent": "openwork",

  // 默认模型（也可以在 promptAsync 调用时覆盖）
  "model": "anthropic/claude-sonnet-4-5",

  // 工具权限：agent 执行工具前是否需要用户同意
  "permission": {
    "bash": "allow",              // "allow" | "ask" | "deny"
    "edit": "allow",
    "write": "allow",
    "read": "allow",
    "external_directory": "ask"   // 对工作区外的路径的访问
  },

  // MCP 工具服务器
  "mcp": {
    "control-chrome": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
    },
    "my-custom": {
      "type": "local",
      "command": ["node", "/abs/path/server.js"],
      "environment": { "API_KEY": "..." },
      "enabled": true,
      "timeout": 30000
    },
    "my-remote": {
      "type": "remote",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer ..." }
    }
  },

  // 模型提供商凭证（也可以通过 client.auth.set 动态设置）
  "provider": {
    "anthropic": {
      "apiKey": "sk-ant-xxxxx"    // 或用环境变量 ANTHROPIC_API_KEY
    },
    "openai": {
      "apiKey": "sk-xxxxx"
    }
  },

  // 插件（高级用法）
  "plugin": ["opencode-scheduler"]
}
```

### 7.2 权限值的含义

| 值 | 行为 |
|---|---|
| `"allow"` | 直接执行，不询问 |
| `"ask"` | 首次执行时弹 `permission.asked` 事件，等待 `client.permission.reply` |
| `"deny"` | 拒绝执行，工具返回 error |

**推荐配置**：桌面应用嵌入场景（用户信任 agent），全部设为 `"allow"`，在 UI 上保留"查看 agent 做了什么"的功能就够了。如果你的产品更保守，对 `bash` 和 `write` 设为 `"ask"`，并在 UI 里渲染一个确认对话框。

### 7.3 动态修改配置

不推荐直接写文件（需要重载检测），推荐走 openwork-server 的 API：

- MCP：`POST /workspace/:id/mcp`
- 其他字段：暂无直接 API，需要读 → 改 → 写文件 → `engine/reload`

---

## 8. 认证与权限

### 8.1 三种 token 作用域

| Scope | 能做什么 | 获取方式 |
|---|---|---|
| `owner` | 全部，包括代理发审批回复 | 启动时 `--openwork-token` 传入的 client token 默认 owner |
| `collaborator` | 读写，但不能批准自己的权限请求 | 需要配合多 token 系统（本基础集成中用不到） |
| `viewer` | 只读 | 同上 |

**简单场景**：只用一个 client token，默认 scope 是 `owner`，可以调用任何 `client` 端点。

### 8.2 安全建议

1. **每次启动生成新 token**：`crypto.randomBytes(32).toString("hex")`，不要写死也不要持久化
2. **hostToken 只留在 main 进程**：通过 contextBridge 只暴露 clientToken 给 renderer
3. **监听 loopback**：默认 `127.0.0.1` 就好，不要加 `--remote-access`
4. **CORS**：默认 `*`，嵌入场景下没问题；如果 orchestrator 可能被其他进程访问，用 `--cors` 限定源

---

## 9. 模型凭证配置

agent 最终要调用 Claude/GPT 等模型，API key 怎么给 OpenCode？三条路径：

### 9.1 方式 A：写入 `opencode.json` 的 `provider` 段

简单直接，但 key 落盘。

```jsonc
{
  "provider": {
    "anthropic": { "apiKey": "sk-ant-xxx" }
  }
}
```

### 9.2 方式 B：环境变量（推荐用于自动化场景）

启动 orchestrator 时传入环境变量：

```ts
spawn(binary, args, {
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: "sk-ant-xxx",
    OPENAI_API_KEY: "sk-xxx",
  },
});
```

OpenCode 会自动读取。

### 9.3 方式 C：运行时通过 SDK 设置（推荐用于需要用户登录的场景）

```ts
await client.auth.set({
  providerID: "anthropic",
  credential: { type: "apikey", apiKey: "sk-ant-xxx" },
});
```

这会写入 OpenCode 的 secrets 存储（位于 `~/.local/share/opencode/` 或等效路径）。适合你的用户从你的后端拿到 API key 后注入到 OpenCode。

### 9.4 支持的 providerID 和 modelID

常用组合（截至本文撰写时）：

| providerID | modelID 示例 |
|---|---|
| `anthropic` | `claude-sonnet-4-5`, `claude-opus-4`, `claude-haiku-4-5-20251001` |
| `openai` | `gpt-5`, `gpt-4o`, `gpt-4-turbo` |
| `google` | `gemini-2.0-flash`, `gemini-1.5-pro` |
| `openrouter` | 由 openrouter 支持的任意模型（用斜杠形式） |

调用 `client.config.providers()` 可以拿到当前 orchestrator 支持的完整列表。

---

## 10. 错误处理

### 10.1 错误的三个层次

1. **网络 / HTTP 层**：SDK 调用 throw，类型是标准 `fetch` 错误或 SDK 的 `ApiError`（带 `status`/`code`/`message`）
2. **Orchestrator 进程层**：子进程崩溃 → main 进程监听 `exit` 事件，记日志并重启
3. **Session 运行时层**：agent 出错（模型调用失败、工具执行失败等）→ 通过 SSE 的 `session.error` 事件到达，**不会** throw

### 10.2 常见错误处理模式

```ts
// 1. SDK 调用
try {
  await client.session.promptAsync({ ... });
} catch (err) {
  // 参数错误 / 网络断开 / token 无效
  if (err.status === 401) { /* token 失效，重新登录 */ }
  else if (err.status === 404) { /* session 不存在 */ }
  else { /* 其他：展示错误 */ }
}

// 2. Session 运行时错误
handleEvent((event) => {
  if (event.type === "session.error") {
    const msg = event.properties.error?.message ?? "Unknown error";
    showErrorToast(msg);
    setSessionStatus(sid, { type: "idle" });  // 回到空闲
  }
});

// 3. 子进程退出
child.on("exit", (code, signal) => {
  if (code !== 0) {
    logError(`orchestrator exited unexpectedly: code=${code} signal=${signal}`);
    // 策略 1: 立即重启（带指数退避）
    // 策略 2: 弹窗提示用户，等待手动重启
  }
});
```

### 10.3 重试策略

- **Orchestrator 重启**：指数退避 1s → 2s → 4s → ... → 30s，重启 5 次还失败就提示用户
- **SSE 重连**：250ms → 500ms → 1s → 2s → 5s，持续重试
- **单次 prompt 失败**：不自动重试，展示错误让用户决定是否重发

---

## 11. Electron 完整示例

下面是一个可直接落地的最小 Electron 集成。假设你的项目结构：

```
my-electron-app/
├── main/
│   ├── index.ts              ← 主进程入口
│   ├── orchestrator.ts       ← 封装 orchestrator 生命周期
│   └── preload.ts            ← contextBridge
├── renderer/
│   ├── index.html
│   ├── app.tsx               ← 你的 UI
│   └── lib/
│       ├── client.ts         ← SDK 客户端
│       ├── sse.ts            ← 事件订阅器
│       ├── sessions.ts       ← 会话操作封装
│       └── mcp.ts            ← MCP 管理封装
└── resources/
    └── sidecars/
        ├── darwin-arm64/
        │   ├── openwork-orchestrator
        │   ├── openwork-server
        │   └── opencode
        ├── darwin-x64/...
        ├── linux-x64/...
        └── win32-x64/...
```

### 11.1 `main/orchestrator.ts`

```ts
import { spawn, ChildProcess } from "node:child_process";
import readline from "node:readline";
import crypto from "node:crypto";
import path from "node:path";
import { app } from "electron";

export interface OrchestratorInfo {
  baseUrl: string;
  clientToken: string;
  hostToken: string;
}

export class OrchestratorSupervisor {
  private child: ChildProcess | null = null;
  private info: OrchestratorInfo | null = null;

  async start(workspacePath: string): Promise<OrchestratorInfo> {
    if (this.info) return this.info;

    const clientToken = crypto.randomBytes(32).toString("hex");
    const hostToken = crypto.randomBytes(32).toString("hex");

    const platform = `${process.platform}-${process.arch}`;
    const binaryName = process.platform === "win32" ? "openwork-orchestrator.exe" : "openwork-orchestrator";
    const sidecarDir = path.join(process.resourcesPath, "sidecars", platform);
    const binaryPath = path.join(sidecarDir, binaryName);

    const args = [
      "serve",
      "--workspace", workspacePath,
      "--openwork-port", "0",           // 让系统分配
      "--openwork-token", clientToken,
      "--openwork-host-token", hostToken,
      "--approval", "auto",
      "--log-format", "json",
      "--sidecar-source", "bundled",
      "--sidecar-dir", sidecarDir,
      "--no-opencode-router",
      "--no-tui",
    ];

    this.child = spawn(binaryPath, args, {
      cwd: workspacePath,
      env: {
        ...process.env,
        PATH: [
          "/usr/local/bin",
          "/opt/homebrew/bin",
          "/usr/bin",
          "/bin",
          process.env.PATH ?? "",
        ].filter(Boolean).join(path.delimiter),
        // 从你的后端拉到的 API key 在这里注入
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // 捕获 stderr 到日志
    this.child.stderr?.on("data", (buf) => {
      console.error("[orchestrator]", buf.toString());
    });

    // 等待 "Ready" 日志
    const baseUrl = await this.waitForReady();

    this.info = { baseUrl, clientToken, hostToken };

    // 监听子进程崩溃
    this.child.on("exit", (code, signal) => {
      console.error(`orchestrator exited: code=${code} signal=${signal}`);
      this.info = null;
      // TODO: 通知 renderer，触发重连或重启
    });

    // 应用退出时优雅关闭
    app.on("before-quit", () => this.stop());

    return this.info;
  }

  private waitForReady(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdout) return reject(new Error("no stdout"));

      const rl = readline.createInterface({ input: this.child.stdout });
      const timeout = setTimeout(() => {
        rl.close();
        reject(new Error("orchestrator ready timeout"));
      }, 30_000);

      rl.on("line", (line) => {
        let record: any;
        try { record = JSON.parse(line); } catch { return; }

        // 业务日志转发
        console.log("[orchestrator]", record.body ?? line);

        if (record.body === "Ready" && record.attributes?.openwork?.baseUrl) {
          clearTimeout(timeout);
          // 继续读后续日志（不关闭 rl）
          resolve(record.attributes.openwork.baseUrl);
        }
      });

      this.child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`orchestrator exited with code ${code} before ready`));
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    // 给 2.5 秒优雅退出
    await new Promise((r) => setTimeout(r, 2500));
    if (!this.child.killed) this.child.kill("SIGKILL");
    this.child = null;
    this.info = null;
  }

  getInfo(): OrchestratorInfo | null {
    return this.info;
  }
}
```

### 11.2 `main/index.ts`

```ts
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { OrchestratorSupervisor } from "./orchestrator.js";

const supervisor = new OrchestratorSupervisor();

async function createWindow() {
  // 在窗口创建前启动 orchestrator
  const workspacePath = path.join(app.getPath("userData"), "workspace");
  await import("node:fs/promises").then((fs) => fs.mkdir(workspacePath, { recursive: true }));

  const info = await supervisor.start(workspacePath);

  // 通过 POST /workspaces/local 注册 workspace
  const registerRes = await fetch(`${info.baseUrl}/workspaces/local`, {
    method: "POST",
    headers: {
      "X-OpenWork-Host-Token": info.hostToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ folderPath: workspacePath, name: "My App", preset: "starter" }),
  });
  const { activeId: workspaceId } = await registerRes.json();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 把连接信息塞进 query string
  win.loadFile("renderer/index.html", {
    query: {
      baseUrl: info.baseUrl,
      token: info.clientToken,      // 只暴露 client token，hostToken 留在 main
      workspaceId,
      workspaceDir: workspacePath,
    },
  });
}

// 提供 IPC：host-only 操作（审批回复等）
ipcMain.handle("openwork:approve", async (_, id: string, allow: boolean) => {
  const info = supervisor.getInfo();
  if (!info) throw new Error("not ready");
  const res = await fetch(`${info.baseUrl}/approvals/${id}`, {
    method: "POST",
    headers: {
      "X-OpenWork-Host-Token": info.hostToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reply: allow ? "allow" : "deny" }),
  });
  return res.json();
});

app.whenReady().then(createWindow);
```

### 11.3 `main/preload.ts`

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openwork", {
  // 连接信息通过 query string 传递（见 main/index.ts）
  approve: (id: string, allow: boolean) => ipcRenderer.invoke("openwork:approve", id, allow),
});
```

### 11.4 `renderer/lib/client.ts`

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const params = new URLSearchParams(window.location.search);

export const config = {
  baseUrl: params.get("baseUrl")!,
  token: params.get("token")!,
  workspaceId: params.get("workspaceId")!,
  workspaceDir: params.get("workspaceDir")!,
};

export const client = createOpencodeClient({
  baseUrl: `${config.baseUrl}/w/${config.workspaceId}/opencode`,
  headers: { Authorization: `Bearer ${config.token}` },
  fetch: globalThis.fetch,
});

// 用于调用 openwork-server 原生端点（非 SDK）
export async function openworkFetch(path: string, init?: RequestInit) {
  return fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}
```

### 11.5 `renderer/lib/sse.ts`

```ts
import { client } from "./client.js";

type EventHandler = (event: { type: string; properties?: any }) => void;

export class EventStream {
  private controller: AbortController | null = null;
  private handlers = new Set<EventHandler>();
  private reconnectAttempt = 0;
  private running = false;

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    if (!this.running) this.start();
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) this.stop();
    };
  }

  private async start() {
    this.running = true;
    while (this.running) {
      this.controller = new AbortController();
      try {
        const sub = await client.event.subscribe(undefined, { signal: this.controller.signal });
        this.reconnectAttempt = 0;
        for await (const event of sub.stream) {
          for (const h of this.handlers) {
            try { h(event); } catch (e) { console.error(e); }
          }
        }
      } catch (err) {
        if (!this.running) break;
        const delay = Math.min(250 * Math.pow(2, this.reconnectAttempt++), 5000);
        console.warn(`SSE reconnecting in ${delay}ms`, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private stop() {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
  }
}

export const eventStream = new EventStream();
```

### 11.6 `renderer/lib/sessions.ts`

```ts
import { client, config, openworkFetch } from "./client.js";

export async function createSession(): Promise<string> {
  const res = await client.session.create({ directory: config.workspaceDir });
  return (res as any).id;
}

export async function sendPrompt(sessionID: string, text: string, files?: File[]) {
  const parts: any[] = [{ type: "text", text }];
  if (files) {
    for (const f of files) {
      const b64 = await fileToBase64(f);
      parts.push({ type: "file", url: b64, filename: f.name, mime: f.type });
    }
  }
  await client.session.promptAsync({
    sessionID,
    directory: config.workspaceDir,
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    parts,
  });
}

export async function abortSession(sessionID: string) {
  await client.session.abort({ sessionID, directory: config.workspaceDir });
}

export async function loadSnapshot(sessionID: string) {
  const res = await openworkFetch(`/workspace/${config.workspaceId}/sessions/${sessionID}/snapshot?limit=140`);
  return res.json();
}

export async function listSessions() {
  const res = await openworkFetch(`/workspace/${config.workspaceId}/sessions?limit=50`);
  return res.json();
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
```

### 11.7 `renderer/lib/mcp.ts`

```ts
import { config, openworkFetch } from "./client.js";

export async function listMcps() {
  const res = await openworkFetch(`/workspace/${config.workspaceId}/mcp`);
  return (await res.json()).items;
}

export async function addMcp(name: string, mcpConfig: any) {
  const res = await openworkFetch(`/workspace/${config.workspaceId}/mcp`, {
    method: "POST",
    body: JSON.stringify({ name, config: mcpConfig }),
  });
  if (!res.ok) throw new Error(`addMcp failed: ${res.status}`);
  return res.json();
}

export async function removeMcp(name: string) {
  await openworkFetch(`/workspace/${config.workspaceId}/mcp/${name}`, { method: "DELETE" });
}

export async function reloadEngine() {
  await openworkFetch(`/workspace/${config.workspaceId}/engine/reload`, { method: "POST" });
}

// 便捷方法
export async function setupBrowserAutomation() {
  await addMcp("control-chrome", {
    type: "local",
    command: ["npx", "-y", "chrome-devtools-mcp@latest"],
  });
  await reloadEngine();
}
```

### 11.8 UI 侧示例（React / Vue / Svelte 自选）

这里用 React 伪代码展示关键部分：

```tsx
import { useEffect, useState } from "react";
import { createSession, sendPrompt, loadSnapshot } from "./lib/sessions";
import { eventStream } from "./lib/sse";

function ChatApp() {
  const [sessionID, setSessionID] = useState<string | null>(null);
  const [messages, setMessages] = useState<Map<string, any>>(new Map());
  const [parts, setParts] = useState<Map<string, any>>(new Map());
  const [pendingDeltas] = useState(new Map<string, Array<{ field: string; delta: string }>>());
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "busy">("idle");

  // 创建初始会话
  useEffect(() => {
    createSession().then(setSessionID);
  }, []);

  // 订阅事件
  useEffect(() => {
    if (!sessionID) return;
    const unsub = eventStream.subscribe((event) => {
      const sid = event.properties?.sessionID;
      if (sid && sid !== sessionID) return;

      switch (event.type) {
        case "message.updated":
          setMessages((m) => new Map(m).set(event.properties.info.id, event.properties.info));
          break;
        case "message.part.updated": {
          const p = event.properties.part;
          setParts((ps) => new Map(ps).set(p.id, p));
          // 清空挂起的 delta
          const key = `${p.messageID}:${p.id}`;
          const queue = pendingDeltas.get(key);
          if (queue) {
            for (const { field, delta } of queue) applyDeltaToPart(p, field, delta);
            pendingDeltas.delete(key);
            setParts((ps) => new Map(ps).set(p.id, p));
          }
          break;
        }
        case "message.part.delta": {
          const { messageID, partID, field, delta } = event.properties;
          setParts((ps) => {
            const existing = ps.get(partID);
            if (!existing) {
              // 缓存
              const key = `${messageID}:${partID}`;
              const queue = pendingDeltas.get(key) ?? [];
              queue.push({ field, delta });
              pendingDeltas.set(key, queue);
              return ps;
            }
            applyDeltaToPart(existing, field, delta);
            return new Map(ps).set(partID, { ...existing });
          });
          break;
        }
        case "session.status":
          setStatus(event.properties.status.type);
          break;
        case "session.idle":
          setStatus("idle");
          break;
        case "session.error":
          alert(event.properties.error?.message ?? "unknown error");
          setStatus("idle");
          break;
      }
    });
    return unsub;
  }, [sessionID]);

  const handleSend = async () => {
    if (!sessionID || !input.trim()) return;
    const text = input;
    setInput("");
    setStatus("busy");
    await sendPrompt(sessionID, text);
  };

  return (
    <div>
      <div className="messages">
        {[...messages.values()].map((msg) => (
          <MessageView
            key={msg.id}
            message={msg}
            parts={[...parts.values()].filter((p) => p.messageID === msg.id)}
          />
        ))}
      </div>
      <input value={input} onChange={(e) => setInput(e.target.value)} disabled={status === "busy"} />
      <button onClick={handleSend} disabled={status === "busy"}>
        {status === "busy" ? "运行中..." : "发送"}
      </button>
    </div>
  );
}

function applyDeltaToPart(part: any, field: string, delta: string) {
  if (field === "text") part.text = (part.text ?? "") + delta;
  else if (field === "reasoning") part.text = (part.text ?? "") + delta;
}

function MessageView({ message, parts }: any) {
  return (
    <div className={`msg ${message.role}`}>
      {parts.map((p: any) => {
        if (p.type === "text") return <div key={p.id}>{p.text}</div>;
        if (p.type === "reasoning") return <details key={p.id}><summary>思考</summary>{p.text}</details>;
        if (p.type === "tool") {
          const status = p.state?.error ? "error" : p.state?.output !== undefined ? "done" : "running";
          return (
            <div key={p.id} className={`tool tool-${status}`}>
              <code>{p.tool}</code>
              <pre>{JSON.stringify(p.state?.input, null, 2)}</pre>
              {p.state?.output !== undefined && <pre>{JSON.stringify(p.state.output, null, 2)}</pre>}
              {p.state?.error && <pre className="error">{p.state.error}</pre>}
            </div>
          );
        }
        if (p.type === "file") return <img key={p.id} src={p.url} alt={p.filename} />;
        return null;
      })}
    </div>
  );
}
```

### 11.9 打包清单

- [ ] 为目标平台构建 orchestrator 三个二进制，放到 `resources/sidecars/<platform>/`
- [ ] macOS：对每个二进制做 codesign（ad-hoc 或正式签名），加到 `app.asar.unpacked`
- [ ] Windows：用 `windowsHide: true` spawn
- [ ] 测试 GUI 环境下 `npx` 能找到（控制浏览器 MCP 依赖）
- [ ] 模型 API key 的管理：从你的后端下发 vs 让用户在应用里输入
- [ ] 应用退出时优雅关闭 orchestrator（监听 `app.on('before-quit')`）
- [ ] 首次启动体验：等待 orchestrator 就绪的 loading 界面

---

## 12. 常见陷阱与 FAQ

### 12.1 陷阱清单

1. **`session.promptAsync` 返回空对象**，别 await 它期待结果。结果全部走 SSE。
2. **`message.part.delta` 可能早于 `message.part.updated` 到达**，必须用 `pendingDeltas` 缓冲。
3. **`abort` 不回滚副作用**：已经写入的文件、发送的 HTTP 请求都保留。UI 上要设计"部分完成"状态。
4. **`engine/reload` 会中断进行中的会话**：改 MCP 配置时先确认没有 busy 会话。
5. **不要 import `@opencode-ai/sdk/v2`**（不带 `/client`）：那是 Node-only 版本，会在 renderer 里炸。只用 `@opencode-ai/sdk/v2/client`。
6. **`directory` 参数在走代理路径时可选**（openwork-server 自动注入），但传上也不会错。直连 OpenCode 时必传。
7. **SSE 订阅是 workspace 级广播**，事件里要按 `sessionID` 过滤。
8. **Chrome DevTools MCP 依赖本地 Chrome**，没装 Chrome 会启动失败。做好检测和引导安装。
9. **macOS GUI 应用不继承 shell PATH**，MCP 用 `npx` 时必须手动注入 `/usr/local/bin`、`/opt/homebrew/bin`。
10. **端口 8787 可能冲突**：生产环境建议传 `--openwork-port 0` 让系统分配，从 stdout 的 `Ready` 日志拿实际端口。
11. **token 泄漏**：每次启动生成新 token，不要持久化。contextBridge 只暴露 clientToken，hostToken 留在 main。
12. **审批模式选择**：桌面应用嵌入推荐 `--approval auto`。如果你的产品强调"用户控制每一步"，用 `manual` 并实现审批 UI。
13. **模型 key 从哪来**：推荐从你自己的后端下发（可以做配额、计费、安全管控），通过环境变量或 `client.auth.set` 注入到 OpenCode。

### 12.2 FAQ

**Q：多窗口 / 多 workspace 怎么办？**
A：一个 orchestrator 进程可以管理多个 workspace（都在 `GET /workspaces` 里），用 `/w/:id/*` 路径区分。UI 侧为每个 workspace 建一个独立的 SDK client 实例即可。

**Q：orchestrator 能共享给多个应用吗？**
A：可以，但不推荐。orchestrator 设计是单一应用私有的。多应用共享会遇到 token 管理、生命周期、端口冲突等复杂问题。更好的做法是每个应用自己 spawn。

**Q：agent 能访问工作区以外的目录吗？**
A：默认不能。`external_directory` 权限默认 `ask`。如果你要开放，改 `opencode.json` 为 `allow`。注意这是一个安全敏感的设置。

**Q：流式响应能更快地显示第一个 token 吗？**
A：能。`message.part.delta` 的推送是实时的。UI 侧主要瓶颈是重渲染，用 `react-window` 或批处理可以把延迟压到 16ms 以内。

**Q：怎么知道 agent 当前在做什么？**
A：订阅 `session.status` 事件（`busy`/`idle`/`retry`），或观察 `message.part.updated` 的 `tool` 类型 part 进入 `input-available` 状态。

**Q：如何让 agent 接入我的业务数据？**
A：用自定义 MCP。实现一个 MCP server（TypeScript/Python/Go 都有 SDK），暴露你的业务能力为 tools，然后 `POST /workspace/:id/mcp` 注册。agent 会自动发现并使用。

**Q：能在 Web 应用里用吗？**
A：技术上可以（`@opencode-ai/sdk/v2/client` 是纯 fetch）。但要求你的后端能运行 orchestrator 进程并暴露 HTTP+SSE。注意 CORS 和 token 管理。多租户场景需要你自己做 workspace 隔离。

**Q：性能开销？**
A：orchestrator 空闲占用约 100-200MB 内存。每个会话增加几十 MB（取决于历史长度）。CPU 主要在 agent 执行期间占用，由 MCP 子进程和模型请求决定。

**Q：能离线运行吗？**
A：模型调用必须联网（除非你接入本地模型提供商）。MCP 和内置工具本身离线可用。

---

## 13. 附录：关键源码位置

集成时建议在编辑器里开着这些文件对照。它们是 OpenWork 项目自己 UI 的实现，是所有 API 契约的"真源"。

| 文件 | 用途 |
|---|---|
| [apps/orchestrator/src/cli.ts](apps/orchestrator/src/cli.ts) | orchestrator CLI 完整参数、环境变量、启动流程 |
| [apps/server/src/server.ts](apps/server/src/server.ts) | openwork-server 所有 HTTP 路由（搜 `addRoute(routes,`） |
| [apps/server/src/workspace-init.ts](apps/server/src/workspace-init.ts) | `starter` preset 的 opencode.json 默认内容 |
| [apps/server/src/validators.ts](apps/server/src/validators.ts) | 请求体校验逻辑（MCP config、preset 等） |
| [apps/app/src/app/lib/opencode.ts](apps/app/src/app/lib/opencode.ts) | SDK 客户端封装参考（可简化后照抄） |
| [apps/app/src/app/session/actions-store.ts](apps/app/src/app/session/actions-store.ts) | `createSession` / `sendPrompt` / `abort` 的完整实现 |
| [apps/app/src/react/session/session-sync.ts](apps/app/src/react/session/session-sync.ts) | SSE 订阅 + 事件分发 + 乱序 delta 缓冲 + 重连 |
| [apps/app/src/react/session/usechat-adapter.ts](apps/app/src/react/session/usechat-adapter.ts) | Part 类型到 UI 消息的完整转换 |
| [apps/app/src/react/session/tool-call.react.tsx](apps/app/src/react/session/tool-call.react.tsx) | 工具调用卡片渲染参考 |
| [apps/app/src/react/session/message-list.react.tsx](apps/app/src/react/session/message-list.react.tsx) | 消息列表渲染参考 |
| [apps/app/src/app/constants.ts](apps/app/src/app/constants.ts) | 默认模型、常量、Chrome MCP 命令等 |
| [apps/app/src/app/types.ts](apps/app/src/app/types.ts) | UI 层的 TypeScript 类型 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 整体架构描述 |
| [packages/docs/computer-use.mdx](packages/docs/computer-use.mdx) | 用户侧的 computer use 文档 |

---

## 14. 附录：现有 UI 页面与 API 对应关系

当你在自己的 Electron 项目里构建 UI 时，可以参考 OpenWork 现有前端各页面是怎么对接后端的。这份映射表帮你决定"我的 XX 页面该调哪个 API"。

### 14.1 聊天/会话页面

**参考文件**：[apps/app/src/app/pages/session.tsx](apps/app/src/app/pages/session.tsx), [apps/app/src/app/context/session.ts](apps/app/src/app/context/session.ts)

这是核心页面，你几乎一定会实现。

| UI 功能 | 调用的 SDK 方法 / API | 说明 |
|---|---|---|
| 发送消息 | `client.session.promptAsync({ sessionID, model, parts })` | 立即返回，结果走 SSE |
| 显示回复 | SSE 事件 `message.part.delta` / `message.part.updated` | 流式渲染文本和工具调用 |
| 加载历史消息 | `client.session.messages({ sessionID, limit: 140 })` 或 `GET /workspace/:id/sessions/:sessionId/messages` | 分页加载 |
| 加载完整快照 | `GET /workspace/:id/sessions/:sessionId/snapshot` | 一次性拿到 session + messages + todos + status |
| 创建新会话 | `client.session.create({ directory })` | 返回 `{ id }` |
| 中止运行 | `client.session.abort({ sessionID })` | 停止 agent 执行 |
| 删除会话 | `client.session.delete({ sessionID })` 或 `DELETE /workspace/:id/sessions/:sessionId` | 需 collaborator 权限 |
| 撤销最后消息 | `client.session.revert({ sessionID, messageID })` | |
| 列出所有会话 | `client.session.list()` 或 `GET /workspace/:id/sessions?limit=50` | 侧边栏历史列表 |
| 显示 TODO 列表 | SSE 事件 `todo.updated` 或 `client.session.todo({ sessionID })` | agent 的任务追踪 |
| 权限审批弹窗 | SSE 事件 `permission.asked` + `client.permission.reply({ requestID, reply })` | 工具执行前的用户确认 |
| AI 提问弹窗 | SSE 事件 `question` + `client.question.reply({ requestID, answer })` | agent 向用户提问 |

### 14.2 工作区管理

**参考文件**：[apps/app/src/app/context/workspace.ts](apps/app/src/app/context/workspace.ts)

| UI 功能 | 调用的 API | 说明 |
|---|---|---|
| 创建工作区 | `POST /workspaces/local` body `{ folderPath, name, preset }` | **需 host token** |
| 列出工作区 | `GET /workspaces` | 返回 `{ items, activeId }` |
| 切换工作区 | `POST /workspaces/:id/activate` | **需 host token** |
| 删除工作区 | `DELETE /workspaces/:id` | **需 host token** |
| 改名 | `PATCH /workspaces/:id/display-name` body `{ displayName }` | **需 host token** |
| 查看状态 | `GET /w/:id/status` | 含端口、授权根、token 来源 |
| 查看能力 | `GET /w/:id/capabilities` | 含 MCP/审批/sandbox 能力标志 |

> **注意**：工作区 CRUD 操作需要 **host token**（`X-OpenWork-Host-Token` header）。你的 Electron renderer 用的是 client token，所以工作区管理操作应该通过 IPC 委托给 main 进程执行。

### 14.3 MCP / Extensions 管理

**参考文件**：[apps/app/src/app/pages/mcp.tsx](apps/app/src/app/pages/mcp.tsx), [apps/app/src/app/pages/extensions.tsx](apps/app/src/app/pages/extensions.tsx)

| UI 功能 | 调用的 API | 说明 |
|---|---|---|
| 列出已装 MCP | `GET /workspace/:id/mcp` | 返回 `{ items: [{ name, config, source }] }` |
| 安装本地 MCP | `POST /workspace/:id/mcp` body `{ name, config: { type: "local", command: [...] } }` | |
| 安装远程 MCP | `POST /workspace/:id/mcp` body `{ name, config: { type: "remote", url: "..." } }` | |
| 删除 MCP | `DELETE /workspace/:id/mcp/:name` | |
| 清除 MCP OAuth | `DELETE /workspace/:id/mcp/:name/auth` | |
| 重载引擎 | `POST /workspace/:id/engine/reload` | 改 MCP 后必须调 |
| 安装 Chrome 浏览器控制 | addMcp("control-chrome", ...) + reloadEngine() | 见 [Step 4.2](#step-4配置-mcp-工具) |

**配置写入位置**：MCP 配置最终写入工作区根目录的 `opencode.json` 的 `mcp` 段。

### 14.4 Skills 管理

**参考文件**：[apps/app/src/app/pages/skills.tsx](apps/app/src/app/pages/skills.tsx)

| UI 功能 | 调用的 API | 说明 |
|---|---|---|
| 列出技能 | `GET /workspace/:id/skills` 或读 `.opencode/skills/` 目录 | |
| 安装技能 | `POST /workspace/:id/skills` body `{ name, content }` | 写入 `.opencode/skills/{name}.md` |
| 删除技能 | `DELETE /workspace/:id/skills/:name` | |
| 从 Hub 安装 | 先 fetch GitHub 仓库内容，再走安装 API | 技能来源: `github.com/{owner}/{repo}/contents/skills` |

**配置位置**：技能文件存放在 `.opencode/skills/{name}.md`（Markdown 格式）。

### 14.5 Plugins 管理

**参考文件**：[apps/app/src/app/pages/plugins.tsx](apps/app/src/app/pages/plugins.tsx)

| UI 功能 | 调用的 API | 说明 |
|---|---|---|
| 列出插件 | `GET /workspace/:id/plugins` 或读 `opencode.json` 的 `plugin` 字段 | |
| 安装插件 | `POST /workspace/:id/plugins` body `{ name }` | |
| 删除插件 | `DELETE /workspace/:id/plugins/:name` | |

**配置位置**：`opencode.json` 的 `plugin` 数组。

### 14.6 模型选择与 Provider 配置

**参考文件**：[apps/app/src/app/context/model-config.ts](apps/app/src/app/context/model-config.ts), [apps/app/src/app/context/providers/store.ts](apps/app/src/app/context/providers/store.ts)

| UI 功能 | 调用的 SDK 方法 | 说明 |
|---|---|---|
| 列出可用模型提供商 | `client.config.providers()` | 返回 anthropic/openai/google 等 |
| 查看某提供商的模型列表 | `client.config.provider({ providerID })` | |
| 设置 API Key | `client.auth.set({ providerID, credential: { type: "apikey", apiKey } })` | 写入 OpenCode secrets |
| 断开提供商 | `client.auth.disconnect({ providerID })` | |
| 切换默认模型 | 写入 `opencode.json` 的 `model` 字段 | 格式: `"anthropic/claude-sonnet-4-5"` |
| 会话级模型覆盖 | `promptAsync` 的 `model` 参数 | 不改配置文件 |

**本地 UI 状态**：模型偏好存在 localStorage（`openwork.modelPref.{workspaceId}`），不会上传。

### 14.7 Commands 和 Agents

| UI 功能 | 调用的 SDK 方法 | 说明 |
|---|---|---|
| 列出可用 agents | `client.app.agents()` | 来自 `.opencode/agent/*.md` |
| 列出 slash commands | `client.app.commands()` | 来自 `.opencode/commands/*.md` |
| 执行命令 | `client.session.command({ sessionID, command, arguments })` | |
| 在 promptAsync 中指定 agent | `promptAsync({ agent: "openwork", ... })` | |

### 14.8 审批管理（仅 `--approval manual` 模式）

| UI 功能 | 调用的 API | 说明 |
|---|---|---|
| 列出待审批 | `GET /approvals` | **需 host token** |
| 批准 | `POST /approvals/:id` body `{ reply: "allow" }` | **需 host token** |
| 拒绝 | `POST /approvals/:id` body `{ reply: "deny" }` | **需 host token** |

### 14.9 自动化任务（需 `opencode-scheduler` 插件）

| UI 功能 | 调用的 API | 说明 |
|---|---|---|
| 列出定时任务 | `GET /workspace/:id/scheduled-jobs` | |
| 创建定时任务 | `POST /workspace/:id/scheduled-jobs` | |
| 删除定时任务 | `DELETE /workspace/:id/scheduled-jobs/:jobId` | |
| 立即运行 | `POST /workspace/:id/scheduled-jobs/:jobId/run` | |

### 14.10 页面 → API 速查矩阵

一张表看清"我要实现 XX 功能该调哪些 API"：

| 你要实现的功能 | 必须调的 API | 认证 | 你需要做的 |
|---|---|---|---|
| 基本聊天 | promptAsync + SSE 事件 | client | 最小 MVP |
| 会话列表/历史 | `GET /workspace/:id/sessions` | client | 侧边栏 |
| 工具调用展示 | SSE `message.part.updated` (tool 类型) | client | 渲染 tool 卡片 |
| 浏览器自动化 | `POST /workspace/:id/mcp` + `engine/reload` | client | 一次性配置 |
| 自定义 MCP | 同上 | client | 设置页面 |
| 模型切换 | promptAsync 的 model 参数 | client | 下拉选择器 |
| API Key 管理 | `client.auth.set()` | client | 设置页面 |
| 权限审批 UI | SSE `permission.asked` + `client.permission.reply` | client | 弹窗确认 |
| 工作区管理 | `POST /workspaces/local` 等 | **host** | IPC 到 main 进程 |
| TODO 跟踪 | SSE `todo.updated` | client | 面板展示 |

> **最小可行产品只需实现前 3 行**（基本聊天 + 会话列表 + 工具调用展示），就能跑通完整的 computer use 体验。

---

## 15. 附录：飞书（Feishu/Lark）消息集成

`opencode-router` 提供飞书 adapter，让用户通过飞书聊天驱动 agent 操控电脑。实现位于 [apps/opencode-router/src/feishu.ts](apps/opencode-router/src/feishu.ts)，使用官方 [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk) 的 WebSocket 长连接模式（不需要公网 webhook）。

### 15.1 飞书应用准备

1. 在 [飞书开发者后台](https://open.feishu.cn/app) 创建 **自建应用**（商店应用不支持长连接）
2. 「添加应用能力」→ 开启「机器人」
3. 「权限管理」→ 申请以下权限：
   - `im:message` — 接收消息
   - `im:message:send_as_bot` — 以机器人身份发消息
   - `im:resource` — 下载图片/文件
4. 「事件与回调」→「事件订阅模式」选择 **「使用长连接接收事件」**
5. 「事件配置」→ 订阅事件 `im.message.receive_v1`
6. 发布应用版本，记录 **App ID**（`cli_xxx`）和 **App Secret**
7. 把机器人添加到目标群或发起私聊

### 15.2 配置方式

**方式 A — 环境变量**（单机器人快速启动）：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=yyyyyyyyyyyyyyyy
FEISHU_DOMAIN=feishu                   # 国内用 feishu，国际版用 lark
```

**方式 B — 配置文件**（`~/.openwork/opencode-router/opencode-router.json`，支持多账号）：

```json
{
  "version": 1,
  "opencodeUrl": "http://127.0.0.1:4096",
  "channels": {
    "feishu": {
      "enabled": true,
      "apps": [
        {
          "id": "default",
          "appId": "cli_xxxxxxxxxxxx",
          "appSecret": "yyyyyyyyyyyyyyyy",
          "enabled": true,
          "domain": "feishu",
          "directory": "/Users/me/workspace"
        }
      ]
    }
  }
}
```

### 15.3 peerId 格式

飞书使用前缀区分 ID 类型：

| 前缀 | 类型 | 用途 |
|---|---|---|
| `ou_` | `open_id` | 用户私聊 |
| `oc_` | `chat_id` | 群聊 |

入站消息自动填入对应 `peerId`，出站时 router 自动选择正确的 `receive_id_type`。

### 15.4 绑定工作目录

用户首次在飞书 @机器人 发消息后，通过 HTTP API 把该对话绑定到工作目录：

```bash
curl -X POST http://127.0.0.1:3005/bindings \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "feishu",
    "identityId": "default",
    "peerId": "ou_xxxxxxxxxxxxxxxx",
    "directory": "/path/to/workspace"
  }'
```

之后该用户的所有消息都会路由到该工作区，agent 在此上下文中执行任务。

### 15.5 消息能力

| 方向 | 类型 | 说明 |
|---|---|---|
| 入站 | 文本 | 自动剥离 `@机器人` 的 mention |
| 入站 | 富文本（post） | 提取纯文本，样式丢弃 |
| 入站 | 图片 / 文件 / 音频 | 自动下载到 `~/.openwork/opencode-router/media/inbound/` |
| 出站 | 文本 | 超过 4000 字符自动分块 |
| 出站 | 图片 | 走 `im.image.create` 上传后引用 |
| 出站 | 文件 / 音频 | 走 `im.file.create` 上传后引用 |

### 15.6 飞书限制与注意事项

- **长连接仅支持自建应用**，商店应用必须用 webhook 模式
- 图片上传最大 **10MB**，文件上传最大 **30MB**
- 单条文本消息最大 150KB（router 切到 4000 字符以保证可读性）
- 群聊中机器人只响应被 `@` 的消息（通过 `mentions` 字段识别）
- 启动时 `wsClient.start()` 有 30 秒超时保护，避免在某些 Node 版本上挂起
- 机器人必须在目标群内，否则无法接收消息

### 15.7 扩展到第三方集成

你的 Electron 或其他项目**不需要**直接调用飞书 SDK。opencode-router 与业务层解耦：只要 orchestrator 启动了 router，飞书消息就能自动驱动 agent。你的项目只需：

1. Electron main 进程 spawn `openwork-orchestrator serve`（默认会带起 opencode-router）
2. 通过环境变量或 API 下发飞书 app 凭证
3. 通过 `POST /bindings` 把飞书 peerId 绑定到用户工作区

无需在前端写任何飞书相关代码。

### 15.8 源码参考

| 文件 | 用途 |
|---|---|
| [apps/opencode-router/src/feishu.ts](apps/opencode-router/src/feishu.ts) | FeishuAdapter 完整实现 |
| [apps/opencode-router/src/config.ts](apps/opencode-router/src/config.ts) | FeishuIdentity 类型与加载逻辑 |
| [apps/opencode-router/src/bridge.ts](apps/opencode-router/src/bridge.ts) | 飞书 adapter 注册与通道路由 |
| [apps/opencode-router/src/media.ts](apps/opencode-router/src/media.ts) | InboundMediaAttachment 支持 `source: "feishu"` |
| [飞书长连接文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode) | 官方事件订阅指南 |

### 15.9 尚未实现（MVP 范围之外）

下列功能在当前 MVP 未实现，可作为后续迭代：

- HTTP API 端点 `GET/POST/DELETE /identities/feishu`（目前只能通过配置文件或环境变量配置）
- 动态添加/移除飞书身份（需重启 router 生效）
- 交互式卡片消息（出站统一用 text/image/file）
- `typing` 指示器（飞书无标准 API）
- 飞书配对码 `/pair` 私密模式（仅 Telegram 支持）
