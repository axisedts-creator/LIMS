// T0D-FIX-8 (LD-455; founder order 2026-11-22 22:06 NPT; evidence: GET /v1/analytics/mis-reports/bill_of_the_day -> 400 'Invalid query.min_repeat_count', error reference 854702454).
// The contract (contracts/openapi/analytics.yaml, getMisReportPage) gives min_repeat_count the schema default 2, so the request validator adds min_repeat_count=2 (and limit=50)
// to EVERY request. The handler must drop min_repeat_count for a report that does not list it (before checkMisFilters), whatever the value; repeated_patient and repeated_test
// still validate it (2..1000). The contract is not edited. Real handler over the T-15 emulators; only the data seam (runMisReport) is replaced by an empty page. Synthetic, no provider.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFS, MONEY_CODES, def } from '../../__tests__/misreports/contract.js';
import { OWNER, TA, db15, expectLims, makeCtx15, rejection, type Ctx15 } from './t15.helpers.js';

const H = vi.hoisted(() => ({ calls: [] as { code: string; args: any }[] }));
vi.mock('../../service/misReports.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../service/misReports.service.js')>();
  return {
    ...actual,
    runMisReport: vi.fn(async (_ctx: any, code: string, args: any) => {
      H.calls.push({ code, args });
      const d = def(code);
      const kind: Record<string, string> = { string: 'text', date: 'text', datetime: 'text', integer: 'count', integer_paisa: 'paisa', basis_points: 'bp' };
      return { columns: d.columns.map((c) => ({ key: c.name, label: c.title, kind: kind[c.type] })), rows: [] };
    }),
  };
});

beforeEach(() => { db15.reset(); vi.clearAllMocks(); H.calls.length = 0; });

type Query = Record<string, unknown>;
/** The date params the web sends (one business day) ... */
const WEB: Query = { business_date_from: '2026-11-17', business_date_to: '2026-11-17' };
/** ... plus what the request validator adds from the contract defaults. */
const WITH_DEFAULTS: Query = { ...WEB, min_repeat_count: 2, limit: 50 };
const LISTS_MIN_REPEAT = DEFS.filter((d) => d.params.includes('min_repeat_count')).map((d) => d.code);
const NOT_LISTING = DEFS.filter((d) => !d.params.includes('min_repeat_count')).map((d) => d.code);

async function call(c: Ctx15, code: string, query: Query) {
  const { handlers } = await import('../index.js');
  c.ctx.operationId = 'getMisReportPage';
  return (handlers as any).getMisReportPage({ params: { report_code: code }, query, headers: {}, body: undefined }, c.ctx);
}
const lastFilters = () => H.calls.at(-1)!.args.filters as Record<string, unknown>;

describe('the fixture is read from the contract (guards against a vacuous test)', () => {
  it('11 reports; only repeated_patient and repeated_test list min_repeat_count', () => {
    expect(DEFS).toHaveLength(11);
    expect([...LISTS_MIN_REPEAT].sort()).toEqual(['repeated_patient', 'repeated_test']);
    expect(NOT_LISTING).toHaveLength(9);
    expect(NOT_LISTING).toContain('bill_of_the_day');
  });
});

describe('every report code accepts the page request with the validator default min_repeat_count=2 (and limit=50)', () => {
  it.each(DEFS.map((d) => d.code))('%s: dates + min_repeat_count=2 + limit=50 -> 200 with columns, rows, totals', async (code) => {
    const c = await makeCtx15(OWNER, { flag: true }); // flag on so the two money codes are served; the others ignore it
    const r = await call(c, code, WITH_DEFAULTS);
    expect(r.status).toBe(200);
    expect(r.body.columns.map((x: any) => x.key)).toEqual(def(code).columns.map((x) => x.name));
    expect(r.body.rows).toEqual([]);
    expect(H.calls, 'the report was really run').toHaveLength(1);
  });

  it.each(NOT_LISTING)('%s: the default is dropped, it never reaches the report as a filter', async (code) => {
    const c = await makeCtx15(OWNER, { flag: true });
    await call(c, code, WITH_DEFAULTS);
    expect(lastFilters()).not.toHaveProperty('min_repeat_count');
  });

  it.each(MONEY_CODES)('%s (money code): still one access entry per served page with the default present', async (code) => {
    const c = await makeCtx15(OWNER, { flag: true });
    const r = await call(c, code, WITH_DEFAULTS);
    expect(r.status).toBe(200);
    expect(c.entries.filter((e: any) => e.action === 'referral_report.view')).toHaveLength(1);
  });
});

describe('bill_of_the_day exactly as the web sends it (reference 854702454)', () => {
  it('dates only (no min_repeat_count at all) -> 200', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    expect((await call(c, 'bill_of_the_day', WEB)).status).toBe(200);
  });
  it('the same request after the validator added its defaults -> 200 (the failing live request)', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    expect((await call(c, 'bill_of_the_day', WITH_DEFAULTS)).status).toBe(200);
  });
  it('flag off (plain code needs none) -> 200 as well', async () => {
    const c = await makeCtx15(OWNER, {});
    expect((await call(c, 'bill_of_the_day', WITH_DEFAULTS)).status).toBe(200);
  });
  it.each([2, 5, 1, 1001, 0, -3, 'abc', '7'])('a report that does not list it ignores min_repeat_count=%j, whatever the value -> 200', async (v) => {
    for (const code of NOT_LISTING) {
      const c = await makeCtx15(OWNER, { flag: true });
      const r = await call(c, code, { ...WEB, min_repeat_count: v });
      expect(r.status, `${code} with ${JSON.stringify(v)}`).toBe(200);
      expect(lastFilters(), code).not.toHaveProperty('min_repeat_count');
    }
  });
  it('the other filters of bill_of_the_day are still validated next to the ignored default (party_id list, closed per report)', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const id = '01a1a98a-ac40-7000-8000-000000000201';
    await call(c, 'bill_of_the_day', { ...WITH_DEFAULTS, party_id: [id] });
    expect(lastFilters()).toEqual({ party_id: [id] });
    const d = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(d, 'bill_of_the_day', { ...WITH_DEFAULTS, visit_type: 'opd' }), 'common.validation_failed', 400); // visit_type is not listed by bill_of_the_day
    const e = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(e, 'bill_of_the_day', { ...WITH_DEFAULTS, party_id: ['not-a-uuid'] }), 'common.validation_failed', 400);
  });
});

describe.each(LISTS_MIN_REPEAT)('%s still validates min_repeat_count (2..1000)', (code) => {
  it.each([2, 5, 1000])('%j -> 200 and the value reaches the report', async (v) => {
    const c = await makeCtx15(OWNER, { flag: true });
    const r = await call(c, code, { ...WEB, min_repeat_count: v });
    expect(r.status).toBe(200);
    expect(lastFilters().min_repeat_count).toBe(v);
  });
  it('absent -> 200 (the report uses its own default of 2)', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    expect((await call(c, code, WEB)).status).toBe(200);
  });
  it.each([1, 1001, 0, -1, 1.5, 'two', null])('%j -> 400 common.validation_failed (same error as before the fix); the report is not run', async (v) => {
    const c = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(c, code, { ...WEB, min_repeat_count: v }), 'common.validation_failed', 400);
    expect(H.calls).toEqual([]);
    expect(c.accessRows).toEqual([]);
  });
  it('the error names the field min_repeat_count (the user can see which input is wrong)', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    const e: any = await rejection(call(c, code, { ...WEB, min_repeat_count: 1001 }));
    expect(e?.code).toBe('common.validation_failed');
    expect(JSON.stringify([e?.message, e?.errors, e?.details])).toMatch(/min_repeat_count/);
  });
});

describe('the fix does not weaken any other gate (adversarial)', () => {
  it('permission still comes first: a caller without it gets 403 whatever min_repeat_count says; nothing read', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    c.assertRole.mockImplementation(async () => { const { LimsError } = await import('../../../../core/errors.js'); throw new LimsError('auth.forbidden'); });
    await expectLims(call(c, 'bill_of_the_day', { ...WITH_DEFAULTS, min_repeat_count: 99999 }), 'auth.forbidden', 403);
    expect(H.calls).toEqual([]);
  });
  it('the tenant of the caller reaches the data seam (min_repeat_count cannot widen the scope)', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    await call(c, 'bill_of_the_day', { ...WITH_DEFAULTS, min_repeat_count: 1001 });
    expect(c.ctx.tenantId).toBe(TA);
    expect(H.calls.at(-1)!.args.scope).toEqual({ all: true, centreIds: expect.any(Array) });
  });
  it('the date range is still required and checked with the default present', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(c, 'bill_of_the_day', { min_repeat_count: 2, limit: 50 }), 'common.validation_failed', 400);
    const d = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(d, 'bill_of_the_day', { ...WITH_DEFAULTS, business_date_from: '2026-11-18' }), 'common.validation_failed', 400);
  });
  it('limit keeps its own 1..200 check next to the default', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(c, 'bill_of_the_day', { ...WITH_DEFAULTS, limit: 201 }), 'common.validation_failed', 400);
  });
  it('(3) audit of the shared parameter list: limit (default 50) is the only other schema default; every report accepts it', async () => {
    for (const d of DEFS) {
      const c = await makeCtx15(OWNER, { flag: true });
      expect((await call(c, d.code, { ...WEB, limit: 50 })).status, d.code).toBe(200);
    }
  });
});
