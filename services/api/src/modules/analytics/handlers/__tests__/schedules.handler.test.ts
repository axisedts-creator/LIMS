// C8 AN-T16 — report schedules API: listReportSchedules #24, createReportSchedule #25, getReportSchedule #26, updateReportSchedule #27, deactivateReportSchedule #28.
// PRD US-18.1/18.3/18.6 (inputs), 02-TRD §5 #24–#28, §9.6 step 6 (name rules), §11 (cap); 05-SCHEMA §3/§4 (D-45: recipients deactivated, never deleted; re-add reactivates);
// 07-SECURITY S1, S3, P1, P2, P11, abuse cases 3/7; CR-C8-001/002 codes. Handlers/services are real; repository = ../../service/__tests__/schedulesFake.ts (seams pinned in its
// header and in ./t16.helpers.ts; the writer may dispute through the reviewer). Idempotency-Key handling belongs to the core and is not tested here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, ADMIN, B1, FOREIGN_MEMBER, LAB, LAB2, LAB3, FINANCE, LOCKED, MEMBER, NOPERM, OWNER, OWNER2, OWNER_A1, REVOKED, REPORTS, SCHEDMGR, TA, TB,
  callSch, contractErrors, expectLims, makeCtx16, okSch, rejection, scheduleBody, schedulesDb, schedulesRepoMock, seedSchedule, sid, uid,
} from './t16.helpers.js';

vi.mock('../../repository/schedules.repo.js', async () => (await import('../../service/__tests__/schedulesFake.js')).schedulesRepoMock);

beforeEach(() => { schedulesDb.reset(); vi.clearAllMocks(); });
afterEach(() => { delete process.env.LIMS_ANALYTICS_MAX_SCHEDULES_PER_TENANT; });

const create = (ctx: any, body: unknown = scheduleBody()) => callSch('createReportSchedule', ctx, { body });
const codeOf = async (p: Promise<unknown>) => ((await rejection(p)) as any)?.code as string;
const untouched = () => { expect(schedulesDb.schedules.size).toBe(0); expect(schedulesDb.recipients.size).toBe(0); };
const sorted = (xs: string[]) => [...xs].sort();
const writes = () => schedulesDb.calls.filter((c) => /^(insert|update|setRecipient|advance|finish)/.test(c.fn));

// ============================================================================================================== #25 create
describe('createReportSchedule — gate order (REQ-SEC-062)', () => {
  it.each([['no permission', NOPERM], ['lab_manager (dashboard.read only)', LAB], ['finance', FINANCE], ['owner with deactivated membership', REVOKED]])(
    '%s -> 403 auth.forbidden before anything is read or written', async (_n, who) => {
      const c = await makeCtx16(who);
      await expectLims(create(c.ctx), 'auth.forbidden', 403);
      untouched(); expect(schedulesDb.calls).toEqual([]);
      expect(c.touched.filter((t) => t.startsWith('core.membership'))).toEqual([]);
      expect(c.assertRole.mock.calls[0]![1]).toEqual({ permission: 'analytics.schedule.manage' });
    });

  it('a non-holder who also sends garbage still gets auth.forbidden (nothing is validated for strangers)', async () => {
    const c = await makeCtx16(NOPERM);
    await expectLims(create(c.ctx, { name: 42, extra: 1 }), 'auth.forbidden', 403);
  });
});

describe('createReportSchedule — happy path (US-18.1 input)', () => {
  it('201 ScheduleDto: contract-valid, version 1, active, owner = caller, next_run_at = next 07:00 Nepal time, recipients listed', async () => {
    const c = await makeCtx16(OWNER);
    const r = await callSch('createReportSchedule', c.ctx, { body: scheduleBody() });
    expect(r.status).toBe(201);
    expect(contractErrors('ScheduleDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({
      name: 'Daily MIS', report_codes: REPORTS, frequency: 'daily', send_time_local: '07:00', period_rule: 'previous_business_day', version: 1, is_active: true,
      owner_membership_id: MEMBER[OWNER], next_run_at: '2026-11-07T01:15:00.000Z',          // now = Fri 11:45 local, 07:00 already passed -> Saturday 07:00 local = 01:15Z
    });
    expect(r.body.scope.all_centres).toBe(true);
    expect(sorted(r.body.recipient_membership_ids)).toEqual(sorted([MEMBER[LAB]!, MEMBER[LAB2]!]));
    for (const k of ['tenant_id', 'created_by', 'updated_by', 'last_run_id']) expect(r.body).not.toHaveProperty(k);
  });

  it('stores the row (tenant, owner, created_by = actor id, quarter-hour time) and one ACTIVE recipient row per recipient', async () => {
    const c = await makeCtx16(OWNER);
    const body = await okSch('createReportSchedule', c.ctx, { body: scheduleBody() }, 201);
    const row = schedulesDb.schedules.get(body.id)!;
    expect(row).toMatchObject({ tenant_id: TA, owner_membership_id: MEMBER[OWNER], created_by: c.ctx.actor.id, send_time_local: '07:00', weekday: null, scope_all_centres: true, is_active: true, version: 1 });
    expect(row.scope_centre_ids).toEqual([]);
    const rec = schedulesDb.recipientsOf(body.id);
    expect(sorted(rec.map((x) => x.membership_id))).toEqual(sorted([MEMBER[LAB]!, MEMBER[LAB2]!]));
    expect(rec.every((x) => x.is_active && x.tenant_id === TA && x.created_by === c.ctx.actor.id)).toBe(true);
  });

  it('weekly + weekday and monthly frequencies get their own next_run_at (domain nextSlot)', async () => {
    const c = await makeCtx16(OWNER);
    const w = await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ frequency: 'weekly', weekday: 7, send_time_local: '08:30' }) }, 201);
    expect(w.next_run_at).toBe('2026-11-08T02:45:00.000Z');                               // Sunday 08:30 local
    expect(w.weekday).toBe(7);
    const m = await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ frequency: 'monthly_ad' }) }, 201);
    expect(m.next_run_at).toBe('2026-12-01T01:15:00.000Z');
    expect(m).not.toHaveProperty('weekday');
  });

  it('80-character name ok (US-18.1 label_text)', async () => {
    const c = await makeCtx16(OWNER);
    const r = await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ name: 'n'.repeat(80) }) }, 201);
    expect(r.name).toHaveLength(80);
  });

  it('a recipient that lacks a report-specific permission is accepted (the report is omitted for them at dispatch, US-18.6)', async () => {
    const c = await makeCtx16(OWNER);
    await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ report_codes: ['income', 'collections'], recipient_membership_ids: [MEMBER[LAB]!] }) }, 201);
  });
});

describe('createReportSchedule — name rules: 80 ok / 81 rejected / URLs, e-mail, phone-like rejected (07-SECURITY S3, 08 A5.4)', () => {
  it.each([
    ['81 characters', 'n'.repeat(81)], ['https://x', 'https://x'], ['HTTP://X', 'HTTP://X'], ['WWW.x', 'WWW.x'], ['www.lab.example', 'www.lab.example'],
    ['@ (e-mail)', 'a@b'], ['10-digit phone', '9800000000'], ['7-digit run', 'Ref 1234567'], ['empty', ''],
  ])('%s -> 400 common.validation_failed on the name; no row, no recipient', async (_l, name) => {
    const c = await makeCtx16(OWNER);
    const e: any = await expectLims(create(c.ctx, scheduleBody({ name })), 'common.validation_failed', 400);
    expect(e.errors?.some((x: any) => /name$/.test(x.path))).toBe(true);
    untouched();
  });

  it('a non-string name -> 400', async () => {
    const c = await makeCtx16(OWNER);
    await expectLims(create(c.ctx, scheduleBody({ name: 42 })), 'common.validation_failed', 400);
    untouched();
  });
});

describe('createReportSchedule — body validation (ScheduleInput)', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['weekly without weekday', { frequency: 'weekly' }],
    ['weekday on a daily schedule', { frequency: 'daily', weekday: 3 }],
    ['weekday 0', { frequency: 'weekly', weekday: 0 }],
    ['weekday 8', { frequency: 'weekly', weekday: 8 }],
    ['send_time 07:10 (not a quarter hour)', { send_time_local: '07:10' }],
    ['send_time 24:00', { send_time_local: '24:00' }],
    ['send_time 7:00', { send_time_local: '7:00' }],
    ['no recipients', { recipient_membership_ids: [] }],
    ['21 recipients', { recipient_membership_ids: Array.from({ length: 21 }, (_, i) => uid(100 + i)) }],
    ['no reports', { report_codes: [] }],
    ['11 reports', { report_codes: ['dashboard', 'income', 'department_income', 'collections', 'volume', 'top_referrers', 'top_centres', 'tests_done', 'tat', 'pending_tests', 'delivery'] }],
    ['unknown frequency', { frequency: 'hourly' }],
    ['unknown period_rule', { period_rule: 'last_week' }],
    ['not-all-centres scope without centres', { scope: { all_centres: false } }],
    ['not-all-centres scope with an empty list', { scope: { all_centres: false, centre_ids: [] } }],
    ['unknown extra property (owner_membership_id)', { owner_membership_id: MEMBER[LAB] }],
    ['non-uuid recipient', { recipient_membership_ids: ['not-a-uuid'] }],
    ['report that cannot be scheduled (interfaces)', { report_codes: ['interfaces'] }],
  ];
  it.each(bad)('%s -> 400 common.validation_failed; nothing written', async (_l, over) => {
    const c = await makeCtx16(OWNER);
    await expectLims(create(c.ctx, scheduleBody(over)), 'common.validation_failed', 400);
    untouched();
  });

  it.each([undefined, null, 'x', [], 7])('body %j -> 400', async (body) => {
    const c = await makeCtx16(OWNER);
    await expectLims(callSch('createReportSchedule', c.ctx, { body }), 'common.validation_failed', 400);   // not via create(): its default param would turn undefined into a valid body
    untouched();
  });

  it.each(['no_such_report', '__proto__', 'INCOME', 'constructor'])('unknown report code %j -> 404 analytics.report_unknown; nothing written', async (code) => {
    const c = await makeCtx16(OWNER);
    await expectLims(create(c.ctx, scheduleBody({ report_codes: ['income', code] })), 'analytics.report_unknown', 404);
    untouched();
  });
});

describe('createReportSchedule — recipients (07-SECURITY S1, P11)', () => {
  it.each([['finance user (no analytics.dashboard.read)', FINANCE], ['recipient with a deactivated membership', REVOKED], ['recipient with no permissions', NOPERM], ['locked recipient', LOCKED]])(
    '%s -> 422 analytics.recipient_ineligible; nothing written', async (_l, who) => {
      const c = await makeCtx16(OWNER);
      await expectLims(create(c.ctx, scheduleBody({ recipient_membership_ids: [MEMBER[LAB]!, MEMBER[who]!] })), 'analytics.recipient_ineligible', 422);
      untouched();
    });

  it('a membership of another tenant -> 404 common.not_found (composite FK probe); nothing written, no oracle for its existence', async () => {
    const c = await makeCtx16(OWNER);
    await expectLims(create(c.ctx, scheduleBody({ recipient_membership_ids: [MEMBER[LAB]!, FOREIGN_MEMBER] })), 'common.not_found', 404);
    await expectLims(create(c.ctx, scheduleBody({ recipient_membership_ids: [uid(999)] })), 'common.not_found', 404);   // unknown id: same answer
    untouched();
  });
});

describe('createReportSchedule — report permissions of the creator (abuse case 3, X1)', () => {
  it('referral_incentive without analytics.referral_report.read -> 403 auth.forbidden; nothing written', async () => {
    const c = await makeCtx16(ADMIN);
    await expectLims(create(c.ctx, scheduleBody({ report_codes: ['income', 'referral_incentive'] })), 'auth.forbidden', 403);
    untouched();
  });
  it('collections without analytics.collections.read -> 403 auth.forbidden', async () => {
    const c = await makeCtx16(SCHEDMGR);
    await expectLims(create(c.ctx, scheduleBody({ report_codes: ['collections'] })), 'auth.forbidden', 403);
    untouched();
  });
  it('the owner (all report permissions) may schedule both; the tenant admin may schedule collections', async () => {
    const o = await makeCtx16(OWNER);
    await okSch('createReportSchedule', o.ctx, { body: scheduleBody({ report_codes: ['income', 'referral_incentive', 'collections'] }) }, 201);
    const a = await makeCtx16(ADMIN);
    await okSch('createReportSchedule', a.ctx, { body: scheduleBody({ report_codes: ['collections'] }) }, 201);
  });
});

describe('createReportSchedule — scope (P1)', () => {
  it('a list of own centres is stored as a snapshot (not all_centres)', async () => {
    const c = await makeCtx16(OWNER);
    const r = await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ scope: { all_centres: false, centre_ids: [A1, A2] } }) }, 201);
    expect(r.scope.all_centres).toBe(false);
    expect(sorted(r.scope.centre_ids)).toEqual(sorted([A1, A2]));
    expect(schedulesDb.schedules.get(r.id)).toMatchObject({ scope_all_centres: false });
    expect(sorted(schedulesDb.schedules.get(r.id)!.scope_centre_ids)).toEqual(sorted([A1, A2]));
  });
  it('a centre of another tenant -> 404 common.not_found; nothing written', async () => {
    const c = await makeCtx16(OWNER);
    await expectLims(create(c.ctx, scheduleBody({ scope: { all_centres: false, centre_ids: [A1, B1] } })), 'common.not_found', 404);
    untouched();
  });
  it('a centre outside the caller\'s own scope -> 404 common.not_found; inside it -> 201', async () => {
    const c = await makeCtx16(OWNER_A1);
    await expectLims(create(c.ctx, scheduleBody({ scope: { all_centres: false, centre_ids: [A2] } })), 'common.not_found', 404);
    untouched();
    const r = await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ scope: { all_centres: false, centre_ids: [A1] } }) }, 201);
    expect(r.scope.centre_ids).toEqual([A1]);
  });
});

describe('createReportSchedule — per-tenant cap of active schedules (§11 LIMS_ANALYTICS_MAX_SCHEDULES_PER_TENANT = 20)', () => {
  const fill = (n: number, tenant = TA, active = true) => { for (let i = 0; i < n; i++) schedulesDb.seedSchedule({ id: uid(2000 + i + (active ? 0 : 500) + (tenant === TB ? 5000 : 0)), tenant_id: tenant, owner_membership_id: MEMBER[OWNER]!, is_active: active, next_run_at: active ? '2026-11-07T01:15:00.000Z' : null }, []); };

  it('the 21st active schedule -> 400 common.validation_failed with errors[0].path = \'\' (08 A13 P-1); nothing written', async () => {
    fill(20);
    const c = await makeCtx16(OWNER);
    const e: any = await expectLims(create(c.ctx), 'common.validation_failed', 400);
    expect(e.errors?.[0]?.path).toBe('');
    expect(schedulesDb.schedules.size).toBe(20);
    expect(writes()).toEqual([]);
  });

  it('the 20th is fine; deactivated schedules do not count; another tenant\'s schedules do not count', async () => {
    fill(19); fill(30, TA, false); fill(25, TB);
    const c = await makeCtx16(OWNER);
    await okSch('createReportSchedule', c.ctx, { body: scheduleBody() }, 201);
    await expectLims(create(c.ctx), 'common.validation_failed', 400);                    // now 20 active
  });

  it('the cap follows the env value', async () => {
    process.env.LIMS_ANALYTICS_MAX_SCHEDULES_PER_TENANT = '2';
    const c = await makeCtx16(OWNER);
    await okSch('createReportSchedule', c.ctx, { body: scheduleBody() }, 201);
    await okSch('createReportSchedule', c.ctx, { body: scheduleBody() }, 201);
    const e: any = await expectLims(create(c.ctx), 'common.validation_failed', 400);
    expect(e.errors?.[0]?.path).toBe('');
  });
});

describe('createReportSchedule — logs and metrics never carry the schedule name (07-SECURITY §7)', () => {
  it('no log line, metric label or audit entry contains the name or a recipient id', async () => {
    const c = await makeCtx16(OWNER);
    await okSch('createReportSchedule', c.ctx, { body: scheduleBody({ name: 'Zeta Secret Pack' }) }, 201);
    const seen = JSON.stringify([c.ctx.log.info.mock.calls, c.ctx.log.warn.mock.calls, c.ctx.log.error.mock.calls, c.ctx.metrics.inc.mock.calls, c.ctx.audit.access.mock.calls]);
    expect(seen).not.toContain('Zeta Secret Pack');
    expect(seen).not.toContain(MEMBER[LAB]!);
  });
});

// ============================================================================================================== #24 list
describe('listReportSchedules', () => {
  it.each([['lab_manager', LAB], ['no permission', NOPERM], ['finance', FINANCE]])('%s -> 403 auth.forbidden; nothing read', async (_n, who) => {
    const c = await makeCtx16(who);
    await expectLims(callSch('listReportSchedules', c.ctx), 'auth.forbidden', 403);
    expect(schedulesDb.calls).toEqual([]);
  });

  it('own tenant only (P2): tenant B rows never appear; each item is a contract-valid ScheduleDto with ACTIVE recipients only (D-45)', async () => {
    seedSchedule(1, OWNER, [LAB, LAB2]); seedSchedule(2, ADMIN, [LAB]);
    schedulesDb.seedSchedule({ id: sid(90), tenant_id: TB, owner_membership_id: FOREIGN_MEMBER, name: 'Tenant B pack', next_run_at: '2026-11-07T01:15:00.000Z' }, [FOREIGN_MEMBER]);
    schedulesDb.recipientsOf(sid(1)).find((r) => r.membership_id === MEMBER[LAB2])!.is_active = false;
    const c = await makeCtx16(OWNER);
    const body = await okSch('listReportSchedules', c.ctx);
    expect(body.data.map((s: any) => s.id).sort()).toEqual([sid(1), sid(2)].sort());
    expect(body.page.limit).toBe(20);
    for (const s of body.data) expect(contractErrors('ScheduleDto', s)).toEqual([]);
    expect(body.data.find((s: any) => s.id === sid(1)).recipient_membership_ids).toEqual([MEMBER[LAB]]);
    expect(JSON.stringify(body)).not.toContain('Tenant B pack');
  });

  it('is_active filter and keyset paging (limit 2 of 3, then the rest; no duplicates)', async () => {
    seedSchedule(1, OWNER); seedSchedule(2, OWNER); seedSchedule(3, OWNER); seedSchedule(4, OWNER, [LAB], { is_active: false, next_run_at: null });
    const c = await makeCtx16(OWNER);
    const inactive = await okSch('listReportSchedules', c.ctx, { query: { is_active: false } });
    expect(inactive.data.map((s: any) => s.id)).toEqual([sid(4)]);
    const p1 = await okSch('listReportSchedules', c.ctx, { query: { is_active: true, limit: 2 } });
    expect(p1.data).toHaveLength(2);
    expect(typeof p1.page.next_cursor).toBe('string');
    expect(p1.page.limit).toBe(2);
    const p2 = await okSch('listReportSchedules', c.ctx, { query: { is_active: true, limit: 2, cursor: p1.page.next_cursor } });
    expect(p2.data).toHaveLength(1);
    expect(p2.page.next_cursor).toBeUndefined();
    expect([...p1.data, ...p2.data].map((s: any) => s.id).sort()).toEqual([sid(1), sid(2), sid(3)].sort());
  });

  it.each([0, 51, -1, 'x'])('limit %j -> 400 common.validation_failed', async (limit) => {
    const c = await makeCtx16(OWNER);
    await expectLims(callSch('listReportSchedules', c.ctx, { query: { limit } }), 'common.validation_failed', 400);
  });
});

// ============================================================================================================== #26 get
describe('getReportSchedule', () => {
  it('lab_manager / no permission -> 403', async () => {
    seedSchedule(1, OWNER);
    for (const who of [LAB, NOPERM]) await expectLims(callSch('getReportSchedule', (await makeCtx16(who)).ctx, { params: { schedule_id: sid(1) } }), 'auth.forbidden', 403);
  });

  it('ScheduleDetailDto: the schedule + its last 20 runs, newest first; last_run = the newest', async () => {
    seedSchedule(1, OWNER);
    for (let i = 0; i < 25; i++) {
      const day = String(i + 1).padStart(2, '0');
      schedulesDb.seedRun({ id: uid(300 + i), tenant_id: TA, schedule_id: sid(1), slot_start: `2026-10-${day}T01:15:00.000Z`, period_from: `2026-09-${day}`, period_to: `2026-10-${day}` });
    }
    const c = await makeCtx16(OWNER);
    const r = await okSch('getReportSchedule', c.ctx, { params: { schedule_id: sid(1) } });
    expect(contractErrors('ScheduleDetailDto', r)).toEqual([]);
    expect(r.runs).toHaveLength(20);
    expect(r.runs[0].id).toBe(uid(324));
    expect(r.runs[19].id).toBe(uid(305));
    expect(r.last_run.id).toBe(uid(324));
    expect(r.runs[0].period).toMatchObject({ business_date_from: '2026-09-25', business_date_to: '2026-10-25', timezone: 'Asia/Kathmandu' });
    expect(r.id).toBe(sid(1));
  });

  it('a schedule without runs has no last_run and an empty runs list', async () => {
    seedSchedule(1, OWNER);
    const r = await okSch('getReportSchedule', (await makeCtx16(OWNER)).ctx, { params: { schedule_id: sid(1) } });
    expect(r.runs).toEqual([]);
    expect(r).not.toHaveProperty('last_run');
  });

  it('unknown id and another tenant\'s id -> the same 404 common.not_found (P1)', async () => {
    schedulesDb.seedSchedule({ id: sid(90), tenant_id: TB, owner_membership_id: FOREIGN_MEMBER }, [FOREIGN_MEMBER]);
    const c = await makeCtx16(OWNER);
    await expectLims(callSch('getReportSchedule', c.ctx, { params: { schedule_id: sid(90) } }), 'common.not_found', 404);
    await expectLims(callSch('getReportSchedule', c.ctx, { params: { schedule_id: sid(91) } }), 'common.not_found', 404);
  });
});

// ============================================================================================================== #27 update
describe('updateReportSchedule — preconditions', () => {
  const put = (ctx: any, over: Record<string, unknown> = {}, ifMatch: string | number | null = 1, id = sid(1)) =>
    callSch('updateReportSchedule', ctx, { params: { schedule_id: id }, body: scheduleBody(over), ifMatch });

  it('lab_manager / no permission -> 403 before the row is read', async () => {
    seedSchedule(1, OWNER);
    for (const who of [LAB, NOPERM]) { const c = await makeCtx16(who); await expectLims(put(c.ctx), 'auth.forbidden', 403); expect(schedulesDb.calls).toEqual([]); }
  });

  it('no If-Match -> 428 common.precondition_required; nothing written', async () => {
    seedSchedule(1, OWNER);
    await expectLims(put((await makeCtx16(OWNER)).ctx, {}, null), 'common.precondition_required', 428);
    expect(writes()).toEqual([]);
  });

  it.each(['abc', '1', '"0"', '"-1"', '"1.5"', '"99999999999"'])('malformed If-Match %s -> 400 common.validation_failed', async (h) => {
    seedSchedule(1, OWNER);
    await expectLims(put((await makeCtx16(OWNER)).ctx, {}, h), 'common.validation_failed', 400);
    expect(writes()).toEqual([]);
  });

  it('stale If-Match -> 409 common.version_conflict; schedule and recipients unchanged', async () => {
    seedSchedule(1, OWNER, [LAB, LAB2], { version: 2 });
    const before = structuredClone([...schedulesDb.schedules.values(), ...schedulesDb.recipients.values()]);
    await expectLims(put((await makeCtx16(OWNER)).ctx, { name: 'Changed' }, 1), 'common.version_conflict', 409);
    expect([...schedulesDb.schedules.values(), ...schedulesDb.recipients.values()]).toEqual(before);
  });

  it('the same If-Match twice: the first wins (version 2), the second is a 409', async () => {
    seedSchedule(1, OWNER);
    const c = await makeCtx16(OWNER);
    await okSch('updateReportSchedule', c.ctx, { params: { schedule_id: sid(1) }, body: scheduleBody({ name: 'First' }), ifMatch: 1 });
    await expectLims(put(c.ctx, { name: 'Second' }, 1), 'common.version_conflict', 409);
    expect(schedulesDb.schedules.get(sid(1))!.name).toBe('First');
  });

  it('another tenant\'s / unknown schedule -> 404 common.not_found even with a valid If-Match', async () => {
    schedulesDb.seedSchedule({ id: sid(90), tenant_id: TB, owner_membership_id: FOREIGN_MEMBER }, [FOREIGN_MEMBER]);
    const c = await makeCtx16(OWNER);
    await expectLims(put(c.ctx, {}, 1, sid(90)), 'common.not_found', 404);
    await expectLims(put(c.ctx, {}, 1, sid(91)), 'common.not_found', 404);
    expect(schedulesDb.schedules.get(sid(90))!.version).toBe(1);
  });
});

describe('updateReportSchedule — changes', () => {
  const put = (ctx: any, over: Record<string, unknown> = {}, ifMatch: number = 1) => callSch('updateReportSchedule', ctx, { params: { schedule_id: sid(1) }, body: scheduleBody(over), ifMatch });

  it('200 ScheduleDto with version + 1 and the new values; updated_by = actor; contract-valid', async () => {
    seedSchedule(1, OWNER);
    const c = await makeCtx16(OWNER);
    const r = await put(c.ctx, { name: 'Weekly MIS', report_codes: ['income'], period_rule: 'previous_7_days' });
    expect(r.status).toBe(200);
    expect(contractErrors('ScheduleDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: sid(1), version: 2, name: 'Weekly MIS', report_codes: ['income'], period_rule: 'previous_7_days', owner_membership_id: MEMBER[OWNER] });
    expect(schedulesDb.schedules.get(sid(1))).toMatchObject({ version: 2, updated_by: c.ctx.actor.id, owner_membership_id: MEMBER[OWNER] });
  });

  it('the owner cannot be changed through the body (owner_membership_id is not an input)', async () => {
    seedSchedule(1, OWNER);
    await expectLims(put((await makeCtx16(OWNER)).ctx, { owner_membership_id: MEMBER[LAB] }), 'common.validation_failed', 400);
  });

  it('name rules apply on update (81 chars, https://x, WWW.x) -> 400; the row is unchanged', async () => {
    seedSchedule(1, OWNER);
    const c = await makeCtx16(OWNER);
    for (const name of ['n'.repeat(81), 'https://x', 'WWW.x', 'a@b', '98000000000']) await expectLims(put(c.ctx, { name }), 'common.validation_failed', 400);
    expect(schedulesDb.schedules.get(sid(1))).toMatchObject({ name: 'Daily MIS', version: 1 });
  });

  it('changing the time recomputes next_run_at from now (09:15 already passed today -> tomorrow 09:15 local = 03:30Z); a rename alone keeps it', async () => {
    seedSchedule(1, OWNER);
    const c = await makeCtx16(OWNER);
    const renamed = (await put(c.ctx, { name: 'Renamed' })).body;
    expect(renamed.next_run_at).toBe('2026-11-07T01:15:00.000Z');
    const moved = (await put(c.ctx, { name: 'Renamed', send_time_local: '09:15' }, 2)).body;
    expect(moved.next_run_at).toBe('2026-11-07T03:30:00.000Z');
    const weekly = (await put(c.ctx, { frequency: 'weekly', weekday: 7, send_time_local: '08:30' }, 3)).body;
    expect(weekly.next_run_at).toBe('2026-11-08T02:45:00.000Z');
  });

  it('a recipient the update does not mention again is DEACTIVATED, never deleted (D-45): same row, is_active false, version bumped', async () => {
    seedSchedule(1, OWNER, [LAB, LAB2]);
    const before = schedulesDb.recipientsOf(sid(1)).find((r) => r.membership_id === MEMBER[LAB2])!;
    const c = await makeCtx16(OWNER);
    const r = (await put(c.ctx, { recipient_membership_ids: [MEMBER[LAB]!, MEMBER[LAB3]!] })).body;
    expect(sorted(r.recipient_membership_ids)).toEqual(sorted([MEMBER[LAB]!, MEMBER[LAB3]!]));      // active rows only
    const rows = schedulesDb.recipientsOf(sid(1));
    expect(rows).toHaveLength(3);                                                                     // nothing deleted
    expect(rows.find((x) => x.id === before.id)).toMatchObject({ membership_id: MEMBER[LAB2], is_active: false, version: before.version + 1 });
    expect(rows.find((x) => x.membership_id === MEMBER[LAB])).toMatchObject({ is_active: true, version: 1 });   // untouched
    expect(rows.find((x) => x.membership_id === MEMBER[LAB3])).toMatchObject({ is_active: true, version: 1 });  // inserted
  });

  it('removed then re-added -> the SAME row is reactivated (no second row, no duplicate-key error) (D-45)', async () => {
    seedSchedule(1, OWNER, [LAB, LAB2]);
    const lab2Row = schedulesDb.recipientsOf(sid(1)).find((r) => r.membership_id === MEMBER[LAB2])!;
    const c = await makeCtx16(OWNER);
    await put(c.ctx, { recipient_membership_ids: [MEMBER[LAB]!] }, 1);                               // LAB2 removed
    expect(schedulesDb.recipients.get(lab2Row.id)!.is_active).toBe(false);
    const r = (await put(c.ctx, { recipient_membership_ids: [MEMBER[LAB]!, MEMBER[LAB2]!] }, 2)).body;   // LAB2 re-added
    expect(sorted(r.recipient_membership_ids)).toEqual(sorted([MEMBER[LAB]!, MEMBER[LAB2]!]));
    const rows = schedulesDb.recipientsOf(sid(1));
    expect(rows).toHaveLength(2);
    expect(rows.filter((x) => x.membership_id === MEMBER[LAB2])).toHaveLength(1);
    expect(schedulesDb.recipients.get(lab2Row.id)).toMatchObject({ is_active: true, version: lab2Row.version + 2 });
    expect(schedulesRepoMock.insertRecipient).not.toHaveBeenCalled();
  });

  it('a NEW recipient is checked like at create: ineligible -> 422, foreign tenant -> 404; nothing changed', async () => {
    seedSchedule(1, OWNER, [LAB]);
    const c = await makeCtx16(OWNER);
    await expectLims(put(c.ctx, { recipient_membership_ids: [MEMBER[LAB]!, MEMBER[FINANCE]!] }), 'analytics.recipient_ineligible', 422);
    await expectLims(put(c.ctx, { recipient_membership_ids: [MEMBER[LAB]!, FOREIGN_MEMBER] }), 'common.not_found', 404);
    expect(schedulesDb.schedules.get(sid(1))!.version).toBe(1);
    expect(schedulesDb.recipientsOf(sid(1))).toHaveLength(1);
  });

  it('no recipients -> 400 (minimum 1)', async () => {
    seedSchedule(1, OWNER);
    await expectLims(put((await makeCtx16(OWNER)).ctx, { recipient_membership_ids: [] }), 'common.validation_failed', 400);
  });

  it('referral_incentive needs analytics.referral_report.read of the editor too (abuse case 3)', async () => {
    seedSchedule(1, ADMIN);
    await expectLims(put((await makeCtx16(ADMIN)).ctx, { report_codes: ['referral_incentive'] }), 'auth.forbidden', 403);
    expect(schedulesDb.schedules.get(sid(1))!.report_codes).toEqual(['income']);
  });

  it('a deactivated schedule is never silently revived: refused with a 4xx, or kept inactive without a next_run_at (schedules__next__ck)', async () => {
    seedSchedule(1, OWNER, [LAB], { is_active: false, next_run_at: null });
    const c = await makeCtx16(OWNER);
    let r: any; let e: any;
    try { r = await put(c.ctx, { name: 'Zombie' }); } catch (x) { e = x; }
    if (e) { expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500); }
    else { expect(r.status).toBe(200); expect(r.body.is_active).toBe(false); expect(r.body.next_run_at).toBeUndefined(); }
    expect(schedulesDb.schedules.get(sid(1))).toMatchObject({ is_active: false, next_run_at: null });
  });
});

// ============================================================================================================== #28 deactivate
describe('deactivateReportSchedule', () => {
  const deact = (ctx: any, ifMatch: string | number | null = 1, id = sid(1)) => callSch('deactivateReportSchedule', ctx, { params: { schedule_id: id }, body: {}, ifMatch });

  it('lab_manager / no permission -> 403 before the row is read', async () => {
    seedSchedule(1, OWNER);
    for (const who of [LAB, NOPERM]) { const c = await makeCtx16(who); await expectLims(deact(c.ctx), 'auth.forbidden', 403); expect(schedulesDb.calls).toEqual([]); }
  });

  it('no If-Match -> 428; stale -> 409; malformed -> 400; nothing written', async () => {
    seedSchedule(1, OWNER, [LAB], { version: 3 });
    const c = await makeCtx16(OWNER);
    await expectLims(deact(c.ctx, null), 'common.precondition_required', 428);
    await expectLims(deact(c.ctx, 2), 'common.version_conflict', 409);
    await expectLims(deact(c.ctx, 'abc'), 'common.validation_failed', 400);
    expect(schedulesDb.schedules.get(sid(1))).toMatchObject({ is_active: true, version: 3 });
  });

  it('200 ScheduleDto: inactive, version + 1, no next_run_at; the row and its recipient rows stay (never deleted)', async () => {
    seedSchedule(1, OWNER, [LAB, LAB2]);
    const c = await makeCtx16(OWNER);
    const r = await deact(c.ctx);
    expect(r.status).toBe(200);
    expect(contractErrors('ScheduleDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: sid(1), is_active: false, version: 2 });
    expect(r.body.next_run_at).toBeUndefined();
    expect(schedulesDb.schedules.get(sid(1))).toMatchObject({ is_active: false, next_run_at: null, version: 2, updated_by: c.ctx.actor.id });
    expect(schedulesDb.recipientsOf(sid(1))).toHaveLength(2);
  });

  it('frees a slot of the cap: with 20 active, deactivating one lets the next create through', async () => {
    for (let i = 1; i <= 20; i++) seedSchedule(i, OWNER, [LAB]);
    const c = await makeCtx16(OWNER);
    await expectLims(callSch('createReportSchedule', c.ctx, { body: scheduleBody() }), 'common.validation_failed', 400);
    await deact(c.ctx, 1, sid(7));
    await okSch('createReportSchedule', c.ctx, { body: scheduleBody() }, 201);
  });

  it('another tenant\'s / unknown schedule -> 404 common.not_found; the foreign row is untouched', async () => {
    schedulesDb.seedSchedule({ id: sid(90), tenant_id: TB, owner_membership_id: FOREIGN_MEMBER, next_run_at: '2026-11-07T01:15:00.000Z' }, []);
    const c = await makeCtx16(OWNER);
    await expectLims(deact(c.ctx, 1, sid(90)), 'common.not_found', 404);
    await expectLims(deact(c.ctx, 1, sid(91)), 'common.not_found', 404);
    expect(schedulesDb.schedules.get(sid(90))).toMatchObject({ is_active: true, version: 1 });
  });
});

// ============================================================================================================== adversarial: stored-data hygiene
describe('tenant isolation of every write (P1, P11)', () => {
  it('every repository call of a create carries the caller\'s tenant id, never one from the body', async () => {
    const c = await makeCtx16(OWNER);
    await okSch('createReportSchedule', c.ctx, { body: scheduleBody() }, 201);
    expect(schedulesDb.calls.length).toBeGreaterThan(0);
    for (const call of schedulesDb.calls) expect(call.args.tenantId, call.fn).toBe(TA);
  });
  it('a body naming tenant_id is refused (additionalProperties false)', async () => {
    const c = await makeCtx16(OWNER);
    await expectLims(create(c.ctx, scheduleBody({ tenant_id: TB })), 'common.validation_failed', 400);
    untouched();
  });
  it('OWNER2 (another owner of the tenant) can manage the schedules of others: schedule.manage is tenant-level, not per owner', async () => {
    seedSchedule(1, OWNER);
    const r = await okSch('getReportSchedule', (await makeCtx16(OWNER2)).ctx, { params: { schedule_id: sid(1) } });
    expect(r.owner_membership_id).toBe(MEMBER[OWNER]);
  });
});
