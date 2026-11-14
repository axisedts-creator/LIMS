APPROVE

Reviewed `git diff 299c13d..HEAD` (T-09 post-ruling) against brief, LD-34, LD-43, LD-45, plan row T-09, 02-TRD s9.4.
Ran: `python -B -m unittest discover -s infra/tests/static -p "test_t09_*.py"` -> Ran 35, OK (skipped=1).
- Only change to tests: `@unittest.skip("needs data-1/dr-1 hosts (B12)")` on `DecisionTest.test_records_wal_per_day_measured`;
  reason verbatim per LD-34/LD-43, body unchanged, no other test weakened (matches T-09-ruling.md).
- Prior review items closed: Dockerfile:12 `ARG PGBACKREST_TARBALL_SHA256` is a 64-hex value (no longer empty; test now anchors
  on the ARG line); CheckCounterTest exercises fail/fail/ok -> 1/2/0; CR T-09 filed and resolved (`.orchestra/cr/T-09.resolved-*`);
  DECISION.md T-09 section lists check/full+incr/WAL-day as open (B12) with no invented measured value; the 24 GiB/day figure is
  labelled a planning estimate and is copied from 02-TRD s9.4.
- Secrets schema: repo2 cipher pass consumers exclude dr-1 (AC-12.3). No secrets, no PHI, only notes/tests touched in this diff.
Non-blocking: T-09-impl.md says "CR .orchestra/cr/T-09.md still open" but the CR is resolved; note text only.
Still open (not defects, deferred by LD-34): `pgbackrest check` on both repos, first full+incr, measured WAL/day on hosts (B12).
