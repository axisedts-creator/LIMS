# C6-T21 impl (writer)
Files: `ports/ReportingPort.impl.ts` (createReportingPort({env}): getReleasedReports, issuePortalLink -> createPortalService, minimal openReleasedReportFile); `repository/released.repo.ts` (all SQL, so service/ports stay SQL-free).
Tests: T21 files 32/32 pass. Whole `modules/reporting`: 6 fail, none mine — `repository.static` (inline SQL in service/portal.service.ts, T20) and 5 `manifest.test.ts` 501-stub cases (T22 handlers not wired).
[CONV] Order `released_at, id` ascending (matches report_versions__tenant_id_released_at__p_idx); cursor = base64url(`<ISO>|<version id>`); limit default 50, max 200, >200 → common.validation_failed /limit (02-CV §4.3, review fix); version status released->valid, superseded->superseded.
[CONV] smartSummaryAvailable = smart_summary_id IS NOT NULL (DDL CHECK makes the three columns all-or-none, 08 A4.4) — avoids reading the JSON.
[CONV] partner/patient/centre scoping is RLS only; no app-side actor filter. Partner `partnerId` filter reads report_versions.partner_id (snapshot copy).
Open: openReleasedReportFile is minimal (T37 adds smartSummary, patient visible_from, redeemPortalLinkForApp). Port is not yet registered in `reporting/index.ts` (no wiring owner in T21's file list). Real PG/RLS and 50 ms budget untested here.
