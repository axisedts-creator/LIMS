# T0C-03 impl
- Files: contracts/errors.yaml, contracts/routes.yaml, contracts/permissions.yaml — verbatim copies of IC §8/§7/§11 fenced blocks (unchanged this round).
- Review/ruling: no T0C-03-review.md exists; ruling (fallbacks vs route ids) was test-only, applied by tester in aaaed60. No impl change needed.
- Tests: `vitest run contracts/__tests__/registry-equality.test.ts` — 14/14 pass (vitest 4.1.12 + yaml, temp install outside repo, alias config).
- [CONV] Equality on parsed data; YAML copied from IC, no invented names.
- Open: no contracts/package.json (owned by T0C-01); `yaml` + `vitest` devDeps must be added there for in-repo `pnpm vitest`.
