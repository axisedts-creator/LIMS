// T0B-MISREPORTS-2 done_when (3) / A39-2: "a schedule whose recipient lacks the permission runs with the report omitted, and while the flag is off the run omits it for everyone
// (PRD §9.7 rule, unchanged)" for the two money codes two_level_commission and tds. Worker side dispatchDueSchedules over the in-memory schedules repo of schedulesFake.ts; no database.
// Today only 'referral_incentive' is omitted when the flag is off (schedule.service.ts), so the flag cases fail now for the right reason. The permission cases follow
// getReport(code).permission and pass once the codes are registry rows. Pinned: all codes omitted -> run state skipped_flag_off, nothing sent; the flag is read per tick.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchDueSchedules } from '../schedule.service.js';
import { schedulesDb } from './schedulesFake.js';
import { MONEY_CODES } from '../../__tests__/misreports/contract.js';

vi.mock('../../repository/schedules.repo.js', async () => (await import('./schedulesFake.js')).schedulesRepoMock);

const TENANT = '01a1b34e-0000-7000-8000-0000000000a1', OWNER = '01a1b34e-0000-7000-8000-0000000000b1', LAB = '01a1b34e-0000-7000-8000-0000000000b2', SID = '01a1b34e-0000-7000-8000-0000000000c1';
const DASH = 'analytics.dashboard.read', REF = 'analytics.referral_report.read';
const SLOT = '2026-11-06T01:15:00.000Z', NOW = '2026-11-06T01:16:00.000Z';

function ctxOf(o: { flag: boolean; perms: string[] }) {
  const sent: any[] = [];
  const ctx: any = {
    tenantId: TENANT, tx: { system: true }, now: () => NOW, actor: { id: 'system' }, log: { info() {} }, metrics: { inc() {} },
    core: {
      tenant: async () => ({ displayName: 'Synthetic Lab' }),
      membership: async () => ({ isActive: true, status: 'active', displayName: 'Synthetic' }),
      membershipPermissions: async () => o.perms,
      memberships: { list: async () => [] },
    },
    ports: {
      IdentityPort: { getTenantSettings: async () => ({ referralIncentiveReportEnabled: o.flag }) },
      NotificationPort: { sendEmailLink: async (_c: unknown, i: any) => { sent.push(i); return { deliveryId: 'd1', status: 'queued', replayed: false }; } },
    },
  };
  return { ctx, sent };
}
const seed = (codes: string[]) => schedulesDb.seedSchedule({ id: SID, tenant_id: TENANT, owner_membership_id: OWNER, report_codes: codes, next_run_at: SLOT }, [LAB]);
const run = () => schedulesDb.runsOf(SID)[0]!;

beforeEach(() => { schedulesDb.reset(NOW); process.env.LIMS_ORIGIN_STAFF_WEB = 'https://staff.example.test'; });

describe.each(MONEY_CODES)('%s in a scheduled pack', (code) => {
  it('flag off: a pack of only this code is skipped_flag_off for everyone, the code is listed as omitted, nothing is sent', async () => {
    seed([code]); const { ctx, sent } = ctxOf({ flag: false, perms: [DASH, REF] });
    await dispatchDueSchedules(ctx);
    expect(run()).toMatchObject({ state: 'skipped_flag_off', omitted_report_codes: [code] });
    expect(sent).toEqual([]);
  });
  it('flag off: in a pack with income the run is dispatched without it, even for a holder of the privileged permission', async () => {
    seed(['income', code]); const { ctx, sent } = ctxOf({ flag: false, perms: [DASH, REF] });
    await dispatchDueSchedules(ctx);
    expect(run()).toMatchObject({ state: 'dispatched', omitted_report_codes: [code] });
    expect(sent).toHaveLength(1);
    expect(schedulesDb.runRecipientsOf(run().id)[0]!.omitted_report_codes).not.toContain(code);
  });
  it('flag on, recipient holds the privileged permission: nothing omitted', async () => {
    seed(['income', code]); const { ctx, sent } = ctxOf({ flag: true, perms: [DASH, REF] });
    await dispatchDueSchedules(ctx);
    expect(run()).toMatchObject({ state: 'dispatched', omitted_report_codes: [] });
    expect(sent).toHaveLength(1);
    expect(schedulesDb.runRecipientsOf(run().id)[0]).toMatchObject({ outcome: 'queued', omitted_report_codes: [] });
  });
  it('flag on, recipient without analytics.referral_report.read: the report is omitted for this recipient; a pack of only this code sends nothing', async () => {
    seed(['income', code]); const a = ctxOf({ flag: true, perms: [DASH] });
    await dispatchDueSchedules(a.ctx);
    expect(schedulesDb.runRecipientsOf(run().id)[0]).toMatchObject({ outcome: 'queued', omitted_report_codes: [code] });
    expect(a.sent).toHaveLength(1);
    schedulesDb.reset(NOW); seed([code]); const b = ctxOf({ flag: true, perms: [DASH] });
    await dispatchDueSchedules(b.ctx);
    expect(schedulesDb.runRecipientsOf(run().id)[0]).toMatchObject({ outcome: 'skipped_ineligible' });
    expect(b.sent).toEqual([]);
  });
});
