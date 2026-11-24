# 2026-11-13: commit the resolved C11 merge, then the spec amendment and the run.ps1 403 patch on main.
git -C C:\LIMS-lanes\C11 add -A
git -C C:\LIMS-lanes\C11 commit --no-edit
git -C C:\LIMS add spec/program/11-ROLE-MATRIX.md .orchestra/run.ps1 .orchestra/recover.ps1
git -C C:\LIMS commit -m "spec: 11-ROLE-MATRIX 3.1 overlay (CR-C2-RM-002 option a, founder ruling); run.ps1: wait on Cloudflare/auth 403 instead of blocking"
git -C C:\LIMS-lanes\C11 status --short | Select-Object -First 5
Write-Host "Done."
