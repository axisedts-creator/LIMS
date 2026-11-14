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
# PATH refresh: add Machine/User PATH entries that were installed after this lane process started (e.g. Go), so no lane restart is needed
try {
  $regPath = @([Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User')) -join ';'
  $havePath = @($env:PATH -split ';' | Where-Object { $_ })
  $addPath = @($regPath -split ';' | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) } | Where-Object { $havePath -notcontains $_ })
  if ($addPath.Count) { $env:PATH = (($havePath + $addPath) -join ';') }
} catch { }
# tool PATH for agents + verify: Git Bash before C:\Windows\System32\bash.exe (WSL launcher), Flutter/Dart, pip --user Scripts
$extra = @("C:\Program Files\Git\bin","C:\Program Files\Git\usr\bin","C:\flutter\bin") + @(Get-ChildItem "$env:APPDATA\Python\Python*\Scripts" -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
$env:PATH = ((@($extra | Where-Object { Test-Path $_ })) -join ';') + ';' + $env:PATH
# optional API-key fuel (user-approved 2026-11-10): ANTHROPIC_API_KEY set in the queue window makes every `claude -p` bill that key. When its credit runs out the agent call fails with
# 'credit balance is too low'; the code in Invoke-Agent then writes this flag, drops the key for this process and carries on with the subscription login. Delete the flag file to use a refilled key again.
$script:CreditFlag = Join-Path $StateDir 'api-credit-exhausted.flag'
$script:VerifyTimeoutMin = 30   # minutes a task's verify command may run before it is killed and counted as failed
if ($env:ANTHROPIC_API_KEY -and (Test-Path $script:CreditFlag)) { Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue }
# writer model cascade (user-approved 2026-11-07 22:24): first implementation pass = Sonnet with --effort high (only if this claude CLI has --effort); chunks C0 and C2 (auth, tenant isolation) keep Opus; every rework pass (after a ruling or review CHANGES) is Opus
$script:EffortOk = $false
try { $script:EffortOk = ([bool]((& claude --help 2>&1 | Out-String) -match '--effort')) } catch { }
$script:FirstWriterModel = if ($Chunk -match '^(C0|C2)-') { '' } else { 'sonnet' }
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
  merger   = @{ model = "opus";   turns = 40 }
}
if (Test-Path 'C:\ProgramData\mingw64\mingw64\bin\gcc.exe') { if ($env:Path -notlike '*mingw64\mingw64\bin*') { $env:Path = 'C:\ProgramData\mingw64\mingw64\bin;' + $env:Path }; if ($env:CGO_ENABLED -eq '0') { $env:CGO_ENABLED = '1' } }   # 2026-11-11 lead: gcc (choco mingw) for go test -race, which needs cgo; lane windows started before the install carry a stale PATH, so every pass puts it back
# 2026-11-11 lead: Git's usr\bin precedes System32 on PATH, so Go tests that exec "whoami" got Git's (prints rauna) instead of Windows' (prints raunak\rauna) and AG-T15's icacls tests failed. A shim dir holding only the Windows whoami.exe goes first on PATH; no other tool changes order.
$wsh = 'C:\LIMS-state\shim'; try { if (-not (Test-Path "$wsh\whoami.exe")) { New-Item -ItemType Directory -Force $wsh | Out-Null; Copy-Item "$env:SystemRoot\System32\whoami.exe" "$wsh\whoami.exe" -Force }; if ($env:Path -notlike "*$wsh*") { $env:Path = "$wsh;" + $env:Path } } catch { }
$Allowed = "Read,Edit,Write,WebFetch,WebSearch,Bash(pnpm *),Bash(npm *),Bash(npx *),Bash(node *),Bash(git status*),Bash(git diff*),Bash(git log*),Bash(go *),Bash(docker *),Bash(supabase *),Bash(psql *),Bash(ls*),Bash(cat *),Bash(grep *),Bash(find *),Bash(mkdir *),Bash(python *),Bash(py *),Bash(pip *),Bash(bash *),Bash(flutter *),Bash(dart *),Bash(yamllint *),Bash(gitleaks *),Bash(ansible-lint *),Bash(curl *),Bash(sha256sum *),Bash(git ls-remote *),Bash(git clone *),Bash(tar *),Bash(atlas *),Bash(git rm *),Bash(git mv *),Bash(cd *),Bash(/c/flutter/bin/flutter *),Bash(/c/flutter/bin/dart *)"
$TestExempt = '^(infra/tests/run\.sh$|db/tests/isolation/|.*/__tests__/probes/pending\.json$|infra/tests/load/flood\.js$|infra/tests/internal/(egress_probe\.sh|container_hardening\.py)$|tests/load/(reporting-load\.js|README\.md)$|tests/e2e/(reporting-journey\.e2e\.ts|README\.md)$|apps/web/src/features/billing/__tests__/copy-scan\.mjs$|services/api/src/modules/payments/__tests__/sim/(esewa|khalti)\.sim\.ts$)'   # deliverables that live in test folders (writer/debugger own them): run.sh, isolation helpers, the generated stub inventory probes/pending.json; C1 probes/load script (lead-approved 2026-11-11, they were silently reverted): flood.js, egress_probe.sh, container_hardening.py
$TestNamePat = '(\.test\.|\.spec\.|_test\.go$|_test\.py$|(^|/)test_[^/]+\.py$|__tests__/|(^|/)conftest\.py$)'
$TestPat = '(__tests__/|\.test\.|\.spec\.|_test\.go$|_test\.py$|(^|/)tests?/|(^|/)test_[^/]+\.py$)'
$TasksFile = Join-Path $StateDir "tasks\$Chunk.json"
# task ids repeat across chunks (T-01..T-35 in C1/C3/C5/C9-C12/C16, T01.. in C2/C13/C14) while .orchestra\notes and \cr travel between lanes through git.
# A shared id therefore gets a chunk-qualified FILE KEY (C3.T-07) in every notes/cr/inbox file name and as {TASK} in the role texts (2026-11-08).
$script:ChunkTag = ($Chunk -split '-')[0]
$script:SharedIds = @{}
try {
  $idCount = @{}
  foreach ($tf in @(Get-ChildItem (Join-Path $StateDir "tasks") -Filter "*.json" -ErrorAction SilentlyContinue)) {
    $tj = Get-Content $tf.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($tx in $tj) { if ($tx.id) { $idCount[[string]$tx.id] = 1 + [int]$idCount[[string]$tx.id] } }
  }
  foreach ($k in @($idCount.Keys)) { if ($idCount[$k] -ge 2) { $script:SharedIds[$k] = $true } }
} catch { }
function FK([string]$id) { if ($script:SharedIds.ContainsKey($id)) { "$($script:ChunkTag).$id" } else { $id } }

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

function Invoke-Agent([string]$Role, [string]$TaskId, [string]$Brief, [string]$ModelOverride = "", [string]$Effort = "") {
  $roleText = (Get-Content (Join-Path $Kit "roles\$Role.md") -Raw).Replace("{CHUNK}",$Chunk).Replace("{TASK}",$TaskId).Replace("{BASE}","$script:Base")
  Set-Content -Path (Join-Path $O "inbox\$TaskId-$Role.md") -Value ($roleText + "`n`n## Task brief`n" + $Brief) -Encoding UTF8
  $rel = ".orchestra/inbox/$TaskId-$Role.md"
  $mdl = if ($ModelOverride) { $ModelOverride } else { $Cfg[$Role].model }
  $common = @("--output-format","json","--model",$mdl,"--max-turns","$($Cfg[$Role].turns)","--permission-mode","acceptEdits","--allowedTools",$Allowed)
  if ($Effort -and $script:EffortOk) { $common = @("--effort",$Effort) + $common }
  $session = $null; $tries = 0; $waits = 0
  $errf = Join-Path $O "logs\stderr-$TaskId-$Role.log"
  while ($true) {
    $tries++
    # switch-back: the flag file (written by the credit check below, or by hand) drops the API key before every agent call
    if ($env:ANTHROPIC_API_KEY -and (Test-Path $script:CreditFlag)) { Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue }
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
    # API key out of credit: fall back to the subscription login right away (no wait, no failed try) and remember it for the next passes
    $credRx = '(?i)credit balance|insufficient (credit|funds)|spend limit|specified API usage limits'
    if ($env:ANTHROPIC_API_KEY -and ((("$err" -match $credRx)) -or (("$raw" -match '"is_error"\s*:\s*true') -and ("$raw" -match $credRx)))) {
      Log "$Role $TaskId API credit exhausted - dropping ANTHROPIC_API_KEY, continuing on the subscription login"
      try { Set-Content -Path $script:CreditFlag -Value (Get-Date -Format s) } catch { }
      Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue; $tries--; continue
    }
    # only a real API/CLI error counts as a usage limit: stderr, or an is_error JSON result - never words in the agent's own work
    # (e.g. a task about nginx "rate-limit zones" must not trigger a 10-minute wait)
    $limRx = '(?i)usage limit|rate.?limit|\b429\b|overloaded|limit reached|out of (extra )?usage|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|connection_failed|reach the API server|Failed to authenticate|Attention Required|Cloudflare'
    if (("$err" -match $limRx) -or (("$raw" -match '"is_error"\s*:\s*true') -and ("$raw" -match $limRx))) {
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
      # a NEW non-test-named file inside a test folder (helper script, checker, generated probe) is a writer deliverable;
      # tracked files in test folders and every test-named file stay tester-only
      $isTestName = $f -match $TestNamePat
      $isNew = -not (git ls-files -- "$f")
      $writerOk = (-not $isTest) -or ($isNew -and -not $isTestName)
      switch ($Role) { "tester" { $ok = $isTest } "writer" { $ok = $writerOk } "debugger" { $ok = $writerOk } "merger" { $ok = $true } default { $ok = $false } }
    }
    if (-not $ok) {
      Log "REVERT ($Role may not touch): $f"
      git checkout -- "$f" 2>$null
      if ((Test-Path $f) -and -not (git ls-files -- "$f")) { Remove-Item -Recurse -Force "$f" }
    }
  }
}
function Commit([string]$msg) { git add -A 2>&1 | Out-Null; $o = "$(git commit -q -m $msg 2>&1)"; if (@(git status --porcelain | Where-Object { $_ -notmatch '\.orchestra/' }).Count) { Log "COMMIT LEFT DIRTY after '$msg': $($o.Substring(0,[Math]::Min(200,$o.Length)))" } }

function Get-VerifyCmd([string]$vf) {
  # first REAL command line, never a REM/:: comment (a merged file once began with "REM C3 T-02" and "passed" without running any test)
  if (-not (Test-Path $vf)) { return $null }
  $vl = @(Get-Content $vf -Encoding UTF8 | ForEach-Object { "$_".Trim() } | Where-Object { $_ -and $_ -notmatch '(?i)^(rem(\s|$)|::)' })
  if ($vl.Count) { return $vl[0] } else { return $null }
}

function Verify($t) {
  $tk = FK $t.id
  $log = Join-Path $O "out\$($t.id)-verify.log"
  # each task is verified by ITS OWN tests only (a broken neighbour task must not fail this one)
  $vf = Join-Path $O "notes\$($tk)-verify.cmd"
  $cmd = Get-VerifyCmd $vf
  if (-not $cmd) {
    $null = Invoke-Agent "tester" $tk ("Write ONE line to .orchestra/notes/$($tk)-verify.cmd: a Windows cmd.exe command that runs ONLY the tests you wrote for $($t.id) and exits non-zero on failure. No other changes. For shell scripts use `"C:\Program Files\Git\bin\bash.exe`" <script>.")
    Enforce "tester"; Commit "[tester] $($t.id) verify command"
    $cmd = Get-VerifyCmd $vf
  }
  if (-not $cmd) { $cmd = if ($t.verify) { $t.verify } else { "pnpm -s verify" } }
  if (-not (Test-Path "package.json") -and $cmd -like "pnpm*") { Set-Content $log "no package.json yet"; return $true }
  # hard time limit (user-approved 2026-11-11): a verify that never exits (e.g. a dev server left running by Playwright) used to hold the lane for hours
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = (Get-Location).Path
  $psi.Arguments = '/c "(' + $cmd + ') > "' + $log + '" 2>&1"'   # cmd strips the outer quotes; parentheses: the redirect must cover EVERY command of an && / || chain, not only the last one
  $vp = [System.Diagnostics.Process]::Start($psi)
  if ($vp.WaitForExit($script:VerifyTimeoutMin * 60000)) { $vp.WaitForExit(); $pass = ($vp.ExitCode -eq 0) }
  else { & taskkill /PID $vp.Id /T /F 2>&1 | Out-Null; $pass = $false; Add-Content $log "VERIFY TIMEOUT: killed after $($script:VerifyTimeoutMin) min"; Log "$($t.id) verify timed out after $($script:VerifyTimeoutMin) min - killed" }
  Set-Content $log (Get-Content $log -Tail 200)
  if ($pass -and (Get-Item $log).Length -eq 0) { Log "$($t.id) WARN verify passed with EMPTY output ($cmd) - confirm it really runs tests" }
  return $pass
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
    if ($LASTEXITCODE -ne 0) {
      git -C $Integration merge --abort 2>$null
      # resolve on the lane side: merge main into the lane, let the merger agent fix conflicts, commit, retry once
      Log "merge conflict integrating $id - merger agent resolving on $branch"
      git merge --no-edit main 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        $ok = Invoke-Agent "merger" (FK $id) "Resolve the in-progress merge of main into $branch."
        # no Enforce here: a merge of main legitimately brings spec/ and .orchestra/ changes; stage what the merger resolved
        git add -A | Out-Null
        $left = @(git diff --cached --name-only --diff-filter=U) + @(git grep -l -E '^(<<<<<<<|>>>>>>>) ' -- . ':!spec' 2>$null)
        if (-not $ok -or @($left | Where-Object { $_ }).Count) { git merge --abort 2>$null; Log "MERGE CONFLICT integrating $id from $branch - merger could not resolve ($(@($left) -join ', ')) - left for human"; return }
        git add -A | Out-Null; git commit -q --no-edit 2>$null | Out-Null
        Log "merger resolved conflicts for $id"
      }
      git -C $Integration merge --no-edit $branch 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { git -C $Integration merge --abort 2>$null; Log "MERGE CONFLICT integrating $id from $branch after merger - left for human"; return }
    }
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
  # lead/human resets: any C:\LIMS-state\resets-<chunk>*.json = {"TASK-ID":"status" | {"status":..,"depends":[..]}}; each file applied once, oldest first
  function Apply-Resets {
  $rsFiles = @(Get-ChildItem -Path $StateDir -Filter "resets-$Chunk*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
  if ($rsFiles.Count) {
    $l = Lock "tasks-$Chunk"
    try {
      foreach ($rf0 in $rsFiles) {
        $map = Get-Content $rf0.FullName -Raw -Encoding UTF8 | ConvertFrom-Json; $all = Get-Tasks
        foreach ($p in $map.PSObject.Properties) { $x = $all | Where-Object { $_.id -eq $p.Name }; if ($x) {
          $v = $p.Value; $st = if ($v -is [string]) { $v } else { $v.status }
          if ($v -isnot [string] -and $v.depends) { $x | Add-Member -Force depends (@(@($x.depends) + @($v.depends) | Where-Object { $_ } | Select-Object -Unique)) }
          $x | Add-Member -Force status $st; $x | Add-Member -Force reviewRounds 0; Log "reset $($p.Name) -> $st ($($rf0.Name))"
          Get-ChildItem -Path (Join-Path (Split-Path $WorkDir -Parent) "*\.orchestra\cr\$(FK $p.Name).md") -ErrorAction SilentlyContinue | ForEach-Object { Move-Item -Force $_.FullName ($_.FullName -replace '\.md$', ".resolved-$(Get-Date -Format yyyyMMddHHmm).md"); Log "archived CR $($_.FullName)" }
        } }
        $all | ConvertTo-Json -Depth 6 | Set-Content $TasksFile -Encoding UTF8
        Remove-Item -Force $rf0.FullName
      }
    } finally { Unlock $l }
  }
  }
  Apply-Resets
  $selfStamp = (Get-Item $PSCommandPath).LastWriteTimeUtc
  while ($true) {
    # a fixed run.ps1 takes effect at the next task: end this pass, lane-loop restarts it on the new code
    if ((Get-Item $PSCommandPath).LastWriteTimeUtc -ne $selfStamp) { Log "run.ps1 changed - ending pass to reload"; break }
    Apply-Resets   # lead resets take effect between tasks, not only at pass start
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
    $tk = FK $t.id   # file key for notes/cr/inbox names ({TASK} in the role texts)
    Set-Status $t.id ($t.status)
    if ($Integration) {   # start from everyone's latest work
      git merge --no-edit main 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        # 2026-11-11 lead: a silent abort left lane C5c stale for hours (T-10 could not see BarcodeSymbol or the 300 s vitest timeout). Resolve with the merger agent as Integrate does; if it cannot, abort and say so in the log.
        $mh = (git rev-parse --git-path MERGE_HEAD).Trim()
        if (Test-Path $mh) {
          Log "$($t.id) merge of main into the lane conflicts - merger agent resolving"
          $okm = Invoke-Agent "merger" $tk "Resolve the in-progress merge of main into the lane branch (task $($t.id) is about to start)."
          git add -A | Out-Null
          $leftm = @(git diff --cached --name-only --diff-filter=U) + @(git grep -l -E '^(<<<<<<<|>>>>>>>) ' -- . ':!spec' 2>$null)
          if (-not $okm -or @($leftm | Where-Object { $_ }).Count) { git merge --abort 2>$null; Log "$($t.id) STALE LANE: merge of main could not be resolved ($(@($leftm) -join ', ')) - starting on the old base" }
          else { git add -A | Out-Null; git commit -q --no-edit 2>$null | Out-Null; Log "$($t.id) merger resolved the merge of main" }
        } else { Log "$($t.id) STALE LANE: merge of main did not start (local changes in the way?) - starting on the old base" }
      }
    }
    $script:Base = (git rev-parse HEAD).Trim()
    $brief = ($t | Select-Object id,title,files,done_when,tests,acs | ConvertTo-Json -Depth 4) + "`nPlan: spec/chunks/$Chunk/06-IMPLEMENTATION-PLAN.md (row $($t.id)). PRD: spec/chunks/$Chunk/01-PRD.md. Security: spec/chunks/$Chunk/07-SECURITY.md."
    $ld = Join-Path $StateDir "lead-decisions.md"
    # lead decisions: global file (C0-era, ids are unique) + per-chunk file lead-decisions-<chunk>.md (ids only unique inside a chunk)
    $idRx = "(^|[^A-Za-z0-9-])" + [regex]::Escape($t.id) + "([^A-Za-z0-9-]|$)"
    $hit = @(@($ld) | Where-Object { Test-Path $_ } | ForEach-Object { Get-Content $_ -Encoding UTF8 } | Where-Object { $_ -match $idRx })
    if ($script:SharedIds.ContainsKey($t.id)) { $hit = @($hit | Where-Object { $_ -match ('\b' + $script:ChunkTag + '\b') }) }   # shared id: a line in the GLOBAL file binds only if it names this chunk (e.g. "C3 ..."); the per-chunk file below is already chunk-scoped
    $cf = Join-Path $StateDir "lead-decisions-$Chunk.md"   # in a chunk file, a line tagged [ALL] binds every task of that chunk
    if (Test-Path $cf) { $hit += @(Get-Content $cf -Encoding UTF8 | Where-Object { $_ -match $idRx -or $_ -match '\[ALL\]' }) }
    if ($hit.Count) { $brief += "`n`nLEAD DECISIONS (binding; they override the spec text for this task; cite them in code comments):`n" + ($hit -join "`n") }
    Log "START $($t.id) $($t.title)"
    $st = $t.status; $rr = [int]$t.reviewRounds

    if ($st -eq "todo") {
      if (-not (Invoke-Agent "tester" $tk $brief)) { Set-Status $t.id "blocked"; continue }
      Enforce "tester"; Commit "[tester] $($t.id) tests"; $st = "tested"; Set-Status $t.id $st
    }
    if ($st -eq "tested") {
      $wm = $script:FirstWriterModel; $we = if ($wm) { "high" } else { "" }
      Log "$($t.id) writer first pass: model=$(if ($wm) { $wm } else { 'opus (C0/C2)' }) effort=$(if ($we -and $script:EffortOk) { $we } else { 'default' }) cli-effort-flag=$($script:EffortOk)"
      if (-not (Invoke-Agent "writer" $tk $brief $wm $we)) { Set-Status $t.id "blocked"; continue }
      Enforce "writer"; Commit "[writer] $($t.id) impl"; $st = "implemented"; Set-Status $t.id $st
    }
    $crf = Join-Path $O "cr\$($tk).md"
    if (Test-Path $crf) {
      if ((Get-Content $crf -Raw) -match '(?im)^\s*Blocking\?\s*no') {
        Move-Item -Force $crf (Join-Path $O "cr\$($tk).nonblocking.md"); Commit "[orchestra] $($t.id) non-blocking CR queued for lead"
        Log "$($t.id) raised a NON-blocking CR (queued for lead) - continuing"
      } else {
        # lead agent rules on clear-cut CRs (roles/lead.md); anything else, or a 2nd CR on the same task, goes to the human
        $prev = @(Get-ChildItem (Join-Path $O "notes\$($tk)-lead-*.md") -ErrorAction SilentlyContinue).Count
        if ($prev -ge 2 -or -not (Invoke-Agent "lead" $tk $brief)) { Log "$($t.id) blocking CR - human"; Set-Status $t.id "blocked"; continue }
        Enforce "lead"
        $lf = Join-Path $O "notes\$($tk)-lead.md"
        $lv = if (Test-Path $lf) { @(Get-Content $lf -TotalCount 2) } else { @("ESCALATE") }
        $verdict = $lv[0].Trim()
        Move-Item -Force $lf (Join-Path $O "notes\$($tk)-lead-$(Get-Date -Format yyyyMMddHHmmss).md") -ErrorAction SilentlyContinue
        if ($verdict -match '^APPROVED_(RETEST|REWRITE)' -and $lv.Count -ge 2 -and $lv[1].Trim()) {
          $dl = Lock "lead-decisions"
          try { Add-Content (Join-Path $StateDir "lead-decisions-$Chunk.md") "- AUTO $(Get-Date -Format s) [lead agent; human reviews at next check] $($t.id): $($lv[1].Trim())" -Encoding UTF8 } finally { Unlock $dl }
          Move-Item -Force $crf (Join-Path $O "cr\$($tk).resolved-$(Get-Date -Format yyyyMMddHHmm).md")
          Commit "[lead] $($t.id) $verdict"
          $ns = if ($verdict -match 'RETEST') { "todo" } else { "tested" }
          Log "$($t.id) CR auto-ruled $verdict -> $ns"; Set-Status $t.id $ns 0; continue
        }
        Commit "[lead] $($t.id) ESCALATE"; Log "$($t.id) blocking CR - lead agent escalated to human"; Set-Status $t.id "blocked"; continue
      }
    }
    $disp = Join-Path $O "notes\$($tk)-dispute.md"
    if (Test-Path $disp) {
      # reviewer arbitrates against the spec; a wrong test is fixed by the tester, never by the writer
      Log "$($t.id) test dispute - reviewer arbitrates"
      if (-not (Invoke-Agent "arbiter" $tk $brief)) { Set-Status $t.id "blocked"; continue }
      Enforce "reviewer"
      $rf = Join-Path $O "notes\$($tk)-ruling.md"
      $ruling = if (Test-Path $rf) { (Get-Content $rf -TotalCount 1).Trim() } else { "" }
      Move-Item -Force $disp (Join-Path $O "notes\$($tk)-dispute-$(Get-Date -Format yyyyMMddHHmm).md")
      Commit "[arbiter] $($t.id) $ruling"
      if ($ruling -match "^TESTS_WRONG") {
        if (-not (Invoke-Agent "tester" $tk ($brief + "`nRevise your tests per .orchestra/notes/$($tk)-ruling.md. Change only what the ruling says."))) { Set-Status $t.id "blocked"; continue }
        Enforce "tester"; Commit "[tester] $($t.id) tests revised per ruling"
        if (-not (Invoke-Agent "writer" $tk $brief)) { Set-Status $t.id "blocked"; continue }
        Enforce "writer"; Commit "[writer] $($t.id) impl after ruling"
      } elseif ($ruling -match "^IMPLEMENTATION_WRONG") {
        if (-not (Invoke-Agent "writer" $tk ($brief + "`nThe tests stand: read .orchestra/notes/$($tk)-ruling.md and make them pass."))) { Set-Status $t.id "blocked"; continue }
        Enforce "writer"; Commit "[writer] $($t.id) impl per ruling"
      } else { Log "$($t.id) ruling '$ruling' - needs a human (see notes\$($tk)-ruling.md)"; Set-Status $t.id "blocked"; continue }
      if (Test-Path $disp) {
        $nDisp = @(Get-ChildItem (Join-Path $O "notes\$($tk)-dispute-*.md") -ErrorAction SilentlyContinue).Count
        if ($nDisp -ge 3) { Log "$($t.id) disputed again after 3 rulings - human"; Set-Status $t.id "blocked"; continue }
        Log "$($t.id) disputed again after ruling - arbitrating again ($nDisp so far)"; Set-Status $t.id "implemented"; continue
      }
      $st = "implemented"; Set-Status $t.id $st
    }
    $round = 0
    while ($st -in @("implemented","changes")) {
      if ($st -eq "changes") {
        $fb = "`nRead .orchestra/notes/$($tk)-review.md (and .orchestra/notes/$($tk)-ruling.md if it exists)."
        if (-not (Invoke-Agent "tester" $tk ($brief + $fb + " Apply ONLY the items that concern test files; if none, change nothing."))) { $st = "blocked"; break }
        Enforce "tester"; Commit "[tester] $($t.id) review fixes (tests)"
        if (-not (Invoke-Agent "writer" $tk ($brief + $fb + " Apply every item that concerns implementation files; test items were handled by the tester."))) { $st = "blocked"; break }
        Enforce "writer"; Commit "[writer] $($t.id) review fixes"
      }
      $pass = Verify $t
      while (-not $pass -and $round -lt $MaxDebugRounds) {
        $round++; Log "$($t.id) verify failed - debugger round $round"
        if (-not (Invoke-Agent "debugger" $tk $brief)) { break }
        Enforce "debugger"; Commit "[debugger] $($t.id) round $round"
        if (Test-Path (Join-Path $O "notes\$($tk)-dispute.md")) { break }   # debugger says a TEST is wrong: arbitrate, don't burn rounds
        $pass = Verify $t
      }
      $nDisp = @(Get-ChildItem (Join-Path $O "notes\$($tk)-dispute-*.md") -ErrorAction SilentlyContinue).Count
      if (-not $pass -and (Test-Path (Join-Path $O "notes\$($tk)-dispute.md")) -and $nDisp -lt 3) { Log "$($t.id) debugger disputes a test - back to arbitration"; $st = "implemented"; break }
      if (-not $pass) { Log "$($t.id) still failing - blocked"; $st = "blocked"; break }
      $rf = Join-Path $O "notes\$($tk)-review.md"
      $rfT0 = if (Test-Path $rf) { (Get-Item $rf).LastWriteTimeUtc } else { [datetime]::MinValue }   # task ids repeat across chunks (T-01 ...): an old review note must never count as this review
      if (-not (Invoke-Agent "reviewer" $tk $brief)) { $st = "blocked"; break }
      Enforce "reviewer"; Commit "[reviewer] $($t.id)"
      $fresh = (Test-Path $rf) -and ((Get-Item $rf).LastWriteTimeUtc -gt $rfT0)
      if (-not $fresh) { Log "$($t.id) reviewer wrote no new review note - not approved" }
      $verdict = if ($fresh) { (Get-Content $rf -TotalCount 1).Trim() } else { "" }
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
