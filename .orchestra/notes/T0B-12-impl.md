# T0B-12 impl (rework per LD-54, CR-C0-T0B-12 option b)
- Deleted `db/migrations/20261105002200_storage__create_buckets.sql` (a comment-only placeholder would fail check-migrations' first-statement rule). No SQL references schema storage.
- Added `db/provisioning/create-storage-buckets.mjs`: 11 buckets of 08 §4.8 verbatim (reporting-legacy reserved), `plan(existing)` = create missing / flip public to private, always public:false; credential only from the file in `LIMS_CORE_STORAGE_KEY_FILE`.
- [CONV] The script sends no HTTP request and exits 2: the Storage base-URL env name and the bucket endpoints are not recorded (CR-C0-T0B-12-b, `.orchestra/cr/T0B-12.provisioning-contract.md`). LD-54 forbids guessing them.
- Added `db/provisioning/README.md`: status plus the first-deploy smoke test (script, re-run, then `db/tests/storage/T0B-12_storage.test.sql`). Not executed.
- Tests: `node --test tests/db/T0B-12.storage-buckets.test.mjs` gives 64/66 pass. The 2 failures are the GATE tests, which stay red until the lead rules on CR-C0-T0B-12-b.
- Open: the lead must rule on CR-C0-T0B-12-b, then the HTTP calls get wired and the tester writes the stub-server tests. The live pgTAP has not been run (LD-54).
