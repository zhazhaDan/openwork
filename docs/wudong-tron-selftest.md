# Tron adapter self-test

当前产物是独立适配分支的 macOS ARM64 Server 测试版，尚未复制到悟东主项目。
Server 自身版本显示 `0.0.0-dev`；Tron 版本请看引擎状态接口。

## 是否需要重新安装依赖

这次修改没有更改 `package.json` 或 `pnpm-lock.yaml`。当前工作目录已经安装依赖，
不需要重新执行 `pnpm install`。只有首次使用新检出目录或缺少依赖时才需要安装。
在悟东主项目执行 `pnpm install` 不会编译、更新这里的 Server。

## 快速回归

在适配仓库根目录运行，将引擎路径换成启动配置实际使用的 Tron 0.5.1 可执行文件：

```sh
cd /Users/mac/Desktop/yantronic/code/wudong-work/openWork-fork-tron-adapter
OPENWORK_TEST_TRON="/你的Tron可执行文件绝对路径" \
  pnpm --filter openwork-server exec bun --conditions=development test test/local-tron.test.ts
```

预期 `2 pass / 0 fail`，原生测试不能显示为跳过。测试使用临时目录，覆盖配置传入的
引擎路径、工作目录、会话创建与读取、退出清理。此命令运行源码测试。

## 手动运行已编译的 Server

产物是 `apps/server/dist/bin/openwork-server`，插件在
`apps/server/dist/opencode-plugins/`。二进制启动时也需要这个插件目录，
因此当前自测请保留整个 `apps/server/dist`。

终端一运行下列命令。`OPENWORK_OPENCODE_BIN` 沿用原有启动配置字段，值填 Tron
可执行文件路径；这里的名字不表示启动 OpenCode。测试状态全部放在临时目录。

```sh
cd /Users/mac/Desktop/yantronic/code/wudong-work/openWork-fork-tron-adapter
TRON_SELFTEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/wudong-tron-selftest.XXXXXX")
mkdir -p "$TRON_SELFTEST_DIR/workspace" "$TRON_SELFTEST_DIR/engine-cwd"

OPENWORK_MANAGE_OPENCODE=1 \
OPENWORK_OPENCODE_BIN="/你的Tron可执行文件绝对路径" \
OPENWORK_MANAGED_OPENCODE_CWD="$TRON_SELFTEST_DIR/engine-cwd" \
OPENWORK_EXTENSIONS_PLUGIN_DIR="$PWD/apps/server/dist/opencode-plugins" \
OPENWORK_RUNTIME_DB="$TRON_SELFTEST_DIR/runtime.sqlite" \
TRON_DB="$TRON_SELFTEST_DIR/tron.db" \
XDG_CONFIG_HOME="$TRON_SELFTEST_DIR/config" \
XDG_DATA_HOME="$TRON_SELFTEST_DIR/data" \
XDG_CACHE_HOME="$TRON_SELFTEST_DIR/cache" \
XDG_STATE_HOME="$TRON_SELFTEST_DIR/state" \
./apps/server/dist/bin/openwork-server \
  --host 127.0.0.1 --port 18787 \
  --config "$TRON_SELFTEST_DIR/server.json" \
  --workspace "$TRON_SELFTEST_DIR/workspace" \
  --token tron-selftest-client --host-token tron-selftest-host
```

终端二检查状态：

```sh
curl --fail-with-body -sS \
  -H 'Authorization: Bearer tron-selftest-client' \
  http://127.0.0.1:18787/experimental/engine-v2-preview/status
```

预期返回 `running: true`、`chatRouting: true`、`version: "0.5.1"` 和引擎 `pid`。
若端口已经占用，请以启动日志中的实际端口为准。

下面的命令在临时工作区创建并读取会话，成功后输出会话 ID：

```sh
node --input-type=module <<'JS'
const base = "http://127.0.0.1:18787";
const headers = {
  authorization: "Bearer tron-selftest-client",
  "content-type": "application/json",
};
async function request(path, body) {
  const response = await fetch(base + path, {
    headers,
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}
const { items } = await request("/workspaces");
const workspace = items[0];
const mount = `/workspace/${encodeURIComponent(workspace.id)}/opencode2/api`;
const created = await request(`${mount}/session`, { location: { directory: workspace.path } });
const read = await request(`${mount}/session/${encodeURIComponent(created.data.id)}`);
if (read.data.id !== created.data.id) throw new Error("会话读取结果不一致");
console.log("会话创建、读取通过：", read.data.id);
JS
```

测试结束后在终端一按 Ctrl+C。引擎子进程应随 Server 一起退出；可以用状态接口
返回的 PID 执行 `ps -p <pid> -o pid=,command=`，预期查不到进程。

## 重新编译

后续修改源码后，在适配仓库根目录运行：

```sh
pnpm --filter openwork-server build
pnpm --filter openwork-server build:bin
```

第一条生成 JS 和插件，第二条生成本机平台二进制。

## 悟东开发实例

主项目已接入本分支的 Server：主进程只启动 Server，将原有配置解析出的
Tron 路径和工作目录通过 `OPENWORK_OPENCODE_BIN`、
`OPENWORK_MANAGED_OPENCODE_CWD` 传入。Server 管理唯一的 Tron 子进程，
不启动 router。插件目录随 Server 一起打包。

在悟东主项目根目录重新构建资源：

```sh
./scripts/build-sidecars.sh
pnpm dev
```

默认源码目录是同级 `openWork-fork-tron-adapter`；需要改用其他已适配源码时设置
`OPENWORK_SERVER_SOURCE`。不要从旧 fork 直接覆盖 Server。
无需因为源码修改重新执行 `pnpm install`。

原有 `/workspace/:id/sessions` 和 `/w/:id/opencode/*` 由 Server 转换到原生接口。
消息、工具和权限的数据转换复用上游客户端，构建时生成 Server 专用传输版本。
全局事件保留 `{directory,payload}`，执行开始/结束转换为悟东的
`session.status`、`session.idle`，失败另外发出 `session.error`。

自动测试覆盖自定义引擎路径/cwd、会话列表/快照、鉴权、事件连接、临时模型服务的
实际推理和流式消息、结束事件、子进程退出。模型服务和所有测试数据位于临时目录，
不使用用户的模型额度，不改写 OpenCode 历史库。

开发实例另行核对侧栏加载成功、全局事件保持连接、Tron 版本及父子进程关系。
未支持的旧操作返回明确的 `501 tron_operation_unavailable`；这不是完整接口回归
或正式跨平台发行验收。Provider OAuth、旧 auth 写入、retry、diff 等接口仍需要
后续按原生能力逐项适配。
