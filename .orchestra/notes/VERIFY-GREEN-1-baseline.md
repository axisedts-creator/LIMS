# VERIFY-GREEN-1 baseline (writer, lane C1 at 28adc3c1b)
`pnpm -s verify` exit 1 (turbo stops at the first failed package). `turbo run build typecheck --continue`: 12/15 tasks ok; FAILED @lims/api, @lims/worker, @lims/web typecheck. build ok.
Errors (`error TS` lines per package): api 38, worker 42, web 290.
- api 38: TS2835 x24 (contracts/ports/*.ts extensionless: common.ts 14, Billing/BillingCommand/Catalog/Frontdesk/Identity/Lab/Notification); TS5097 x2 (shared-ts bsdate/index.ts:2, formula/index.ts:3 `.ts` specifiers); TS2430 x5 (identity handlers confirmEmailToken, loginStaff, resolveSession, setPasswordFromSetup, verifyMfaChallenge); TS2379 x5 (quality settings.handlers.ts:12, observation.service.ts:191,192, + chart.service.ts TS2339 x4 level_code/lot_no).
- worker 42: same TS5097 x2; TS2883 x12 (analytics mappers/schedules.dto.ts x5, service/schedule.service.ts x6 + 1); TS2379 (api quality observation.service x2, worker engagement/tasks/purge.ts:36,43); TS2339 reporting/tasks/send_delivery.ts:148 (attempt, maxAttempts); plus TS2835 via contracts.
- web 290: TS2307 portal pages (missing @/features/portal/*, @/server/*), TS2379/TS2339/TS2345 in `__tests__` files (catalog web-t32..t35, instruments, inventory, partners). Not touched: test files + missing modules, not types/specifiers of the named files.

## Backlog after first slice (LD-256; `turbo run typecheck --continue` 2026-11-16: api 66, worker 27, web 290; TS2835/TS2883/TS2430 = 0)
Every class below needs a runtime line, a cast or a shape change, so it is outside "types and specifiers only" (LD-253) and left for a later task:
- api catalog/ports/CatalogPort.impl.ts: TS2352 x18, TS2322 x7, TS2375 x1 (un-hidden by ports/common.ts `any` -> real types; row/DTO shape vs port type, IsoDate/Uuidv7 brands: needs casts or mapper edits).
- api frontdesk/service/registration.service.ts TS2345 x12, order.service.ts TS2345 x9 (worker re-reports 12): local Ctx not assignable to RequestContext (un-hidden; needs ctx shape change in order/money code).
- api billing/ports/BillingPort.impl.ts TS2352 x3, BillingCommandPort.impl.ts TS2352 x3 + TS2322 x1, service/invoice.service.ts TS2322 x1 (worker re-reports 3): un-hidden, money code, casts/shape.
- api partners/service/conversion.service.ts TS2322 x1, TS2375 x1 (worker re-reports 2): un-hidden, shape.
- api quality settings.handlers.ts TS2379 x1, observation.service.ts TS2379 x2 (exactOptionalPropertyTypes: needs conditional spreads = runtime), chart.service.ts TS2339 x4 (level_code/lot_no not on row type: shape).
- shared-ts bsdate/index.ts:2, formula/index.ts:3 TS5097 x2 per api/worker: kept on purpose, node --test needs `.ts`; allowing would loosen api tsconfig.
- worker engagement/tasks/purge.ts TS2379 x2, reporting/tasks/send_delivery.ts TS2339 x2 (attempt/maxAttempts), engagement/tasks/fetch_smart_summary.ts TS18046 x2: runtime/shape.
- web 290: TS2353 x171 (test files: unknown prop in render/fixture objects), TS2722 x35 (catalog web-t32.server.test.ts), TS2698 x29 (instruments tests spread of non-object), TS2604/TS2786 x7 each (lab tests), TS2307 x7 + TS7006 x2 (portal/src/app/r: missing @/features/portal/*, @/server/* modules), rest TS2345/TS2339/TS2379/TS2375/TS2532/TS2554/TS18048/TS18049/TS2493/TS4104/TS2352 in `__tests__`: test-file or missing-module fixes, not this task (test edits forbidden).
