# C6-T10 impl (writer)
Files: api `repository/outsourced.repo.ts` (all SQL, shared with worker), `service/outsourced.service.ts` (O1-O6), `handlers/outsourced.handlers.ts` (+ wired in `index.ts`); worker `tasks/process_input_file.ts` + manifest task `reporting.process_input_file` (maxAttempts 5).
Verify: `.orchestra\notes\C6-T10-verify.cmd` -> api 155/155, worker 40/40; full reporting api 554/554. api tsc only error is pre-existing `packages/shared-ts/src/bsdate` TS5097; worker has no tsconfig.
[CONV] scanner hit + sandbox refusals count on `lims_reporting_sandbox_rejections_total{reason}` (reason 'infected' for EICAR, 'invalid_output' for an untrusted ok-reply); sanitise timeout default 60 s; sandbox TimeoutError/AbortError -> rejected, other sandbox errors -> throw (retry).
[CONV] worker manifest uses an unwired sandbox that always throws until C6-T12 provides the /internal/sanitize client (files stay `sanitizing`, never ready).
[CONV] job keys `pif:<file_id>` (process) and `assemble:<report_id>` (02-TRD §9); withdraw allowed from ready|confirmed only, else input_file_not_ready; O2 bounded to 200 rows.
[CONV] O6 `test_names` returned [] (needs catalogue port); item state mapping: latest non-withdrawn file confirmed->confirmed, ready->awaiting_confirmation, else awaiting_file. O6 SQL untested (join; needs live DB).
Open: O4 `common.immutable_record` (released-version lookup) not implemented; confirm/withdraw do not bump reports.version (only needs_assembly flag).
