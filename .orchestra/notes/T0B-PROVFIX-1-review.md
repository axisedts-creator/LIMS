# T0B-PROVFIX-1 static review of provisionTenant (writer; no database in the lane — read only)
Roles: request tx = lims_api (member of lims_app). Outside scope claims = platform session (scope=platform, aal2, sub=staff user, no tenant_id).
Inside scope claims = {sub: identity system actor, actor_type 'system', tenant_id=new id} (core/db/tx.ts:186) => is_staff_or_system() TRUE, is_platform_actor() FALSE.
Audit trigger = app.tg_row_audit() SECURITY DEFINER (lims_owner) -> audit_log__insert__owner_only. No created_by/updated_by/recorded_by FKs exist in db/migrations (grep).
| # | statement | scope | admitting policy | audit trg | FKs | verdict |
|1| SELECT core.tenants WHERE tenant_code (findByCode) | out | tenants__select__platform | - | - | OK |
|2| INSERT core.tenants ... RETURNING | out | tenants__insert__platform + tenants__select__platform (RETURNING) | yes: A12.5 clause (core.tenants, row_id=tenant_id, platform) | - | OK |
|3| INSERT identity.ird_annex_records x3 | IN (moved) | NONE: ird_annex_records__insert__platform needs is_platform_actor() = false in scope | yes (would pass in scope) | tenant_id->core.tenants | FAILS — CR .orchestra/cr/T0B-PROVFIX-1.md (blocking) |
|4| INSERT core.branches | in | branches__insert__tenant | yes, tenant_id=current | tenant_id->core.tenants | OK |
|5| INSERT core.collection_centres | in | collection_centres__insert__tenant | yes | tenant, (tenant,branch)->branches | OK |
|6| INSERT core.roles / core.role_permissions (per default role) | in | roles__insert__tenant / role_permissions__insert__tenant | yes | tenant, role | OK (permission_code FK not checked) |
|7| INSERT identity.tenant_settings (training_mode) | in | tenant_settings__insert__tenant | yes | tenant | OK (column added by 20261115192000) |
|8| INSERT identity.feature_flags SELECT FROM identity.g_feature_flags | in | feature_flags__insert__tenant; g_feature_flags GRANT SELECT lims_app | yes | tenant, flag_code | OK (g_ RLS not checked) |
|9| INSERT identity.tenant_contract_acceptances x2 | in | tenant_contract_acceptances__insert__tenant | yes | tenant | OK |
|10| INSERT core.users / core.memberships / core.membership_roles (SELECT core.roles, RETURNING) | in | users/memberships/membership_roles__insert__tenant; roles + membership_roles __select__tenant | yes | tenant, membership, role | OK |
|11| INSERT identity.invitations (tenant_id set) | in | invitations__insert__tenant | yes | tenant, membership | OK |
|12| SELECT app.enqueue_job(...) | in | DEFINER, EXECUTE lims_app | - | - | OK |
|13| INSERT audit.access_log (actor_id = staff user, centre_id NULL) | in | access_log__insert__tenant (no actor_id check) | - | - | OK |
Pre-scope also: GoTrue adminCreateUser (external) + SELECT app.identity_user_exists (DEFINER) — reads only.
## Other operations (brief item 4) — outside-scope statements in tenant.service.ts
- transition (activate/suspend/reactivate/terminate): load() = SELECT core.tenants out of scope (read, platform policy); writes in scope. OK.
- updateTenant: UPDATE core.tenants out of scope -> audit via A12.5 clause. OK.
- updateTenantSettingsAsPlatform: findSettings out of scope (read). setFeatureFlagAsPlatform, inviteTenantAdmin (line ~604): only load/gotrueUser/identity_user_exists out of scope (reads); inviteAdmin writes in scope. OK.
- getTenant.detail: reads out of scope (known open CR C2.T22-detail). No other audited write outside a scope found; nothing fixed.
Risk: static only; RLS of g_feature_flags / permission FKs / withTenantScope allowlist containing provisionTenant not re-verified here.
