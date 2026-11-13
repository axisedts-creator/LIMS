# One-shot recovery (2026-11-13): 1) test the API, 2) release the staged resets only if it works, 3) merge main into lane C11.
Set-Location C:\LIMS
Write-Host "1/3 API test ..."
$r = (& claude -p "reply ok" --output-format json 2>&1 | Out-String)
if ($r -match '"is_error"\s*:\s*false' -and $r -notmatch 'Cloudflare|Attention Required') {
  Write-Host "API OK"
  $n = @(Get-ChildItem C:\LIMS-state\hold -Filter 'resets-*.json' -ErrorAction SilentlyContinue)
  if ($n.Count) { Move-Item $n.FullName C:\LIMS-state\ -Force; Write-Host "2/3 released $($n.Count) reset files - the queue starts lanes within about 3 minutes" }
  else { Write-Host "2/3 no staged reset files found in C:\LIMS-state\hold" }
} else {
  Write-Host "API STILL FAILING - nothing released. Paste this back:" -ForegroundColor Yellow
  Write-Host $r.Substring(0, [Math]::Min(600, $r.Length))
}
Write-Host "3/3 merging main into lane C11 ..."
git -C C:\LIMS-lanes\C11 merge main --no-edit
Write-Host "Done. If the merge printed CONFLICT, paste the file names back."
