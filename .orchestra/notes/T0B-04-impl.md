# T0B-04 impl (writer)
- New `db/seeds/003_audit__g_cs_access_actions.sql`: 91 codes = 05-SCHEMA §3.7 base list ∪ 03-IC §13.1 YAML. Uses `SET LOCAL ROLE lims_owner` and `ON CONFLICT (code) DO NOTHING`; `sort_order` goes up by 10 in source order.
- New `db/policies/audit.sql`: copy of the 7 audit.* CREATE POLICY statements from `20261105000600_audit__create_audit_tables.sql`, including the CR-C2-010 centre clause. Migration not changed: its request-id/support-session indexes and grants already meet the tests.
- [CONV] display = the quoted text in the §13.1 trailing comment, otherwise the code with `.`/`_` turned into spaces and the first letter capitalised (e.g. "Report view").
- [CONV] The seed header names `tools/codegen/gen-access-actions.ts`, but that generator is T0C-05 (0C) and does not exist yet. A throwaway script outside the repo produced this seed, using the same parsing as the equality test. When T0C-05 ships, it must produce byte-identical output or replace this file.
- Ran: `node --test` on tests/db/T0B-01..04: 53/53 pass.
- NOT run: pgTAP `db/tests/audit/T0B-04_audit.test.sql` (no psql/pg_prove on PATH).
- Open: T0B-03 CR (`audit_log__actor__ck`) still unresolved; unrelated.
