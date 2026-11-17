## Debugger 2026-11-11 (verify fail: manifest+crontab test, 5000ms timeout)
Cause: no code defect. The test's first `await import('../index.js')` loads the whole worker manifest cold; the verify run was slow (27s) and exceeded vitest's 5s default. Only that one test failed; 47/48 passed, API suites passed.
Check: re-ran the same worker command three times (alone and with xsdSubset): 33/33 and 48/48 pass, 2–4s. Warm cache.
Fix: none in implementation; test timeout is a test/infra matter and tests may not be edited. Re-run verify; if it recurs under load, route to tester for a per-test timeout.
