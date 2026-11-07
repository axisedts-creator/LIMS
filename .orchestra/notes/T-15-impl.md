# T-15 impl (writer) — review round
- Files: role auditstore templates/psql.j2 (PGHOST=127.0.0.1, item 1), tasks/main.yml (schema.sql `-1`, item 4); infra/auditstore/digest.sql (DO loop backfills missed nights D-6..D ascending, only days newer than the chain's latest link, item 3); DECISION.md (verdict UNVERIFIED, off-host digests NOT YET IMPLEMENTED, items 2/6); new `.orchestra/cr/T-15.md` (secret ids, off-host digest owner, auditstore-drift CI; item 7).
- [CONV] digest backfill uses a PL/pgSQL DO block (each INSERT sees the previous day's link); older holes behind an existing link are never filled (chain order kept).
- DISPUTE: `.orchestra/notes/T-15-dispute.md` — l.536 (no IPv4 literal) contradicts the new loopback test l.565. Static 62/63, only l.536 red.
- Live test (item 2) NOT run: needs Linux + PG17 (`LIMS_T15_LIVE=1`); this machine is Windows without PG server binaries. DECISION.md stays UNVERIFIED until it runs.
- Item 5 = tester (done in c325b1b). Open: CR T-15 (secrets schema ids, off-host digest shipping, CI job); pg_hba.conf.j2 `groups['dr'][0]` in lean (T-04).
- Tests: `python -B -m unittest discover -s infra/tests/static -p "test_t15_*.py"` 62/63; yamllint on role clean.
