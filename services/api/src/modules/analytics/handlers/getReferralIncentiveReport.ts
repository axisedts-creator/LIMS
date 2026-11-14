// GET /v1/analytics/reports/referral-incentive (02-TRD §5 #8, §5.2; PRD US-07.1–.5; CR-C8-006; 07-SECURITY REQ-SEC-062/067).
// Order: assertRole (forbidden, then auth.mfa_required: the permission is privileged) -> tenant flag (common.feature_disabled) -> validate -> read -> access log.
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { toReferralIncentiveReportDto } from '../mappers/reports.dto.js';
import { REFERRAL_GROUP_BY, decodeCursor, pageOf, referralIncentive } from '../service/referral.service.js';
import { MAX_REFERRER_IDS, checkGroupBy, checkInt, checkUuidList } from '../service/reports.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

const FLAG = 'referralIncentiveReportEnabled';
type Audited = { audit: { access(e: object): Promise<void> }; ports: { IdentityPort: { getTenantSettings(ctx: unknown, i: { keys: string[] }): Promise<Record<string, unknown>> } } };

export const getReferralIncentiveReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.referral_report.read');
  const { audit, ports } = c as unknown as Audited;
  const settings = await ports.IdentityPort.getTenantSettings(c, { keys: [FLAG] });
  if (settings[FLAG] !== true) throw new LimsError('common.feature_disabled'); // C2 seed: off. Says nothing about the report.

  const q = queryOf(req);
  const groupBy = checkGroupBy(REFERRAL_GROUP_BY, q.group_by, 'referrer');
  const rollup = checkGroupBy(['canonical', 'none'] as const, q.rollup, 'canonical', 'rollup');
  const limit = checkInt(q.limit, 'limit', 1, 200, 50);
  const referrerIds = checkUuidList(q.referrer_id, 'referrer_id', MAX_REFERRER_IDS);
  const cursor = decodeCursor(q.cursor);
  const { period, scope, generatedAt } = await periodAndScope(c, q);

  const out = await referralIncentive(c, { period, scope, groupBy, rollup, referrerIds, now: generatedAt as never });
  const page = pageOf(out.rows, limit, cursor);
  // One entry per view, written on the request tx before the body leaves: a failed write fails the request (no un-logged view). No figures, names or ids.
  await audit.access({
    action: 'referral_report.view', entityType: 'analytics_report', outcome: 'allowed',
    detail: { report_code: 'referral_incentive', from: period.from, to: period.to, rows: page.rows.length },
  });
  return {
    status: 200,
    body: toReferralIncentiveReportDto({ period, scope, generatedAt }, { rows: page.rows, totals: out.totals, freshness: out.freshness, limit, nextCursor: page.nextCursor }),
  };
};
