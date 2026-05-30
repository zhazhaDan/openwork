# Skills 与 Agents 在 Composer 中的展示与调用分析

> 基于 `different-ai/openwork` dev 分支最新代码。
> 分析范围：React 运行时 (`src/react-app/`) 的 Composer 组件。

---

## 一、总览：Composer 中四种扩展入口

```
┌─────────────────────────────────────────────────────────────┐
│  Composer 输入框                                             │
│                                                             │
│  [输入文本框 - LexicalPromptEditor]                          │
│                                                             │
│  @agentName   ← @mention (Agent + 文件)                     │
│  /skillName   ← /slash-command (Commands + Skills + MCP)    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  底部控制条                                                   │
│  📎 附件  🔌 工具菜单  │  默认Agent ▼  claude-sonnet ▼  Balanced ▼  │
│         ┌──────┐                                             │
│         │Commands│ ← Commands(命令)                          │
│         │Skills  │ ← Skills(技能), 从 Server API 加载         │
│         │MCPs    │ ← MCP 服务器状态(只读)                     │
│         │Plugin_X│ ← 云导入插件                               │
│         └──────┘                                             │
└─────────────────────────────────────────────────────────────┘
```

### 两种核心交互模式

| 触发方式 | 适用扩展 | 数据来源 | 选中后行为 |
|---|---|---|---|
| **`/` slash-command** | Commands + Skills | `client.command.list()` (OpenCode API) | 替换输入框为 `/commandName `, 然后发送 |
| **`@` mention** | Agents + 文件 | `client.app.agents()` + `client.find.files()` | 插入 `@agentName` 令牌到编辑器 |
| **🔌 工具菜单按钮** | Commands + Skills + MCP + 插件 | 同上 + `client.listMcp()`, `client.listSkills()` | 选中后同样变为 `/commandName ` |
| **Agent 下拉按钮** | Agents | `client.app.agents()` | 设置 `selectedAgent` 状态，发 prompt 时附带 |

---

## 二、`/` Slash-Command 机制

### 2.1 数据模型

```typescript
// src/app/types.ts 第 108 行
export type SlashCommandOption = {
  id: string;
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";  // 来源标注
};
```

### 2.2 数据源 — 从 OpenCode 加载

```
Composer 打开 → 检测 draft 输入 "/"
  → loadCommands()
    → listCommands(opencodeClient, workspaceRoot)
      → OpenCode API: POST /opencode/command/list
        → 返回 [{ name, description, source }] 列表
```

**`listCommands()`** (`src/app/lib/opencode-session.ts` 第 128 行):

```typescript
export async function listCommands(client: Client, directory?: string) {
  const result = await client.command.list({ directory });
  return result.data.map((cmd) => ({
    id: `cmd:${cmd.name}`,
    name: String(cmd.name),
    description: cmd.description ? String(cmd.description) : undefined,
    source: cmd.source,  // "command" | "mcp" | "skill"
  }));
}
```

**Actions-Store 包装** (`src/react-app/domains/session/sync/actions-store.ts` 第 836 行):

```typescript
async function listCommands() {
  const list = await listCommandsTyped(c, directory);
  return [BUILTIN_COMPACT_COMMAND, ...list];  // 总是追加内置 /compact
}
```

### 2.3 命名来源解析 — Commands vs Skills vs MCP

`source` 字段决定了命令属于哪个分类：

- `"command"` → 常规命令，来自 `.tron/commands/*.md` 文件
- `"skill"` → 技能命令，来自 `.tron/skills/*/SKILL.md` 文件
- `"mcp"` → MCP 暴露的工具（在 `/` 弹窗中标注，在工具菜单只读展示）
- 无 `source` 或 `"command"` → 归入 Commands 分类

**Skill 映射为 SlashCommand** 在 OpenCode 层完成 — 当 SKILL.md 文件包含 `trigger:` 或 `command:` 前导元数据时，OpenCode 将其注册为 `/skillname` 命令。

### 2.4 实时过滤与选中

```
输入 "/" → slashMatch = draft.match(/^\/(\S*)$/)
  → slashOpen = true
  → slashQuery = 当前输入的字符
  → slashFiltered = fuzzysort.go(slashQuery, commands, keys:["name","description"])
```

**选中后** (`applyCommandSelection`):

```typescript
const applyCommandSelection = (command: SlashCommandOption) => {
  props.onDraftChange(`/${command.name} `);  // 替换输入框内容
  setSlashOpen(false);
  setToolMenuOpen(false);
};
```

**最终发送时**，`draft.command` 被 ComposerDraft 携带：

```typescript
// src/app/types.ts 第 128 行
export type ComposerDraft = {
  command?: { name: string; arguments: string } | undefined;
  // ...
};
```

在 `session-route.tsx` 的 `onSendDraft` 中：

```typescript
if (draft.command) {
  const result = await opencodeClient.session.command({
    sessionID: selectedSessionId,
    command: draft.command.name,
    arguments: draft.command.arguments,
  });
}
```

### 2.5 可视化展示

```
┌─────────────────────────────────────────────┐
│  /⌨ 输入中                                   │
└─────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────┐
│  /compact  Compact session                  │
│  /summarize Summarize project               │
│  /test      Run tests            SKILL ◀── │
│  /review    Code review         SKILL ◀── │
│  /debug     Debug mode           MCP ◀─── │
└─────────────────────────────────────────────┘
                                              ↑ Skills 标签紫色
                                              ↑ MCP 标签青色
```

关键代码 (`composer.tsx` 第 806-811 行):

```typescript
{command.source && command.source !== "command" ? (
  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase
    ${command.source === "skill" ? "bg-violet-3/40 text-violet-11"
    : "bg-cyan-3/40 text-cyan-11"}`}>
    {command.source === "skill" ? "SKILL" : "MCP"}
  </span>
) : null}
```

---

## 三、`@` Mention 机制 (Agent + 文件)

### 3.1 触发与数据加载

```
输入 "@" → mentionMatch = draft.match(/@([^\s@]*)$/)
  → mentionOpen = true
  → mentionQuery = 当前输入的字符
  → 并行加载:
      props.listAgents()      → client.app.agents() → Agent[]
      props.searchFiles(q)   → client.find.files() → file paths
```

**数据合并** (`composer.tsx` 第 391-398 行):

```typescript
void Promise.all([props.listAgents(), props.searchFiles(mentionQuery)])
  .then(([agentList, files]) => {
    const next: MentionItem[] = [
      // Agent 列表
      ...agentList.map((agent) => ({
        id: `agent:${agent.name}`, kind: "agent",
        value: agent.name, label: agent.name
      })),
      // 最近文件 (前 8 个)
      ...recent.map((file) => ({ id: `file:${file}`, kind: "file", value: file, label: file })),
      // 搜索结果 (去重)
      ...files.filter((file) => !recent.includes(file))
        .map((file) => ({ id: `file:${file}`, kind: "file", value: file, label: file })),
    ];
    setMentionItems(next);
  });
```

### 3.2 Agent 筛选规则

```typescript
// session-route.tsx 第 1387 行
listAgents: async () => {
  const list = unwrap(await opencodeClient.app.agents());
  return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  // 排除隐藏的和 subagent 模式的 agent
},
```

### 3.3 可视化展示

```
┌─────────────────────────────────┐
│  @default   Default Agent       │
│  ⚡ @coder   Coding Assistant  │  Agent
│  ⚡ @writer  Writing Assistant │  Agent
│  📄 src/main.tsx               │  文件
│  📄 src/utils/helpers.ts       │  文件
└─────────────────────────────────┘
  Agent 用 ⚡ (Zap 图标)
  文件 用 📄 (FileText 图标)
```

### 3.4 选中后的最终处理

在 `session-route.tsx` 的 `onSendDraft` 中，`draftToParts` 函数将 `@agentName` 转换为 Agent 部分：

```typescript
for (const part of draft.parts) {
  if (part.type === "agent") {
    parts.push({ type: "agent", name: part.name });
    continue;
  }
  if (part.type === "file") {
    parts.push({ type: "file", url: `file://${absPath}`, ... });
  }
}
```

最终通过 `opencodeClient.session.promptAsync({ agent: selectedAgent, parts })` 发送。

---

## 四、Agent 下拉选择器 (Composer 下方)

这是一个**独立的按钮菜单**，与 `@` mention 不同：

```
[draft 输入框]
────────────────────────────────────────
 默认Agent ▼  claude-sonnet ▼  Balanced ▼
│         │                    │
│ default │ ← 无 Agent         │
│ Coder   │ ← Agent 列表       │
│ Writer  │                    │
└─────────┘
```

**状态管理**:

```typescript
const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
```

- 点击发送时，`selectedAgent` 被传递给 `promptAsync({ agent: selectedAgent })`
- 这是**全局 Agent 选择**，作用于整个会话的所有 prompt，直到用户切换

**与 @mention 的区别**:

| | @mention Agent | Agent 下拉选择器 |
|---|---|---|
| 作用范围 | 单次 prompt 的单个 part | 整个会话的默认 Agent |
| 发送格式 | `parts: [{type: "agent", name: "coder"}]` | `promptAsync({ agent: "coder" })` |
| 多个 Agent | 可以在同一 prompt 中 @ 多个 | 只能选一个 |

---

## 五、🔌 工具菜单 (+ 按钮)

### 5.1 菜单结构

点击 `+` 按钮弹出侧边栏式菜单：

```
┌─────────────────────────────────────────┐
│ Commands │  /compact         Compact   │
│ Skills   │  /test    Run tests   SKILL │
│ MCPs     │  /review  Review      SKILL │
│ Plugin_X │  /deploy  Deploy      MCP  │
│          │                            │
│          │  ┌────────────────────┐    │
│          │  │ 🔧 Configure      │    │
│          │  └────────────────────┘    │
└─────────────────────────────────────────┘
```

### 5.2 Skills 面板的数据加载

```typescript
// session-surface.tsx 第 671 行
const listSkills = async (): Promise<SkillCard[]> => {
  const response = await props.client.listSkills(props.workspaceId, { includeGlobal: true });
  // 调用 Server API: GET /workspace/:id/skills
  // 返回技能列表，包括工作区级和全局
  return response.items.map((skill) => ({
    name: skill.name,
    path: skill.path,
    description: skill.description,
    trigger: skill.trigger,
  }));
};
```

Skills 面板显示两类技能：

```typescript
// composer.tsx 第 1161-1163 行
// 合并两类来源:
// ① 已命令化的技能 (toolSkillItems = commands 中 source==="skill")
// ② 纯技能卡片 (skills 中还没有对应命令的)
[
  ...toolSkillItems,  // 已注册为 /cmd 的技能
  ...skills            // 未注册为命令的技能卡片
    .filter((skill) => !toolSkillItems.some((c) => c.name === skill.name))
    .map((skill) => ({ id: `skill:${skill.name}`, name: skill.name, ...source: "skill" }))
]
```

### 5.3 MCP 面板

MCP 面板是**只读的** — 展示服务器名称、URL/命令、连接状态：

```typescript
// session-surface.tsx 第 683 行
const listMcp = async () => {
  const response = await props.client.listMcp(props.workspaceId);
  // 还额外查询 OpenCode runtime 的 MCP 状态
  const statuses = unwrap(await opencodeClient.mcp.status({ directory: workspaceRoot }));
  return { servers, statuses, status };
};
```

状态显示：根据 `status` 字段渲染不同颜色的徽标。

### 5.4 插件面板

当用户通过云导入安装了插件时，显示在 Commands/Skills/MCPs 下方的分隔线之后：

```typescript
// 插件文件名解析为命令名
function pluginSlashCommandName(file: CloudImportedPluginFile) {
  if (file.objectType === "command") {
    // .opencode/commands/xxx.md → "xxx"
    return command?.trim() || null;
  }
  if (file.objectType === "skill") {
    // .opencode/skills/xxx/SKILL.md → "xxx"
    return skill?.trim() || null;
  }
}
```

选中插件文件 → 和选中普通命令一样调用 `applyCommandSelection`。

---

## 六、完整数据流链路

```
Skill/Agent 在 Composer 中的完整链路：

┌──────────────────────────────────────────────────────────────┐
│  数据来源层                                                   │
│                                                              │
│  OpenCode Engine                OpenWork Server              │
│  ┌─────────────────┐           ┌─────────────────────┐      │
│  │ command.list()   │──────────►│ /workspace/:id/     │      │
│  │ app.agents()     │   HTTP    │   commands,skills,  │      │
│  │ mcp.status()     │           │   mcp, plugins      │      │
│  │ find.files()     │           └─────────────────────┘      │
│  └─────────────────┘                                         │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  前端加载层                                                    │
│                                                              │
│  session-route.tsx / session-surface.tsx                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ listCommands → opencodeClient.session.command.list()   │  │
│  │ listAgents  → opencodeClient.app.agents()              │  │
│  │ listSkills  → client.listSkills(workspaceId)           │  │
│  │ listMcp     → client.listMcp(workspaceId)              │  │
│  │ searchFiles → opencodeClient.find.files()              │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  Composer 展示层 (composer.tsx)                               │
│                                                              │
│  输入检测 → regex 匹配 / 或 @ 或 点击按钮                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │ /弹出框       │  │ @弹出框       │  │ 🔌 工具菜单      │    │
│  │ SlashCommand │  │ Agent+文件   │  │ Commands/Skills │    │
│  │ fuzzysort    │  │ fuzzysort    │  │ MCPs/Plugins    │    │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘    │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  选中 → 应用层                                                 │
│                                                              │
│  applyCommandSelection(command):                             │
│    → 替换 draft 为 "/commandName "                           │
│    → 关闭弹窗                                                │
│                                                              │
│  onInsertMention(kind, value):                               │
│    → 在编辑器中插入 @agentName 或 @filePath 令牌              │
│    → 关闭 @弹窗                                              │
│                                                              │
│  onSelectAgent(agentName):                                   │
│    → 设置 selectedAgent 状态                                 │
│    → 关闭 Agent 下拉选择器                                   │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  发送 → 执行层 (session-route.tsx onSendDraft)               │
│                                                              │
│  if (draft.command):                                         │
│    opencodeClient.session.command({                          │
│      sessionID, command: draft.command.name,                 │
│      arguments: draft.command.arguments                      │
│    })                                                        │
│  else:                                                       │
│    opencodeClient.session.promptAsync({                      │
│      sessionID, parts: [textParts, agentParts, fileParts],   │
│      model, agent: selectedAgent, ...                        │
│    })                                                        │
└──────────────────────────────────────────────────────────────┘
```

---

## 七、关键代码索引

| 关注点 | 文件 | 行号 |
|---|---|---|
| Composer 主组件 | `react-app/domains/session/surface/composer/composer.tsx` | 246-1428 |
| `/` slash 检测 | 同上 | 288 |
| `@` mention 检测 | 同上 | 291-292 |
| slash 弹窗渲染 | 同上 | 774-827 |
| mention 弹窗渲染 | 同上 | 829-873 |
| 工具菜单渲染 | 同上 | 1090-1241 |
| Agent 下拉选择器 | 同上 | 1286-1347 |
| accept 选中结果 | 同上 | 592-608 |
| 键盘导航 (方向键+回车) | 同上 | 639-702 |
| Skills 数据加载 | `react-app/domains/session/surface/session-surface.tsx` | 671-681 |
| MCP 数据加载 | 同上 | 683-704 |
| Commands 数据加载 | `react-app/domains/session/sync/actions-store.ts` | 836-845 |
| listCommands 底层 | `app/lib/opencode-session.ts` | 128-145 |
| SlashCommandOption 类型 | `app/types.ts` | 108-113 |
| SkillCard 类型 | `app/types.ts` | 262-267 |
| ComposerDraft 类型 (含 command) | `app/types.ts` | 115-129 |
| Agent 发送参数 | `react-app/shell/session-route.tsx` | 1362-1369 |
| Command 发送逻辑 | 同上 | 1340-1349 |

---

## 八、关键架构决策

1. **Skills 有两种形态**: 已注册为 `/cmd` 的技能（来自 OpenCode `command.list()`）和纯技能卡片（来自 `listSkills()`）。Composer 合并显示两者。
2. **Agent 有两条进入路径**: `@mention`（单次 inline 指定）和底栏下拉选择器（全局默认 Agent），两者在发送时分别通过 `parts` 和 `agent` 参数传递给 OpenCode。
3. **Commands/Skills/MCP 共享同一个 `/` 前缀命名空间**，通过 `source` 字段区分来源，UI 用颜色徽标标注（紫色=Skill，青色=MCP）。
4. **MCP 面板是只读的** — 只展示状态，不提供点击触发（因为 MCP 工具由 OpenCode 自动决定是否调用，用户无需手动选择）。
5. **插件面板**通过文件路径解析生成斜杠命令名，与原生 Commands 共享同一套触发机制。
6. **所有数据延迟加载** — 只有在用户触发 `/` 或打开工具菜单时才请求 API，无预加载。
