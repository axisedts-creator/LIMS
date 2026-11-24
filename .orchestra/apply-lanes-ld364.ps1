# apply-lanes-ld364.ps1 - the founder runs it (double-click apply-lanes-ld364.cmd). Lead, 2026-11-18 07:55 NPT (LD-364).
# 1. commit .orchestra\queue.ps1 (two new UI lanes C0-0P and C0-0Q, MaxLanes 9; founder: increase the lanes)
# 2. merge the idle lane branches into main (the stale git lock stopped every task-end merge since 22:56 NPT)
# 3. restart the queue (running lane windows are adopted, nothing is stopped)
# Nothing is deleted or pushed. A merge that conflicts is aborted (main unchanged) and reported.
Set-Location C:\LIMS
$log = 'C:\LIMS-state\logs\apply-lanes-ld364.log'
function L([string]$m) { $s = "$(Get-Date -Format s) $m"; Write-Host $s; Add-Content $log $s }
$trailer = "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`n`nClaude-Session: https://claude.ai/code/session_01UjY635U7Jui4KiEdLCq4Rj"
$head = (git rev-parse --abbrev-ref HEAD).Trim()
if ($head -ne 'main') { L "STOP: C:\LIMS is on branch $head, not main. Nothing was done."; exit 1 }
for ($i = 0; $i -lt 24 -and (Test-Path 'C:\LIMS\.git\index.lock'); $i++) { Start-Sleep -Seconds 5 }
if (Test-Path 'C:\LIMS\.git\index.lock') { L 'STOP: .git\index.lock exists and does not clear. If no git window is open, run apply-ui-ld344.cmd again (it moves a stale lock aside).'; exit 1 }

# 1. queue.ps1
git diff --quiet -- .orchestra/queue.ps1
if ($LASTEXITCODE -ne 0) {
  git add -- .orchestra/queue.ps1
  git commit -q -m "queue: two UI lanes (C0-0P, C0-0Q) and MaxLanes 9 (LD-364, founder asked to increase the lanes 07:29 NPT)`n`n$trailer" -- .orchestra/queue.ps1
  L 'committed .orchestra/queue.ps1'
} else { L 'queue.ps1 already committed' }

# 2. a dirty main refuses merges that touch the same files; the one known case is pnpm-workspace.yaml (see merge-lanes.ps1)
$dirty = @(git status --porcelain -uno)
if ($dirty.Count -eq 1 -and $dirty[0] -match 'pnpm-workspace\.yaml') {
  git add -- pnpm-workspace.yaml
  git commit -q -m "pnpm-workspace.yaml: allowBuilds placeholder written by pnpm (LD-364)`n`n$trailer" -- pnpm-workspace.yaml
  L 'committed pnpm-workspace.yaml (pnpm-written change)'
} elseif ($dirty.Count -gt 0) {
  L ("WARNING: main has " + $dirty.Count + " uncommitted tracked change(s); a merge that touches them will fail and be reported. First lines:")
  $dirty | Select-Object -First 8 | ForEach-Object { L "   $_" }
}

# 3. merge the idle lanes under the queue's merge lock (the same lock the lanes use at task end)
$skip = @('lane/C0-0D', 'lane/C0-0I')   # running or about to run: their own task end merges them
$lockp = 'C:\LIMS-state\locks\merge.lock'
New-Item -ItemType Directory -Force -Path 'C:\LIMS-state\locks' | Out-Null
$got = $false
for ($i = 0; $i -lt 240 -and -not $got; $i++) {
  try { $fs = [System.IO.File]::Open($lockp, 'CreateNew', 'Write', 'None'); $w = New-Object System.IO.StreamWriter($fs); $w.Write("$PID"); $w.Close(); $got = $true }
  catch { Start-Sleep -Milliseconds 500 }
}
if (-not $got) { L 'STOP: the queue merge lock is held for 2 minutes (a lane is merging). Run this again in a few minutes.'; exit 1 }
$merged = 0; $failed = 0; $already = 0
try {
  $branches = @(git for-each-ref --format='%(refname:short)' 'refs/heads/lane/C0-0*')
  foreach ($b in $branches) {
    if ($skip -contains $b) { L "skip   $b (running or starting)"; continue }
    git merge-base --is-ancestor $b main 2>$null
    if ($LASTEXITCODE -eq 0) { L "ok     $b is already in main"; $already++; continue }
    $o = git merge --no-edit -m "Merge $b into main (apply-lanes-ld364, the lanes could not merge during the stale git lock)`n`n$trailer" $b 2>&1
    if ($LASTEXITCODE -eq 0) { L "MERGED $b"; $merged++ }
    else { git merge --abort 2>$null; L "FAILED $b - merge aborted, main unchanged. Paste these lines to the lead:"; $o | Select-Object -First 8 | ForEach-Object { L "   $_" }; $failed++ }
  }
} finally { Remove-Item -Force $lockp -ErrorAction SilentlyContinue }
L "merge summary: merged $merged, already in main $already, failed $failed"

# 4. restart the queue so it reads the two new lanes
L 'restarting the queue (lane windows are adopted)'
& powershell -NoProfile -ExecutionPolicy Bypass -File C:\LIMS\.orchestra\relaunch.ps1
L 'done - tell the lead; the log is C:\LIMS-state\logs\apply-lanes-ld364.log'
