// C8 AN-T11 — getTestsDoneReport (GET /v1/analytics/reports/tests-done). PRD US-09.1–3, M40–M47 (CR-C8-004: centre-scoped via daily_results.centre_id);
// 02-TRD §5 #9 / §5.1 TestsDoneReport / §6.5; 07-SECURITY P1, P4, REQ-SEC-017/081. Repos are in-memory emulators (./helpers.t11.ts);
// handler + service + mapper + labels.service are real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, BR1, BR2, BRB, BRANCH_NAME, DEPT, DEPT_NAME, NO_PERM, OWNER_A1, OWNER_ALL, OWNER_MULTI, ADMIN, D1, D2, TA, TEST, TEST_NAME, SENTINEL, WINDOW,
  call11, contractErrors11, db, expectLims, makeCtx11, ok11, seedT11, t11, R,
} from './helpers.t11.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t11.js')).rollupsMockT11);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t11.js')).labelsRepoMockT11);
vi.mock('../../repository/sourceViews.repo.js', async () => (await import('./helpers.t11.js')).sourceViewsMockT11);

const OP = 'getTestsDoneReport' as const;
const KEYS = ['results_resulted', 'results_verified', 'results_approved', 'results_amended', 'auto_verified', 'critical_count', 'abnormal_count', 'tests_approved'];
const v = (a: number[]) => Object.fromEntries(KEYS.map((k, i) => [k, a[i]]));   // [resulted, verified, approved, amended, auto, critical, abnormal, tests_approved]
const pick = (r: any) => Object.fromEntries(KEYS.map((k) => [k, r[k]]));
const byKey = (body: any) => Object.fromEntries(body.rows.map((r: any) => [r.key, r]));

// Hand-computed from seedT11(), window [D1, D3).
const TOTAL_ALL = v([26, 23, 21, 3, 3, 3, 6, 16]);   // includes the NULL-centre row [4,4,4,0,0,0,0,4]
const TOTAL_A1 = v([17, 14, 12, 3, 2, 3, 4, 9]);     // facts 1 + 3
const TOTAL_MULTI = v([22, 19, 17, 3, 3, 3, 6, 12]); // A1 + A2
const BY_DEPT = { [DEPT.H]: v([19, 17, 15, 1, 3, 1, 5, 11]), [DEPT.B]: v([7, 6, 6, 2, 0, 2, 1, 5]) };

beforeEach(() => { seedT11(); vi.clearAllMocks(); });

describe('US-09.1 — each count sits on the date of its own event; M40–M47', () => {
  it('group_by day: one row per business date with key = date; every one of the eight measures is an exact sum; D0/D3 and tenant B never leak', async () => {
    const { ctx } = await makeCtx11(ADMIN);
    const body = await ok11(OP, ctx, { ...WINDOW, group_by: 'day' });
    expect(body.report_code).toBe('tests_done');
    expect(body.rows.map((r: any) => r.key)).toEqual([D1, D2]);
    expect(pick(body.rows[0])).toEqual(v([15, 13, 11, 1, 3, 1, 5, 7]));
    expect(pick(body.rows[1])).toEqual(v([11, 10, 10, 2, 0, 2, 1, 9]));
    expect(body.totals).toEqual(TOTAL_ALL);
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
  });

  it('totals have exactly the eight measure keys and equal the column sums of the rows', async () => {
    const { ctx } = await makeCtx11(ADMIN);
    const body = await ok11(OP, ctx, WINDOW);
    expect(Object.keys(body.totals).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expect(body.totals[k], k).toBe(body.rows.reduce((s: number, r: any) => s + r[k], 0));
  });

  it('a window with no data → rows [], zero totals, contract-valid', async () => {
    const { ctx } = await makeCtx11(ADMIN);
    const body = await ok11(OP, ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    expect(body.rows).toEqual([]);
    expect(body.totals).toEqual(v([0, 0, 0, 0, 0, 0, 0, 0]));
    expect(contractErrors11(OP, body)).toEqual([]);
  });
});

describe('US-09.2 — group by department / test / processing branch, labels from the catalog', () => {
  it('department (default group_by): one row per department id with its catalog name', async () => {
    const { ctx } = await makeCtx11(ADMIN);
    const body = await ok11(OP, ctx, WINDOW);
    const r = byKey(body);
    expect(Object.keys(r).sort()).toEqual([DEPT.H, DEPT.B].sort());
    expect(r[DEPT.H].label).toContain(DEPT_NAME.H);
    expect(r[DEPT.B].label).toContain(DEPT_NAME.B);
    expect(pick(r[DEPT.H])).toEqual(BY_DEPT[DEPT.H]);
    expect(pick(r[DEPT.B])).toEqual(BY_DEPT[DEPT.B]);
  });

  it('test: labels from catalog.v_pub_test_directory (name present), a deactivated test keeps its row with is_inactive true', async () => {
    const { ctx } = await makeCtx11(ADMIN);
    const r = byKey(await ok11(OP, ctx, { ...WINDOW, group_by: 'test' }));
    expect(Object.keys(r).sort()).toEqual([TEST.CBC, TEST.GLU, TEST.OLD].sort());
    expect(r[TEST.CBC].label).toContain(TEST_NAME.CBC);
    expect(pick(r[TEST.CBC])).toEqual(v([14, 12, 10, 1, 2, 1, 3, 8]));
    expect(pick(r[TEST.GLU])).toEqual(v([5, 5, 5, 0, 1, 0, 2, 3]));
    expect(r[TEST.OLD].label).toContain(TEST_NAME.OLD);
    expect(r[TEST.OLD].is_inactive).toBe(true);
    expect(r[TEST.CBC].is_inactive ?? false).toBe(false);
  });

  it('processing_branch: one row per processing branch with the core branch name', async () => {
    const { ctx } = await makeCtx11(ADMIN);
    const r = byKey(await ok11(OP, ctx, { ...WINDOW, group_by: 'processing_branch' }));
    expect(pick(r[BR1])).toEqual(v([14, 12, 10, 1, 2, 1, 3, 8]));
    expect(pick(r[BR2])).toEqual(v([12, 11, 11, 2, 1, 2, 3, 8]));
    expect(r[BR1].label).toContain(BRANCH_NAME(BR1));
  });

  it('ad_month: key YYYY-MM; bs_month: key YYYY-MM of the B.S. month (one month here); both sum to the totals', async () => {
    const { ctx } = await makeCtx11(ADMIN);
    const ad = await ok11(OP, ctx, { ...WINDOW, group_by: 'ad_month' });
    expect(ad.rows).toHaveLength(1);
    expect(ad.rows[0].key).toBe('2026-11');
    expect(pick(ad.rows[0])).toEqual(TOTAL_ALL);
    const bs = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by: 'bs_month' });
    expect(bs.rows).toHaveLength(1);
    expect(bs.rows[0].key).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(pick(bs.rows[0])).toEqual(TOTAL_ALL);
  });

  it('a test / department id with no catalog row still gets a non-empty label ≤ 200 chars (never undefined)', async () => {
    t11.results.push(R(D1, A1, BR1, DEPT.UNKNOWN, TEST.FOREIGN, [1, 1, 1, 0, 0, 0, 0, 1]));
    const { ctx } = await makeCtx11(ADMIN);
    for (const group_by of ['department', 'test']) {
      const body = await ok11(OP, ctx, { ...WINDOW, group_by });
      for (const r of body.rows) { expect(typeof r.label).toBe('string'); expect(r.label.length).toBeGreaterThan(0); expect(r.label.length).toBeLessThanOrEqual(200); }
      expect(contractErrors11(OP, body)).toEqual([]);
    }
  });

  it('filters: department_id narrows rows and totals; processing_branch_id narrows too', async () => {
    const { ctx } = await makeCtx11(ADMIN);
    const d = await ok11(OP, ctx, { ...WINDOW, department_id: [DEPT.B] });
    expect(d.rows.map((r: any) => r.key)).toEqual([DEPT.B]);
    expect(d.totals).toEqual(BY_DEPT[DEPT.B]);
    const b = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, processing_branch_id: [BR2], group_by: 'processing_branch' });
    expect(b.rows.map((r: any) => r.key)).toEqual([BR2]);
    expect(b.totals).toEqual(v([12, 11, 11, 2, 1, 2, 3, 8]));
  });

  it('department_id of tenant B or unknown, processing_branch_id of tenant B → 404 common.not_found, nothing read', async () => {
    for (const q of [{ department_id: [DEPT.FOREIGN] }, { department_id: [DEPT.UNKNOWN] }, { department_id: [DEPT.H, DEPT.FOREIGN] }, { processing_branch_id: [BRB] }]) {
      await expectLims(call11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, ...q }), 'common.not_found', 404);
    }
    expect(db.calls).toEqual([]);
  });
});

describe('US-09.3 / CR-C8-004 / 07 P4 — centre scoping on results', () => {
  it('A1-only user: figures equal A1-only values; the NULL-centre row and A2 are absent; scope echo has empty tenant_wide_sections_hidden', async () => {
    const { ctx } = await makeCtx11(OWNER_A1);
    const body = await ok11(OP, ctx, WINDOW);
    expect(body.totals).toEqual(TOTAL_A1);
    expect(body.scope).toEqual({ all_centres: false, centre_ids: [A1], tenant_wide_sections_hidden: [] });
    expect(body.rows.map((r: any) => r.key).sort()).toEqual([DEPT.H, DEPT.B].sort());
    expect(contractErrors11(OP, body)).toEqual([]);
  });

  it('two-centre user sees exactly A1 + A2; all-centre users also get NULL-centre rows', async () => {
    expect((await ok11(OP, (await makeCtx11(OWNER_MULTI)).ctx, WINDOW)).totals).toEqual(TOTAL_MULTI);
    for (const who of [ADMIN, OWNER_ALL]) {
      const body = await ok11(OP, (await makeCtx11(who)).ctx, WINDOW);
      expect(body.totals, who).toEqual(TOTAL_ALL);
      expect(body.scope).toEqual({ all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] });
    }
  });

  it('the NULL-centre row alone: all-centre user sees it, A1-only user gets zeros', async () => {
    t11.results = t11.results.filter((f) => f.centreId === null && f.tenantId === TA);
    expect((await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW)).totals).toEqual(v([4, 4, 4, 0, 0, 0, 0, 4]));
    expect((await ok11(OP, (await makeCtx11(OWNER_A1)).ctx, WINDOW)).totals).toEqual(v([0, 0, 0, 0, 0, 0, 0, 0]));
  });

  it('scope handed to the repo is the effective scope with the ctx tenant on every call', async () => {
    const { ctx } = await makeCtx11(OWNER_A1);
    await ok11(OP, ctx, WINDOW);
    expect(db.calls.length).toBeGreaterThan(0);
    for (const c of db.calls) { expect(c.args.tenantId).toBe(ctx.tenantId); expect(c.args.scope).toEqual({ all: false, centreIds: [A1] }); }
  });

  it('many users at once: interleaved requests keep their own totals', async () => {
    const jobs = Array.from({ length: 20 }, async (_, i) => {
      const who = [ADMIN, OWNER_A1, OWNER_MULTI][i % 3]!;
      return { who, totals: (await ok11(OP, (await makeCtx11(who)).ctx, WINDOW)).totals };
    });
    const want: Record<string, unknown> = { [ADMIN]: TOTAL_ALL, [OWNER_A1]: TOTAL_A1, [OWNER_MULTI]: TOTAL_MULTI };
    for (const r of await Promise.all(jobs)) expect(r.totals, r.who).toEqual(want[r.who]);
  });
});

describe('response contract + errors', () => {
  it.each(['department', 'test', 'processing_branch', 'day', 'ad_month', 'bs_month'])('group_by=%s validates against the 200 schema (additionalProperties:false = allow-list)', async (group_by) => {
    const { ctx } = await makeCtx11(ADMIN);
    const body = await ok11(OP, ctx, { ...WINDOW, group_by });
    expect(contractErrors11(OP, body)).toEqual([]);
    expect(body.rows.length).toBeGreaterThan(0);
  });

  it.each(['branch', 'centre', '', 'day; DROP TABLE x'])('group_by %j → 400 common.validation_failed before any query', async (group_by) => {
    const { ctx } = await makeCtx11(ADMIN);
    await expectLims(call11(OP, ctx, { ...WINDOW, group_by }), 'common.validation_failed', 400);
    expect(db.calls).toEqual([]);
  });

  it('no analytics.dashboard.read → 403 before any read', async () => {
    const { ctx, touched } = await makeCtx11(NO_PERM);
    await expectLims(call11(OP, ctx, WINDOW), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('a dependency failure is propagated, never an empty 200', async () => {
    db.fail = new (await import('../../../../core/errors.js')).LimsError('common.dependency_unavailable');
    await expectLims(call11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW), 'common.dependency_unavailable', 503);
  });
});
