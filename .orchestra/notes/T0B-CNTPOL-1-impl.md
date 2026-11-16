# T0B-CNTPOL-1 impl (writer) - STOPPED on dispute, see T0B-CNTPOL-1-dispute.md
- Files: db/migrations/20261116030000_engagement__narrow_number_counters_access.sql (new: leading `SET LOCAL ROLE lims_owner`, 3 RESTRICTIVE number_counters__{select,insert,update}__nonstaff_keys TO lims_app verbatim from the CR Proposal, plain BEFORE UPDATE guard engagement.guard_counter_decrease() + trigger number_counters__patient_no_decrease); db/policies/engagement.sql (same text after number_counters__delete__tenant).
- [CONV] guard follows engagement.guard_actor_columns (LANGUAGE plpgsql, SET search_path = '', not DEFINER, P0001 immutable_row); LD-257 cited in comments; no DROP/REVOKE/GRANT/ALTER.
- Key regex: real builders checked by the static test; no correction needed.
- Ran: T0B-CNTPOL-1.static 17/17 pass; tests/db/*.test.mjs 1502/1548, 8 new failures from T0B-05/T0B-06 policy parsers (dispute), 1 dirty-tree REVIEW-1 check.
- OPEN: tester's counter_key rename gap (patient renames own key, then reinserts) left for the lead. Test 462 not edited.
- NOT run in the lane: migration + pgTAP (no Postgres); founder runs db/tests/run-suites.sh before push-cloud.ps1.
