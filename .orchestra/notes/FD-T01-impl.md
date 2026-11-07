# FD-T01 impl
- Files: modules/frontdesk/{index,permissions,config}.ts, handlers/index.ts; worker jobs/frontdesk/index.ts; web features/frontdesk/nav.manifest.ts.
- handlers: one shared stub per operationId (29) throwing `LimsError('common.service_unavailable')`; never reads the request.
- [CONV] permissions.ts exports `FRONTDESK_PERMISSIONS` (10 codes TRD §7); config.ts exports `loadFrontdeskConfig(env)` (TRD §11.1 defaults, positive-int validation).
- [CONV] `ports.FrontdeskPort` omitted until FD-T11; worker manifest empty (tasks/subscriptions land with their tasks); nav `entries: []` = hidden.
- `LIMS_FRONTDESK_PAYMENT_RESULT_URL` boot-fail rule not enforced yet (needs C15 port registration; B12 task).
- C0 ajv `x-coded-set` CR resolved (FD-T01.resolved-202611072006). Re-run 2026-11-07 20:17 (no change since review 7fb6ef9): 26/30 vitest, 9/9 node:test. 4 boot tests fail: modules/reporting/index.ts:8 throws at import (`LIMS_CORE_ENV must be one of ...`), then `module reporting: index.ts exports no manifest` — BLOCKED on C6, see .orchestra/cr/FD-T01.md. No C4 code change needed; re-run verify.cmd when C6 lands (expect 30/30 + 9/9).
