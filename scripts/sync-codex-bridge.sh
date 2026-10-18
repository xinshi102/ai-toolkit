#!/bin/bash
# Sync the local codex-bridge-plugin source into this repo, test it, and optionally push.
#
#   scripts/sync-codex-bridge.sh            # sync + syntax + tests + show diff
#   scripts/sync-codex-bridge.sh --push     # ... then commit and push origin main
#   scripts/sync-codex-bridge.sh --check    # only report what would change
#
# Source can be overridden with CODEX_BRIDGE_SRC.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${CODEX_BRIDGE_SRC:-$HOME/Documents/deepseek/codex-bridge-plugin}"
DST="$ROOT/codex-bridge-plugin"
MODE=sync

for arg in "$@"; do
  case "$arg" in
    --push) MODE=push ;;
    --check) MODE=check ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

[ -d "$SRC" ] || { echo "source missing: $SRC" >&2; exit 1; }
[ -d "$DST" ] || { echo "repo copy missing: $DST" >&2; exit 1; }

if [ "$MODE" = check ]; then
  rsync -an --delete --itemize-changes \
    --exclude .git --exclude node_modules --exclude .DS_Store \
    "$SRC/" "$DST/"
  exit 0
fi

rsync -a --delete \
  --exclude .git --exclude node_modules --exclude .DS_Store \
  "$SRC/" "$DST/"
printf 'node_modules/\n.DS_Store\n' > "$DST/.gitignore"

echo "-- syntax --"
node --check "$DST/lib/index.js"
node --check "$DST/lib/window-page.js"

echo "-- tests --"
(cd "$DST" && node --test)

cd "$ROOT"
echo "-- diff --"
git status --short -- codex-bridge-plugin

if [ "$MODE" = push ]; then
  if git diff --quiet -- codex-bridge-plugin && git diff --cached --quiet -- codex-bridge-plugin; then
    echo "no changes to commit"
    exit 0
  fi
  git add codex-bridge-plugin
  git -c user.name="Xinshi" -c user.email="xinshi102@users.noreply.github.com" \
    commit -m "Sync codex-bridge-plugin from local source"
  git push origin main
fi
