Title: CR-C0-T0B-HARDEN-1-029: lab.results skipped from the enforce_mutable_columns migration (no always-on mutable-column list in the spec)
From chunk: C0 (lane C0-0B, T0B-HARDEN-1)            To owner: C0-0B (lead triage), then the chunk that owns lab
Type: spec gap
Blocking? no (LD-231: a table whose list the spec does not define is SKIPPED with a non-blocking CR; the list was not guessed or widened)
Problem: lab.results is one of the 44 class C/B tables of LD-231 (lims_app holds UPDATE, no BEFORE UPDATE FOR EACH ROW app.enforce_mutable_columns trigger). Why it was skipped: spec/chunks/C5-lab-workflow/05-SCHEMA.md:560-569 and :1283 give a state-conditional list ("after approval only these columns may change": current_version_no, qc_review_required, updated_at, updated_by, version), enforced by lab.enforce_result_lock() (:582); before approval the generic trigger is not used (:561). In addition 4 UPDATE sites build the SET list at run time and are not resolved by the static test: services/api/src/modules/lab/service/evaluation.service.ts:128, qc.service.ts:43, result-side.store.ts:99, services/api/src/modules/lab/store/results.store.ts:109.
Proposed change (exact): the owner chunk adds an always-on mutable-column list for lab.results to its 05-SCHEMA (CREATE TRIGGER results__mutable_columns ... app.enforce_mutable_columns(<cols>, 'updated_at','updated_by','version')) covering every column its services update, or the lead rules that the existing guard trigger counts as coverage and records lab.results as an accepted exception of db/tests/immutability/T0B-08_immutability.test.sql test 1 (AC-0B-4.1).
Backward compatible? yes (no schema change made here)
Tenant/security impact: until resolved, only the API's own checks limit which columns of lab.results an UPDATE may change (LD-231 FACT).
IRD/regulatory impact: none
Alternatives considered: deriving a list from the current code (forbidden: LD-231 "NEVER guess a list", "do not widen the list to make the test pass").
Tests that will prove it: tests/db/T0B-HARDEN-1.mutable-columns.test.mjs (static) and the founder's rerun of db/tests/immutability/T0B-08_immutability.test.sql test 1.
