APPROVE

C6-T37 review (diff 1e1a3bf0..ac3b44d0).
- redeemPortalLinkForApp matches 02-TRD §7.1 / 03-IC §4.7 + §13.3 (D-30): sha256(token) and sha256(phone) as 32-byte bytea -> app.reporting_redeem_link_for_app via ctx.tx; tenant_id = ctx.tenantId check; ctx.commitOnError() on every no-row/other-tenant result (A19 P-42); every failure identical reporting.link_invalid; impl writes nothing; return shape verbatim.
- openReleasedReportFile adds smartSummary from smart_summary_json only when non-NULL (08 A2.3); no SmartReportPort call; not_found stays indistinguishable.
- RLS (partner/patient policies with ::uuid[] cast, released-version EXISTS), qr_tokens policies, tg_portal_links_guard, DEFINER: present in C0 migration / db/policies/reporting.sql, not re-edited.
- Portal: .well-known files, /app/** fallbacks incl. /app/reports/[report_id] (portal.report_link_required) present; new /phlebo/[...slug] fallback data-free (D-38).
- No PHI/secret in logs or errors; paths are C6-owned (released.repo.ts + phlebo page outside brief file list but inside C6 ownership and required by the plan row).
- Ran: vitest t37+contract+read 61/61 pass; node --test C6-T37.static 7/7 pass. Real-DB RLS/DEFINER probes covered by C0 db tests, not run here.
