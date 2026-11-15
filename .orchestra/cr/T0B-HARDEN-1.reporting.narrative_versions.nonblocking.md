Title: CR-C0-T0B-HARDEN-1-039: reporting.narrative_versions skipped from the enforce_mutable_columns migration (no always-on mutable-column list in the spec)
From chunk: C0 (lane C0-0B, T0B-HARDEN-1)            To owner: C0-0B (lead triage), then the chunk that owns reporting
Type: spec gap
Blocking? no (LD-231: a table whose list the spec does not define is SKIPPED with a non-blocking CR; the list was not guessed or widened)
Problem: reporting.narrative_versions is one of the 44 class C/B tables of LD-231 (lims_app holds UPDATE, no BEFORE UPDATE FOR EACH ROW app.enforce_mutable_columns trigger). Why it was skipped: spec/chunks/C6-reporting-delivery/05-SCHEMA.md:207 (reporting.tg_narrative_versions_guard) is state-conditional: "while draft: everything except id/tenant/narrative/version_no; once signed: only status (signed -> superseded), updated_*, version". The draft list differs from the signed list, so no single always-on list exists.
Proposed change (exact): the owner chunk adds an always-on mutable-column list for reporting.narrative_versions to its 05-SCHEMA (CREATE TRIGGER narrative_versions__mutable_columns ... app.enforce_mutable_columns(<cols>, 'updated_at','updated_by','version')) covering every column its services update, or the lead rules that the existing guard trigger counts as coverage and records reporting.narrative_versions as an accepted exception of db/tests/immutability/T0B-08_immutability.test.sql test 1 (AC-0B-4.1).
Backward compatible? yes (no schema change made here)
Tenant/security impact: until resolved, only the API's own checks limit which columns of reporting.narrative_versions an UPDATE may change (LD-231 FACT).
IRD/regulatory impact: none
Alternatives considered: deriving a list from the current code (forbidden: LD-231 "NEVER guess a list", "do not widen the list to make the test pass").
Tests that will prove it: tests/db/T0B-HARDEN-1.mutable-columns.test.mjs (static) and the founder's rerun of db/tests/immutability/T0B-08_immutability.test.sql test 1.
