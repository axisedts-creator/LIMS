APPROVE

VERIFY-GREEN-2 review (reviewer, 2026-11-16), diff e2b79c96e..HEAD.

- Scope: only CatalogPort.impl.ts, conversion.service.ts, 2 new tests + 1 tsconfig fixture under catalog/partners `__tests__`, and lane notes. No contract, policy, grant, migration, seed or SQL edits.
- Types only: `asCtx()` is an identity cast (same object, so the revisions WeakMap key does not change); brand casts (Uuidv7, DecimalString, IsoDate) on values that are already present; `as unknown as` on resolveOrderables arrays and Reference/CriticalLimits matches. I checked rangeMatch.ts:98-115: the runtime objects are the same as before, and the cast only widens `kind: string` and the brand types. No @ts-ignore, @ts-expect-error, `as any` or new skipLibCheck (enforced by vg2.typecheck.test.ts).
- Money/order statement: buildBookingOrderInput (the order input to FrontdeskPort) emits identical values. No emitted value, rounding, status, idempotency key or SQL changed. This is pinned by vg2.buildBookingOrderInput.test.ts (toStrictEqual, absent vs undefined keys). No billing, payment or invoice code was touched.
- No PHI in logs, no secrets, no invented names. RLS, permissions and error codes are untouched (not in scope).
- Ran: `pnpm exec vitest run src/modules/catalog src/modules/partners`: 121 files passed, 7324 passed, 2 skipped. The vg2 tsc gate is included, so modules/catalog and modules/partners have 0 errors.
- Not verified by reviewer: the full-package api count (66 -> 38) and `turbo run typecheck --continue` (the shell refused the full tsc run). The writer's impl note says vg2-tsc-after.log was not written. Nonblocking, but the lead should rerun it for the per-package after counts that done_when asks for.
