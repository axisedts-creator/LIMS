# Founder runbook: widen an existing admin role in the staging lab (ADMINPACK-3, LD-262)

Why: the lab was provisioned before the admin packs were widened, so it still holds the old, shorter `corp_admin` (92 permissions). The ADMINPACK-2 command never rewrites a role the lab already has. This flag adds only the permissions the pack gained to the role you name.
Rules: it only adds. Nothing is removed, and the role's name, MFA setting and every other column stay as they are. Roles you do not name are not touched.

## 1. Connection and tenant uuid
Same as the ADMINPACK-2 runbook, steps 1 and 2: set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` in your shell (names only here, never put values in a file) and copy the `<tenant uuid>` from `/platform/tenants/<tenant uuid>`.

## 2. Corporate admin: dry run first, then apply
Dry run (writes nothing):
`pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack elabcorp_default --add-missing corp_admin`

Read the output, then apply the same command with --yes:
`pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack elabcorp_default --add-missing corp_admin --yes`

## 3. Assist admin (only if the lab uses the Assist pack)
Dry run:
`pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack elabassist_standard --add-missing std_admin`

Apply:
`pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack elabassist_standard --add-missing std_admin --yes`

## 4. Read the dry run
- `would add N: ...` = permission codes the pack holds and the lab's role lacks. These are what `--yes` will add.
- `only in the lab, kept, never removed (N): ...` = codes the lab's role holds and the pack lacks (for example added by a lab administrator). Informational: nothing is removed.
- `would add 0: (none)` = already up to date; `--yes` changes nothing.
After `--yes` the line says `added N: ...`. A second run says `added 0`.
Exit code 0 = success, 1 = failure (nothing is half-applied; the run is one transaction), 2 = wrong arguments or a refusal (role not in that pack, the lab does not have the role, or a privileged permission would go to a role without MFA required).

## 5. Then
The administrator user must sign in again so the added permissions appear in the session.
