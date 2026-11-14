# FD-T01 impl
- Files: modules/frontdesk/{index,permissions,config}.ts, handlers/index.ts; worker jobs/frontdesk/index.ts; web features/frontdesk/nav.manifest.ts.
- handlers: one shared stub per operationId (29) throwing `LimsError('common.service_unavailable')`; never reads the request.
- [CONV] permissions.ts exports `FRONTDESK_PERMISSIONS` (10 codes TRD §7); config.ts exports `loadFrontdeskConfig(env)` (TRD §11.1 defaults, positive-int validation).
- [CONV] `ports.FrontdeskPort` omitted until FD-T11; worker manifest empty (tasks/subscriptions land with their tasks); nav `entries: []` = hidden.
- `LIMS_FRONTDESK_PAYMENT_RESULT_URL` boot-fail rule not enforced yet (needs C15 port registration; B12 task).
- C0 ajv + C6 reporting CRs resolved. Review ed40818 items were tests-only (timeouts, applied by tester 76a0133); no impl change. Re-run 2026-11-07 22:00: vitest 30/30, node:test 9/9.
