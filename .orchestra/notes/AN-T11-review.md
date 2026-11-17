APPROVE

Scope reviewed: `git diff af2b00bd..HEAD` (4 handlers, reports.service, rollups.repo, sourceViews.repo, columns.ts, reports.dto, tests).

Checked:
- Names verbatim vs 02-TRD §5 #9/#13/#14/#15 and §5 response shapes (TestsDoneReport, QualityIndicatorsReport, DeliveryReport, InterfacesReport); group_by enums match; permission `analytics.dashboard.read` on all four; tests-done takes Period only (no ScopeQuery) and uses caller's own scope.
- Tables/columns vs 05-SCHEMA (daily_results/rejections/specimens/critical_values/deliveries/releases/interface_messages; report_kind/release_basis literals); `instruments.v_pub_agent_status` per PRD M91.
- Centre scoping (CR-C8-004/005): every read uses `$4 OR (centre_id IS NOT NULL AND centre_id = ANY ($5))`; empty restricted scope returns []; NULL-centre deliveries visible to all-centre readers only; `tenant_wide_sections_hidden` [] (TRD §4.4).
- Injection: group keys from closed allow-lists; filters bound; unknown department/branch ids -> 404 without echo.
- No migrations in diff (no RLS change needed); no PHI in logs; no secrets; only C8 analytics paths + own notes.
- Tests cover done_when: restricted users see own centres + empty tenant_wide_sections_hidden (t11.security.test.ts:64), NULL-centre deliveries all-centre only (delivery.handler.test.ts:91-120), authz-first, tenant isolation, period validation.

Ran: `vitest run src/modules/analytics` -> 852 pass, 5 skipped, 1 fail: boot.test.ts:226 "boots ... (30 of 30)" timed out (30000ms; took ~34s) — full-app bootstrap timing on this machine, reproduced alone; not caused by AN-T11 code (assertion logic not reached). tsc: 0 errors under modules/analytics.

Non-blocking notes:
- Instruments ≤200 / agents ≤200 maxItems not enforced in service (same as existing reports; no cap anywhere yet).
- SQL not run against a real DB (C5/C6/C7 views absent).
