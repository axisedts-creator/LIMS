Title: CR-C0-FILES-1: direct-to-storage upload/download routes for files above 256 KiB (wire core storage/direct.ts into modules)
From chunk: C0 (T0B-FILES-1, LD-310)            To owner: C0-0B (api contract) + module owners C3 frontdesk, C5 instruments, C6 reporting, C7 engagement, micro, anatomic, partners, billing, identity
Type: api
Blocking? no (core helper + kit shipped in T0B-FILES-1; module wiring waits for this CR)

Problem: done_when 1 analysis (from the code, 2026-11-17). Today EVERY file path moves the bytes through the API process:
| flow | path today | code |
| attachment upload (instruments) | API (multipart -> ctx.uploads.accept -> storage.put) | modules/instruments/service/attachments.service.ts:102 |
| attachment download (instruments) | API (ctx.download.stream reads all bytes) | attachments.service.ts:150 |
| report download, staff | API (storage.read in handler) | modules/reporting/handlers/reports-read.handlers.ts:182 |
| report download, patient portal | API (storage.read) | modules/reporting/service/portal.service.ts:261 |
| report download, engagement downloadMyReport | API: signed URL used SERVER side, bytes fetched then re-sent | modules/engagement/service/report.service.ts:142 (P-L1: URL never leaves API) |
| label and PDF print download | API (storage.read) | modules/reporting/service/print.service.ts:99 |
| import upload (micro breakpoints CSV, instruments ingest inline) | API (ctx.uploads.accept) | micro/service/breakpoint.service.ts:234, instruments/service/ingest.service.ts:273 |
| TRF upload / view | API (ctx.uploads.accept / ctx.download.stream) | frontdesk/service/trf.service.ts:97, :130 |
| outsourced report, narrative image, anatomic image, branding, IRD docs, billing/audit exports, partner slips | API | grep ctx.uploads.accept / download.stream |

Why T0B-FILES-1 could not make them direct (done_when 7):
1. New routes are needed (`POST .../uploads:init`, `POST .../uploads:confirm`, download `mode: direct` response); the brief allows only additive fields and LD-310 (d) puts routes and permission codes off limits.
2. 08 A13 P-2 / P-L1 and module rules E37, F21a say "no Storage URL is ever produced / reaches a response"; returning a signed URL to the browser is a security-rule change that needs the lead.
3. Upload scan, magic bytes and PNG re-encode (REQ-SEC-083..085, D-67) need the bytes: on the direct path they must move to the worker after confirmUpload (row `scan_state: pending`, object under the quarantine key). Re-encoded images (anatomic, narrative, branding) and CSV imports (API checks UTF-8/NUL) stay on the proxy path.
4. The Storage HTTP API is not pinned (SP-1): `RawStorage.signUpload / signDownload / head` exist only as an interface; the real provider must bind type, length, sha256 (x-amz-checksum-sha256 style), create-only and response headers into the signature.

Proposed change (exact, additive): per flow, `POST <collection>/uploads:init {filename, contentType, byteSize, sha256}` -> `{mode, objectPath, upload?: {url, method, headers, resumable, expiresAt}}`; `POST <collection>/uploads:confirm {objectPath, contentType, byteSize, sha256}` -> the existing attachment resource (row inserted only here); download endpoints add optional `?mode=direct` -> 200 `{url, expiresAt, acceptRanges}` for files > 256 KiB. Same permissions as today's upload/download operation. Uses core `createDirectTransfer` (services/api/src/core/storage/direct.ts).
Backward compatible? yes (existing multipart and streaming routes stay for <= 256 KiB and for clients without direct support).
Tenant/security impact: new public surface = short-lived (300 s) signed URLs to the browser; tenant + permission checks before signing; access-log row at issue time; patient reports `Cache-Control: private, no-store`. Needs P-2 amendment. REQ-SEC-083..085.
Alternatives considered: keep proxy but stream (no buffering): smaller change, but still one extra hop through the free-tier API host; can be done first per module.
Tests that will prove it: core/storage/__tests__/direct.test.ts (exists) + per module handler tests: no multipart body accepted on init, confirm refuses a missing/mismatched object, row absent until confirm.
