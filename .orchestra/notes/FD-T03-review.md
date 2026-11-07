CHANGES
1. services/api/package.json:19 and pnpm-lock.yaml:352-354 — not C4-owned (01-CHUNK-MAP §3: `services/api/package.json` → C0-0D; `pnpm-lock.yaml` → C0-0A). Fix: revert both hunks (`git checkout ab233c4 -- services/api/package.json pnpm-lock.yaml`) and write `.orchestra/cr/FD-T03.md` (04-CHANGE-REQUESTS template) asking C0-0D to add devDependency `"pg": "8.23.1"` to services/api (already resolved in the lockfile via graphile-worker). FD-T03 stays blocked on that CR; no repo code change needed.

Checked, no defect:
- Ran `tests/frontdesk/FD-T03.pg.sh` (supabase/postgres:17.6.1.136, migrations + tenant_a/b seeds): 83/83 pass — done_when met.
- Every statement binds `tenant_id = $1` explicitly and is schema-qualified; tenant_id from argument only (forged row.tenant_id ignored, tested); column/table names from constant allowlists, values parameterised; LIKE metacharacters escaped (injection tested).
- Cross-tenant SELECT (RLS bypassed = explicit filter, and under RLS backstop) and INSERT (42501) probes per repo; id-swap on lists; counters concurrency (20 parallel, distinct) + tenant isolation.
- consents append-only (no update/delete export). No logging, no PHI, no secrets (random throwaway PWs, synthetic patients). Repo `Tx` structurally compatible with core `Tx`.
- Cross-centre (07 §6.2) deferred to handler tests — acceptable, needs memberships/claims, not repo scope.
