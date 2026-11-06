<# LIMS build queue: runs every chunk in wave order with no manual input.
   Start once (from C:\LIMS):  powershell -ExecutionPolicy Bypass -File .orchestra\queue.ps1 -NoPush
   - Keeps at most $MaxLanes lane windows open at once (each lane = own git worktree + branch, so no collisions).
   - Starts a queued lane when its "after" chunks are finished (every task done or blocked) and a slot is free.
   - Every 10 minutes: re-checks, restarts any lane window that died, starts the next lanes.
   - Re-running it after a reboot is safe: finished chunks are skipped, unfinished ones resume. #>
param([string]$Integration = "C:\LIMS", [string]$LanesRoot = "C:\LIMS-lanes", [string]$StateDir = "C:\LIMS-state",
      [int]$MaxLanes = 6, [int]$EveryMinutes = 10, [switch]$NoPush)

$C0 = "C0-foundation-contracts"
# order = priority. after = chunks that must be finished first (spec/program/01-CHUNK-MAP.md §1).
$Queue = @(
  @{ name="C0-0A"; chunk=$C0; filter='^(T0A-|SP-|T0-)'; after=@() },
  @{ name="C0-0B"; chunk=$C0; filter='^T0B-'; after=@() },
  @{ name="C0-0C"; chunk=$C0; filter='^T0C-'; after=@() },
  @{ name="C0-0D"; chunk=$C0; filter='^T0D-'; after=@() },
  @{ name="C1";  chunk="C1-infrastructure-ops";     filter='.*'; after=@() },
  # Wave 1
  @{ name="C2";  chunk="C2-identity-admin";         filter='.*'; after=@($C0) },
  @{ name="C3";  chunk="C3-catalog-pricing";        filter='.*'; after=@($C0) },
  @{ name="C4";  chunk="C4-frontdesk-billing";      filter='.*'; after=@($C0) },
  @{ name="C5";  chunk="C5-lab-workflow";           filter='.*'; after=@($C0) },
  @{ name="C6";  chunk="C6-reporting-delivery";     filter='.*'; after=@($C0) },
  @{ name="C7";  chunk="C7-instrument-integration"; filter='.*'; after=@($C0) },
  @{ name="C8";  chunk="C8-analytics-mis";          filter='.*'; after=@($C0) },
  # Wave 2
  @{ name="C9";  chunk="C9-quality-engine";         filter='.*'; after=@($C0,"C5-lab-workflow") },
  @{ name="C10"; chunk="C10-microbiology";          filter='.*'; after=@($C0,"C5-lab-workflow") },
  @{ name="C11"; chunk="C11-specialty-pathology";   filter='.*'; after=@($C0,"C5-lab-workflow") },
  @{ name="C12"; chunk="C12-inventory";             filter='.*'; after=@($C0,"C3-catalog-pricing") },
  @{ name="C13"; chunk="C13-b2b-partner-portal";    filter='.*'; after=@($C0,"C4-frontdesk-billing","C6-reporting-delivery") },
  @{ name="C14"; chunk="C14-smart-report";          filter='.*'; after=@($C0,"C6-reporting-delivery") },
  @{ name="C15"; chunk="C15-payment-gateways";      filter='.*'; after=@($C0,"C4-frontdesk-billing") },
  # Wave 3
  @{ name="C16"; chunk="C16-patient-engagement";    filter='.*'; after=@($C0,"C6-reporting-delivery","C15-payment-gateways") },
  @{ name="C17"; chunk="C17-home-collection";       filter='.*'; after=@($C0,"C4-frontdesk-billing","C5-lab-workflow") }
  # C18 stays out: design-only until the eLabs export sample arrives (B4).
)

$log = Join-Path $StateDir "logs\queue.log"
New-Item -ItemType Directory -Force -Path $LanesRoot, (Join-Path $StateDir "logs") | Out-Null
function Q($m) { $l = "$(Get-Date -Format s) [queue] $m"; Write-Host $l; Add-Content $log $l }

function Get-Tasks($chunk) { $f = Join-Path $StateDir "tasks\$chunk.json"; if (Test-Path $f) { try { Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } } else { $null } }
function Finished($chunk, $filter = '.*') {
  $t = Get-Tasks $chunk; if (-not $t) { return $false }
  @($t | Where-Object { $_.id -match $filter -and $_.status -notin @('done','blocked') }).Count -eq 0
}
function Blocked($chunk) { $t = Get-Tasks $chunk; if ($t) { @($t | Where-Object { $_.status -eq 'blocked' }).Count } else { 0 } }

$host.UI.RawUI.WindowTitle = "LIMS queue"
$procs = @{}
while ($true) {
  Set-Location $Integration
  # 1. drop finished / dead lanes
  foreach ($n in @($procs.Keys)) { if ($procs[$n].HasExited) { $procs.Remove($n) } }
  # 2. start lanes that are ready, in priority order, while a slot is free
  foreach ($l in $Queue) {
    if ($procs.ContainsKey($l.name)) { continue }
    if (Finished $l.chunk $l.filter) { continue }
    $ready = $true; foreach ($a in $l.after) { if (-not (Finished $a)) { $ready = $false } }
    if (-not $ready) { continue }
    if ($procs.Count -ge $MaxLanes) { break }
    $wt = Join-Path $LanesRoot $l.name; $br = "lane/$($l.name)"
    if (-not (Test-Path $wt)) {
      if (git branch --list $br) { git worktree add $wt $br 2>&1 | Out-Null } else { git worktree add $wt -b $br main 2>&1 | Out-Null }
    } else { git -C $wt merge --no-edit main 2>&1 | Out-Null }
    $plist = @("-ExecutionPolicy","Bypass","-File","`"$Integration\.orchestra\lane-loop.ps1`"","-Chunk",$l.chunk,
               "-Filter","`"$($l.filter)`"","-WorkDir","`"$wt`"","-Integration","`"$Integration`"","-StateDir","`"$StateDir`"","-ExitWhenFinished")
    if ($NoPush) { $plist += "-NoPush" }
    $procs[$l.name] = Start-Process powershell -ArgumentList $plist -PassThru
    Q "started lane $($l.name) ($($l.chunk))"
    Start-Sleep -Seconds 20
  }
  # 3. status line
  $done = @($Queue | Where-Object { Finished $_.chunk $_.filter }).Count
  $bl = ($Queue | ForEach-Object { $_.chunk } | Select-Object -Unique | ForEach-Object { Blocked $_ } | Measure-Object -Sum).Sum
  Q "lanes running: $($procs.Count) [$(($procs.Keys) -join ', ')] | finished lanes: $done/$($Queue.Count) | blocked tasks: $bl"
  if ($done -eq $Queue.Count) { Q "ALL QUEUED CHUNKS FINISHED. Review blocked tasks, then merge/push."; break }
  Start-Sleep -Seconds ($EveryMinutes * 60)
}
