APPROVE

Re-review of `7a4eaf6a..HEAD` (review fixes `4b7468d2` tests, `ebede0fc` impl) against item 1 of the previous review (Open 3, orphaned object).
Checks run: `src/modules/instruments/__tests__` gives 2061 pass, 1 fail. The failure is `unit/signing.test.ts` (Go fixture copy, AG-T11), which is not caused by T04. `attachments.inline.test.ts` passes, including the new orphan test. `tsc --noEmit` reports no errors in the T04 files.
Item 1 fixed:
- Each message gets its own `stored[]` (`MB`). `processOne` receives a shallow spread, so it shares the same array.
- Every object that accept() stores is pushed to that array, and this happens before the scan-state check.
- The savepoint catch deletes every object in the array (best effort) before returning `retry`.
- The duplicate_event branch deletes its object and removes it from the array in place.
- The inner catch only swallows the codes in ATT_REJECT. `common.internal` from a scanner outage still propagates, so the message is retried.
- The new test (2nd record scanner unavailable) checks retry, no events, no rows and `storage.paths() == []`.
Still verified OK from the previous pass:
- Names are verbatim, there is no new event, and the scan is required and fails closed.
- Object paths start with the tenant, and logs, rows and events carry no PHI or image bytes.
- Only owned paths are edited.
Per LD-182, I did not raise the JPEG refusal / CR-C7-018 or the missing OBX-5 fill. Both are in `cr/H80-T04.nonblocking.md`.
Non-blocking note (not a defect against done_when): if the OUTER batch transaction fails after the savepoints commit, the objects stay orphaned (impl note says so). Consider a post-commit/rollback hook or a storage sweep in a later task.
