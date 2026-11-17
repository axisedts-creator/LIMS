APPROVE

T0B-PROVFIX-4 review (reviewer, LD-299), diff 976309e8d..4f7febd5d.
- Contract: new `PlatformTenantSettingsDto` = exact copy of TenantSettingsDto properties + `training_mode: boolean` (optional), additionalProperties false, same required; only getTenantSettingsAsPlatform / updateTenantSettingsAsPlatform 200 repointed. Tenant ops (getSettings/updateSettings) and TenantSettingsPatch unchanged, so tenants still never see training_mode (LD-26). Nothing loosened, no new names beyond the one the brief prescribes.
- Service: platformDto, checkPlatformPatch, DTO_KEYS untouched (done_when 6). DTO_KEYS vs schema checked both directions by test, no one-sided key (done_when 4).
- Generated: identity.ts, server/operations.ts gain `training_mode?: boolean` on the two platform ops only. `codegen:check` clean (rerun by reviewer).
- Web: platform `Settings` = `Record<string, unknown> & { version }` (shared.ts:58), no type change needed (done_when 5).
- Tests: real service + real ajv options (AJV_OPTIONS, strict) over both platform ops, training_mode true/false/absent x pending present/absent, non-vacuous guards, schema-equality guard against future drift. Reviewer rerun: 4 files, 284/284 pass. Tester note records 12 fails on the pre-fix tree.
- Lint: `lint:openapi` fails only on pre-existing role-packs rule 4 (not touched here).
- No RLS/permission/rate tier/error code changes; no PHI, no secrets; owned paths only.
