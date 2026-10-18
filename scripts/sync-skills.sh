#!/bin/bash
# Sync repository skill components to the local AI installations registered in sync/targets.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/sync/targets.json"
MODE="--check"
COMPONENT=""

usage() { echo "Usage: $0 [--check|--apply] [--component NAME]" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check|--apply) MODE="$1"; shift ;;
    --component) [[ $# -ge 2 ]] || usage; COMPONENT="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[[ -f "$MANIFEST" ]] || { echo "Missing manifest: $MANIFEST" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 2; }

manifest_json="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' "$MANIFEST")"

rows="$(python3 -c '
import json, sys
data = json.loads(sys.argv[1])
only = sys.argv[2] if len(sys.argv) > 2 else ""
components = data.get("components")
if components is None:
    components = [{"component": data.get("component", "unnamed"),
                   "canonical": data.get("canonical", ""),
                   "targets": data.get("targets", []),
                   "habits": data.get("habits", [])}]
for component in components:
    name = component.get("component", "unnamed")
    if only and name != only:
        continue
    canonical = component.get("canonical", "")
    for target in component.get("targets", []):
        print("\t".join(["target", name, canonical, target.get("name", ""), target.get("kind", ""), target.get("path", "")]))
    for habit in component.get("habits", []):
        print("\t".join(["habit", name, canonical, habit.get("name", ""), habit.get("format", ""), habit.get("path", "")]))
' "$manifest_json" "$COMPONENT")"

[[ -n "$rows" ]] || { echo "No components matched${COMPONENT:+ (--component $COMPONENT)}." >&2; exit 2; }

sync_dir="$ROOT/.sync-backups"
timestamp="$(date +%Y%m%d-%H%M%S)"
failed=0

backup() {  # backup <source> <label>
  local source="$1" label="$2"
  mkdir -p "$sync_dir"
  cp -R "$source" "$sync_dir/$label-$timestamp"
  echo "  backup: $sync_dir/$label-$timestamp"
}

sync_target() {  # sync_target <component> <canonical> <name> <kind> <path>
  local component="$1" canonical_rel="$2" name="$3" kind="$4" target="$5"
  local canonical="$ROOT/$canonical_rel"
  echo "[$component/$name] $target"
  if [[ ! -d "$canonical" ]]; then
    echo "  canonical missing: $canonical"
    failed=1
    return
  fi
  if [[ ! -d "$target" ]]; then
    echo "  MISSING"
    failed=1
    return
  fi
  case "$kind" in
    full-copy)
      if diff -qr "$canonical" "$target" >/dev/null 2>&1; then
        echo "  current"
      else
        echo "  differs"
        if [[ "$MODE" == "--apply" ]]; then
          backup "$target" "$component-${name// /_}"
          rm -rf "$target"
          mkdir -p "$(dirname "$target")"
          cp -R "$canonical" "$target"
          echo "  updated"
        fi
      fi
      ;;
    pointer)
      if [[ ! -f "$target/SKILL.md" ]]; then
        echo "  MISSING"
        failed=1
        return
      fi
      if grep -qiE 'canonical|正本' "$target/SKILL.md"; then
        echo "  pointer entry intact; canonical skill not copied"
      else
        echo "  pointer entry does not look like a redirect; review manually"
        failed=1
      fi
      ;;
    *)
      echo "  unsupported target kind: $kind"
      failed=1
      ;;
  esac
}

sync_habit() {  # sync_habit <component> <canonical> <name> <format> <path>
  local component="$1" canonical_rel="$2" name="$3" format="$4" path="$5"
  local canonical="$ROOT/$canonical_rel"
  echo "[$component/habit:$name] $path"
  if [[ "$format" != "copy" ]]; then
    echo "  manual review required (format: $format); unchanged"
    return
  fi
  if [[ ! -f "$path" ]]; then
    echo "  MISSING"
    failed=1
    return
  fi
  if cmp -s "$canonical/SKILL.md" "$path"; then
    echo "  current"
  else
    echo "  differs"
    if [[ "$MODE" == "--apply" ]]; then
      backup "$path" "$component-habit-${name// /_}"
      cp "$canonical/SKILL.md" "$path"
      echo "  updated"
    fi
  fi
}

while IFS=$'\t' read -r row_kind component canonical name kind_or_format path; do
  [[ -n "${row_kind:-}" ]] || continue
  if [[ "$row_kind" == "target" ]]; then
    sync_target "$component" "$canonical" "$name" "$kind_or_format" "$path"
  else
    sync_habit "$component" "$canonical" "$name" "$kind_or_format" "$path"
  fi
done <<< "$rows"

if [[ "$MODE" == "--check" ]]; then
  echo "Check complete. Apply with --apply after reviewing the targets above."
fi
exit "$failed"
