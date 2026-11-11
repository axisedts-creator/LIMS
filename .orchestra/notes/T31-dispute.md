# T31 dispute (writer, review round)
Case: session-kinds.app.test.ts:97-101 "GoTrue refuses the refresh" asserts `w.committed('rotateToken')` has length 0.
Conflict: review item 1 (and the new lost-race case at :72, which asserts `w.gt.calls` is empty when `rotateToken` returns false with the access JWT due) requires `rotateToken` to run BEFORE the GoTrue refresh. When GoTrue then refuses, `deny` keeps every write of the tx (P-42 commitOnError), which includes the rotation. No implementation can pass both cases in one tx without a savepoint seam (the AppWorld fake has none).
The rotation kept on a revoked row is harmless: the new token never leaves the server; the old token then matches previous_token_sha256 of a TERMINAL row, so sessionByToken does not flag reuse and the request gets 401 (gone).
Proposed test fix: at :101 drop `expect(w.committed('rotateToken')).toHaveLength(0)` or replace it with `expect(otherWrites(w, ['rotateToken', 'updateSession', 'recordTenant', 'enqueue'])).toEqual([])`. All other expected values unchanged.
State: identity suite 3433 pass / 1 fail (this case) / 72 skip.
