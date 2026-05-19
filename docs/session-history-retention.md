# 会话历史保留策略分析

> 基于 `different-ai/openwork` dev 分支最新代码。
> 覆盖：消息加载上限、Snapshot limit、自动/手动 compact、OpenCode DB 实际存储策略。

---

## 一、结论先行

**会话历史全量保留在 OpenCode SQLite 数据库中，从不删除。** 但前端加载和展示有明确的上限策略：

| 层面 | 保留策略 | 加载策略 |
|---|---|---|
| OpenCode DB (真值源) | **全量保留** — 所有消息永久存储 | OpenCode API 默认返回所有消息 |
| Server Snapshot | **全量拉取** — 但前端传 `limit=140` | 只接收最近 140 条 |
| React Query Cache | **内存缓存** — 组件卸载后丢弃 | 只缓存当前加载的 140 条 |
| localStorage | 仅存 sessionId 引用 | 不存消息内容 |

**设计意图**：全量保留是为了不丢数据，加载限制是为了性能。用户通过 `/compact` 命令主动压缩上下文，或通过 OpenCode 的 `compaction.auto` 配置启用自动压缩。

---

## 二、加载策略：只加载最近 140 条

### 2.1 Snapshot limit

```typescript
// session-surface.tsx 第 285-287 行
const snapshotQuery = useQuery<OpenworkSessionSnapshot>({
  queryKey: snapshotQueryKey,
  queryFn: async () => (
    await props.client.getSessionSnapshot(
      props.workspaceId, props.sessionId, { limit: 140 }  // ← 140 条
    )
  ).item,
  staleTime: 500,
});
```

### 2.2 Server 层传递 limit

```
前端: GET /w/:id/sessions/:sid/snapshot?limit=140
  → Server: fetchOpencodeJson(..., "/session/<sid>/message", { query: { limit: 140 } })
    → OpenCode: GET /session/<sid>/message?limit=140
      → 返回最近 140 条消息
```

### 2.3 为什么是 140？

这是**性能与可用性的平衡点**：

| 考虑 | 影响 |
|---|---|
| 140 条消息通常覆盖很长一段对话 | 一次加载足够上下文给 LLM |
| 首次渲染 140 条 bubble ~30ms | 在 60fps 预算内 |
| 网络传输 JS bundle 200KB | 140 条 JSON 消息通常 50-100KB |
| SSE 事件会增量追加 | 新消息不受 140 限制 |

### 2.4 会话列表 (侧边栏) load limit

```typescript
// session-route.tsx 第 457 行 — 后台加载会话列表
const response = await openworkClient.listSessions(workspace.id, { limit: 200 });
```

侧边栏最多加载 **200 个会话**的元数据（不包含消息内容，仅 title/id/time）。

---

## 三、没有 "加载更早消息" 功能

### 3.1 当前代码中不存在以下机制

- ❌ 没有 "Load earlier messages" 按钮
- ❌ 没有 `beforeId` 或 `start` 参数的分页 UI
- ❌ 没有滚动到顶触发加载的 Intersection Observer
- ❌ 消息列表没有虚拟滚动（全部渲染在 DOM 中）

### 3.2 代码验证

搜索 `loadBefore`、`loadEarlier`、`olderMessage`、`beforeId`、`previousMessage` 等关键词在整个 `react-app/domains/session/` 目录均无结果。

### 3.3 设计逻辑

这是一个**有意为之的简化**：

```
越早的消息 → 上下文价值越低 → 不需要单独 UI 翻看
全量数据 → 存在 OpenCode DB → 由 LLM 通过 compact 机制消费
用户要看的 → 最近 140 条 → 足够覆盖当前对话
```

---

## 四、OpenCode DB：全量保留，永不删除

### 4.1 存储方式

```
.tron/tron.db  (SQLite, WAL 模式)
├── sessions:  id, title, slug, parentID, directory, time, summary
├── messages:  id, sessionID, role, parentID, time
├── parts:     id, messageID, sessionID, type("text"|"reasoning"|"tool"|...)
└── ...
```

所有消息**永久保留**在 SQLite 中。OpenWork 没有代码去删除旧消息。

### 4.2 为什么不删

1. **LLM 上下文窗口是消费端问题**，不是存储端问题 — 删 DB 记录会影响未来如果上下文窗口扩大的回溯能力
2. **Compact 机制解决消费问题** — 压缩旧消息为摘要，DB 原数据不丢
3. **用户自有文件** — 用户可以随时删除 `.tron/tron.db` 重建

---

## 五、Compact 机制：上下文窗口管理

### 5.1 手动 Compact (`/compact`)

用户输入 `/compact` 或在 Composer 中选择 `Commands → /compact`：

```
用户触发
  → sessionActions.sendPrompt({ command: "compact" })
    → compactCurrentSession(sessionID)
      → opencodeClient.session.summarize({ sessionID, providerID, modelID })
        → OpenCode 将历史消息压缩为摘要
        → 后续请求的上下文窗口减小
```

**实现** (`actions-store.ts` 第 640-684 行):

```typescript
async function compactCurrentSession(sessionIdOverride?: string) {
  const sessionID = sessionIdOverride ?? options.selectedSessionId();
  if (!sessionID) throw new Error("No session ID");
  if (!options.messages().length) throw new Error("Empty session");

  const model = options.selectedSessionModel();
  await compactSessionTyped(c, sessionID, model, {
    directory: options.runtimeWorkspaceRoot() || options.selectedWorkspaceRoot() || undefined,
  });
}
```

### 5.2 自动 Compact (`compaction.auto`)

在 Settings → General 中有开关：

```
"settings.auto_compact" = "Auto context compaction"
"settings.auto_compact_desc" = "Controls OpenCode compaction.auto for this workspace."
```

这是 **OpenCode 内置的自动压缩机制**，OpenWork 只是暴露配置开关。当启用时：

1. OpenCode 监控当前会话的 token 使用量
2. 接近上下文窗口上限时自动触发 summarization
3. 将早期消息压缩为摘要嵌入上下文

**关键 i18n key**（仅 Solid shell 有使用）:
```
"session.compacting_auto": "OpenCode is auto-compacting this session"
```
在 React shell 中尚未渲染此状态，但 OpenCode 引擎的自动 compact 行为仍然生效。

### 5.3 Compact 不删数据

**重要**：Compact 是**上下文压缩**，不是数据删除：
- 原始消息在 OpenCode DB 中**完整保留**
- Compact 生成一个**摘要嵌入**到后续对话中
- 前端仍可以看到完整的历史（通过 snapshot 加载）

---

## 六、多工作区切换时的缓存清理

```typescript
// session-sync.ts 第 560-573 行
function releaseWorkspaceSessionSync(input: SyncOptions) {
  existing.refs -= 1;
  if (existing.refs > 0) return;

  // 立即断开 SSE 连接，不延迟
  existing.dispose();
  syncs.delete(key);
}
```

React Query Cache 中的数据**不会**在工作区切换时清理：
- `transcriptKey` 数据保留在内存
- 只有 SSE 连接断开
- 下次切回来时，cache 可能仍有旧数据，但会通过 snapshot refetch 覆盖

---

## 七、总结

```
┌─────────────────────────────────────────────────────────────┐
│                    会话历史保留策略总结                       │
├─────────────┬───────────────────────────┬───────────────────┤
│ 维度         │ 策略                      │ 实现               │
├─────────────┼───────────────────────────┼───────────────────┤
│ OpenCode DB │ 全量永久保留               │ SQLite 无限存储    │
│ 前端加载     │ 最近 140 条               │ snapshot limit=140│
│ 更早消息     │ 不可见 (无分页 UI)         │ 有意无实现         │
│ 上下文窗口   │ Compact 压缩 (手动+自动)    │ `/compact` + 设置 │
│ 会话列表     │ 最近 200 个会话            │ listSessions limit│
│ 内存缓存     │ 组件卸载即丢               │ React Query Cache │
│ localStorage│ 仅存 sessionId 引用        │ 不存消息内容       │
│ 工作区切换   │ SSE 断开, Cache 保留      │ ref-counted sync  │
└─────────────┴───────────────────────────┴───────────────────┘
```

**核心哲学**：全量保留在 DB、按需加载到前端、Compact 管理上下文窗口、永不分页查看历史。
