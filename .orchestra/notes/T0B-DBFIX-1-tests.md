# T0B-DBFIX-1 tests (tester)
- File: tests/db/T0B-DBFIX-1.fixtures.test.mjs (static node:test; run `node --test tests/db/T0B-DBFIX-1.fixtures.test.mjs` or .orchestra/notes/T0B-DBFIX-1-verify.cmd). The lane cannot run SQL (no Docker).
- Covers LD-230 (1) role_code vs CHECK read from the migration, (2) pg_temp.ins sets tenant+sub claims in C12/C13, (6) legal_name_snapshot in T0B-06, (7) generator --check + the 7 partners probes use receiving_centre_id, (8) run-suites.sh storage stub before the suite loop, (9) roles memberships + T0B-02 default-ACL assertion, plus per-file assertion counts (23 files, baseline = unrepaired tree; skip/todo may not grow).
- Fails now for the right reasons: stale role_code, ins() sets no claims, missing legal_name_snapshot, stale probes, no stub, stale expectations.
- `--check` is stale beyond partners today (_registry.sql, identity.tenant_contract_acceptances, ...): regenerate ALL probes with the fixed generator, not only the 7.
- NOT statically provable, left to the founder rerun: (3) pgTAP like/unlike/is resolution, (4) audit_context_missing, (5) syntax near uuid / := (C16_schema:102, C18_behaviour:61), (6) lock_reason, hmac_len, T0B-03_audit:149 subquery.
- Stub scope: tests require storage.buckets(id, name, public); T0B-12_storage.test.sql also reads storage.objects (lines 37, 49): implementer/lead decide whether the stub needs it.
- Founder reruns (Git Bash): LIMS_SKIP_GEN=1 bash db/tests/run-suites.sh <suites touched by faults 1-9, the 7 partners probes, roles/00_bootstrap_roles, app/T0B-02_helpers, storage/T0B-12_storage>.
