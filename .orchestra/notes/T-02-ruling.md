TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- Spec rule enforced by T-01 scan is correct: spec/chunks/C1-infrastructure-ops/01-PRD.md:146 (AC-05.2: gitleaks over `infra/` zero findings) and 07-SECURITY.md:33 (REQ-SEC-128). T-01 check stays as is.
- The spec does not require any test file to carry the key-marker literals; the failure comes only from `infra/tests/static/test_t02_providers.py:228`, whose regex source contains the raw strings `PRIVATE KEY-----` and `AGE-SECRET-KEY-`, which T-01 (`test_t01_skeleton.py:186`) correctly flags.
- No implementation file is implicated; T-02 implementation needs no change.
- Change in test (tester): on line 228, build the markers by concatenation so the source never holds the contiguous literals, e.g.
  `re.search("PRIVATE" + " KEY-----|AGE-SECRET" + "-KEY-|ENC\\[AES256_GCM", t)`
  (same pattern as `test_t01_skeleton.py:164`). Keep the assertion semantics identical.
- Do NOT widen T-01's exemption to `infra/tests/static/test_*.py`: that would weaken AC-05.2 coverage for files under `infra/`.
