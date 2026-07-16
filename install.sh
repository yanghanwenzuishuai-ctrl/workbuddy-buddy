#!/usr/bin/env bash
# workbuddy-buddy one-line installer.
#   curl -fsSL https://raw.githubusercontent.com/FlashFamily/workbuddy-buddy/main/install.sh | bash
#
# Fetches the source, builds the desktop pet, installs the WorkBuddy hook
# (backing up your settings.json), and launches the pet. Requires macOS + Rust.
set -euo pipefail

REPO="https://github.com/FlashFamily/workbuddy-buddy"
SRC="${WB_BUDDY_SRC:-$HOME/.workbuddy-buddy/src}"

info() { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m! %s\033[0m\n" "$*"; }
die()  { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "目前仅支持 macOS。"
command -v git     >/dev/null 2>&1 || die "需要 git。"
command -v python3 >/dev/null 2>&1 || die "需要 python3。"
command -v cargo   >/dev/null 2>&1 || die "需要 Rust。安装：curl https://sh.rustup.rs -sSf | sh   然后重开终端再试。"

info "获取源码 → $SRC"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" pull --ff-only --quiet || warn "git pull 失败，用现有副本继续。"
else
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 "$REPO" "$SRC"
fi

info "编译桌宠（首次几分钟，之后很快）…"
( cd "$SRC" && cargo build --release -p wb-buddy-app )

info "把 hook 装进 WorkBuddy（自动备份 settings.json）…"
python3 "$SRC/hooks/install.py"

info "启动桌宠…"
BIN="$SRC/target/release/wb-buddy-app"
pkill -f "$BIN" 2>/dev/null || true
nohup "$BIN" >/dev/null 2>&1 &

WB_RUNNING=""
pgrep -f 'WorkBuddy.app/Contents/MacOS/Electron' >/dev/null 2>&1 && WB_RUNNING=1

cat <<EOF

  ✅ 装好了。桌宠已经在屏幕角落待命。

  ⚠️  最后一步：让 WorkBuddy 加载新 hook——
EOF
if [ -n "$WB_RUNNING" ]; then
  cat <<EOF
      WorkBuddy 正在运行，且配置是启动时缓存的，必须【完全退出后重开】：
        Cmd+Q  （或彻底点不动就： pkill -KILL -f WorkBuddy.app ）
      重开后打开一个工作目录、随便跑个任务，桌宠就会跟着动。
EOF
else
  echo "      打开 WorkBuddy，进一个工作目录，跑个任务即可。"
fi
cat <<EOF

  • 换宠物：菜单栏托盘「选择伙伴」，或右键点宠物
  • 点一下宠物：把 WorkBuddy 窗口拉到最前；拖动：移动窗口
  • 卸载 hook：cp ~/.workbuddy/settings.json.wb-buddy-bak ~/.workbuddy/settings.json 后重启 WorkBuddy
  • 仓库 / 问题反馈：$REPO
EOF
