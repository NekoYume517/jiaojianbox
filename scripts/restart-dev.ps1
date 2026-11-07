# 重启交件箱开发实例：先关旧的 Electron/服务端，再起新的（无弹窗）
param([switch]$NoServer)
$root = 'C:\Users\zzy\Documents\Codex\2026-11-07\jie-h\outputs\jiaojianbox'
# 1. Electron：只终止交件箱自己的 electron（按可执行路径过滤）
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like "$root\*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 1
# 2. 服务端
if (-not $NoServer) {
  $conn = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
  if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue; Start-Sleep 1 }
  Start-Process python -ArgumentList '-m','uvicorn','server.app:app','--host','127.0.0.1','--port','8765' -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep 4
  Invoke-RestMethod http://127.0.0.1:8765/health | ConvertTo-Json -Compress
}
# 3. Electron（干净环境变量，避免 ELECTRON_RUN_AS_NODE 污染）
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $root 'node_modules\electron\dist\electron.exe'
$psi.Arguments = '.'
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE') | Out-Null
[System.Diagnostics.Process]::Start($psi) | Out-Null
Start-Sleep 10
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object Id, MainWindowTitle
