// C2-T9 worker task identity.send_recovery (02-TRD s10 row; 03-APP-FLOW s3.7; 01-PRD AC-A7.1; 07-SECURITY AU-T5; 08 A25 D-219).
// ASSUMED seams (spec silent; writer: dispute if wrong):
//  - ../tasks/send_recovery.ts exports `SEND_RECOVERY = 'identity.send_recovery'`, `sendRecovery: TaskHandler` (default wiring) and `createSendRecovery(deps)` -> TaskHandler,
//    deps = { gotrue: Pick<GoTrueGateway,'adminFindUserByEmail'|'sendRecovery'>, repo: { loginContext(tx, sub) -> app.identity_login_context row (snake_case) } }.
//  - payload { email_norm } (platform task, ctx.tenantId undefined); the job: adminFindUserByEmail(email_norm) -> loginContext(ctx.tx, userId) -> send ONLY when the account is
//    active: tenant user = membership_count > 0 AND tenant_status 'active' AND membership_status 'active' AND membership_locked false; platform staff = platform_active true.
//    Otherwise stop silently (no throw, no GoTrue send). Then gotrue.sendRecovery(email_norm, '/auth/confirm'). The job records nothing else (02-TRD).
//  - a GoTrue outage (LimsError common.dependency_unavailable) is RETHROWN so the queue retries (maxAttempts 8); a bad payload is skipped without throwing.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGoTrueGateway } from '../../../../../api/src/modules/identity/gotrue/gateway.fake.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { SEND_RECOVERY, createSendRecovery, sendRecovery } from '../tasks/send_recovery.js';

const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT = idN(0xa1), MEMB = idN(0xb1), STAFF = idN(0xd2);
const tenantRow = (o: Record<string, unknown> = {}) => ({ platform_staff_id: null, platform_role: null, platform_active: null, platform_allowed_cidrs: null, membership_count: 1, tenant_id: TENANT, tenant_status: 'active',
  membership_id: MEMB, membership_status: 'active', membership_locked: false, mfa_required: false, has_verified_factor: false, idle_timeout_minutes: 30, absolute_session_hours: 12, ...o });
const platformRow = (o: Record<string, unknown> = {}) => tenantRow({ platform_staff_id: STAFF, platform_role: 'platform_support', platform_active: true, membership_count: 0, tenant_id: null, tenant_status: null, membership_id: null, membership_status: null, membership_locked: null, ...o });
const mk = (tag: string) => `t9-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@lims-test.example`;

function world(row: Record<string, unknown> | null = tenantRow(), o: { gotrue?: any } = {}) {
  const gw: any = createFakeGoTrueGateway(); const calls: Array<{ m: string; a: unknown[] }> = [];
  const gotrue = o.gotrue ?? new Proxy(gw, { get: (t, p: string) => (typeof t[p] === 'function' ? (...a: unknown[]) => { calls.push({ m: p, a }); return t[p](...a); } : t[p]) });
  const loginContext = vi.fn(async (_tx: unknown, _sub: string) => row ?? tenantRow({ membership_count: 0, tenant_id: null, tenant_status: null, membership_id: null, membership_status: null, membership_locked: null }));
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }; const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const ctx: any = { tenantId: undefined, actor: { type: 'system', id: idN(1) }, requestId: idN(0xe1), tx, log, attempt: 1, maxAttempts: 8, jobId: '1', now: () => '2026-11-11T04:00:00.000Z' };
  const task = createSendRecovery({ gotrue, repo: { loginContext } } as any);
  const run = (payload: Record<string, unknown>) => task(payload as any, ctx);
  const sent = () => gw.mailbox;
  return { gw, calls, loginContext, log, tx, ctx, run, sent, sends: () => calls.filter((c) => c.m === 'sendRecovery') };
}
const user = async (w: ReturnType<typeof world>, email = mk('u')) => { const u: any = await w.gw.adminCreateUser({ email, emailConfirm: true }); await w.gw.adminUpdatePassword(u.userId, 'Old-pass-Lims!9xyz'); return { email, userId: u.userId as string }; };

describe('AC-A7.1 / AU-T5: only an existing ACTIVE account gets a recovery e-mail; every other case stops silently', () => {
  it('task id is identity.send_recovery', () => { expect(SEND_RECOVERY).toBe('identity.send_recovery'); });
  it('existing active tenant user -> adminFindUserByEmail, loginContext(sub), then sendRecovery(email, /auth/confirm) exactly once; the fake mailbox holds a recovery link', async () => {
    const w = world(); const u = await user(w); await w.run({ email_norm: u.email });
    expect(w.sends()).toEqual([{ m: 'sendRecovery', a: [u.email, '/auth/confirm'] }]); expect(w.loginContext).toHaveBeenCalledWith(w.tx, u.userId); expect(w.sent().latestTokenHash(u.email, 'recovery')).toBeTruthy();
    expect(w.calls.map((c) => c.m).indexOf('adminFindUserByEmail')).toBeLessThan(w.calls.map((c) => c.m).indexOf('sendRecovery'));
  });
  it('existing active platform staff -> sent', async () => { const w = world(platformRow()); const u = await user(w); await w.run({ email_norm: u.email }); expect(w.sends()).toHaveLength(1); });
  it.each([
    ['unknown e-mail (GoTrue finds nobody)', 'unknown'],
    ['locked membership', tenantRow({ membership_locked: true })],
    ['deactivated membership', tenantRow({ membership_status: 'deactivated' })],
    ['suspended tenant', tenantRow({ tenant_status: 'suspended' })],
    ['inactive platform staff', platformRow({ platform_active: false })],
    ['GoTrue user with no membership and no platform row', null],
  ] as const)('%s -> no GoTrue send, no throw, no write, nothing logged with the e-mail', async (_n, row) => {
    const w = world(row === 'unknown' ? tenantRow() : (row as any)); const u = row === 'unknown' ? { email: mk('nobody'), userId: '' } : await user(w);
    await expect(w.run({ email_norm: u.email })).resolves.toBeUndefined(); expect(w.sends()).toHaveLength(0); expect(w.tx.query).not.toHaveBeenCalled();
    expect(JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls])).not.toContain(u.email);
    if (row === 'unknown') expect(w.loginContext).not.toHaveBeenCalled();
  });
  it('the outcome (resolved, undefined) is the same for every skip reason: the job result carries no existence signal', async () => {
    const w = await world(); const u = await user(w); const a = await w.run({ email_norm: u.email }); const b = await w.run({ email_norm: mk('nobody') }); expect(a).toBeUndefined(); expect(b).toBeUndefined();
  });
});

describe('robustness', () => {
  it.each([[{}], [{ email_norm: 5 }], [{ email_norm: '' }], [{ email_norm: 'not-an-email' }], [{ email_norm: 'a@b.test', extra: 1, tenant_id: TENANT }], [undefined]])('bad payload %j -> skipped without throwing, GoTrue untouched', async (payload) => {
    const w = world(); await expect(w.run(payload as any)).resolves.toBeUndefined(); expect(w.calls).toHaveLength(0); expect(w.sends()).toHaveLength(0);
  });
  it('GoTrue outage on the lookup or on the send is rethrown (queue retries up to 8 attempts); the e-mail is not in the thrown message', async () => {
    const email = mk('outage');
    for (const bad of ['adminFindUserByEmail', 'sendRecovery'] as const) {
      const gw: any = createFakeGoTrueGateway(); const u: any = await gw.adminCreateUser({ email: `${bad}-${email}`, emailConfirm: true });
      const gotrue = { adminFindUserByEmail: async (e: string) => { if (bad === 'adminFindUserByEmail') throw new LimsError('common.dependency_unavailable'); return gw.adminFindUserByEmail(e); }, sendRecovery: async () => { if (bad === 'sendRecovery') throw new LimsError('common.dependency_unavailable'); } };
      const w = world(tenantRow(), { gotrue }); const err: any = await w.run({ email_norm: `${bad}-${email}` }).then(() => undefined, (e) => e); void u;
      expect(err?.code).toBe('common.dependency_unavailable'); expect(String(err?.message)).not.toContain(email);
    }
  });
  it('the default wiring (sendRecovery) never throws on a bad payload and touches no GoTrue/DB before validating', async () => {
    const tx = { query: vi.fn() }; const ctx: any = { tenantId: undefined, actor: { type: 'system', id: idN(1) }, requestId: idN(0xe1), tx, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, attempt: 1, maxAttempts: 8, jobId: '1', now: () => '2026-11-11T04:00:00.000Z' };
    await expect(sendRecovery({ nonsense: true } as any, ctx)).resolves.toBeUndefined(); expect(tx.query).not.toHaveBeenCalled();
  });
});

describe('static hygiene of tasks/send_recovery.ts', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'tasks', 'send_recovery.ts'), 'utf8');
  it('no console.*, no link-TTL logic of its own (D-219: the TTL is GoTrue\'s), no recovery_requests table, no direct SQL', () => {
    expect(src).not.toMatch(/console\.(log|info|warn|error|debug)/); expect(src).not.toMatch(/recovery_requests|LINK_TTL|OTP_EXP|3600|60\s*\*\s*60/i);
    expect(src).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+[\w.]*\s+SET|DELETE\s+FROM)\b/i);
  });
});
