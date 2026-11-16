# PLATFORM-PROVISION-1 tests (tester)
- services/api/src/modules/identity/__tests__/provision-contract.test.ts: real request validation (core/openapi.ts body ajv options) of provisionTenant; fixture accepted, no contract_acceptance / no title refused with field path, limits 32/120/80, UTC accepted_at, additionalProperties; generated copies (api-client-ts operations.ts, identity.ts) carry the field.
- apps/web/src/features/platform/__tests__/provision1.form.test.tsx (+ vitest.provision1.config.ts): Contract acceptance section, limits, no hard coded version, UTC default now, body equals fixture, required checks, single flight, idempotency key, provisionTenantAction validation.
- apps/web/src/features/platform/__tests__/provision1.payload.json: the exact body the form builds; shared by both tests above.
- t26.tenants.test.tsx: fillValid now also fills the four contract fields (needed once they are required; no assertion changed).
- Not mine: tools/codegen codegen.test.ts "committed outputs equal generated output" goes red after the yaml edit until `pnpm codegen` is run (the repo's snapshot gate); it is in the verify.
- Run: `.orchestra\notes\PLATFORM-PROVISION-1-verify.cmd` (api package, web package x2, codegen package).
- Assumed labels (dispute if wrong): ToS version, DPA version, Accepted by (name), Accepted by (title), Accepted at (datetime-local); heading "Contract acceptance".
