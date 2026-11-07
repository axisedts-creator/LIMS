# T-01 tests (tester, chunk C3-catalog-pricing)
- File: `services/api/src/modules/catalog/__tests__/unit/skeleton.test.ts` (vitest): manifest/autoload, 107 handlers, 9 permissions, §11 config, stub inventory (CR-C3-008), REQ-SEC-099.
- Run: `.orchestra/notes/T-01-verify.cmd` (= `pnpm --filter @lims/api exec vitest run src/modules/catalog/__tests__/unit`; needs `pnpm install`).
- Expected now: fail on import (modules/catalog/* missing). Not run here: no node_modules in this worktree.
- Interface assumed (writer must match): `manifest` (index.ts), `handlers` (handlers/index.ts), `CATALOG_PERMISSIONS: string[]` (permissions.ts), `loadCatalogConfig(env)` (config.ts) with camelCase fields = key minus `LIMS_CATALOG_` (e.g. `cacheMaxEntries`); non-integer/negative/empty values throw naming the key.
- `probes/pending.json` = JSON array of operationId strings (format not in spec; assumed); must equal the set of handlers that reject `LimsError('common.service_unavailable','not_implemented')`. Writer creates it.
- Name clash: C1 also has T-01 notes under `.orchestra/notes/T-01-*`; this overwrote T-01-tests.md and T-01-verify.cmd (C1's remain in git history). The LD-06/LD-17 lead decisions in the inbox are infra-only (C1) and do not apply here.
- Retest (lead APPROVED_RETEST): core/__tests__/boot.test.ts 5 "core sample module" bootstrap() calls now pass modulesDir: fixturesShared() + "/does-not-exist" (as line 53). No prod change. verify.cmd also runs boot.test.ts.
- Ran: boot.test.ts 22/22 pass. skeleton.test.ts FAILS: probes/pending.json ENOENT (writer deliverable, absent on disk although impl note says it exists). Writer must recreate it.
