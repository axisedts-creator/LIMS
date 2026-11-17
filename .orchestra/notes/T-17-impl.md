# T-17 impl (writer)
- New: `service/pricing.service.ts` (#71–#81), `handlers/pricing.handlers.ts`. Changed: `handlers/index.ts`, `service/referrers.service.ts` (mergeDoctor moves/drops the assignment), `repo/masters.repo.ts` (MasterTable += price_lists/versions/items), `__tests__/probes/pending.json` (11 ops removed).
- Result (after ruling, tests revised): T-17 verify set + referrers.service 399/399 pass; catalog suite 2731/2731. No impl change needed.
- [CONV] bulk-upsert: any invalid row/dup orderable -> whole request 400; unknown/foreign orderable -> per-row `common.not_found`. Remove outcomes: removed=`updated`, absent=`unchanged`.
- [CONV] item edits keep `version` of the draft (publish If-Match unaffected) and bump nothing; item_count recounted. Assignments PUT always bumps list version + revision (handler test needs it, even for an unchanged set).
- [CONV] merge reassignment = DELETE + INSERT (no UPDATE contract on associations); lock order list -> version -> items -> catalog_state.
- Open: publishing an empty version is allowed; assigning a merged/inactive doctor is not blocked; draft copy inserts item-by-item (ponytail, ~100k ceiling). `tsc` shows 2 pre-existing errors outside catalog; no eslint in services/api.
