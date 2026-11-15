Title: CR-C0-T0B-HARDEN-1-038: quality.qc_runs skipped from the enforce_mutable_columns migration (no always-on mutable-column list in the spec)
From chunk: C0 (lane C0-0B, T0B-HARDEN-1)            To owner: C0-0B (lead triage), then the chunk that owns quality
Type: spec gap
Blocking? no (LD-231: a table whose list the spec does not define is SKIPPED with a non-blocking CR; the list was not guessed or widened)
Problem: quality.qc_runs is one of the 44 class C/B tables of LD-231 (lims_app holds UPDATE, no BEFORE UPDATE FOR EACH ROW app.enforce_mutable_columns trigger). Why it was skipped: spec/chunks/C9-quality-engine/05-SCHEMA.md:116 gives only a state rule ("frozen once outcome is set; status never changes once closed", quality.enforce_run_frozen() :436-454), which names frozen columns, not mutable ones. In addition the UPDATE at services/api/src/modules/quality/repository/run.repo.ts:100 builds its SET list at run time and is not resolved by the static test.
Proposed change (exact): the owner chunk adds an always-on mutable-column list for quality.qc_runs to its 05-SCHEMA (CREATE TRIGGER qc_runs__mutable_columns ... app.enforce_mutable_columns(<cols>, 'updated_at','updated_by','version')) covering every column its services update, or the lead rules that the existing guard trigger counts as coverage and records quality.qc_runs as an accepted exception of db/tests/immutability/T0B-08_immutability.test.sql test 1 (AC-0B-4.1).
Backward compatible? yes (no schema change made here)
Tenant/security impact: until resolved, only the API's own checks limit which columns of quality.qc_runs an UPDATE may change (LD-231 FACT).
IRD/regulatory impact: none
Alternatives considered: deriving a list from the current code (forbidden: LD-231 "NEVER guess a list", "do not widen the list to make the test pass").
Tests that will prove it: tests/db/T0B-HARDEN-1.mutable-columns.test.mjs (static) and the founder's rerun of db/tests/immutability/T0B-08_immutability.test.sql test 1.
