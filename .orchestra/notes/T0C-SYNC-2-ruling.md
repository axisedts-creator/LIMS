TESTS_WRONG — services/api/src/core/__tests__/sync2.pending.test.ts:14 builds the covered set from health handlers only; it must be the handlers bootstrap actually builds (health + sync).

Change in the test: add `import { syncHandlers } from '../sync/index.js';` and replace line 14 with
`const healthHandlers = { ...createHealthHandlers(okChecks()), ...syncHandlers };` (same as sync1.pending.test.ts:11,18). No other line changes; 32-35 stays valid (part 2 ids still have no handler).

Reasons:
1. LD-325 (a)/(b) (binding, inbox T0C-SYNC-2-arbiter.md:34): every T0B handler task removes the ids it implements from the pending list; a handler wins over a pending id. T0B-SYNC-1 did exactly that for the 7 part 1 ops.
2. The test's own header (sync2.pending.test.ts:1-2) says it must stay green "on both sides of that move" — with health-only handlers it cannot once part 1 handlers merge.
3. Boot reality: services/api/src/core/bootstrap.ts:91-92 calls checkHandlers('core', spec, { ...health, ...syncHandlers }, CORE_PENDING_OPERATIONS); the test's line 30 checks a handler set boot never uses.
4. Sibling test sync1.pending.test.ts:17-18 already uses health + syncHandlers with the same LD-325 rationale.
5. The only implementation workaround (re-adding 7 implemented ids to CORE_PENDING_OPERATIONS) contradicts LD-325 (b) and would keep the production gate (bootstrap.ts:61) counting implemented ops as pending. Not acceptable.
6. LD-371 (inbox :38) says no code/contract change is expected in this task; the fix belongs in the test.
