APPROVE

Reviewed `git diff 6106f0e82..HEAD` (tester 6780ffa8e, writer cc5708ea7 = notes only).

- Scope: only db/tests/**, tests/db/T0B-GREEN-2.pgtap.test.mjs (tests/db is the established C0 wrapper location, T0B-01..13), .orchestra notes + 1 CR. No migration, policy, grant, seed or contract edit (LD-268 stop-list kept).
- STALE claims spot-checked against the repo: 3 RESTRICTIVE number_counters policies (20261116030000); agent_credentials column-level UPDATE grant omits kind / expires_at (20261105002000:745); lims_migration NOLOGIN with no lims_app membership (db/bootstrap/00_roles.sql:6,20, LD-226); is_staff_or_system admits 'device' (20261105000100); no insert/update __staff_centre on the 3 shape-C projections. All consistent.
- No weakening: each relaxed expectation is replaced by an exact count / exact set / pin (FK sources, RESTRICTIVE count = 3, lims_reporting_lookup confined to schema reporting, has_column_privilege pins, C18 setup pin that goes red when D-136 lands). In-transaction GRANTs (lims_app TO lims_migration; Supabase default storage grants) and FK drops are inside the rolled-back test transaction and not asserted on.
- Storage bucket-existence SKIP only on an empty stub; wrapper cross-checks provisioning script BUCKETS == probe list, and fails on any other SKIP or an assertion-count drop.
- No PHI (synthetic "Test Patient 000n" only), no secrets.
- Independent run (reviewer, 2026-11-18): `node --test tests/db/T0B-GREEN-2.pgtap.test.mjs` -> tests 3, pass 3, fail 0 (run-suites.sh over all 23 suites, 184 s).

Non-blocking observations (no change required here):
- policy_shape "shared_with has an actor policy" now accepts any identity `__own` / `__own_user` policy for every listed actor; fine today, but it no longer distinguishes actors on identity tables.
- CR-C0-T0B-GREEN-2-001 (D-136) and CR-C0-T0B-GREEN-1-004 (device actor) stay open for the lead; missing __mutable_columns triggers on collector_flags, partner_ticket and the 4 sales tables belong to the immutability suite's task.
