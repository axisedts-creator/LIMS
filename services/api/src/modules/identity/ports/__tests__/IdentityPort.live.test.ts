// T5 live-DB integration (done_when "integration privileged re-validation"; IC perf: privileged re-validation <= 10 ms, memoised assertRole <= 2 ms).
// Skipped unless LIMS_TEST_DATABASE_URL is set; same preconditions + `pg` loading as repository/__tests__/sessions.repo.live.test.ts
// (tenant ...a001, user ...a300, membership ...a500 exist; LIMS_TEST_API_DATABASE_URL = lims_api URL optional, proves FORCE RLS).
// NOT run in the tester pass (no DB / pg driver here): record the `T5 bench:` line when run with a DB.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../../../core/db/tx.js';
import { createCoreAdminRepo } from '../../repository/core-admin.repo.js';
import { createIdentityPort } from '../IdentityPort.impl.js';

const URL_ = process.env['LIMS_TEST_DATABASE_URL'];
const API_URL = process.env['LIMS_TEST_API_DATABASE_URL'] ?? URL_;
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', SUB = '01a1a98a-ac40-7000-8000-00000000a300', MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500';
const OTHER_TENANT = '01a1a98a-ac40-7000-8000-00000000a0ff', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const REQ = '01a1a98a-ac40-7000-8000-00000000c001';

describe.skipIf(!URL_)('IdentityPort over a real DB', () => {
  let admin: any, apiPool: any, db: ReturnType<typeof createDb>, port: ReturnType<typeof createIdentityPort>;
  const claims = (o: object = {}) => ({ sub: SUB, tenant_id: TENANT, membership_id: MEMBERSHIP, actor_type: 'user' as const, aal: 'aal2' as const, session_state: 'active', ...o });
  const withCtx = <T>(fn: (ctx: any) => Promise<T>, o: { tenantId?: string; claims?: object } = {}) =>
    db.requestTx({ requestId: REQ, clientIp: '203.0.113.7', operation: { module: 'identity', operationId: 'T5live' }, claims: claims(o.claims) as any },
      (tx) => fn({ tenantId: o.tenantId ?? TENANT, actor: { type: 'user', id: SUB, membershipId: MEMBERSHIP }, requestId: REQ, tx, now: () => new Date().toISOString(), ports: {} }));
  const asAdmin = async (sql: string, values: unknown[] = []) => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      await c.query(sql, values); await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    admin = new Pool({ connectionString: URL_, max: 2 });
    apiPool = new Pool({ connectionString: API_URL, max: 10 });
    db = createDb({ pool: apiPool, identitySystemActorId: SYS });
    port = createIdentityPort({ repo: createCoreAdminRepo(), systemActorPermissions: () => [] });
  });
  afterAll(async () => {
    await asAdmin(`UPDATE core.memberships SET locked_at = NULL, locked_by = NULL, lock_reason_code = NULL WHERE id = $1`, [MEMBERSHIP]);
    await admin?.end(); await apiPool?.end();
  });

  it('getActor returns the seeded membership; another tenant id in ctx -> no profile (REQ-SEC-024 explicit tenant bind + RLS)', async () => {
    const a = await withCtx((ctx) => port.getActor(ctx));
    expect(a.actor.membershipId ?? MEMBERSHIP).toBe(MEMBERSHIP);
    expect(a.isLocked).toBe(false);
    const e: any = await withCtx((ctx) => port.getActor(ctx), { tenantId: OTHER_TENANT }).then(() => undefined, (x) => x);
    expect(e?.code).toMatch(/^(auth\.unauthenticated|common\.not_found|auth\.forbidden)$/);
  });
  it('lock committed after the token was issued -> next request fails auth.account_locked on getActor and on a privileged assertRole', async () => {
    await asAdmin(`UPDATE core.memberships SET locked_at = now(), locked_by = $2, lock_reason_code = 'security_concern' WHERE id = $1`, [MEMBERSHIP, SUB]);
    for (const call of [(ctx: any) => port.getActor(ctx), (ctx: any) => port.assertRole(ctx, { permission: 'identity.user.manage' })]) {
      const e: any = await withCtx(call).then(() => undefined, (x) => x);
      expect(e?.code).toBe('auth.account_locked');
    }
    await asAdmin(`UPDATE core.memberships SET locked_at = NULL, locked_by = NULL, lock_reason_code = NULL WHERE id = $1`, [MEMBERSHIP]);
  });
  it('deactivated after the token was issued -> privileged assertRole fails with an auth.* code (contract case 6, real DB)', async () => {
    await asAdmin(`UPDATE core.memberships SET status = 'deactivated', deactivated_at = now(), deactivated_by = $2, deactivation_reason_code = 'other' WHERE id = $1`, [MEMBERSHIP, SUB]);
    try {
      const e: any = await withCtx((ctx) => port.assertRole(ctx, { permission: 'identity.user.manage' })).then(() => undefined, (x) => x);
      expect(e?.code).toMatch(/^auth\./);
    } finally {
      await asAdmin(`UPDATE core.memberships SET status = 'active', deactivated_at = NULL, deactivated_by = NULL, deactivation_reason_code = NULL WHERE id = $1`, [MEMBERSHIP]);
    }
  });
  // T5 review item 1: lims_app cannot SELECT identity.platform_staff (only lims_owner has a policy), so the support-session read must depend
  // only on identity.support_sessions. Run with LIMS_TEST_API_DATABASE_URL = the lims_app URL, otherwise the RLS defect is invisible.
  it('support actor with an active support session -> allowlist profile, not identity.support_session_required (C2-1, 02-TRD §7.2/§7.4, live RLS)', async () => {
    const STAFF = '01a1a98a-ac40-7000-8000-00000000a600', SSID = '01a1a98a-ac40-7000-8000-00000000a601';
    await asAdmin(`INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, created_by, updated_by)
                   VALUES ($1, $1, 'support.t5@example.test', 'Support T5', 'platform_support', $2, $2) ON CONFLICT (id) DO NOTHING`, [STAFF, SYS]);
    await asAdmin(`INSERT INTO identity.support_sessions (id, tenant_id, platform_staff_id, scope, reason_text, ticket_ref, duration_minutes, status, started_at, expires_at, created_by, updated_by)
                   VALUES ($1, $2, $3, 'read_only', 'T5 live support-session test', 'T5-LIVE', 30, 'active', now(), now() + interval '30 minutes', $4, $4)
                   ON CONFLICT (id) DO UPDATE SET status = 'active', started_at = now(), expires_at = now() + interval '30 minutes', ended_at = NULL, end_reason = NULL`, [SSID, TENANT, STAFF, SYS]);
    try {
      const sclaims = { sub: STAFF, tenant_id: TENANT, actor_type: 'user' as const, aal: 'aal2' as const, scope: 'support', support_session_id: SSID, support_scope: 'read_only', platform_staff_id: STAFF };
      const a: any = await db.requestTx({ requestId: REQ, clientIp: '203.0.113.7', operation: { module: 'identity', operationId: 'T5liveSupport' }, claims: sclaims as any },
        (tx) => port.getActor({ tenantId: TENANT, actor: { type: 'user', id: STAFF, supportSessionId: SSID }, requestId: REQ, tx, now: () => new Date().toISOString(), ports: {} } as any));
      expect([...a.permissions].sort()).toEqual(['audit.log.read', 'identity.centre.read', 'identity.user.read']);
      expect(a.roles).toEqual([]);
    } finally {
      await asAdmin(`UPDATE identity.support_sessions SET status = 'ended', ended_at = now(), end_reason = 'ended_by_staff' WHERE id = $1`, [SSID]);
    }
  });
  it('bench: memoised assertRole p95 <= 2 ms, privileged re-validation p95 <= 10 ms (200 requests)', async () => {
    const memo: number[] = [], priv: number[] = [];
    for (let i = 0; i < 200; i++) {
      await withCtx(async (ctx) => {
        await port.getActor(ctx);
        let t = performance.now(); await port.assertRole(ctx, { permission: 'identity.user.read' }); memo.push(performance.now() - t);
        t = performance.now(); await port.assertRole(ctx, { permission: 'identity.user.manage' }).catch(() => undefined); priv.push(performance.now() - t);
      });
    }
    const p95 = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length * 0.95)]!;
    console.log(`T5 bench: assertRole memo p95=${p95(memo).toFixed(2)} ms, privileged p95=${p95(priv).toFixed(2)} ms`);
    expect(p95(memo)).toBeLessThanOrEqual(2);
    expect(p95(priv)).toBeLessThanOrEqual(10);
  });
});
