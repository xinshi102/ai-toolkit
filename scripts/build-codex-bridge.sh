#!/bin/bash
# Build the DSH plugin artifact from the single source of truth.
#
#   scripts/build-codex-bridge.sh [target]
#
# Source: codex-bridge-plugin/  Target: plugins/dsh/codex-bridge/ (generated, gitignored)
# Never hand-edit the target: run this script after changing the source.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/codex-bridge-plugin"
DST="${1:-$ROOT/plugins/dsh/codex-bridge}"

[ -d "$SRC" ] || { echo "source missing: $SRC" >&2; exit 1; }
mkdir -p "$DST"
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude .DS_Store \
  --exclude .gitignore --exclude bridge-mcp --exclude docs \
  "$SRC/" "$DST/"
node --check "$DST/lib/index.js"
(cd "$DST" && node --test test/*.test.js panels/*/test/*.test.js)
echo "built: $DST"
