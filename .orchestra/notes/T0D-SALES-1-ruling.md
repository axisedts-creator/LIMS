TESTS_WRONG — sales1.harness.tsx:136 glob cannot match the literal `(staff)` route group, so `openSales` throws "missing page file" whatever the implementation.

Reasons:
- Brief (.orchestra/inbox/T0D-SALES-1-arbiter.md:21, DONE WHEN (2)) places the routes under `apps/web/src/app/(staff)/partners/sales/...`; brief line 15 files list says the same. The test must be able to load pages at that literal path.
- Arbiter check (picomatch 4.0.7, the matcher behind vite 7.3.7 / tinyglobby 0.2.17 import.meta.glob): pattern `app/(staff)/partners/sales/*/page.tsx` returns false for `app/(staff)/partners/sales/designations/page.tsx` and TRUE for `app/staff/partners/sales/designations/page.tsx`; `(...)` is an extglob group, not literal parens. `app/[(]staff[)]/partners/sales/*/page.tsx` returns true.
- `apps/web/src/app/(staff)/partners/sales/designations/page.tsx` exists, yet the harness would see PAGES = {}. Nothing in the spec or brief requires that failure; it is a test-tooling defect.
- Fix (tester): line 136 -> `import.meta.glob('../../../app/\\(staff\\)/partners/sales/*/page.tsx')` (writer's vitest proof) or `'../../../app/[(]staff[)]/partners/sales/*/page.tsx'`. Keys keep literal parens, so the line 145 lookup stays unchanged. Tester must confirm in a vitest run that PAGES contains the designations key before re-handing.
- No other assertion changes. Implementation is not affected by this ruling.
