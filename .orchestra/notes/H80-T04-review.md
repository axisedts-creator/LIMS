CHANGES

Reviewed `0c98648e` (impl) and `b3f15acc` (tests). The brief's range `7a4eaf6a..HEAD` is empty because HEAD = 7a4eaf6a and both commits are already ancestors. Neither file has changed since 0c98648e.
Checks run: `attachments.inline.test.ts` 25/25 pass. Full `src/modules/instruments/__tests__` gives 1 failing file outside T04 (`unit/signing.test.ts`, the Go fixture copy). `tsc --noEmit`: no errors in the T04 files.
Verified OK: names verbatim (`instruments.result.received.v1` `attachment {bucket, object_path, sha256, mime_type}` per 03-IC, `instruments-attachments`, core codes `common.unsupported_media_type|payload_too_large|upload_quarantined`); no new event; accept() opts as §6.8 step 2; scan required and fail closed; tenant-first object path; no PHI or bytes in logs, rows or events; only owned paths; ctx.uploads/ctx.storage are wired by core/pipeline for every handler.
Not raised, per LD-182: the JPEG refusal / CR-C7-018, and truth_h80e not filling inlineAttachment (both in cr/H80-T04.nonblocking.md). The five failures outside T04 are not caused by T04 files.

1. Open 3 is a real defect: the stored object is orphaned on rollback.
   - Where: `services/api/src/modules/instruments/service/ingest.service.ts:270-277` (accept() writes the object) together with `:347-353` (the savepoint catch).
   - Problem: if anything after a successful accept() throws, the savepoint rolls back the rows and the event, but the object stays in `instruments-attachments` with no reference. Examples: a second attachment record in the same message hits scanner `unavailable` (`:273-275` deletes only its own object), the event publish throws, or `insertRun`/`insertRecords` fails.
   - Effect: the agent retries the message and every retry stores another copy under a new uuidv7 path. A persistent error therefore grows unreferenced PHI-bearing images without bound. This breaks the module's own rule ("do not leave an orphan object", `attachments.service.ts:134`).
   - Fix:
     - Add `stored: { bucket: string; path: string }[]` to the per-message state: create it in `submitMessageBatch` and pass it to `processOne` through `B`, fresh for each message.
     - Right after accept() returns, push `{ bucket: up.bucket, path: up.objectPath }`.
     - In the catch at `:349`, before pushing `retry`, run `for (const s of stored) await ctx.storage?.delete(s.bucket, s.path).catch(() => undefined)`.
     - Keep the existing deletes at `:274` and `:302` (or remove those entries from `stored` once deleted).
   - Test: add one to `__tests__/attachments.inline.test.ts` using `realUploads()`: a message with two attachment records, where the 2nd accept() returns `scanState: 'unavailable'` (or `repo.insertRecords` throws). Expect `outcome: 'retry'` and `u.storage.paths()` to equal `[]`.
