APPROVE
HC-T16 review of ac7971ea..HEAD (2026-11-14).
- Only code change: anonymise_definer.live.test.ts:46 adds `AND tablename IN ('visits', 'handover_items')` exactly per LD-168 / ruling; expected four rows and assertions (:45, :47-49) unchanged. Contract not weakened (FORCE RLS on both tables and all four TO lims_owner policies still asserted).
- No implementation change in range (LD-168: none required). Owned paths only (services/worker/src/jobs/homecollection/__tests__ + own notes). No PHI, no secrets, no invented names.
- Ran `bash tests/homecollection/HC-T16.pg.sh`: 6 files, 61/61 tests pass (11:38 NPT).
