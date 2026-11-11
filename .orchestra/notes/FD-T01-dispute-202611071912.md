# FD-T01 dispute — 3 boot tests use an env the core must reject

Tests: `boot.test.ts` "bootstrap with default repoRoot/modulesDir resolves", "every frontdesk operation is mounted …", "mounts nothing outside the spec".
All three call `bootstrap({ config: loadConfig({ LIMS_CORE_ENV: 'ci' }) })` — no `LIMS_CORE_JWT_*`.
Failure: `Error: module frontdesk: bearerJwt operations need LIMS_CORE_JWT_* config` (services/api/src/core/openapi.ts:202).
Why the test is wrong: contracts/openapi/frontdesk.yaml secures its operations with `bearerJwt`; the core fails boot closed when JWT config is absent (comment at core/config.ts:64 "bootstrap refuses to mount any bearerJwt operation"). No module change can make this pass without weakening auth, and core is not C4-owned.
Fix (tester): pass a full JWT config, e.g. reuse services/api/src/core/auth/__tests__/helpers.ts (key file + `LIMS_CORE_JWT_ALG/ISSUER/AUDIENCE/KEY_FILE`), then the 400/401 assertions apply.
Status: other 27 vitest + 9 node:test cases pass with the implementation.
