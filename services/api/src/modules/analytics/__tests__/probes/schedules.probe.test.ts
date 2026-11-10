// AN-T21 — P1 (#24-#29), P2 (listReportSchedules), P3 (schedule scope), P10 (report run visibility), P11 (foreign recipient -> 404), X3, over the AN-T16 emulator
// (handlers/__tests__/t16.helpers.ts + service/__tests__/schedulesFake.ts). Tenant B rows exist in every test.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import {
  A1, A2, B1, FOREIGN_MEMBER, LAB, LAB2, LAB3, LAB_A1, MEMBER, NOPERM, OWNER, OWNER2, OWNER_A1, TA, TB, callSch, expectLims, ifm, makeCtx16, okSch, scheduleBody, schedulesDb,
  seedSchedule, sid, uid,
} from '../../handlers/__tests__/t16.helpers.js';
import { extraPaths } from './spec.js';

vi.mock('../../repository/schedules.repo.js', async () => (await import('../../service/__tests__/schedulesFake.js')).schedulesRepoMock);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // first call pays the cold import of handlers/index
beforeEach(() => { schedulesDb.reset(); vi.clearAllMocks(); });

const B_SCHED = sid(90), B_RUN = uid(590);
function seedForeign() {
  schedulesDb.seedSchedule({ id: B_SCHED, tenant_id: TB, owner_membership_id: FOREIGN_MEMBER, name: 'Tenant B pack', next_run_at: '2026-11-07T01:15:00.000Z' }, [FOREIGN_MEMBER]);
  schedulesDb.seedRun({ id: B_RUN, tenant_id: TB, schedule_id: B_SCHED, slot_start: '2026-11-06T01:15:00.000Z' });
  schedulesDb.seedRunRecipient({ id: uid(591), tenant_id: TB, report_run_id: B_RUN, schedule_id: B_SCHED, membership_id: FOREIGN_MEMBER });
}
const leaks = (v: unknown) => JSON.stringify(v);

describe('P1 tenant B ids on the schedule operations -> 404 common.not_found, nothing of tenant B in the answer', () => {
  beforeEach(() => { seedSchedule(1, OWNER); seedForeign(); });

  it('getReportSchedule / updateReportSchedule / deactivateReportSchedule with a tenant B schedule id', async () => {
    const c = await makeCtx16(OWNER);
    await expectLims(callSch('getReportSchedule', c.ctx, { params: { schedule_id: B_SCHED } }), 'common.not_found', 404);
    await expectLims(callSch('updateReportSchedule', c.ctx, { params: { schedule_id: B_SCHED }, ifMatch: ifm(1), body: scheduleBody() }), 'common.not_found', 404);
    await expectLims(callSch('deactivateReportSchedule', c.ctx, { params: { schedule_id: B_SCHED }, ifMatch: ifm(1), body: {} }), 'common.not_found', 404);
    expect(schedulesDb.schedules.get(B_SCHED)!.is_active).toBe(true); // untouched
  });

  it('getReportRun with a tenant B run id', async () => {
    const e = await expectLims(callSch('getReportRun', (await makeCtx16(OWNER)).ctx, { params: { report_run_id: B_RUN } }), 'common.not_found', 404);
    expect(leaks({ m: e.message })).not.toContain('Tenant B');
  });

  it('P11 createReportSchedule: a tenant B membership as recipient (alone or mixed with a valid one) -> 404, no schedule row is written', async () => {
    const before = schedulesDb.schedules.size;
    for (const ids of [[FOREIGN_MEMBER], [MEMBER[LAB]!, FOREIGN_MEMBER], [FOREIGN_MEMBER, MEMBER[LAB]!]]) {
      await expectLims(callSch('createReportSchedule', (await makeCtx16(OWNER)).ctx, { body: scheduleBody({ recipient_membership_ids: ids }) }), 'common.not_found', 404);
    }
    expect(schedulesDb.schedules.size).toBe(before);
  });

  it('updateReportSchedule: a tenant B recipient on an own schedule -> 404, recipients unchanged', async () => {
    const c = await makeCtx16(OWNER);
    await expectLims(callSch('updateReportSchedule', c.ctx, { params: { schedule_id: sid(1) }, ifMatch: ifm(1), body: scheduleBody({ recipient_membership_ids: [MEMBER[LAB]!, FOREIGN_MEMBER] }) }), 'common.not_found', 404);
    expect(schedulesDb.recipients.size ? [...schedulesDb.recipients.values()].some((r: any) => r.membership_id === FOREIGN_MEMBER && r.tenant_id === TA) : false).toBe(false);
  });

  it('P1/P3 scope body: a tenant B centre (alone or mixed) in scope.centre_ids -> 404', async () => {
    for (const scope of [{ all_centres: false, centre_ids: [B1] }, { all_centres: false, centre_ids: [A1, B1] }]) {
      const e = await callSch('createReportSchedule', (await makeCtx16(OWNER)).ctx, { body: scheduleBody({ scope }) }).then(() => undefined, (x: unknown) => x);
      expect(isLimsError(e, 'common.not_found'), JSON.stringify(scope)).toBe(true);
    }
  });
});

describe('P2 listReportSchedules with tenant B data present returns zero tenant B rows', () => {
  it('across pages, for the owner and for a second manager', async () => {
    seedSchedule(1, OWNER); seedSchedule(2, OWNER); seedSchedule(3, OWNER2);
    seedForeign();
    schedulesDb.seedSchedule({ id: sid(91), tenant_id: TB, owner_membership_id: FOREIGN_MEMBER, name: 'Tenant B second' }, [FOREIGN_MEMBER]);
    for (const who of [OWNER, OWNER2]) {
      const c = await makeCtx16(who);
      const seen: any[] = []; let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const body = await okSch('listReportSchedules', c.ctx, { query: { limit: 1, ...(cursor ? { cursor } : {}) } });
        seen.push(...body.data); cursor = body.next_cursor ?? body.page?.next_cursor;
        expect(extraPaths('listReportSchedules', body), 'X3').toEqual([]);
        if (!cursor) break;
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(leaks(seen)).not.toMatch(/Tenant B|bb03/);
      expect(seen.map((s) => s.id)).not.toContain(B_SCHED);
      expect(seen.map((s) => s.id)).not.toContain(sid(91));
    }
  });
});

describe('P10 report run: non-recipient same-tenant user -> 404; recipient -> 200; owner -> 200 with the recipient list', () => {
  const RUN = uid(500);
  beforeEach(() => {
    seedSchedule(1, OWNER, [LAB, LAB2]);
    schedulesDb.seedRun({ id: RUN, tenant_id: TA, schedule_id: sid(1), slot_start: '2026-11-06T01:15:00.000Z', report_codes: ['income'], period_from: '2026-11-05', period_to: '2026-11-06' });
    [LAB, LAB2].forEach((k, i) => schedulesDb.seedRunRecipient({ id: uid(600 + i), tenant_id: TA, report_run_id: RUN, schedule_id: sid(1), membership_id: MEMBER[k]!, omitted_report_codes: [] }));
    seedForeign();
  });
  const get = async (who: string) => callSch('getReportRun', (await makeCtx16(who)).ctx, { params: { report_run_id: RUN } });
  it('non-recipient / non-owner with dashboard.read (LAB3, OWNER2, LAB restricted to A1 who is not a recipient) -> 404, not 403', async () => {
    for (const who of [LAB3, OWNER2, LAB_A1]) await expectLims(get(who), 'common.not_found', 404);
  });
  it('recipient -> 200 without the recipient list of the other recipients; owner -> 200', async () => {
    const r = await get(LAB);
    expect(r.status).toBe(200);
    expect(extraPaths('getReportRun', r.body)).toEqual([]);
    expect(leaks(r.body)).not.toContain(MEMBER[LAB2]!);   // a recipient never learns who else received it
    const o = await get(OWNER);
    expect(o.status).toBe(200);
    expect(extraPaths('getReportRun', o.body)).toEqual([]);
    expect(leaks(o.body)).toContain(MEMBER[LAB2]!);
    expect(leaks(o.body)).not.toContain(FOREIGN_MEMBER);
  });
  it('no analytics permission -> 403 before any read', async () => {
    await expectLims(get(NOPERM), 'auth.forbidden', 403);
    expect(schedulesDb.calls).toEqual([]);
  });
});

describe('P3 schedule scope of a centre-restricted manager', () => {
  it('an A1-only schedule manager cannot create a schedule for centre A2 (404) nor for all centres', async () => {
    const scoped = await makeCtx16(OWNER_A1);
    const e1 = await callSch('createReportSchedule', scoped.ctx, { body: scheduleBody({ scope: { all_centres: false, centre_ids: [A2] } }) }).then(() => undefined, (x: unknown) => x);
    expect(isLimsError(e1, 'common.not_found') || isLimsError(e1, 'auth.forbidden'), 'A2 accepted for an A1-only owner').toBe(true);
    const e2 = await callSch('createReportSchedule', (await makeCtx16(OWNER_A1)).ctx, { body: scheduleBody({ scope: { all_centres: true } }) }).then((r) => r, (x: unknown) => x);
    const widened = !(e2 instanceof Error) && (e2 as any)?.status === 201;
    expect(widened, 'an A1-only owner created an all-centres schedule').toBe(false);
  });
});
