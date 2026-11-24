# Lead 2026-11-18: commits the spec fix that adds 3 staff_web routes (staff.billing.expenses, expense_types, cash_transfers) to
# spec/program/03-INTERFACE-CATALOG.md section 7. They were already in contracts/routes.yaml (T0D-ACCT-2), so the contracts test
# "routes.yaml == IC section 7" was red on main and blocked T0C-SYNC-2 (CR-C0-T0C-SYNC-2). Only this one file is committed.
Set-Location C:\LIMS
$log = 'C:\LIMS-state\logs\apply-spec-ic7.log'
function L($m) { $s = "$(Get-Date -Format s) $m"; Add-Content $log $s; Write-Host $s }
git diff --quiet -- spec/program/03-INTERFACE-CATALOG.md
if ($LASTEXITCODE -ne 0) {
  git add -- spec/program/03-INTERFACE-CATALOG.md
  git commit -q -m "spec: IC section 7 gets the 3 staff.billing routes of T0D-ACCT-2 (CR-C0-T0C-SYNC-2)`n`nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01UjY635U7Jui4KiEdLCq4Rj" -- spec/program/03-INTERFACE-CATALOG.md
  if ($LASTEXITCODE -eq 0) { L 'committed spec/program/03-INTERFACE-CATALOG.md' } else { L 'COMMIT FAILED - paste this window to the lead' }
} else { L 'nothing to commit (already committed)' }

# Merge main into the idle lane C0-0M now (the lane window ended when T0C-SYNC-2 blocked), so the spec fix is in its tree.
$wt = 'C:\LIMS-lanes\C0-0M'
$run = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -match 'lane-loop\.ps1' -and $_.CommandLine -match 'C0-0M' })
if ($run.Count -eq 0) {
  $st = @(git -C $wt status --porcelain 2>$null)
  if ($st.Count -eq 0) {
    $mo = git -C $wt merge --no-edit main 2>&1
    if ($LASTEXITCODE -eq 0) { L 'merged main into lane C0-0M' }
    else { git -C $wt merge --abort 2>$null; L ('merge of main into lane C0-0M conflicts (aborted; the lane merger agent resolves at task start): ' + ((@($mo) | Select-Object -First 3) -join ' | ')) }
  } else { L ('lane C0-0M has ' + $st.Count + ' uncommitted files, first: ' + ((@($st) | Select-Object -First 6) -join ' | ') + ' - tell the lead') }
} else { L 'lane C0-0M window is running; its own merge at task start brings main in' }
Copy-Item -LiteralPath 'C:\LIMS-state\scratch-lead\HOLD-resets-ld371-SYNC-2.json' -Destination 'C:\LIMS-state\resets-C0-foundation-contracts-ld371.json' -Force
L 'reset file ld371 written (T0C-SYNC-2 -> implemented)'
Write-Host 'done - tell the lead'
