# C6-T37 impl
- services/api/src/modules/reporting/ports/ReportingPort.impl.ts: + redeemPortalLinkForApp (patient-only, sha256 token+phone -> DEFINER app.reporting_redeem_link_for_app via ctx.tx, tenant check, ctx.commitOnError() + one reporting.link_invalid on every failure); openReleasedReportFile now returns smartSummary (smart_summary_json snapshot, key absent when NULL, no SmartReportPort call).
- services/api/src/modules/reporting/repository/released.repo.ts: findReleasedVersionFile selects smart_summary_json (repo file outside brief list, minimal read-only column add) [CONV].
- apps/portal/src/app/phlebo/[...slug]/page.tsx: new data-free "/phlebo/*" fallback (portal.app_fallback, D-38). Well-known files + /app pages already satisfied tests, unchanged.
- [CONV] non-patient actor -> auth.forbidden; malformed token/phone -> reporting.link_invalid without reaching DEFINER; phone must match E.164 `^\+[1-9]\d{6,14}$`; token cap 4096 (LD-66).
- Results: vitest t37+contract+read 61/61 pass; node --test C6-T37.static 7/7 pass; tsc shows no errors in touched files.
- Open: pending.json (LD-70) — reporting module has none, nothing to remove. Patient visible_from stays C16's; RLS policies/DEFINER/guard are C0 migration (already present), not re-edited.
