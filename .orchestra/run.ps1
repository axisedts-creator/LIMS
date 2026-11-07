<#
  LIMS agent orchestra: tester -> writer -> verify -> debugger -> reviewer, one task at a time per lane.
  Single lane :  powershell -ExecutionPolicy Bypass -File C:\LIMS\.orchestra\run.ps1 -Chunk C0-foundation-contracts
  Parallel    :  use supervisor.ps1 (it runs this script once per lane, each in its own git worktree).
  Safe to stop and re-run: progress lives in the shared state folder (default C:\LIMS-state).
#>
param(
  [string]$Chunk = "C0-foundation-contracts",
  [string]$Filter = ".*",                 # regex on task id, e.g. '^T0A-' for one C0 workstream
  [string]$WorkDir = "",                  # git worktree to work in (default: repo that holds this script)
  [string]$StateDir = "C:\LIMS-state",    # shared by all lanes: task list + locks + main log
  [string]$Integration = "",              # repo whose 'main' collects finished work (lanes only)
  [int]$MaxDebugRounds = 3,
  [switch]$PlanOnly,                      # plan the chunk (write its task list) and exit
  [int]$LimitWaitMinutes = 10,
  [switch]$NoPush
)

$ErrorActionPreference = "Continue"
$Kit  = $PSScriptRoot
$Root = if ($WorkDir) { $WorkDir } else { Split-Path -Parent $PSScriptRoot }
Set-Location $Root
$O = Join-Path $Root ".orchestra"
foreach ($d in "notes","out","cr","inbox","logs","tasks") { New-Item -ItemType Directory -Force -Path (Join-Path $O $d) | Out-Null }
foreach ($d in "tasks","locks","logs") { New-Item -ItemType Directory -Force -Path (Join-Path $StateDir $d) | Out-Null }
$Lane = (Split-Path -Leaf $Root)

$Cfg = @{
  planner  = @{ model = "sonnet"; turns = 40 }
  tester   = @{ model = "sonnet"; turns = 40 }
  writer   = @{ model = "opus";   turns = 80 }
  debugger = @{ model = "sonnet"; turns = 40 }
  reviewer = @{ model = "opus";   turns = 25 }
  arbiter  = @{ model = "opus";   turns = 25 }
  lead     = @{ model = "opus";   turns = 20 }
}
$Allowed = "Read,Edit,Write,Bash(pnpm *),Bash(npm *),Bash(npx *),Bash(node *),Bash(git status*),Bash(git diff*),Bash(git log*),Bash(go *),Bash(docker *),Bash(supabase *),Bash(psql *),Bash(ls*),Bash(cat *),Bash(grep *),Bash(find *),Bash(mkdir *),Bash(python *),Bash(py *),Bash(pip *),Bash(bash *),Bash(flutter *),Bash(dart *),Bash(yamllint *),Bash(gitleaks *),Bash(ansible-lint *)"
$TestExempt = '^(infra/tests/run\.sh$|db/tests/isolation/)'   # deliverable scripts that live in test folders (writer/debugger own them)
$TestPat = '(__tests__/|\.test\.|\.spec\.|_test\.go$|_test\.py$|(^|/)tests?/|(^|/)test_[^/]+\.py$)'
$TasksFile = Join-Path $StateDir "tasks\$Chunk.json"

function Log($m) {
  $line = "$(Get-Date -Format s) [$Chunk/$Lane] $m"; Write-Host $line
  Add-Content (Join-Path $StateDir "logs\$Chunk.log") $line
}
function Lock([string]$name) {
  $p = Join-Path $StateDir "locks\$name.lock"
  for ($i = 0; $i -lt 1200; $i++) {
    try { $fs = [System.IO.File]::Open($p,'CreateNew','Write','None'); $w = New-Object System.IO.StreamWriter($fs); $w.Write("$PID"); $w.Close(); return $p }
    catch {
      $owner = (Get-Content $p -ErrorAction SilentlyContinue | Select-Object -First 1)
      $age = ((Get-Date) - (Get-Item $p -ErrorAction SilentlyContinue).LastWriteTime).TotalSeconds
      if ($age -gt 60 -and (-not $owner -or -not (Get-Process -Id ([int]$owner) -ErrorAction SilentlyContinue))) { Log "removing stale lock $name"; Remove-Item -Force $p -ErrorAction SilentlyContinue; continue }
      Start-Sleep -Milliseconds 500 }
  }
  Log "lock $name stuck - delete $p if no other window uses it"; exit 1
}
function Unlock($p) { Remove-Item -Force $p -ErrorAction SilentlyContinue }

function Get-Tasks { Get-Content $TasksFile -Raw -Encoding UTF8 | ConvertFrom-Json }
function Set-Status([string]$id, [string]$status, [int]$reviewRounds = -1) {
  $l = Lock "tasks-$Chunk"
  try {
    $all = Get-Tasks
    foreach ($x in $all) { if ($x.id -eq $id) {
      $x | Add-Member -Force status $status
      if ($reviewRounds -ge 0) { $x | Add-Member -Force reviewRounds $reviewRounds }
      $x | Add-Member -Force lane $Lane } }
    $all | ConvertTo-Json -Depth 6 | Set-Content $TasksFile -Encoding UTF8
  } finally { Unlock $l }
}

function Invoke-Agent([string]$Role, [string]$TaskId, [string]$Brief) {
  $roleText = (Get-Content (Join-Path $Kit "roles\$Role.md") -Raw).Replace("{CHUNK}",$Chunk).Replace("{TASK}",$TaskId).Replace("{BASE}","$script:Base")
  Set-Content -Path (Join-Path $O "inbox\$TaskId-$Role.md") -Value ($roleText + "`n`n## Task brief`n" + $Brief) -Encoding UTF8
  $rel = ".orchestra/inbox/$TaskId-$Role.md"
  $common = @("--output-format","json","--model",$Cfg[$Role].model,"--max-turns","$($Cfg[$Role].turns)","--permission-mode","acceptEdits","--allowedTools",$Allowed)
  $session = $null; $tries = 0; $waits = 0
  $errf = Join-Path $O "logs\stderr-$TaskId-$Role.log"
  while ($true) {
    $tries++
    # prompt goes right after -p: --allowedTools takes a list and would swallow a prompt placed after it
    if ($session) { $run = @("-p","Continue the task in $rel from where you stopped.","--resume",$session) + $common }
    else          { $run = @("-p","Read $rel and do exactly what it says. Reply in at most 6 lines.") + $common }
    $raw = (& claude @run 2> $errf | Out-String)
    $code = $LASTEXITCODE
    $err = (Get-Content $errf -Raw -ErrorAction SilentlyContinue)
    Add-Content (Join-Path $O "logs\agents.log") "---- $(Get-Date -Format s) $Role $TaskId try $tries exit $code`nSTDOUT: $raw`nSTDERR: $err"
    $j = $null; try { $j = $raw | ConvertFrom-Json } catch {}
    if ($j -and $j.session_id) { $session = $j.session_id }
    if ($code -eq 0 -and $j -and -not $j.is_error) { return $true }
    if (("$raw $err") -match '(?i)usage limit|rate.?limit|\b429\b|overloaded|limit reached|out of (extra )?usage') {
      $waits++; if ($waits -gt 100) { Log "$Role $TaskId still limited - giving up for now"; return $false }
      Log "$Role $TaskId usage limit - waiting $LimitWaitMinutes min, then resuming the same session"
      Start-Sleep -Seconds ($LimitWaitMinutes*60); $tries--; continue
    }
    if ($j -and $j.subtype -eq "error_max_turns" -and $tries -lt 3) { Log "$Role $TaskId ran out of turns - resuming"; continue }
    if ($tries -ge 2) {
      $txt = "$err $raw".Trim(); $why = $txt.Substring(0, [Math]::Min(300, $txt.Length)) -replace "`r?`n",' | '
      Log "$Role $TaskId failed twice: $why"; return $false
    }
    Start-Sleep -Seconds 30
  }
}

function Changed() { (git status --porcelain -uall) | ForEach-Object { ($_.Substring(3)).Trim('"') -replace '\\','/' } }
function Enforce([string]$Role) {
  foreach ($f in Changed) {
    if ($f -like "spec/*") { $ok = $false }
    elseif ($f -like ".orchestra/*") { $ok = ($f -like ".orchestra/notes/*" -or $f -like ".orchestra/cr/*" -or $f -like ".orchestra/tasks/*") }
    else {
      $isTest = ($f -match $TestPat) -and ($f -notmatch $TestExempt)
      switch ($Role) { "tester" { $ok = $isTest } "writer" { $ok = -not $isTest } "debugger" { $ok = -not $isTest } default { $ok = $false } }
    }
    if (-not $ok) {
      Log "REVERT ($Role may not touch): $f"
      git checkout -- "$f" 2>$null
      if ((Test-Path $f) -and -not (git ls-files -- "$f")) { Remove-Item -Recurse -Force "$f" }
    }
  }
}
function Commit([string]$msg) { git add -A | Out-Null; git commit -q -m $msg 2>$null | Out-Null }

function Verify($t) {
  $log = Join-Path $O "out\$($t.id)-verify.log"
  # each task is verified by ITS OWN tests only (a broken neighbour task must not fail this one)
  $vf = Join-Path $O "notes\$($t.id)-verify.cmd"
  if (-not (Test-Path $vf)) {
    $null = Invoke-Agent "tester" $t.id ("Write ONE line to .orchestra/notes/$($t.id)-verify.cmd: a Windows cmd.exe command that runs ONLY the tests you wrote for $($t.id) and exits non-zero on failure. No other changes. For shell scripts use `"C:\Program Files\Git\bin\bash.exe`" <script>.")
    Enforce "tester"; Commit "[tester] $($t.id) verify command"
  }
  $cmd = if (Test-Path $vf) { (Get-Content $vf -TotalCount 1).Trim() } elseif ($t.verify) { $t.verify } else { "pnpm -s verify" }
  if (-not (Test-Path "package.json") -and $cmd -like "pnpm*") { Set-Content $log "no package.json yet"; return $true }
  cmd /c "$cmd > `"$log`" 2>&1"; $pass = ($LASTEXITCODE -eq 0)
  Set-Content $log (Get-Content $log -Tail 200); return $pass
}

function Integrate([string]$id) {
  if (-not $Integration) {
    if (-not $NoPush -and (git remote)) { git push -q origin HEAD 2>$null; if ($LASTEXITCODE -ne 0) { Log "push failed (GitHub login?) - work is safe locally" } }
    return
  }
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $l = Lock "merge"
  try {
    git -C $Integration merge --no-edit $branch 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { git -C $Integration merge --abort 2>$null; Log "MERGE CONFLICT integrating $id from $branch - left for human"; return }
    if (-not $NoPush) { git -C $Integration push -q origin main 2>$null; if ($LASTEXITCODE -ne 0) { Log "push failed (GitHub login?) - work is safe locally" } }
  } finally { Unlock $l }
  git merge --no-edit main 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { git merge --abort 2>$null; Log "could not merge main into $branch - left for human" }
}

# ---------------- main ----------------
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Log "'claude' not found in this window - install Claude Code or reopen PowerShell"; exit 1 }
if (-not (Test-Path ".git")) { Log "$Root is not a git repo/worktree"; exit 1 }
$laneLock = Lock "lane-$Lane"
try {
  if (-not (Test-Path $TasksFile)) {
    $pl = Lock "plan-$Chunk"
    try {
      if (-not (Test-Path $TasksFile)) {
        Log "planning $Chunk"
        if (-not (Invoke-Agent "planner" "$Chunk-plan" "Chunk folder: spec/chunks/$Chunk/")) { Log "planner failed - see $O\logs\agents.log"; exit 1 }
        $out = Join-Path $O "tasks\$Chunk.json"
        if (-not (Test-Path $out)) { Log "planner wrote no task file"; exit 1 }
        $all = Get-Content $out -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($x in $all) { $x | Add-Member -Force status "todo" }
        $all | ConvertTo-Json -Depth 6 | Set-Content $TasksFile -Encoding UTF8
        Enforce "planner"; Commit "[planner] $Chunk tasks"
        Log "planned $(@($all).Count) tasks"
      }
    } finally { Unlock $pl }
  }
  if ($PlanOnly) { Log "plan-only: done"; exit 0 }

  # lead/human resets: C:\LIMS-state\resets-<chunk>.json = {"TASK-ID":"status", ...}; applied once under the lock
  $rs = Join-Path $StateDir "resets-$Chunk.json"
  if (Test-Path $rs) {
    $l = Lock "tasks-$Chunk"
    try {
      $map = Get-Content $rs -Raw -Encoding UTF8 | ConvertFrom-Json; $all = Get-Tasks
      foreach ($p in $map.PSObject.Properties) { $x = $all | Where-Object { $_.id -eq $p.Name }; if ($x) {
        $v = $p.Value; $st = if ($v -is [string]) { $v } else { $v.status }
        if ($v -isnot [string] -and $v.depends) { $x | Add-Member -Force depends (@(@($x.depends) + @($v.depends) | Where-Object { $_ } | Select-Object -Unique)) }
        $x | Add-Member -Force status $st; $x | Add-Member -Force reviewRounds 0; Log "reset $($p.Name) -> $st"
        # a lead reset means the lead has ruled: archive any open blocking CR so it does not re-block (searched in every lane)
        Get-ChildItem -Path (Join-Path (Split-Path $WorkDir -Parent) "*\.orchestra\cr\$($p.Name).md") -ErrorAction SilentlyContinue | ForEach-Object { Move-Item -Force $_.FullName ($_.FullName -replace '\.md$', ".resolved-$(Get-Date -Format yyyyMMddHHmm).md"); Log "archived CR $($_.FullName)" }
      } }
      $all | ConvertTo-Json -Depth 6 | Set-Content $TasksFile -Encoding UTF8
      Remove-Item -Force $rs
    } finally { Unlock $l }
  }
  while ($true) {
    $all = Get-Tasks; $t = $null
    foreach ($c in $all) {
      if ($c.id -notmatch $Filter) { continue }
      if ($c.status -in @("done","blocked")) { continue }
      if ($c.lane -and $c.lane -ne $Lane -and $c.status -ne "todo") { continue }
      $unmet = @(@($c.depends) | Where-Object { $_ } | Where-Object { $d = $_; @($all | Where-Object { $_.id -eq $d -and $_.status -ne "done" }).Count -gt 0 })
      if ($unmet.Count -gt 0) { continue }
      $t = $c; break
    }
    if (-not $t) { Log "nothing runnable for '$Filter' right now (done, blocked, or waiting on other lanes)"; break }
    Set-Status $t.id ($t.status)
    if ($Integration) { git merge --no-edit main 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { git merge --abort 2>$null } }   # start from everyone's latest work
    $script:Base = (git rev-parse HEAD).Trim()
    $brief = ($t | Select-Object id,title,files,done_when,tests,acs | ConvertTo-Json -Depth 4) + "`nPlan: spec/chunks/$Chunk/06-IMPLEMENTATION-PLAN.md (row $($t.id)). PRD: spec/chunks/$Chunk/01-PRD.md. Security: spec/chunks/$Chunk/07-SECURITY.md."
    $ld = Join-Path $StateDir "lead-decisions.md"
    if (Test-Path $ld) { $hit = @(Select-String -Path $ld -Pattern ("(^|[^A-Za-z0-9-])" + [regex]::Escape($t.id) + "([^A-Za-z0-9-]|$)") | ForEach-Object { $_.Line }); if ($hit.Count) { $brief += "`n`nLEAD DECISIONS (binding; they override the spec text for this task; cite them in code comments):`n" + ($hit -join "`n") } }
    Log "START $($t.id) $($t.title)"
    $st = $t.status; $rr = [int]$t.reviewRounds

    if ($st -eq "todo") {
      if (-not (Invoke-Agent "tester" $t.id $brief)) { Set-Status $t.id "blocked"; continue }
      Enforce "tester"; Commit "[tester] $($t.id) tests"; $st = "tested"; Set-Status $t.id $st
    }
    if ($st -eq "tested") {
      if (-not (Invoke-Agent "writer" $t.id $brief)) { Set-Status $t.id "blocked"; continue }
      Enforce "writer"; Commit "[writer] $($t.id) impl"; $st = "implemented"; Set-Status $t.id $st
    }
    $crf = Join-Path $O "cr\$($t.id).md"
    if (Test-Path $crf) {
      if ((Get-Content $crf -Raw) -match '(?im)^\s*Blocking\?\s*no') {
        Move-Item -Force $crf (Join-Path $O "cr\$($t.id).nonblocking.md"); Commit "[orchestra] $($t.id) non-blocking CR queued for lead"
        Log "$($t.id) raised a NON-blocking CR (queued for lead) - continuing"
      } else {
        # lead agent rules on clear-cut CRs (roles/lead.md); anything else, or a 2nd CR on the same task, goes to the human
        $prev = @(Get-ChildItem (Join-Path $O "notes\$($t.id)-lead-*.md") -ErrorAction SilentlyContinue).Count
        if ($prev -ge 2 -or -not (Invoke-Agent "lead" $t.id $brief)) { Log "$($t.id) blocking CR - human"; Set-Status $t.id "blocked"; continue }
        Enforce "lead"
        $lf = Join-Path $O "notes\$($t.id)-lead.md"
        $lv = if (Test-Path $lf) { @(Get-Content $lf -TotalCount 2) } else { @("ESCALATE") }
        $verdict = $lv[0].Trim()
        Move-Item -Force $lf (Join-Path $O "notes\$($t.id)-lead-$(Get-Date -Format yyyyMMddHHmmss).md") -ErrorAction SilentlyContinue
        if ($verdict -match '^APPROVED_(RETEST|REWRITE)' -and $lv.Count -ge 2 -and $lv[1].Trim()) {
          $dl = Lock "lead-decisions"
          try { Add-Content (Join-Path $StateDir "lead-decisions.md") "- AUTO $(Get-Date -Format s) [lead agent; human reviews at next check] $($t.id): $($lv[1].Trim())" -Encoding UTF8 } finally { Unlock $dl }
          Move-Item -Force $crf (Join-Path $O "cr\$($t.id).resolved-$(Get-Date -Format yyyyMMddHHmm).md")
          Commit "[lead] $($t.id) $verdict"
          $ns = if ($verdict -match 'RETEST') { "todo" } else { "tested" }
          Log "$($t.id) CR auto-ruled $verdict -> $ns"; Set-Status $t.id $ns 0; continue
        }
        Commit "[lead] $($t.id) ESCALATE"; Log "$($t.id) blocking CR - lead agent escalated to human"; Set-Status $t.id "blocked"; continue
      }
    }
    $disp = Join-Path $O "notes\$($t.id)-dispute.md"
    if (Test-Path $disp) {
      # reviewer arbitrates against the spec; a wrong test is fixed by the tester, never by the writer
      Log "$($t.id) test dispute - reviewer arbitrates"
      if (-not (Invoke-Agent "arbiter" $t.id $brief)) { Set-Status $t.id "blocked"; continue }
      Enforce "reviewer"
      $rf = Join-Path $O "notes\$($t.id)-ruling.md"
      $ruling = if (Test-Path $rf) { (Get-Content $rf -TotalCount 1).Trim() } else { "" }
      Move-Item -Force $disp (Join-Path $O "notes\$($t.id)-dispute-$(Get-Date -Format yyyyMMddHHmm).md")
      Commit "[arbiter] $($t.id) $ruling"
      if ($ruling -match "^TESTS_WRONG") {
        if (-not (Invoke-Agent "tester" $t.id ($brief + "`nRevise your tests per .orchestra/notes/$($t.id)-ruling.md. Change only what the ruling says."))) { Set-Status $t.id "blocked"; continue }
        Enforce "tester"; Commit "[tester] $($t.id) tests revised per ruling"
        if (-not (Invoke-Agent "writer" $t.id $brief)) { Set-Status $t.id "blocked"; continue }
        Enforce "writer"; Commit "[writer] $($t.id) impl after ruling"
      } elseif ($ruling -match "^IMPLEMENTATION_WRONG") {
        if (-not (Invoke-Agent "writer" $t.id ($brief + "`nThe tests stand: read .orchestra/notes/$($t.id)-ruling.md and make them pass."))) { Set-Status $t.id "blocked"; continue }
        Enforce "writer"; Commit "[writer] $($t.id) impl per ruling"
      } else { Log "$($t.id) ruling '$ruling' - needs a human (see notes\$($t.id)-ruling.md)"; Set-Status $t.id "blocked"; continue }
      if (Test-Path $disp) { Log "$($t.id) disputed again after ruling - human"; Set-Status $t.id "blocked"; continue }
      $st = "implemented"; Set-Status $t.id $st
    }
    $round = 0
    while ($st -in @("implemented","changes")) {
      if ($st -eq "changes") {
        $fb = "`nRead .orchestra/notes/$($t.id)-review.md (and .orchestra/notes/$($t.id)-ruling.md if it exists)."
        if (-not (Invoke-Agent "tester" $t.id ($brief + $fb + " Apply ONLY the items that concern test files; if none, change nothing."))) { $st = "blocked"; break }
        Enforce "tester"; Commit "[tester] $($t.id) review fixes (tests)"
        if (-not (Invoke-Agent "writer" $t.id ($brief + $fb + " Apply every item that concerns implementation files; test items were handled by the tester."))) { $st = "blocked"; break }
        Enforce "writer"; Commit "[writer] $($t.id) review fixes"
      }
      $pass = Verify $t
      while (-not $pass -and $round -lt $MaxDebugRounds) {
        $round++; Log "$($t.id) verify failed - debugger round $round"
        if (-not (Invoke-Agent "debugger" $t.id $brief)) { break }
        Enforce "debugger"; Commit "[debugger] $($t.id) round $round"; $pass = Verify $t
      }
      if (-not $pass) { Log "$($t.id) still failing - blocked"; $st = "blocked"; break }
      if (-not (Invoke-Agent "reviewer" $t.id $brief)) { $st = "blocked"; break }
      Enforce "reviewer"; Commit "[reviewer] $($t.id)"
      $rf = Join-Path $O "notes\$($t.id)-review.md"
      $verdict = if (Test-Path $rf) { (Get-Content $rf -TotalCount 1).Trim() } else { "" }
      if ($verdict -eq "APPROVE") { $st = "done" }
      elseif ($rr -ge 2) { Log "$($t.id) not approved after 2 review rounds - blocked"; $st = "blocked" }
      else { $rr++; $st = "changes"; Set-Status $t.id $st $rr }
    }
    Set-Status $t.id $st $rr
    Log "END $($t.id) -> $st"
    if ($st -eq "done") { Integrate $t.id }
  }
}
finally { Unlock $laneLock }
