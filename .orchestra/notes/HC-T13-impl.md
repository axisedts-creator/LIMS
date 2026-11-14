# HC-T13 impl (H9 reviewHeldCollection)
- Files: `services/api/src/modules/homecollection/collection.service.ts` (new), `handlers/reviewHeldCollection.ts` (new, thin), `index.ts` (H9 wired).
- Flow: assertRole(no centre) -> id -> If-Match 428 -> body 400 -> load 404 -> lock visit (lockVisitsForUpdate) + assertRole(centre) -> re-read collection -> not held 409 -> version 409 -> apply guards -> write.
- Apply: guards barcode_mismatch hold (422), order cancelled / specimen not `ordered` or missing / other applied collection (409 mutation_superseded); then ONE `collectionSynced` (this collection, corrected time, booking_id iff booking), then updateCollection with applied_event_id.
- Discard: no ports, no event; flag `held_collection` resolved with resolution_code = reason_code, note = reason_text.
- [CONV] apply also resolves the open `held_collection` flag (spec silent; stale open flag after apply is wrong). reviewed_by = actor user id. review_reasons mirrored as const (ponytail, like visit.service REASONS).
- Concurrency: the visit row lock serialises two reviews (and a push on the same visit); loser re-reads -> collection_not_held. Lost optimistic update -> version_conflict (tx rolls back, event too).
- RUN: static.test.ts 11/11 pass; tsc clean for my files. review.test.ts NOT RUN: HC-T13.pg.sh bootstrap fails in migration 20261113230000_instruments__add_truth_h80e_driver.sql "permission denied for schema instruments" (not C17b-owned).
