APPROVE

Round-2 item 1 resolved: integrity_check.ts:524 `credited` now sums billing.credit_notes joined via credit_notes.invoice_id -> invoices.order_id (02-TRD.md:382 "Balance:"); live case added (CN with NULL order_id: matching credited -> clean, credited 0 -> order_balance violation).
Open question from writer (cancelled invoices) is settled: TRD:382 says `invoiced = Σ net of issued invoices of the order (any status)`, so no status filter is correct.
Rounds 1-2 items all resolved. Names (task ids, crontab 45 18 / 0 20, per_tenant, maxAttempts 5/1, metric + labels), tenant guard, read-only check, no PHI/secrets in logs, owned paths: OK.
Re-ran here: `npx vitest run services/worker/src/jobs/billing/__tests__/` -> 16 passed, 10 skipped (no LIMS_TEST_DATABASE_URL).
Not blocking but MUST be done before merge: the live suite (done_when "detects planted gap") has never run against a migrated DB. Branch-scope `INV:<branch_code>` prepare and chronology-only violations are still untested.
