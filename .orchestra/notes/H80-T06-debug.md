# H80-T06 debugger
- Verify log failure (worker start timeout, 0 tests) was the host error of LD-166; on re-run vitest started and showed 9 real failures, all `getByLabelText(/^name/i)` finding 2 elements: core "Name" and the schema-driven option "Name script".
- Fix (impl only): `components/InstrumentForm.tsx` options fields are labelled `Analyser option: <schema title>`, so a driver option can never collide with a core field label.
- Result: h80-t06 vitest config 30/30 pass. Not run: tsc, web-t03/rs-c7 regressions, Playwright/axe. Open: CR for `Driver.options_schema` (see impl note).
