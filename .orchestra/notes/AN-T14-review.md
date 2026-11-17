APPROVE

Reviewed `git diff d2c31f63..HEAD` (AN-T14) against 02-TRD §5 #1/#18/#19, §5.1 Tile/DashboardDto, §9.7, 05-SCHEMA §3 refresh_state policies, 08 A17 P-22, 06-PLAN row AN-T14.
- Names verbatim: operationIds, `analytics.dashboard.read`, `analytics.collections.read`, `common.rate_limited`, `analytics.refresh_tenant`, tile keys = §5.1 set exactly; `net_collected_paisa` omitted (not 403) without collections.read and the family is not read.
- Snapshot tiles (reports_pending, reports_ready_unreleased, pending_tests, pending_overdue) carry value+unit only; flow tiles carry previous/delta; delta_bp omitted when previous = 0 (§5.1).
- Throttle SQL = §9.7 verbatim (INSERT … ON CONFLICT (tenant_id, family) DO UPDATE … WHERE … RETURNING), only `_manual` row written by the user (matches `refresh_state__insert__tenant_manual` / `__update__tenant_manual`); no-row → 429 with Retry-After read in same tx (core errors.ts:124 sets header); body validated (400) before the slot is touched; marks before enqueue; `app.enqueue_job` 3-arg form → run_at = now() (wrapper coalesce), max_attempts from registry.
- Tenant isolation: every read bound to `ctx.tenantId`; backlog scope `$2::boolean OR centre_id = ANY($3::uuid[])`; live pending has no implicit centre predicate (D-49), explicit filter uses `::uuid[]`. No new migrations/policies in this diff.
- No logging, no PHI, no secrets; all code paths inside services/api/src/modules/analytics (C8-owned).
- Tests cover done_when/ACs: tiles/deltas/series/department_top/omission by permission/freshness (US-01, US-16), fresh-tenant 202 then 429, Retry-After countdown/boundaries, 10-parallel → one 202, perf smoke (p95 + read count flat in period length).

Run (2026-11-09 16:29): 4 AN-T14 files + boot.test.ts = 257 pass / 1 fail. The fail is boot.test.ts "mounts … 30 of 30" timing out at 30 s (36 s in the batch, 48 s alone on this loaded machine); writer's earlier isolated run passed 117/117. Environment timing, not a logic defect of this diff; flag for the tester if it reproduces on CI.
Not verified: real SQL against the real schema/RLS (no DB here), as the impl note states.
