# Lead 2026-11-18 08:35 NPT (LD-367): the PC ran out of virtual memory with 7 to 8 lanes at once (Windows error 1455, exit 0xC000012D).
# Two tasks blocked with no real fault (T0B-GREEN-3, T0C-SYNC-2) and two UI testers crashed on resume. Also the old lane window C0-0D still
# had the pre-LD-364 filter and ran T0D-UIDASH-1 at the same time as lane C0-0P.
# This script: 1) commits queue.ps1 (MaxLanes 5, one extra slot for resets); 2) stops the old C0-0D lane window and parks its dirty files
# with git stash (nothing is deleted); 3) restarts the queue (the other lane windows are adopted); 4) puts the staged reset file in place.
# To go back to 9 lanes later: set Windows virtual memory to System managed size (Advanced system settings, Performance, Advanced, Virtual memory), then tell the lead.
Set-Location C:\LIMS
$log = 'C:\LIMS-state\logs\apply-maxlanes5.log'
function L($m) { $s = "$(Get-Date -Format s) $m"; Add-Content $log $s; Write-Host $s }
git diff --quiet -- .orchestra/queue.ps1
if ($LASTEXITCODE -ne 0) {
  git add -- .orchestra/queue.ps1
  git commit -q -m "queue: MaxLanes 5 (paging file exhausted at 8 lanes, error 1455)`n`nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01UjY635U7Jui4KiEdLCq4Rj" -- .orchestra/queue.ps1
  L 'committed .orchestra/queue.ps1'
} else { L 'queue.ps1 already committed' }

$d = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -match 'lane-loop\.ps1' -and $_.CommandLine -match 'C0-0D' })
foreach ($p in $d) { & taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null; L "stopped old lane window C0-0D pid $($p.ProcessId)" }
if (-not $d.Count) { L 'lane C0-0D window was not running' }
Start-Sleep -Seconds 5
$dirty = @(git -C C:\LIMS-lanes\C0-0D status --porcelain 2>$null)
if ($dirty.Count -gt 0) {
  git -C C:\LIMS-lanes\C0-0D stash push -u -m "lead 2026-11-18: dirty files of the stopped lane window C0-0D (T0D-UIDASH-1 tester)" 2>&1 | ForEach-Object { L "stash: $_" }
} else { L 'lane C0-0D worktree is clean' }

& powershell -NoProfile -ExecutionPolicy Bypass -File C:\LIMS\.orchestra\relaunch.ps1
Start-Sleep -Seconds 20
Copy-Item -LiteralPath 'C:\LIMS-state\scratch-lead\HOLD-resets-lanefix1.json' -Destination 'C:\LIMS-state\resets-C0-foundation-contracts-lanefix1.json' -Force
L 'queue relaunched with MaxLanes 5; reset file lanefix1 written (T0B-GREEN-3 and T0C-SYNC-2 -> implemented, T0D-UIDASH-1 and T0D-UICONSOLE-1 -> todo)'
Write-Host 'done - tell the lead'
