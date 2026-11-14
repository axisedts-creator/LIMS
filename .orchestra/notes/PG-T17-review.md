APPROVE

Re-review after fixes (1e9b06f7..HEAD):
- Prior finding 1 resolved: merchant.service.ts:224 now compares `refund_two_person_threshold_paisa` numerically (`Number(before[k]) !== body[k]`), so a node-pg int8 string no longer logs an unchanged threshold in `settings.change`. New test seeds the threshold as the string '250000': an unchanged PUT logs only `reconciliation_enabled`, and a changed PUT logs only `refund_two_person_threshold_paisa`.
- No other code changes. All diff paths are owned (payments module/jobs + PG-T17 notes).
- Tests (run by reviewer): api 95/95, worker 9/9.

Earlier checks still hold: names verbatim; write-only secret; env guard; every P22 outcome returns 200; lazy settings row (P-22); field-names-only access log; rewrap is AAD-bound and fail-closed.
Not verifiable here: RLS/row-audit (no payments migration in this task); route/permission wiring and cron registration come in later tasks.
