# RM-T02 impl (writer)
- Files: identity/service/role-pack.service.ts (createRolePackRepo, createRolePackService.applyRolePack), identity/cli/apply-role-pack.ts (main + guarded entry point).
- [CONV] Pack data via RM-T01 loadRolePacks() (validated against contracts/permissions.yaml); permission lists sorted + de-duplicated; is_system_default left to column default false (S9 custom role).
- [CONV] Re-apply is insert-only: an existing pack role (same code, active or not) is left as the tenant edited it (R6 "editable afterwards"); permissions a tenant removed are NOT restored, so `updated` is always [] and repo.addPermissions is unused by the service (kept as the insert-only seam the tests require).
- [CONV] CLI system actor = nil UUID, claims {actor_type:'system', tenant_id}, operationId 'applyRolePack' context 'cli' on createDb.requestTx: no configured system-actor id exists for CLIs. Open: confirm actor id / RLS is_staff_or_system for system claims on a real DB.
- Open: hook into provisionTenant (tenant.service not in task files); package.json script `identity:apply-role-pack` not added (not in task files); concurrent applies on one tenant fail with 23505 from the unique (tenant_id, role_code) index (caller rolls back, re-run is safe).
- Tests: vitest role-packs 82/82 pass (incl. RM-T01); tsc: no errors in the new files. Real-DB run not done.
