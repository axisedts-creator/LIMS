TESTS_WRONG — the 3 boot tests bootstrap with `loadConfig({ LIMS_CORE_ENV: 'ci' })` and no JWT config; the spec gives that config no default, so a module whose contract uses bearerJwt cannot boot that way.

Change in `services/api/src/modules/frontdesk/__tests__/unit/boot.test.ts` (lines 87, 94, 109): build the config with all four `LIMS_CORE_JWT_ALG/ISSUER/AUDIENCE/KEY_FILE` (key file from `services/api/src/core/auth/__tests__/helpers.ts`, synthetic key). Keep every assertion as is, including 400/401 for unauthenticated calls and "never runs a stub".

Reasons:
- spec/chunks/C0-foundation-contracts/02-TRD.md:945 — `LIMS_CORE_JWT_ALG/_ISSUER/_AUDIENCE/_KEY_FILE` have no default ("—"); values are set per env.
- spec/chunks/C0-foundation-contracts/02-TRD.md:623-624 — bearer tokens are checked against the pinned alg, key file, iss and aud. Without them no verifier exists, so the core fails boot closed (core/config.ts:64, core/openapi.ts:202). That behaviour is C0's and C4 must not weaken it.
- contracts/openapi/frontdesk.yaml secures its operations with `bearerJwt` (29 uses), so this module needs the JWT config to mount.
- spec/chunks/C4-frontdesk-billing/06-IMPLEMENTATION-PLAN.md:11 — done_when is "core boots with module"; it does not require booting without auth config.
