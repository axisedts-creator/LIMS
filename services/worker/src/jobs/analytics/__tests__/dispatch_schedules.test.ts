// C8 AN-T16 — worker task `analytics.dispatch_schedules` (02-TRD §9.6 steps 1–7; PRD US-18.1/18.2/18.3/18.5/18.6; 07-SECURITY S1/S2, abuse case 3; CR-C8-007/008; 08 A4.2/A5.4/D-29/D-45).
// World + pinned seams: ./dispatchFake.ts (read its header) and, API side, service/__tests__/schedulesFake.ts. The task, schedule.service.dispatch and domain/schedule are REAL; the
// repository is the in-memory emulator; the NotificationPort is the real C6 fake (params/link validated like C6 does) wrapped in a spy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../../api/src/core/errors.js';
import {
  COLL, M1, M2, M3, M4, NOW, ORIGIN, OWNER, SID, SLOT, SYS, TA, TB, addMember, buildNotif, makeJobCtx, resetWorld, run, runRecipients, runs, schedulesDb, seedDue, sends, world,
} from './dispatchFake.js';

vi.mock('../../../../../api/src/modules/analytics/repository/schedules.repo.js', async () => (await import('../../../../../api/src/modules/analytics/service/__tests__/schedulesFake.js')).schedulesRepoMock);

beforeEach(() => { resetWorld(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

const only = <T>(xs: T[]): T => { expect(xs).toHaveLength(1); return xs[0]!; };
const writes = () => schedulesDb.calls.filter((c) => /^(insert|finish|advance)/.test(c.fn));

// ============================================================================================================== US-18.1 happy path
describe('dispatch — due schedule (US-18.1)', () => {
  it('creates ONE run for the slot and sends once per eligible recipient with the C6 contract (recipient, template, purpose, params, key, related, absolute staff link)', async () => {
    seedDue();
    await run(makeJobCtx());
    const r = only(runs());
    expect(r).toMatchObject({ tenant_id: TA, schedule_id: SID, slot_start: SLOT, state: 'dispatched', report_codes: ['dashboard', 'income'], omitted_report_codes: [], period_from: '2026-11-05', period_to: '2026-11-06', scope_all_centres: true, created_by: SYS, sent_count: 2, skipped_count: 0 });
    expect(r.expires_at).toBe(new Date(Date.parse(NOW) + 400 * 86_400_000).toISOString());
    const got = sends();
    expect(got).toHaveLength(2);
    for (const m of [M1, M2]) {
      expect(got.find((s) => s.recipient.membershipId === m)).toEqual({
        recipient: { kind: 'staff', membershipId: m, requiredPermission: 'analytics.dashboard.read' },
        templateCode: 'analytics.report_ready', purpose: 'scheduled_report_ready',
        params: { lab_name: 'Test Lab Pvt Ltd', schedule_name: 'Daily MIS' },
        idempotencyKey: `${SID}:${SLOT}:${m}`,
        related: { entityType: 'report_run', entityId: r.id },
        linkUrl: `${ORIGIN}/analytics/report-runs/${r.id}`,
      });
    }
  });

  it('stores one run-recipient row per recipient with the delivery id and status, composite run/schedule ids, created_by and the 400-day expiry', async () => {
    seedDue();
    await run(makeJobCtx());
    const r = only(runs());
    const rows = runRecipients(r.id);
    expect(rows.map((x) => x.membership_id).sort()).toEqual([M1, M2].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ tenant_id: TA, report_run_id: r.id, schedule_id: SID, outcome: 'queued', notification_status: 'queued', omitted_report_codes: [], error_code: null, created_by: SYS });
      expect(row.delivery_id).toEqual(expect.any(String));
      expect(row.expires_at).toBe(r.expires_at);
    }
  });

  it('advances the schedule: next_run_at = the next 07:00 slot, last_run_id = the run', async () => {
    seedDue();
    await run(makeJobCtx());
    expect(schedulesDb.schedules.get(SID)).toMatchObject({ next_run_at: '2026-11-07T01:15:00.000Z', last_run_id: only(runs()).id });
  });

  it('only {lab_name, schedule_name} params and a link-only body: no figures, no e-mail address, no staff or patient name leaves C8 (US-18.2, S2)', async () => {
    seedDue({ name: 'Weekly P&L' });
    await run(makeJobCtx());
    for (const s of sends()) {
      expect(Object.keys(s.params).sort()).toEqual(['lab_name', 'schedule_name']);
      expect(Object.keys(s.recipient).sort()).toEqual(['kind', 'membershipId', 'requiredPermission']);
      expect(JSON.stringify(s)).not.toMatch(/@|example\.invalid|Test User|paisa|net_sales/);
    }
  });

  it('the staff link origin follows LIMS_ORIGIN_STAFF_WEB (D-29: absolute URL, never hard-coded, never a relative path)', async () => {
    process.env.LIMS_ORIGIN_STAFF_WEB = 'https://other-staff.lims.invalid';
    buildNotif();                                                          // the C6 fake now only accepts links of that origin
    seedDue({}, [M1]);
    await run(makeJobCtx());
    expect(sends()[0].linkUrl).toBe(`https://other-staff.lims.invalid/analytics/report-runs/${only(runs()).id}`);
  });

  it('metrics per recipient outcome and ONE dispatch log line with ids and counts only (no schedule name, no link)', async () => {
    seedDue({ name: 'Zeta Secret Pack' });
    await run(makeJobCtx());
    expect(world.metrics.filter((m) => m.name === 'lims_analytics_schedule_sends_total').map((m) => m.labels)).toEqual([{ outcome: 'queued' }, { outcome: 'queued' }]);
    const line = only(world.logs.filter((l) => l?.event === 'analytics_schedule_dispatched'));
    expect(line).toMatchObject({ tenant_id: TA, schedule_id: SID, run_id: only(runs()).id, recipients_sent: 2, recipients_skipped: 0 });
    expect(JSON.stringify(world.logs)).not.toMatch(/Zeta Secret Pack|report-runs\//);
  });
});

describe('dispatch — what is NOT due', () => {
  it('next_run_at in the future, an inactive schedule and a null next_run_at create nothing', async () => {
    seedDue({ next_run_at: '2026-11-06T06:00:00.001Z' });
    schedulesDb.seedSchedule({ id: '01900000-0000-7000-8000-000000001901', tenant_id: TA, owner_membership_id: OWNER, is_active: false, next_run_at: null }, [M1]);
    await run(makeJobCtx());
    expect(schedulesDb.runs.size).toBe(0);
    expect(sends()).toEqual([]);
  });

  it('exactly at the slot instant it is due (next_run_at <= now)', async () => {
    schedulesDb.reset(SLOT); resetWorld(SLOT);
    seedDue();
    await run(makeJobCtx());
    expect(runs()).toHaveLength(1);
  });

  it('tenant isolation: another tenant\'s due schedule is never touched; every repository call carries the job\'s tenant (P1)', async () => {
    seedDue();
    schedulesDb.seedSchedule({ id: '01900000-0000-7000-8000-000000001999', tenant_id: TB, owner_membership_id: OWNER, next_run_at: SLOT }, [M1]);
    await run(makeJobCtx());
    expect(schedulesDb.runsOf('01900000-0000-7000-8000-000000001999')).toEqual([]);
    expect(schedulesDb.schedules.get('01900000-0000-7000-8000-000000001999')!.next_run_at).toBe(SLOT);
    for (const c of schedulesDb.calls) expect(c.args.tenantId, c.fn).toBe(TA);
  });

  it('reads at most 50 due schedules per tick (TRD §9.6 step 1)', async () => {
    seedDue();
    await run(makeJobCtx());
    expect(schedulesDb.calls.find((c) => c.fn === 'dueSchedules')!.args.limit).toBe(50);
  });
});

// ============================================================================================================== slots and periods
describe('dispatch — period + next slot per rule (TRD §9.6 step 2)', () => {
  it('weekly Sunday 08:30: next slot a week later; period previous_7_days from the slot\'s local date', async () => {
    seedDue({ frequency: 'weekly', weekday: 7, send_time_local: '08:30', period_rule: 'previous_7_days', next_run_at: '2026-11-01T02:45:00.000Z' });
    schedulesDb.clock.now = '2026-11-01T03:00:00.000Z';
    await run(makeJobCtx());
    expect(only(runs())).toMatchObject({ period_from: '2026-10-25', period_to: '2026-11-01', state: 'dispatched' });
    expect(schedulesDb.schedules.get(SID)!.next_run_at).toBe('2026-11-08T02:45:00.000Z');
  });

  it('monthly_bs on a B.S. 1st: the previous B.S. month, next slot = the 1st of the next B.S. month (golden table values via bsdate)', async () => {
    const { bsToAd } = await import('../../../../../../packages/shared-ts/src/bsdate/index.js');
    const first = bsToAd({ year: 2083, month: 7, day: 1 }), prev = bsToAd({ year: 2083, month: 6, day: 1 }), next = bsToAd({ year: 2083, month: 8, day: 1 });
    const slot = new Date(Date.parse(`${first}T07:00:00Z`) - (5 * 60 + 45) * 60_000).toISOString();
    seedDue({ frequency: 'monthly_bs', period_rule: 'previous_bs_month', next_run_at: slot });
    schedulesDb.clock.now = new Date(Date.parse(slot) + 3_600_000).toISOString();
    await run(makeJobCtx());
    expect(only(runs())).toMatchObject({ period_from: prev, period_to: first });
    expect(schedulesDb.schedules.get(SID)!.next_run_at).toBe(new Date(Date.parse(`${next}T07:00:00Z`) - (5 * 60 + 45) * 60_000).toISOString());
  });
});

// ============================================================================================================== late slots (step 2a)
describe('dispatch — late slots (worker was down; 03-APP-FLOW X18)', () => {
  const lateBy = (ms: number) => { schedulesDb.clock.now = new Date(Date.parse(SLOT) + ms).toISOString(); };

  it('exactly 24 h late is still sent', async () => {
    seedDue(); lateBy(86_400_000);
    await run(makeJobCtx());
    expect(only(runs()).state).toBe('dispatched');
    expect(sends()).toHaveLength(2);
  });

  it('24 h + 1 ms late -> run state skipped_late, NOTHING sent, no recipient rows, schedule still advances', async () => {
    seedDue(); lateBy(86_400_001);
    await run(makeJobCtx());
    const r = only(runs());
    expect(r).toMatchObject({ state: 'skipped_late', slot_start: SLOT, sent_count: 0 });
    expect(sends()).toEqual([]);
    expect(runRecipients(r.id)).toEqual([]);
    const s = schedulesDb.schedules.get(SID)!;
    expect(Date.parse(s.next_run_at!)).toBeGreaterThan(Date.parse(SLOT));
    expect(s.last_run_id).toBe(r.id);
  });

  it('three days of downtime: no burst of old e-mails — only the slot inside the 24 h window is sent; stale slots are logged as skipped_late', async () => {
    seedDue({ next_run_at: '2026-11-03T01:15:00.000Z' });                  // now = 11-06T06:00Z
    for (let i = 0; i < 8 && Date.parse(schedulesDb.schedules.get(SID)!.next_run_at!) <= Date.parse(NOW); i++) await run(makeJobCtx());
    const all = runs();
    for (const r of all) {
      const late = Date.parse(NOW) - Date.parse(r.slot_start) > 86_400_000;
      expect(r.state, r.slot_start).toBe(late ? 'skipped_late' : 'dispatched');
    }
    expect(all.some((r) => r.state === 'dispatched' && r.slot_start === SLOT)).toBe(true);
    expect(sends()).toHaveLength(2);                                       // M1, M2 for the 11-06 slot only
    expect(sends().every((s) => s.idempotencyKey.includes(SLOT))).toBe(true);
    expect(Date.parse(schedulesDb.schedules.get(SID)!.next_run_at!)).toBeGreaterThan(Date.parse(NOW));
  });
});

// ============================================================================================================== idempotency (US-18.5)
describe('dispatch — idempotent for the same due slot (US-18.5)', () => {
  it('running the same slot again (cron twice / schedule row restored) creates no second run and sends nothing more; the schedule still advances', async () => {
    seedDue();
    await run(makeJobCtx());
    const firstRun = only(runs());
    const sentBefore = sends().length;
    const s = schedulesDb.schedules.get(SID)!;
    s.next_run_at = SLOT; s.last_run_id = null;                           // the same slot is due again
    await run(makeJobCtx());
    expect(runs()).toHaveLength(1);
    expect(runs()[0]!.id).toBe(firstRun.id);
    expect(sends()).toHaveLength(sentBefore);
    expect(runRecipients(firstRun.id)).toHaveLength(2);
    expect(schedulesDb.schedules.get(SID)!.next_run_at).toBe('2026-11-07T01:15:00.000Z');
  });

  it('the C6 idempotency key is exactly <schedule_id>:<slot_start>:<membership_id> (a replay by C6 would dedupe too)', async () => {
    seedDue({}, [M1]);
    await run(makeJobCtx());
    expect(sends()[0].idempotencyKey).toBe(`${SID}:${SLOT}:${M1}`);
    const again = await world.notif.sendEmailLink(makeJobCtx(), sends()[0]);
    expect(again.replayed).toBe(true);
  });

  it('two ticks racing for the same schedule do not double-send (one wins the unique slot)', async () => {
    seedDue();
    await Promise.all([run(makeJobCtx()), run(makeJobCtx())]);
    expect(runs()).toHaveLength(1);
    expect(sends()).toHaveLength(2);
  });
});

// ============================================================================================================== eligibility (US-18.3)
describe('dispatch — eligibility over ACTIVE recipients (US-18.3, D-45)', () => {
  it('deactivated membership, locked membership, missing analytics.dashboard.read, unknown membership -> skipped_ineligible with no send; the rest are sent', async () => {
    addMember(M3, { status: 'deactivated', isActive: false });
    addMember(M4, { lockedAt: '2026-11-01T00:00:00.000Z' });
    const NOPERM = '01900000-0000-7000-8000-0000000000f5', GHOST = '01900000-0000-7000-8000-0000000000f6';
    addMember(NOPERM, { perms: [COLL] });
    buildNotif();
    seedDue({}, [M1, M3, M4, NOPERM, GHOST]);
    await run(makeJobCtx());
    const r = only(runs());
    const rows = runRecipients(r.id);
    expect(rows.find((x) => x.membership_id === M1)).toMatchObject({ outcome: 'queued' });
    for (const m of [M3, M4, NOPERM, GHOST]) expect(rows.find((x) => x.membership_id === m), m).toMatchObject({ outcome: 'skipped_ineligible', delivery_id: null, notification_status: null });
    expect(sends().map((s) => s.recipient.membershipId)).toEqual([M1]);
    expect(r).toMatchObject({ sent_count: 1, skipped_count: 4 });
    expect(world.logs.find((l) => l?.event === 'analytics_schedule_dispatched')).toMatchObject({ recipients_sent: 1, recipients_skipped: 4 });
  });

  it('recipients removed from the schedule (is_active false, D-45) get nothing and no row', async () => {
    seedDue({}, [M1, M2]);
    schedulesDb.recipientsOf(SID).find((r) => r.membership_id === M2)!.is_active = false;
    await run(makeJobCtx());
    expect(sends().map((s) => s.recipient.membershipId)).toEqual([M1]);
    expect(runRecipients(only(runs()).id).map((r) => r.membership_id)).toEqual([M1]);
  });

  it('a recipient C6 cannot reach (no e-mail on the staff profile) is recorded as outcome suppressed / suppressed_no_contact — still counted, never a failure', async () => {
    addMember(M3, { email: null });
    buildNotif();
    seedDue({}, [M1, M3]);
    await run(makeJobCtx());
    const rows = runRecipients(only(runs()).id);
    expect(rows.find((r) => r.membership_id === M3)).toMatchObject({ outcome: 'suppressed', notification_status: 'suppressed_no_contact' });
    expect(rows.find((r) => r.membership_id === M3)!.delivery_id).toEqual(expect.any(String));
    expect(world.metrics.map((m) => m.labels.outcome).sort()).toEqual(['queued', 'suppressed']);
  });

  it('a send that C6 rejects fails ONLY that recipient (outcome failed + error_code); the others are still sent and the slot is not retried', async () => {
    seedDue({}, [M1, M2]);
    const real = world.notif.sendEmailLink.getMockImplementation?.();
    world.send.mockImplementation(async (c: any, i: any) => {
      if (i.recipient.membershipId === M1) throw new LimsError('reporting.notification_params_invalid');
      return real ? real(c, i) : { deliveryId: '01900000-0000-7000-8000-0000000000d1', status: 'queued', replayed: false };
    });
    await run(makeJobCtx());
    const rows = runRecipients(only(runs()).id);
    expect(rows.find((r) => r.membership_id === M1)).toMatchObject({ outcome: 'failed', error_code: 'reporting.notification_params_invalid', delivery_id: null });
    expect(rows.find((r) => r.membership_id === M2)).toMatchObject({ outcome: 'queued' });
    expect(schedulesDb.schedules.get(SID)!.next_run_at).toBe('2026-11-07T01:15:00.000Z');
  });

  it('no eligible recipient at all: the run exists (visible to the owner), nothing is sent, the schedule advances', async () => {
    addMember(M1, { status: 'deactivated', isActive: false });
    buildNotif();
    seedDue({}, [M1]);
    await run(makeJobCtx());
    expect(only(runs())).toMatchObject({ state: 'dispatched', sent_count: 0, skipped_count: 1 });
    expect(sends()).toEqual([]);
    expect(schedulesDb.schedules.get(SID)!.next_run_at).toBe('2026-11-07T01:15:00.000Z');
  });
});

// ============================================================================================================== omission rules (US-18.6)
describe('dispatch — omission rules for referral_incentive and per-report permissions (US-18.6, abuse case 3)', () => {
  it('tenant flag OFF: the run omits referral_incentive for everyone (run-level omitted_report_codes), still sends the rest', async () => {
    seedDue({ report_codes: ['income', 'referral_incentive'] }, [M1, OWNER]);
    await run(makeJobCtx());
    const r = only(runs());
    expect(r).toMatchObject({ state: 'dispatched', omitted_report_codes: ['referral_incentive'], report_codes: ['income', 'referral_incentive'] });
    expect(sends()).toHaveLength(2);
  });

  it('tenant flag OFF and the pack\'s only report is referral_incentive: run state skipped_flag_off, nothing sent, schedule advances', async () => {
    seedDue({ report_codes: ['referral_incentive'] });
    await run(makeJobCtx());
    const r = only(runs());
    expect(r.state).toBe('skipped_flag_off');
    expect(sends()).toEqual([]);
    expect(schedulesDb.schedules.get(SID)!.next_run_at).toBe('2026-11-07T01:15:00.000Z');
  });

  it('flag ON: a recipient without analytics.referral_report.read receives the run with the report omitted FOR THEM; the holder does not; the run-level list stays empty', async () => {
    world.settings.referralIncentiveReportEnabled = true;
    seedDue({ report_codes: ['income', 'referral_incentive'] }, [M1, OWNER]);
    await run(makeJobCtx());
    const r = only(runs());
    expect(r.omitted_report_codes).toEqual([]);
    const rows = runRecipients(r.id);
    expect(rows.find((x) => x.membership_id === M1)).toMatchObject({ outcome: 'queued', omitted_report_codes: ['referral_incentive'] });
    expect(rows.find((x) => x.membership_id === OWNER)).toMatchObject({ outcome: 'queued', omitted_report_codes: [] });
    expect(sends()).toHaveLength(2);
  });

  it('a recipient without analytics.collections.read gets collections omitted for them (report-specific permission of the pack)', async () => {
    seedDue({ report_codes: ['income', 'collections'] }, [M1, OWNER]);
    await run(makeJobCtx());
    const rows = runRecipients(only(runs()).id);
    expect(rows.find((x) => x.membership_id === M1)).toMatchObject({ omitted_report_codes: ['collections'] });
    expect(rows.find((x) => x.membership_id === OWNER)).toMatchObject({ omitted_report_codes: [] });
  });

  it('the flag is read for THIS tenant at dispatch time, never cached from an earlier tick', async () => {
    seedDue({ report_codes: ['income', 'referral_incentive'] }, [OWNER]);
    await run(makeJobCtx());
    expect(only(runs()).omitted_report_codes).toEqual(['referral_incentive']);
    world.settings.referralIncentiveReportEnabled = true;
    const s = schedulesDb.schedules.get(SID)!; s.next_run_at = '2026-11-06T01:30:00.000Z';
    await run(makeJobCtx());
    expect(runs().find((r) => r.slot_start === '2026-11-06T01:30:00.000Z')!.omitted_report_codes).toEqual([]);
  });
});

// ============================================================================================================== failure + hygiene
describe('dispatch — failure of dependencies', () => {
  it('a repository failure rejects the task (the job tx rolls back, the cron retries) and sends nothing', async () => {
    seedDue();
    schedulesDb.fail = Object.assign(new Error('connection reset'), { code: '08006' });
    await expect(run(makeJobCtx())).rejects.toThrow('connection reset');
    expect(sends()).toEqual([]);
  });

  it('writes nothing when there is nothing due (no empty runs, no schedule updates)', async () => {
    seedDue({ next_run_at: '2026-11-07T01:15:00.000Z' });
    await run(makeJobCtx());
    expect(writes()).toEqual([]);
  });
});
