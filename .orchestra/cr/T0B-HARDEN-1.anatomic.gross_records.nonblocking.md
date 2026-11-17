Title: CR-C0-T0B-HARDEN-1-006: anatomic.gross_records skipped from the enforce_mutable_columns migration (no always-on mutable-column list in the spec)
From chunk: C0 (lane C0-0B, T0B-HARDEN-1)            To owner: C0-0B (lead triage), then the chunk that owns anatomic
Type: spec gap
Blocking? no (LD-231: a table whose list the spec does not define is SKIPPED with a non-blocking CR; the list was not guessed or widened)
Problem: anatomic.gross_records is one of the 44 class C/B tables of LD-231 (lims_app holds UPDATE, no BEFORE UPDATE FOR EACH ROW app.enforce_mutable_columns trigger). Why it was skipped: spec/chunks/C11-specialty-pathology/05-SCHEMA.md defines app.enforce_mutable_columns lists only for anatomic.blocks (:616-617), anatomic.slides (:683-684) and anatomic.images (:744-746); the other C11 docs and 08-CR-REGISTER give no list for this table. The only rule is 08-CR-REGISTER D-66 (b) (spec/program/08-CR-REGISTER.md:2550), a service rule conditional on the case state.
Proposed change (exact): the owner chunk adds an always-on mutable-column list for anatomic.gross_records to its 05-SCHEMA (CREATE TRIGGER gross_records__mutable_columns ... app.enforce_mutable_columns(<cols>, 'updated_at','updated_by','version')) covering every column its services update, or the lead rules that the existing guard trigger counts as coverage and records anatomic.gross_records as an accepted exception of db/tests/immutability/T0B-08_immutability.test.sql test 1 (AC-0B-4.1).
Backward compatible? yes (no schema change made here)
Tenant/security impact: until resolved, only the API's own checks limit which columns of anatomic.gross_records an UPDATE may change (LD-231 FACT).
IRD/regulatory impact: none
Alternatives considered: deriving a list from the current code (forbidden: LD-231 "NEVER guess a list", "do not widen the list to make the test pass").
Tests that will prove it: tests/db/T0B-HARDEN-1.mutable-columns.test.mjs (static) and the founder's rerun of db/tests/immutability/T0B-08_immutability.test.sql test 1.
