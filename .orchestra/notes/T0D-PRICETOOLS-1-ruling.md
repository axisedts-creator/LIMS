TESTS_WRONG — pricetools1.source.test.ts:57 counts a folder that predates this task; the spec does not forbid pre-existing catalog routes.
Reasons:
1. `apps/web/src/app/(staff)/catalog/import-templates` was added by 7b0106219 "[writer] T-35 impl" (git log --diff-filter=A), long before T0D-PRICETOOLS-1.
2. `git diff --stat main...HEAD -- apps/web/src/app` shows only the two existing price-lists page.tsx files modified; no folder was added under app/(staff)/catalog, so the test's stated intent ("no page, route or layout file was added for the tools") is met.
3. The task brief (.orchestra/inbox/T0D-PRICETOOLS-1-arbiter.md:20) says "WHAT EXISTS (read first, extend, never replace)" and even allows new catalog routes ("New routes under the staff billing, partners, catalog ... areas are allowed"); nothing requires the absence of the T-35 import-templates screen.
4. The plan row (spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md) has no text for T0D-PRICETOOLS-1 that mandates this check; the assertion is a tester design guard only.
Change in the test (line 57): exclude folders that exist on main. Minimal form:
  `const PRE_EXISTING = new Set(['import-templates']); // T-35 screen, 7b0106219`
  `expect(dirs.filter((x) => /compare|copy|bulk|template|upload/i.test(x) && !PRE_EXISTING.has(x))).toEqual([]);`
Keep the rest of the test unchanged so any new compare/copy/bulk/template/upload folder still fails.
