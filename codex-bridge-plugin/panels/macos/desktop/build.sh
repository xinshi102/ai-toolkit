#!/bin/bash
# Build the macOS collaboration window and install it over the local app.
#
#   panels/macos/desktop/build.sh [app-path]
#
# Default app: ~/Applications/DeepSeek-Codex 协作窗口.app
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HOME/Applications/DeepSeek-Codex 协作窗口.app}"
OUT="$HERE/build/DeepSeekCodexWindow"
mkdir -p "$HERE/build"
swiftc -O -framework AppKit -framework WebKit -o "$OUT" "$HERE/CollaborationWindow.swift"
cp "$OUT" "$APP/Contents/MacOS/DeepSeekCodexWindow"
chmod +x "$APP/Contents/MacOS/DeepSeekCodexWindow"
codesign --force --deep --sign - "$APP"
echo "installed: $APP"
