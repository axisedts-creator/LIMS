# HC-T09 impl (H3-H8, H11)
Files: `visit.service.ts` (H3-H8), `route.service.ts` (bumpVersion, placeOnRoute caps/lock, H11), 7 `handlers/*.ts`, `index.ts`; `service/visitRead.service.ts` (split `buildVisitDetail`, export `staffNames`/`userNames`).
Tests: 205/205 pass (2026-11-13 15:29, after ruling: helpers.ts duplicate `seedWorld` export removed by tester; no impl change). tsc: no errors in module files.
[CONV] bumpVersion(tx, tenantId, routeId); route lock = bump FIRST (loser re-counts); state check before body check; H7 no If-Match; H8 If-Match = flag version; cancel of assigned+order raises order_cancel_required (V11).
[CONV] assign enqueues specimen refresh in same tx (V5 / 02-TRD §8) via `enqueueRefreshVisitSpecimens`.
[CONV] reasons = constant of the 05-SCHEMA §2 seed (system `missed`/`booking_cancelled` excluded): test DB has no g_cs_reasons seed (P-1). Switch to reasons.repo once seeded.
Open: daily cap 60 serialised per route only (ponytail comment); linter + full suite not run.
