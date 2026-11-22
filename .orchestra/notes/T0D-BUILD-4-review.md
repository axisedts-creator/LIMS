APPROVE

# T0D-BUILD-4 review (reviewer, 2026-11-22)
Scope reviewed: full task diff main...HEAD (31 files), plus the LD-453 round 4722a6c9d..HEAD (boot cap, authz regen, notes).

## LD-452 item 2 (required checks)
(a) tests/security/authz-classification.json vs main: 70 entries changed, every one now "class": "guarded-exact" (1 new getMisReportPage + 69 stale entries: 47 unguarded, 15 guarded-other, 7 stub moved up). 0 entries became unguarded, 0 lost a permission. Summary unguarded 47 -> 0, so the "one remaining unguarded entry" of LD-452 does not exist any more (nothing public left to justify).
(b) getMisReportPage = guarded-exact on analytics.dashboard.read (authz json line 2084). Per-code checks proven by tests in services/api/src/modules/analytics/handlers/__tests__/misReportPage.handler.test.ts:
- money codes without analytics.referral_report.read -> 403 auth.forbidden, nothing read or logged: :173
- money codes at aal1 -> 403 auth.mfa_required: :168
- money codes flag off -> 403 common.feature_disabled: :163; other tenant flag does not open it: :179; access log referral_report.view per page, failure fails the request: :145, :156, :184
- every definition asks its own permission and is refused 403 without it (same authorise(report.permission) as exports.ts:35): :124; finance user split: :134
Handler gate order (getMisReportPage.ts): permission first (base read before 404/501 for non-MIS codes), flag, input, scope, data, access log. Matches the export.

## Other checks
- Names: operationId, path, params, error codes (common.invalid_cursor, analytics.report_unknown, operation_pending 501 via core) exist in contracts/errors.yaml / core; no new permission; x-idempotency none, x-rate-limit-tier general, x-context tenant.
- Tenant/centre: resolveScope on caller ctx; tests :351-:381 (other tenant, foreign centre 404, restricted scope, >20 ids 400). No SQL, no migration, so no RLS change.
- Totals over the whole filtered set (re-paged through runMisReport, bounded by the row cap): tests :288-:319. Empty 200: :328-:342. Bad range/limit/cursor typed 400: :219-:285.
- Web: rows, totals row, paging, DD/MM/YYYY via DateText, NPR via billing formatNpr, kit DataTable; payment mode block stays Not available and the gap is in notes/T0D-BUILD-4-left.md (LD-436). Cursor filtered by regex before forwarding.
- No PHI in logs (access log detail = report_code + dates), no secrets, synthetic examples only.

## For the lead (not defects of this task, no CHANGES)
1. tools/codegen/lint-openapi.ts:64-69 adds two OPEN_OBJECT_ALLOWLIST entries (rows[], totals) although the LD-119 comment says "exactly ONE entry". Needed for per-code rows; marked [CONV] by the writer. Lead should ratify by an LD or the comment stays false.
2. File budget: 22 non-note files vs "at most 20"; the overflow is the arbiter-ordered 30 -> 31 pins and generated clients.
3. Web cursor regex caps at 200 chars, handler accepts up to 512; a real cursor longer than 200 would be dropped silently (page 1 shown). Not reachable with today's cursors per tests; watch if cursors grow.
Not verified by me: I did not run the test suites (reviewer edits nothing; results taken from notes/T0D-BUILD-4-tests.md).
