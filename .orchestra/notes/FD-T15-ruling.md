TESTS_WRONG — admin/duplicates.test.ts:33, :69, :85-86, :107 build "twins" without `phone_e164`, so seedPatient (patients/helpers.ts:108) gives each a different random phone; by the spec predicate two present, different phones are NOT duplicates.
Reasons:
- spec/chunks/C4-frontdesk-billing/02-TRD.md:220 (F26) — predicate is "normalised name, birth year ±1, same phone when both present"; different present phones fail it.
- spec/chunks/C4-frontdesk-billing/01-PRD.md:147 (US-FD-02.2) — duplicate requires "same phone".
- The test itself asserts this rule at duplicates.test.ts:28-29 (case 3, c1/c2 not listed), so the four fixtures contradict the test's own case.
What the TESTER changes (duplicates.test.ts only; assertions unchanged):
1. :33 case 5 — give e1 and e2 one shared phone (or `phone_e164: null` on both).
2. :69 — the 7 identical people share one phone (e.g. `const ph = phone()` and pass `phone_e164: ph`), or pass `phone_e164: null`.
3. :85-86 mkPair — x and twin share one phone per pair (or `phone_e164: null`).
4. :107 — each pair (per `t`) shares one phone (or `phone_e164: null`).
Implementation unchanged: patients.repo.ts dedupe predicate matches 02-TRD.md:220.
