// C8 AN-T16 — getReportRun #29 (GET /report-runs/{report_run_id}); PRD US-18.4 + US-18.6 (viewer omissions), 02-TRD §5 #29 + ReportRunDto notes, 05-SCHEMA §3 (report_runs /
// report_run_recipients visibility: system, recipients of the run, the schedule owner), 07-SECURITY P10 (non-recipient same-tenant -> 404; recipient -> 200; owner -> 200 with the
// recipient list), S4, REQ-SEC-098 (link carries only a UUID), CR-C8-008. Seams: ./t16.helpers.ts + ../../service/__tests__/schedulesFake.ts (RLS of the run tables emulated from
// ctx.tx.membershipId). The figures themselves are computed at open time by the web page from the report endpoints (viewer scope ∩ schedule scope) — #29 returns metadata only.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, FINANCE, FOREIGN_MEMBER, LAB, LAB2, LAB3, LAB_A1, MEMBER, NOPERM, OWNER, OWNER2, OWNER_A1, TA, TB,
  callSch, contractErrors, expectLims, makeCtx16, schedulesDb, seedSchedule, sid, uid,
} from './t16.helpers.js';

vi.mock('../../repository/schedules.repo.js', async () => (await import('../../service/__tests__/schedulesFake.js')).schedulesRepoMock);

beforeEach(() => { schedulesDb.reset(); vi.clearAllMocks(); });

const RUN = uid(500);
const SLOT = '2026-11-06T01:15:00.000Z';
/** Schedule 1 owned by OWNER with recipients LAB, LAB2 (+ LAB_A1 when asked) and one dispatched run with run-recipient rows for them. */
function world(o: { schedule?: Record<string, unknown>; run?: Record<string, unknown>; recipients?: string[]; omitted?: Record<string, string[]> } = {}) {
  const recipients = o.recipients ?? [LAB, LAB2];
  seedSchedule(1, OWNER, recipients, { name: 'Daily MIS', report_codes: ['income', 'collections'], ...(o.schedule ?? {}) });
  schedulesDb.seedRun({ id: RUN, tenant_id: TA, schedule_id: sid(1), slot_start: SLOT, report_codes: ['income', 'collections'], period_from: '2026-11-05', period_to: '2026-11-06', ...(o.run ?? {}) });
  recipients.forEach((k, i) => schedulesDb.seedRunRecipient({ id: uid(600 + i), tenant_id: TA, report_run_id: RUN, schedule_id: sid(1), membership_id: MEMBER[k]!, omitted_report_codes: o.omitted?.[k] ?? [] }));
}
const get = (ctx: any, id = RUN) => callSch('getReportRun', ctx, { params: { report_run_id: id } });

describe('getReportRun — permission gate (analytics.dashboard.read) and visibility (US-18.4, P10)', () => {
  it.each([['no permission', NOPERM], ['finance (collections only, no dashboard.read)', FINANCE]])('%s -> 403 auth.forbidden; nothing read', async (_n, who) => {
    world({ recipients: [LAB, LAB2, who] });
    const c = await makeCtx16(who);
    await expectLims(get(c.ctx), 'auth.forbidden', 403);
    expect(schedulesDb.calls).toEqual([]);
    expect(c.assertRole.mock.calls[0]![1]).toEqual({ permission: 'analytics.dashboard.read' });
  });

  it('a recipient of the run -> 200 ReportRunDto', async () => {
    world();
    const r = await get((await makeCtx16(LAB)).ctx);
    expect(r.status).toBe(200);
    expect(contractErrors('ReportRunDto', r.body)).toEqual([]);
  });

  it('the schedule owner (not a recipient) -> 200', async () => {
    world();
    expect((await get((await makeCtx16(OWNER)).ctx)).status).toBe(200);
  });

  it('a same-tenant user who holds the permission but is neither recipient nor owner -> 404 common.not_found (no 403: no oracle) (P10)', async () => {
    world();
    for (const who of [LAB3, OWNER2]) await expectLims(get((await makeCtx16(who)).ctx), 'common.not_found', 404);
  });

  it('defense in depth: even when the repository would hand the run to a stranger (permissive tx), the service answers 404', async () => {
    world();
    const c = await makeCtx16(LAB3);
    c.ctx.tx.system = true;                                                // the emulated RLS now returns every row
    await expectLims(get(c.ctx), 'common.not_found', 404);
  });

  it('unknown id and another tenant\'s run id -> the same 404', async () => {
    world();
    schedulesDb.seedSchedule({ id: sid(90), tenant_id: TB, owner_membership_id: FOREIGN_MEMBER }, [FOREIGN_MEMBER]);
    schedulesDb.seedRun({ id: uid(590), tenant_id: TB, schedule_id: sid(90), slot_start: SLOT });
    const c = await makeCtx16(OWNER);
    await expectLims(get(c.ctx, uid(590)), 'common.not_found', 404);
    await expectLims(get(c.ctx, uid(591)), 'common.not_found', 404);
  });

  it('a recipient that was REMOVED from the schedule afterwards still opens the runs they received (their run row stays; D-45)', async () => {
    world();
    schedulesDb.recipientsOf(sid(1)).find((r) => r.membership_id === MEMBER[LAB2])!.is_active = false;
    expect((await get((await makeCtx16(LAB2)).ctx)).status).toBe(200);
  });

  it('a run recipient who lost analytics.dashboard.read since is refused by the gate (403), the link needs the permission at open time', async () => {
    world({ recipients: [LAB, FINANCE] });
    await expectLims(get((await makeCtx16(FINANCE)).ctx), 'auth.forbidden', 403);
  });
});

describe('getReportRun — ReportRunDto content', () => {
  it('id, schedule_id, current schedule name, the run\'s report_codes, period (both calendars + timezone), the run\'s scope snapshot, created_at', async () => {
    world();
    const body = (await get((await makeCtx16(LAB)).ctx)).body;
    expect(body).toMatchObject({
      id: RUN, schedule_id: sid(1), schedule_name: 'Daily MIS', report_codes: ['income', 'collections'], scope_all_centres: true, scope_centre_ids: [],
      period: { business_date_from: '2026-11-05', business_date_to: '2026-11-06', days: 1, timezone: 'Asia/Kathmandu' },
    });
    expect(body.period.label_ad).toEqual(expect.any(String));
    expect(body.period.label_bs).toMatch(/2083/);                          // 2026-11-05 is in B.S. 2083
    expect(Date.parse(body.created_at)).not.toBeNaN();
  });

  it('metadata only: no figures, no tenant/audit columns, no e-mail, no delivery ids, no outcomes for a plain recipient', async () => {
    world();
    const body = (await get((await makeCtx16(LAB)).ctx)).body;
    expect(Object.keys(body).sort()).toEqual(['created_at', 'effective_scope', 'id', 'period', 'report_codes', 'schedule_id', 'schedule_name', 'scope_all_centres', 'scope_centre_ids', 'viewer_omitted_report_codes'].sort());
    expect(body).not.toHaveProperty('recipients');
    expect(JSON.stringify(body)).not.toMatch(/@|delivery_id|tenant_id|created_by|expires_at|sent_count/);
  });

  it('the period of a B.S.-rule run is echoed as stored (two calendars derived by the service, not stored)', async () => {
    world({ schedule: { period_rule: 'previous_bs_month' }, run: { period_from: '2026-10-18', period_to: '2026-11-17' } });
    const body = (await get((await makeCtx16(LAB)).ctx)).body;
    expect(body.period).toMatchObject({ business_date_from: '2026-10-18', business_date_to: '2026-11-17', days: 30 });
    expect(contractErrors('ReportRunDto', body)).toEqual([]);
  });
});

describe('getReportRun — viewer_omitted_report_codes (US-18.6; review m#20)', () => {
  it('a recipient sees THEIR OWN omitted codes (their row), not another recipient\'s and not the run-level list', async () => {
    world({ omitted: { [LAB]: ['collections'], [LAB2]: [] }, run: { omitted_report_codes: ['referral_incentive'] } });
    const lab = (await get((await makeCtx16(LAB)).ctx)).body;
    const lab2 = (await get((await makeCtx16(LAB2)).ctx)).body;
    expect(lab.viewer_omitted_report_codes).toEqual(['collections']);
    expect(lab2.viewer_omitted_report_codes).toEqual([]);
  });

  it('the schedule owner who is not a recipient sees the run-level omitted codes', async () => {
    world({ run: { omitted_report_codes: ['referral_incentive'] } });
    expect((await get((await makeCtx16(OWNER)).ctx)).body.viewer_omitted_report_codes).toEqual(['referral_incentive']);
  });

  it('the owner who is ALSO a recipient sees their recipient row\'s codes', async () => {
    world({ recipients: [LAB, OWNER], omitted: { [OWNER]: ['collections'] }, run: { omitted_report_codes: ['referral_incentive'] } });
    expect((await get((await makeCtx16(OWNER)).ctx)).body.viewer_omitted_report_codes).toEqual(['collections']);
  });
});

describe('getReportRun — owner view: recipient list and run log (US-18.3 "the schedule owner sees it in the run log")', () => {
  it('owner gets recipients [{membership_id, display_name, outcome}] with display names read through core.memberships.list({membershipIds, activeOnly:false})', async () => {
    world({ recipients: [LAB, LAB2, LAB3] });
    const run3 = schedulesDb.runRecipientsOf(RUN).find((r) => r.membership_id === MEMBER[LAB3])!;
    run3.outcome = 'skipped_ineligible';
    const c = await makeCtx16(OWNER);
    const body = (await get(c.ctx)).body;
    expect(contractErrors('ReportRunDto', body)).toEqual([]);
    expect(body.recipients).toHaveLength(3);
    expect(body.recipients.find((r: any) => r.membership_id === MEMBER[LAB3])).toEqual({ membership_id: MEMBER[LAB3], display_name: 'Test User A-schlab3', outcome: 'skipped_ineligible' });
    expect(body.recipients.find((r: any) => r.membership_id === MEMBER[LAB])).toMatchObject({ display_name: 'Test User A-schlab', outcome: 'queued' });
    const listCalls = (c.core.memberships as any).calls as { membershipIds?: string[]; activeOnly?: boolean }[];
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every((x) => x.activeOnly === false)).toBe(true);
    expect(listCalls.flatMap((x) => x.membershipIds ?? []).sort()).toEqual([MEMBER[LAB], MEMBER[LAB2], MEMBER[LAB3]].sort());
  });

  it('a recipient never gets the recipient list (other people\'s names stay private)', async () => {
    world({ recipients: [LAB, LAB2] });
    const c = await makeCtx16(LAB);
    const body = (await get(c.ctx)).body;
    expect(body).not.toHaveProperty('recipients');
    expect(JSON.stringify(body)).not.toContain('schlab2');
  });

  it('a deactivated recipient still shows with their name (activeOnly:false)', async () => {
    world({ recipients: [LAB] });
    schedulesDb.seedRunRecipient({ id: uid(660), tenant_id: TA, report_run_id: RUN, schedule_id: sid(1), membership_id: MEMBER['A:user:schrevoked']!, outcome: 'skipped_ineligible' });
    const body = (await get((await makeCtx16(OWNER)).ctx)).body;
    expect(body.recipients.find((r: any) => r.membership_id === MEMBER['A:user:schrevoked'])).toMatchObject({ display_name: 'Test User A-schrevoked', outcome: 'skipped_ineligible' });
  });

  it('runs that were skipped (skipped_late / skipped_flag_off) are visible to the owner (run visibility)', async () => {
    world({ run: { state: 'skipped_late' } });
    expect((await get((await makeCtx16(OWNER)).ctx)).status).toBe(200);
    schedulesDb.runs.get(RUN)!.state = 'skipped_flag_off';
    expect((await get((await makeCtx16(OWNER)).ctx)).status).toBe(200);
  });
});

describe('getReportRun — effective_scope = viewer scope ∩ schedule scope (US-18.4; 07-SECURITY S4)', () => {
  const echo = async (viewer: string, run: Record<string, unknown>, recipients: string[] = [LAB, LAB_A1, OWNER_A1]) => {
    world({ recipients, run });
    return (await get((await makeCtx16(viewer)).ctx)).body.effective_scope;
  };

  it('all-centre schedule + all-centre viewer -> all centres', async () => {
    expect(await echo(LAB, { scope_all_centres: true, scope_centre_ids: [] })).toEqual({ all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] });
  });
  it('all-centre schedule + viewer restricted to {A1} -> {A1}', async () => {
    expect(await echo(LAB_A1, { scope_all_centres: true, scope_centre_ids: [] })).toEqual({ all_centres: false, centre_ids: [A1], tenant_wide_sections_hidden: [] });
  });
  it('schedule {A1,A2} + all-centre viewer -> {A1,A2}', async () => {
    const e = await echo(LAB, { scope_all_centres: false, scope_centre_ids: [A1, A2] });
    expect(e.all_centres).toBe(false);
    expect([...e.centre_ids].sort()).toEqual([A1, A2].sort());
  });
  it('schedule {A1,A2} + viewer {A1} -> {A1}', async () => {
    expect((await echo(OWNER_A1, { scope_all_centres: false, scope_centre_ids: [A1, A2] })).centre_ids).toEqual([A1]);
  });
  it('schedule {A2} + viewer {A1} -> empty (the viewer sees no centre of this run, never A2)', async () => {
    const e = await echo(LAB_A1, { scope_all_centres: false, scope_centre_ids: [A2] });
    expect(e.all_centres).toBe(false);
    expect(e.centre_ids).toEqual([]);
  });
  it('the DTO still carries the run\'s own scope snapshot (what the schedule had), whoever the viewer is', async () => {
    world({ recipients: [LAB_A1], run: { scope_all_centres: false, scope_centre_ids: [A1, A2] } });
    const body = (await get((await makeCtx16(LAB_A1)).ctx)).body;
    expect(body.scope_all_centres).toBe(false);
    expect([...body.scope_centre_ids].sort()).toEqual([A1, A2].sort());
  });
});
