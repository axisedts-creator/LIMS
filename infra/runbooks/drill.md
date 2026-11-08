# Restore drill runbook (`drill`)

Owner C1. The monthly restore drill (04 I3; timer `lims-restore-drill`, first Saturday 02:00 NPT) restores the newest backup plus WAL onto a scratch target, replays to a point in time, and runs verification checks. Playbook: `ansible-playbook playbooks/restore-drill.yml`.
The alert `RestoreDrillOverdue` is in `backup.md`; this file holds `RestoreDrillFailed` and how to read a drill. Template: 04-UI-UX s4.2.

## RestoreDrillFailed
Severity: page   Owner: C1   Last tested: never
**Means:** the last restore drill failed, or finished with failed checks (`lims_ops_restore_drill_checks_failed` above 0).  **Impact:** SEV2; the backup may not restore, so the RPO/RTO promises are unproven.
**Check first:** the newest drill report in `infra/runbooks/drill-log/` (failed check names); `pgbackrest --stanza=lims info`; `journalctl -u lims-restore-drill.service --since -1d`.
**Fix:** 1. Read which check failed: restore error (repo, cipher key, missing WAL segment), replay did not reach the target time, row-count or audit-digest check mismatch. 2. A restore or WAL error is a backup defect: follow `backup.md#walarchivefailing` and force a fresh full (`backup.md`). 3. A check mismatch with a clean restore: do not edit the check; find why data differs and ask the owner. 4. Run the drill again until it passes.
**Escalate when:** two consecutive failures, or any sign the production backup is corrupt -> secondary on-call and founder.
**Close-out:** ops log line with failed checks, cause, and the date of the passing rerun.

## Reading the drill result
1. The drill writes a report with: backup label used, target time, restore duration, each check and its result.
2. Restore duration is the measured input to the 4 h RTO (LD-45 lean DR: restore onto a fresh VM from site B). A duration above 3 h is a warning: record it and plan a faster path.
3. Any failed check means the drill failed even if the playbook exited 0.
4. The report lands in `infra/runbooks/drill-log/`; keep it; the metric `lims_ops_restore_drill_last_success_timestamp_seconds` drives `RestoreDrillOverdue`.

## Running the drill by hand
1. On ops-1 (or the lean prod host): `ansible-playbook playbooks/restore-drill.yml`.
2. Use only the scratch target the playbook creates; it must never restore over production data. DESTRUCTIVE steps are inside the playbook and guarded; do not bypass the guards.
3. `infra/ci/ops-note.sh "restore drill run result <pass|fail>"`.
