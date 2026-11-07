# T0B-12 impl (writer)
- Added `db/migrations/20261105002200_storage__create_buckets.sql`: 11 buckets of 08 §4.8 verbatim (reporting-legacy reserved, not created), public = false, `ON CONFLICT (id) DO UPDATE SET public = false`.
- [CONV] File named `_storage__create_buckets.sql`, not the plan-row `_create_policies.sql`: SP-4 = api-proxied, so it holds buckets only (SP-4.md "skips *_storage__create_policies.sql").
- [CONV] No policy/grant on storage.* or realtime.*; isolation = private buckets + ctx.storage adapter (C0-0D T0D-17).
- Ran `node --test tests/db/T0B-12.storage-buckets.test.mjs`: 61/61 pass. Full tests/db: 703/705; 2 failures pre-existing, not storage (T0B-03 core.tenants `__platform` policies; T0B-04 003 seed header).
- Open: live pgTAP not run (LD-51 no docker). lims_owner has no privilege on storage.buckets in 05-SCHEMA §1 -> live INSERT likely fails; CR `.orchestra/cr/T0B-12.md`.
