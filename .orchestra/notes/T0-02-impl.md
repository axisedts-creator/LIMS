# T0-02 impl
- Files: tools/lint/ownership.yaml (new; ~170 rules). Tests: `node --test tests/lint/ownership.test.mjs` = 10/10 pass.
- [CONV] Modules listed one literal path per module (no `<m>` / brace groups), so each path has exactly one matching module rule and specificity ties cannot happen.
- [CONV] services/api, services/worker, apps/web: only the files CM s3 names are C0-0D (no `services/api/**` umbrella); any other path there is a gap on purpose, so the lint catches it.
- [CONV] Root lint configs as globs `.eslintrc*`, `eslint.config.*`, `.prettierrc*` (CM says "eslint config").
- No api/worker rules for admin/platform: CM module table has no such schema; web (staff)/admin, features/admin|platform -> C2.
- Open: `core`/`audit`/`migration_staging` are DB schemas only (under db/ -> C0-0B); no module paths given. CODEOWNERS generation + check-paths.ts left to T0A-02.
