# LIMS watchdog: started by Windows Task Scheduler every 10 min. If the queue window is gone, start it again.
$running = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'queue\.ps1' }
if (-not $running) {
  Add-Content "C:\LIMS-state\logs\queue.log" "$(Get-Date -Format s) [watchdog] queue not running - restarting"
  Start-Process powershell -WorkingDirectory "C:\LIMS" -ArgumentList '-ExecutionPolicy','Bypass','-File','C:\LIMS\.orchestra\queue.ps1','-NoPush'
}
