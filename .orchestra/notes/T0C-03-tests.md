# T0C-03 tests (AC-0C-1.3)
- File: `contracts/__tests__/registry-equality.test.ts` (Vitest; parses fenced yaml of IC §7/§8/§11 with `yaml` strict mode, compares to `contracts/{routes,errors,permissions}.yaml`).
- Also checks: unique ids/codes, permission regex, route->permission refs, no PHI route params, display_token nav:false, platform.* only to platform roles.
- Run: `pnpm vitest run contracts/__tests__/registry-equality.test.ts` (needs `vitest` + `yaml` devDeps from T0A-01 / contracts/package.json — implementer must add `yaml`).
- Fails now because `contracts/errors.yaml`, `routes.yaml`, `permissions.yaml` do not exist (assert "must exist"). IC-side guard test passes once deps are installed.
- NOT run: repo has no package.json/node_modules yet (T0A-01 pending); python probe of IC blocks was blocked, so counts (>100 errors, >60 routes, >150 perms) and the platform.* rule are unverified against IC.
- Implementer: copy IC YAML blocks verbatim (comments optional); equality is on parsed data, key order inside maps ignored, list order enforced.
- Ruling applied: "route ids unique" test now checks per-route `fallback` is member of `fallbacks:` list (unique), not a route id. Not re-run (no deps in repo).
