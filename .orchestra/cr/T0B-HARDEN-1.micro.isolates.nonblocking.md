Title: CR-C0-T0B-HARDEN-1-033: micro.isolates skipped from the enforce_mutable_columns migration (no always-on mutable-column list in the spec)
From chunk: C0 (lane C0-0B, T0B-HARDEN-1)            To owner: C0-0B (lead triage), then the chunk that owns micro
Type: spec gap
Blocking? no (LD-231: a table whose list the spec does not define is SKIPPED with a non-blocking CR; the list was not guessed or widened)
Problem: micro.isolates is one of the 44 class C/B tables of LD-231 (lims_app holds UPDATE, no BEFORE UPDATE FOR EACH ROW app.enforce_mutable_columns trigger). Why it was skipped: spec/chunks/C10-microbiology/05-SCHEMA.md:123 (§5) gives only micro.tg_child_final_lock (P0001 immutable_row once the parent culture is final_submitted); review spec/review/C10-microbiology.md #7 offered "attach app.enforce_mutable_columns with explicit lists" as an alternative but the spec took the final_lock option and gives no column list (DDL trigger isolates__final_lock :1024).
Proposed change (exact): the owner chunk adds an always-on mutable-column list for micro.isolates to its 05-SCHEMA (CREATE TRIGGER isolates__mutable_columns ... app.enforce_mutable_columns(<cols>, 'updated_at','updated_by','version')) covering every column its services update, or the lead rules that the existing guard trigger counts as coverage and records micro.isolates as an accepted exception of db/tests/immutability/T0B-08_immutability.test.sql test 1 (AC-0B-4.1).
Backward compatible? yes (no schema change made here)
Tenant/security impact: until resolved, only the API's own checks limit which columns of micro.isolates an UPDATE may change (LD-231 FACT).
IRD/regulatory impact: none
Alternatives considered: deriving a list from the current code (forbidden: LD-231 "NEVER guess a list", "do not widen the list to make the test pass").
Tests that will prove it: tests/db/T0B-HARDEN-1.mutable-columns.test.mjs (static) and the founder's rerun of db/tests/immutability/T0B-08_immutability.test.sql test 1.
