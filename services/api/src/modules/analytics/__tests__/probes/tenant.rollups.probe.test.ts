// AN-T21 — P1, P3, P4, P5, X3 over the rollup-backed operations of the AN-T14 world (income, department income, volume, top centres, collections, dashboard,
// pending summary): the world holds tenant B rows with SENTINEL values, NULL-centre rows and out-of-window rows (see handlers/__tests__/helpers.t14.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_A1 } from '../../handlers/__tests__/t09.helpers.js';
import {
  A1, A2, B1, BR1, BRB, DEPT, FINANCE, OWNER_A109, OWNER_ALL09, SENTINEL, WINDOW, makeCtx14, seedT14,
} from '../../handlers/__tests__/helpers.t14.js';
import { runReportBattery, type World } from './battery.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('../../handlers/__tests__/helpers.t14.js')).rollupsMock14);
vi.mock('../../repository/labels.repo.js', async () => (await import('../../handlers/__tests__/helpers.t14.js')).labelsRepoMock14);

const world: World = {
  name: 'rollups',
  seed: seedT14,
  makeCtx: (actor) => makeCtx14(actor),
  actorsFor: (o) => (o.permission === 'analytics.collections.read' ? { all: FINANCE, a1: FINANCE_A1 } : { all: OWNER_ALL09, a1: OWNER_A109 }),
  window: WINDOW,
  centres: { a1: A1, a2: A2, b: B1 },
  branches: { containsA1andA2: BR1, b: BRB },
  forbidden: [String(SENTINEL), B1, BRB, DEPT.FOREIGN, 'Tenant B Radiology'],
  foreignDepartment: DEPT.FOREIGN, homeDepartment: DEPT.H,
};

runReportBattery(world, ['getAnalyticsDashboard', 'getIncomeReport', 'getDepartmentIncomeReport', 'getVolumeReport', 'getTopCentresReport', 'getCollectionsReport']);

describe('P4 centre-restricted caller: rows without a centre (credit-party income, NULL-centre results / collections) are absent', () => {
  beforeEach(() => seedT14());
  it('dashboard of an A1-only owner is strictly below the all-centre figure and equals the A1 filter (the D2 NULL-centre income 2000 is not in it)', async () => {
    const { handlers } = await import('../../handlers/index.js');
    const get = async (actor: string, q: Record<string, unknown>) => {
      const { ctx } = await makeCtx14(actor); ctx.operationId = 'getAnalyticsDashboard';
      return JSON.stringify(((await (handlers as any).getAnalyticsDashboard({ params: {}, query: q, headers: {}, body: undefined }, ctx)).body), (k, v) => (k === 'scope' || k === 'generated_at' ? undefined : v));
    };
    const wide = await get(OWNER_ALL09, WINDOW), scoped = await get(OWNER_A109, WINDOW), a1 = await get(OWNER_ALL09, { ...WINDOW, centre_id: [A1] });
    expect(scoped).not.toBe(wide);
    expect(scoped).toBe(a1);
  });
  it('income report: the A1-only total excludes the NULL-centre invoice and the A2 invoice (D1 16000 + D2 10000 - credit 2000 = 24000)', async () => {
    const { handlers } = await import('../../handlers/index.js');
    const { ctx } = await makeCtx14(OWNER_A109); ctx.operationId = 'getIncomeReport';
    const r = await (handlers as any).getIncomeReport({ params: {}, query: { ...WINDOW }, headers: {}, body: undefined }, ctx);
    expect(r.body.totals.net_sales_paisa).toBe(24000);
    expect(JSON.stringify(r.body)).not.toContain(String(SENTINEL));
  });
});
