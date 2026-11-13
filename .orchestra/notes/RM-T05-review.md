APPROVE
# RM-T05 review (reviewer) — diff 6058caff..9fd800f6

Checked against LD-150 / LD-141 / LD-140 and 11-ROLE-MATRIX s8:
- contracts/openapi/identity.yaml: listRolePacks + applyRolePack copied field for field from LD-150 (paths, operationIds, x-permission identity.role.manage, x-context tenant, x-idempotency none/required, x-rate-limit-tier general, x-error-codes [common.validation_failed], body {pack_code} required, 200 shapes, response sets 401/403/429/500 and 400/401/403/409/422/429/500; all _common refs exist). additionalProperties:false on body, so tenant/actor cannot ride in the body.
- contracts/routes.yaml: staff.admin.role_packs row verbatim, placed after staff.admin.roles as LD-150 orders.
- Web: page gates identity.role.manage before any API call; action sends {pack_code} only with Idempotency-Key; diff shown before Apply; no removal/widening shown (R6, matches RM-T02 server `updated: []`); PermissionMatrix read-only + kit components; Apply latched against double send. PACK_CODE_RE accepts both data-file pack codes (elabcorp_default, elabassist_standard).
- No PHI, no secrets, no logging added. No RLS/DB change (none expected per LD-150). Paths: features/admin/roles/** and app/(staff)/admin/** are C2; contracts edits authorised by LD-150.

Run: `pnpm --dir apps/web exec vitest run --config src/features/admin/roles/__tests__/vitest.rm-t05.config.ts` -> 26/26 pass.

Escalation for lead/C0 (not a writer defect — placement is mandated by LD-150):
- `pnpm vitest run contracts/__tests__/t0d-12d.test.ts contracts/__tests__/registry-equality.test.ts` -> 4 fail: t0d-12d expects 174 routes and a contiguous LD-112 block (new row wedged after staff.admin.roles); registry-equality expects routes.yaml == IC §7. C0 must update both tests and IC §7 for CR-C2-RM-001 before merge to main is green.

Not verified: Playwright spec apps/web/tests/e2e/identity/RM-T05.role-packs.spec.ts (needs stack); server HTTP handlers for listRolePacks/applyRolePack are not in this task, so the screen 404s on a live stack until they land.
