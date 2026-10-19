#!/bin/bash
# Backward-compatible entry point: sync the xinshi component only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$ROOT/sync-skills.sh" --component xinshi "$@"
