# AN-T12 dispute (writer)
Test seed is self-contradictory; 10 handler tests fail on ONE sample, everything else in the 3 files passes (81/91).
- `helpers.t12.ts` seedT12 line 128: `SP(A1, BR1, 'serum', 'routine', D0, '10:00:00', { pre: 77_777, transport: 77_777, lab: 77_777 })` is labelled "before the window".
- Its pre_analytical / transport stop = received = D0 10:00 NPT (out, correct). But within_lab stop = first_verified = received + 77 777 s = D1 07:36 NPT = INSIDE [D1, D3).
- `deriveFacts()` (same file) and US-11.4 both anchor on the STOP event, so the emulator itself emits a within_lab sample (duration 77 777) on D1. Result: within_lab n 5 / max 77777 instead of the hand-computed n 4 / max 7200 (ALL, A1_ONLY, MULTI, routine, window test, "many users").
- No implementation can both honour US-11.4 and return n 4 here; the impl output equals the emulator's own figures.
Fix (tester): give that D0 specimen a `lab` <= 50 000 s (stop stays on D0), e.g. `lab: 40_404`, and keep the 77777 leak check on pre/transport (or change the `/77777|66666/` regex). Same check for the D3 row: fine as is (stop >= D3).
