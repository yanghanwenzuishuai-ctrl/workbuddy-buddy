#!/usr/bin/env bash
# Install the fixed community-latest ad-hoc macOS build for the current user.
#   curl -fsSL https://raw.githubusercontent.com/FlashFamily/workbuddy-buddy/main/install-community.sh | bash
set -euo pipefail

REPOSITORY="FlashFamily/workbuddy-buddy"
RELEASE_TAG="community-latest"

info() { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m! %s\033[0m\n" "$*" >&2; }
die()  { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "社区版桌宠目前仅支持 macOS；Windows 版仍在开发中。"
[ -n "${HOME:-}" ] || die "无法确定当前用户的主目录。"

for required_command in curl hdiutil codesign shasum ditto open find awk pgrep tr; do
  command -v "$required_command" >/dev/null 2>&1 ||
    die "缺少必要命令：$required_command"
done

case "$(uname -m)" in
  arm64) asset="workbuddy-buddy_macos_arm64.dmg" ;;
  x86_64) asset="workbuddy-buddy_macos_x64.dmg" ;;
  *) die "不支持的 Mac 架构：$(uname -m)" ;;
esac

if pgrep -x wb-buddy-app >/dev/null 2>&1; then
  die "检测到 WorkBuddy Buddy 正在运行。安装器没有结束任何进程；请从桌宠菜单完整退出后重新运行安装命令。"
fi

install_root="$HOME/Applications"
target_app="$install_root/workbuddy-buddy.app"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/workbuddy-buddy-community.XXXXXX")"
mountpoint="$temporary/mount"
install_stage=""
mounted=0

cleanup() {
  exit_status=$?
  trap - EXIT INT TERM HUP

  if [ "$mounted" -eq 1 ]; then
    hdiutil detach "$mountpoint" -quiet >/dev/null 2>&1 || true
  fi
  if [ -n "$install_stage" ]; then
    rm -rf -- "$install_stage"
  fi
  rm -rf -- "$temporary"
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

release_root="https://github.com/$REPOSITORY/releases/download/$RELEASE_TAG"
dmg_path="$temporary/$asset"
checksum_path="$dmg_path.sha256"

info "下载 macOS 社区版（$asset，固定频道 $RELEASE_TAG）…"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --retry 3 --retry-delay 2 --output "$dmg_path" "$release_root/$asset"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --retry 3 --retry-delay 2 --output "$checksum_path" "$release_root/$asset.sha256"

if ! expected="$(
  awk -v expected_name="$asset" '
    {
      if (NR != 1 || NF != 2 ||
          ($2 != expected_name && $2 != "*" expected_name)) {
        invalid = 1
      }
      if (NR == 1) {
        digest = $1
      }
    }
    END {
      if (NR != 1 || invalid) {
        exit 1
      }
      print digest
    }
  ' "$checksum_path"
)"; then
  die "SHA256 文件格式或文件名不符合预期，已停止安装。"
fi

case "$expected" in
  ""|*[!0-9A-Fa-f]*) die "SHA256 文件包含无效摘要，已停止安装。" ;;
esac
[ "${#expected}" -eq 64 ] ||
  die "SHA256 摘要长度无效，已停止安装。"

actual="$(shasum -a 256 "$dmg_path" | awk 'NR == 1 { print $1 }')"
expected_lower="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
[ "$expected_lower" = "$actual" ] ||
  die "安装包 SHA256 校验失败，已停止安装。"
info "SHA256 校验通过。"

mkdir -m 700 "$mountpoint"
hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mountpoint" -quiet
mounted=1

app_count="$(
  find "$mountpoint" -maxdepth 2 -type d -name 'workbuddy-buddy.app' -print |
    awk 'END { print NR + 0 }'
)"
[ "$app_count" -eq 1 ] ||
  die "安装包应恰好包含一个 workbuddy-buddy.app，实际找到：$app_count。"
source_app="$(
  find "$mountpoint" -maxdepth 2 -type d -name 'workbuddy-buddy.app' -print -quit
)"

codesign --verify --deep --strict "$source_app" ||
  die "应用的代码签名结构校验失败，已停止安装。"
signature_details="$(codesign --display --verbose=4 "$source_app" 2>&1)" ||
  die "无法读取应用签名信息，已停止安装。"
case "$signature_details" in
  *"Signature=adhoc"*) ;;
  *) die "应用不是预期的 ad-hoc 社区版签名，已停止安装。" ;;
esac

info "ad-hoc 代码结构校验通过。"
warn "ad-hoc 仅用于检查应用包结构未损坏，不代表 Apple Developer ID 身份信任，也不等于 Apple 公证。"

mkdir -p "$install_root"
install_stage="$(mktemp -d "$install_root/.workbuddy-buddy-install.XXXXXX")"
staged_app="$install_stage/workbuddy-buddy.app"
previous_app="$install_stage/previous.app"

info "复制到 $target_app …"
ditto "$source_app" "$staged_app"
codesign --verify --deep --strict "$staged_app" ||
  die "复制后的应用代码签名结构校验失败，已停止安装。"

had_previous=0
if [ -e "$target_app" ] || [ -L "$target_app" ]; then
  mv "$target_app" "$previous_app"
  had_previous=1
fi

if ! mv "$staged_app" "$target_app"; then
  if [ "$had_previous" -eq 1 ]; then
    if ! mv "$previous_app" "$target_app"; then
      preserved_stage="$install_stage"
      install_stage=""
      warn "恢复旧版本失败，旧应用已保留在：$preserved_stage/previous.app"
    fi
  fi
  die "无法把社区版安装到 $target_app。"
fi

if ! codesign --verify --deep --strict "$target_app"; then
  rm -rf -- "$target_app"
  if [ "$had_previous" -eq 1 ]; then
    if ! mv "$previous_app" "$target_app"; then
      preserved_stage="$install_stage"
      install_stage=""
      warn "恢复旧版本失败，旧应用已保留在：$preserved_stage/previous.app"
    fi
  fi
  die "安装后的应用代码签名结构校验失败；已尝试恢复旧版本。"
fi

if [ "$had_previous" -eq 1 ]; then
  rm -rf -- "$previous_app"
fi

info "尝试启动 WorkBuddy Buddy…"
if ! open "$target_app"; then
  warn "macOS 阻止了首次启动，但应用已经安装完成。"
fi

cat <<EOF

  ✅ WorkBuddy Buddy 社区版已安装到：
     $target_app

  这是未经 Apple Developer ID 签名和公证的社区测试版。安装器没有运行
  xattr，也没有关闭 Gatekeeper。

  如果 macOS 阻止首次打开：
  1. 打开“系统设置”；
  2. 进入“隐私与安全性”；
  3. 找到 WorkBuddy Buddy 的拦截提示，点击“仍要打开”并按系统提示确认。

  Apple 官方说明：
  https://support.apple.com/guide/mac-help/mh40616/mac

  正式稳定版将继续使用 Developer ID 签名和 Apple 公证。
  仓库 / 问题反馈：https://github.com/$REPOSITORY
EOF
