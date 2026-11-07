# T0B-08 impl (writer)
- Files: new `db/tools/gen-isolation-probes.ts` (CLI per test header; reuses `sql-lib.ts` rootDir/readYaml); generated + committed `db/tests/isolation/_registry.sql` and 12 `<schema>.<table>.test.sql` probes (real registry). No test file edited.
- [CONV] Probes are catalog-driven at run time (tenant column `tenant_id`/`id`, UPDATE column `updated_at`/tenant col, owner column `actor_id`/`created_by`, grants via has_*_privilege, composite FKs via pg_constraint) so the generator needs no column knowledge beyond tables.yaml.
- [CONV] Step 4 expects `n=0` where the role holds the privilege, else `E42501`; DELETE probe emitted only for class M. Step 6 copies a tenant-A row and repoints FK cols at a tenant-B parent; explicit `skip()` when no such rows are seeded.
- [CONV] Step 1 seeds core fixtures (tenants A/B, centres A1/A2, staff/partner/patient memberships) inline, same ids as T0B-03 tests; module rows rely on db/seeds. `probe_fixture:` (02-TRD §4.5 step 1) not yet supported.
- `--check` also flags orphan generated files and a stale `_registry.sql`; write mode deletes orphans. Hand-written `T0B-08_*.test.sql` in the dir are ignored.
- Ran: `node --test tests/db/T0B-08.suites.test.mjs` 41/41 pass; all `tests/db/*.test.mjs` 170/170 pass.
- Open: live pgTAP (`bash db/tests/run-suites.sh`, image present locally) NOT run — command needed approval. Expect first-run shakeout of the generated probes and tester pgTAP suites.
