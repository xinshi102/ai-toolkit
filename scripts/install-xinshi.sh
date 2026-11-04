#!/bin/bash
# Install the xinshi skill pointer into one or more host skill roots.
# Usage: install-xinshi.sh <canonical-xinshi-dir> <host-skill-root> [more roots...]
# Example: install-xinshi.sh "$PWD/skills/xinshi" ~/.codex/skills ~/.agents/skills ~/.dsh/skills
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <canonical-xinshi-dir> <host-skill-root> [more roots...]" >&2
  exit 2
fi

canonical="$(cd "$1" && pwd)"
[[ -f "$canonical/SKILL.md" ]] || { echo "canonical SKILL.md not found: $canonical" >&2; exit 2; }
shift

for root in "$@"; do
  if [[ ! -d "$root" ]]; then
    echo "skip missing root: $root" >&2
    continue
  fi
  target="$root/xinshi"
  if [[ -d "$target" ]]; then
    if [[ -f "$target/SKILL.md" ]] && grep -q "canonical skill\|integrations/xinshi/SKILL.md" "$target/SKILL.md"; then
      echo "ok (already a pointer): $target"
    else
      echo "refuse to overwrite non-pointer: $target" >&2
    fi
    continue
  fi
  mkdir -p "$target"
  cat > "$target/SKILL.md" <<EOF
---
name: xinshi
description: 信使的任务入口：先判断环境与协作方式，单 harness 能做就自己做，需要时才用子 agent、跨 harness 或运行器；持续推进到必须由用户决定为止。
---

Read the single canonical skill at \`$canonical/SKILL.md\` and follow it; reuse it if already loaded in this conversation.
EOF
  echo "installed: $target -> $canonical"
done
