# T0B-PROVPACK-1 impl (writer)
- Changed: `services/api/src/modules/identity/service/tenant.service.ts` only. CR: `.orchestra/cr/T0B-PROVPACK-1.md`. Dispute: `.orchestra/notes/T0B-PROVPACK-1-dispute.md`.
- `TENANT_ADMIN_GRANTS` (catalogue minus platform.* and `roles: []`) used by seedRoles for tenant_admin; other roles keep ROLE_GRANTS.
- `DEFAULT_ROLE_PACK = 'elabcorp_default'`; `adminGrantsAndPack` (additive, ON CONFLICT DO NOTHING, role-pack.service reused) runs at provisioning (after the admin invite) and at activation (repair of pre-fix labs).
- [CONV] role-pack repo seam follows the tenant repo seam: injected TenantRepo without `rolePackRepo` = pack step not wired (unit fakes have no SQL).
- Tests (after ruling, tests revised da40f0ba2): verify set 14 files 477/477 pass; tsc 0 errors. No code change needed after the ruling.
- Open: CR flags R2/R5a conflict (tenant_admin now holds sign-off/refund authorities per LD-301); metrolabs still needs a re-activation path (it is `provisioning`, so activateTenant repairs it).
