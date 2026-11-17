TESTS_WRONG — settings.service.test.ts:74 never sends a missing If-Match; fix the call, keep the assertion.
Reasons:
- Spec requires If-Match on E41 (spec/chunks/C7-instrument-integration/02-TRD.md:719) and a missing one maps to 428 `common.precondition_required` (spec/program/03-INTERFACE-CATALOG.md:2447). The assertion's expected code is correct.
- But helper `put` (test line 16) declares `expectedVersion: number | undefined = 1`; JS default parameters replace an explicit `undefined` with the default, so line 74 sends expectedVersion 1 against a version-1 row — a valid E41 update (body omits both window fields = "neither", 02-TRD.md:742). The spec requires that call to succeed, so the test contradicts the spec as written.
Change in the test (line 74 only): call the service directly so the precondition is truly absent:
  `expect(code(await rejection(w.svc.updateInstrumentSettings(w.ctx, { expectedVersion: undefined, body: { ...BODY } })))).toBe('common.precondition_required');`
(or remove the `= 1` default from `put` and pass `1` explicitly at every other call site). Do not weaken the 428 or 409 assertions, nor the "no writes / no publish" checks on line 76.
