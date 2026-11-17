# BL-T18 impl (writer)
Files: services/worker/src/jobs/billing/tasks/export_tenant.ts (new), services/worker/src/jobs/billing/index.ts (register, maxAttempts 1, no cron), docs/manual/billing/tenant-export.md (new).
[CONV] archive "LBX1"|iv|tag|AES-256-GCM(JSON), key env LIMS_BILLING_EXPORT_KEY; sha256 = rows one-JSON-per-line in PK order; path `<tenant>/tenant-export/<stamp>-<rand>.lbx`.
[CONV] FK order computed from pg_constraint (topological, ties by name); no-PK table falls back to x::text order.
Open: live tests (2 DBs) not run here; openArchive also re-checks manifest vs rows.
