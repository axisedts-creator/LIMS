# T-38 tests (docs review, tester)
- `apps/web/src/features/catalog/__tests__/web-t38.docs.test.ts` + `vitest.web-t38.config.ts` (node env; reads markdown only).
- Checks: help/<slug>.md per screen (SCR-01…19; slugs home, departments, specimens, methods, units, tests, analyte, ranges, panels, comment_codes, doctors, credit_parties, price_lists, price_list, price_list_version, price_simulator, surcharges, tax, imports + every `helpKey="catalog.*"` in components) with title, `## Purpose`, route, permission, exact §4 copy, tax disclaimer, two-step text, no banned word.
- Manual: docs/manual/catalog/README.md (links resolve) + one `<slug>.md` per screen + `integration.md` (04-UI-UX §7 items) + runbook entries + tax onboarding note.
- ASSUMED naming (help = last helpKey segment; SCR-07/08 = analyte.md/ranges.md) is stated in the test header; dispute if wrong.
- Run: `.orchestra\notes\T-38-verify.cmd` (copy: C3.T-38-verify.cmd). Now: 213 fail / 3 pass (files missing = right reason).
