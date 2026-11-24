# Start (or restart) the LIMS queue after a shutdown: report RAM, move stale lane locks aside, then start queue.ps1.
# Lane windows that are alive are NOT touched (the new queue adopts them). Locks are MOVED to locks\_stale-<date>, never deleted.
# Run:  powershell -ExecutionPolicy Bypass -File C:\LIMS\.orchestra\start-lanes.ps1      (or double-click start-lanes.cmd)
$state = "C:\LIMS-state"
$qlog  = Join-Path $state "logs\queue.log"
$rep   = Join-Path $state "logs\start-lanes-report.txt"
function Rpt($m) { $l = "$(Get-Date -Format s) $m"; Add-Content $rep $l; Add-Content $qlog "$(Get-Date -Format s) [start-lanes] $m"; Write-Host $l }
New-Item -ItemType Directory -Force -Path (Join-Path $state "logs"), (Join-Path $state "locks") | Out-Null
Rpt "start-lanes.ps1 begins"

# 1. machine facts (so the RAM upgrade and the page file can be checked from the log)
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $cs = Get-CimInstance Win32_ComputerSystem
  Rpt ("RAM installed {0} GB, free now {1} GB, commit limit {2} GB, boot time {3}" -f [math]::Round($cs.TotalPhysicalMemory/1GB,1), [math]::Round($os.FreePhysicalMemory/1MB,1), [math]::Round($os.TotalVirtualMemorySize/1MB,1), $os.LastBootUpTime.ToString('s'))
  foreach ($pf in @(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue)) { Rpt ("page file {0}: allocated {1} MB, in use {2} MB" -f $pf.Name, $pf.AllocatedBaseSize, $pf.CurrentUsage) }
  $free = [math]::Round(([System.IO.DriveInfo]::new("C")).AvailableFreeSpace/1GB,1)
  Rpt "free on C: $free GB"
  $wsl = @(Get-Process -Name vmmem,vmmemWSL,vmmemmsrdc -ErrorAction SilentlyContinue)
  foreach ($w in $wsl) { Rpt ("{0} (WSL2/VM) working set {1} GB" -f $w.ProcessName, [math]::Round($w.WorkingSet64/1GB,1)) }
  $agents = @(Get-Process -Name claude,node -ErrorAction SilentlyContinue)
  Rpt ("running claude/node processes: {0}, working set {1} GB" -f $agents.Count, [math]::Round((($agents | Measure-Object WorkingSet64 -Sum).Sum)/1GB,1))
} catch { Rpt "machine facts failed: $($_.Exception.Message)" }

# 2. an old queue (if any) is stopped; lane windows stay
$old = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -match 'queue\.ps1' -and $_.ProcessId -ne $PID })
foreach ($p in $old) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Rpt "stopped old queue pid $($p.ProcessId)" }

# 3. lane locks: a lock stays only if its owner pid is a live lane process (run.ps1 / lane-loop.ps1); otherwise it is moved aside
$live = @{}
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -match 'run\.ps1|lane-loop\.ps1' -and $_.ProcessId -ne $PID } | ForEach-Object { $live[[string]$_.ProcessId] = $_.CommandLine }
Rpt "live lane processes: $($live.Count)"
$stale = Join-Path $state ("locks\_stale-" + (Get-Date -Format yyyyMMdd))
foreach ($f in @(Get-ChildItem (Join-Path $state "locks") -Filter *.lock -File -ErrorAction SilentlyContinue)) {
  $owner = (Get-Content $f.FullName -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($owner -and $live.ContainsKey([string]$owner)) { Rpt "kept lock $($f.Name): owner pid $owner is a live lane process" }
  else {
    New-Item -ItemType Directory -Force -Path $stale | Out-Null
    Move-Item -Force $f.FullName (Join-Path $stale $f.Name)
    Rpt "moved stale lock $($f.Name) (owner pid $owner is not a lane process) to $stale"
  }
}

# 4. free disk space first (the documented free-space.ps1 -Apply: docker prune, pnpm store prune, node_modules of finished lanes). Skipped when a lane window is alive, so pnpm prune cannot race with an install.
if ($live.Count -eq 0) {
  Rpt "free-space.ps1 -Apply begins (can take several minutes)"
  try { & powershell -NoProfile -ExecutionPolicy Bypass -File "C:\LIMS\.orchestra\free-space.ps1" -Apply 2>&1 | ForEach-Object { Rpt ("free-space: " + $_) } } catch { Rpt "free-space failed: $($_.Exception.Message)" }
} else { Rpt "free-space skipped: lane windows are alive" }

# 5. start the queue (same arguments as relaunch.ps1 and watchdog.ps1; MaxLanes comes from queue.ps1)
Start-Process powershell -WorkingDirectory "C:\LIMS" -ArgumentList '-ExecutionPolicy','Bypass','-File','C:\LIMS\.orchestra\queue.ps1','-NoPush'
Rpt "queue started"
Write-Host "queue started - this window can be closed"
