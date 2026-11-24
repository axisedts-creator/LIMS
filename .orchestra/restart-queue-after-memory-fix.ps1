# Lead 2026-11-18. Run this ONLY AFTER Windows virtual memory is set to System managed size and the PC was restarted
# (and ideally claude-mem is disabled). It sets the lane cap (default 7), commits queue.ps1, clears a stale git lock by moving it aside
# (nothing is deleted), and starts the queue again. After a restart the old lane windows are gone; the queue starts them again from the task statuses.
# Usage: powershell -ExecutionPolicy Bypass -File C:\LIMS\.orchestra\restart-queue-after-memory-fix.ps1 [-Lanes 9]
param([int]$Lanes = 7)
Set-Location C:\LIMS
$log = 'C:\LIMS-state\logs\restart-queue.log'
function L($m) { $s = "$(Get-Date -Format s) $m"; Add-Content $log $s; Write-Host $s }
if ($Lanes -lt 3 -or $Lanes -gt 10) { L "refused: -Lanes must be 3 to 10"; exit 1 }
$lock = 'C:\LIMS\.git\index.lock'
if ((Test-Path $lock) -and -not (Get-Process git -ErrorAction SilentlyContinue)) {
  Rename-Item -LiteralPath $lock -NewName ("index.lock.stale-" + (Get-Date -Format yyyyMMddHHmm)); L 'moved a stale .git\index.lock aside'
}
$p = 'C:\LIMS\.orchestra\queue.ps1'
$enc = New-Object System.Text.UTF8Encoding($true)
$s = [IO.File]::ReadAllText($p, $enc)
$n = [regex]::Replace($s, '\[int\]\$MaxLanes = \d+,', ('[int]$MaxLanes = ' + $Lanes + ','))
if ($n -ne $s) { [IO.File]::WriteAllText($p, $n, $enc); L "queue.ps1: MaxLanes set to $Lanes" } else { L "queue.ps1: MaxLanes already $Lanes" }
git diff --quiet -- .orchestra/queue.ps1
if ($LASTEXITCODE -ne 0) {
  git add -- .orchestra/queue.ps1
  git commit -q -m "queue: MaxLanes $Lanes after the virtual memory fix`n`nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01UjY635U7Jui4KiEdLCq4Rj" -- .orchestra/queue.ps1
  L 'committed queue.ps1'
}
& powershell -NoProfile -ExecutionPolicy Bypass -File C:\LIMS\.orchestra\relaunch.ps1
L "queue started with MaxLanes $Lanes"
Write-Host 'done - tell the lead'
