<#
  LIMS - agent orchestra (tester -> writer -> verify -> debugger -> reviewer)
  Usage (from C:\LIMS):  powershell -ExecutionPolicy Bypass -File .orchestra\run.ps1 -Chunk C0-foundation-contracts
  Safe to stop (Ctrl+C) and re-run any time: progress is saved in .orchestra\tasks\<chunk>.json
#>
param(
  [string]$Chunk = "C0-foundation-contracts",
  [int]$MaxDebugRounds = 3,
  [int]$LimitWaitMinutes = 20,
  [switch]$NoPush
)

$ErrorActionPreference = "Continue"   # native tools write to stderr; failures are checked explicitly
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$O = Join-Path $Root ".orchestra"
foreach ($d in "tasks","notes","out","cr","inbox","logs") { New-Item -ItemType Directory -Force -Path (Join-Path $O $d) | Out-Null }

# ---- models / turn caps (change here to trade quality vs. usage) ----
$Cfg = @{
  planner  = @{ model = "sonnet"; turns = 30 }
  tester   = @{ model = "sonnet"; turns = 40 }
  writer   = @{ model = "opus";   turns = 80 }
  debugger = @{ model = "sonnet"; turns = 40 }
  reviewer = @{ model = "opus";   turns = 25 }
}
$Allowed = "Read,Edit,Write,Bash(pnpm *),Bash(npm *),Bash(npx *),Bash(node *),Bash(git status*),Bash(git diff*),Bash(git log*),Bash(go *),Bash(docker *),Bash(supabase *),Bash(psql *),Bash(ls*),Bash(cat *),Bash(grep *),Bash(find *),Bash(mkdir *)"
$TestPat = '(__tests__/|\.test\.|\.spec\.|_test\.go$|^db/tests/|^tests/)'

# ---- one orchestrator per chunk ----
$Lock = Join-Path $O "lock-$Chunk"
if (Test-Path $Lock) { Write-Host "Another run holds $Lock. Delete it if no run is active."; exit 1 }
New-Item -ItemType File -Path $Lock | Out-Null

function Log($m) { $line = "$(Get-Date -Format s) [$Chunk] $m"; Write-Host $line; Add-Content (Join-Path $O "logs\$Chunk.log") $line }

function Invoke-Agent([string]$Role, [string]$TaskId, [string]$Brief) {
  $roleText = Get-Content (Join-Path $O "roles\$Role.md") -Raw
  $roleText = $roleText.Replace("{CHUNK}",$Chunk).Replace("{TASK}",$TaskId).Replace("{BASE}",$script:Base)
  $inbox = Join-Path $O "inbox\$TaskId-$Role.md"
  Set-Content -Path $inbox -Value ($roleText + "`n`n## Task brief`n" + $Brief) -Encoding UTF8
  $rel = ".orchestra/inbox/$TaskId-$Role.md"
  $first = @("-p","--output-format","json","--model",$Cfg[$Role].model,"--max-turns",$Cfg[$Role].turns,
            "--permission-mode","acceptEdits","--allowedTools",$Allowed,
            "Read $rel and do exactly what it says. Reply in at most 6 lines.")
  $session = $null; $tries = 0; $waits = 0
  while ($true) {
    $tries++
    if ($session) { $run = @("-p","--resume",$session,"--output-format","json","--model",$Cfg[$Role].model,"--max-turns",$Cfg[$Role].turns,
                             "--permission-mode","acceptEdits","--allowedTools",$Allowed,
                             "Continue the task in $rel from where you stopped.") } else { $run = $first }
    $errf = Join-Path $O "logs\$Chunk-stderr.log"
    $raw = (& claude @run 2> $errf | Out-String)
    $code = $LASTEXITCODE
    Add-Content (Join-Path $O "logs\$Chunk-agents.log") "---- $Role $TaskId try $tries exit $code`n$raw"
    $j = $null; try { $j = $raw | ConvertFrom-Json } catch {}
    if ($j -and $j.session_id) { $session = $j.session_id }
    $ok = ($code -eq 0) -and $j -and (-not $j.is_error)
    if ($ok) { return $true }
    $errTail = (Get-Content $errf -Tail 20 -ErrorAction SilentlyContinue | Out-String)
    if (($raw + $errTail) -match '(?i)usage limit|rate.?limit|\b429\b|overloaded|limit reached|out of (extra )?usage') {
      Log "$Role $TaskId hit a usage limit - sleeping $LimitWaitMinutes min, then resuming the same session"
      $waits++; if ($waits -gt 60) { Log "$Role $TaskId still limited after 60 waits - stopping"; return $false }
      Start-Sleep -Seconds ($LimitWaitMinutes*60); $tries--; continue
    }
    if ($j -and $j.subtype -eq "error_max_turns") { Log "$Role $TaskId ran out of turns - resuming once"; if ($tries -lt 2) { continue } }
    if ($tries -ge 2) { Log "$Role $TaskId failed twice"; return $false }
    Start-Sleep -Seconds 30
  }
}

function Changed() { (git status --porcelain -uall) | ForEach-Object { ($_.Substring(3)).Trim('"') -replace '\\','/' } }

# Enforce "no overlap": each role may touch only its own files; anything else is reverted.
function Enforce([string]$Role) {
  $bad = @()
  foreach ($f in Changed) {
    if ($f -like "spec/*") { $bad += $f; continue }
    if ($f -like ".orchestra/*") { if ($f -notlike ".orchestra/notes/*" -and $f -notlike ".orchestra/cr/*" -and $f -notlike ".orchestra/inbox/*" -and $f -notlike ".orchestra/tasks/*" -and $f -notlike ".orchestra/logs/*" -and $f -notlike ".orchestra/out/*") { $bad += $f }; continue }
    $isTest = $f -match $TestPat
    switch ($Role) {
      "tester"   { if (-not $isTest) { $bad += $f } }
      "writer"   { if ($isTest) { $bad += $f } }
      "debugger" { if ($isTest) { $bad += $f } }
      "reviewer" { $bad += $f }
      "planner"  { $bad += $f }
    }
  }
  foreach ($f in $bad) {
    Log "REVERT ($Role not allowed): $f"
    git checkout -- "$f" 2>$null; if (Test-Path $f) { if (-not (git ls-files -- "$f")) { Remove-Item -Recurse -Force "$f" } }
  }
}

function Commit([string]$msg) { git add -A | Out-Null; git commit -q -m $msg 2>$null | Out-Null }

function Verify($t) {
  $log = Join-Path $O "out\$($t.id)-verify.log"
  $cmd = if ($t.verify) { $t.verify } else { "pnpm -s verify" }
  if (-not (Test-Path "package.json") -and $cmd -like "pnpm*") { Set-Content $log "no package.json yet - verification by tester notes only"; return $true }
  cmd /c "$cmd > `"$log`" 2>&1"
  $pass = ($LASTEXITCODE -eq 0)
  $tail = Get-Content $log -Tail 200; Set-Content $log $tail
  return $pass
}

try {
  if (-not (Test-Path ".git")) { Log "C:\LIMS is not a git clone - follow the setup steps first"; exit 1 }
  $TasksFile = Join-Path $O "tasks\$Chunk.json"
  if (-not (Test-Path $TasksFile)) {
    Log "planning $Chunk"
    if (-not (Invoke-Agent "planner" "$Chunk-plan" "Chunk folder: spec/chunks/$Chunk/")) { Log "planner failed - see logs"; exit 1 }
    Enforce "planner"; Commit "[planner] $Chunk tasks"
  }
  $tasks = Get-Content $TasksFile -Raw | ConvertFrom-Json
  foreach ($t in $tasks) { if (-not ($t.PSObject.Properties.Name -contains "status")) { $t | Add-Member status "todo" } }
  function Save { $tasks | ConvertTo-Json -Depth 6 | Set-Content $TasksFile -Encoding UTF8 }

  foreach ($t in $tasks) {
    if ($t.status -in @("done","blocked")) { continue }
    $deps = @($t.depends) | Where-Object { $_ }
    $unmet = $deps | Where-Object { $d = $_; ($tasks | Where-Object { $_.id -eq $d -and $_.status -ne "done" }) }
    if ($unmet) { Log "skip $($t.id): waiting on $($unmet -join ',')"; continue }

    $script:Base = (git rev-parse HEAD).Trim()
    $brief = ($t | Select-Object id,title,files,done_when,tests,acs | ConvertTo-Json -Depth 4) + "`nPlan: spec/chunks/$Chunk/06-IMPLEMENTATION-PLAN.md (row $($t.id)). PRD: spec/chunks/$Chunk/01-PRD.md. Security: spec/chunks/$Chunk/07-SECURITY.md."
    Log "START $($t.id) $($t.title)"

    if ($t.status -eq "todo") {
      if (-not (Invoke-Agent "tester" $t.id $brief)) { $t.status="blocked"; Save; continue }
      Enforce "tester"; Commit "[tester] $($t.id) tests"; $t.status="tested"; Save
    }
    if ($t.status -eq "tested") {
      if (-not (Invoke-Agent "writer" $t.id $brief)) { $t.status="blocked"; Save; continue }
      Enforce "writer"; Commit "[writer] $($t.id) impl"; $t.status="implemented"; Save
    }
    if (Test-Path (Join-Path $O "cr\$($t.id).md")) { Log "$($t.id) needs a change request - blocked for human"; $t.status="blocked"; Save; continue }
    if (Test-Path (Join-Path $O "notes\$($t.id)-dispute.md")) { Log "$($t.id) test dispute - blocked for human"; $t.status="blocked"; Save; continue }

    $round = 0
    while ($t.status -in @("implemented","changes")) {
      if ($t.status -eq "changes") {
        if (-not (Invoke-Agent "writer" $t.id ($brief + "`nApply every item in .orchestra/notes/$($t.id)-review.md."))) { $t.status="blocked"; break }
        Enforce "writer"; Commit "[writer] $($t.id) review fixes"
      }
      $pass = Verify $t
      while (-not $pass -and $round -lt $MaxDebugRounds) {
        $round++; Log "$($t.id) verify FAILED - debugger round $round"
        if (-not (Invoke-Agent "debugger" $t.id $brief)) { break }
        Enforce "debugger"; Commit "[debugger] $($t.id) round $round"; $pass = Verify $t
      }
      if (-not $pass) { Log "$($t.id) still failing after $MaxDebugRounds rounds - blocked for human"; $t.status="blocked"; break }
      if (-not (Invoke-Agent "reviewer" $t.id $brief)) { $t.status="blocked"; break }
      Enforce "reviewer"; Commit "[reviewer] $($t.id)"
      $verdict = (Get-Content (Join-Path $O "notes\$($t.id)-review.md") -TotalCount 1).Trim()
      if ($verdict -eq "APPROVE") { $t.status="done" }
      elseif ($t.reviewRounds -ge 2) { Log "$($t.id) not approved after 2 review rounds - blocked"; $t.status="blocked" }
      else { $t | Add-Member -Force reviewRounds ([int]$t.reviewRounds + 1); $t.status="changes" }
      Save
    }
    Save; Log "END $($t.id) -> $($t.status)"
    if (-not $NoPush -and (git remote)) { git add -A | Out-Null; git commit -q -m "[orchestra] $($t.id) status" 2>$null | Out-Null; git push -q origin HEAD 2>$null; if ($LASTEXITCODE -ne 0) { Log "push failed (check GitHub login) - work is still saved locally" } }
  }
  Log "run finished. Blocked tasks need you: see .orchestra\notes, .orchestra\cr, .orchestra\logs\$Chunk.log"
}
finally { Remove-Item -Force $Lock -ErrorAction SilentlyContinue }
