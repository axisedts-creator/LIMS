LEAD ITEM, LD-422 (2026-11-19):

Debugger across 3 rounds: the security-authz guards are correct (537 of 537 authz-specific tests
pass per the impl note); the only red is tests/security/authz-classification.json being stale
against its own generator, classify-authz.mjs. Separate from this chunk of red, noted by the
debugger but not part of it: existing billing and payments suites lack IdentityPort fixtures
(about 297 tests fail); that needs its own tester fixture round, not an authz-classification
change.

Verified directly by the lead, not taken on the debugger word alone: ran classify-authz.mjs in
lane C1, plain node, no PG container, no vitest. Fresh counts: guarded-exact 931, unguarded 47,
guarded-other 31. Committed counts: guarded-exact 838, unguarded 130, guarded-other 41. Total
operations 1177 both times, none added or removed. Diffed every one of the 93 changed operations
by name, not just the aggregate counts: zero moved to a weaker class, all 93 moved toward
stronger guarding. Same shape as SEC-AUTHZ-4 and SEC-AUTHZ-5, the next module group in the LD-261
rollout.

RULING: TESTS_WRONG, snapshot regeneration only, no implementation change, no assertion loosened.

For the tester: run node tests/security/classify-authz.mjs from the repo root; it prints the
fresh classification to stdout. Write that output over tests/security/authz-classification.json,
replacing the file exactly, then commit it. Writer and debugger may not hand edit this file.
Before committing, confirm the diff only moves operations toward guarded-exact, never toward
unguarded, guarded-other, stub or inconclusive; if any operation instead moved to a weaker class,
stop and write a dispute instead of committing. The separate IdentityPort fixture gap in billing
and payments (about 297 failing tests, named in the debug file) is not part of this ruling and
needs its own round; name it in the next tester note instead of trying to fix it here.

Reset: C1 SEC-AUTHZ-6 to changes.
