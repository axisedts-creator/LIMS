# T0B-04 debug (round 1)
- Cause: verify log = `Command "verify" not found`. Lane root `package.json` (T0A-01) has no `verify` script; `main` has one (`turbo run build typecheck && node --test "tools/lint/tests/*.test.mjs"`). Not a T0B-04 defect: seed/policy/tests unchanged and pass (node --test tests/db 53/53 per impl note).
- Fix: none in T0B-04 files. Root `package.json` is C0-0A-owned (CHUNK-MAP §3), so not edited. Lane needs `git merge main` (harness does it in Integrate) then re-run verify.
- Note: main's `verify` runs only tools/lint tests, not tests/db; T0B tests would go unrun by verify. That is for 0A/lead.
