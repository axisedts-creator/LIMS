# RM-T01 tests (tester)
Files (services/api/src/modules/identity/__tests__/role-packs/):
- role-packs.data.test.ts: data file == spec/program/11-ROLE-MATRIX.data.yaml; 19+10 roles; per-role permission/privileged counts (§3); codes in registry, sorted, unique; no default-role code, corp_/std_ prefix; privileged => mfa (R3); R4 caps; R2/R5 decision authorities, Admin has no clinical sign-off.
- role-packs.loader.test.ts: loader contract `loadRolePacks()` / `parseRolePacks(text, registry?)` from ../../role-packs/loader.js; rejects unknown code, default-role code (10 codes), privileged + mfa false, malformed input.
Run: `.orchestra\notes\RM-T01-verify.cmd` (= pnpm --dir services/api exec vitest run src/modules/identity/__tests__/role-packs).
Expected red now: role-packs.data.yaml and loader.ts do not exist (ENOENT / cannot resolve module).
Not tested here (other RM tasks): matrix replay, per-route guards, seed (RM-T02/T03). R8 (RLS scope) is not testable on the data file.
