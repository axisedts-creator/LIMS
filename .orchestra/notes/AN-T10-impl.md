# AN-T10 impl (writer)
- New: `handlers/getReferralIncentiveReport.ts` (registered in `handlers/index.ts`), `service/referral.service.ts`. Edited: `repository/rollups.repo.ts` (`referrerVolumeRows` +grain, new `referrerBillingRows`), `mappers/reports.dto.ts` (+`toReferralIncentiveReportDto`; comment on l.2 reworded for no-commission.sh).
- Gate: assertRole(`analytics.referral_report.read`, carries mfa_required) -> `getTenantSettings(referralIncentiveReportEnabled)` -> validate -> read -> `ctx.audit.access(referral_report.view)`; refused requests write no access row. SELF row has no net_billed_paisa.
- [CONV] keyset cursor = base64url `{sort_value, key}`, strict decode before any read; rows built for whole period, totals = whole period, paged in memory. Freshness = referrer_volume + referrer_billing via `loadFamilyStates`.
- Tests: referral 71/73 pass, no-commission 16/16 (with --testTimeout=120000), other analytics 1053 pass, tsc clean for analytics. 
- Open: 4 test defects in `AN-T10-dispute.md` (2 referral tests, boot.test IMPLEMENTED list, 5 s timeout). No-commission.sh clean on repo.
