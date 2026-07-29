#!/usr/bin/env bash
# Install the latest signed workbuddy-buddy macOS release for the current user.
#   curl -fsSL https://raw.githubusercontent.com/FlashFamily/workbuddy-buddy/main/install.sh | bash
set -euo pipefail

REPOSITORY="FlashFamily/workbuddy-buddy"
INSTALL_ROOT="${WB_BUDDY_APP_DIR:-$HOME/Applications}"

info() { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
die()  { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "桌宠目前仅支持 macOS；Windows 版仍在开发中。"
command -v curl >/dev/null 2>&1 || die "需要 curl。"
command -v hdiutil >/dev/null 2>&1 || die "需要 macOS 自带的 hdiutil。"
command -v codesign >/dev/null 2>&1 || die "需要 macOS 自带的 codesign。"

case "$(uname -m)" in
  arm64) asset="workbuddy-buddy_macos_arm64.dmg" ;;
  x86_64) asset="workbuddy-buddy_macos_x64.dmg" ;;
  *) die "不支持的 Mac 架构：$(uname -m)" ;;
esac

temporary="$(mktemp -d "${TMPDIR:-/tmp}/workbuddy-buddy.XXXXXX")"
mountpoint="$temporary/mount"
mounted=""
cleanup() {
  if [ -n "$mounted" ]; then
    hdiutil detach "$mountpoint" -quiet || true
  fi
  rm -rf "$temporary"
}
trap cleanup EXIT INT TERM

release_root="https://github.com/$REPOSITORY/releases/latest/download"
info "下载最新 macOS 安装包（$asset）…"
curl -fL --retry 3 --retry-delay 2 -o "$temporary/$asset" "$release_root/$asset"
curl -fL --retry 3 --retry-delay 2 -o "$temporary/$asset.sha256" "$release_root/$asset.sha256"

expected="$(awk 'NR == 1 { print $1 }' "$temporary/$asset.sha256")"
actual="$(shasum -a 256 "$temporary/$asset" | awk '{ print $1 }')"
[ -n "$expected" ] && [ "$expected" = "$actual" ] || die "安装包校验失败，已停止安装。"

mkdir "$mountpoint"
hdiutil attach "$temporary/$asset" -nobrowse -readonly -mountpoint "$mountpoint" -quiet
mounted=1
source_app="$(find "$mountpoint" -maxdepth 2 -type d -name 'workbuddy-buddy.app' -print -quit)"
[ -n "$source_app" ] || die "安装包中没有找到 workbuddy-buddy.app。"
codesign --verify --deep --strict "$source_app" || die "应用签名校验失败，已停止安装。"

target_app="$INSTALL_ROOT/workbuddy-buddy.app"
info "安装到 $target_app …"
mkdir -p "$INSTALL_ROOT"
pkill -x wb-buddy-app >/dev/null 2>&1 || true
ditto "$source_app" "$target_app"
codesign --verify --deep --strict "$target_app" || die "复制后的应用签名校验失败。"

info "启动 WorkBuddy Buddy…"
open "$target_app"

cat <<EOF

  ✅ WorkBuddy Buddy 已安装。

  1. 打开咸鱼办公室的 /start 页面并生成一次性配对码；
  2. 点击网页上的“打开 WorkBuddy Buddy”，核对预填码后确认挂载；
  3. 桌宠会用 WorkBuddy 的正式 marketplace 配置注册状态插件；
  4. 按提示完整重启一次 WorkBuddy，状态同步即可生效。

  不会写入旧式原始 Hook，也不会上传 prompt、回复、工具参数或文件路径。
  仓库 / 问题反馈：https://github.com/$REPOSITORY
EOF
