TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- Spec: spec/chunks/C8-analytics-mis/01-PRD.md:171 (US-11.4 rule 4) — a sample is anchored on the business date of its STOP event; within-lab = first-verified date.
- Seed helpers.t12.ts:128: specimen received D0 10:00 NPT with `lab: 77_777` → first_verified = D0 10:00 + 21h36m17s = D1 07:36:17 NPT, inside window [D1, D3).
- So per PRD:171 that within_lab sample (77 777 s) belongs in the report; the test's own emulator `deriveFacts()` (helpers.t12.ts:91, businessDate(stop)) agrees. Hand-computed expectations (within_lab n 4 / max 7200) contradict the spec and the seed.
- Fix in test, minimal: helpers.t12.ts:128 change `lab: 77_777` to a value keeping the stop on D0 (≤ 50 399 s, e.g. `lab: 40_404`). pre/transport 77 777 stay (stop = received = D0, out of window), so the `/77777|66666/` leak check at tat.handler.test.ts:197 stays valid.
- D3 row (helpers.t12.ts:129): all stops ≥ D3, correctly excluded; no change.
- Do not change ALL / A1_ONLY / MULTI / line 112 expectations; after the seed fix they hold as written.
- Implementation: no change required.
