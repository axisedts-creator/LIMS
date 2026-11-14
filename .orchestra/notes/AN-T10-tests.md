# AN-T10 tests (tester)
- `services/api/src/modules/analytics/handlers/__tests__/referral.handler.test.ts` (+ `t10.helpers.ts`): gate order forbidden > mfa_required > feature_disabled, body/SELF row/paging/validation/scope/isolation, access_log `referral_report.view`, no commission/payout keys.
- `services/api/src/modules/analytics/__tests__/ci/no-commission.test.ts`: runs `__tests__/ci/no-commission.sh` (created by tester, CR-C8-015) on real repo + scratch trees.
- Run: `.orchestra\notes\AN-T10-verify.cmd` (vitest via `pnpm --dir services/api`).
- Now: 71 referral tests fail (handler is AN-T01 stub -> common.internal); no-commission real-repo test fails: comment in `mappers/reports.dto.ts:2` contains the word -> writer must reword it.
- Writer seams (see t10.helpers.ts header): `rollups.repo.referrerVolumeRows` gains `grain` + `business_date`; new `rollups.repo.referrerBillingRows`; flag via `IdentityPort.getTenantSettings({keys:['referralIncentiveReportEnabled']})`; `ctx.audit.access({action:'referral_report.view',entityType:'analytics_report',outcome:'allowed',detail:{report_code,from,to,rows}})`.
- Register handler in `handlers/index.ts`; DTO must expose only contract keys (no spread).
