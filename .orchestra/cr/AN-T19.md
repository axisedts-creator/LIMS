Title: CR-C8-AN-T19: source for the current B.S. month / fiscal year so report pages can offer the B.S. presets and the "This B.S. month" default
From chunk: C8            To owner: C0-0C (contracts/openapi/analytics.yaml) — or C0-0D if a shared B.S. calendar lib is the answer
Type: api
Blocking? no for AN-T19 delivery (pages ship with Today / Yesterday / This & Last A.D. month / Custom); yes for the 04-UI-UX §2 (:44) period default "This B.S. month" and the B.S.-month / fiscal-year presets.
Problem: 04-UI-UX.md:44 requires PeriodPicker presets This/Last B.S. month, This/Last fiscal year, default "This B.S. month" on report pages (US-03..US-14 period filter). The API accepts `bs_month` (YYYY-MM) and `fiscal_year_bs`, but nothing tells the web which B.S. month / fiscal year is current (or previous) in Nepal time. The UI must not convert B.S.<->A.D. itself (no calendar table on the client), so today the presets are omitted (apps/web/src/features/analytics/components/period.ts).
Proposed change (exact): additive, one of
 (a) every report envelope `period` (and `getAnalyticsFilterOptions` #29 / #30) gains optional `presets: { this_bs_month: string; last_bs_month: string; this_fy: string; last_fy: string }` (bs_month = `YYYY-MM`, fy = the `fiscal_year_bs` value the API accepts), computed server-side in Asia/Kathmandu; OR
 (b) the API accepts `preset=this_bs_month|last_bs_month|this_fy|last_fy` and resolves it server-side (response `period` already carries label_ad/label_bs/from/to for display).
Backward compatible? yes — new optional field / new optional enum param.
Tenant/security impact: none (no PHI, no new surface; whitelisted enum only).
IRD/regulatory impact: none (fiscal-year boundaries come from the existing server-side B.S. calendar).
Alternatives considered: client-side B.S. conversion table (rejected: duplicate calendar source, drift risk); default to This A.D. month (current stop-gap, deviates from 04-UI-UX:44).
Tests that will prove it: AN-T19 web — PeriodPicker offers the 4 B.S. presets, default request on a report page carries `bs_month=<this month>` (or `preset=this_bs_month`); API contract test for the new field/param.
