# T0C-VERLEVEL-1 dispute (debugger)
Verify fails on tests, not implementation. Arbiter already ruled TESTS_WRONG (.orchestra/notes/T0C-VERLEVEL-1-ruling.md) but the tester edits were never applied.
1. services/api/src/modules/lab/__tests__/probes/registry.static.test.ts:56-57 pins privileged lab codes without lab.verification_policy.manage. Task done_when 6 + spec/program/08-CR-REGISTER.md:645 (privileged => aal2); fails with `+ "lab.verification_policy.manage"`.
2. db/tests/lab/T0C-VERLEVEL-1_verification_levels.test.sql:195 no-op UPDATE (3 -> 3) writes no audit row (db/migrations/20261105000200_core__create_tenants.sql:52-55; spec/program/08-CR-REGISTER.md:2335). Change to required_verifiers = 2, keep 'n=1'.
Implementation unchanged. Tester must apply both edits, then re-run verify.
