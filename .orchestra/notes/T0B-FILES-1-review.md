APPROVE
# T0B-FILES-1 review round 2 (reviewer)
Checked: diff 77aee6fa5..HEAD, focus on 1ac224833..HEAD (review fixes). Round 1 item 1 resolved:
- services/api/src/core/storage/direct.ts:23-28,78: `ConfirmUploadInput.unrecorded?: true` documented; `storage.delete` runs only when `i.unrecorded === true`, otherwise `common.validation_failed` and the object stays. Optional (not required) field is correct: a required literal would make the no-delete path untypeable.
- direct.test.ts:171 deletion case now passes `unrecorded: true`; new case (175-183) asserts validation_failed + object still present for size/sha/type. Test strengthened, not weakened.
- CR "Proposed change" line added (server-issued, not-yet-recorded objectPath only). impl.md CR path corrected to `T0B-FILES-1.nonblocking.md`.
Earlier checks (names verbatim, no routes/permission codes per LD-310 d, no PHI/URL/secrets in logs, owned paths only, TTL <= 300 s, tenant + bucket checks before signing) unchanged by the fixes.
Ran: api vitest src/core/storage + src/core/uploads = 125 pass, 2 skipped (live). api tsc --noEmit clean.
Non-blocking: direct.ts:72 doc comment "A wrong object is deleted" should add "only with unrecorded: true". sha256 check at confirm still depends on SP-1 provider binding (CR says so).
