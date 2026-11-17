# BL-T17 impl (writer)
Files: services/worker/src/jobs/billing/{tasks/fiscal_counter_prepare.ts, tasks/integrity_check.ts, cron.ts, index.ts (manifest registers both tasks, maxAttempts 5/1, crontab)}.
Run: wiring 16 pass; live 9 skipped (no LIMS_TEST_DATABASE_URL) — SQL NOT executed against a real DB. Worker has no tsconfig: no typecheck run.
[CONV] integrity checks: seq_gap (count=max(seq), counter.last_no=max(seq); INV*/CN/RC, RC from ledger_entries.receipt_seq), chronology (lag issued_at by seq; RC uses created_at), print_count (invoices + credit_notes vs print_log), order_balance (invoiced/credited/paid vs sums; paid = signed ledger sum; only orders with a balance row).
[CONV] prepare: INV/CN/RC + `INV:<branch_code>` per active core.branches when billing.settings.invoice_series_scope='branch'; current FY via fiscalYearOf; next FY when BS month=3 & day>=25; closes FYs < FY(now-1d); ON CONFLICT DO NOTHING, no last_no write.
Review items 1–3 applied; round 2: credited now summed via credit_notes.invoice_id → invoices.order_id (TRD "Balance:").
Open: live DB run needed before merge; order_balance rule re cancelled invoices unverified.
