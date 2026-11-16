Title: CR-C0-0B-PROVPACK-1: tenant_admin holds every tenant scoped permission; provisioning applies the default role pack (LD-301)
From chunk: C0-0B            To owner: spec owner (lead) for spec/program/11-ROLE-MATRIX.md and spec/chunks/C0-foundation-contracts/02-TRD.md; C0-0C/contracts owner for contracts/permissions.yaml
Type: bug
Blocking? no (implemented under LD-301; the spec text lags the code)

Problem: live staging 2026-11-17 (tenant metrolabs): a new lab got only the ten default roles; tenant_admin lacked lab, instruments, inventory,
quality, payments, engagement, home collection and partners permissions; the pack could only be applied by `identity:apply-role-pack` with
cloud PG credentials. Founder 2026-11-16: "admin should get all features" (LD-301, AUTH-SENSITIVE LD-189).

Implemented (services/api/src/modules/identity/service/tenant.service.ts):
- `TENANT_ADMIN_GRANTS` = every code of contracts/permissions.yaml EXCEPT (a) `platform.*` and (b) actor-only codes (`roles: []`: device,
  portal, patient, partner, system sets; 02-TRD gen-permissions rule forbids granting them to a tenant role). These two classes are the
  "never for a tenant administrator" set; tests compute it from the catalogue (tenant.provpack.helpers NEVER_FOR_TENANT_ADMIN).
- `DEFAULT_ROLE_PACK = 'elabcorp_default'` applied at provisioning and again at activation through role-pack.service (insert only, R6 tenant
  edits win). Activation also adds any missing tenant_admin grant (ON CONFLICT DO NOTHING), so pre-fix labs are repaired by activating.
- mfa_required stays true on tenant_admin; no other default role changes.

Proposed spec change (exact text to decide by lead):
1. 11-ROLE-MATRIX R6: "Templates are custom roles (S9) seeded at tenant provisioning (S14) from the default pack `elabcorp_default`, re-applied
   insert-only at activation, and editable afterwards by identity.role.manage holders."
2. 11-ROLE-MATRIX R5 / R5a / §3.3 and R2: CONFLICT to resolve. R5a says Admin holds NO decision authority (result verify/approve/amend,
   sign-out, release, refunds/reversals/cancel, PO approve) and NO bench work. LD-301 now gives the DEFAULT role `tenant_admin` every
   tenant scoped code, which includes those decision authorities. Either record LD-301 as overriding R2/R5a for tenant_admin (separation of
   duties then rests on who is assigned tenant_admin), or ask the founder to narrow it and list the excluded codes.
3. 02-TRD provisioning text (tenant bundle, §5.10) + 03-APP-FLOW §9.1: add "default role pack applied (role.change access-log row per created
   role)" to the provisioning bundle and "tenant_admin grants + default pack re-applied, additive" to activation (T2).
4. contracts/permissions.yaml: `tenant_admin` is not listed in each code's `roles:`; the code derives its grants. Either list it (generated
   ROLE_GRANTS then matches) or state in the file header that tenant_admin = all non-platform, non-actor-only codes.

Backward compatible? yes (additive grants/roles; nothing removed).
Tenant/security impact: privilege increase for tenant_admin (LD-189, founder yes LD-301). No RLS change. No platform permission reachable.
Alternatives considered: HTTP applyRolePack (still a stub, CR-C2-RM-001) — not needed for this fix.
Tests that prove it: services/api/src/modules/identity/handlers/__tests__/tenant.provpack.test.ts (22).
