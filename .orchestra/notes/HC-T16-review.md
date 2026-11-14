CHANGES
HC-T16 review (lead ruling, LD-168). TESTS-ONLY change. No implementation change.
Tester:
1. services/worker/src/jobs/homecollection/__tests__/anonymise_definer.live.test.ts, the pg_policies query at about line 46: add `AND tablename IN ('visits', 'handover_items')` after `AND policyname LIKE '%__owner_only'`. Keep the expected four rows and every assertion exactly as they are. Reason: the query as written also returns event_inbox__select__owner_only and event_inbox__delete__owner_only, which belong to the event_inbox table (the core event-inbox migration 20261105001000_core__create_event_inboxes.sql creates owner_only policies on each schema's event_inbox), not to the anonymise function. The four visits/handover_items policies are present and correct, so this narrows the query and does not weaken the contract.
2. Change nothing else. Rerun `bash tests/homecollection/HC-T16.pg.sh`. If a different assertion fails, that is a new real failure: record it in the debug note and do not re-dispute this item.
Writer: nothing to change.
