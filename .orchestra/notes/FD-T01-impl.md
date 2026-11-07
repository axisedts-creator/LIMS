# FD-T01 impl
- Files: modules/frontdesk/{index,permissions,config}.ts, handlers/index.ts; worker jobs/frontdesk/index.ts; web features/frontdesk/nav.manifest.ts.
- handlers: one shared stub per operationId (29) throwing `LimsError('common.service_unavailable')`; never reads the request.
- [CONV] permissions.ts exports `FRONTDESK_PERMISSIONS` (10 codes TRD §7); config.ts exports `loadFrontdeskConfig(env)` (TRD §11.1 defaults, positive-int validation).
- [CONV] `ports.FrontdeskPort` omitted until FD-T11; worker manifest empty (tasks/subscriptions land with their tasks); nav `entries: []` = hidden.
- `LIMS_FRONTDESK_PAYMENT_RESULT_URL` boot-fail rule not enforced yet (needs C15 port registration; B12 task).
- Results (post-ruling, JWT bootConfig): 27/30 vitest, 9/9 node:test. 3 boot tests fail: core ajv `strict mode: unknown keyword: "x-coded-set"` (core/openapi.ts, C0-0D) — BLOCKED on C0, see .orchestra/cr/FD-T01.md (retitled per review item 2; CR id left to register owner). Re-run 2026-11-07: unchanged.
