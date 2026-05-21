# OpenWork 跨工作区管理分析

> 基于 `different-ai/openwork` GDD/fixDev_5.5 分支
> 覆盖：Workspace 列表、选择、切换、添加、删除、Remote 连接、并发隔离、状态持久化

---

## 一、总体架构

### 1.1 三态模型

OpenWork 维护**三套 workspace ID 系统**，各司其职：

| State    | Owner        | Purpose                            |
|----------|--------------|------------------------------------|
| selected | Rust/Desktop | 用户在 UI 中当前聚焦的 workspace    |
| watched  | Rust/Desktop | 文件系统监控目标 (filesystem watcher)|
| active   | Server       | Server 端激活 (触发 OpenCode reload)|

### 1.2 三层存储

| 层 | 存储位置 | 内容 | 持久化 |
|---|---|---|---|
| **Desktop (Rust)** | `~/.config/wudong-wd/workspace-state.json` | 完整 workspace 列表 (id/path/type/baseUrl) | 永久 |
| **Server (Bun)** | `server.json` 或 `config.workspaces[]` | Server 启动时加载的 workspace 列表 | 永久 |
| **React Shell** | `localStorage` | 当前 active workspaceId + 每个 workspace 最后打开的 sessionId | 永久 |
| **React State** | Zustand `useOpenworkStore` | `activeWorkspaceId` + `workspaces[]` (运行时) | 内存 |

### 1.3 两层 Workspace 数据类型

**Rust Desktop -> tauri IPC -> JS:**
```
WorkspaceInfo {
  id: "ws_abc1234567",           // SHA256(path) 前12位
  name: "my-project",            // 路径最后一节 或 用户指定
  path: "/Users/mac/project",    // 文件系统绝对路径
  preset: "starter" | "remote",  // 模板类型
  workspaceType: "local" | "remote",
  remoteType?: "openwork" | "opencode",
  baseUrl?: "http://...:49234",
  directory?: "/custom/dir",
  displayName?: "My Project",    // 用户自定义别名
  openworkHostUrl?, openworkToken?, ...
}
```

**Server -> HTTP -> JS (OpenworkWorkspaceInfo):**
```
= WorkspaceInfo + {
  opencode?: {                   // Server 注入的 OpenCode 连接信息
    baseUrl?: "http://127.0.0.1:49235",
    directory?: "/path/to/ws",
    username?: "xxx",
    password?: "xxx"
  }
}
```

---

## 二、Workspace 列表加载与合并

### 2.1 启动流程

```
1. Desktop boot
   Rust workspace_bootstrap()
   -> 读取 ./config/wudong-wd/workspace-state.json
   -> 修正 selected/watched ID (清理无效引用)
   -> 启动文件监控 (watch local workspace root + .tron/ 目录)
   -> 返回 WorkspaceList 给前端

2. React Shell mount
   session-route.tsx: refreshRouteState()
   +-- 读取 desktop workspace list (WorkspaceList)
   +-- 连接 OpenWork Server (resolveOpenworkConnection)
   +-- GET /workspaces -> Server 返回 workspace 列表 (含 opencode 连接信息)
   +-- mergeRouteWorkspaces(serverList, desktopList)
   |     +-- Server 优先 (含有 opencode 信息)
   |     +-- Desktop 补充 (路径/displayName 如有)
   |     +-- 去重: 按 id 和 path 匹配
   +-- 解析 activeWorkspaceId 优先级:
   |     1. URL 中 sessionId 对应的 workspace
   |     2. localStorage 记录的 activeWorkspaceId
   |     3. desktop list 的 selectedId
   |     4. server list 的 activeId
   |     5. 第一个 workspace
   +-- loadWorkspaceSessionsInBackground() 后台加载会话列表
```

### 2.2 合并逻辑

Server workspace 作为主表（含有 opencode 连接信息），Desktop workspace 补充 displayName/name。去重 key: id 优先, path normalize 其次。返回合并列表: [...mergedServer, ...missingDesktop]。

### 2.3 三种 Workspace 类型

| Type | 特征 |
|---|---|
| **local** | path: 文件系统路径; baseUrl: 无 (由 Server Managed OpenCode 统一); directory: =path (自动); id: SHA256(path) |
| **remote (opencode)** | baseUrl: 远程地址; directory: 可选; id: SHA256(remote::{baseUrl}::{directory}) |
| **remote (openwork)** | openworkHostUrl: OpenWork server; openworkWorkspaceId: 远程 workspace id; id: SHA256(openwork::{hostUrl}::{wsId}) |

---

## 三、Workspace 切换 -- 完整链路

### 3.1 用户点击 Workspace

```
用户点击 sidebar workspace
  |
  v
onSelectWorkspace(workspaceId)     // session-route.tsx L1907
  |
  +-- 1. 如果 id 未变化 -> 提前返回
  |
  +-- 2. 更新 React 状态
  |     setSelectedWorkspaceId(workspaceId)
  |     writeActiveWorkspaceId(workspaceId)  // localStorage
  |
  +-- 3. 后台加载会话列表 (如果缓存为空)
  |     setRetryingWorkspaceIds([workspaceId])
  |     loadWorkspaceSessionsInBackground(client, [workspace])
  |
  +-- 4. Tauri IPC (fire-and-forget, 不等返回以加速快速切换)
  |     workspaceSetSelected(workspaceId)       // -> Rust: selected_workspace_id = id
  |     workspaceSetRuntimeActive(workspaceId)  // -> Rust: watched_workspace_id = id
  |
  +-- 5. Server activate
  |     client.activateWorkspace(workspaceId)  // -> POST /workspaces/:id/activate
  |                                            // -> emit reload event
  |
  +-- 6. 导航到上次的 session (如果有)
  |     读取 localStorage -> 找到 session -> navigate("/session/${sessionId}")
  |
  +-- 7. React useEffect 级联触发
        opencodeClient 重建 (依赖 selectedWorkspaceId 变化)
        -> ReactSessionRuntime 重建 SSE 连接
        -> 旧 workspace 的 SSE 断开 (ref-counted, refs=0 时 dispose)
```

### 3.2 opencodeClient 重建

opencodeClient 是每个 workspace 独立创建的。URL 中嵌入 `workspaceId`。关键代码：

```
const opencodeBaseUrl = useMemo(() => {
  const mounted = buildOpenworkWorkspaceBaseUrl(baseUrl, selectedWorkspaceId);
  return mounted.replace(/\/+$/g, "") + "/opencode";
}, [baseUrl, selectedWorkspaceId]);
```

URL 示例：
```
Workspace A: http://127.0.0.1:49234/w/ws_abc/opencode
Workspace B: http://127.0.0.1:49234/w/ws_def/opencode
```

### 3.3 SSE 连接生命周期

**关键机制：Ref-counted 同步，即时释放。**

所有 sync 按 `{workspaceId}:{baseUrl}:{token}` 键控的 Map 管理。

切 workspace 时：
- 新 workspace: `ensureWorkspaceSessionSync` -> `refs++` -> 创建新 SSE 连接
- 旧 workspace: `releaseWorkspaceSessionSync` -> `refs--` -> 如果 refs=0 -> 断开 SSE
- **立即断开**，不等延迟（注释明确说明：避免多个活跃 workspace 的 SSE 流累积造成性能问题）

### 3.4 React Query Cache 键隔离

所有缓存键都带 `workspaceId` 前缀：
- transcript: `["react-session-transcript", wsId, sId]`
- status: `["react-session-status", wsId, sId]`
- todo: `["react-session-todos", wsId, sId]`
- permission: `["react-session-permissions", wsId, sId]`

切换 workspace 时：
- A workspace 的 cache 数据保留在内存中（React Query 默认不清理）
- B workspace 的 cache 从 snapshot + SSE 重新填充
- 切回 A 时，cache 可能有旧数据，但 snapshot refetch 会覆盖

---

## 四、Workspace CRUD 操作

### 4.1 创建 Local Workspace

```
Desktop: workspace_create(folderPath, name, preset)
  Rust:
  +-- fs::create_dir_all(folder)
  +-- folder = normalize_local_workspace_path(folder)
  +-- id = stable_workspace_id(folder)       // SHA256(path) 前12位
  +-- ensure_workspace_files(folder, preset)  // 创建 .tron/ 模板文件
  +-- state.workspaces.retain(w => w.id != id)  // 去重
  +-- state.workspaces.push(WorkspaceInfo { id, path, preset, workspaceType: Local })
  +-- state.selected_workspace_id = id       // 自动选中
  +-- save_workspace_state()
  +-- 返回 WorkspaceList
```

### 4.2 创建 Remote Workspace

```
Desktop: workspace_create_remote(baseUrl, directory?, displayName?, remoteType, ...)
  Rust:
  +-- 校验 baseUrl 格式 (必须是 http:// 或 https://)
  +-- remoteType === "openwork":
  |     id = stable_workspace_id_for_openwork(hostUrl, workspaceId)
  +-- remoteType === "opencode":
  |     id = stable_workspace_id_for_remote(baseUrl, directory)
  +-- state.workspaces.push(WorkspaceInfo { id, baseUrl, directory, workspaceType: Remote })
  +-- state.selected_workspace_id = id
  +-- 返回 WorkspaceList
```

### 4.3 删除 Workspace (Forget)

```
Desktop: workspace_forget(id)
  Rust:
  +-- state.workspaces.retain(w => w.id != id)
  +-- 如果删除的是当前 selected -> selected = first remaining
  +-- 如果删除的是当前 watched -> watched = selected
  +-- save_workspace_state()
  +-- update_workspace_watch() -> 停止文件监控
  +-- 返回 WorkspaceList

 JS:
  +-- forgetWorkspaceMemory(id)  // 清理 localStorage 中的 workspace->session 映射
```

### 4.4 Workspace 激活 (Activate)

```
POST /workspaces/:id/activate  (host token required)
  Server:
  +-- resolveWorkspace(config, id)
  +-- resolveOpencodeDirectory(workspace)
  +-- POST <opencodeBaseUrl>/instance/dispose?directory=<dir>
  |     -> OpenCode dispose 该 directory 的内存实例
  |     -> 下次请求时重新加载 wudong.jsonc 配置
  +-- emitReloadEvent(ctx.reloadEvents, workspace, "config", trigger)
      -> SSE 推送给前端
```

关键在于 Activate 触发 OpenCode reload，使 wudong.jsonc 的修改生效。

---

## 五、URL 路由与 Server 代理

### 5.1 URL 结构

```
http://127.0.0.1:49234/w/{workspaceId}/opencode/{restPath}
http://127.0.0.1:49234/w/{workspaceId}/workspace/{workspaceId}/plugins  (内层ID匹配校验)
http://127.0.0.1:49234/workspaces  (全局端点，无需 mount)
```

### 5.2 Mount 解析

`parseWorkspaceMount("/w/ws_abc/opencode/session/123/message")`
-> `{ workspaceId: "ws_abc", restPath: "/opencode/session/123/message" }`

### 5.3 Proxy 代理

```
前端: GET /w/ws_abc/opencode/session/list?limit=200
         Header: Authorization: Bearer <client_token>

Server:
  +-- parseWorkspaceMount -> workspaceId=ws_abc, restPath=/opencode/session/list
  +-- requireClient -> 验证 Bearer token
  +-- resolveWorkspace -> 在 config.workspaces 中找 ws_abc
  +-- resolveWorkspaceOpencodeConnection -> baseUrl + authHeader
  +-- resolveOpencodeDirectory -> /path/to/ws_abc
  |
  +-- proxy -> GET http://127.0.0.1:49235/session/list?limit=200
               Headers:
                 Authorization: Basic <username>:<password>
                 x-opencode-directory: /path/to/ws_abc
```

### 5.4 安全性：Mount Checking

读取 `/w/ws_abc/workspace/ws_def/plugins` 时，Server 检测到内层 `ws_def` 不等于外层 `ws_abc` -> 返回 404。防止通过 mount URL 越权访问其他 workspace。

---

## 六、文件系统监控

### 6.1 监控目标

只在 `workspaceType == Local` 时监控，Remote workspace 不监控。

- 根目录 (NonRecursive): 检测 opencode.json/openwork.jsonc -> "config", AGENTS.md -> "agents"
- `.tron/` (Recursive): skills/ -> "skills", agents/ -> "agents", commands/ -> "commands", plugins/ -> "plugins"

### 6.2 Ignore 策略

明确 Ignore: .DS_Store, desktop.ini, .localized, .db, .db-journal, .db-wal, .db-shm, openwork.json

只对已知路径分类 (conservative): 其他任何文件不触发 reload。

### 6.3 Debounce

750ms 防抖。last_emit 在 Arc<Mutex> 中跨 event 共享。

### 6.4 Event 传播

Rust watcher 检测变化 -> 分类 reason -> emit "openwork://reload-required" -> 前端 reloadCoordinator 接收 -> markReloadRequired -> (仅当活跃 session 完成后) 触发 reload。

---

## 七、并发与隔离总结

### 7.1 隔离矩阵

| 维度 | 隔离方式 |
|---|---|
| OpenCode 连接 | 不同 URL -> Server 不同 mount -> 不同 x-opencode-directory |
| SQLite 数据库 | 不同 `.tron/tron.db` (per workspace path) |
| 配置文件 | 不同 `.tron/wudong.jsonc` (per workspace path) |
| Skills | 不同 `.tron/skills/` (per workspace path) |
| Commands | 不同 `.tron/commands/` (per workspace path) |
| LLM Provider | 不同 wudong.jsonc 中的 provider 配置 |
| MCP Server | 不同 wudong.jsonc 中的 mcp 配置 |
| SSE 连接 | 不同 SyncEntry，按 workspaceId 键控 |
| React Query Cache | 不同 key，含 workspaceId 前缀 |
| localStorage | 不同 key->sessionId 映射 |
| Rust 文件监控 | 不同 root directory |
| LLM 调用 | 共享同一个 OpenCode 进程，但 session/message 按 workspace 隔离 |

### 7.2 并行执行能力

```
Workspace A: session_123 -> 正在调用 LLM (流式响应)
Workspace B: session_456 -> 同时调用 LLM

Server 代理:
  /w/ws_A/opencode/session/123/prompt -> x-opencode-directory: /path/A
  /w/ws_B/opencode/session/456/prompt -> x-opencode-directory: /path/B

OpenCode Server (单进程):
  +-- 两个请求共享同一个 event loop (Bun)
  +-- 两个 session 数据库完全隔离 (不同 DB 文件)
  +-- LLM API 调用共享 Provider 连接池
  +-- SSE 流推送按 session 独立

结论: 真正的并行执行，完全隔离，互不干扰
```

### 7.3 跨 Workspace 操作边界

| 操作 | 是否跨 Workspace | 说明 |
|---|---|---|
| 创建新 session | 仅当前 workspace | opencodeClient 的 URL 已锁定 workspaceId |
| 发送 prompt | 仅当前 workspace | URL mount + x-opencode-directory 双重保证 |
| 查看历史 session | 仅当前 workspace | listSessions 返回当前 workspace 的数据 |
| 切换 model | 仅当前 workspace | wudong.jsonc 是 per-workspace |
| 添加 MCP server | 仅当前 workspace | wudong.jsonc 是 per-workspace |
| 修改 skills | 仅当前 workspace | .tron/skills/ 是 per-workspace |
| Reload engine | 仅当前 workspace | POST /instance/dispose?directory=<this-ws> |
| Server 崩溃 | 全部 workspace | 单实例共享，但会话数据在各自 DB 中安全 |

---

## 八、架构图：全链路全景

```
+-----------------------------------------------------------+
|                Desktop Shell (Tauri/Rust)                  |
|                                                           |
|  WorkspaceState { selected, watched, workspaces[] }       |
|       |                                                   |
|       +-- workspace_bootstrap() -> 读 workspace-state.json|
|       +-- update_workspace_watch() -> fs watcher per ws  |
|       +-- workspace_create/forget/set_selected/set_active |
|                                                           |
|  +-----------------------------------------------------+ |
|  |  React Frontend (session-route.tsx)                  | |
|  |                                                     | |
|  |  opencodeClient_A -> http://...:49234/w/ws_A/opencode| |
|  |  opencodeClient_B -> http://...:49234/w/ws_B/opencode| |
|  |                                                     | |
|  |  SSE Sync_A -> key="ws_A:http://...:opencode:token" | |
|  |  SSE Sync_B -> key="ws_B:http://...:opencode:token" | |
|  |                                                     | |
|  |  React Query Cache:                                  | |
|  |    ["transcript", ws_A, sid_1]                      | |
|  |    ["transcript", ws_B, sid_2]  (完全隔离)           | |
|  |                                                     | |
|  |  localStorage:                                       | |
|  |    activeWorkspace: "ws_A"                           | |
|  |    sessionByWorkspace: { ws_A:sid_1, ws_B:sid_2 }   | |
|  +------------------------+----------------------------+ |
+---------------------------|------------------------------+
                        HTTP/SSE
+---------------------------|------------------------------+
|              OpenWork Server (Bun, PID=X)                |
|                                                           |
|  config.workspaces: [                                     |
|    { id:ws_A, path:/User/A, workspaceType:local },       |
|    { id:ws_B, path:/User/B, workspaceType:local },       |
|    { id:ws_R, baseUrl:http://remote, workspaceType:remote}|
|  ]                                                        |
|                                                           |
|  parseWorkspaceMount("/w/ws_A/opencode/session/...")      |
|    -> resolveWorkspace                                    |
|    -> resolveOpencodeDirectory                           |
|    -> proxy (加 x-opencode-directory header)              |
|                                                           |
|  +-----------------------------------------------------+ |
|  |  Managed OpenCode (PID=Y)  serve on :49235          | |
|  |                                                     | |
|  |  x-opencode-directory: /User/A                      | |
|  |    -> SQLite: /User/A/.tron/tron.db                 | |
|  |    -> Config: /User/A/.tron/wudong.jsonc              | |
|  |                                                     | |
|  |  x-opencode-directory: /User/B                      | |
|  |    -> SQLite: /User/B/.tron/tron.db                 | |
|  |    -> Config: /User/B/.tron/wudong.jsonc              | |
|  |                                                     | |
|  |  Session/Message/Todo/Permission 全部按 dir 隔离    | |
|  +-----------------------------------------------------+ |
+-----------------------------------------------------------+
```

### 关键设计决策总结

| 决策 | 选择 | 原因 |
|---|---|---|
| **单 OpenCode 进程 vs 多进程** | 单进程 | 桌面场景资源友好，OpenCode 原生支持 multi-directory |
| **URL Mount 隔离** | `/w/{workspaceId}/opencode` | 无需客户端配置，透明代理 |
| **x-opencode-directory header** | 每次代理自动注入 | OpenCode 原生 multi-tenant 支持 |
| **SSE 即时释放** | refs=0 立即 dispose | 避免多 workspace SSE 流累积冻结 UI |
| **Cache 不主动清理** | 保留旧 workspace cache | 下次切换回来更快 |
| **Fire-and-forget IPC** | Tauri 调用不等返回 | 加速快速 workspace 切换 |
| **Workspace 三态模型** | selected + watched + active | 解耦 UI 选择、文件监控、Server 激活 |
