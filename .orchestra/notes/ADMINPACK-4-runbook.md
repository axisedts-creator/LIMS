# Founder runbook: connect and apply a role pack in the staging lab (ADMINPACK-4, LD-265)

This note replaces the connection steps of the ADMINPACK-2 and ADMINPACK-3 runbooks (their placeholders were pasted literally, the pooler user name was wrong, and the Supabase certificate was not trusted). The apply and add-missing steps of those runbooks stay valid.

## 1. One-time: the Supabase CA file
In the Supabase dashboard open Database settings, find SSL Configuration, and download the CA certificate (a `.crt` file). Save it as `C:\LIMS-cloud-secrets\supabase-ca.crt`. Do this once.

## 2. Connect (paste as is, from the repository root)
Open PowerShell in the repository root and paste the whole block. It asks for the database password (hidden) and the tenant uuid (shown in the platform console at `/platform/tenants`). Nothing needs editing.

```powershell
$cfg = @{}
Get-Content 'C:\LIMS-cloud-secrets\supabase-test.env' | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2].Trim('"').Trim("'") }
}
$ref = $cfg['SUPABASE_PROJECT_REF']
if (-not $ref -or -not $cfg['SUPABASE_POOLER_HOST']) { throw 'SUPABASE_POOLER_HOST or SUPABASE_PROJECT_REF missing in supabase-test.env' }
$env:PGHOST = $cfg['SUPABASE_POOLER_HOST']
$env:PGPORT = '5432'
$env:PGDATABASE = 'postgres'
$env:PGSSLMODE = 'require'
$env:PGUSER = "lims_api.$ref"
$secure = Read-Host 'Database password for lims_api' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if (-not (Test-Path 'C:\LIMS-cloud-secrets\supabase-ca.crt')) { throw 'Supabase CA file missing: see step 1' }
$env:NODE_EXTRA_CA_CERTS = 'C:\LIMS-cloud-secrets\supabase-ca.crt'
$tenant = Read-Host 'Tenant uuid'
```

## 3. Look first (read-only), then dry run, then apply
`--list` is read-only: it changes nothing and writes no audit event. For every role of the pack it shows whether the lab has it, `is_system_default`, `is_active`, `mfa_required`, the lab's permission count, the pack's permission count and how many pack permissions the lab's role lacks.

```powershell
pnpm --filter @lims/api identity:apply-role-pack --tenant $tenant --pack elabcorp_default --list
```

Dry run (nothing is written):

```powershell
pnpm --filter @lims/api identity:apply-role-pack --tenant $tenant --pack elabcorp_default --add-missing corp_admin
```

Apply, only after the dry run looks right:

```powershell
pnpm --filter @lims/api identity:apply-role-pack --tenant $tenant --pack elabcorp_default --add-missing corp_admin --yes
```

If `--list` shows `in_lab=no` for a role, run the plain apply once (it only creates missing pack roles, never edits existing ones):

```powershell
pnpm --filter @lims/api identity:apply-role-pack --tenant $tenant --pack elabcorp_default
```

The plain apply now also lists the role codes under `created:`, `updated:` and `unchanged:`.

## 4. Read a refusal: `refused: <reason> <role>`
One line, exit code 2 (plain apply: 1). Nothing was written.
- `args`: bad arguments (unknown pack, empty or duplicate role list).
- `role_not_in_pack`: the role is not in that pack.
- `role_missing_in_lab`: the pack has the role but the lab does not. Run the plain apply.
- `role_is_system_default`: the lab's role with that code is a system default role; it is never changed.
- `unassignable_code`: the pack holds a permission code that is not in the permission contract. Report it; do not retry.
- `privileged_without_mfa`: a privileged permission would go to a role whose `mfa_required` is off. Report it; the flag never changes MFA.

## 5. Read a failure: `apply-role-pack failed: ...` and `db: ...`
After a failure the next line `db: <sqlstate> <schema>.<table> <constraint>` names the database object. It never holds row values. `42501` = the database denied the statement (row-level security or privilege); `23503` = a foreign key points at a row that does not exist; `-` = not reported. Send both lines to the lead.

## 6. Then
The administrator user must sign in again so new permissions appear in the session.
When you are done, close this PowerShell window: the database password stays in its environment until you do.
