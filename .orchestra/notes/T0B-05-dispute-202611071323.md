# T0B-05 dispute (writer, 2026-11-07, round after ruling d715bc6)
Run: `bash db/tests/run-suites.sh --no-seeds db/tests/core/T0B-05_platform.test.sql db/tests/core/T0B-05_queue.test.sql` ("Schema updated").
Platform file: ok 1-47, then `psql:db/tests/core/T0B-05_platform.test.sql:135: ERROR:  new row for relation "platform_staff" violates check constraint "platform_staff__role_code__ck"`. Run aborts; queue file (tests 6-23 per ruling) never reached.
Test: db/tests/core/T0B-05_platform.test.sql:133-135 fixture inserts identity.platform_staff with `role_code = 'platform_admin'`.
Why the test is wrong: `platform_admin` is not a spec role. Spec: spec/chunks/C2-identity-admin/05-SCHEMA.md:174 (`role_code`: `platform_superadmin`, `platform_support`), spec/chunks/C0-foundation-contracts/05-SCHEMA.md:242, 03-INTERFACE-CATALOG.md §11 platform_roles. The CHECK (db/migrations/20261105001300_identity__create_identity_schema.sql:59, merged from main) enforces exactly that set. Impl not at fault.
Fix: change both fixture rows (lines 134-135) to `'platform_superadmin'` (dl_* / platform.dead_letter.manage is superadmin-only, IC line 3003).
