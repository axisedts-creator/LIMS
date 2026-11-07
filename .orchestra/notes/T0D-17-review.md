APPROVE

# T0D-17 review (reviewer)
- Diff 18995f2..HEAD: only owned paths (`services/{api,worker}/src/core/{uploads,storage}/**`, `download.ts`) + own notes/CR. No `spec/`, lockfile or package.json edits.
- Names verbatim vs 03-IC §13.6: `UploadMime`, `BucketName` (11 buckets, A26.3), `UploadAcceptOptions`, `AcceptedUpload`, `ctx.storage.{put,read,move,signedUrl,delete}` signatures, `signedUrl` ttl ≤ 300, `maxBytes` ≤ 15 MB, `maxMegapixels` default 40, `scan: not_applicable` only for text/csv.
- Config keys `LIMS_CORE_SCANNER_URL` / `LIMS_CORE_SCANNER_TIMEOUT_MS` with defaults `tcp://clamd:3310` / 30000 (D-209), INSTREAM; `LIMS_CORE_STORAGE_KEY_FILE` the only credential source (07 §6). Metric `lims_core_storage_deletes_total{bucket,reason}` (P-12).
- Error codes all in contracts/errors.yaml: common.upload_quarantined (422), common.unsupported_media_type (415), common.payload_too_large (413), common.dependency_unavailable (503), common.internal.
- Fail closed: scanner reply must be exactly `stream: OK`; any error/timeout → `unavailable`; infected → 422, not stored; download serves only `scanState === 'clean'`, else 422. Tenant = first path segment, traversal/encoding refused; writes owner bucket only, reads any known bucket (P-13).
- AC-0D-3.3: attachment + nosniff + no-store, access-log row before response, no signed URL in response/logs (raw storage errors dropped, log carries op+bucket only). No PHI in logs, no secrets in files.
- RLS / idempotency / rate tier / permissions: n/a (no tables, no routes in this task).
- Checks run: api vitest storage+uploads 91 pass / 2 skipped (live gated); worker vitest 45 pass; api `tsc --noEmit` clean. Worker has no tsconfig.json (pre-existing, not this task).
- Not verified: live dev-stack Storage + clamd integration (`live.test.ts` gated, LD-51 no container runtime). Open items correctly parked in `.orchestra/cr/T0D-17.nonblocking.md` (Storage URL key/raw client shape, delete reason values, JPEG decoder).
