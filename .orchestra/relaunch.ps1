# Replace the running queue with the current .orchestra\queue.ps1. Lane windows are NOT touched: the new queue adopts them.
# Run:  powershell -ExecutionPolicy Bypass -File C:\LIMS\.orchestra\relaunch.ps1
$log = "C:\LIMS-state\logs\queue.log"
$old = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -match 'queue\.ps1' -and $_.ProcessId -ne $PID })
foreach ($p in $old) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  Add-Content $log "$(Get-Date -Format s) [relaunch] stopped old queue pid $($p.ProcessId)"
}
Start-Sleep -Seconds 3
Start-Process powershell -WorkingDirectory "C:\LIMS" -ArgumentList '-ExecutionPolicy','Bypass','-File','C:\LIMS\.orchestra\queue.ps1','-NoPush'
Add-Content $log "$(Get-Date -Format s) [relaunch] started the new queue"
Write-Host "new queue started - this window can be closed"
