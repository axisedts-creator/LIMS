# T0D-03 impl (writer)
- Files: new `core/db/{tx,sqlstate,allowlists}.ts`; `core/config.ts` adds txRetryMax / identityAuthOps / withTenantScopeOps (frozen; bad values fail naming the key).
- tx: BEGIN + one 6×`set_config(..., true)` + `now() AS tx_started_at` (§6.4 SQL), SAVEPOINT s<n>, retry 40001/40P01 up to retryMax with jitter `round(10+random*40)` ms, `ctl.noRetry()` request-level; errors mapped once after the retry decision.
- [CONV] unlisted SQLSTATE -> 500 common.internal; "connection errors" = socket errnos + class 08 + 57P01–57P03 -> 503; P0001 other than `immutable_row` -> 500.
- [CONV] withTenantScope accepts only tx objects created by createDb (WeakMap), refuses nesting, restores claims on throw (restore error swallowed only when fn already threw); tx.query rejects after its attempt ends (no use of a released connection).
- [CONV] mapped errors reuse `AuthError` (registry code + status) until T0D-04 LimsError; identityAuthTx refuses (common.internal) when identitySystemActorId unset.
- Dispute resolved (ruling TESTS_WRONG; retry.test.ts:150 fixed by tester); no impl change needed, 163/163 pass. Not wired yet: ctx.noRetry/ctx.db in HandlerContext (pipeline task), access-log row per withTenantScope (C2), real PgBouncer proof (SP-9).
