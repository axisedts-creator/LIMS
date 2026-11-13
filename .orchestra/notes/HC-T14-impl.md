# HC-T14 impl
- Files: api `handover.service.ts` (H13-H15), `handlers/{listHandovers,getHandover,confirmHandover}.ts` + index.ts wiring, `repository/handovers.repo.ts` (+listHandoversPage, enqueueFlagHandoverDiscrepancy), `repository/visitFlags.repo.ts` (+insertOpenVisitFlagIfAbsent); worker `tasks/flag_handover_discrepancy.ts`.
- Result after ruling fixture fix (`tests/homecollection/HC-T14.pg.sh`, log HC-T14-impl-run.log): API 59/59 pass; worker 12/12 pass. No impl change needed. tsc --noEmit (api, worker): no errors in HC-T14 files.
- [CONV] H13 newest first (handed_over_at DESC, id DESC), keyset cursor base64url{v,k,i}; default status = all; pending DTOs omit received_count; names failing -> display '—' / key omitted.
- [CONV] Check order: load 404 -> assertRole(to_centre_id) 403 -> If-Match 428 -> body 400 -> non-pending / stale 409 -> items (dup/subset 400, foreign 404). H13: assertRole without centre, scope = RLS on to_centre_id.
- [CONV] Worker flag: ON CONFLICT on the partial unique index, created_by = ctx.actor.id, centre_id = visit centre, each touched route bumped once via route.service.bumpVersion.
- Open: no `core.g_task_registry` row shipped (test fixture only, as HC-T09); lint not run.
