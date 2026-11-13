# HC-T12 impl (A3 pushSyncMutations)
- Files: `sync.service.ts` (pipeline, JCS+sha256, effects, events, batch row), `conflict.service.ts` (pure guards 03-APP-FLOW §4), `events/publish.ts`, `handlers/pushSyncMutations.ts` + `index.ts` wiring; repo adds: `visits.repo lockVisitsForUpdate`, `collections.repo listAppliedCollectionsBySpecimenIds`, `handovers.repo listHandoverItemsByCollectionIds + getActiveCentreId`.
- [CONV] device row compare-and-bumped first (last_push_at, max seq) = push serialiser per device; visits locked FOR UPDATE ascending (+ visits of already-collected specimens named by handovers).
- [CONV] identity/consent/arrived/not_collected on a cancelled visit stay `applied` (US-08-4); completed/failed on cancelled = visit_closed; completed from `assigned` = V8 then V9.
- [CONV] held collection with unknown specimen / no order keeps the mutation + flag but no collections row (FK); handover centre fallback = ctx.centreId, else unresolved not_found.
- [CONV] event `collected_at_device` / `captured_at_device` = corrected time (AB15); stored row keeps the raw device time.
- Tests: after both rulings, HC-T12.pg.sh (real PG17) 5 files 114/114 green (HC-T12-run.log); `tsc --noEmit` clean for homecollection. No impl change needed.
- Open: A3 centre-denied mutation stored as `rejected` code `auth.forbidden`; lock order vs dispatcher route lock left to the deadlock detector (ponytail comment).
