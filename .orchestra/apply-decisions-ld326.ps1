# 2026-11-17 lead (LD-326): commit the two spec additions the lanes may not make (run.ps1 Enforce reverts every spec/* change by any role).
# Edited in the main working tree by the lead: spec/program/03-INTERFACE-CATALOG.md
#   - section 13.1 YAML: account_entry.create, account_entry.reverse (CR-C0-ACCT-1, LD-324)
#   - BillingCommandPortV1: previewInvoiceNo (LD-323)
# Backup of the file before the edit: C:\LIMS-state\backups\03-INTERFACE-CATALOG.md.before-LD326-20261117
Set-Location C:\LIMS
$br = (git rev-parse --abbrev-ref HEAD).Trim()
if ($br -ne 'main') { Write-Host "STOP: C:\LIMS is on branch $br, not main. Nothing committed."; exit 1 }
git diff --stat -- spec/program/03-INTERFACE-CATALOG.md
git add spec/program/03-INTERFACE-CATALOG.md
git commit -m 'spec: 03-IC 13.1 account_entry.create and account_entry.reverse (CR-C0-ACCT-1) and BillingCommandPortV1.previewInvoiceNo (LD-323)' -m 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01UjY635U7Jui4KiEdLCq4Rj'
git log -1 --oneline
Write-Host "committed. Lanes pick it up when they start their next task."
