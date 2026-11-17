# AN-T01 tests (tester)
- API (vitest) `services/api/src/modules/analytics/__tests__/boot.test.ts`: manifest vs core `validateManifest`; 30 operationIds mapped; stubs 501 in dev only, never echo input; 5 `analytics.*` permissions, bearerJwt-only; `LIMS_ANALYTICS_*` config; real `bootstrap` mounts 30/30, unauth 401.
- Worker (vitest) `services/worker/src/jobs/analytics/__tests__/manifest.test.ts`: subscriptions == 12 C8 events parsed from IC §3.25 == EVENT_CONSUMERS.analytics; 8 tasks, 4 per_tenant crons, maxAttempts/taskOptions == TRD §9.4.
- Web (node:test) `apps/web/src/features/analytics/__tests__/nav.manifest.test.ts`: 6 entries verbatim (04-UI-UX §1), build-nav passes.
- Run: `.orchestra\notes\AN-T01-verify.cmd` (needs `pnpm install`; none in this worktree, so NOT run here).
- Seams writer must use: `manifest` (api `index.ts`, worker `index.ts`), `navManifest`, `ANALYTICS_PERMISSIONS` (frozen), `loadAnalyticsConfig(env)` with camelCase fields (see header of boot.test.ts); stub: dev -> `{status:501}`, staging/production -> reject `common.internal`.
- SPEC CONFLICT: 04-UI-UX §1 gives analytics.reports chord `g m`, already owned by instruments.messages; build-nav fails on it. Test requires another unique `g <letter>` (not pinned). TRD §9.3 says attempts 3 for sweeps/purge but §9.4 literal omits them; literal asserted.
- Expected now: API + worker fail on import (files missing); web fails (manifest missing); chord-clash and drift-guard web tests pass.
