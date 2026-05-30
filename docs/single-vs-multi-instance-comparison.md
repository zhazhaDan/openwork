# 单实例 vs 多实例架构对比

> 基于 `different-ai/openwork` 当前架构（Managed Mode：单个 OpenCode Server 进程 + 多 Workspace 共享）
> 分析如果改为每组 Workspace 独立 OpenCode 进程的优劣势。

---

## 一、当前架构（单实例）

```
┌──────────────────────────────────────────────────┐
│  OpenWork Server (Bun, PID=1)                    │
│                                                  │
│  managed_opencode = spawn("opencode serve")      │
│  PID=2, port=os-random                           │
│                                                  │
│  /w/ws_A/opencode/* ────┐                       │
│  /w/ws_B/opencode/* ────┤                       │
│  /w/ws_C/opencode/* ────┤                       │
│                          ▼                       │
│            x-opencode-directory header            │
│            ┌──────────────────────────────┐      │
│            │  OpenCode Server (PID=2)     │      │
│            │  - multi-tenant by design    │      │
│            │  - per-directory DB isolation │      │
│            │  - shared process, thread, GC │      │
│            └──────────────────────────────┘      │
└──────────────────────────────────────────────────┘
```

---

## 二、多实例架构（假设）

```
┌──────────────────────────────────────────────────────────┐
│  OpenWork Server (Bun, PID=1)                            │
│                                                          │
│  managed_opencodes = new Map()                            │
│                                                          │
│  ws_A: spawn("opencode serve", { cwd: /path/A })        │
│         PID=2, port=49301                                │
│  ws_B: spawn("opencode serve", { cwd: /path/B })        │
│         PID=3, port=49302                                │
│  ws_C: spawn("opencode serve", { cwd: /path/C })        │
│         PID=4, port=49303                                │
│                                                          │
│  /w/ws_A/opencode/* ──→ http://127.0.0.1:49301          │
│  /w/ws_B/opencode/* ──→ http://127.0.0.1:49302          │
│  /w/ws_C/opencode/* ──→ http://127.0.0.1:49303          │
└──────────────────────────────────────────────────────────┘
```

---

## 三、维度对比

### 3.1 资源消耗

| 维度 | 单实例 | 多实例 | 影响 |
|---|---|---|---|
| **内存** | 1× OpenCode heap (~200-400MB) | N× OpenCode heap (N×200-400MB) | 3 workspace = 600MB vs 1200MB |
| **CPU** | 1× event loop, shared across workspaces | N× event loops, 1 per workspace | 空闲 workspace 也会占用 CPU ticks |
| **进程数** | Server + 1 = 2 进程 | Server + N = N+1 进程 | macOS 进程创建开销 ~50ms/ea |
| **端口** | Server + 1 = 2 端口 | Server + N = N+1 端口 | 当前范围 48000-51000 有 3001 个，充足 |
| **文件描述符** | ~50 fd total | N×~50 fd total | 主要影响是 SQLite WAL 连接池 |
| **磁盘** | N 个独立 `.tron/tron.db` (单实例也一样) | 相同 | 无差异，配置隔离不依赖进程数 |

**结论**：多实例内存开销大，3 个 workspace ~600MB 额外。对小内存设备（8GB MacBook Air）有压力。

### 3.2 故障隔离

| 场景 | 单实例 | 多实例 |
|---|---|---|
| **OpenCode 崩溃 (OOM)** | ❌ 所有 workspace 会话丢失 | ✅ 只有问题 workspace 受影响 |
| **某 workspace 的死循环** | ❌ 阻塞所有 workspace | ✅ 只阻塞问题 workspace |
| **某 workspace SQLite 损坏** | ⚠️ 可能触发进程级 panic | ✅ 隔离 |
| **OpenCode bug (segfault)** | ❌ 全灭 | ✅ 单 workspace 恢复 |
| **内存泄漏** | ❌ 影响所有 | ✅ 只泄漏问题进程 |
| **Server 崩溃** | ❌ 全灭 (但无差异) | ❌ 全灭 (Server 是单点) |

**结论**：多实例在故障隔离上明显优于单实例。但 Server 层仍是单点（需要监控+自动重启）。

### 3.3 启动与生命周期

| 操作 | 单实例 | 多实例 |
|---|---|---|
| **首次启动 (3 workspace)** | 1 spawn + 1 health check ≈ 2-3s | 3 spawn + 3 health check (串行) ≈ 5-8s |
| **添加新 workspace** | 0 spawn (直接复用) ≈ 0ms | 1 spawn + 1 health check ≈ 2s |
| **删除 workspace** | 0 kill ≈ 0ms | 1 kill ≈ 100ms |
| **Reload engine (单个)** | `POST /instance/dispose?directory=A` | kill + spawn 该 workspace 进程 ≈ 3s |
| **Reload engine (全部)** | `POST /instance/dispose` (单次) | 逐一 kill + spawn 所有 N 个 |
| **健康检查** | 1 次 HTTP request | N 次 HTTP request |

**结论**：单实例启动和 reload 更快。多实例的 "添加新 workspace" 必须等待进程就绪，延迟 2-3s。

### 3.4 运维复杂度

| 维度 | 单实例 | 多实例 |
|---|---|---|
| **端口分配** | 1 个随机端口 | N 个端口，需要端口映射表 |
| **日志聚合** | 1 个 stdout/stderr 流 | N 个流，需要带标签区分 |
| **监控** | 1 个 PID 的健康状态 | N 个 PID，僵尸进程风险 |
| **升级 OpenCode** | 替换 binary → restart | N 个进程升级，需要灰度策略 |
| **调试** | 单一的 stdout/stderr | 需要确定是哪个 workspace 的进程 |
| **资源限制 (cgroups)** | 难以精确限制单 workspace | 天然支持 per-process cgroup |
| **配置文件冲突** | 不存在 (directory 隔离) | 不存在 (不同 process+cwd) |

**结论**：单实例运维简单粗暴。多实例需要进程编排能力（类似 Docker Compose 或 Kubernetes Pod）。

### 3.5 性能

| 场景 | 单实例 | 多实例 |
|---|---|---|
| **单 workspace 高负载** | ❌ 可能挤压其他 workspace | ✅ 独占 CPU/内存 |
| **并发请求 (3 workspace 同时)** | ⚠️ 共享 event loop，公平调度 | ✅ 真正的并行 (OS 调度) |
| **LLM API 连接池** | ✅ 共享连接，可复用 | ⚠️ 每个进程独立连接池 |
| **Provider 缓存 (JWT/Prompt)** | ✅ 进程内共享 | ❌ 跨进程无法共享 |
| **SQLite 写入锁** | N 个 DB 文件，无锁争用 | 相同 |
| **冷启动 (首次 llm call)** | 1× cold | N× cold |

**结论**：多实例在 CPU-bound 场景下并行优势明显（真正并行），但在 I/O-bound 场景（LLM 调用）下共享连接池更高效。

### 3.6 安全性

| 维度 | 单实例 | 多实例 |
|---|---|---|
| **进程级隔离** | ❌ 共享内存空间 | ✅ 完全隔离 |
| **凭证泄露** | ❌ 一个 workspace 可能访问另一个的 env | ✅ 独立环境变量 |
| **文件系统访问** | ⚠️ 同一个进程，依赖 OpenCode 内部校验 | ✅ OS 级 chroot 可能 |
| **侧信道攻击** | ⚠️ 内存共享 (理论上) | ✅ 进程边界不可逾越 |

**结论**：多实例安全隔离更彻底。适合多租户 SaaS 场景。

### 3.7 代码改动量

| 模块 | 单实例（当前） | 多实例需要的改动 |
|---|---|---|
| `managed-opencode.ts` | 单个 Map → 单次 spawn | Map<workspaceId, ManagedOpencodeServer> |
| `cli.ts` | 1 次 createManagedOpencodeServer | N 次，需要 per-workspace cwd |
| `server.ts` proxyOpencodeRequest | workspace.baseUrl (单 url) | workspace.baseUrl (已支持 per-ws url) ✅ |
| `reloadOpencodeEngine` | POST /instance/dispose?dir | kill + respawn per workspace |
| `startup/shutdown` | 1 kill | N kill + SIGKILL 超时控制 |
| 端口持久化 | 不需要 | 需要 per-workspace port 持久化 |
| Token 管理 | 1 组 Basic Auth | N 组 Basic Auth (或者统一) |
| 健康检查 | `wait_for_openwork_health` (Server) | 新增 per-workspace health |

**结论**：多实例改动量中等（~300-400 行新增），主要集中在进程管理。Server 层 API 基本不变（workspace.baseUrl 已支持 per-ws）。

---

## 四、适用场景矩阵

| 场景 | 推荐 | 原因 |
|---|---|---|
| **单用户桌面 App** (当前) | ✅ 单实例 | 资源受限，用户感知不到隔离 |
| **开发者同时 3-5 个项目** | ✅ 单实例 | 启动快，内存友好 |
| **团队共享 Server (10+ workspace)** | ⚠️ 多实例 | 故障隔离至关重要 |
| **SaaS 多租户** | ✅ 多实例 | 安全性 + 计费隔离 |
| **CI/CD agent runner** | ✅ 多实例 | 每次 job 独立进程，干净清理 |
| **长时间运行 agent (24h+)** | ⚠️ 多实例 | 内存泄漏不影响其他 workspace |
| **测试/开发环境** | ✅ 单实例 | 快速迭代 |
| **生产环境** | ✅ 多实例 | 可靠性优先 |
| **资源受限设备 (树莓派)** | ✅ 单实例 | 内存不足 |
| **高性能工作站 (64GB RAM)** | ➡️ 多实例 | 充分利用硬件 |

---

## 五、混合架构建议

折中方案：**惰性多实例** —— 按需 spawn，不预分配。

```
spawnOpencodeForWorkspace(ws):
  if hasRunningProcess(ws.id):
    return existing  // 复用
  if activeWorkspaceCount >= maxConcurrent:
    evictOldest()    // LRU 淘汰空闲 workspace 进程
  process = spawn("opencode serve", { cwd: ws.path, port: nextFreePort() })
  registry.set(ws.id, process)
  return process
```

**策略**：
- **活跃 workspace**（有活跃 session）：保持进程运行
- **空闲 workspace**（>5min 无请求）：SIGTERM 停止进程
- **LRU 上限**：最多 N 个并发进程（可配置，默认 4）
- **首次请求**：cold start 延迟 ~2s，后续请求无延迟

这样在单用户桌面场景下（通常 1 个活跃 workspace）表现为单实例，在团队共享场景下自动扩容。

---

## 六、总结

```
┌───────────────────┬──────────────────────┬──────────────────────┐
│ 维度               │ 单实例 (当前)         │ 多实例 (假设)         │
├───────────────────┼──────────────────────┼──────────────────────┤
│ 内存               │ ✅ 200-400MB         │ ❌ N×200-400MB       │
│ 故障隔离            │ ❌ 全灭               │ ✅ 独立隔离            │
│ 启动延迟            │ ✅ ~2s               │ ⚠️ ~2N s             │
│ 运维复杂度          │ ✅ 简单               │ ❌ 复杂               │
│ 并行性能            │ ⚠️ 共享 event loop   │ ✅ 真并行              │
│ 安全性              │ ⚠️ 进程内隔离         │ ✅ OS 级隔离           │
│ 代码改动量          │ ✅ 0 (当前)           │ ⚠️ ~300-400 行        │
│ LLM 连接池          │ ✅ 共享复用            │ ❌ N 个独立池          │
│ 适用场景            │ 桌面/小团队            │ SaaS/多租户/生产       │
└───────────────────┴──────────────────────┴──────────────────────┘
```

**当前选择的合理性**：OpenWork 定位为单用户桌面 App，单实例架构在内存、启动速度、运维复杂度上最优。多实例的优势（故障隔离、安全隔离）在桌面场景下价值有限，而过量内存消耗对用户体验是实际伤害。

**未来演进路径**：如果需要支持团队共享或 SaaS 场景，推荐 **惰性多实例** 混合方案，在不破坏当前桌面体验的前提下按需扩展。
