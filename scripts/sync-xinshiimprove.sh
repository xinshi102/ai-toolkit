#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/sync/targets.json"
CANONICAL="$ROOT/skills/xinshiimprove"
MODE="${1:---check}"

if [[ "$MODE" != "--check" && "$MODE" != "--apply" ]]; then
  echo "Usage: $0 [--check|--apply]" >&2
  exit 2
fi

if [[ ! -d "$CANONICAL" || ! -f "$MANIFEST" ]]; then
  echo "Missing canonical skill or target manifest." >&2
  exit 2
fi

command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 2; }

manifest_json="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' "$MANIFEST")"
targets_json="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["targets"]))' "$manifest_json")"
habits_json="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1]).get("habits", [])))' "$manifest_json")"

sync_dir="$ROOT/.sync-backups"
timestamp="$(date '+%Y%m%d-%H%M%S')"
failed=0

sync_target() {
  local name="$1" kind="$2" target="$3"
  echo "[$name] $target"
  if [[ ! -d "$target" ]]; then
    echo "  MISSING"
    failed=1
    return
  fi
  case "$kind" in
    full-copy)
      if diff -qr "$CANONICAL" "$target" >/dev/null 2>&1; then
        echo "  current"
      else
        echo "  differs"
        if [[ "$MODE" == "--apply" ]]; then
          mkdir -p "$sync_dir"
          cp -R "$target" "$sync_dir/${name// /_}-$timestamp"
          rm -rf "$target"
          mkdir -p "$(dirname "$target")"
          cp -R "$CANONICAL" "$target"
          echo "  updated; backup: $sync_dir/${name// /_}-$timestamp"
        fi
      fi
      ;;
    shared-rules)
      if [[ ! -d "$target/share" ]]; then
        echo "  missing share directory"
        failed=1
        return
      fi
      if diff -qr "$CANONICAL/share" "$target/share" >/dev/null 2>&1; then
        echo "  shared rules current; tool entry point preserved"
      else
        echo "  shared rules differ"
        if [[ "$MODE" == "--apply" ]]; then
          mkdir -p "$sync_dir"
          cp -R "$target/share" "$sync_dir/${name// /_}-share-$timestamp"
          rm -rf "$target/share"
          cp -R "$CANONICAL/share" "$target/share"
          echo "  shared rules updated; backup: $sync_dir/${name// /_}-share-$timestamp"
        fi
      fi
      ;;
    *)
      echo "  unsupported target kind: $kind"
      failed=1
      ;;
  esac
}

while IFS=$'\t' read -r name kind path; do
  [[ -n "$name" ]] && sync_target "$name" "$kind" "$path"
done < <(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); [print("\t".join([x["name"],x["kind"],x["path"]])) for x in d]' "$targets_json")

while IFS=$'\t' read -r name format path; do
  [[ -n "$name" ]] || continue
  echo "[habit: $name] $path"
  if [[ "$format" != "copy" ]]; then
    echo "  manual review required (format: $format); unchanged"
    continue
  fi
  if [[ ! -f "$path" ]]; then
    echo "  MISSING"
    failed=1
    continue
  fi
  if cmp -s "$CANONICAL/SKILL.md" "$path"; then
    echo "  current"
  else
    echo "  differs"
    if [[ "$MODE" == "--apply" ]]; then
      mkdir -p "$sync_dir"
      cp -p "$path" "$sync_dir/habit-${name// /_}-$timestamp"
      cp "$CANONICAL/SKILL.md" "$path"
      echo "  updated; backup: $sync_dir/habit-${name// /_}-$timestamp"
    fi
  fi
done < <(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); [print("\t".join([x["name"],x["format"],x["path"]])) for x in d]' "$habits_json")

if [[ "$MODE" == "--check" ]]; then
  echo "Check complete. Apply with --apply after reviewing the targets above."
fi
exit "$failed"
