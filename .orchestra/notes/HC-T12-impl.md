# HC-T12 impl (A3 pushSyncMutations)
- Files: `sync.service.ts` (pipeline, JCS+sha256, effects, events, batch row), `conflict.service.ts` (pure guards 03-APP-FLOW §4), `events/publish.ts`, `handlers/pushSyncMutations.ts` + `index.ts` wiring; repo adds: `visits.repo lockVisitsForUpdate`, `collections.repo listAppliedCollectionsBySpecimenIds`, `handovers.repo listHandoverItemsByCollectionIds + getActiveCentreId`.
- [CONV] device row compare-and-bumped first (last_push_at, max seq) = push serialiser per device; visits locked FOR UPDATE ascending (+ visits of already-collected specimens named by handovers).
- [CONV] identity/consent/arrived/not_collected on a cancelled visit stay `applied` (US-08-4); completed/failed on cancelled = visit_closed; completed from `assigned` = V8 then V9.
- [CONV] held collection with unknown specimen / no order keeps the mutation + flag but no collections row (FK); handover centre fallback = ctx.centreId, else unresolved not_found.
- [CONV] event `collected_at_device` / `captured_at_device` = corrected time (AB15); stored row keeps the raw device time.
- Tests: static + publish 20/20 green; DB suite 82/114 (2 runs) — all 32 failures are test defects, see HC-T12-dispute.md (barcode collision across files, bigint string, AB5 seed). Not verified: held-collection paths (1)-(7) and split/handover-after-collect cases that died on the collision; re-run after the tester fix.
- Open: A3 centre-denied mutation stored as `rejected` code `auth.forbidden`; lock order vs dispatcher route lock left to the deadlock detector (ponytail comment).
