# VERIFY-GREEN-4 impl (writer)
- Errors before -> after (`tsc --noEmit`, per package): api 9 -> 0, worker 10 -> 0; `turbo run typecheck --continue --filter=@lims/api --filter=@lims/worker` exit 0.
- Quality: settings.handlers.ts (conditional spread, no `expectedVersion` key when absent), observation.service.ts (`...an`, no `analyteId` key when undefined), chart.service.ts (typed `head` group; same keys, same order).
- Worker: fetch_smart_summary.ts (`typeof versionNo !== 'number'` guard; `Number.isInteger` already rejected non-numbers), purge.ts (`tenantId?: string | undefined`), send_delivery.ts (ctx type gains `attempt`/`maxAttempts`, which JobContext supplies, manifest.ts:31).
- [CONV] TS5097: `allowImportingTsExtensions` added ONLY to services/api and services/worker tsconfig (both already `noEmit: true`). Least loosening: shared-ts keeps .ts specifiers so `node --test` works; nothing is emitted from these two packages, and base/shared-ts are untouched.
- No `as any` / `@ts-ignore` / `@ts-expect-error` / skipLibCheck added. No money or order code touched; no emitted value, rounding, status or SQL changed (the spreads only drop keys whose value was `undefined`, which the pins test treats as equal).
- Tests run: api vitest 6 files / 212 pass; worker vitest 4 files / 118 pass; shared-ts `node --test` 228 pass. Not run: full api/worker suites, the DB-backed suites.
- Open: none; no CR needed, no line required a runtime change.
