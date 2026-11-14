TESTS_WRONG — anonymise_definer.live.test.ts:46 pg_policies query must add `AND tablename IN ('visits', 'handover_items')` after `AND policyname LIKE '%__owner_only'`; expected four rows and all assertions (:45, :47-49) unchanged.
Reasons:
- LD-168 (binding lead decision, 2026-11-14) rules exactly this: TESTS_WRONG, narrow query by table, no implementation change.
- spec/program/03-INTERFACE-CATALOG.md:3454 requires only `visits__select/update__owner_only` and `handover_items__select/update__owner_only` for app.homecollection_anonymise_retired_visits; test checks these four.
- spec/chunks/C0-foundation-contracts/05-SCHEMA.md:373, :1224-1226 define `event_inbox__select__owner_only` / `event_inbox__delete__owner_only` on every schema's event_inbox (C0-owned), so they legitimately exist in schema homecollection and are out of HC-T16 scope.
- spec/program/02-CONVENTIONS.md:708 (DEFINER owner policies under FORCE RLS) is still fully asserted after narrowing; contract not weakened.
- Writer dispute (.orchestra/notes/HC-T16-dispute.md:3-5): only failure is this query; FORCE-RLS assertion at :45 passes.
