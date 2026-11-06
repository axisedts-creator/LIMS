APPROVE

Scope: `git diff b878e92..HEAD` = test-only change in contracts/__tests__/registry-equality.test.ts:122-124 plus notes. No contract YAML changed.

- Fix matches .orchestra/notes/T0C-03-ruling.md exactly: `fallbacks:` unique; each per-route `fallback` is a member of `fallbacks:`. Route-id uniqueness and origin-resolution asserts unchanged.
- Verified against IC: 03-INTERFACE-CATALOG.md:2275 (`fallbacks: [portal.report_link_required, portal.app_fallback]`), :2318 and :2413 (per-route fallbacks use those ids). contracts/routes.yaml:10, :53, :148 match.
- No assertion weakened beyond what ruling requires; equality test (AC-0C-1.3) still on parsed data for §7/§8/§11.
- Only owned paths touched (contracts/, .orchestra/notes). No names invented, no secrets, no PHI. RLS/permissions/idempotency/rate tier/error codes: N/A for this diff (registries only).

Not verified by reviewer: test run. Reviewer sandbox blocked npm/python, so 14/14 pass rests on implementer note (temp install outside repo). Open item unchanged: contracts/package.json with `vitest` + `yaml` devDeps (owned by T0C-01) is needed for in-repo runs.
