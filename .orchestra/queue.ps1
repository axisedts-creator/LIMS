<# LIMS build queue: runs every chunk in wave order with no manual input.
   Start once (from C:\LIMS):  powershell -ExecutionPolicy Bypass -File .orchestra\queue.ps1 -NoPush
   - Keeps at most $MaxLanes lane windows open at once (each lane = own git worktree + branch, so no collisions).
   - A chunk can have several lanes (C4, C4b, C4c ...): each lane owns a fixed list of task ids (its filter); the task list's depends decide the order,
     so two lanes never run tasks that depend on each other at the same time.
   - Starts a lane when its "after" chunks are finished (every task done or blocked), it has a task that can run NOW, and a slot is free.
   - A lane that has nothing runnable closes and frees its slot (lane-loop -ExitWhenIdle); the queue starts it again when work is ready.
   - Every few minutes: re-checks, restarts any lane window that died, starts the next lanes.
   - Re-running it after a reboot is safe: finished chunks are skipped, unfinished ones resume; lane windows that are already open are adopted, not duplicated.
   - Lane order below = priority: the chunks that gate the most later work (C4, C6, C5, C3, C15, C16) come first. #>
param([string]$Integration = "C:\LIMS", [string]$LanesRoot = "C:\LIMS-lanes", [string]$StateDir = "C:\LIMS-state",
      [int]$MaxLanes = 8, [int]$EveryMinutes = 3, [int]$MinFreeGB = 60, [int]$ResetExtra = 1, [switch]$NoPush)

$C0 = "C0-foundation-contracts"
$log = Join-Path $StateDir "logs\queue.log"
New-Item -ItemType Directory -Force -Path $LanesRoot, (Join-Path $StateDir "logs") | Out-Null
function Q($m) { $l = "$(Get-Date -Format s) [queue] $m"; Write-Host $l; Add-Content $log $l }

# one queue at a time (a second one would only fight over the same lanes)
$others = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'queue\.ps1' -and $_.ProcessId -ne $PID })
if ($others.Count) { Q "another queue is already running (pid $($others[0].ProcessId)) - this one exits"; exit 0 }

# order = priority. after = chunks that must be finished first (spec/program/01-CHUNK-MAP.md section 1).
# filter = regex on task id: the tasks this lane owns. C0 lanes are split by workstream; all other chunks by task-id lists
# (balanced by file affinity and dependency order, generated 2026-11-07 from the task lists in C:\LIMS-state\tasks).
$Queue = @(
  @{ name="C0-0A"; chunk=$C0; filter='^(T0A-|SP-|T0-)'; after=@() },
  @{ name="C0-0B"; chunk=$C0; filter='^T0B-'; after=@() },
  @{ name="C0-0C"; chunk=$C0; filter='^T0C-'; after=@() },
  @{ name="C0-0D"; chunk=$C0; filter='^T0D-(?!UI-)'; after=@() },
  # 2026-11-13 lead: the restyle tasks (T0D-UI-R*) were split off C0-0D so they run in parallel with T0D-18 (they touch packages/ui and apps/web/src/core/shell, T0D-18 touches services/api/src/core). R05 (Flutter) is not on the critical path of the RS lanes, so it has its own lane.
  @{ name="C0-0E"; chunk=$C0; filter='^(T0D-UI-R01|T0D-UI-R02|T0D-UI-R03|T0D-UI-R04|T0D-UI-R07)$'; after=@() },
  @{ name="C0-0F"; chunk=$C0; filter='^T0D-UI-R05$'; after=@() },
  @{ name="C1";  chunk="C1-infrastructure-ops"; filter='.*'; after=@() },
  @{ name="C4"; chunk="C4-frontdesk-billing"; filter='^(FD-T01|FD-T03|FD-T04|FD-T05|FD-T06|FD-T13|FD-T07|FD-T10|FD-T15|FD-T08|FD-T09|FD-T11|FD-T12|FD-T16|FD-T17|J-T03)$'; after=@($C0) },
  @{ name="C4b"; chunk="C4-frontdesk-billing"; filter='^(FD-T02|BL-T02|BL-T05|BL-T06|BL-T08|BL-T07|BL-T11|BL-T09|BL-T12|BL-T16|BL-T22|J-T01|FD-T14)$'; after=@($C0) },
  @{ name="C4c"; chunk="C4-frontdesk-billing"; filter='^(BL-T01|BL-T03|BL-T04|BL-T17|BL-T10|BL-T14|BL-T15|BL-T19|BL-T18|BL-T13|BL-T20|BL-T23)$'; after=@($C0) },
  @{ name="C6"; chunk="C6-reporting-delivery"; filter='^(C6-T01|C6-T02|C6-T04|C6-T05|C6-T06|C6-T07|C6-T32|C6-T08|C6-T09|C6-T13|C6-T41|C6-T36|C6-T40|C6-T43|C6-T14|C6-T12|C6-T38|C6-T39|C6-T16|C6-T15|C6-T31|C6-T34)$'; after=@($C0) },
  @{ name="C6b"; chunk="C6-reporting-delivery"; filter='^(C6-T03|C6-T10|C6-T11|C6-T19|C6-T20|C6-T25|C6-T24|C6-T17|C6-T22|C6-T30|C6-T42|C6-T23|C6-T29|C6-T21|C6-T37|C6-T44|C6-T26|C6-T33|C6-T18|C6-T35)$'; after=@($C0) },
  @{ name="C5"; chunk="C5-lab-workflow"; filter='^(T-01|T-02|T-04|T-06|T-07|T-08|T-11|T-30|T-09|T-10|T-28|T-19|T-25|T-20|T-29|T-27|T-31|T-32|T-34)$'; after=@($C0) },
  @{ name="C5b"; chunk="C5-lab-workflow"; filter='^(T-03|T-05|T-12|T-13|T-14|T-22|T-15|T-16|T-17|T-21|T-24|T-18|T-23|T-26|T-33)$'; after=@($C0) },
  @{ name="C5c"; chunk="C5-lab-workflow"; filter='^(T-10|T-19|T-26|T-28)$'; after=@($C0) },   # 2026-11-11 lead: independent C5 tasks pulled forward; C5 gates C9/C10/C11/C17 (~109 tasks)
  @{ name="C3"; chunk="C3-catalog-pricing"; filter='^(T-01|T-02|T-04|T-05|T-31|T-13|T-15|T-16|T-17|T-18|T-19|T-34|T-30|T-33|T-28b|T-29a|T-29b|T-21|T-22|T-23|T-25|T-36|T-38)$'; after=@($C0) },
  @{ name="C3b"; chunk="C3-catalog-pricing"; filter='^(T-03|T-20|T-26|T-06|T-14|T-07|T-08|T-09|T-10|T-11|T-32|T-12|T-28a|T-27|T-29|T-37|T-24|T-35)$'; after=@($C0) },
  @{ name="C15"; chunk="C15-payment-gateways"; filter='^(PG-T01|PG-T03|PG-T17|PG-T06|PG-T08|PG-T09|PG-T24|PG-T12|PG-T14|PG-T15|PG-T19|PG-T20)$'; after=@($C0,"C4-frontdesk-billing") },
  @{ name="C15b"; chunk="C15-payment-gateways"; filter='^(PG-T02|PG-T04|PG-T05|PG-T07|PG-T10|PG-T11|PG-T13|PG-T16|PG-T18)$'; after=@($C0,"C4-frontdesk-billing") },
  @{ name="C16"; chunk="C16-patient-engagement"; filter='^(T-01|T-03|T-Q1|T-Q2|T-Q3|T-Q4|T-Q5|T-B1|T-B3|T-B4|T-B6|T-L1|T-L2|T-L5|T-BK1|T-P1|T-P2|T-P3|T-P4|T-PAY1|T-SEC1|T-DOC1)$'; after=@($C0,"C6-reporting-delivery","C15-payment-gateways") },
  @{ name="C16b"; chunk="C16-patient-engagement"; filter='^(T-02|T-A1|T-REL1|T-B2|T-R1|T-OPS1|T-R2|T-A2|T-A3|T-B5|T-A4|T-N1|T-M1|T-EP1|T-AC1|T-L3|T-L4|T-L6|T-P5|T-PERF1|T-E2E1)$'; after=@($C0,"C6-reporting-delivery","C15-payment-gateways") },
  @{ name="C17"; chunk="C17-home-collection"; filter='^(HC-T01|HC-T03|HC-T04|HC-T08|HC-T09|HC-T10|HC-T11|HC-T12|HC-T25|HC-T14|HC-T16|HC-T18|HC-T19|HC-T28|HC-T30)$'; after=@($C0,"C4-frontdesk-billing","C5-lab-workflow") },
  @{ name="C17b"; chunk="C17-home-collection"; filter='^(HC-T02|HC-T21|HC-T05|HC-T06|HC-T07|HC-T22|HC-T24|HC-T15|HC-T13|HC-T17|HC-T20|HC-T26|HC-T27|HC-T29)$'; after=@($C0,"C4-frontdesk-billing","C5-lab-workflow") },
  @{ name="C12"; chunk="C12-inventory"; filter='^(T-01|T-02|T-04|T-07|T-08|T-09|T-13|T-14|T-23|T-21|T-16|T-17|T-19|T-20|T-25|T-26)$'; after=@($C0,"C3-catalog-pricing") },
  @{ name="C12b"; chunk="C12-inventory"; filter='^(T-03|T-05|T-06|T-11|T-10|T-12|T-22|T-15|T-18|T-24)$'; after=@($C0,"C3-catalog-pricing") },
  @{ name="C13"; chunk="C13-b2b-partner-portal"; filter='^(T01|T03|T05|T07|T08|T09|T10|T16|T21|T14|T19|T25|T22)$'; after=@($C0,"C4-frontdesk-billing","C6-reporting-delivery") },
  @{ name="C13b"; chunk="C13-b2b-partner-portal"; filter='^(T04|T06|T17|T11|T15|T12|T13|T18|T23|T20)$'; after=@($C0,"C4-frontdesk-billing","C6-reporting-delivery") },
  @{ name="C14"; chunk="C14-smart-report"; filter='^(T01|T03|T05|T10|T11|T09|T12|T16|T14|T17|T25|T22|T24|T27|T28|T29)$'; after=@($C0,"C6-reporting-delivery") },
  @{ name="C14b"; chunk="C14-smart-report"; filter='^(T02|T04|T06|T07|T08|T20|T21|T13|T15|T18|T19|T23|T26)$'; after=@($C0,"C6-reporting-delivery") },
  @{ name="C9"; chunk="C9-quality-engine"; filter='^(T-01|T-02|T-03|T-04|T-05|T-10|T-13|T-20|T-12|T-14|T-21|T-22|T-25|T-24|T-27)$'; after=@($C0,"C5-lab-workflow") },
  @{ name="C9b"; chunk="C9-quality-engine"; filter='^(T-06|T-07|T-08|T-09|T-15|T-11|T-16|T-17|T-23|T-18|T-19|T-26)$'; after=@($C0,"C5-lab-workflow") },
  @{ name="C10"; chunk="C10-microbiology"; filter='^(T-01|T-02|T-05|T-06|T-07|T-08|T-09|T-10|T-15|T-14|T-16|T-18|T-25|T-26)$'; after=@($C0,"C5-lab-workflow") },
  @{ name="C10b"; chunk="C10-microbiology"; filter='^(T-03|T-04|T-11|T-12|T-13|T-24|T-19|T-20|T-21|T-17|T-22|T-23)$'; after=@($C0,"C5-lab-workflow") },
  @{ name="C11"; chunk="C11-specialty-pathology"; filter='^(T-01|T-02|T-03|T-05|T-08|T-09|T-12|T-13|T-14|T-27|T-15|T-18|T-21|T-25|T-26)$'; after=@($C0,"C5-lab-workflow") },
  @{ name="C11b"; chunk="C11-specialty-pathology"; filter='^(T-04|T-06|T-07|T-10|T-11|T-16|T-19|T-20|T-22|T-23|T-24|T-17)$'; after=@($C0,"C5-lab-workflow") },
  @{ name="C2"; chunk="C2-identity-admin"; filter='^(T1|T11|T27|T6|T9|T7|T8|T12|T10|T18|T17|T19|T20|T25|T28|T29)$'; after=@($C0) },
  @{ name="C2b"; chunk="C2-identity-admin"; filter='^(T2|T3|T4|T5|T16|T13|T14|T31|T15|T21|T22|T23|T24|T26|T30|RM-T0[1-5])$'; after=@($C0) },
  @{ name="C7"; chunk="C7-instrument-integration"; filter='^(AG-T01|AG-T02|AG-T04|AG-T05|AG-T06|API-T02|API-T04|API-T14|AG-T11|AG-T10|AG-T13|AG-T17|AG-T14|AG-T12|AG-T15|AG-T16|AG-T18|INT-T01|WEB-T01|WEB-T02|WEB-T03|WEB-T06|WEB-T07)$'; after=@($C0) },
  @{ name="C7b"; chunk="C7-instrument-integration"; filter='^(API-T01|AG-T03|AG-T08|AG-T07|AG-T09|API-T03|API-T07|API-T08|API-T06|API-T05|API-T09|API-T16|API-T10|API-T15|API-T11|API-T12|API-T13|INT-T03|WEB-T05|WEB-T04|H80-T0[1-8])$'; after=@($C0) },
  @{ name="C8"; chunk="C8-analytics-mis"; filter='^(AN-T01|AN-T02|AN-T03|AN-T07|AN-T08|AN-T09|AN-T10|AN-T14|AN-T15|AN-T22|AN-T15b|AN-T16|AN-T21)$'; after=@($C0) },
  @{ name="C8b"; chunk="C8-analytics-mis"; filter='^(AN-T04|AN-T05|AN-T06|AN-T12|AN-T13|AN-T11|AN-T17|AN-T18|AN-T19|AN-T20|AN-T24|AN-T23)$'; after=@($C0) },
  # 2026-11-13 lead: restyle lanes (spec/program/10-DESIGN-SYSTEM.md). Each runs one RS-<chunk> task and starts only after C0 task T0D-UI-R07 is done (need=).
  @{ name="C2r";  chunk="C2-identity-admin";          filter='^RS-C2$';  after=@($C0); need="T0D-UI-R07" },
  @{ name="C3r";  chunk="C3-catalog-pricing";         filter='^RS-C3$';  after=@($C0); need="T0D-UI-R07" },
  @{ name="C4r";  chunk="C4-frontdesk-billing";       filter='^RS-C4$';  after=@($C0); need="T0D-UI-R07" },
  @{ name="C5r";  chunk="C5-lab-workflow";            filter='^RS-C5$';  after=@($C0); need="T0D-UI-R07" },
  @{ name="C6r";  chunk="C6-reporting-delivery";      filter='^RS-C6$';  after=@($C0); need="T0D-UI-R07" },
  @{ name="C7r";  chunk="C7-instrument-integration";  filter='^RS-C7$';  after=@($C0); need="T0D-UI-R07" },
  @{ name="C8r";  chunk="C8-analytics-mis";           filter='^RS-C8$';  after=@($C0); need="T0D-UI-R07" },
  @{ name="C15r"; chunk="C15-payment-gateways";       filter='^RS-C15$'; after=@($C0,"C4-frontdesk-billing"); need="T0D-UI-R07" }

  # C18 stays out: design-only until the eLabs export sample arrives (B4).
)

function Get-Tasks($chunk) {
  $f = Join-Path $StateDir "tasks\$chunk.json"; if (-not (Test-Path $f)) { return $null }
  try { $j = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  foreach ($x in $j) { $x }   # one task per output item: same result in Windows PowerShell 5.1 and PowerShell 7
}
function Finished($chunk, $filter = '.*') {
  $t = Get-Tasks $chunk; if (-not $t) { return $false }
  @($t | Where-Object { $_.id -match $filter -and $_.status -notin @('done','blocked') }).Count -eq 0
}
# gate for "after": a chunk counts as finished for the chunks that wait on it when every task is done or blocked, except leaf tasks nothing else needs yet.
# Those keep running in their own lane while the next chunks start (they still have to reach done before the build is accepted).
$GateIgnore = @{ "C0-foundation-contracts" = @("T0B-11","T0C-10.C9","T0C-10.C10","T0C-10.C11","T0C-10.C12","T0C-10.C13","T0C-10.C14","T0C-10.C15","T0C-10.C16","T0C-10.C17","T0D-12c","T0D-12d","T0D-UI-R01","T0D-UI-R02","T0D-UI-R03","T0D-UI-R04","T0D-UI-R05","T0D-UI-R07"); "C2-identity-admin" = @("RS-C2"); "C3-catalog-pricing" = @("RS-C3"); "C4-frontdesk-billing" = @("RS-C4"); "C5-lab-workflow" = @("RS-C5"); "C6-reporting-delivery" = @("RS-C6"); "C7-instrument-integration" = @("RS-C7"); "C8-analytics-mis" = @("RS-C8"); "C15-payment-gateways" = @("RS-C15") }   # C0: per-tenant billing export + live restore proof (AC-0B-6.4): no task depends on it. RS-*: the restyle passes (LD-140) do not hold up the chunks that wait on these chunks (2026-11-13 lead; without this C9-C17 waited for RS-C3..RS-C15)
# 2026-11-11 lead: wave-2 chunks need their own contracts/openapi file (C0 task T0C-10.Cxx) before a lane may start; GateIgnore keeps these tasks from closing the C0 gate for everyone else
$Wave2Need = @{ "C9-quality-engine"="T0C-10.C9"; "C10-microbiology"="T0C-10.C10"; "C11-specialty-pathology"="T0C-10.C11"; "C12-inventory"="T0C-10.C12"; "C13-b2b-partner-portal"="T0C-10.C13"; "C14-smart-report"="T0C-10.C14"; "C15-payment-gateways"="T0C-10.C15"; "C16-patient-engagement"="T0C-10.C16"; "C17-home-collection"="T0C-10.C17" }
function TaskDone($chunk, $id) { $t = Get-Tasks $chunk; if (-not $t) { return $false }; @($t | Where-Object { $_.id -eq $id -and $_.status -eq 'done' }).Count -eq 1 }
function GateDone($chunk) {
  $t = Get-Tasks $chunk; if (-not $t) { return $false }
  $skip = @($GateIgnore[$chunk])
  @($t | Where-Object { $skip -notcontains $_.id -and $_.status -notin @('done','blocked') }).Count -eq 0
}
# a lead reset file (resets-<chunk>*.json) that names a task of this lane is applied by a running lane of that chunk (run.ps1 Apply-Resets, then deletes the file)
function ResetPending($chunk, $filter) {
  foreach ($f in @(Get-ChildItem -Path $StateDir -Filter "resets-$chunk*.json" -ErrorAction SilentlyContinue)) {
    try { $m = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
    foreach ($p in $m.PSObject.Properties) { if ($p.Name -match $filter) { return $true } }
  }
  return $false
}
# free space on the drive that holds the lane worktrees (native number, GB); -1 when it cannot be read
function FreeGB { try { [math]::Round(([System.IO.DriveInfo]::new($LanesRoot.Substring(0,1))).AvailableFreeSpace / 1GB, 1) } catch { -1 } }
function Blocked($chunk) { $t = Get-Tasks $chunk; if ($t) { @($t | Where-Object { $_.status -eq 'blocked' }).Count } else { 0 } }
# same rules run.ps1 uses to pick its next task: not done/blocked, not owned by another lane (once started), every dependency done
function Runnable($chunk, $filter, $lane) {
  $t = @(Get-Tasks $chunk); if (-not $t.Count) { return $false }
  foreach ($c in $t) {
    if ($c.id -notmatch $filter) { continue }
    if ($c.status -in @('done','blocked')) { continue }
    if ($c.lane -and $c.lane -ne $lane -and $c.status -ne 'todo') { continue }
    $unmet = @(@($c.depends) | Where-Object { $_ } | Where-Object { $d = $_; @($t | Where-Object { $_.id -eq $d -and $_.status -ne 'done' }).Count -gt 0 })
    if ($unmet.Count -eq 0) { return $true }
  }
  return $false
}
# lane windows that are already open (started by an earlier queue) are adopted so a restarted queue never doubles them
function Adopt-Lanes {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'lane-loop\.ps1' } | ForEach-Object {
    if ($_.CommandLine -match '-WorkDir\s+"?([^"\s]+)"?') {
      $leaf = Split-Path -Leaf $Matches[1]
      if (-not $procs.ContainsKey($leaf)) {
        $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($p) { $procs[$leaf] = $p; Q "adopted running lane $leaf (pid $($_.ProcessId))" }
      }
    }
  }
}

$host.UI.RawUI.WindowTitle = "LIMS queue"
$procs = @{}
Q "queue started: $($Queue.Count) lanes defined, max $MaxLanes at once"
while ($true) {
  Set-Location $Integration
  # 1. drop finished / dead lanes, adopt open lane windows
  foreach ($n in @($procs.Keys)) { if ($procs[$n].HasExited) { $procs.Remove($n) } }
  Adopt-Lanes
  # 1b. disk guard: below $MinFreeGB no NEW lane/worktree/planner is started (running lanes keep going); below 50 GB a flag file + window title warn the user
  $free = FreeGB; $lowDisk = ($free -ge 0 -and $free -lt $MinFreeGB)
  $flag = Join-Path $StateDir "DISK-LOW.txt"
  if ($free -ge 0 -and $free -lt 50) {
    Set-Content $flag "$(Get-Date -Format s) only $free GB free on $($LanesRoot.Substring(0,2)). Run: powershell -ExecutionPolicy Bypass -File C:\LIMS\.orchestra\free-space.ps1 -Apply"
    $host.UI.RawUI.WindowTitle = "LIMS queue - DISK LOW $free GB"
  } else { if (Test-Path $flag) { Remove-Item $flag -Force -ErrorAction SilentlyContinue }; $host.UI.RawUI.WindowTitle = "LIMS queue" }
  if ($lowDisk) { Q "DISK LOW: $free GB free (limit $MinFreeGB GB) - not starting new lanes; running lanes continue. To free space: powershell -ExecutionPolicy Bypass -File C:\LIMS\.orchestra\free-space.ps1 -Apply" }
  # 1c. test-hang watchdog (2026-11-11 night): a static test run (python -m unittest) older than 40 min is hung, not slow (one blocked a lane for 1h41m). Kill it so the agent waiting on it continues.
  try {
    foreach ($w in @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '-m unittest' -and $_.CreationDate -lt (Get-Date).AddMinutes(-40) })) {
      Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
      Q "WATCHDOG: killed hung test run pid $($w.ProcessId) started $($w.CreationDate.ToString('s')): $($w.CommandLine.Substring(0, [Math]::Min(120, $w.CommandLine.Length)))"
    }
  } catch { }
  # 2. start lanes that are ready, in priority order, while a slot is free
  $waiting = 0
  foreach ($l in $Queue) {
    if ($procs.ContainsKey($l.name)) { continue }
    $rp = ResetPending $l.chunk $l.filter   # a pending reset needs a running lane to apply it, even when the lane looks finished
    if (-not $rp -and (Finished $l.chunk $l.filter)) { continue }
    $ready = $true; foreach ($a in $l.after) { if (-not (GateDone $a)) { $ready = $false } }
    if (-not $ready) { continue }
    $wn = $Wave2Need[$l.chunk]; if ($wn -and -not (TaskDone "C0-foundation-contracts" $wn)) { continue }   # wave-2 chunk waits for its own contract file
    if ($l.need -and -not (TaskDone "C0-foundation-contracts" $l.need)) { continue }   # restyle lanes wait for the new kit and shell (T0D-UI-R07)
    if (-not $rp -and -not (Runnable $l.chunk $l.filter $l.name)) { $waiting++; continue }   # nothing it could run right now: do not hold a slot
    if ($lowDisk) { break }
    if ($procs.Count -ge $MaxLanes) {
      # reset reserve (lead, 2026-11-13, founder go): a lane with a pending lead reset may take up to $ResetExtra slots beyond $MaxLanes, so a blocked task is not starved behind long lanes.
      # continue, not break: lower-priority reset lanes further down the list must still be considered.
      if (-not ($rp -and $procs.Count -lt ($MaxLanes + $ResetExtra))) { continue }
    }
    $wt = Join-Path $LanesRoot $l.name; $br = "lane/$($l.name)"
    if (-not (Test-Path $wt)) {
      if (git branch --list $br) { git worktree add $wt $br 2>&1 | Out-Null } else { git worktree add $wt -b $br main 2>&1 | Out-Null }
    } else {
      # merge guard (2026-11-11): never start a lane on a half-merged tree. A conflict used to be swallowed silently.
      $mf = $null
      git -C $wt rev-parse -q --verify MERGE_HEAD 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { $mf = "an earlier merge is unfinished (MERGE_HEAD present)" }
      else {
        # self-heal (2026-11-11 night): untracked CR archive files that main already has would block the merge; drop the ones main has
        try {
          foreach ($s in @(git -C $wt status --porcelain 2>$null)) {
            if ($s -match '^\?\? (\.orchestra/cr/\S*\.resolved-\S*)$') {
              $rf = $Matches[1]
              if (Test-Path (Join-Path $Integration $rf)) { Remove-Item (Join-Path $wt $rf) -Force -ErrorAction SilentlyContinue }
            }
          }
        } catch { }
        $mo = git -C $wt merge --no-edit main 2>&1
        if ($LASTEXITCODE -ne 0) {
          # a conflict that touches nothing but .orchestra/cr archive names (rename/rename of resolved CR files) is bookkeeping: keep both names and commit
          $healed = $false
          try {
            git -C $wt rev-parse -q --verify MERGE_HEAD 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
              $un = @(git -C $wt diff --name-only --diff-filter=U 2>$null)
              if ($un.Count -gt 0 -and @($un | Where-Object { $_ -notlike '.orchestra/cr/*' }).Count -eq 0) {
                git -C $wt add -A -- .orchestra/cr 2>&1 | Out-Null
                git -C $wt commit -q --no-edit 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) { $healed = $true; Q "lane $($l.name): merge of main conflicted only in .orchestra/cr archive names - kept both and committed" }
              }
            }
          } catch { }
          if (-not $healed) { git -C $wt merge --abort 2>&1 | Out-Null; $mf = "merge of main failed and was aborted: " + ((@($mo) -join ' ') -replace '\s+', ' ') }
        }
      }
      if ($mf) {
        if (-not $script:MergeWarned) { $script:MergeWarned = @{} }
        if ($script:MergeWarned[$l.name] -ne $mf) { $script:MergeWarned[$l.name] = $mf; Q "LANE $($l.name) NOT STARTED: $mf. Fix by hand: git -C $wt merge main" }
        continue
      }
    }
    $plist = @("-ExecutionPolicy","Bypass","-File","`"$Integration\.orchestra\lane-loop.ps1`"","-Chunk",$l.chunk,
               "-Filter","`"$($l.filter)`"","-WorkDir","`"$wt`"","-Integration","`"$Integration`"","-StateDir","`"$StateDir`"","-ExitWhenFinished","-ExitWhenIdle")
    if ($NoPush) { $plist += "-NoPush" }
    $procs[$l.name] = Start-Process powershell -ArgumentList $plist -PassThru
    Q "started lane $($l.name) ($($l.chunk))"
    Start-Sleep -Seconds 20
  }
  # 2b. plan ahead: chunks still waiting on dependencies get their task list now (planner only, cheap model), so they start instantly later
  foreach ($l in $Queue) {
    if ($procs.Count -ge $MaxLanes -or $lowDisk) { break }
    if (Test-Path (Join-Path $StateDir "tasks\$($l.chunk).json")) { continue }
    $pk = "plan-$($l.chunk)"
    if ($procs.ContainsKey($pk) -or @($procs.Keys | Where-Object { $_ -like 'plan-*' }).Count -ge 2) { continue }   # max 2 planners at once
    if (@($Queue | Where-Object { $_.chunk -eq $l.chunk -and $procs.ContainsKey($_.name) }).Count) { continue }   # lane already running will plan it
    $wt = Join-Path $LanesRoot $l.name; $br = "lane/$($l.name)"
    if (-not (Test-Path $wt)) {
      if (git branch --list $br) { git worktree add $wt $br 2>&1 | Out-Null } else { git worktree add $wt -b $br main 2>&1 | Out-Null }
    }
    $plist = @("-ExecutionPolicy","Bypass","-File","`"$Integration\.orchestra\run.ps1`"","-Chunk",$l.chunk,"-WorkDir","`"$wt`"","-StateDir","`"$StateDir`"","-PlanOnly","-NoPush")
    $procs[$pk] = Start-Process powershell -ArgumentList $plist -PassThru
    Q "planning ahead: $($l.chunk)"
    Start-Sleep -Seconds 20
  }
  # 3. status line
  $done = @($Queue | Where-Object { Finished $_.chunk $_.filter }).Count
  $bl = ($Queue | ForEach-Object { $_.chunk } | Select-Object -Unique | ForEach-Object { Blocked $_ } | Measure-Object -Sum).Sum
  Q "lanes running: $($procs.Count) [$(($procs.Keys) -join ', ')] | finished lanes: $done/$($Queue.Count) | blocked tasks: $bl | ready but waiting on task dependencies: $waiting | free on C: $free GB"
  if ($done -eq $Queue.Count) { Q "ALL QUEUED CHUNKS FINISHED. Review blocked tasks, then merge/push."; break }
  Start-Sleep -Seconds ($EveryMinutes * 60)
}
