# T31 dispute (writer, review round)
Case: session-kinds.app.test.ts:97-101 "GoTrue refuses the refresh" asserts `w.committed('rotateToken')` has length 0.
Conflict: review item 1 (and the new lost-race case at :72, which asserts `w.gt.calls` is empty when `rotateToken` returns false with the access JWT due) requires `rotateToken` to run BEFORE the GoTrue refresh. When GoTrue then refuses, `deny` keeps every write of the tx (P-42 commitOnError), which includes the rotation. No implementation can pass both cases in one tx without a savepoint seam (the AppWorld fake has none).
The rotation kept on a revoked row is harmless: the new token never leaves the server; the old token then matches previous_token_sha256 of a TERMINAL row, so sessionByToken does not flag reuse and the request gets 401 (gone).
Proposed test fix: at :101 drop `expect(w.committed('rotateToken')).toHaveLength(0)` or replace it with `expect(otherWrites(w, ['rotateToken', 'updateSession', 'recordTenant', 'enqueue'])).toEqual([])`. All other expected values unchanged.
State: identity suite 3433 pass / 1 fail (this case) / 72 skip.

## Debugger confirmation (verify log 23:21, 1 fail / 101)
Failing: session-kinds.app.test.ts:101 `expect(w.committed('rotateToken')).toHaveLength(0)` after GoTrue refuses the refresh.
Spec: 08-CR-REGISTER.md:214 "the session token rotates on every refresh" and A3.1 (:1925-1927) fix WHAT rotates, not its order vs the GoTrue call; they do not require rotation to be absent on a refused refresh. The test's rotation-free expectation contradicts the lost-race case at :72 (rotateToken false + access JWT due => w.gt.calls empty), which forces rotateToken BEFORE the GoTrue call.
With P-42 commitOnError every write of the tx (incl. the rotation) survives the 401; the fake has no savepoint, so no implementation passes :72 and :101 together. Implementation left unchanged. Fix is test side: drop/replace :101's rotateToken assertion as proposed above.
