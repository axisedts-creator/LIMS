CHANGES

Scope checked: `git diff 633df067..HEAD` (queue.handlers.ts, queue.repo.ts, queue.service.ts, handlers/index.ts, test). Permissions, x-idempotency, If-Match 428/409, centre probes (07 §6.4), tenant binding, static SQL, no PHI/secrets, owned paths: OK. 105/105 tests pass locally (vitest, fake tx; real-Postgres RLS not exercised).

1. services/api/src/modules/engagement/service/queue.service.ts:24 (DUP_PATH use at :105) and :132 — invented sub-codes `common.field_duplicate` and `common.field_immutable`; neither exists in the error registry (03-INTERFACE-CATALOG.md §8, lines 2471-2489). Fix: use `common.field_invalid` for both (keep paths `/code` | `/display_name` and `/centre_id`; 02-TRD §5 Q1c only requires `400 common.validation_failed` on `/code`). If a distinct sub-code is wanted, raise a CR instead.

2. services/api/src/modules/engagement/repository/queue.repo.ts:15 and :32 — `LIMIT 500`, but the contract caps list responses at `maxItems: 200` (contracts/openapi/engagement.yaml:4830, 4966, 5104, 5236). A centre with >200 rows returns a contract-violating 200. Fix: `LIMIT 200` in both list statements; add a test that the repo SQL/rows are capped at 200.

3. services/api/src/modules/engagement/service/queue.service.ts:107 (reached from `create`, :115-122) — pg 42501/23503 on INSERT maps to `common.not_found`, which is not in the x-error-codes of `createQueue` / `createCounter` (engagement.yaml:4866-4874, 5139-5147; no 404 response declared). Fix: in `create`, map 42501/23503 to `common.validation_failed` with `[{ path: '/centre_id', code: 'common.field_invalid' }]` (same as the `centreExists` miss at :117); keep `common.not_found` only for `update`. Tighten test lines 294/300 to drop `common.not_found` for create.
