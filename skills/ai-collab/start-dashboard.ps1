param([int]$Port = 18765, [string]$Roots = "", [switch]$Foreground)
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$argsList = @('-X','utf8','-B',(Join-Path $Here 'runtime\collab_dashboard.py'),'--port',"$Port")
if ($Roots) { $argsList += @('--roots', $Roots) }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { Write-Host "端口 $Port 已被占用，换一个：-Port 18800"; exit 1 }
if ($Foreground) { & python @argsList; exit $LASTEXITCODE }
$log = Join-Path $Here '.work\dashboard.log'; New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
Start-Process -FilePath 'python' -ArgumentList $argsList -WindowStyle Hidden -RedirectStandardError $log
Start-Sleep -Seconds 4
try { $r = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 20; Write-Host "看板已启动: http://127.0.0.1:$Port/" }
catch { Write-Host "看板没起来，报错见 $log"; if (Test-Path $log) { Get-Content $log -Tail 8 } }
