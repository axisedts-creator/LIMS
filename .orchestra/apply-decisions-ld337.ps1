# 2026-11-17 lead (LD-337): commit the spec change the lanes may not make (run.ps1 Enforce reverts every spec/* change by any role).
# Edited in the main working tree by the lead: spec/program/03-INTERFACE-CATALOG.md
#   - section 7 YAML (routes): 28 staff web routes that main already carries in contracts/routes.yaml (NAV-COMPLETE-1, ADMINPAGE, T0D-ACCT-1) are added so the registry-equality test routes.yaml == IC section 7 is green again
# Backup of the file before the edit: C:\LIMS-state\backups\03-INTERFACE-CATALOG.md.before-LD337-20261117
Set-Location C:\LIMS
$br = (git rev-parse --abbrev-ref HEAD).Trim()
if ($br -ne 'main') { Write-Host "STOP: C:\LIMS is on branch $br, not main. Nothing committed."; exit 1 }
git diff --stat -- spec/program/03-INTERFACE-CATALOG.md
git add spec/program/03-INTERFACE-CATALOG.md
git commit -m 'spec: 03-IC section 7 routes: add the 28 staff web routes already in contracts/routes.yaml (registry-equality routes.yaml == IC 7)' -m 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01UjY635U7Jui4KiEdLCq4Rj'
git log -1 --oneline
Write-Host "committed. Lanes pick it up when they start their next task."
