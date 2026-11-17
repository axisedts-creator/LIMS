CHANGES

1. db/tests/fixtures/probe-rows/catalog.sql:45 (after the catalog.files INSERT) — the generated probe rows for the new table catalog.import_batch are NOT committed. HEAD lacks them; they exist only as an uncommitted working-tree change. `node db/tools/gen-isolation-probes.ts --check` reports "ok (461 probe files, 19 fixture files current)" only WITH that uncommitted edit, so the committed tree is stale against the generator. That breaks tests/db/T0B-DBSEED-1.fixtures.test.mjs, and db/tests/isolation/catalog.import_batch.test.sql has no tenant rows to probe. Fix: re-run `node db/tools/gen-isolation-probes.ts` (do not hand-edit) and commit db/tests/fixtures/probe-rows/catalog.sql with the two generated rows:
   INSERT INTO catalog.import_batch (id, tenant_id, created_by, file_name, file_sha256, template_version, status, payload) VALUES (pg_temp.id('f1'), pg_temp.id('01'), ...'validated', '{}'), (pg_temp.id('f3'), pg_temp.id('02'), ...'validated', '{}') ON CONFLICT DO NOTHING;
   Then re-run `--check` and the DBSEED fixtures test on the committed tree.

Checked with no defect found:
- Names: the six operationIds, catalog.test.manage, and the six error codes match the brief (LD-318) verbatim. The error codes are in contracts/errors.yaml and the generated TS and Dart files. The LD-333 extras (test_category in the catalog.changed.v1 entity_type enum, is_active on listCommentCodes) are present. No existing operationId was removed.
- RLS: ENABLE and FORCE are on. select/insert/update policies are tenant-scoped with is_staff_or_system. There is no DELETE grant or policy. db/policies/catalog.sql mirrors the migration. The registry and tables.yaml rows were added.
- Append-only guard trigger: a committed batch cannot change, the transitions are validated→committed|expired and rejected→expired, and the 24-hour expiry is enforced by the database. db/tests/catalog/T0C-TESTIMPORT-1_import_batches.test.sql covers these cases.
- Contract: commit requires If-Match, Idempotency-Key and a confirm flag that must be exactly true. Validate is idempotent. All operations are rate tier general. The limits (xlsx only, 5 MB, 5000 rows per sheet) are written in the contract text. Imports are drafts only and never publish (LD-318).
- pendingOperations: the six new ids were added (LD-325(b), LD-335). The testmgmt1 pin follows the arbiter ruling.
- The audit trigger excludes payload and errors. No PHI, no secrets. Only owned paths were changed.
