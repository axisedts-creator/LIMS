APPROVE
# AN-T10 review (reviewer) — diff cf6532bd..c145960b
- Gate order matches 02-TRD §342 / PRD US-07.1: assertRole(`analytics.referral_report.read`, privileged → aal2 via C2) → `getTenantSettings({keys:['referralIncentiveReportEnabled']})` → `common.feature_disabled` → validate → read → `ctx.audit.access({action:'referral_report.view', entityType:'analytics_report', outcome:'allowed', detail:{report_code, from, to, rows}})` (TRD §883, CR-C8-006 2-segment code). Refused requests read/log nothing.
- Names verbatim: operationId, route, params (group_by enum, rollup, referrer_id ≤ 20, limit 1–200 default 50, cursor), error codes, DTO keys match analytics.yaml:1112 / :4805 (additionalProperties:false; SELF row has no referrer_id / net_billed_paisa). `billed_note_key` = `analytics.referrers.billed_note`. Freshness families referrer_volume + referrer_billing (TRD §163).
- Isolation: every rollup read carries ctx.tenantId + checked scope (same WHERE/SCOPE_SQL as AN-T09); billing read from daily_referrer_billing only; no new tables/RLS in this task. x-idempotency none, tier general — no handler work needed.
- No PHI/money/ids in access detail or logs; no secrets; only C8-owned paths + own notes.
- CI script covers the 6 TRD §875 paths, case-insensitive content + file names, exit 2 on tool error; `__tests__` exclusion is required (the script and absence-asserting tests must contain the word) — acceptable [CONV].
- Ran: referral + no-commission + boot vitest → 206/206 pass; `tsc --noEmit` → no analytics errors.
- Not in scope here (later tasks): rejecting the report code for exports/schedules (US-07.1), nav hiding, UI title (US-07.5).
