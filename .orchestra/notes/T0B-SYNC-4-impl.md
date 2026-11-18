# T0B-SYNC-4 impl (writer)
- New: modules/lab/sync/resultEnter.adapter.ts, resultVerify.adapter.ts, modules/reporting/sync/printMarker.adapter.ts, modules/billing/sync/cashClose.adapter.ts, core/sync/offlineSignoffs.ts (stores + marker rule), db/migrations/20261118100000_core__add_sync_offline_signoffs.sql (+ db/policies/core.sql).
- Edited: core/sync/engine.ts (execute may return outcome rejected + errorCode, writes kept), core/sync/index.ts (8 default adapters), reporting print.service.ts / print.repo.ts / print.handlers.ts (issued_offline; handler wires the production marker store).
- [CONV] offline approval default off and close step up default off (no tenant setting exists); policy failure set = POLICY_CODES + common.version_conflict; marked letterhead print renders a file; audit of offline approval uses lab_result.view (CR).
- CR: .orchestra/cr/T0B-SYNC-4.nonblocking.md (new tables, access action, settings, worklist_item pull, render worker watermark).
- Verify: tsc clean; T0B-SYNC-4.pg.sh 198/201, the 3 failures are test defects -> .orchestra/notes/T0B-SYNC-4-dispute.md. Three-runs + boot test NOT done (stopped on dispute).
