# Quality runbook

Operator guide for the quality module (C9). Metric and alert names are in `services/worker/src/jobs/quality/ops/quality.rules.yml`. Logs carry ids and codes only; never copy patient values or sample barcodes into a ticket.

## QC rejected but C5 shows no hold

Symptom: the QC runs page shows a rejected run, but the lab does not block the analyte.

1. The run publishes `evt.lab.quality.qc_run.rejected.v1` in the same transaction as the rejection. Check the dead letters for that event type (alert `QualityConsumerDeadLetter`, metric `lims_core_dead_letters_total`).
2. If a dead letter exists, fix the cause named in its error code, then replay it from the dead-letter admin screen. The consumer is idempotent on `event_id`.
3. If none exists, check that the run is really rejected and that the instrument and analyte of the run match the lab hold rule. Alert `QualityRejectedRunWithoutAction` fires when a rejected run has had no corrective action for 4 hours.

## QC values not appearing

Symptom: instrument QC results are captured in the lab, but no run or point shows in quality.

1. Open the Unassigned QC page (`/quality/observations`). Rows there are observations that no QC plan, material or map accepts yet. Gauge `lims_quality_unassigned_observations` (label `status`) counts them per status; a rising count means a missing map or plan.
2. Check alert `QualityQcSyncStalled` (metric `lims_quality_qc_sync_last_success_timestamp_seconds`). It fires when the sync from C5 has not succeeded for 5 minutes. Look at the sync job log for the failing SQLSTATE.
3. Alert `QualityQcImportError` means a row was skipped (`lims_quality_qc_observations_total` with `status="import_error"`). The log has the `qc_result_id` and SQLSTATE only. A skipped row is not retried; fix the missing instrument or analyte reference and ask the lab to re-capture.

## Auto-verify never allows

Symptom: the decisions list shows only deny for a tenant.

1. Tenant switch: Quality settings must have the auto-verify feature switch on. With it off every decision is `feature_disabled`.
2. Active version: the analyte needs an active version. Without one the decision is `rule_missing`. A version in draft, simulating or stopped does not decide live.
3. QC plan coverage: the instrument and analyte of the result must be covered by an active QC plan, and the pair must be in control. Open the simulation report and read `deny_by_reason` to see which reason dominates.
4. Alert `QualityAutoverifyAllowWithReasons` is the opposite breach: an allow that carried reasons. Page the on-call; this must never happen.
