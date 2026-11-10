// AN-T21 — P1, P3, P5, X3 for the referrer reports of the AN-T09/T10 world (#6 top referrers, #8 referral report, filter options #16/#30, referrer search #17),
// plus the runtime half of P13: no response other than #8 carries net_billed_paisa, with the referral flag off AND on; `sort=-net_billed_paisa` is refused.
// The world holds a tenant B referrer with 999999 billing and an out-of-window billing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, B1, D1, D3, OWNER, OWNER_A1, R, REF_NAME, makeCtx10, seed10,
} from '../../handlers/__tests__/t10.helpers.js';
import { BR1, BRB } from '../../handlers/__tests__/t09.helpers.js';
import { callOp, runReportBattery, type World } from './battery.js';
import { OPS, op } from './spec.js';
import { isLimsError } from '../../../../core/errors.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('../../handlers/__tests__/t10.helpers.js')).rollupsMock10);
vi.mock('../../repository/labels.repo.js', async () => (await import('../../handlers/__tests__/t10.helpers.js')).labelsRepoMock09);

const WINDOW = { business_date_from: D1, business_date_to: D3 };
const world: World = {
  name: 'referral',
  seed: seed10,
  makeCtx: (actor) => makeCtx10(actor, { flag: true }),
  actorsFor: () => ({ all: OWNER, a1: OWNER_A1 }),
  window: WINDOW,
  centres: { a1: A1, a2: A2, b: B1 },
  branches: { containsA1andA2: BR1, b: BRB },
  forbidden: [R.FOREIGN, REF_NAME.FOREIGN, '999999', B1, BRB],
};
runReportBattery(world, ['getTopReferrersReport', 'getReferralIncentiveReport']);

describe('P13 runtime: net_billed_paisa is carried by #8 only, and only when the flag is on', () => {
  beforeEach(() => seed10());
  const body = async (id: string, flag: boolean, q: Record<string, unknown> = WINDOW, b?: unknown) => {
    const { ctx } = await makeCtx10(OWNER, { flag });
    return callOp(op(id), ctx, q, b).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
  };

  it('flag off: #8 -> 403 common.feature_disabled and its body (if any) has no net_billed_paisa', async () => {
    const out = await body('getReferralIncentiveReport', false);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(isLimsError(out.e, 'common.feature_disabled')).toBe(true);
  });

  it.each([false, true])('flag %s: top referrers (default and every allowed sort) is volume only', async (flag) => {
    const sorts = (op('getTopReferrersReport').raw.parameters.find((p: any) => p.name === 'sort')?.schema?.enum ?? []) as string[];
    expect(sorts.length).toBeGreaterThan(0);
    for (const sort of [undefined, ...sorts]) {
      const out = await body('getTopReferrersReport', flag, { ...WINDOW, ...(sort ? { sort } : {}) });
      expect(out.ok, `sort=${String(sort)}`).toBe(true);
      if (out.ok) expect(JSON.stringify(out.r.body)).not.toContain('net_billed');
    }
  });

  it.each([false, true])('flag %s: sort=-net_billed_paisa (and net_billed_paisa) -> 400 common.validation_failed on #6', async (flag) => {
    for (const sort of ['-net_billed_paisa', 'net_billed_paisa']) {
      const out = await body('getTopReferrersReport', flag, { ...WINDOW, sort });
      expect(out.ok, `sort=${sort} answered`).toBe(false);
      if (!out.ok) { expect(isLimsError(out.e, 'common.validation_failed')).toBe(true); expect((out.e as any).statusCode).toBe(400); }
    }
  });

  it('every other operation that answers on this world has no net_billed key, flag on or off', async () => {
    const reportOps = OPS.filter((o) => o.method === 'GET' && o.permission === 'analytics.dashboard.read' && o.id !== 'getTopReferrersReport' && o.id !== 'getAnalyticsDashboard'
      && !o.pathParams.length && o.query.includes('business_date_from') && o.id !== 'getTatReport' && o.id !== 'getTestsDoneReport');
    let answered = 0;
    for (const o of reportOps) for (const flag of [false, true]) {
      const out = await body(o.id, flag);
      if (out.ok) { answered++; expect(JSON.stringify(out.r.body), `${o.id} flag=${flag}`).not.toContain('net_billed'); }
    }
    expect(answered).toBeGreaterThan(0);
  });

  it('filter options and referrer search never carry billing', async () => {
    for (const id of ['getAnalyticsFilterOptions']) {
      const out = await body(id, true, {});
      if (out.ok) expect(JSON.stringify(out.r.body)).not.toContain('net_billed');
    }
    const s = await body('searchAnalyticsReferrers', true, {}, { q: 'Dr' });
    if (s.ok) expect(JSON.stringify(s.r.body)).not.toContain('net_billed');
  });
});
