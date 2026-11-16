# T0B-PROVFIX-4 impl (writer, LD-299)
Hand edited (1): `contracts/openapi/identity.yaml` — new `PlatformTenantSettingsDto` (TenantSettingsDto copy + `training_mode: boolean`, optional, additionalProperties false, same required); only `getTenantSettingsAsPlatform` / `updateTenantSettingsAsPlatform` 200 now $ref it. Tenant ops, TenantSettingsPatch, checkPlatformPatch, platformDto, DTO_KEYS untouched.
Generated (`pnpm --dir tools/codegen codegen`): `packages/api-client-ts/src/identity.ts`, `packages/api-client-ts/src/server/operations.ts`. `codegen:check` clean.
[CONV] full property copy, not allOf: allOf + additionalProperties false would refuse every key. Future TenantSettingsDto edits must touch both (contract test enforces equality).
DTO_KEYS vs schema: no one-sided key (tester test, both directions) — no CR.
Tests: verify suite 284/284 pass (was 12 fail). `@lims/api` typecheck pass. apps/web: `Settings` is `Record<string, unknown>`, no change needed.
Pre-existing, not mine: lint:openapi (role-packs rule 4, core Readiness missing_env maxLength); codegen vitest 5 fails (same + TRD inventory + engagement §5.1); @lims/web typecheck errors in test files/portal (msw `onUnhandledRequest`, LabSettingsPage, portal imports).
