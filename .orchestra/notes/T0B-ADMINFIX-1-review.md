APPROVE
- Range 23ec863..HEAD: only test fixture change per arbiter ruling (ctxOk gains IdentityPort.assertRole; header comment updated); `bare` stays port-less. No assertion weakened.
- Code under task (_audit-export.bind.ts, from 23ec863): asserts `audit.log.export` (matches x-permission of createAuditExport/listAuditExports/getAuditExport/downloadAuditExport in contracts/openapi/identity.yaml) before any service call; fails closed `common.internal` without port; `auth.unauthenticated` checked first. Same shape as _audit-view.bind.ts.
- No file under services/api/src/core in this task (core fix is T0D-PORTOWN-1, LD-305). No audit row or retention change. No logs/PHI/secrets added.
- Chain test covers all seven ops as admin (2xx + contract schema) in shadow and enforce, assertRole count 1..2 (ruling 202611170111), no extra permission, 403 with no read/write for non-holders, P-10.
- Second cause named in impl note: audit-export.service.ts canReadAll/getActor read ctx.ports.IdentityPort (same registry refusal); plus no handler assert in shadow mode.
- Ran verify.cmd: 4 files, 171/171 pass. `tsc --noEmit` clean.
