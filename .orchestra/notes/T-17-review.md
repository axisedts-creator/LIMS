APPROVE

Reviewed `git diff 3264ae08..HEAD` (T-17) against 02-TRD §5 rows 71–81, 03-APP-FLOW §2.1 V1–V5 / §2.4, PRD AC-13.3–13.8.
- Names: operationIds, error codes (`catalog.code_duplicate`, `common.version_conflict`, `catalog.version_in_use`, `common.not_found`), path params and tables match the spec verbatim.
- AC-13.6/13.7: second default / owner already assigned -> 23505 -> 409 `catalog.code_duplicate`; default list cannot be deactivated (400). AC-13.4: draft-only item edits (status check + P0001 mapping). AC-13.5: `change_reason` required. AC-13.8: integer paisa 0..999,999,999, NPR only.
- V1/V4/V5: one draft (409 version_conflict), version_no = max+1, copy defaults to latest published; publish locks list then version, enforces now−300 s and strictly-later window start, supersedes open-ended predecessor in the same tx, bumps `price_list`/`versioned`.
- Merge (§2.4): merged doctor's assignment removed; re-assigned to the survivor only if it has none; same tx.
- Tenant isolation: every statement carries `tenant_id = $1`; owner/orderable existence checked in-tenant (foreign = unknown = 404). No new migrations (RLS untouched). No logging, no PHI, no secrets. Paths all inside the catalog module.
- Checks run: catalog suite 34 files / 2731 tests pass; `tsc` shows only the 2 pre-existing errors outside catalog (contracts/ports, packages/shared-ts).

Non-blocking notes (no fix required for T-17):
1. Merge reassignment INSERT has no `mapPg`; a concurrent `replacePriceListAssignments` adding the survivor to another list could surface a raw 23505 / deadlock instead of a 409 (rare race).
2. Merge changes a list's assignments but bumps only the `doctor` revision, not `price_list`; fine while consumers key on the tenant revision.
