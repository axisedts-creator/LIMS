# T0D-FIX-2 tests (tester)
New: services/api/src/core/__tests__/contract-parameters.test.ts (every operation of every contracts/openapi/*.yaml: loaded params == declared; billing: 3 ops explicit $ref, no alias)
New: services/api/src/modules/billing/__tests__/contract/fix2.list-limit.test.ts (limit=200 passes the API ajv for the 3 list ops; bounds/unknown param/cursor still 400)
New: services/api/src/modules/partners/__tests__/contract/fix2.settings-pending.test.ts (getPartnerSettings = 501 operation_pending in dev/staging/production)
New: services/api/src/modules/identity/__tests__/fix2.access-review-pending.test.ts (listAccessReviews, recordAccessReview = 501 operation_pending)
Edited (stale pins): partners/__tests__/boot.test.ts (getPartnerSettings no longer a T01 stub), identity/__tests__/audit-wire.operations.test.ts (KNOWN_STUBS = the 2 role pack stubs)
Run: cmd /c .orchestra\notes\T0D-FIX-2-verify.cmd. Writer: use a HANDLER returning { status: 501, body: pendingProblem(op, path, ctx.requestId) } (core/errors.ts), NOT pendingOperations: sales1/msgdesk1/partyset1 pending tests cap partners' pending list, and identity manifest is not in the task files.
Finding: only billing's 3 ops differ; loadSpec keeps the $ref, glue drops the shared (aliased) param object. core/openapi.ts not involved: the YAML fix is enough, no -left note needed.
