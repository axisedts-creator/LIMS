TESTS_WRONG — session-kinds.app.test.ts:101 asserts `w.committed('rotateToken')` has length 0 after GoTrue refuses the refresh; no spec line requires that.
Change in the test (line 101 only): replace `expect(w.committed('rotateToken')).toHaveLength(0)` with `expect(otherWrites(w, ['rotateToken', 'updateSession', 'recordTenant', 'enqueue'])).toEqual([])`. Keep every other assertion of the case (401 auth.session_expired, commitOnError x1, state revoked, revoke_reason refresh_failed, one refresh_failed event).
Reasons:
1. spec/program/08-CR-REGISTER.md:214 — "the session token rotates on every refresh"; says WHAT rotates, not its order vs the GoTrue access refresh, and nothing about rotation on a refused refresh.
2. spec/program/08-CR-REGISTER.md:1925-1927 (A3.1 / CR-C2-018) — only defines the previous_token_sha256 move and the reuse revoke; silent on refused refreshes.
3. spec/chunks/C2-identity-admin/02-TRD.md:125 and 03-APP-FLOW.md:244 — a refresh failure requires only: session `revoked`, reason `refresh_failed` (plus event/alert counter). The test still checks all of that.
4. The task's P-42 requirement (commitOnError keeps the tx writes through the 401) means a rotation done before the GoTrue call survives; with the lost-race case at :72 (no GoTrue call when the rotate guard misses) rotation must precede GoTrue, so :101 as written is unsatisfiable without a savepoint seam the spec does not ask for.
5. A rotated token on a revoked row is never returned to the client and a revoked row resolves to 401, so no security property in 07-SECURITY AU-T15/AU-T22 is weakened.
