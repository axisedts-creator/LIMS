# Microbiology runbook (`micro`)

Owner C10. One section per alert in `monitoring/rules/micro.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Microbiology.

## MicroInstrumentRecordsBacklog
Severity: warn   Owner: C10   Last tested: never (new in T-21)
**Means:** More than 50 open micro instrument records awaiting match for 24 h.  **Impact:** the Microbiology module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (tenant_id) (lims_micro_instrument_records_open{match_status=~"pending_match|needs_mapping|conflict"}) > 50` (expect: empty when healthy); Grafana D15-micro panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C10 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## MicroConsumerDeadLetter
Severity: warn   Owner: C10   Last tested: never (new in T-21)
**Means:** A microbiology event consumer dead-lettered.  **Impact:** the Microbiology module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_core_dead_letters_total{task=~"evt.micro.*"}[5m]) > 0` (expect: empty when healthy); Grafana D15-micro panel for the metric.
**Fix:** 1. Find the dead letter in the C2 platform console (dead letters, filter by task). 2. Read the error in VictoriaLogs (`dead_letter_created`, same task, last 30 min). 3. Fix the cause, then replay from the console; never edit rows by hand (see `runtime.md`).
**Escalate when:** still firing after one working day → the C10 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## MicroBreakpointImportDeadLetter
Severity: warn   Owner: C10   Last tested: never (new in T-21)
**Means:** The breakpoint import validation job dead-lettered.  **Impact:** the Microbiology module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_core_dead_letters_total{task="micro.breakpoint_import_validate"}[5m]) > 0` (expect: empty when healthy); Grafana D15-micro panel for the metric.
**Fix:** 1. Find the dead letter in the C2 platform console (dead letters, filter by task). 2. Read the error in VictoriaLogs (`dead_letter_created`, same task, last 30 min). 3. Fix the cause, then replay from the console; never edit rows by hand (see `runtime.md`).
**Escalate when:** still firing after one working day → the C10 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## MicroSubmitInternalErrors
Severity: warn   Owner: C10   Last tested: never (new in T-21)
**Means:** Microbiology submits failing with common.internal for 15 min.  **Impact:** the Microbiology module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(rate(lims_micro_submit_failures_total{error_code="common.internal"}[5m])) > 0` (expect: empty when healthy); Grafana D15-micro panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C10 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## MicroUnmappedReceived
Severity: warn   Owner: C10   Last tested: never (new in T-21)
**Means:** A micro specimen was received without a culture in the last hour.  **Impact:** the Microbiology module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (tenant_id) (increase(lims_micro_unmapped_received_total[1h])) > 0` (expect: empty when healthy); Grafana D15-micro panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C10 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
