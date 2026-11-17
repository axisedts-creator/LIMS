TESTS_WRONG — the test asserts navigation to an id the mocked API never returned; change the expected URL, not the implementation.
Change in `apps/web/src/features/catalog/__tests__/cattests1.tests-page.test.tsx` line 293: expect `/catalog/tests/${ID(1000)}` (the id of the mocked 201 body), OR change the mocked reply at lines 118 and 124 to set `id: ID(900)` explicitly. Leave every other assertion of the test unchanged.
Reasons:
- spec/chunks/C3-catalog-pricing/02-TRD.md:226 — POST `/v1/catalog/tests` returns `201 Test`; the created test's id is the one in that body.
- spec/program/03-INTERFACE-CATALOG.md:2291 and spec/chunks/C3-catalog-pricing/04-UI-UX.md:18 — detail route is `/catalog/tests/{test_id}`; `{test_id}` must be the created Test's id.
- Test file line 61: `test(n)` sets `id: ID(100 + n)`, so `test(900, ...)` at lines 118/124 yields `id: ID(1000)`; the expectation `ID(900)` is a fixture arithmetic error.
- Navigating to an id not returned by the API would be a defect; the implementation's push of the 201 reply id is the correct behaviour.
