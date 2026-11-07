APPROVE
# T-01 review (reviewer, chunk C3-catalog-pricing) — diff 8d7ad21..a5fe3ef
- Diff scope: `services/api/src/modules/catalog/__tests__/probes/pending.json` (new, 107 entries) + `.orchestra/notes/T-01-impl.md`. Both owned/allowed paths; pending.json is listed in the task brief files.
- pending.json is now tracked in git (`git ls-files` confirms), so the earlier ENOENT problem cannot come back.
- Names: skeleton.test.ts:125 checks every entry is an operationId in contracts/openapi/catalog.yaml with no duplicates; :133 checks the list equals exactly the handlers that still throw common.service_unavailable/not_implemented. Nothing invented.
- No PHI, no secrets (plain operationId strings). RLS/permissions/idempotency/rate tier: no code change in this diff.
- Ran: `npx vitest run src/modules/catalog` = 1 file, 47/47 pass.
