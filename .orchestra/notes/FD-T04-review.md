APPROVE

Scope: `git diff f312441b..HEAD`. It holds no implementation change, only the search.test.ts probe revision, notes, and a committed run log.
- search.test.ts:165-172 follows ruling 9138d0fc items 4a/4b/5. The tenant-wide `countPatients` is gone. "Table intact" is now checked with the seeded p.id row via `ownerRows` and with `pg_class oid = to_regclass('frontdesk.patients')`, which returns 0 rows if the table is dropped, so the probe still fails closed. The 200/validation, ≤20 rows and no-anonymised assertions are unchanged. REQ-SEC-080/081/082 coverage (07-SECURITY.md:34) is kept.
- No spec names, permissions, error codes, RLS or PHI paths are touched by this diff. Notes contain no secrets.
- .tmp/fd04b.log is a test-run log. It contains synthetic tenant UUIDs only, with no PHI and no secrets. It is a non-blocking repo-hygiene item for the orchestrator, not a task defect.
- The open items already logged in FD-T04-impl.md (duplicate_override reason not checked against the coded set; dedupe TOCTOU) predate this diff and are out of its scope.
