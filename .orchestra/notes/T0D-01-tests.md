# T0D-01 tests (tester)
- Files: `services/api/src/core/__tests__/{config,boot,openapi}.test.ts`, `helpers.ts`, `fixtures/**` (shared fixture specs + one dir per failing/ok manifest case).
- Run: `.orchestra\notes\T0D-01-verify.cmd` = `pnpm --dir services/api exec vitest run src/core/__tests__` (needs `services/api/package.json` with `@lims/api`, vitest, fastify 5.12.8, fastify-openapi-glue 4.12.0, yaml; workspace entry is a C0-0A CR, LD-05).
- Assumed API (impl must match or dispute): `loadConfig(env)->frozen {env,responseValidation,loadSampleModule}` (only `LIMS_CORE_ENV` required; throws naming the key); `bootstrap({config,repoRoot?,modulesDir?})->Promise<FastifyInstance>` ready, rejects on boot failure; `repoRoot` holds `contracts/openapi/<m>.yaml`, `modulesDir` holds `<m>/index.ts`.
- Covers: AC-0D-1.1 (mount, ignore dirs w/o index.ts, status/body/headers applied), 1.2 (missing + extra handler name operationId), 1.3 (produces vs IC §3.25 for `catalog`/`identity`), autoload rules (name, spec exists, canonical openapi path, claimsResolver only identity, PORT_OWNERS), REQ-SEC-099 no unspecced routes, SP-8 O1/O2/O4, sample module only ci+flag.
- Needs from impl: `core/__fixtures__/sample.yaml` (3.0.3, path indented 2 spaces, method 4) + `module-sample/`. Sample test boots with the real default repoRoot/modulesDir.
- Fails now: `../bootstrap.js` / `../config.js` do not exist (and `services/api` has no package.json).
- Not tested here: auth/security handlers (T0D-02), error body shape (T0D-04), health (T0D-10), CI manifest-vs-IC check job (T0C), `main.ts` listen.
