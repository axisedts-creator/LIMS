# T0B-12 tests (tester, rewritten for LD-54: provisioning script, no SQL on schema storage)
- `tests/db/T0B-12.storage-buckets.test.mjs` (node, no DB, no network): detector self-tests; 08 §4.8 parse (11 buckets); SP-4 api-proxied; no SQL in db/{migrations,policies,seeds,bootstrap} references schema storage and `*_storage__*.sql` is gone or comment-only; check-migrations exit 0.
- Same file, static on `db/provisioning/create-storage-buckets.mjs`: parses, 11 names verbatim, public:false never true, credential only via LIMS_CORE_STORAGE_KEY_FILE, no URL/key/pg client; `db/provisioning/README.md` has the first-deploy smoke test.
- `db/tests/storage/T0B-12_storage.test.sql` (pgTAP): header edited, now a post-provisioning smoke probe; NOT run (LD-54).
- NOT WRITTEN: stub-HTTP-server behaviour tests. Service-URL env name + bucket endpoints are not recorded in SP-4/TRD -> `.orchestra/cr/T0B-12.provisioning-contract.md`; describe "GATE" (2 tests) fails until recorded. Lead must rule, then tester adds them.
- Run: `.orchestra\notes\T0B-12-verify.cmd`. Fails now: migration still present, script/README missing, GATE.
