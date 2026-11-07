# FD-T01 impl
- Files: modules/frontdesk/{index,permissions,config}.ts, handlers/index.ts; worker jobs/frontdesk/index.ts; web features/frontdesk/nav.manifest.ts.
- handlers: one shared stub per operationId (29) throwing `LimsError('common.service_unavailable')`; never reads the request.
- [CONV] permissions.ts exports `FRONTDESK_PERMISSIONS` (10 codes TRD §7); config.ts exports `loadFrontdeskConfig(env)` (TRD §11.1 defaults, positive-int validation).
- [CONV] `ports.FrontdeskPort` omitted until FD-T11; worker manifest empty (tasks/subscriptions land with their tasks); nav `entries: []` = hidden.
- `LIMS_FRONTDESK_PAYMENT_RESULT_URL` boot-fail rule not enforced yet (needs C15 port registration; B12 task).
- Results: 27/30 vitest pass, 9/9 node:test pass. 3 boot tests fail on missing JWT config in the test env — see FD-T01-dispute.md.
