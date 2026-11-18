APPROVE
Range 382496e64..2a8140b19: only services/api/src/modules/analytics/__tests__/probes/contract.probe.test.ts (owned path) plus orchestra notes.
- Both edits match the arbiter ruling (T0B-MISREPORTS-2-ruling.md, LD-402) verbatim: owner list now [referral_incentive, two_level_commission], both flag referralIncentiveReportEnabled (A39-2a "no new flag"); allow-list adds service/misReports.service.ts with LD-402 comment.
- Order checked: reportRegistry.ts:69 referral_incentive precedes the MIS_ORDER spread at :81; flag applied via MONEY_REPORT_CODES at :83.
- Grep checked: non-test net_billed_paisa hits in analytics = 7 files, all in the allow-list; no other assertion loosened, lines 80-82 unchanged.
- No names invented, no PHI/secrets, no runtime code changed this pass.
- Not re-reviewed: earlier impl commits outside this range. Open (not a defect of this diff): A39-4 parent/sub party link, CR-C0-MISREPORTS2-001 item 1, stays with founder (LD-310/LD-402).
