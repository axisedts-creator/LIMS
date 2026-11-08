# Audit runbook (`audit`)

Owner C1. One section per alert in `monitoring/rules/audit.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
The audit store is the database `lims_audit` (LD-45: same Postgres cluster in profile `lean`, owned by a role the app cannot use; a separate host in `full`). Audit rows reach it by logical replication ("audit shipping"); nightly hash digests are shipped off-host to site B (tamper evidence).
The audit store is append-only. Never `UPDATE`/`DELETE`/`TRUNCATE` audit rows, and never reset the digest chain, to clear an alert.

## AuditShippingLagging
Severity: page   Owner: C1   Last tested: never
**Means:** audit shipping to the audit store lags more than 5 min.  **Impact:** SEV2; audit rows exist only in the source database until shipped, and a source loss now would lose them.
**Check first:** `psql -c "select slot_name, active, confirmed_flush_lsn from pg_replication_slots"` on the source; Grafana D8 (Audit shipping) (`lims_ops_auditstore_lag_seconds`); `psql -d lims_audit -c "select now()"` to prove the store answers.
**Fix:** 1. If the subscription worker is stuck, see the subscriber log (`journalctl -u postgresql --since -30min | grep -i "logical replication"`). 2. Check disk space of the audit store and of the WAL volume (`db.md#replicationslotwalretained`). 3. After the cause is fixed the subscription catches up by itself; watch the lag fall.
**Escalate when:** lag over 30 min or growing -> secondary on-call; lag plus `PostgresDown` -> SEV1.
**Close-out:** ops log line with lag peak, cause and catch-up time.

## AuditShippingDown
Severity: page   Owner: C1   Last tested: never
**Means:** the audit shipping subscription is disabled.  **Impact:** SEV2 (04-UI-UX s5.1): no audit rows are being shipped; the audit trail has a gap forming at the source.
**Check first:** `psql -d lims_audit -c "select subname, subenabled from pg_subscription"` (expect `t`); `lims_ops_auditstore_subscription_enabled` on Grafana.
**Fix:** 1. Find out who disabled it: `ops_audit` and the PostgreSQL log (maintenance, patching, or an incident). 2. If it was an error: `alter subscription <name> enable` as the audit-store owner. 3. If the subscription was dropped or its slot lost: stop and escalate; rebuilding needs a backfill (`Backfill` below), not a blind recreate.
**Escalate when:** disabled without a known maintenance record -> treat as a security event: secondary on-call and `incident-response.md`.
**Close-out:** ops log line with who/why it was disabled and when it was re-enabled.

## AuditShippingDisabled
Severity: warn   Owner: C1   Last tested: never
**Means:** audit shipping is not configured: the audit store reports down for 15 min (`lims_ops_auditstore_up == 0`).  **Impact:** in a fresh environment this is expected; in prod audit rows are not shipped.
**Check first:** `psql -d lims_audit -c "select 1"`; `systemctl status lims-auditstore-metrics.timer`; the `auditstore` role has run on this host.
**Fix:** 1. In dev/staging before the role is applied: nothing to do, silence with a comment. 2. In prod: run the `auditstore` role (`ansible-playbook playbooks/site.yml --limit <host>`), then confirm `lims_ops_auditstore_up == 1`.
**Escalate when:** in prod for over 1 h -> secondary on-call (it will become `AuditShippingDown`).
**Close-out:** ops log line with environment and action.

## AuditDigestMismatch
Severity: page   Owner: C1   Last tested: never
**Means:** the nightly re-verification of audit digests found a mismatch between the stored digest and the audit rows.  **Impact:** SEV1 until proven otherwise: audit rows or digests may have been altered (tamper evidence).
**Check first:** `journalctl -u lims-auditstore-digest.service --since -2d` (names the day range that mismatched); compare with the digest copy at site B (`ls` the digest files there; do not edit any).
**Fix:** 1. Do not touch the audit store. 2. Preserve evidence first: `pg_dump` of the mismatching day range of `lims_audit` and the digest files with `sha256sum`, record the hashes with `infra/ci/ops-note.sh`. 3. Open an incident (`incident-response.md`) at SEV1 and inform the founder. 4. Compare the site-B digest copy with the local digest to learn which side changed. 5. A mismatch from a known bug (for example a digest job run during a restore) is only accepted after the founder approves the explanation.
**Escalate when:** always -> founder immediately.
**Close-out:** incident record with the day range, hashes, comparison result and decision.

## Backfill
Procedure. Use after `AuditShippingDown` when the subscription or slot was lost.
1. Stop and record the gap start: the last `confirmed_flush_lsn` or the newest shipped row time.
2. Take a founder-approved decision before any re-sync; backfill must copy source rows into `lims_audit` without removing or editing rows already there.
3. After the backfill, run the digest job for the affected days (`systemctl start lims-auditstore-digest.service`) and confirm no `AuditDigestMismatch`.
4. Record gap start/end, the number of rows copied, and the new digests with `infra/ci/ops-note.sh`.

## Investigation access
Procedure. Reading `access_log`/`audit_log` for an incident uses the `audit_reader` role and needs founder approval.
1. Get the approval in writing (message to the founder; keep the reference in the incident record).
2. Use a read-only session as `audit_reader` for the affected tenant and time range only.
3. Record who, when and the query purpose with `infra/ci/ops-note.sh`; the access itself is audited.
4. Close the session when done; never export raw rows beyond the incident's evidence set.
