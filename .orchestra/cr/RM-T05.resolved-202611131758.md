```
Title: CR-C2-RM-001: applyRolePack + listRolePacks operations and staff_web route for the role-pack apply screen
From chunk: C2            To owner: C0-0C (contracts/openapi/identity.yaml, contracts/routes.yaml)
Type: api
Blocking? yes — C2 06-IMPLEMENTATION-PLAN row RM-T05 (11-ROLE-MATRIX §8: "needs the HTTP operation applyRolePack, so a CR to C0,
  CR-C2-RM-001, must be accepted first"). All 26 RM-T05 tests red on the missing contract (.orchestra/notes/RM-T05-tests.md).
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  AC 11-ROLE-MATRIX §8 / LD-141: a tenant admin picks a role pack, sees a diff against current roles, and applies it.
  The service exists (services/api/src/modules/identity/service/role-pack.service.ts applyRolePack, RM-T02: creates missing
  pack roles, never rewrites existing ones (R6), returns {pack_code, created, updated, unchanged}), but there is no HTTP
  operation to call it, no read of pack contents to diff against, and no staff_web route for the screen.
Proposed change (exact), additive:
  contracts/openapi/identity.yaml
    /v1/identity/role-packs:
      get:
        operationId: listRolePacks
        tags: [ identity ]
        summary: List role packs with their roles (diff source for the apply screen)
        security: [ { bearerJwt: [] } ]
        x-permission: identity.role.manage
        x-context: tenant
        x-idempotency: none
        x-rate-limit-tier: general
        x-error-codes: []
        responses:
          "200": RolePackList = { data: [ { pack_code: string, name: string (= data-file label),
                   roles: [ { code: string, name: string, mfa_required: boolean, permission_codes: string[] } ] } ] }
          "401" "403" "429" "500": _common refs
    /v1/identity/role-packs/{pack_code}/apply   (or /v1/identity/role-packs/apply with pack_code in body — C0 picks; body form shown)
      post:
        operationId: applyRolePack
        tags: [ identity ]
        security: [ { bearerJwt: [] } ]
        x-permission: identity.role.manage
        x-context: tenant
        x-idempotency: required
        x-rate-limit-tier: general
        x-error-codes: [ common.validation_failed ]
        requestBody: { pack_code: string (required) }  — tenant and actor come from the token only; no tenant_id/actor_id in body
        responses:
          "200": ApplyRolePackResult = { pack_code: string, created: string[], updated: string[], unchanged: string[] }
          "400" "401" "403" "409" "422" (unknown pack_code -> common.validation_failed) "429" "500": _common refs
  contracts/routes.yaml (after staff.admin.roles):
    - { id: staff.admin.role_packs, origin: staff_web, path: /admin/roles/packs, owner: C2, permission: identity.role.manage }
  Optional (same CR, per 11-ROLE-MATRIX §8): contracts/role-packs.yaml generated from 11-ROLE-MATRIX.data.yaml.
Backward compatible? yes — two new operations, one new route; nothing renamed or removed.
Tenant/security impact: no RLS change (writes core.roles / core.role_permissions under existing tenant policies); no PHI.
  New authenticated tenant surface gated by identity.role.manage (privileged; MFA-required roles per R-rules). Apply is
  idempotent and never widens an existing role (R6); each created role emits access audit 'role.change'.
IRD/regulatory impact: n/a (not billing).
Alternatives considered: web screen reading the data file directly — rejected (tests forbid copying corp_/std_ content into
  the web; contract-first per 04 §1). Reusing createRole per role from the web — rejected (no pack diff/R6 server-side guarantee).
Tests that will prove it: apps/web/src/features/admin/roles/__tests__/rm-t05.contract.test.ts + rm-t05.screen.test.tsx
  (26 cases), apps/web/tests/e2e/identity/RM-T05.role-packs.spec.ts (Playwright: diff before save, gate, axe).
```
