# T-15 impl (writer) — doctors #60–#66
- Files: service/referrers.service.ts (new), handlers/referrers.handlers.ts (new), handlers/index.ts (7 stubs -> spread), repo/masters.repo.ts (MasterTable += doctors), probes/pending.json (7 ids removed, 79 -> 72).
- Result: 267/267 pass after arbiter ruling (`['r_s', ['AB3']]`); impl unchanged. tsc: only TS5097 in packages/shared-ts/src/bsdate (outside C3, not touched).
- [CONV] auto code = upsert `code_counters` (`next_value` = next to hand out), DR + 5-digit pad; merged doctor: verify and reactivate -> 409 catalog.version_in_use; merge of an already-merged source -> 409 same code; unknown/foreign merge target -> 400 validation_failed.
- [CONV] unknown body keys are reported at path "" (never echo the key, AB-20); write ops return contacts (route needs manage), only getDoctor consults IdentityPort.getActor (fail closed).
- Open: auto code colliding with an existing explicit `DR00001` -> 409 code_duplicate and the counter never moves (review item 1); filed `.orchestra/cr/T-15.md` (skip taken codes, max 100 tries; also covers T-16 `CP`). Code stays as is until the ruling. Re-pointed doctors get version+1. created_at cursor is ms precision (ponytail note in code). Price-list reassignment at merge = T-17.

---
<!-- merged from lane/C1: C1-infrastructure-ops task T-15 (same task id, different chunk) -->
# C1 T-15 impl (writer) — review round
- Files: role auditstore templates/psql.j2 (PGHOST=127.0.0.1, item 1), tasks/main.yml (schema.sql `-1`, item 4); infra/auditstore/digest.sql (DO loop backfills missed nights D-6..D ascending, only days newer than the chain's latest link, item 3); DECISION.md (verdict UNVERIFIED, off-host digests NOT YET IMPLEMENTED, items 2/6); new `.orchestra/cr/T-15.md` (secret ids, off-host digest owner, auditstore-drift CI; item 7).
- [CONV] digest backfill uses a PL/pgSQL DO block (each INSERT sees the previous day's link); older holes behind an existing link are never filled (chain order kept).
- DISPUTE: `.orchestra/notes/T-15-dispute.md` — l.536 (no IPv4 literal) contradicts the new loopback test l.565. Static 62/63, only l.536 red.
- Live test (item 2) NOT run: needs Linux + PG17 (`LIMS_T15_LIVE=1`); this machine is Windows without PG server binaries. DECISION.md stays UNVERIFIED until it runs.
- Item 5 = tester (done in c325b1b). Open: CR T-15 (secrets schema ids, off-host digest shipping, CI job); pg_hba.conf.j2 `groups['dr'][0]` in lean (T-04).
- Tests: `python -B -m unittest discover -s infra/tests/static -p "test_t15_*.py"` 62/63; yamllint on role clean.
