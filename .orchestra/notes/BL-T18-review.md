APPROVE

# BL-T18 review (reviewer) — diff a64e7cd..023c163

- Names verbatim: task `billing.export_tenant` (02-TRD §7.2 row, §13; maxAttempts 1, not on crontab), bucket `billing-exports` (03-IC storage table), `billing.integrity_check`. Archive format + `LIMS_BILLING_EXPORT_KEY` are marked [CONV] (spec silent) — acceptable.
- Matches §13: FK order (topological from pg_constraint), rows by PK, tenant_id filter, encrypted archive (AES-256-GCM, AAD, auth tag) + manifest (table, row_count, sha256). Restore + integrity_check in runbook.
- Tenant isolation: guard rejects missing/non-string/mismatched tenant before any query or put; reads only via ctx.tx under tenant claims (RLS applies); path first segment = tenant_id (07-SECURITY REQ-SEC-034/035). Table names validated against IDENT before interpolation.
- No PHI/secrets in logs (only event + table count). No secrets in files (test key random at runtime).
- Owned paths only (services/worker/src/jobs/billing, services/api/src/modules/billing, docs/manual/billing).
- Tests: done_when (checksums match, zero foreign rows, gapless continuation) covered by live suite; tamper/wrong key/truncation; read-only source. US-BL-15.2 deferred to existing T0B-10 schema test (ok).
- Ran: vitest tenant-export-restore.test.ts -> 6 passed, 9 skipped (live suite skipped: no LIMS_TEST_DATABASE_URL / LIMS_TEST_RESTORE_DATABASE_URL). Live DB path NOT verified here; must run in CI with two DBs.
