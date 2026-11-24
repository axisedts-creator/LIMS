# 2026-11-13 v2: main's pnpm-workspace.yaml has an uncommitted pnpm-written change (allowBuilds placeholder) that lane/C9 and lane/C12 already committed with the same content;
# git refuses to merge them into a dirty main. Commit that one file first, then integrate the two lanes. A failing merge is aborted so main stays clean.
git -C C:\LIMS diff --quiet -- pnpm-workspace.yaml
if ($LASTEXITCODE -ne 0) {
  git -C C:\LIMS add pnpm-workspace.yaml
  git -C C:\LIMS commit -m 'pnpm-workspace.yaml: allowBuilds placeholder written by pnpm (same content as lane/C9 and lane/C12)'
}
foreach ($b in 'C9','C12') {
  Write-Host "== merge lane/$b into main"
  $o = git -C C:\LIMS merge --no-edit "lane/$b" 2>&1
  $code = $LASTEXITCODE
  $o | Select-Object -First 15
  if ($code -ne 0) { git -C C:\LIMS merge --abort 2>$null; Write-Host "FAILED - merge aborted, main unchanged. Paste the lines above." -ForegroundColor Yellow }
}
Write-Host '== done'
