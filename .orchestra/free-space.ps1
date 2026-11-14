<#  Frees disk space on the drive that holds the lane worktrees, without touching anything a running lane uses.
    Default = DRY RUN (prints what it would do). Add -Apply to really do it. Prints the free space before/after every step.
      1. Docker: dangling images and unused build cache (nothing a running container uses).
      2. pnpm store: packages no project uses any more.
      3. node_modules folders of lanes that are completely finished (every task of the lane is "done"), have no running lane window,
         and no pending lead reset. Source files, git history and branches are never touched; an agent runs "pnpm install" again if a lane is ever reopened.
    Deleting uses "cmd /c rmdir /s /q", which removes pnpm's workspace links without following them into source folders. #>
param([switch]$Apply, [switch]$NoPnpm, [string]$LanesRoot = "C:\LIMS-lanes", [string]$StateDir = "C:\LIMS-state", [string]$Integration = "C:\LIMS")
$drive = $LanesRoot.Substring(0,2)
function Free { try { [math]::Round(([System.IO.DriveInfo]::new($LanesRoot.Substring(0,1))).AvailableFreeSpace / 1GB, 1) } catch { -1 } }
$start = Free
"Free on $drive now: $start GB   [mode: $(if ($Apply) { 'APPLY - deleting' } else { 'dry run - nothing is deleted; add -Apply' })]"
function Step($name, [scriptblock]$what) {
  if (-not $Apply) { "  would run: $name"; return }
  $b = Free; try { & $what } catch { "  failed: $($_.Exception.Message)" }; $a = Free
  "{0,-40} {1,7} -> {2,7} GB   freed {3} GB" -f $name, $b, $a, [math]::Round($a - $b, 1)
}

# 1. docker
if (Get-Command docker -ErrorAction SilentlyContinue) {
  Step "docker: dangling images" { docker image prune -f | Out-Null }
  Step "docker: unused build cache" { docker builder prune -f | Out-Null }
} else { "docker not found - skipped" }

# 2. pnpm store
if ($NoPnpm) { "pnpm store prune skipped (-NoPnpm)" } elseif (Get-Command pnpm -ErrorAction SilentlyContinue) { Step "pnpm: store prune" { pnpm store prune | Out-Null } } else { "pnpm not found - skipped" }

# 3. node_modules of finished, idle lanes (lane table and filters are read from queue.ps1, the same table the queue uses)
$C0 = "C0-foundation-contracts"
$qsrc = Get-Content (Join-Path $Integration ".orchestra\queue.ps1") -Raw
$Queue = $null
$m = [regex]::Match($qsrc, '(?s)\$Queue = @\(.*?\r?\n\)\r?\n')
if ($m.Success) { Invoke-Expression $m.Value }
if (-not $Queue) { "could not read the lane table from queue.ps1 - step 3 skipped" }
else {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'lane-loop\.ps1|run\.ps1' })
  foreach ($l in $Queue) {
    $wt = Join-Path $LanesRoot $l.name
    if (-not (Test-Path $wt)) { continue }
    $f = Join-Path $StateDir "tasks\$($l.chunk).json"
    if (-not (Test-Path $f)) { continue }
    try { $j = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
    $t = @(); foreach ($x in $j) { $t += $x }
    $mine = @($t | Where-Object { $_.id -match $l.filter })
    if ($mine.Count -eq 0 -or @($mine | Where-Object { $_.status -ne 'done' }).Count -gt 0) { continue }   # not finished: keep
    $rx = [regex]::Escape($wt) + '("|\s|$)'
    if (@($procs | Where-Object { $_.CommandLine -match $rx }).Count) { "  lane $($l.name): finished but a window is still open - kept"; continue }
    $pend = $false
    foreach ($rf in @(Get-ChildItem -Path $StateDir -Filter "resets-$($l.chunk)*.json" -ErrorAction SilentlyContinue)) {
      try { $rm = Get-Content $rf.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
      foreach ($p in $rm.PSObject.Properties) { if ($p.Name -match $l.filter) { $pend = $true } }
    }
    if ($pend) { "  lane $($l.name): reset pending - kept"; continue }
    $dirs = @()
    foreach ($base in @($wt, (Join-Path $wt 'contracts')) + @('apps','packages','services','tools','tests','infra' | ForEach-Object { Join-Path $wt $_ } | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } })) {
      $nm = Join-Path $base 'node_modules'; if (Test-Path $nm) { $dirs += $nm }
    }
    if (-not $dirs.Count) { continue }
    Step "node_modules of finished lane $($l.name) ($($dirs.Count) dirs)" { foreach ($d in $dirs) { cmd /c rmdir /s /q "`"$d`"" } }
  }
}
$end = Free
"Done. Free on $drive : $start GB -> $end GB (freed $([math]::Round($end - $start, 1)) GB)."
