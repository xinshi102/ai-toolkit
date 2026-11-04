# Install the xinshi skill pointer into one or more host skill roots.
# Usage:
#   powershell -File scripts\install-xinshi.ps1 -Canonical <repo>\skills\xinshi -Roots C:\Users\me\.codex\skills,C:\Users\me\.agents\skills
param(
  [Parameter(Mandatory = $true)][string]$Canonical,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Roots
)

$canonicalPath = (Resolve-Path -LiteralPath $Canonical).Path
if (-not (Test-Path (Join-Path $canonicalPath 'SKILL.md'))) {
  Write-Error "canonical SKILL.md not found: $canonicalPath"
  exit 2
}

$canonicalUrl = $canonicalPath -replace '\\', '/'

$pointer = @"
---
name: xinshi
description: 信使的任务入口：先判断环境与协作方式，单 harness 能做就自己做，需要时才用子 agent、跨 harness 或运行器；持续推进到必须由用户决定为止。
---

Read the single canonical skill at ``$canonicalUrl/SKILL.md`` and follow it; reuse it if already loaded in this conversation.
"@

foreach ($root in $Roots) {
  if (-not (Test-Path -LiteralPath $root)) {
    Write-Warning "skip missing root: $root"
    continue
  }
  $target = Join-Path $root 'xinshi'
  if (Test-Path -LiteralPath $target) {
    $skill = Join-Path $target 'SKILL.md'
    if ((Test-Path -LiteralPath $skill) -and (Select-String -LiteralPath $skill -Pattern 'canonical skill|integrations/xinshi/SKILL.md' -SimpleMatch -Quiet)) {
      Write-Output "ok (already a pointer): $target"
    }
    else {
      Write-Warning "refuse to overwrite non-pointer: $target"
    }
    continue
  }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $target 'SKILL.md') -Value $pointer -Encoding utf8
  Write-Output "installed: $target -> $canonicalPath"
}
