// T0D-FIX-8 (LD-455; founder order 2026-11-22 22:06 NPT; evidence: getMisReportPage 400 'Invalid query.min_repeat_count', ref 854702454, /billing/bill-of-the-day).
// The contract (analytics.yaml, getMisReportPage) gives min_repeat_count schema default 2 (2..1000) and limit default 50, so the request validator adds them to EVERY request.
// The handler must drop min_repeat_count for a report that does not list it (before checkMisFilters), whatever its value; repeated_patient / repeated_test still validate it.
// Real handler over the T-15 emulators; only runMisReport is replaced (it applies the real checkMisFilters, as the real one does). Synthetic data, no database, no provider.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIS_REPORT_CODES, MIS_DEFS } from '../../domain/misReports.js';
import { DEFS, MONEY_CODES } from '../../__tests__/misreports/contract.js';
import { OWNER, db15, expectLims, makeCtx15, type Ctx15 } from './t15.helpers.js';

const H = vi.hoisted(() => ({ calls: [] as { code: string; args: any }[] }));
vi.mock('../../service/misReports.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../service/misReports.service.js')>();
  return {
    ...actual,
    runMisReport: vi.fn(async (_ctx: any, code: string, args: any) => {
      H.calls.push({ code, args });
      actual.checkMisFilters(code, args.filters); // the real service validates the filters it is given
      return { columns: [], rows: [] };
    }),
  };
});
beforeEach(() => { db15.reset(); vi.clearAllMocks(); H.calls.length = 0; });

// what the web sends for a one day report, plus what the contract validator adds (min_repeat_count=2, limit=50)
const WEB = { business_date_from: '2026-11-17', business_date_to: '2026-11-17' };
const VALIDATED = { ...WEB, min_repeat_count: 2, limit: 50 };
async function call(c: Ctx15, code: string, query: Record<string, unknown>) {
  const { handlers } = await import('../index.js');
  c.ctx.operationId = 'getMisReportPage';
  return (handlers as any).getMisReportPage({ params: { report_code: code }, query, headers: {}, body: undefined }, c.ctx);
}
const TAKES = ['repeated_patient', 'repeated_test'];
const NOT_TAKING: string[] = [...MIS_REPORT_CODES.filter((k) => !TAKES.includes(k)), ...MONEY_CODES];

describe('the contract lists exactly these report codes and exactly two take min_repeat_count', () => {
  it('every contract definition code is served; only repeated_patient and repeated_test list min_repeat_count', () => {
    for (const d of DEFS) if (!MONEY_CODES.includes(d.code as never)) expect(MIS_DEFS[d.code], d.code).toBeDefined();
    expect(MIS_REPORT_CODES.filter((k) => (MIS_DEFS[k]!.params as readonly string[]).includes('min_repeat_count')).sort()).toEqual(TAKES);
  });
});

describe('validator default min_repeat_count=2 (and limit=50) on every report code is accepted', () => {
  it.each([...MIS_REPORT_CODES, ...MONEY_CODES])('%s: dates + min_repeat_count=2 + limit=50 -> 200', async (code) => {
    const c = await makeCtx15(OWNER, { flag: true });
    const r = await call(c, code, VALIDATED);
    expect(r.status).toBe(200);
  });
  it.each(NOT_TAKING)('%s: min_repeat_count is dropped before the filters reach runMisReport', async (code) => {
    const c = await makeCtx15(OWNER, { flag: true });
    await call(c, code, VALIDATED);
    expect(H.calls.length).toBeGreaterThan(0);
    for (const x of H.calls) expect(x.args.filters, code).not.toHaveProperty('min_repeat_count');
  });
  it.each(NOT_TAKING)('%s: whatever the value (1, 1001, 7, "abc") it is ignored for a report that does not list it', async (code) => {
    for (const v of [1, 1001, 7, 'abc']) {
      const c = await makeCtx15(OWNER, { flag: true });
      const r = await call(c, code, { ...WEB, min_repeat_count: v });
      expect(r.status, `${code} ${String(v)}`).toBe(200);
    }
  });
});

describe('bill_of_the_day exactly as the web sends it (ref 854702454)', () => {
  it('only the two dates (the validator then adds the default) -> 200, no min_repeat_count in the filters', async () => {
    for (const q of [WEB, VALIDATED]) {
      const c = await makeCtx15(OWNER, { flag: true });
      const r = await call(c, 'bill_of_the_day', q);
      expect(r.status).toBe(200);
      expect(r.body).toHaveProperty('columns');
      expect(r.body).toHaveProperty('rows');
      expect(r.body).toHaveProperty('totals');
      for (const x of H.calls) expect(x.args.filters).not.toHaveProperty('min_repeat_count');
    }
  });
  it('a filter bill_of_the_day really does not list is still refused (the fix is not a loosening): visit_type -> 400', async () => {
    const c = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(c, 'bill_of_the_day', { ...VALIDATED, visit_type: 'opd' }), 'common.validation_failed', 400);
  });
});

describe('repeated_patient and repeated_test still validate min_repeat_count (2..1000)', () => {
  it.each(TAKES.flatMap((k) => [2, 5, 1000].map((v) => [k, v] as const)))('%s with %i -> 200 and the value reaches the report', async (code, v) => {
    const c = await makeCtx15(OWNER, { flag: true });
    const r = await call(c, code, { ...WEB, min_repeat_count: v });
    expect(r.status).toBe(200);
    expect(H.calls.at(-1)!.args.filters.min_repeat_count).toBe(v);
  });
  it.each(TAKES.flatMap((k) => [1, 1001, 0, -1, 2.5, 'two'].map((v) => [k, v] as const)))('%s with %j -> 400 common.validation_failed', async (code, v) => {
    const c = await makeCtx15(OWNER, { flag: true });
    await expectLims(call(c, code, { ...WEB, min_repeat_count: v }), 'common.validation_failed', 400);
    expect(H.calls).toEqual([]);
  });
  it.each(TAKES)('%s: the validator default 2 alone -> 200', async (code) => {
    const c = await makeCtx15(OWNER, { flag: true });
    expect((await call(c, code, VALIDATED)).status).toBe(200);
  });
});

describe('AUDIT of the shared MIS parameter list: the other defaults (limit=50) are accepted on every report', () => {
  it.each([...MIS_REPORT_CODES, ...MONEY_CODES])('%s: limit 50 -> 200 and runMisReport gets limit 50', async (code) => {
    const c = await makeCtx15(OWNER, { flag: true });
    expect((await call(c, code, { ...WEB, limit: 50 })).status).toBe(200);
    expect(H.calls.at(0)!.args.limit).toBe(50);
  });
});

describe('security: the gate order is unchanged by the fix', () => {
  it('a caller without the permission is refused 403 before min_repeat_count is looked at, nothing is read', async () => {
    const { NO_PERM } = await import('./t15.helpers.js');
    const c = await makeCtx15(NO_PERM, { flag: true });
    await expectLims(call(c, 'repeated_patient', { ...WEB, min_repeat_count: 'garbage' }), 'auth.forbidden', 403);
    expect(H.calls).toEqual([]);
  });
});
