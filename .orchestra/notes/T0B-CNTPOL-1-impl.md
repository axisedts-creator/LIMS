# T0B-CNTPOL-1 impl (writer) - STOPPED on dispute, see T0B-CNTPOL-1-dispute.md
- Files: db/migrations/20261116030000_engagement__narrow_number_counters_access.sql (new: leading `SET LOCAL ROLE lims_owner`, 3 RESTRICTIVE number_counters__{select,insert,update}__nonstaff_keys TO lims_app verbatim from the CR Proposal, plain BEFORE UPDATE guard engagement.guard_counter_decrease() + trigger number_counters__patient_no_decrease); db/policies/engagement.sql (same text after number_counters__delete__tenant).
- [CONV] guard follows engagement.guard_actor_columns (LANGUAGE plpgsql, SET search_path = '', not DEFINER, P0001 immutable_row); LD-257 cited in comments; no DROP/REVOKE/GRANT/ALTER.
- Key regex: real builders checked by the static test; no correction needed.
- Ran (after ruling 1): T0B-CNTPOL-1.static 17/17 pass; tests/db/*.test.mjs 1510/1548; 37 failures pre-existing (baseline), 1 new = T0B-10.C2 parser (dispute 2).
- OPEN: tester's counter_key rename gap (patient renames own key, then reinserts) left for the lead. Test 462 not edited.
- NOT run in the lane: migration + pgTAP (no Postgres); founder runs db/tests/run-suites.sh before push-cloud.ps1.
