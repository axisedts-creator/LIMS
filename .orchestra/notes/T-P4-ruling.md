TESTS_WRONG — the setup() fixture never reaches the fake ReportingPort; the spec does not require the task to see rows pushed to the test's local array after the fake is built.
Reasons:
- spec/program/02-CONVENTIONS.md:954: fakes are seeded through `createFake<Port>({ seed, fixtures })` and must be deterministic. packages/fakes/src/base.ts:100 clones and deep-freezes `opts.fixtures` when the fake is built (mergeFixtures -> clone, base.ts:70). That makes `fixtures.push(...)` in setFixture (test lines 70-71, 77) invisible to the fake, so every `openReleasedReportFile` call gets `common.not_found`.
- spec/chunks/C16-patient-engagement/07-SECURITY.md:181 (store only when approved, read through ReportingPort): the task is right to store nothing on not_found. The failures come from the fixture, not from the behaviour.
Change in the test (fetch_smart_summary.test.ts setup(), nothing else):
- setFixture must seed through the fake, e.g. `let n = 0; const setFixture = (over = {}) => inner.__seed({ reports: [{ id: ID(0xb00 + n++), tenantId: w.tenantId, reportId: RPT, versionNo: 1, ...rest as now, ...over }] } as any);` (base.ts:118 `__seed` upserts by `id` and calls init(); `rp` delegates to `inner.openReleasedReportFile`, which uses the rebuilt methods).
- Drop the local `fixtures` array, or build the fake with `fixtures: { reports: [] }`. Keep every assertion and the wrapper as they are.
- Re-run all 33 tests after the change. The 18 that pass now with no stored row (draft / disabled / not_found) must still pass for the right reason: the port is called and returns the fixture.
