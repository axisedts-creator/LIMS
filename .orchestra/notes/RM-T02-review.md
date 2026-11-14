APPROVE

Reviewed `git diff e66c4e63..HEAD` (RM-T02) against 11-ROLE-MATRIX R2/R6/S9, s4 item 5, s8, LD-141 and the core.roles / core.role_permissions migration.

- Names: core.roles (id, tenant_id, role_code, display_name, mfa_required, created_by, updated_by), core.role_permissions (tenant_id, role_id, permission_code, created_by) match 20261105000500 verbatim. Access-log action `role.change` / entityType `role` matches role.service. Error codes auth.unauthenticated / common.internal / common.validation_failed are existing codes.
- Tenant isolation: tables are ENABLE+FORCE RLS with tenant_id = app.current_tenant_id() AND is_staff_or_system(); CLI claims actor_type 'system' + tenant_id satisfy it. Every statement carries explicit tenant_id = $1; tenant/actor from ctx only (input smuggling test). No `::uuid[]` cast needed (text[] of permission codes only).
- Insert-only re-apply: no UPDATE/DELETE; role_permissions insert uses ON CONFLICT DO NOTHING; existing pack role (any state) left alone, so tenant-added permissions are never removed (R6). is_system_default left to column default false (S9). Default roles never written.
- Pack codes satisfy roles__role_code__ck (all < 30 chars). Permissions come from the RM-T01 loader (validated against contracts/permissions.yaml); no widening, no invented permission.
- No HTTP operation (CR-C2-RM-001 pending); LD-141 cited in both files. Only owned paths touched. No secrets, no PHI in logs; CLI error output is one bounded line.
- Tests: seed (19 corp_ / 10 std_ equal data file, sorted), idempotency, tenant edits kept, default roles + tenant B untouched, audit, fail-closed, SQL shape. Ran: vitest role-pack.service + apply-role-pack.cli = 51/51 pass.

Non-blocking open points (already in RM-T02-impl.md, not defects of this task):
1. Hook into provisionTenant (tenant.service not in task files) - R6/S14 "seeded at tenant provisioning" is only met once a follow-up wires it.
2. CLI system actor = nil UUID; confirm or replace with the configured identity system actor id when one exists for CLIs.
3. package.json script `identity:apply-role-pack` not added (not in task files); runbook line in the CLI references it.
4. No real-DB run (RLS/FK path verified by reading only).
