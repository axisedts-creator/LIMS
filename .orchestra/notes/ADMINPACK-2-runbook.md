# Founder runbook: apply a role pack to the staging lab (ADMINPACK-2, LD-254 FOUNDER STEP, LD-260)

Safe to re-run. Roles the lab already has are never rewritten (tenant edits win); only missing pack roles are created.

## 1. Set the database connection (names only; use your own values, never put them in a file)
The CLI reads the standard libpq environment of your shell and nothing else. Set these five in the same terminal before step 3:
- `PGHOST` (staging database server)
- `PGPORT`
- `PGUSER` (a role allowed to write the identity tables)
- `PGPASSWORD`
- `PGDATABASE`

## 2. Find the tenant uuid of the staging lab
Connect to the staging database with `psql` (same PG* variables) and run:
`SELECT id, tenant_code, display_name, status FROM core.tenants ORDER BY created_at;`
Copy the `id` (a uuid) of the staging lab row. That value is the `<tenant uuid>` below.

## 3. Run, from the repository root
Corporate pack:
`pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack elabcorp_default`

Assist pack:
`pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack elabassist_standard`

Use the pack that matches the lab. Exit code 0 means success (also when nothing changed), 1 failure, 2 wrong arguments (tenant must be a uuid).

## 4. Read the result
One line: `role pack <code>: created=N updated=N unchanged=N`.
- created: pack roles that did not exist and were added now.
- updated: roles changed by the pack (0 today; existing roles are left alone).
- unchanged: roles already present, left as they are.
Second run on the same lab should show created=0.

## 5. Then
The administrator user must hold the pack role (assign it in Users and roles), and must sign in again so the new permissions appear in the session.
