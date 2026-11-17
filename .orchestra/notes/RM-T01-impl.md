# RM-T01 impl (writer)
- Files: identity/role-packs/role-packs.data.yaml (byte copy of spec/program/11-ROLE-MATRIX.data.yaml, LD-141), identity/role-packs/loader.ts (`loadRolePacks()`, `parseRolePacks(text, registry?)`), identity/domain/role-pack.ts (types + pure `validateRolePacks`).
- [CONV] Registry type and default reused from domain/permission-set.ts (DEFAULT_REGISTRY = C0 generated constants); default role codes (roles + partner_roles + platform_roles) read once from contracts/permissions.yaml via core REPO_ROOT, same as tenant.service.
- [CONV] Fail closed: throws Error naming the offending code on unknown permission, default-role-code collision (R6), privileged + mfa_required false (R3), duplicate template code, unknown base_default_role, malformed doc/version.
- R4 caps and R2/R5 overlay are properties of the data file (asserted by role-packs.data.test.ts); loader does not re-encode them (would duplicate the matrix).
- Tests: vitest role-packs 31/31 pass; tsc no errors in new files. eslint config does not cover these paths (ignored), not linted.
- Open: loadRolePacks reads the YAML via import.meta.dirname; the build step must copy role-packs.data.yaml next to loader.js (no copy rule checked here).
