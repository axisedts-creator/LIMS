# T14 impl (writer)
Files: identity/service/role.service.ts (service + default SQL repo), identity/handlers/{listPermissions,listRoles,createRole,getRole,updateRole,deactivateRole}.ts, handlers/role.http.ts (shared bind/If-Match/field mapping), handlers/index.ts (wiring).
Tests: T14-verify.cmd 104/104 pass. typecheck: no new errors (2 pre-existing in contracts/ports/IdentityPort.ts, shared-ts/bsdate). Full suite: 17 fail, all outside identity (signing key fixtures missing, reporting static, boot timeouts under load; boot passes alone).
[CONV] description max 300 (DB roles__text__ck) although contract says 500 — needs CR (contract vs schema mismatch).
[CONV] signout job_key `signout:<role_id>.<version>.<batch>:role_change`, payload {tenant_id, user_ids[<=200], reason}; 02-TRD §10 only names session/user-id keys.
[CONV] last-admin race: listRoleManageHolders first locks all active role rows of the tenant (FOR UPDATE), then reads holders in a fresh snapshot.
[CONV] permission `phase` read from contracts/permissions.yaml (absent = "1"); not in generated constants. revokeSessions takes optional 5th arg actorId (revoked_by).
Open: default SQL repo never run against a live DB (no T14 DB harness); lint not run (no lint script in services/api).
