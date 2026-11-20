#!/bin/sh
# Mac 上打包，并去掉程序里带你用户名的路径（/Users/你的名字/.cargo/...）
# 用法：在项目根目录运行 sh scripts/build-release.sh
# 打出来的是同时支持 M 系列和 Intel 的版本，第一次要先装两个目标：
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
cd "$(dirname "$0")/.." || exit 1
osascript -e 'quit app "ingwork"' 2>/dev/null
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$HOME=~"
pnpm tauri build --target universal-apple-darwin || exit 1
echo
app="src-tauri/target/universal-apple-darwin/release/bundle/macos/ingwork.app"
if grep -rqF "$HOME" "$app/Contents/MacOS/"; then
  echo "[!!] 程序里还有你的用户目录路径，先别发布。"
else
  echo "[OK] 程序里没有你的用户目录路径。"
fi
echo "安装包：src-tauri/target/universal-apple-darwin/release/bundle/dmg/"
