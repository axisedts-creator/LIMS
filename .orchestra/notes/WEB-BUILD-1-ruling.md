TESTS_WRONG — build-boundaries.test.ts:207-215 asserts DiffTable.tsx is in `reached`, which the required fix makes impossible.

Reasons:
1. LD-194 SCOPE (3) (binding, .orchestra/inbox/WEB-BUILD-1-arbiter.md:31) and done_when (:21) require DiffTable.tsx to start with 'use client'; test (c) at build-boundaries.test.ts:217-221 enforces it.
2. LD-194 RULES (c) (:31) and the tests field (:22) require the walk to stop at modules that start with 'use client'; the scanner does this (build-boundaries.test.ts:101) and the self-test at :173 asserts such modules are NOT in `reached`.
3. So after a correct implementation DiffTable.tsx can never be in `reached`; :213 contradicts :101/:173 and the spec. Nothing in the brief/LD requires DiffTable to be a reached (non-client) module.
4. The shared.tsx half of the assertion (:212) is right: LD-194 SCOPE (2) keeps shared.tsx server-safe (no 'use client') and imported by labels/page.tsx, so it must stay on the walked graph.
Change to the test: in :207-215 drop 'packages/ui/src/components/DiffTable/DiffTable.tsx' from the arrayContaining list (keep shared.tsx). Replace it with an assertion that the audit page source imports DiffTable (e.g. its import resolves via resolveSpec to packages/ui/src/components/DiffTable/DiffTable.tsx) and that DiffTable is NOT in `reached` because it is a 'use client' boundary. Rename the test title accordingly.
Implementation note: the writer must still run the real build per LD-194 SCOPE (4) and RULES (d) once the test is fixed.
