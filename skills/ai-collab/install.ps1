param([switch]$Codex, [switch]$Dsh, [string]$SkillsDir = "")
# ai-collab (personal) installer: fill local runtime path into DSH overlays, create data dirs, register the skill entry.
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runtime = (Join-Path $Here 'runtime') -replace '\\','/'
Get-ChildItem (Join-Path $Here 'runtime') -Filter '*.patch.yml' | ForEach-Object {
  $t = [IO.File]::ReadAllText($_.FullName)
  if ($t.Contains('__AI_COLLAB_RUNTIME__')) { [IO.File]::WriteAllText($_.FullName, $t.Replace('__AI_COLLAB_RUNTIME__', $Runtime), (New-Object Text.UTF8Encoding $false)) }
}
New-Item -ItemType Directory -Force (Join-Path $Here 'outputs'), (Join-Path $Here '.work'), (Join-Path $Here '.work\runtime-tests'), (Join-Path $HOME '.ai-collab\plan-map') | Out-Null
$targets = @()
if ($SkillsDir) { $targets += $SkillsDir }
if ($Codex) { $targets += (Join-Path $HOME '.codex/skills') }
if ($Dsh)   { $targets += (Join-Path $HOME '.dsh/skills') }
foreach ($t in $targets) {
  $dst = Join-Path $t 'ai-collab'; New-Item -ItemType Directory -Force $dst | Out-Null
  $p = ($Here -replace '\\','/')
  [IO.File]::WriteAllText((Join-Path $dst 'SKILL.md'), "---`nname: ai-collab`ndescription: 多 AI 协作（主控派工作包给 DSH/Codex 等执行者，阻塞等待、分级验收、本地看板）。正文在 $p/SKILL.md。`n---`n`n先读 ``$p/SKILL.md``，相对路径都相对该目录。`n", (New-Object Text.UTF8Encoding $false))
  Write-Host "已安装入口: $dst"
}
Write-Host "完成。看板: powershell -File `"$Here\start-dashboard.ps1`""
