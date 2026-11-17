// C9 T-25 — S-07 (07-SECURITY §5; REQ-SEC-002/099; 02-TRD §5.0) privilege escalation: EVERY role of contracts/permissions.yaml calls EVERY one of the 54 operations through the real handler and the real
// IdentityPort; only the roles that hold the operation's x-permission get past authorisation, everyone else -> 403 auth.forbidden with zero DB statements and zero access-log rows.
// Also the API half of the S-05 sub-case (08 A17 P-16): partner / portal / patient / device / system actors holding NO quality permission are refused on all 54 operations; and a tenant-A actor's
// grants cannot be borrowed through the request (tenant/actor come from the context only). No database.
// Fails now if: any handler reaches the tx or the audit log before authorisation, an operation is bound to a permission the spec does not list, or a non-staff actor type is let in.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ALL_QUALITY_PERMS, ALL_ROLES, OPS, QUALITY_GRANTS, TENANT_B, fire, grantsOfRole, loadManifest, makeHarness, requestFor, seen } from './kit.js';

let handlers: Record<string, (...a: any[]) => Promise<any>>;
beforeAll(async () => { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); handlers = (await loadManifest()).handlers; });
const run = async (op: (typeof OPS)[number], who: Parameters<typeof makeHarness>[0]) => {
  const h = makeHarness(who, op.id);
  const out = await fire(handlers[op.id]!, requestFor(op), h.ctx);
  return { ...out, h };
};

describe('S-07 the role catalogue is what the probe thinks it is', () => {
  it('there are roles, 8 quality permissions, and 54 operations each bound to one of them', () => {
    expect(ALL_ROLES.length).toBeGreaterThanOrEqual(6);
    expect(ALL_QUALITY_PERMS.length).toBe(8);
    expect(OPS.length).toBe(54);
    for (const o of OPS) expect(ALL_QUALITY_PERMS, o.id).toContain(o.permission);
  });
  it('write operations are only ever bound to manage / review / ack permissions, and front_desk / phlebotomist / centre_staff hold no quality permission at all', () => {
    for (const o of OPS.filter((x) => x.isWrite)) expect(o.permission, o.id).toMatch(/^quality\.(qc\.manage|config\.manage|autoverify\.manage|qc_run\.review|tat_alert\.ack)$/);
    for (const r of ['front_desk', 'phlebotomist', 'centre_staff']) if (ALL_ROLES.includes(r)) expect(grantsOfRole(r), r).toEqual([]);
  });
  it('qc.manage and config.manage are lab_manager only (07-SECURITY §3: "technologist edits targets -> lab_manager only")', () => {
    expect(QUALITY_GRANTS.find((p) => p.code === 'quality.qc.manage')!.roles).toEqual(['lab_manager']);
    expect(QUALITY_GRANTS.find((p) => p.code === 'quality.config.manage')!.roles).toEqual(['lab_manager']);
  });
});

describe.each(ALL_ROLES)('S-07 role %s x all 54 operations (aal2 session, own tenant)', (role) => {
  const held = grantsOfRole(role);
  it.each(OPS.map((o) => [o.id, o] as const))('%s', async (_id, op) => {
    const r = await run(op, { permissions: held, aal: 'aal2' });
    if (held.includes(op.permission)) {
      expect(r.error?.code, `${role} holds ${op.permission}: must pass authorisation`).not.toBe('auth.forbidden');
      expect(r.error?.code).not.toBe('auth.mfa_required');
      expect(r.error?.code).not.toBe('auth.unauthenticated');
    } else {
      expect(r.reply, `${role} lacks ${op.permission} but got ${r.reply?.status}`).toBeUndefined();
      expect(r.error?.code, String(r.error?.message)).toBe('auth.forbidden');
      expect(r.error?.statusCode).toBe(403);
      expect(r.h.queries, 'no DB statement before authorisation').toEqual([]);
      expect(r.h.audits, 'no access-log row before authorisation').toEqual([]);
    }
  });
});

describe.each(['partner', 'portal', 'patient', 'device', 'system'] as const)('S-05 sub-case (API half): actor type %s holds no quality permission', (actorType) => {
  it.each(OPS.map((o) => [o.id, o] as const))('%s -> refused, nothing read or written', async (_id, op) => {
    const r = await run(op, { actorType, aal: 'aal2' });
    expect(r.reply, `${actorType} got ${r.reply?.status}`).toBeUndefined();
    expect(['auth.forbidden', 'auth.unauthenticated'], String(r.error?.code)).toContain(r.error?.code);
    expect(r.h.queries).toEqual([]);
    expect(r.h.audits).toEqual([]);
  });
});

describe('S-07 the request cannot lend privileges or retarget the tenant', () => {
  const writeOps = OPS.filter((o) => o.isWrite && o.hasBody);
  it.each(writeOps.map((o) => [o.id, o] as const))('%s: tenant_id / permissions / actor in path-query-body-headers change nothing for a role without the permission', async (_id, op) => {
    const h = makeHarness({ permissions: [], aal: 'aal2' }, op.id);
    const req = requestFor(op, { body: { tenant_id: TENANT_B, created_by: TENANT_B, permissions: [op.permission], role: 'lab_manager' }, query: { tenant_id: TENANT_B } });
    req.headers['x-tenant-id'] = TENANT_B;
    req.headers['x-permissions'] = op.permission;
    const out = await fire(handlers[op.id]!, req, h.ctx);
    expect(out.error?.code).toBe('auth.forbidden');
    expect(h.queries).toEqual([]);
    expect(seen(out.error)).not.toContain(TENANT_B);
  });
});
