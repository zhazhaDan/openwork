# 会话历史存储策略分析

> 基于 `different-ai/openwork` dev 分支最新代码。
> 覆盖：后端持久化 → 服务端代理 → 前端多级缓存 → SSR 流式推送 → React Query 混合策略。

---

## 一、总览：四层存储架构

```
┌─────────────────────────────────────────────────────────┐
│  Layer 4  localStorage                                   │
│  键: openwork.react.sessionByWorkspace                   │
│  值: { workspaceId → sessionId } 映射                    │
│  作用: 记住用户最后打开的会话, 跨启动恢复                 │
├─────────────────────────────────────────────────────────┤
│  Layer 3  React Query Cache (内存, TanStack Query)       │
│  Key: ["react-session-transcript", workspaceId, session] │
│  Value: UIMessage[]                                      │
│  作用: ① SSR 增量写入 ② Snapshot 合并 ③ 组件响应式渲染    │
│  Key: ["react-session-status", workspaceId, session]     │
│  Value: SessionStatusReadModel                            │
│  Key: ["react-session-todos", workspaceId, session]      │
│  Value: Todo[]                                            │
│  Key: ["react-session-permissions", workspaceId, session]│
│  Value: PendingPermission[]                               │
├─────────────────────────────────────────────────────────┤
│  Layer 2  OpenWork Server (代理 + Zod 验证)               │
│  fetches from OpenCode, validates with Zod, returns JSON │
│  Snapshots: 4 路并行请求 (session + messages + todos +    │
│             statuses) 合成一次返回                         │
│  staleTime: 500ms (React Query 控制刷新频率)               │
├─────────────────────────────────────────────────────────┤
│  Layer 1  OpenCode Engine (真值源)                        │
│  SQLite DB: .tron/tron.db                                │
│    - sessions table                                       │
│    - messages table                                       │
│    - parts table                                          │
│    - todos table                                          │
│  API: GET /session, /session/:id, /session/:id/message   │
│  SSE: /event 推送实时增量                                 │
└─────────────────────────────────────────────────────────┘
```

---

## 二、Layer 1: OpenCode SQLite 持久化

### 2.1 真值源

所有会话历史**仅存储在 OpenCode 的 SQLite 数据库**中。OpenWork 本身不额外持久化消息数据。

```
.tron/tron.db  (SQLite, WAL 模式)
├── sessions
│   id, title, slug, parentID, directory,
│   time: { created, updated, completed, archived }
│   summary: { additions, deletions, files }
├── messages
│   id, sessionID, role, parentID,
│   time: { created, updated }
├── parts
│   id, messageID, sessionID,
│   type: "text" | "reasoning" | "tool" | "file" | "step-start"
│   text, state, ... (per type)
├── todos
│   content, status, priority
└── status
    sessionID → { type: "idle" | "busy" | "retry" }
```

### 2.2 消息部分 (Part) 的类型系统

| Part Type | 示例 | 数据 |
|---|---|---|
| `text` | 用户输入 / 助手回复 | `{ type: "text", text: "hello", state: "done" }` |
| `reasoning` | 模型思考过程 | `{ type: "reasoning", text: "let me think..." }` |
| `tool` | Agent 工具调用 | `{ type: "tool", tool: "bash", state: { input, output, error } }` |
| `file` | 文件附件 | `{ type: "file", url: "file://...", filename, mime }` |
| `step-start` | 步骤分隔符 | `{ type: "step-start" }` |

---

## 三、Layer 2: OpenWork Server 代理层

### 3.1 数据路由

前端不直接访问 OpenCode SQLite，所有读写通过 OpenWork Server 代理：

```
前端 fetch("/w/:id/sessions/:sid/messages")
  → Server: fetchOpencodeJson(config, workspace, "/session/<sid>/message")
    → OpenCode: GET /session/<sid>/message (from .tron/tron.db)
    → JSON response
  → Server: buildSessionMessages(json) → Zod 验证
  → 前端: UIMessage[]
```

### 3.2 Zod 验证读模型

`apps/server/src/session-read-model.ts` — 所有从 OpenCode 返回的数据经过 Zod schema 严格验证：

```typescript
// 消息结构
const sessionMessageInfoSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.string(),          // "user" | "assistant" | "system"
  parentID: z.string().nullish(),
  time: sessionTimeSchema.optional(),
});

const sessionPartSchema = z.object({
  id: z.string(),
  messageID: z.string(),
  sessionID: z.string(),
}).passthrough();  // 额外字段保留

const sessionMessageSchema = z.object({
  info: sessionMessageInfoSchema,
  parts: z.array(sessionPartSchema),
}).passthrough();
```

验证失败 → `ApiError(502, "opencode_invalid_response")` — 防止数据损坏传播到前端。

### 3.3 Snapshot 并行加载

`readWorkspaceSessionSnapshot()` 使用 **4 路并行请求** (`Promise.all`):

```typescript
const [session, messages, todos, statuses] = await Promise.all([
  fetchOpencodeJson(..., "/session/<id>"),         // 会话元数据
  fetchOpencodeJson(..., "/session/<id>/message"), // 消息列表
  fetchOpencodeJson(..., "/session/<id>/todo"),    // 待办事项
  fetchOpencodeJson(..., "/session/status"),       // 所有会话状态
]);
return buildSessionSnapshot({ session, messages, todos, statuses });
```

**默认消息限制**: `limit: 140` 条 (来自前端 `session-surface.tsx` 第 287 行)。

---

## 四、Layer 3: React Query 内存缓存

### 4.1 缓存键体系

```typescript
// session-sync.ts
transcriptKey(workspaceId, sessionId)
  = ["react-session-transcript", workspaceId, sessionId]
    → 存储: UIMessage[] (当前会话的完整消息列表)

statusKey(workspaceId, sessionId)
  = ["react-session-status", workspaceId, sessionId]
    → 存储: SessionStatusReadModel

todoKey(workspaceId, sessionId)
  = ["react-session-todos", workspaceId, sessionId]
    → 存储: Todo[]

permissionKey(workspaceId, sessionId)
  = ["react-session-permissions", workspaceId, sessionId]
    → 存储: PendingPermission[]
```

### 4.2 初始加载流程

当用户打开一个会话时：

```
① session-surface.tsx 触发 useQuery<OpenworkSessionSnapshot>
   queryFn: client.getSessionSnapshot(workspaceId, sessionId, { limit: 140 })
   → Server: GET /workspace/:id/sessions/:sid/snapshot
   → OpenCode: 4 路并行查询
   staleTime: 500ms

② useEffect 检测 currentSnapshot 变化
   → seedSessionState(workspaceId, currentSnapshot)
     → snapshotToUIMessages(snapshot) // 将 server 格式转 UIMessage[]
     → mergeSnapshotIntoCachedMessages(incoming, existing)
       // 如果缓存中有更新的流数据，不覆盖
     → queryClient.setQueryData(transcriptKey, merged)
```

### 4.3 Snapshot + 流式增量合并策略

**这是最关键的设计** —— 同时使用两个数据源并智能合并：

| 数据源 | 何时写入 | 写入方式 |
|---|---|---|
| **Server Snapshot** (HTTP) | 打开会话时 + 每 500ms | `useQuery` → `queryClient.setQueryData` (全量替换) |
| **SSE 事件流** | 实时推送 | `event.subscribe()` → `queryClient.setQueryData` (增量追加) |

**合并逻辑** (`message-merge.ts`):

```typescript
export function mergeSnapshotIntoCachedMessages(
  snapshotMessages: UIMessage[],   // 来自 server API
  cachedMessages: UIMessage[],     // 来自 SSE 增量
) {
  // ① 以更长的列表作为主序
  const useCachedOrder = cachedMessages.length > snapshotMessages.length;
  
  // ② 逐消息合并:
  //   - snapshot 的消息: 结构正确(time/title)
  //   - cache 的文本: 更长(流式累积了更多 token)
  //   如果 cache 中的 text > snapshot 的 text, 保留 cache 版本
  for (const message of merged) {
    const snapshot = snapshotById.get(message.id);
    const cached = cachedById.get(message.id);
    if (snapshot && cached) {
      // 逐 part 比较文本长度, 保留更长的(流式实时数据)
      message.parts = mergeMessageParts(snapshot, cached);
    }
  }
}
```

这个设计解决了 **快照轮询与流式推送的竞态问题** — 如果快照在流式推送中间到达，不会覆盖已累积的流式文本。

---

## 五、Layer 4: SSE 流式推送

### 5.1 订阅生命周期

```
ReactSessionRuntime 组件挂载
  → ensureWorkspaceSessionSync({ workspaceId, baseUrl, token })
    → 创建 SSE 连接到 OpenCode /event 端点
    → ref-counted (多会话共享一个 SSE 连接)

  → trackWorkspaceSessionSync(opts, sessionId)
    → 注册此 sessionId 为"被追踪会话"
    → SSE 事件按 sessionId 过滤分发
```

**引用计数机制**:
```typescript
const syncs = new Map<string, SyncEntry>();  // 全局单例

// 同一工作区的所有会话共享一个 SSE 连接
// refs 计数达到 0 时才断开连接
```

### 5.2 事件类型处理

| SSE 事件 | 写入的 React Query Key | 操作 |
|---|---|---|
| `message.updated` | `transcriptKey` | `upsertMessage()` — 添加新消息壳 |
| `message.part.updated` | `transcriptKey` | `upsertPart()` — 添加/更新 part |
| `message.part.delta` | `transcriptKey` | **缓冲**, requestAnimationFrame 批量 flush |
| `session.status` | `statusKey` | `setQueryData(status)` |
| `session.idle` | `statusKey` | `setQueryData({ type: "idle" })` |
| `todo.updated` | `todoKey` | `setQueryData(todos)` |
| `permission.asked` | `permissionKey` | `setQueryData(append permission)` |
| `permission.replied` | `permissionKey` | `setQueryData(remove permission)` |

### 5.3 Delta 批处理机制

**这是性能关键** —— 避免每个 token 触发一次完整 React 重渲染：

```
SSE 推送 token: "hello" " " "world" "!" (4 个 delta 事件)
  │
  ├─ 每个 delta 存入 deltaFlushBuffer[]
  ├─ scheduleDeltaFlush()
  │   └─ window.requestAnimationFrame(() => flushDeltas())
  │       // 在下一帧统一处理所有 token
  │
  ▼
flushDeltas():
  ① 按 sessionId 分组所有待处理 delta
  ② 对每个 session, 一次 setQueryData 调用完成所有 token 追加
  ③ appendDelta() 使用 O(1) 消息查找 (按索引, 不遍历)
```

**代码注释** (session-sync.ts 第 33-35 行):
```
// Coalesce rapid-fire delta events from the SSE stream into one cache
// commit per animation frame. Without this, a long response produces a
// setQueryData per token; each triggers a full transcript re-render
// (~27ms on large sessions) which starves the main thread.
```

### 5.4 消息 stub 角色推断

当 `message.part.delta` 比 `message.updated` 先到达时（竞态）：

```typescript
// 根据对话交替模式推断角色
function inferStubRole(messages: UIMessage[]): UIMessage["role"] {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return "user";           // 第一条总是用户
  if (lastMessage.role === "user") return "assistant";    // 交替
  if (lastMessage.role === "assistant") return "user";    // 交替
  return "assistant";
}
```

等真正的 `message.updated` 到达后，角色会被正确覆盖。

---

## 六、Layer 5: localStorage 会话记忆

### 6.1 存储内容

```typescript
// session-memory.ts
ACTIVE_WORKSPACE_KEY = "openwork.react.activeWorkspace"
  → 值: workspaceId (string)
  → 作用: 记住最后活跃的工作区

SESSION_BY_WORKSPACE_KEY = "openwork.react.sessionByWorkspace"
  → 值: { [workspaceId]: sessionId } (JSON)
  → 作用: 每个工作区记住最后打开的会话
```

### 6.2 示例

```json
{
  "ws_abc123": "session_456",
  "ws_def456": "session_789"
}
```

### 6.3 注意

- **不存储消息内容** — 仅存储 sessionId 引用
- 启动时用于导航恢复：切换工作区 → 自动打开上一次的会话
- 消息数据由 React Query Cache 在内存中重建（通过 server snapshot 请求 + SSE）

---

## 七、完整数据流

```
用户打开会话 "session_456"
  │
  ├─ ① session-surface.tsx: useQuery<Snapshot>(queryKey, queryFn)
  │     → client.getSessionSnapshot(workspaceId, "session_456", { limit: 140 })
  │       → GET /w/ws_abc/sessions/session_456/snapshot?limit=140
  │         → Server: 4 路 Promise.all([
  │             OpenCode: GET /session/session_456
  │             OpenCode: GET /session/session_456/message
  │             OpenCode: GET /session/session_456/todo
  │             OpenCode: GET /session/status
  │           ])
  │         → Zod 验证 → JSON response
  │     → snapshotToUIMessages() → UIMessage[]
  │     → mergeSnapshotIntoCachedMessages(snapshot, cached)
  │     → queryClient.setQueryData(transcriptKey, merged)
  │
  ├─ ② 组件渲染: useSharedQueryState(transcriptKey) → UIMessage[] → 渲染气泡
  │
  ├─ ③ ReactSessionRuntime 挂载
  │     → ensureWorkspaceSessionSync(workspaceId)
  │       → SSE connect: client.event.subscribe()
  │     → trackWorkspaceSessionSync(workspaceId, "session_456")
  │
  ├─ ④ 用户输入 prompt
  │
  ├─ ⑤ SSE 事件到达
  │     message.updated    → upsertMessage()
  │     message.part.delta → rAF 批量 flush (每帧一次 setQueryData)
  │     session.idle       → setQueryData({ type: "idle" })
  │
  ├─ ⑥ 每 500ms (staleTime)
  │     useQuery 自动 refetch snapshot (后台更新 meta 数据)
  │     → mergeSnapshotIntoCachedMessages() 保护不覆盖流式文本
  │
  └─ ⑦ 用户切换到另一个工作区
        → releaseWorkspaceSessionSync() → 旧 SSE 断开
        → 新工作区的 ensureWorkspaceSessionSync() → 新 SSE 连接
        → 旧工作区的 transcriptKey 数据仍保留在 React Query Cache
```

---

## 八、关键性能策略汇总

| 策略 | 实现 | 目的 |
|---|---|---|
| **Snapshot + SSE 双源合并** | `mergeSnapshotIntoCachedMessages` | snapshot 提供结构正确性, SSE 提供实时性 |
| **rAF 批量 flush** | `requestAnimationFrame` 合并 delta | 每帧一次 setQueryData, 60fps 渲染 |
| **O(1) 消息查找** | 直接索引而非 map/map | `findIndex` 单次遍历, 不克隆整个列表 |
| **tail staleness** | staleTime 500ms | 后台静默更新 meta 数据 |
| **Initial snapshot limit** | 140 条消息 | 平衡冷启动速度与上下文长度 |
| **Zod 验证网关** | 服务端严格 schema | 防止损坏数据污染前端缓存 |
| **SSE 引用计数** | `SyncEntry.refs` | 同工作区多会话共享一个 SSE 连接 |
| **角色推断** | `inferStubRole` | 处理 delta 比 message.updated 先到的竞态 |
| **localStorage 仅存 ID** | sessionId 映射 | 最小化存储开销 |

---

## 九、关键代码索引

| 关注点 | 文件 | 行号 |
|---|---|---|
| OpenCode Session SQLite 结构 | OpenCode 引擎内部 (`.tron/tron.db`) | — |
| Session 读模型 (Zod) | `apps/server/src/session-read-model.ts` | 1-141 |
| Server 会话路由 | `apps/server/src/server.ts` | 3011-3110 |
| Server Snapshot 并行加载 | 同上 | 3087-3110 |
| Server → OpenCode HTTP proxy | 同上 | 420-483 |
| React Query 缓存键定义 | `react-app/domains/session/sync/session-sync.ts` | 43-50 |
| Snapshot 初始加载 | `react-app/domains/session/surface/session-surface.tsx` | 273-291 |
| seedSessionState | `react-app/domains/session/sync/session-sync.ts` | 575-594 |
| SSE 事件订阅 + delta 批处理 | 同上 | 494-535, 422-492 |
| Snapshot-Cache 合并 | `react-app/domains/session/sync/message-merge.ts` | 1-89 |
| UIMessage 转换 (snapshot) | `react-app/domains/session/sync/usechat-adapter.ts` | 84-126 |
| localStorage 会话记忆 | `react-app/shell/session-memory.ts` | 1-94 |
| ReactSessionRuntime 挂载 | `react-app/domains/session/sync/runtime-sync.tsx` | 1-34 |
| Part 类型映射 (SSE → UI) | `react-app/domains/session/sync/session-sync.ts` | 112-174 |
