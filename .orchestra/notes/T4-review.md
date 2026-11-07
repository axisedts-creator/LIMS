APPROVE
Round 3. Scope: git diff dc4cf7b..HEAD = identity/index.ts (manifest) + repository/__tests__/sessions.repo.live.test.ts + notes.
Round-2 items 1–3 fixed and re-checked against db/migrations/20261105001300_identity__create_identity_schema.sql + 20261105000400_core__create_users_and_memberships.sql: sha256 32-byte tokens (sessions__token_len__ck), createDb({pool, identitySystemActorId}) (tx.ts identityAuthTx), lock_reason_code='security_concern' (memberships__lock_reason__ck). Seed rows also satisfy sessions__kind_shape__ck, __idle__ck (30 min), __absolute__ck (11 h < 12 h), __revoke__ck (revoked_at + 'logout').
Names verbatim, fail-closed, no PHI/secrets (synthetic UUIDs, 203.0.113/198.51.100 doc ranges, *.example email), owned paths only, nothing invented.
Ran: verify cmd -> 2 files passed, live file skipped (90 passed / 9 skipped).
OPEN (not a code defect, for lead/verify): live suite + p95<=3 ms @500 rps bench NOT executed — `pg` is not installed in services/api and no LIMS_TEST_DATABASE_URL was set. done_when bench item stays open until someone runs it on a migrated DB (bash db/tests/run-suites.sh bootstrap, LIMS_TEST_API_DATABASE_URL=lims_api) and records the `T4 bench:` line in notes/T4-tests.md.
Not a C2 defect: runtime db wiring into module construction remains open with C0-0D (CR-C2-020).
