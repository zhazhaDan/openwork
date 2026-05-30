# OpenWork dev 分支：工作区与会话管理架构文档

> 从 `different-ai/openwork` dev 分支 (`c4656492`) 提取的架构参考文档。
> 目标用途：作为其他项目实现多工作区 + 会话管理的设计参考。

---

## 一、总体架构

OpenWork 是一个三层架构的桌面代理工作台：

```
┌──────────────────────────────────────────────────────┐
│  apps/app (前端 UI)                                   │
│  ┌──────────────────────────────────────────────────┐│
│  │ src/react-app/   ← React 域架构 (主运行时)        ││
│  │ ├── shell/       启动引导 + 路由                  ││
│  │ ├── kernel/      Zustand store + Provider 栈      ││
│  │ ├── domains/     8 个业务域                       ││
│  │ │   ├── session/    会话主页面 + 状态同步          ││
│  │ │   └── workspace/  工作区 CRUD 模态框             ││
│  │ └── infra/       TanStack Query                   ││
│  └──────────────────────────────────────────────────┘│
└──────────────┬────────────────────┬───────────────────┘
               │ Tauri IPC          │ HTTP (REST API)
               ▼                    ▼
┌─────────────────────┐  ┌─────────────────────────────┐
│ apps/desktop (Rust)  │  │ apps/server (Bun)            │
│ 引擎进程管理           │  │ REST API + OpenCode 代理层   │
│ 工作区状态持久化        │  │ 每个工作区独立 baseUrl 配置  │
│ 文件系统监听           │  └──────────────┬──────────────┘
└─────────────────────┘                  │
                                   ┌─────▼──────┐
                                   │ OpenCode   │
                                   │ 实例们      │
                                   │ (per WS)    │
                                   └────────────┘
```

## 二、工作区管理的核心设计决策

### 2.1 每个工作区有独立的 OpenCode 连接

这不是"单进程切换"模型，而是**每个工作区维护独立的 OpenCode 连接 URL**。

**工作区数据结构** (`WorkspaceInfo`):

```typescript
interface WorkspaceInfo {
  id: string;              // 稳定哈希 ID (ws_<sha256_prefix>)
  name: string;
  path: string;            // 本地路径
  workspaceType: "local" | "remote";
  baseUrl?: string;        // ★ 该工作区的 OpenCode API URL
  directory?: string;      // 工作区目录 (传递给 OpenCode)
  // ... 其他字段
}
```

### 2.2 Server 层代理模式

前端不直接连接 OpenCode，而是通过 OpenWork Server 代理：

```
前端请求:  /w/{workspaceId}/opencode/session?directory=/path
               │
               ▼
        parseWorkspaceMount() 解析 workspaceId
               │
               ▼
        resolveWorkspaceOpencodeConnection(workspace)
          → 获取 workspace.baseUrl (该工作区专属的 OpenCode URL)
               │
               ▼
        proxyOpencodeRequest()
          → 转发到 workspace.baseUrl + "/session"
          → 注入 x-opencode-directory header
          → 注入 Authorization (Basic Auth)
```

**关键代码** (`apps/server/src/opencode-connection.ts`):

```typescript
export function resolveWorkspaceOpencodeConnection(
  config: ServerConfig,
  workspace: WorkspaceInfo,
): { baseUrl?: string; authHeader?: string } {
  // 每个 workspace 有自己的 baseUrl
  const baseUrl = workspace.baseUrl || config.opencodeBaseUrl || undefined;
  
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(username && password ? { authHeader: `Basic ...` } : {}),
  };
}
```

**结论**：每个工作区可以连接到**不同的 OpenCode 实例**，切换工作区不会杀死另一个工作区的运行中 task。

---

## 三、工作区切换流程（前端完整链路）

### 3.1 `selectedWorkspaceId` 状态管理

**React 组件状态** (`src/react-app/shell/session-route.tsx`):

```typescript
// 工作区选择状态 — 单一 selectedWorkspaceId
const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
  () => readActiveWorkspaceId() ?? ""
);

// 按工作区分组的会话列表
const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = 
  useState<Record<string, any[]>>({});

// 工作区列表 (合并了桌面端本地工作区和服务器端远程工作区)
const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
```

**Zustand 全局 store** (`src/react-app/kernel/store.ts`):

```typescript
type OpenworkStore = {
  workspaces: OpenworkWorkspaceInfo[];
  activeWorkspaceId: string | null;
  selectedSessionId: string | null;
};
```

### 3.2 切换触发：`onSelectWorkspace` 回调

**完整代码** (`session-route.tsx` 行 1907-1943):

```typescript
onSelectWorkspace: async (workspaceId) => {
  // ① 防重复：已是当前工作区则跳过
  if (workspaceId === selectedWorkspaceId) return true;

  // ② 更新 React 状态 — 触发 UI 重渲染
  setSelectedWorkspaceId(workspaceId);
  writeActiveWorkspaceId(workspaceId || null);  // localStorage 持久化

  // ③ 后台加载新工作区的会话列表 (如果尚未加载)
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (client && workspace && !sessionsByWorkspaceId[workspaceId]?.length) {
    setRetryingWorkspaceIds((current) => 
      Array.from(new Set([...current, workspaceId]))
    );
    void loadWorkspaceSessionsInBackground(client, [workspace]);
  }

  // ④ 通知桌面壳 (Tauri IPC) — fire-and-forget
  if (isDesktopRuntime()) {
    void workspaceSetSelected(workspaceId).catch(() => undefined);
    void workspaceSetRuntimeActive(workspaceId).catch(() => undefined);
  }

  // ⑤ 通知 OpenWork Server 激活工作区 — 触发 config reload 事件
  if (workspaceId && client) {
    void client.activateWorkspace(workspaceId).catch(() => undefined);
  }

  // ⑥ 恢复到该工作区上一次打开的会话
  const remembered = readLastSessionFor(workspaceId);
  if (remembered && remembered !== selectedSessionId) {
    const known = sessionsByWorkspaceId[workspaceId];
    if (known?.some((s) => s?.id === remembered)) {
      navigate(`/session/${remembered}`);
    }
  }
  return true;
},
```

### 3.3 `opencodeClient` 的响应式派生

**这是架构的核心** — 切换工作区后，OpenCode 客户端自动指向新工作区：

```typescript
// ① 计算当前工作区的 OpenCode 代理 URL
const opencodeBaseUrl = useMemo(() => {
  if (!selectedWorkspaceId || !baseUrl) return "";
  const mounted = buildOpenworkWorkspaceBaseUrl(baseUrl, selectedWorkspaceId) ?? baseUrl;
  return `${mounted}/opencode`;
  // 结果示例: http://localhost:48001/w/ws_abc123/opencode
}, [baseUrl, selectedWorkspaceId]);
//                    ▲ selectedWorkspaceId 变化 → opencodeBaseUrl 自动更新

// ② 创建指向该工作区 OpenCode 的客户端
const opencodeClient = useMemo(
  () =>
    opencodeBaseUrl && token && !selectedWorkspaceError
      ? createClient(opencodeBaseUrl, selectedWorkspaceRoot, {
          token,
          mode: "openwork",
        })
      : null,
  [opencodeBaseUrl, selectedWorkspaceError, selectedWorkspaceRoot, token],
);
//▲ opencodeBaseUrl 变化 → opencodeClient 自动重新创建
```

**依赖链**:

```
selectedWorkspaceId 变化
  → opencodeBaseUrl 重新计算  (新的 /w/新id/opencode)
  → opencodeClient 重新创建   (指向新工作区的 OpenCode 实例)
  → canCreateTask = true      (如果连接可用)
```

### 3.4 发送 prompt 流程

```typescript
onSendDraft: async (draft: ComposerDraft) => {
  // ★ 直接使用当前的 opencodeClient, 它已指向当前 selectedWorkspaceId 的 OpenCode
  // ★ 不需要任何 "ensureWorkspaceRuntime" 或 "activateWorkspace" 前置调用
  
  const result = await opencodeClient.session.promptAsync({
    sessionID: selectedSessionId,  // 当前选中的会话
    parts,                         // prompt 内容
    model: local.prefs.defaultModel,
    agent: selectedAgent,
  });
},
```

---

## 四、会话管理

### 4.1 会话归属

会话**严格归属于工作区**。数据存储在工作区对应的 OpenCode SQLite 数据库 (`.tron/tron.db`) 中。

### 4.2 会话跨工作区状态

```
sessionsByWorkspaceId = {
  "ws_abc123": [session_a, session_b, ...],  // 工作区 A 的会话
  "ws_def456": [session_x, session_y, ...],  // 工作区 B 的会话
}
```

切换工作区时保留已有会话缓存 — 不会因为切换而丢失侧边栏数据。

### 4.3 会话列表加载策略

```typescript
// 后台加载（非阻塞），最多重试 6 次，指数退避
const loadWorkspaceSessionsInBackground = async (client, workspaces) => {
  const MAX_ATTEMPTS = 6;
  const backoffMs = (attempt) => Math.min(500 * 2^attempt, 4000);
  
  // 每个工作区独立请求:
  // GET /w/{workspaceId}/sessions?limit=200
  const response = await client.listSessions(workspaceId, { limit: 200 });
  
  setSessionsByWorkspaceId((current) => ({
    ...current,
    [workspaceId]: response.items,
  }));
};
```

### 4.4 上次会话持久化

```typescript
// localStorage 持久化
openwork.workspace-last-session.v1 = { workspaceId: sessionId }

// 切换工作区时恢复
const remembered = readLastSessionFor(workspaceId);
if (remembered) navigate(`/session/${remembered}`);
```

### 4.5 会话运行状态检测

```typescript
function isActiveSessionStatus(status: unknown) {
  return status === "running" || status === "retry" || status === "busy";
}

// 用于 Reload 拦截 — 如果有活跃会话则阻止引擎重载
const activeReloadBlockingSessions = useMemo(
  () =>
    Object.values(sessionsByWorkspaceId)
      .flat()
      .filter((session) => isActiveSessionStatus(getSessionStatus(session)))
      .map((session) => ({
        id: session.id,
        title: session.title || "untitled",
      })),
  [sessionsByWorkspaceId],
);
```

---

## 五、桌面壳层 (Rust)

### 5.1 工作区状态持久化

**文件**: `<app_data>/wudong-workspaces.json` (JSON, 版本 5)

```rust
pub struct WorkspaceState {
    pub version: u32,
    pub selected_workspace_id: String,   // UI 选择的工作区
    pub watched_workspace_id: String,     // 运行时激活的工作区 (文件监听目标)
    pub workspaces: Vec<WorkspaceInfo>,   // 所有注册的工作区
}
```

**关键**: `selected` 和 `watched` 在 Rust 层是两个独立字段，但在前端 `onSelectWorkspace` 中始终同时设置。这种双字段设计为未来"浏览不切换运行时"的场景保留了可能。

### 5.2 引擎管理

**单进程模式**: `EngineManager` 维护单一 `CommandChild`:

```rust
pub struct EngineState {
    pub child: Option<CommandChild>,    // 唯一一个 OpenCode 子进程
    pub base_url: Option<String>,
    pub project_dir: Option<String>,
    // ...
}

impl EngineManager {
    pub fn stop_locked(state: &mut EngineState) {
        if let Some(child) = state.child.take() {
            let _ = child.kill();
        }
        state.base_url = None;
        // 清除所有状态
    }
}
```

**注意**: 这个 Rust 层的引擎管理主要用于**桌面启动时启动/停止 OpenWork Server**。实际工作区级别的 OpenCode 实例管理由 OpenWork Server (`apps/server/`) 的 managed mode 负责，每个工作区可以有独立的 OpenCode 进程。

### 5.3 OpenWork Server 启动

**端口分配**: 范围 `48000-51000`，优先复用已有端口:

```rust
pub fn resolve_openwork_port(
  host: &str,
  preferred_port: Option<u16>,  // 上次使用的端口
  reserved_ports: &HashSet<u16>,
) -> Result<u16, String> { /* ... */ }
```

**启动参数**:
```
openwork-server 
  --host 127.0.0.1 
  --port 48001 
  --workspace /path/to/a --workspace /path/to/b  // 预注册所有工作区
  --cors * 
  --approval auto
```

**环境变量**:
```
OPENWORK_TOKEN=<random>
OPENWORK_HOST_TOKEN=<random>
OPENWORK_MANAGE_OPENCODE=1          // Server 自己管理 OpenCode 生命周期
OPENWORK_OPENCODE_BIN=<path>        // OpenCode 二进制路径
```

---

## 六、数据流总览

```
用户点击工作区 B 的侧边栏
  │
  ├─ ① setSelectedWorkspaceId(B)
  ├─ ② writeActiveWorkspaceId(B)        → localStorage
  ├─ ③ loadWorkspaceSessionsInBackground → GET /w/B/sessions
  ├─ ④ workspaceSetSelected(B)          → Tauri IPC → Rust 持久化
  ├─ ⑤ workspaceSetRuntimeActive(B)     → Tauri IPC → 文件监听更新
  ├─ ⑥ client.activateWorkspace(B)      → POST /workspaces/B/activate → server 重排 activeId
  │
  │  ✦ 工作区 A 的 OpenCode: 继续运行, task 不受影响
  │
  ├─ ⑦ opencodeBaseUrl 重新计算:
  │     buildOpenworkWorkspaceBaseUrl(baseUrl, B) + "/opencode"
  │
  ├─ ⑧ opencodeClient 重新创建:
  │     createClient(新 opencodeBaseUrl, B 的 workspaceRoot)
  │
  ├─ ⑨ readLastSessionFor(B) → 恢复上次会话
  │     navigate(`/session/${sessionId}`)

用户在 B 的会话 b 中发送 prompt:
  │
  ├─ onSendDraft(draft)
  ├─ opencodeClient 已指向 B 的 OpenCode
  ├─ opencodeClient.session.promptAsync({ sessionID, parts })
  │     → POST /w/B/opencode/session/{sessionID}/prompt_async
  │       → server proxy → B 的 OpenCode 实例
  │
  ✦ A 的 OpenCode: 完全不受影响, task 继续运行
```

---

## 七、关键架构决策汇总

| 决策 | 说明 |
|---|---|
| **每个工作区独立 OpenCode URL** | `workspace.baseUrl` 是工作区配置的核心，允许多工作区并行 |
| **Server 代理模式** | 前端通过 `/w/:id/opencode/*` 访问 OpenCode，Server 按 workspaceId 路由 |
| **`opencodeClient` 响应式派生** | React `useMemo` 依赖 `[opencodeBaseUrl, ...]`，切换工作区自动重建 |
| **会话按工作区分组** | `sessionsByWorkspaceId` 数据结构天然隔离 |
| **后台非阻塞加载** | 切换工作区时异步加载会话列表，不阻塞 UI |
| **上次会话恢复** | localStorage 持久化 `workspaceId → sessionId` 映射 |
| **无跨工作区 task 中断** | 切换工作区只改变前端连接的 URL，不杀后端 OpenCode 进程 |
| **Tauri 仅做薄壳** | 文件操作通过 Server API，Tauri 只管进程启动/停止和原生 UI |

---

## 八、代码索引

| 关注点 | 文件 |
|---|---|
| 前端主页面 + 工作区切换 + 会话发送 | `apps/app/src/react-app/shell/session-route.tsx` |
| 会话 actions store (sendPrompt 等) | `apps/app/src/react-app/domains/session/sync/actions-store.ts` |
| 全局 Zustand store | `apps/app/src/react-app/kernel/store.ts` |
| Server provider 栈 (URL 管理) | `apps/app/src/react-app/kernel/server-provider.tsx` |
| 桌面引导 (engine start) | `apps/app/src/react-app/shell/desktop-runtime-boot.ts` |
| 最后会话 + 工作区内存 | `apps/app/src/react-app/shell/session-memory.ts` |
| Server 主路由 + OpenCode 代理 | `apps/server/src/server.ts` |
| OpenCode 连接解析 | `apps/server/src/opencode-connection.ts` |
| 工作区文件路径管理 | `apps/server/src/workspace-files.ts` |
| Rust 工作区状态持久化 | `apps/desktop/src-tauri/src/workspace/state.rs` |
| Rust 引擎管理器 | `apps/desktop/src-tauri/src/engine/manager.rs` |
| Rust OpenWork Server spawn | `apps/desktop/src-tauri/src/openwork_server/spawn.rs` |
| Rust 命令 (workspace) | `apps/desktop/src-tauri/src/commands/workspace.rs` |
| 域架构设计文档 | `apps/app/src/react-app/ARCHITECTURE.md` |
| 系统架构文档 | `ARCHITECTURE.md` |
