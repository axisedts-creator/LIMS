APPROVE

AN-T09 review (reviewer), diff 521875d1..256e377b.

Checked against 02-TRD §5 (#4–#7, #16, #17, #30), §5.1, §6.3, §6.4; PRD US-05/06/08, M01–M08, M25–M32, M35–M38; 03 IdentityPortV1.getActor/ActorProfile.permissions; 03 route `staff.billing.daily_cash` / `billing.cash_report.read`.
- Names verbatim: operationIds, report fields, enums (group_by, sort, rollup), limits (1–100 / 1–50), maxItems (payment_method_code ≤ 20, referrer_id ≤ 20), `daily_cash_route_id` enum, `recipients` shape. No money field on top referrers (D-44). No "commission".
- Permissions: assertRole before any read on all 7 ops; collections + #30 on `analytics.collections.read` (CR-C8-001/D-46); #16 on dashboard.read; P-10 conditional parts (`recipients`, `daily_cash_route_id`) via actor permissions, no 403. Idempotency none, tier general (manifest unchanged).
- Tenant isolation: every SQL has `tenant_id = $1` + TRD §6 scope predicate; dynamic SQL fragments only from constant allow-lists; LIKE pattern bound and escaped. No new tables, so no RLS change in scope.
- No logs added; no PHI in queries (search is POST body); no secrets.
- Ran AN-T09-verify set (`--testTimeout 170000`): run 1 = 320/321 (1 failure, did not reproduce), run 2 = 321/321. `tsc --noEmit`: no analytics errors. Lint not run.

Non-blocking notes:
1. `.orchestra/cr/C3.T-31.md` -> `C3.T-31.resolved-202611081506.md` rename was swept into the tester commit d43427a7 (not a C8 path). Orchestrator should confirm it was intended.
2. Payment-method label = code; TRD §6.3 wants message catalog `analytics.payment_method.<code>` with code fallback. No catalog exists yet, so fallback is what ships. Revisit when the catalog lands.
3. #16/#30 do not cap lists at the contract maxItems (centres 200, branches 50, departments 200). Real tenants stay far below these.
4. SQL is shape-tested only; no live-DB/RLS run (same as AN-T08).
