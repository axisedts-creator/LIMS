APPROVE
Re-review (round 2) of edf4a04e..af0a59c6.
Prior #1 fixed: build_export.ts:44-59 SAVEPOINT build_export before build, ROLLBACK TO SAVEPOINT first in catch; Terminal and final attempt (attempt >= maxAttempts) commit failed (+ common.internal + log.error) and RESOLVE; retryable rethrows leave committed 'queued' (E6). markFailed after rollback-to-savepoint runs on a clean tx (fixes aborted-tx case).
Prior #2 fixed: buildExportFake.ts models db.tx = same job tx (consumer.ts:58), rollback-on-reject, savepoints, 25P02 after failed statement; build_export.test.ts asserts final attempt resolves with failed/common.internal, plus SQL-error final and non-final cases.
Ran: worker build_export.test.ts 43/43 pass; api export/__tests__ + exports.handler.test.ts + boot.test.ts 201/203 at default timeouts (2 boot failures = 30s timeout + cascade); boot.test.ts alone with --testTimeout/--hookTimeout=300000: 117/117 pass (environment slowness, predates AN-T15 per impl note).
Earlier checks still hold (names/codes verbatim, quota lock X16, download claim X14, own-row 404, P-2 headers, neutraliseFormula in every writer, uuid[] casts, no PHI/secrets, owned paths only).
Not verified: real Postgres/RLS/advisory lock, HTTP Idempotency-Key, real write-excel-file output in Excel. OPEN (6 registry reports refused on export) still needs a writer CR, not a code change.
