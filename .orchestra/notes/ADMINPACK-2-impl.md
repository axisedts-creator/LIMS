# ADMINPACK-2 impl (writer)
- services/api/package.json: one new script `identity:apply-role-pack`, same loader as bootstrap script, points at cli/apply-role-pack.ts (LD-260).
- .orchestra/notes/ADMINPACK-2-runbook.md: founder runbook (docs/runbooks does not exist). Both exact commands, PG* names only, tenant lookup via core.tenants, result reading, admin must hold pack role + sign in again.
- CLI and tests untouched. Tests: script static test + apply-role-pack.cli.test.ts = 29/29 pass.
- [CONV] runbook says `updated` is 0 today: service only creates missing roles, existing ones counted unchanged (R6). CLI prints counts, not lists.
- Open: tenant lookup SQL assumes founder has psql access to staging; tester/reviewer may confirm.
