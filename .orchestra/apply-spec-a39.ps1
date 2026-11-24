# 2026-11-17 lead (LD-342): commit spec Addendum A39 (founder decision B: commission and TDS reports behind a tenant flag and the privileged permission).
# Edited in the main working tree by the lead. Backup of the original: C:\LIMS-state\backups\08-CR-REGISTER.md.before-A39-20261117.bak
Set-Location C:\LIMS
$br = (git rev-parse --abbrev-ref HEAD).Trim()
if ($br -ne 'main') { Write-Host "STOP: C:\LIMS is on branch $br, not main. Nothing committed."; exit 1 }
git add -- 'spec/program/08-CR-REGISTER.md'
git diff --cached --stat
git commit -m 'spec: Addendum A39 - commission and TDS reports behind the tenant flag and the privileged permission (founder decision B, LD-342)' -m 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01UjY635U7Jui4KiEdLCq4Rj'
git log -1 --oneline
Write-Host "committed. Task T0C-MISREPORTS-1 (lane C0-0M) can now run again."
