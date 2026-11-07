# BL-T01 tests (module skeletons — "core boots with module")
- `services/api/src/modules/billing/__tests__/unit/boot.test.ts`: manifest validates (name/openapi/produces = 3 billing events), handler set = billing.yaml operationIds, real `bootstrap()` boots with default modulesDir and every op is mounted and not 2xx/500 unauthenticated, permissions.ts codes exist in permissions.yaml, config.ts only LIMS_BILLING_* keys, no cross-module imports.
- `services/worker/src/jobs/billing/__tests__/unit/manifest.test.ts`: `manifest` (WorkerManifest, module `billing`) passes `validateManifests`; task ids `billing.*`.
- `apps/web/src/features/billing/__tests__/nav.manifest.test.ts`: `navManifest` (module `billing`) accepted by `buildNav`; permissions exist.
- Run: `.orchestra\notes\BL-T01-verify.cmd` (vitest from repo root).
- Contract assumed (02-CONV §2.2/2.3, build-nav.ts): exports `manifest` (api, worker), `navManifest` (web). Impl needs `handlers/index.ts` (stubs → `common.service_unavailable`, like FD-T01) because the core requires a handler per operationId; not in the brief's file list.
- NOT run: worktree has no node_modules, so the tests are unexecuted here; expected failure now = import of missing `../../index.js` / `../nav.manifest.ts`.
