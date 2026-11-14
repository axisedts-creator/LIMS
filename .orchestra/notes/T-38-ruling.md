TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- Spec spec/chunks/C3-catalog-pricing/04-UI-UX.md:233 requires the "Import stuck" runbook entry to name worker queue `catalog.import_*` (also spec/chunks/C3-catalog-pricing/03-APP-FLOW.md:328). Writer intends to write it verbatim; that satisfies the spec.
- apps/web/src/features/catalog/__tests__/web-t38.docs.test.ts:22 `norm()` strips every `*` (`replace(/[`*]/g, '')`), and :26 `allManual()` applies norm to all manual text.
- So :229 `expect(t).toMatch(/catalog\.import_\*/)` can never pass for any content, including the exact spec spelling. The assertion is unsatisfiable, not a spec requirement.
Required test change (tester), line 229 only:
- Replace with `expect(t).toMatch(/catalog\.import_/);` (matches normalised `catalog.import_*`), OR assert on raw (un-normalised) manual text: `expect(mdIn(manualDir).map((n) => raw(join(manualDir, n))).join('\n')).toMatch(/catalog\.import_\*/);`
- Second form is preferred: it keeps the verbatim spec name `catalog.import_*` enforced.
- Do not change other assertions in this test.
