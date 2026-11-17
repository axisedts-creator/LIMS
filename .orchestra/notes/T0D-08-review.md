APPROVE

Round 2. Prior item 1 fixed: `services/api/src/core/core-repo/dead-letters.ts:82` returns `{ items: [] }` for `platformRows: true` + `tenantId`, after input validation and before any SQL; covered by new test in `core-repo/__tests__/dead-letters.test.ts:249` (empty items, no `nextCursor`). No other source changes since round 1 (`git diff 976c11c..HEAD -- services/`). Verify cmd: 144/144 pass.

Non-blocking (unchanged, out of done_when): `systemActorPermissions` (CR-C2-013) not implemented; `ctx.*` wiring and real 4-arg `withTenantScope` left to owning task; SQL semantics/RLS untested without DB (db/tests).
