# API-T05 dispute — settings.service.test.ts:74
Test: `E41 … missing If-Match -> 428 …` calls `put(w, { ...BODY }, undefined)`.
Helper (line 16): `const put = (w, body, expectedVersion: number | undefined = 1) => …` — a default parameter turns `undefined` into `1`. So the call sends If-Match 1, body without window, against `withWindow()` row at version 1: a valid update (clears the window). The test expects rejection `common.precondition_required`; no correct implementation can both accept a valid update and reject it.
Impl already returns 428 for a truly missing `expectedVersion` (same `version()` as E13/E26; covered by instruments.service.test.ts E26 and E27-E31 cases).
Fix (tester): call `w.svc.updateInstrumentSettings(w.ctx, { expectedVersion: undefined, body })` directly, or drop the default value in `put`.
Result otherwise: 266/267 in the 4 API-T05 suites pass; only this test fails.
