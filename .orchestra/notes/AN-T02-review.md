APPROVE

AN-T02 review (diff a3fe3b1..bdc20eb). Ran `.orchestra\notes\AN-T02-verify.cmd`: 7 files / 182 tests pass.

Checked against spec:
- Registry (02-TRD §3.3): 14 codes, permissions, families, live sources, schedulable (interfaces = no), flag `referralIncentiveReportEnabled` match verbatim; `net_billed_paisa` only in `referral_incentive` (D-44/B13); `SCHEDULE_REQUIRED_PERMISSION = analytics.dashboard.read` (08 A7.6); unknown → `analytics.report_unknown`.
- Families (§9.1) and event→family map (§8.2): all 16 families/tables and 12 events with specimen `to_status` rules match; snapshot sentinel `1970-01-01`.
- resolvePeriod (§4 steps 1–6): selector exclusivity, `bs_month`/`fiscal_year_bs`, `common.date_out_of_range`, `analytics.range_too_large`, previous period; 18:15 UTC boundary via fixed +05:45. All error codes exist in contracts/errors.yaml; permission names from contracts/permissions.yaml.
- Freshness (PRD US-16.1–3): three stale conditions and reasons verbatim; live sources never stale.
- csv: RFC 4180 quoting only, `neutraliseFormula` imported from shared-ts/spreadsheet, no local guard (P-9).
- Pure domain code: no SQL/RLS, no logging, no secrets, no PHI. Only analytics module paths + notes touched.

Non-blocking (for later tasks, not defects here):
- `exportColumns` are writer [CONV], not pinned by spec — confirm in the export task (AN build_export) before consumption.
- Dashboard collections tile needs `analytics.collections.read` in addition (§3.3); registry carries only the base permission — the dashboard service task must enforce it.
- Relative import of shared-ts (no `@lims/shared-ts` alias yet) — swap when the alias lands.
