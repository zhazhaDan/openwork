#!/usr/bin/env bash
# build-sidecars.sh
#
# 用 openWork-fork 当前源码重新编译 sidecar 二进制，把结果拷到 wudongPC/packages/main/resouces/。
#
# 编译产物：
#   - openwork-server          openwork 服务端
#   - opencode-router          消息路由（Telegram/Slack/Feishu/Mattermost）
#   - openwork-orchestrator    服务编排器（拉起前两个 + tron-ai）
#   - chrome-devtools-mcp      Chrome DevTools MCP shim
#
# 输入控制：
#   --target <triple>     编译目标 triple（默认本机），如 aarch64-apple-darwin
#                         也支持 OPENWORK_BUILD_TARGET 环境变量
#   --force               强制重新编译（即使现有二进制看起来正常）
#   --skip-clean          不清理临时构建目录（debug 用）
#   --no-versions         不更新 versions.json（仅拷二进制）
#
# 用法示例：
#   ./scripts/build-sidecars.sh                       # 默认本机 triple
#   ./scripts/build-sidecars.sh --force               # 强制重编
#   OPENWORK_BUILD_TARGET=aarch64-apple-darwin ./scripts/build-sidecars.sh
#
# 前置条件：
#   - 当前仓库根（wudong-work/）下存在 openWork-fork/ 子目录
#   - bun 已安装（router/server/orchestrator 用 bun build --compile）
#   - 系统已安装 codesign（macOS 需要给 sidecar 做 ad-hoc 签名）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WUDONG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_ROOT="$(cd "$WUDONG_ROOT/.." && pwd)"
FORK_ROOT="$WORK_ROOT/openWork-fork"
RESOUCES_DIR="$WUDONG_ROOT/packages/main/resouces"
BUILD_DIR="$FORK_ROOT/apps/desktop/src-tauri/sidecars"

# ---- 参数解析 --------------------------------------------------------------

FORCE=""
SKIP_CLEAN=""
UPDATE_VERSIONS="1"
TARGET="${OPENWORK_BUILD_TARGET:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"; shift 2 ;;
    --target=*)
      TARGET="${1#*=}"; shift ;;
    --force)
      FORCE="--force"; shift ;;
    --skip-clean)
      SKIP_CLEAN="1"; shift ;;
    --no-versions)
      UPDATE_VERSIONS=""; shift ;;
    -h|--help)
      sed -n '1,/^set -euo pipefail$/p' "$0" | sed -n '/^#/p'
      exit 0 ;;
    *)
      echo "未知参数: $1" >&2
      exit 1 ;;
  esac
done

# ---- 前置检查 --------------------------------------------------------------

[[ -d "$FORK_ROOT" ]] || { echo "找不到 openWork-fork: $FORK_ROOT" >&2; exit 1; }
[[ -d "$RESOUCES_DIR" ]] || { echo "找不到 wudongPC resouces 目录: $RESOUCES_DIR" >&2; exit 1; }
command -v bun >/dev/null || { echo "需要 bun，请先安装: https://bun.sh" >&2; exit 1; }

if [[ "$(uname -s)" == "Darwin" ]]; then
  command -v codesign >/dev/null || { echo "macOS 需要 codesign（来自 Xcode CLT）" >&2; exit 1; }
fi

# ---- 推导默认 target ------------------------------------------------------

if [[ -z "$TARGET" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  TARGET="aarch64-apple-darwin" ;;
    Darwin-x86_64) TARGET="x86_64-apple-darwin" ;;
    Linux-x86_64)  TARGET="x86_64-unknown-linux-gnu" ;;
    Linux-aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
    *)
      echo "无法推导本机 target triple，请用 --target 显式指定" >&2
      exit 1 ;;
  esac
fi

echo "==> wudong root:   $WUDONG_ROOT"
echo "==> openWork-fork: $FORK_ROOT"
echo "==> 输出 resouces: $RESOUCES_DIR"
echo "==> target triple: $TARGET"
echo "==> 构建临时目录: $BUILD_DIR"
[[ -n "$FORCE" ]] && echo "==> 模式: 强制重编"

# ---- 编译 openwork-server -----------------------------------------------

echo
echo "==> 编译 openwork-server"
cd "$FORK_ROOT/apps/server"
bun run build:bin
# 产物: dist/bin/openwork-server
if [[ -f "$FORK_ROOT/apps/server/dist/bin/openwork-server" ]]; then
  cp -f "$FORK_ROOT/apps/server/dist/bin/openwork-server" "$BUILD_DIR/openwork-server"
  echo "  [ok] openwork-server"
else
  echo "  [error] openwork-server 编译失败" >&2
  exit 1
fi

# ---- 编译 opencode-router -----------------------------------------------

echo
echo "==> 编译 opencode-router"
cd "$FORK_ROOT/apps/opencode-router"
if [[ -f "package.json" ]]; then
  bun run build:bin
  if [[ -f "$FORK_ROOT/apps/opencode-router/dist/bin/opencode-router" ]]; then
    cp -f "$FORK_ROOT/apps/opencode-router/dist/bin/opencode-router" "$BUILD_DIR/opencode-router"
    echo "  [ok] opencode-router"
  else
    echo "  [error] opencode-router 编译失败" >&2
    exit 1
  fi
else
  echo "  [skip] opencode-router (目录不存在)"
fi

# ---- 调 prepare-sidecar.mjs 编译 -----------------------------------------

cd "$FORK_ROOT"

# prepare-sidecar.mjs 自带：
#   - 检测 stub binary 自动重编
#   - bun build --compile 多 target
#   - 写 versions.json + per-target 副本
#   - macOS ad-hoc codesign（去掉 quarantine + 签名）
echo
echo "==> 调用 prepare-sidecar.mjs（target=${TARGET}）"
TAURI_ENV_TARGET_TRIPLE="${TARGET}" \
node apps/desktop/scripts/prepare-sidecar.mjs \
  --outdir "$BUILD_DIR" \
  $FORCE

# ---- 拷贝产物 --------------------------------------------------------------

echo
echo "==> 拷贝二进制到 wudongPC/resouces"

# wudongPC 只用 canonical 名（无 target 后缀），prepare-sidecar 会同时输出
# 带 target 后缀的副本（给 Tauri 用）和 canonical 副本（macOS 上无后缀）。
# 我们直接拷 canonical。
for name in opencode-router openwork-server openwork-orchestrator; do
  src="$BUILD_DIR/$name"
  dst="$RESOUCES_DIR/$name"
  if [[ ! -f "$src" ]]; then
    echo "  [skip] $name (源文件不存在: $src)"
    continue
  fi
  cp -f "$src" "$dst"
  chmod +x "$dst"
  echo "  [ok]   $name  ($(du -h "$dst" | awk '{print $1}'))"
done

# ---- 同步 versions.json --------------------------------------------------

if [[ -n "$UPDATE_VERSIONS" && -f "$BUILD_DIR/versions.json" ]]; then
  cp -f "$BUILD_DIR/versions.json" "$RESOUCES_DIR/versions.json"
  echo "  [ok]   versions.json"
fi

# ---- 清理 -----------------------------------------------------------------

if [[ -z "$SKIP_CLEAN" ]]; then
  # 只清掉 build 时落下的 per-target 副本，留 canonical 名以便下次 prepare-sidecar
  # 增量判断（它用 canonical 文件存在与否决定是否重编）
  echo
  echo "==> 清理 per-target 副本"
  find "$BUILD_DIR" -maxdepth 1 -type f \
    \( -name '*-aarch64-apple-darwin*' \
       -o -name '*-x86_64-apple-darwin*' \
       -o -name '*-aarch64-unknown-linux-gnu*' \
       -o -name '*-x86_64-unknown-linux-gnu*' \
       -o -name '*-aarch64-pc-windows-msvc*' \
       -o -name '*-x86_64-pc-windows-msvc*' \) \
    -delete 2>/dev/null || true
fi

# ---- 完成 -----------------------------------------------------------------

echo
echo "==> 完成。当前 wudongPC/resouces 状态："
ls -lh "$RESOUCES_DIR" | awk 'NR>1 {printf "    %s  %-32s  %s\n", $5, $9, $6" "$7" "$8}'

if [[ -f "$RESOUCES_DIR/versions.json" ]]; then
  echo
  echo "==> versions.json："
  sed 's/^/    /' "$RESOUCES_DIR/versions.json"
fi
