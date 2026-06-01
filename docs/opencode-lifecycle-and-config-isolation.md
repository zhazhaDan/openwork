# OpenCode 实例生命周期 & Workspace 配置隔离分析

> 基于 `different-ai/openwork` dev 分支最新代码 (GDD/fixDev_5.5)
> 覆盖：Managed Mode 生命周期、配置隔离、端口分配、Token 管理

---

## 一、结论先行

### Managed Mode：**单个 OpenCode Server 进程，多 Workspace 共享**

```
┌─────────────────────────────────────────────────────────────┐
│                    Desktop App (Tauri/Rust)                  │
│                                                             │
│  EngineManager ──── 管理状态（已弃用直连模式）                │
│  OpenworkServerManager ──── 管理唯一的 Server 子进程          │
│       │                                                     │
│       ▼                                                     │
│  spawn_openwork_server()                                    │
│    ├── env: OPENWORK_MANAGE_OPENCODE=1                      │
│    ├── env: OPENWORK_OPENCODE_BIN=<path>                    │
│    └── args: --host 127.0.0.1 --port <随机> --workspace ... │
│                                                             │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              OpenWork Server (Bun/Node.js)                   │
│                                                             │
│  cli.ts: 检测到 MANAGE_OPENCODE=1                           │
│    │                                                        │
│    ▼                                                        │
│  createManagedOpencodeServer()                              │
│    ├── spawn("opencode", ["serve", "--hostname", "127.0.0.1",│
│    │         "--port", "<随机空闲端口>", "--cors", "*"])     │
│    ├── 等待 stdout: "opencode server listening on ..."      │
│    ├── 返回 { url, username, password, pid, close() }        │
│    │                                                        │
│    ▼                                                        │
│  所有 workspace 共享这个 OpenCode 实例                       │
│  通过 x-opencode-directory header 区分 workspace            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**关键发现**：
- **不是每个 workspace 一个 OpenCode 进程**
- **是所有 workspace 共享一个 OpenCode server 进程**
- **隔离通过 `x-opencode-directory` HTTP header 实现**

---

## 二、Managed Mode 生命周期详解

### 2.1 启动链路（4 层）

#### Layer 1: Rust Desktop → 启动 Server

```rust
// commands/engine.rs L368-379
let openwork_info = start_openwork_server(
    &app,
    &openwork_manager,
    &workspace_paths,
    None,           // opencode_base_url: None → 让 Server 自己管理
    None,           // opencode_username
    None,           // opencode_password
    openwork_remote_access_enabled,
    true,           // manage_opencode = true ← 关键标志
    Some(&opencode_bin),  // opencode bin path
    opencode_bin_source.as_deref(),
);
```

#### Layer 2: spawn.rs → 设置环境变量

```rust
// openwork_server/spawn.rs L239-246
if manage_opencode {
    command = command.env("OPENWORK_MANAGE_OPENCODE", "1");     // 告诉 Server 自己管 OpenCode
    if let Some(path) = opencode_bin_path {
        command = command.env("OPENWORK_OPENCODE_BIN", path);   // 告诉 Server 用哪个 binary
    }
}
```

Server 启动参数：
```
openwork-server
  --host 127.0.0.1
  --port <48000-51000 随机>
  --cors *
  --approval auto
  --workspace /path/to/workspace-A
  --workspace /path/to/workspace-B
  ...
```

#### Layer 3: Server CLI → 检测并 spawn OpenCode

```typescript
// cli.ts L26-48
if (!config.opencodeBaseUrl && process.env.OPENWORK_MANAGE_OPENCODE === "1") {
  const workspace = config.workspaces[0];              // 取第一个 workspace 的路径作为 cwd
  managedOpencode = await createManagedOpencodeServer({
    bin: process.env.OPENWORK_OPENCODE_BIN,            // 从环境变量取 binary 路径
    cwd: managedOpencodeCwd,                           // = workspace[0].path
  });
  // 将 managed OpenCode 的连接信息注入到所有 workspace
  config.opencodeBaseUrl = managedOpencode.url;
  for (const entry of config.workspaces) {
    entry.baseUrl ??= managedOpencode.url;             // 所有 workspace 共享同一个 baseUrl
    entry.directory ??= entry.path;                    // 每个 workspace 有自己的 directory
  }
}
```

#### Layer 4: createManagedOpencodeServer → spawn 并等待就绪

```typescript
// managed-opencode.ts L31-91
export async function createManagedOpencodeServer(options) {
  const port = options.port ?? await findFreePort("127.0.0.1");  // 随机找空闲端口
  const username = randomSecret();    // 生成随机认证信息
  const password = randomSecret();

  const child = spawn(options.bin || "opencode", [
    "serve",
    "--hostname", "127.0.0.1",
    "--port", String(port),
    "--cors", "*"                   // 允许跨域
  ], {
    cwd: options.cwd,               // 工作目录 = 第一个 workspace 路径
    env: {
      ...process.env,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 等待 OpenCode 输出 "opencode server listening on http://..."
  const url = await new Promise((resolve, reject) => {
    child.stdout?.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          resolve(match?.[1]);
        }
      }
    });
    // 15s 超时
  });

  return { url, username, password, pid: child.pid, close: () => child.kill() };
}
```

### 2.2 运行时架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                        Desktop App Process                        │
│                                                                    │
│  ┌─────────────────────┐    ┌────────────────────────────────┐   │
│  │  React Frontend      │    │  Rust Shell (Tauri)             │   │
│  │                      │    │                                  │   │
│  │  Workspace A 活跃     │◄──►│  OpenworkServerManager          │   │
│  │  → GET /w/ws_A/...   │    │    ├─ child: Server PID=12345  │   │
│  │                      │    │    ├─ port: 49234               │   │
│  └─────────────────────┘    │    └─ base_url: http://...:49234 │   │
│                             └──────────────┬───────────────────┘   │
│                                            │ spawn                 │
│                             ┌──────────────▼───────────────────┐   │
│                             │  OpenWork Server (Bun) PID=12345 │   │
│                             │                                   │   │
│                             │  ┌─────────────────────────────┐ │   │
│                             │  │ OpenCode (managed) PID=12346│ │   │
│                             │  │ serve on :49235 (随机端口)   │ │   │
│                             │  └──────────────┬──────────────┘ │   │
│                             │                 │                  │   │
│                             │  /w/ws_A/opencode/* ──────────────┤───→ x-opencode-directory: /path/A
│                             │  /w/ws_B/opencode/* ──────────────┤───→ x-opencode-directory: /path/B
│                             │  /w/ws_C/opencode/* ──────────────┤───→ x-opencode-directory: /path/C
│                             └───────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 2.3 生命周期事件

| 事件 | 触发条件 | 行为 |
|---|---|---|
| **启动** | 用户打开 App / 手动 start engine | Rust spawn Server → Server spawn OpenCode → 等待 health check → 探测 /workspaces 获取 opencode info |
| **健康检查** | Server 启动后 | `GET /health` 最多等 10s，轮询间隔 200ms |
| **Owner Token** | Server 健康后 | `POST /tokens` 用 host_token mint owner_token |
| **请求代理** | 前端调 `/w/:id/opencode/*` | Server 加 `x-opencode-directory` + `Authorization` header 后转发 |
| **引擎重载** | 用户点 reload engine | `POST <baseUrl>/instance/dispose?directory=<dir>` → OpenCode dispose 该 directory 的实例 |
| **停止** | 用户 stop / App 关闭 | `SIGTERM` → Server shutdown handler → `managedOpencode.close()` → kill OpenCode child |
| **崩溃检测** | Server stdout/stderr 事件 | `CommandEvent::Terminated` → 标记 `child_exited=true`，前端可查询状态 |

### 2.4 停止与清理

```typescript
// cli.ts L80-83
const shutdown = () => {
  managedOpencode?.close();   // child.kill() — SIGTERM/SIGKILL
  (server as { stop?: () => void }).stop?.(true);  // 关闭 HTTP server
};

process.once("SIGINT", shutdown);   // Ctrl+C
process.once("SIGTERM", shutdown);  // kill 信号
```

Rust 层的停止：

```rust
// manager.rs L63-82
pub fn stop_locked(state: &mut OpenworkServerState) {
    if let Some(child) = state.child.take() {
        let _ = child.kill();         // 杀掉 Server 子进程
    }
    // 清空所有状态
    state.child_exited = true;
    state.port = None;
    state.base_url = None;
    // ... 全部清空
}
```

**级联效应**：杀 Server → Server 的 shutdown handler → 杀 OpenCode → 全部清理。

---

## 三、Workspace 级别配置隔离机制

### 3.1 隔离的核心：`x-opencode-directory` Header

这是整个多工作区隔离的**唯一机制**。OpenCode Server 本身支持 multi-tenant，通过 `directory` 参数区分不同 workspace。

```typescript
// server.ts L516-519 (proxyOpencodeRequest)
const directoryHeader = workspace ? buildOpencodeDirectoryHeader(
  resolveOpencodeDirectory(workspace)
) : null;

if (directoryHeader && !headers.has("x-opencode-directory")) {
  headers.set("x-opencode-directory", directoryHeader);  // ← 关键！
}
```

### 3.2 Directory 解析优先级

```typescript
// server.ts L3344-3349
function resolveOpencodeDirectory(workspace: WorkspaceInfo): string | null {
  const explicit = workspace.directory?.trim() ?? "";
  if (explicit) return explicit;                          // 1. 显式配置
  if (workspace.workspaceType === "local") return workspace.path;  // 2. local 类型用 path
  return null;                                            // 3. remote 类型无 directory
}
```

实际值来源链：

```
WorkspaceConfig.directory
  ↑ CLI: --opencode-directory <path> (仅当只有 1 个 workspace 时)
  ↑ ENV: OPENWORK_OPENCODE_DIRECTORY
  ↑ File Config: server.json → opencodeDirectory
  ↑ cli.ts fallback: entry.directory ??= entry.path  (managed mode 下)
```

### 3.3 CJK 路径编码

```
// server.ts L3351-3360
function buildOpencodeDirectoryHeader(directory): string | null {
  if (!directory) return null;
  const trimmed = directory.trim();
  // CJK 字符不能放在 HTTP header 中，需要 percent-encode
  return /[^\x00-\x7F]/.test(trimmed)
    ? encodeURIComponent(trimmed)   // /Users/foo/工作区 → %2FUsers%2Ffoo%2F%E5%B7%A5%E4%BD%9C%E5%8C%BA
    : trimmed;                     // ASCII 路径原样传递
}
```

### 3.4 配置文件系统：每 Workspace 独立的 `wudong.jsonc`

**注意**：GDD 分支已将品牌从 `opencode` 改为 `tron`。

```
workspace-root/
├── tron.jsonc          ← 首选（根目录，带注释的 JSON）
├── tron.json           ← 备选（根目录，纯 JSON）
└── .tron/
    ├── tron.jsonc      ← 首选（隐藏目录，Git 友好）
    ├── tron.json       ← 备选
    ├── tron.json     ← OpenWork 自身配置
    ├── skills/         ← Workspace 级 skills
    ├── commands/       ← Workspace 级命令模板
    └── plugins/        ← Workspace 级插件
```

优先级查找逻辑 (`workspace-files.ts`)：

```typescript
export function opencodeConfigPath(workspaceRoot: string): string {
  // 优先级从高到低：
  1. .tron/wudong.jsonc    ← Git 友好，推荐
  2. .tron/wudong.json
  3. tron.jsonc          ← 根目录（向后兼容）
  4. tron.json
  return hiddenJsoncPath;  // 默认返回 .tron/wudong.jsonc
}
```

### 3.5 每个 Workspace 可独立配置的内容

`wudong.jsonc` 中可配置的字段（通过 Server API 读写）：

| 配置域 | API 端点 | 隔离级别 |
|---|---|---|
| **Provider** (model/api key) | `GET/POST /w/:id/opencode/config/providers` | ✅ Per-workspace |
| **Plugin** | `GET/POST /w/:id/plugins` | ✅ Per-workspace (写 tron.jsonc) |
| **MCP Server** | `GET/POST /w/:id/mcp` | ✅ Per-workspace (写 tron.jsonc) |
| **Skill** | `GET /w/:id/skills` | ✅ Per-workspace (.tron/skills/) |
| **Command Template** | `GET/POST /w/:id/commands` | ✅ Per-workspace (.tron/commands/) |
| **compaction.auto** | Settings UI toggle | ✅ Per-workspace (写 tron.jsonc) |
| **baseUrl** | Server config / workspace config | ⚠️ Managed mode 下共享 |
| **directory** | 自动 = workspace.path | ✅ Per-workspace |

### 3.6 配置读写流程示例：MCP

```
用户在 UI 中添加 MCP server
  │
  ▼
POST /w/ws_xxx/mcp
  │ body: { name: "my-mcp", config: { type: "stdio", command: "node", args: [...] } }
  ▼
Server mcp.ts:
  1. readJsoncFile(opencodeConfigPath(workspaceRoot))  // 读 .tron/wudong.jsonc
  2. 合并 mcp 到 config.mcp 字段
  3. updateJsoncTopLevel(opencodeConfigPath(root), { mcp: mcpMap })  // 写回
  4. emitReloadEvent(ctx.reloadEvents, workspace, "mcp", trigger)
  ▼
ReloadEvent 通过 SSE 推送给前端
  → 前端刷新 MCP 列表
```

---

## 四、端口分配策略

### 4.1 两层端口

| 层 | 用途 | 范围 | 分配策略 |
|---|---|---|---|
| **Server Port** | OpenWork Server HTTP | 48000-51000 | 随机偏移 + 冲突跳过 |
| **OpenCode Port** | Managed OpenCode serve | OS 随机分配 (port=0) | `findFreePort()` |

### 4.2 Server Port 分配算法

```rust
// spawn.rs L47-83
pub fn resolve_openwork_port(host, preferred_port, reserved_ports) -> Result<u16> {
    // 1. 如果有 preferred_port 且未被占用 → 直接使用（重启复用）
    if let Some(port) = preferred_port {
        if !reserved_ports.contains(port) && wait_for_preferred_port(host, port) {
            return Ok(port);
        }
    }

    // 2. 在 48000-51000 范围内随机起始，线性探测
    let count = range_port_count();  // ~3001 个可用端口
    let start = random_range_offset();  // 基于 nanos 随机
    for step in 0..count {
        let port = OPENWORK_PORT_RANGE_START + (start + step) % count;
        if !reserved_ports.contains(port) && bind_available_port(host, port) {
            return Ok(port);
        }
    }

    // 3. 最终回退到 OS ephemeral port (bind to :0)
    for _ in 0..32 {
        let listener = TcpListener::bind((host, 0))?;
        return Ok(listener.local_addr()?.port());
    }
}
```

### 4.3 端口持久化

```
~/.config/wudong-wd/openwork-server-state.json
{
  "version": 3,
  "workspace_ports": {
    "/Users/mac/project-A": 49234,
    "/Users/mac/project-B": 49100
  },
  "preferred_port": null
}
```

- 每次 Server 启动时写入当前端口
- **其他 workspace 的端口被标记为 reserved**，避免冲突
- 重启同一 workspace 时**优先复用上次端口**（`preferred_port` 机制）

### 4.4 Token 持久化

```
~/.config/wudong-wd/openwork-server-tokens.json
{
  "version": 1,
  "workspaces": {
    "/Users/mac/project-A": {
      "client_token": "uuid-v4...",
      "host_token": "uuid-v4...",
      "owner_token": "uuid-v4...",   // 每次 Server 启动重新 mint
      "updated_at": 1708000000000
    }
  }
}
```

- `client_token` / `host_token`：**跨重启稳定**（首次生成后不变）
- `owner_token`：**每次启动重新 mint**（Server 端生成，不信任 desktop 缓存）

---

## 五、Engine Reload（引擎热重载）机制

### 5.1 触发条件

用户在 UI 中点击 "Reload Engine" 或修改了需要生效的配置后：

```typescript
// server.ts L3386-3406
async function reloadOpencodeEngine(config, workspace) {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl;
  const directory = resolveOpencodeDirectory(workspace);

  // 构造 URL: POST <baseUrl>/instance/dispose?directory=<encoded-dir>
  const targetUrl = buildOpencodeReloadUrl(baseUrl, directory);

  const response = await fetch(targetUrl, { method: "POST", headers: { Authorization } });
  // OpenCode dispose 该 directory 的内存实例
  // 下次请求时会自动重新加载最新的 tron.jsonc 配置
}
```

### 5.2 Reload vs Restart 对比

| | **Reload Engine** | **Restart Server** |
|---|---|---|
| 目标 | 单个 workspace 的 OpenCode 实例 | 整个 Server + OpenCode |
| 影响范围 | 只影响一个 workspace | 所有 workspace 中断 |
| 速度 | ~1s (HTTP round-trip) | ~3-5s (进程重启) |
| 数据保留 | ✅ 会话保持 | ❌ 需要重建 SSE 连接 |
| 触发方式 | UI 按钮 / API | Stop + Start |

### 5.3 配置变更自动触发 Reload

以下操作会自动触发 ReloadEvent（通过 SSE 推送）：

| 操作 | 触发原因 | 是否 auto-reload |
|---|---|---|
| 修改 tron.jsonc (provider/model) | `"config"` | ✅ |
| 添加/删除 Plugin | `"plugins"` | ✅ |
| 添加/删除 MCP Server | `"mcp"` | ✅ |
| 安装/卸载 Skill | `"skills"` | ✅ |
| 添加/编辑 Command | `"commands"` | ✅ |
| 修改 Agent 定义 | `"agents"` | ✅ |

---

## 六、完整数据流：一次请求的生命周期

以 "Workspace A 中发送 prompt" 为例：

```
1. React Frontend
   POST /w/ws_A/session/<sid>/prompt
   Headers: { Authorization: Bearer <client_token> }

2. OpenWork Server (Bun)
   ├── 解析 mount: workspaceId = ws_A, restPath = /session/<sid>/prompt
   ├── 认证: requireClient() → 验证 Bearer token
   ├── 找到 workspace: config.workspaces.find(w => w.id === "ws_A")
   ├── 解析连接:
   │   baseUrl = ws_A.baseUrl (= managed OpenCode URL)
   │   authHeader = Basic <username>:<password>
   │   directory = ws_A.directory (= /path/to/workspace-A)
   │
   └── 代理转发:
       POST http://127.0.0.1:<opencode_port>/session/<sid>/prompt
       Headers: {
         Authorization: Basic <creds>,
         "x-opencode-directory": "/path/to/workspace-A",  ← 隔离关键
         Content-Type: application/json
       }
       Body: { content: "帮我写个函数..." }

3. OpenCode Server (managed)
   ├── 收到 x-opencode-directory header
   ├── 定位到 /path/to/workspace-A/.tron/tron.db (SQLite)
   ├── 读取该 workspace 的 session + messages
   ├── 调用 LLM API (provider 来自 tron.jsonc 配置)
   └── SSE 流式返回 token deltas

4. OpenWork Server (反向)
   ├── sanitizeProxyResponse() (去掉 content-encoding 等 hop-by-hop header)
   └── 返回给前端

5. React Frontend
   ├── SSE delta → requestAnimationFrame batch → setQueryData
   └── UI 更新 (60fps)
```

---

## 七、总结

```
┌─────────────────────────────────────────────────────────────────┐
│                    架构总结                                      │
├──────────────────────┬──────────────────────────────────────────┤
│ 维度                  │ 实现                                     │
├──────────────────────┼──────────────────────────────────────────┤
│ OpenCode 实例数       │ 1 个 (所有 workspace 共享)               │
│ Workspace 隔离方式     │ x-opencode-directory HTTP header         │
│ 配置文件              │ 每 workspace 独立 .tron/wudong.jsonc        │
│ SQLite DB             │ 每 workspace 独立 .tron/tron.db           │
│ Server 进程数         │ 1 个 (单例，Mutex 保护)                  │
│ 端口分配              │ Server: 48000-51000 随机; OpenCode: OS   │
│ Token 管理            │ client/host 跨重启稳定; owner 每次刷新   │
│ 引擎重载              │ POST /instance/dispose?directory=<dir>   │
│ 崩溃恢复              │ 检测 Terminated 事件 → 状态标记 → UI 反馈 │
│ CJK 路径支持          │ percent-encode in x-opencode-directory   │
│ 远程 workspace        │ baseUrl + directory 组合 ID (sha256前12) │
└──────────────────────┴──────────────────────────────────────────┘
```

**设计哲学**：
- **单一 OpenCode 进程**：节省资源，简化部署
- **Header 级隔离**：无侵入，OpenCode 原生支持 multi-directory
- **配置即代码**：`wudong.jsonc` 是唯一真相源，Server 只做代理和校验
- **端口随机化**：避免冲突，支持多实例并行开发
