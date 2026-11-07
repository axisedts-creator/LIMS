# BL-T17 impl (writer)
Files: services/worker/src/jobs/billing/{tasks/fiscal_counter_prepare.ts, tasks/integrity_check.ts, cron.ts, index.ts (manifest registers both tasks, maxAttempts 5/1, crontab)}.
Run: wiring 16 pass; live 7 skipped (no LIMS_TEST_DATABASE_URL) — SQL NOT executed against a real DB.
[CONV] integrity checks: seq_gap (count=max(seq) and counter.last_no=max(seq), INV*/CN), chronology (lag issued_at by seq), print_count (invoices + credit_notes vs print_log), order_balance (invoiced/credited vs sums, only orders with a balance row; paid not checked).
[CONV] prepare: current FY via billing fiscalYearOf; next FY when BS month=3 & day>=25 (Asia/Kathmandu); closes FYs whose start year < FY(now-1d), compared numerically; INSERT ... ON CONFLICT DO NOTHING, no last_no write.
Open: per-branch INV series not prepared; RC (receipts) not integrity-checked (no document table); order_balance rule re cancelled invoices unverified; live DB run needed.
