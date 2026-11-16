APPROVE

Round 2. All three round-1 items fixed:
1. Runbook step 2 now uses `/platform/tenants`; code link goes to `/platform/tenants/${t.tenant_id}` (apps/web/src/features/platform/TenantsTable.tsx:14), so "copy the last part" works. psql fallback says it needs BYPASSRLS and that `lims_api` gets zero rows under FORCE RLS.
2. PGUSER = `lims_api`, role name only; password stays in the shell.
3. Static test now asserts `/platform/tenants`, BYPASSRLS when psql is mentioned, and `lims_api`.

Rechecked: package.json adds one script, same as identity:bootstrap-platform-admin except the file name. CLI untouched (not in the diff). Result line and exit codes 0/1/2 in the runbook match cli/apply-role-pack.ts:35-43. No secret, host or password in any file. docs/runbooks is absent, so the notes runbook is the right place. Only owned paths touched.
Tests (rerun by reviewer): apply-role-pack.script.test.ts + apply-role-pack.cli.test.ts, 31/31 pass.
