// T0B-MISREPORTS-1 done_when (3) "the row cap and the date cap return the standard validation error", (5) "permission denied cases ... schedule and export of each new
// report", LD-342 / A39-2 (gate of the two money reports: flag + analytics.referral_report.read + aal2 + access log action referral_report.view with the report code).
// Real handlers (createAnalyticsExport, createReportSchedule, updateReportSchedule) over the in-memory emulators of the T-15 / T-16 suites (handlers/__tests__/t15.helpers.ts,
// t16.helpers.ts); no database. Pinned picks (writer may dispute through the reviewer):
//   * business_date_to of the 11 MIS reports is INCLUSIVE (from == to = one day, 2026-10-01..2026-10-31 = a month); more than 366 inclusive days, or to < from -> 400 common.validation_failed.
//   * the export request of a money report writes, besides data.export, one access entry { action: 'referral_report.view', detail: { report_code } } (A39-2c); a refused request writes nothing.
//   * scheduling is not gated by the flag at creation (same as referral_incentive today); the run omits a flag-off money report for everyone (worker, not tested here).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import {
  OWNER as EXP_OWNER, OWNER_AAL1, db15, callExp, createBody, expectLims, makeCtx15, okExp, type Ctx15,
} from '../../handlers/__tests__/t15.helpers.js';
import {
  ADMIN, OWNER as SCH_OWNER, SCHEDMGR, callSch, ifm, makeCtx16, okSch, scheduleBody, schedulesDb, seedSchedule, sid,
} from '../../handlers/__tests__/t16.helpers.js';
import { DEFS, DELIVERED_CODES, MONEY_CODES, def } from './contract.js';

vi.mock('../../repository/schedules.repo.js', async () => (await import('../../service/__tests__/schedulesFake.js')).schedulesRepoMock);

beforeEach(() => { db15.reset(); schedulesDb.reset(); vi.clearAllMocks(); });

const SAFE_FILTERS = ['min_repeat_count', 'visit_type']; // filters that name no tenant id (ids are looked up and 404 when unknown to the fake tenant)
const paramsOf = (code: string, over: Record<string, unknown> = {}) => {
  const ex = def(code).example_params; const filters = Object.fromEntries(Object.entries(ex.filters ?? {}).filter(([k]) => SAFE_FILTERS.includes(k)));
  return { business_date_from: '2026-10-01', business_date_to: '2026-10-31', ...(Object.keys(filters).length ? { filters } : {}), ...over };
};
const body = (code: string, over: Record<string, unknown> = {}, format = 'csv') => createBody({ report_code: code, format, params: paramsOf(code, over) });
const create = (c: Ctx15, code: string, over: Record<string, unknown> = {}) => callExp('createAnalyticsExport', c.ctx, { body: body(code, over) });
const untouched = () => { expect(db15.exports.size).toBe(0); expect(db15.jobs).toEqual([]); expect(db15.log).toEqual([]); };
const denyOnly = (c: Ctx15, permission: string) => c.assertRole.mockImplementation(async (_c: unknown, rq: { permission: string }) => { if (rq.permission === permission) throw new LimsError('auth.forbidden'); });

describe('export request of each new report (createAnalyticsExport)', () => {
  it.each(DELIVERED_CODES)('%s: 202 queued for the holder (flag on), the request is stored with the code and the job is enqueued', async (code) => {
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    const r = await okExp('createAnalyticsExport', c.ctx, { body: body(code) }, 202);
    expect(r.body).toMatchObject({ report_code: code, format: 'csv', status: 'queued' });
    expect(db15.exports.get(r.body.id)!.report_code).toBe(code);
    expect(db15.jobs).toHaveLength(1);
    const asked = c.assertRole.mock.calls.map((x: any) => x[1].permission);
    expect(asked[0]).toBe('analytics.data.export');
    expect(asked).toContain(def(code).permission);
    expect(c.entries.filter((e: any) => e.action === 'data.export')).toHaveLength(1);
  });

  it.each(DELIVERED_CODES)('%s: csv and xlsx are accepted; pdf only behind its feature switch (unset -> 403 common.feature_disabled)', async (code) => {
    for (const format of ['csv', 'xlsx']) { db15.reset(); const c = await makeCtx15(EXP_OWNER, { flag: true }); await okExp('createAnalyticsExport', c.ctx, { body: body(code, {}, format) }, 202); }
    db15.reset();
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    await expectLims(callExp('createAnalyticsExport', c.ctx, { body: body(code, {}, 'pdf') }), 'common.feature_disabled', 403);
    untouched();
  });

  it.each(DELIVERED_CODES)('%s: without its report permission -> 403 auth.forbidden; no row, no job, no log', async (code) => {
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    denyOnly(c, def(code).permission);
    await expectLims(create(c, code), 'auth.forbidden', 403);
    untouched(); expect(c.entries).toEqual([]);
  });

  it.each(DELIVERED_CODES)('%s: a caller without analytics.data.export -> 403 before anything is read', async (code) => {
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    denyOnly(c, 'analytics.data.export');
    await expectLims(create(c, code), 'auth.forbidden', 403);
    untouched();
  });

  it.each(DELIVERED_CODES)('%s: flag off does not matter and no referral_report.view entry is written (not a gated report)', async (code) => {
    const c = await makeCtx15(EXP_OWNER, {});
    await okExp('createAnalyticsExport', c.ctx, { body: body(code) }, 202);
    expect(c.entries.filter((e: any) => e.action === 'referral_report.view')).toEqual([]);
  });
});

describe('T0B-MISREPORTS-2 money codes (A39-2, LD-346): two_level_commission and tds are no longer pending; gate = flag + analytics.referral_report.read at aal2 + access log', () => {
  // The cases of T0B-MISREPORTS-1 that expected 501 operation_pending are REPLACED (done_when 1: the codes leave the pending list); the gate cases of
  // .orchestra/notes/T0B-MISREPORTS-2-moved-tests.md are re-added verbatim below. Pinned: a refused request writes nothing; the order is permissions (403 auth.forbidden,
  // then aal1 -> auth.mfa_required) before the flag (common.feature_disabled); nobody is exempt from the flag.
  it.each(MONEY_CODES)('%s: holder at aal2 with the flag on -> 202 queued, request stored with the code, one job, data.export logged once', async (code) => {
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    const r = await okExp('createAnalyticsExport', c.ctx, { body: body(code) }, 202);
    expect(r.body).toMatchObject({ report_code: code, format: 'csv', status: 'queued' });
    expect(db15.exports.get(r.body.id)!.report_code).toBe(code);
    expect(db15.jobs).toHaveLength(1);
    const asked = c.assertRole.mock.calls.map((x: any) => x[1].permission);
    expect(asked[0]).toBe('analytics.data.export'); expect(asked).toContain('analytics.referral_report.read');
    expect(c.entries.filter((e: any) => e.action === 'data.export')).toHaveLength(1);
  });
  it.each(MONEY_CODES)('%s: csv and xlsx are accepted; pdf only behind its own switch', async (code) => {
    for (const format of ['csv', 'xlsx']) { db15.reset(); const c = await makeCtx15(EXP_OWNER, { flag: true }); await okExp('createAnalyticsExport', c.ctx, { body: body(code, {}, format) }, 202); }
    db15.reset();
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    await expectLims(callExp('createAnalyticsExport', c.ctx, { body: body(code, {}, 'pdf') }), 'common.feature_disabled', 403);
    untouched();
  });
  it.each(MONEY_CODES)('%s: without analytics.referral_report.read -> 403 auth.forbidden; no row, no job, no log (flag on)', async (code) => {
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    denyOnly(c, 'analytics.referral_report.read');
    await expectLims(create(c, code), 'auth.forbidden', 403);
    untouched(); expect(c.entries).toEqual([]);
  });
  it.each(MONEY_CODES)('%s: a caller without analytics.data.export -> 403 before anything is read', async (code) => {
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    denyOnly(c, 'analytics.data.export');
    await expectLims(create(c, code), 'auth.forbidden', 403);
    untouched();
  });
  it.each(MONEY_CODES)('%s: flag off (default, or false) -> 403 common.feature_disabled; no row, no job, no log; nobody is exempt', async (code) => {
    for (const flag of [undefined, false]) {
      db15.reset();
      const c = await makeCtx15(EXP_OWNER, flag === undefined ? {} : { flag });
      await expectLims(create(c, code), 'common.feature_disabled', 403);
      untouched(); expect(c.entries).toEqual([]);
    }
  });
  it.each(MONEY_CODES)('%s: holder at aal1 -> 403 auth.mfa_required; nothing written (flag on or off)', async (code) => {
    for (const flag of [undefined, true]) {
      db15.reset();
      const c = await makeCtx15(OWNER_AAL1, flag === undefined ? {} : { flag });
      await expectLims(create(c, code), 'auth.mfa_required', 403);
      untouched(); expect(c.entries).toEqual([]);
    }
  });
  it.each(MONEY_CODES)('%s: the access log gets referral_report.view with the report code (A39-2c), once, next to data.export', async (code) => {
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    await okExp('createAnalyticsExport', c.ctx, { body: body(code) }, 202);
    const views = c.entries.filter((e: any) => e.action === 'referral_report.view');
    expect(views).toHaveLength(1);
    expect(views[0].detail).toMatchObject({ report_code: code });
    expect(JSON.stringify(c.entries)).not.toMatch(/commission_paisa|tds_withheld/); // ids, codes, dates only (E4): never an amount
  });
  it.each(MONEY_CODES)('%s: date cap and hostile params use the standard validation error; no row, no job (flag on)', async (code) => {
    for (const p of [{ business_date_from: '2024-01-01', business_date_to: '2025-01-01' }, { business_date_from: '2026-10-05', business_date_to: '2026-10-04' }]) {
      db15.reset();
      const c = await makeCtx15(EXP_OWNER, { flag: true });
      await expectLims(create(c, code, p), 'common.validation_failed', 400);
      untouched();
    }
    const c = await makeCtx15(EXP_OWNER, { flag: true });
    await expectLims(callExp('createAnalyticsExport', c.ctx, { body: createBody({ report_code: code, format: 'csv', params: { ...paramsOf(code), filters: { no_such_filter: ['x'] } } }) }), 'common.validation_failed', 400);
    untouched();
  });
  it.each(MONEY_CODES)('%s: the owner (aal2, referral_report.read, schedule.manage) may schedule it -> 201 with the code kept (scheduling itself is not gated by the flag; the run omits it, see the worker note)', async (code) => {
    const c = await makeCtx16(SCH_OWNER);
    const r = await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ report_codes: [code] }) }, 201);
    expect(r.report_codes).toEqual([code]);
  });
  it.each(MONEY_CODES)('%s: the tenant admin (no analytics.referral_report.read) cannot schedule it, at create or at update; the stored schedule is unchanged', async (code) => {
    const c = await makeCtx16(ADMIN);
    await expectLims(callSch('createReportSchedule', c.ctx, { body: scheduleBody({ report_codes: ['income', code] }) }), 'auth.forbidden', 403);
    expect(schedulesDb.schedules.size).toBe(0);
    seedSchedule(1, ADMIN);
    await expectLims(callSch('updateReportSchedule', (await makeCtx16(ADMIN)).ctx, { params: { schedule_id: sid(1) }, body: scheduleBody({ report_codes: [code] }), ifMatch: ifm(1) }), 'auth.forbidden', 403);
    expect(schedulesDb.schedules.get(sid(1))!.report_codes).toEqual(['income']);
  });
  it.each(MONEY_CODES)('%s: a schedule manager without the privileged permission (dashboard.read only) -> 403 auth.forbidden; nothing written', async (code) => {
    const c = await makeCtx16(SCHEDMGR);
    await expectLims(callSch('createReportSchedule', c.ctx, { body: scheduleBody({ report_codes: ['income', code] }) }), 'auth.forbidden', 403);
    expect(schedulesDb.schedules.size).toBe(0);
  });
  it('a plain report (income) never writes referral_report.view and never needs the flag (the gate is for the two codes only)', async () => {
    const c = await makeCtx15(EXP_OWNER, {});
    await okExp('createAnalyticsExport', c.ctx, { body: createBody({ report_code: 'income', format: 'csv' }) }, 202);
    expect(c.entries.filter((e: any) => e.action === 'referral_report.view')).toEqual([]);
  });
});

describe('date cap and params (done_when 3): the standard validation error', () => {
  it.each(DELIVERED_CODES)('%s: one day (from == to) and a full 366 day span are accepted', async (code) => {
    for (const p of [{ business_date_from: '2026-10-05', business_date_to: '2026-10-05' }, { business_date_from: '2024-01-01', business_date_to: '2024-12-31' }]) {
      db15.reset();
      const c = await makeCtx15(EXP_OWNER, { flag: true });
      await okExp('createAnalyticsExport', c.ctx, { body: body(code, p) }, 202);
    }
  });
  it.each(DELIVERED_CODES)('%s: 367 days, to before from, a bad date and a missing end -> 400 common.validation_failed; no row, no job', async (code) => {
    for (const p of [{ business_date_from: '2024-01-01', business_date_to: '2025-01-01' }, { business_date_from: '2026-10-05', business_date_to: '2026-10-04' },
      { business_date_from: '2026-13-40', business_date_to: '2026-10-04' }, { business_date_from: '2026-10-05', business_date_to: undefined }]) {
      db15.reset();
      const c = await makeCtx15(EXP_OWNER, { flag: true });
      await expectLims(create(c, code, p), 'common.validation_failed', 400);
      untouched();
    }
  });
  it.each(DELIVERED_CODES)('%s: an unknown filter key and a hostile value -> 400 common.validation_failed', async (code) => {
    for (const filters of [{ no_such_filter: ['x'] }, { party_id: ["'; DROP TABLE billing.invoices; --"] }, { min_repeat_count: -1 }, { min_repeat_count: 'two' }, { visit_type: 'icu' }]) {
      db15.reset();
      const c = await makeCtx15(EXP_OWNER, { flag: true });
      await expectLims(callExp('createAnalyticsExport', c.ctx, { body: createBody({ report_code: code, format: 'csv', params: { ...paramsOf(code), filters } }) }), 'common.validation_failed', 400);
      untouched();
    }
  });
});

describe('schedule of each new report (createReportSchedule / updateReportSchedule)', () => {
  it.each(DELIVERED_CODES)('%s: the owner (every analytics permission) may schedule it -> 201 with the code kept', async (code) => {
    const c = await makeCtx16(SCH_OWNER);
    const r = await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ report_codes: [code] }) }, 201);
    expect(r.report_codes).toEqual([code]);
  });
  it.each(DEFS.filter((d) => d.permission !== 'analytics.dashboard.read' && DELIVERED_CODES.includes(d.code)).map((d) => d.code))(
    '%s: a schedule manager without its report permission (dashboard.read only) -> 403 auth.forbidden; nothing written', async (code) => {
      const c = await makeCtx16(SCHEDMGR);
      await expectLims(callSch('createReportSchedule', c.ctx, { body: scheduleBody({ report_codes: ['income', code] }) }), 'auth.forbidden', 403);
      expect(schedulesDb.schedules.size).toBe(0);
    });
  it.each(['bill_of_the_day', 'collection_boy', 'party_billing'])('%s: the tenant admin (collections.read) may schedule it', async (code) => {
    const c = await makeCtx16(ADMIN);
    await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ report_codes: [code] }) }, 201);
  });
  it('a pack of every plain new report plus an old one is one schedule (limit of the field unchanged)', async () => {
    const c = await makeCtx16(SCH_OWNER);
    const codes = ['income', ...DELIVERED_CODES.slice(0, 5)];
    const r = await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ report_codes: codes }) }, 201);
    expect(r.report_codes).toEqual(codes);
  });
});
