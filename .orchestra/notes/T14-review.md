CHANGES
# T14 review (reviewer) — diff 25cb23a..605d0c0

Ran `.orchestra\notes\T14-verify.cmd`: 3 files, 104/104 pass. Names (tables/columns vs db/migrations/20261105000500, `identity.sessions` cols, error codes, `role.change`, `role_change`, `identity.gotrue_signout`), tenant scoping (every SQL names tenant_id, `ANY($2::uuid[])`), If-Match/428/409, mass-assignment, last-admin rule (03-APP-FLOW §2 "Last admin" def) and fan-out batches of 200 check out. No new tables (no RLS work), no PHI in logs, no secrets, only owned paths + notes.

Defects (both are spec deviations decided as [CONV] without the CR that CLAUDE.md requires):

1. services/api/src/modules/identity/service/role.service.ts:48 — `DESCRIPTION_MAX = 300` contradicts contracts/openapi/identity.yaml:5584/5598 (`description maxLength: 500`) and 02-TRD §5.4 row createRole (`≤500`); DB `roles__text__ck` says 300 (C0 05-SCHEMA:772). Fix: keep 300 (safe side), and write `.orchestra/cr/T14.md` (template spec/program/04-CHANGE-REQUESTS.md) asking the contract owner to set RoleCreateRequest/RoleUpdateRequest/Role `description.maxLength` to 300 (or C0 to widen the CHECK to 500); reference it in the comment at :47.

2. services/api/src/modules/identity/service/role.service.ts:249-253 — job_key `signout:<role_id>.<version>.<batch>:role_change` and payload `{tenant_id, user_ids[], reason}` are invented; 02-TRD §10 (line 533) fixes `job_key = signout:<session_id or user_id>:<reason>` and the tenant-kind task does `adminSignOutUser(userId)` (single user), while 03-APP-FLOW §4.3 demands batches of 200. Fix: add this conflict to the same `.orchestra/cr/T14.md` (proposed: batch job_key `signout:<role_id>.<version>.<batch>:role_change`, payload `{tenant_id, user_ids ≤200, reason}` added to the §10 task row), so the future gotrue_signout task (not yet in the repo) is built to the agreed payload.

Notes (not blocking): `identity.gotrue_signout` is not yet in `core.g_task_registry` seeds, so `app.enqueue_job` would raise `unknown_task_identifier` against a live DB until the task registration lands; default SQL repo never ran against Postgres (no T14 DB test).
