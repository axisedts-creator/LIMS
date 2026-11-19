APPROVE

Scope: `git diff ea6e5f6a..HEAD` (6 commits, writer/tester/arbiter/debugger).

Checked
- done_when (1): `core/storage/s3.ts` implements full RawStorage incl. signUpload/signDownload/head; SigV4 query signing over node:crypto, no new dependency. Upload binds content-type, content-length, x-amz-content-sha256, x-amz-meta-sha256, if-none-match:*; download binds response-content-disposition/type/cache-control.
- (2): exactly the 7 STORAGE_* names; half set / unknown provider / bad endpoint / bad bucket / bad FORCE_PATH_STYLE stop boot via `loadConfig` with `config:` messages naming keys only, never values; none (or unset) = proxy streaming. `.env.example` not readable by me (permission); covered by s3-config.test.ts:99/103.
- (3): AWS published vector, tampered length/type/checksum, dropped headers, create-only (412, replay), expiry, both path and virtual host style, all against the in-process fake on localhost.
- (4): docs/ops/STORAGE.md has Supabase founder steps, MinIO move (endpoint + keys only), round trip check, backup/restore, no-real-patient-data warning; no secrets.
- (5): no route wired; impl note lists the P-2 routes/files.
- (6) re-run by reviewer: s3 suites 136/136; `vitest run src/core` 3 runs in a row, each 75 files passed / 1 skipped, 2858 tests passed / 31 skipped, 0 fail; `tsc --noEmit` clean.
- Security: object paths still go through assertOwned/assertTenantPath in index.ts before RawStorage; errors are `storage: <op> failed (<status>|network)` only (no URL, signature or secret); no PHI logged; no key material in source.
- No RLS/permission/idempotency/rate-tier/error-code surface in this task (no table, no route).

Notes (not blocking)
- Debugger commit a84a7e25b emptied `pendingOperations` in modules/billing/index.ts and modules/frontdesk/index.ts (C4-owned paths per 01-CHUNK-MAP, outside this task's file list). Change is correct (bootstrap.ts:65 rejects pending ids that have handlers; LD-325 said REGAPI-2/ACCT-1 should have removed them) and it restores the core suite, but the lead should record it against those tasks.
- Create-only relies on the store honouring `If-None-Match: *` on PUT. The fake does; Supabase S3 support is unverified. Founder round trip check should include a second upload to the same key expecting 412 before trusting create-only on the test project.
- Virtual host style with a dotted bucket over https breaks the wildcard TLS certificate; docs already say path style for Supabase/MinIO.
