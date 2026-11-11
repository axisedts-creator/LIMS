# FD-T15 dispute — admin/duplicates.test.ts fixtures contradict the dedupe predicate

Run: `bash tests/frontdesk/FD-T15.pg.sh` (2026-11-11) -> 74 passed, 4 failed, all in admin/duplicates.test.ts:49, :71, :94, :109.

Cause: `seedPatient` (patients/helpers.ts:107-108) defaults `phone_e164: phone()` — a fresh random number per patient. The failing cases build "twins" without passing `phone_e164`, so each twin gets a DIFFERENT phone. The US-FD-02.2 predicate (02-TRD §2.3; domain/patient.ts:40 `isDuplicateSuspect`; the test file's own header line 3: "same phone when both present") says two present, different phones -> NOT a suspect. The same file asserts exactly that in case 3 (:29, c1/c2 -> not listed), so the fixtures contradict the test's own rule.
- :33 case 5 (e1/e2), :69 (7 identical people), :85-86 (tz pairs), :107 (paging pairs): no `phone_e164` given -> random distinct phones -> correctly not suspects -> empty/short results.
- Cases that pass explicitly set a shared phone (a1/a2) or `phone_e164: null` (d2).

Proposed TESTER fix (duplicates.test.ts only): in those four fixtures pass `phone_e164: null` (or one shared phone per twin group), e.g. `mk(...)` default `{ phone_e164: null, ...o }` and the same in `mkPair`. No implementation change requested; the predicate in patients.repo.ts:62 matches the spec and the passing cases.
