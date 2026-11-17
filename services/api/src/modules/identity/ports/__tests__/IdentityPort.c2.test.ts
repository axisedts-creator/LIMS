// T5: C2 cases C2-1..C2-10 (02-TRD §7), memo/cache unit tests, privileged re-validation, D-119 key filter, method rules of the
// nine added methods. Uses the assumed API documented in ./helpers.ts. Expected now: fails on missing ../IdentityPort.impl.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createIdentityPort } from '../IdentityPort.impl.js';
import {
  makeFakeRepo, makeCtx, member, mid, DEFAULT_SETTINGS, FIXED_ACTOR_PERMISSIONS, PNG, SHA, SUPPORT_ID, STAFF_SUB, TENANTS, actorIdFor,
  type MemberRow,
} from './helpers';

const SYS_PERMS = ['identity.signatory.read'];
const IMG = '01900000-0000-7000-8000-0000000b0001', SIG = '01900000-0000-7000-8000-0000000b0002';

async function code(p: Promise<unknown>): Promise<string | undefined> { return (await p.then(() => undefined, (e: any) => e))?.code; }

function setup(init: Parameters<typeof makeFakeRepo>[0] = {}, deps: Record<string, unknown> = {}) {
  const f = makeFakeRepo({
    members: [
      member('A', 'tech', 1), member('A', 'admin', 2, { roleCodes: ['tenant_admin'], signature: { displayTitle: 'Pathologist', registrationNo: 'R-1', imageRef: SIG } }),
      member('A', 'centre', 3, { roleCodes: ['front_desk'], allCentres: false, centreIds: ['01900000-0000-7000-8000-0000000c0001'], branchIds: ['01900000-0000-7000-8000-0000000e0001'] }),
      member('A', 'p', 4, { actorType: 'partner', roleCodes: [], partnerRole: 'partner_admin', allCentres: false, mfaEnrolled: false }),
      member('A', 'ghost', 5, { roleCodes: ['tenant_admin'], status: 'deactivated' }),
      member('B', 'admin', 6, { roleCodes: ['tenant_admin'], signature: { displayTitle: 'Other', imageRef: SIG } }),
      ...(init.members ?? []),
    ],
    assets: [
      { id: IMG, tenantId: TENANTS.A, kind: 'logo', mimeType: 'image/png', sha256: SHA, base64: PNG, scanState: 'clean' },
      { id: SIG, tenantId: TENANTS.A, kind: 'signature', mimeType: 'image/png', sha256: SHA, base64: PNG, scanState: 'clean' },
      ...(init.assets ?? []),
    ],
    sigImages: [
      { tenantId: TENANTS.A, membershipId: mid(2), mimeType: 'image/png', sha256: SHA, base64: PNG, scanState: 'clean' },
      { tenantId: TENANTS.B, membershipId: mid(6), mimeType: 'image/png', sha256: SHA, base64: PNG, scanState: 'clean' },
      ...(init.sigImages ?? []),
    ],
    support: init.support ?? [], settings: init.settings, tenantStatus: init.tenantStatus,
  });
  let now = 1_000_000;
  const clock = { advance: (ms: number) => { now += ms; } };
  const mk = () => createIdentityPort({ repo: f.repo as any, systemActorPermissions: (id: string) => (id === actorIdFor('A', 'system', 'default') || id === actorIdFor('B', 'system', 'default') ? SYS_PERMS : []),
    nowMs: () => now, ...deps });
  return { ...f, port: mk(), mk, clock, ctx: makeCtx };
}
const asUser = (persona: string) => makeCtx('A', 'user', persona);

describe('getActor (02-TRD §7.1)', () => {
  it('maps membership: roles, union permissions, centre/branch scope, signature, isLocked=false', async () => {
    const s = setup();
    const a = await s.port.getActor(asUser('admin'));
    expect(a.roles).toEqual(['tenant_admin']);
    expect(a.permissions.length).toBeGreaterThan(5);
    expect(a.centreScope).toEqual({ all: true, centreIds: [] });
    expect(a.signature).toEqual({ displayTitle: 'Pathologist', registrationNo: 'R-1', signatureImageRef: SIG });
    expect(a.isLocked).toBe(false);
    const c = await s.port.getActor(asUser('centre'));
    expect(c.centreScope).toEqual({ all: false, centreIds: ['01900000-0000-7000-8000-0000000c0001'] });
    expect(c.branchIds).toEqual(['01900000-0000-7000-8000-0000000e0001']);
  });
  it('mfa.level comes from the verified claims aal, not the DB (lowest wins); enrolled from factors', async () => {
    const s = setup();
    s.st.claims.set(actorIdFor('A', 'user', 'admin'), { aal: 'aal1', membership_id: mid(2), session_state: 'active' });
    const a = await s.port.getActor(asUser('admin'));
    expect(a.mfa).toEqual({ enrolled: true, level: 'aal1' });
  });
  it('no membership in claims -> auth.unauthenticated; locked -> auth.account_locked', async () => {
    const s = setup({ members: [member('A', 'lk', 9, { lockedAt: '2026-11-01T00:00:00.000Z' })] });
    s.st.claims.set(actorIdFor('A', 'user', 'nobody'), { aal: 'aal1' });
    expect(await code(s.port.getActor(asUser('nobody')))).toBe('auth.unauthenticated');
    expect(await code(s.port.getActor(asUser('lk')))).toBe('auth.account_locked');
  });
  it('partner: fixed set by claims partner_role, no core membership read, centreScope none, roles [partnerRole]', async () => {
    const s = setup();
    const a = await s.port.getActor(makeCtx('A', 'partner', 'p'));
    expect([...a.permissions].sort()).toEqual([...FIXED_ACTOR_PERMISSIONS.partner.partner_admin].sort());
    expect(a.roles).toEqual(['partner_admin']);
    expect(a.centreScope).toEqual({ all: false, centreIds: [] });
    expect(s.calls['membership'] ?? 0).toBe(0);
  });
  it('patient pre_auth stage -> patient_pre_auth set; patient -> patient set; no centre scope', async () => {
    const s = setup();
    const ctx = makeCtx('A', 'patient', 'x');
    s.st.claims.set(ctx.actor.id, { aal: 'aal1', patient_stage: 'pre_auth' });
    expect([...(await s.port.getActor(ctx)).permissions].sort()).toEqual([...(FIXED_ACTOR_PERMISSIONS as any).patient_pre_auth].sort());
    s.st.claims.set(ctx.actor.id, { aal: 'aal1', membership_id: mid(1) });
    const a = await s.port.getActor(makeCtx('A', 'patient', 'x', { requestId: '01900000-0000-7000-8000-0000000000e2' }));
    expect([...a.permissions].sort()).toEqual([...(FIXED_ACTOR_PERMISSIONS as any).patient].sort());
    expect(a.centreScope).toEqual({ all: false, centreIds: [] });
  });
  it('device: bridge_agent default; queue_display -> [engagement.queue.board_read] + its centre', async () => {
    const s = setup();
    const ctx = makeCtx('A', 'device', 'q');
    s.st.claims.set(ctx.actor.id, { device_kind: 'queue_display', centre_id: '01900000-0000-7000-8000-0000000c0001' });
    const a = await s.port.getActor(ctx);
    expect(a.permissions).toEqual(['engagement.queue.board_read']);
    expect(a.centreScope).toEqual({ all: false, centreIds: ['01900000-0000-7000-8000-0000000c0001'] });
    expect([...(await s.port.getActor(makeCtx('A', 'device', 'default'))).permissions].sort()).toEqual([...FIXED_ACTOR_PERMISSIONS.device.bridge_agent].sort());
  });
  it('portal: fixed portal set, no centre scope', async () => {
    const a = await setup().port.getActor(makeCtx('A', 'portal'));
    expect([...a.permissions].sort()).toEqual([...(FIXED_ACTOR_PERMISSIONS as any).portal].sort());
    expect(a.centreScope.all).toBe(false);
  });
});

describe('per-request memo (02-TRD §7.1/§7.2, IC perf: assertRole <= 2 ms memoised)', () => {
  it('same request: getActor + non-privileged assertRole x3 read the membership once', async () => {
    const s = setup();
    const ctx = asUser('tech');
    await s.port.getActor(ctx);
    for (let i = 0; i < 3; i++) await s.port.assertRole(ctx, { permission: 'lab.result.read' });
    expect(s.calls['membership']).toBe(1);
  });
  it('memo is not shared across actors/tenants even when requestId collides', async () => {
    const s = setup();
    const a = await s.port.getActor(asUser('tech'));
    const b = await s.port.getActor(asUser('admin'));
    expect(a.roles).toEqual(['lab_technologist']);
    expect(b.roles).toEqual(['tenant_admin']);
    // same requestId, other tenant's admin: must get its own profile, not tenant A's memoised one
    expect((await s.port.getActor(makeCtx('B', 'user', 'admin'))).displayName).toBe('Test User 6');
  });
  it('memo returns a copy: mutating a returned profile does not change the next result', async () => {
    const s = setup();
    const ctx = asUser('tech');
    const a: any = await s.port.getActor(ctx);
    try { a.permissions.push('billing.invoice.issue'); a.roles.length = 0; } catch { /* frozen is fine */ }
    expect(await code(s.port.assertRole(ctx, { permission: 'billing.invoice.issue' }))).toBe('auth.forbidden');
  });
});

describe('assertRole (02-TRD §7.2)', () => {
  it('session state: mfa_pending -> auth.mfa_required; mfa_enrolment_required -> identity.mfa_enrolment_required; password_setup -> auth.forbidden', async () => {
    const s = setup();
    for (const [state, want] of [['mfa_pending', 'auth.mfa_required'], ['mfa_enrolment_required', 'identity.mfa_enrolment_required'], ['password_setup', 'auth.forbidden']] as const) {
      s.st.claims.set(actorIdFor('A', 'user', 'tech'), { aal: 'aal2', membership_id: mid(1), session_state: state });
      expect(await code(s.port.assertRole(makeCtx('A', 'user', 'tech'), { permission: 'lab.result.read' })), state).toBe(want);
    }
  });
  it('platform.* refused for everyone; platform actor without support session -> identity.support_session_required', async () => {
    const s = setup();
    expect(await code(s.port.assertRole(asUser('admin'), { permission: 'platform.tenant.read' }))).toBe('auth.forbidden');
    const ctx = makeCtx('A', 'user', 'staff');
    s.st.claims.set(ctx.actor.id, { scope: 'platform', platform_staff_id: STAFF_SUB, aal: 'aal2' });
    expect(await code(s.port.assertRole(ctx, { permission: 'identity.user.read' }))).toBe('identity.support_session_required');
  });
  it('branchId outside branchIds -> auth.forbidden; inside / all-centres -> ok', async () => {
    const s = setup();
    const BR = '01900000-0000-7000-8000-0000000e0001', OTHER = '01900000-0000-7000-8000-0000000e0002';
    await expect(s.port.assertRole(asUser('centre'), { permission: 'frontdesk.registration.create', branchId: BR })).resolves.toBeUndefined();
    expect(await code(s.port.assertRole(asUser('centre'), { permission: 'frontdesk.registration.create', branchId: OTHER }))).toBe('auth.forbidden');
    await expect(s.port.assertRole(asUser('tech'), { permission: 'lab.result.read', branchId: OTHER })).resolves.toBeUndefined();
  });
  it('AC-B3.1: centre-scoped user -> A2 forbidden; AC-B3.2: all_centres passes any centre of own tenant, none of tenant B', async () => {
    const s = setup();
    const A1 = '01900000-0000-7000-8000-0000000c0001', A2 = '01900000-0000-7000-8000-0000000c0002';
    expect(await code(s.port.assertRole(asUser('centre'), { permission: 'frontdesk.registration.create', centreId: A2 }))).toBe('auth.forbidden');
    await expect(s.port.assertRole(asUser('centre'), { permission: 'frontdesk.registration.create', centreId: A1 })).resolves.toBeUndefined();
    await expect(s.port.assertRole(asUser('tech'), { permission: 'lab.result.read', centreId: A2 })).resolves.toBeUndefined();
    // tenant B ctx for a tenant-A membership id/claims: no profile in B -> never passes
    s.st.claims.set(actorIdFor('B', 'user', 'tech'), { aal: 'aal2', membership_id: mid(1), session_state: 'active' });
    const e = await code(s.port.assertRole(makeCtx('B', 'user', 'tech'), { permission: 'lab.result.read' }));
    expect(e).toMatch(/^(auth\.unauthenticated|auth\.forbidden)$/);
  });
  it('emits lims_identity_authz_decisions_total outcome without ids', async () => {
    const seen: any[] = [];
    const s = setup({}, { metrics: { authzDecision: (...a: unknown[]) => seen.push(a) } });
    await s.port.assertRole(asUser('tech'), { permission: 'lab.result.read' });
    await code(s.port.assertRole(asUser('tech'), { permission: 'billing.invoice.issue' }));
    expect(seen).toEqual([['allow', false], ['forbidden', false]]);
  });
});

describe('privileged re-validation (IC §4.6 invariants; REQ-SEC-067; AC for membership revoked after token issued)', () => {
  it('privileged call re-reads the membership WITHOUT the memo, every time; non-privileged uses the memo', async () => {
    const s = setup();
    const ctx = asUser('admin');
    await s.port.assertRole(ctx, { permission: 'identity.user.manage' });
    const after1 = s.calls['membership'] + (s.calls['lockMembership'] ?? 0);
    await s.port.assertRole(ctx, { permission: 'identity.user.manage' });
    expect(s.calls['membership'] + (s.calls['lockMembership'] ?? 0)).toBe(after1 + 1);
    const before = s.calls['membership'];
    await s.port.assertRole(ctx, { permission: 'catalog.test.read' });
    expect(s.calls['membership']).toBe(before);
  });
  it('role removed / membership deactivated / locked mid-request after the memo was filled -> next privileged check fails', async () => {
    const s = setup();
    const ctx = asUser('admin');
    await s.port.assertRole(ctx, { permission: 'identity.user.manage' });             // fills memo
    const m = s.st.members.find((x) => x.membershipId === mid(2))!;
    m.permissions = m.permissions.filter((p) => p !== 'identity.user.manage');        // grant removed in DB
    expect(await code(s.port.assertRole(ctx, { permission: 'identity.user.manage' }))).toBe('auth.forbidden');
    m.permissions = ['identity.user.manage']; m.status = 'deactivated';
    expect(await code(s.port.assertRole(ctx, { permission: 'identity.user.manage' }))).toMatch(/^auth\./);
    m.status = 'active'; m.lockedAt = '2026-11-05T00:00:00.000Z';
    expect(await code(s.port.assertRole(ctx, { permission: 'identity.user.manage' }))).toBe('auth.account_locked');
  });
  it('centre narrowed in DB after memo: privileged check applies steps 5-6 on fresh data', async () => {
    const s = setup();
    const C = '01900000-0000-7000-8000-0000000c0009';
    const ctx = asUser('admin');
    await s.port.assertRole(ctx, { permission: 'identity.user.manage', centreId: C });
    const m = s.st.members.find((x) => x.membershipId === mid(2))!;
    m.allCentres = false; m.centreIds = [];
    expect(await code(s.port.assertRole(ctx, { permission: 'identity.user.manage', centreId: C }))).toBe('auth.forbidden');
  });
  it('privileged requires claims aal2 even when the DB factor is verified (04 A4)', async () => {
    const s = setup();
    s.st.claims.set(actorIdFor('A', 'user', 'admin'), { aal: 'aal1', membership_id: mid(2), session_state: 'active' });
    expect(await code(s.port.assertRole(asUser('admin'), { permission: 'identity.user.manage' }))).toBe('auth.mfa_required');
    await expect(s.port.assertRole(asUser('admin'), { permission: 'catalog.test.read' })).resolves.toBeUndefined();   // non-privileged: aal1 ok
  });
  it('support session expired mid-request -> identity.support_session_required on a privileged check', async () => {
    const s = setup({ support: [{ tenantId: TENANTS.A, id: SUPPORT_ID, active: true, scope: 'admin', staffDisplayName: 'Support Person' }] });
    const ctx = makeCtx('A', 'user', 'staff', { actor: { type: 'user', id: STAFF_SUB, supportSessionId: SUPPORT_ID } });
    s.st.claims.set(STAFF_SUB, { scope: 'support', support_session_id: SUPPORT_ID, support_scope: 'admin', platform_staff_id: STAFF_SUB, aal: 'aal2' });
    await expect(s.port.assertRole(ctx, { permission: 'identity.settings.manage' })).resolves.toBeUndefined();
    s.st.support[0]!.active = false;
    expect(await code(s.port.assertRole(ctx, { permission: 'identity.settings.manage' }))).toBe('identity.support_session_required');
  });
});

describe('C2-1 support-session allowlist (02-TRD §7.4)', () => {
  const RO = ['identity.user.read', 'identity.centre.read', 'audit.log.read'];
  const ADMIN = [...RO, 'identity.user.manage', 'identity.role.manage', 'identity.centre.manage', 'identity.settings.manage', 'identity.session.revoke'];
  const withScope = (scope: 'read_only' | 'admin') => {
    const s = setup({ support: [{ tenantId: TENANTS.A, id: SUPPORT_ID, active: true, scope, staffDisplayName: 'Support Person' }] });
    const ctx = makeCtx('A', 'user', 'staff', { actor: { type: 'user', id: STAFF_SUB, supportSessionId: SUPPORT_ID } });
    s.st.claims.set(STAFF_SUB, { scope: 'support', support_session_id: SUPPORT_ID, support_scope: scope, platform_staff_id: STAFF_SUB, aal: 'aal2' });
    return { s, ctx };
  };
  it('read_only: exactly the 3 read codes; no roles, no centres; displayName suffix', async () => {
    const { s, ctx } = withScope('read_only');
    const a = await s.port.getActor(ctx);
    expect([...a.permissions].sort()).toEqual([...RO].sort());
    expect(a.roles).toEqual([]);
    expect(a.centreScope).toEqual({ all: false, centreIds: [] });
    expect(a.branchIds).toEqual([]);
    expect(a.displayName).toBe('Support Person (the LIMS provider support)');
    expect(await code(s.port.assertRole(ctx, { permission: 'identity.user.manage' }))).toBe('auth.forbidden');
  });
  it('admin: read_only + 5 manage codes; never audit.log.export, clinical, billing, platform.*', async () => {
    const { s, ctx } = withScope('admin');
    expect([...(await s.port.getActor(ctx)).permissions].sort()).toEqual([...ADMIN].sort());
    for (const p of ['audit.log.export', 'lab.result.read', 'billing.invoice.read', 'platform.tenant.read']) expect(await code(s.port.assertRole(ctx, { permission: p })), p).toBe('auth.forbidden');
    await expect(s.port.assertRole(ctx, { permission: 'identity.session.revoke' })).resolves.toBeUndefined();
  });
  it('session unknown for this tenant (other tenant support id) -> no permissions granted', async () => {
    const { s, ctx } = withScope('admin');
    s.st.support[0]!.tenantId = TENANTS.B;
    expect(await code(s.port.assertRole(ctx, { permission: 'identity.user.read' }))).toMatch(/^(auth\.forbidden|identity\.support_session_required)$/);
  });
});

describe('C2-2 revoked session / sessions revoked on partner changes', () => {
  it('an auth.session_expired from the session/claims read surfaces unchanged from getActor and assertRole', async () => {
    const s = setup();
    (s.repo as any).claims = async () => { throw Object.assign(new Error('x'), { code: 'auth.session_expired' }); };
    expect(await code(s.port.getActor(asUser('tech')))).toBe('auth.session_expired');
    expect(await code(s.port.assertRole(asUser('tech'), { permission: 'lab.result.read' }))).toBe('auth.session_expired');
  });
  it('updatePartnerMembership deactivate / set_role revoke the membership sessions; reactivate / resend do not', async () => {
    const s = setup();
    const ctx = asUser('admin');
    await s.port.updatePartnerMembership(ctx, { membershipId: mid(4), action: 'set_role', partnerRole: 'partner_member' });
    await s.port.updatePartnerMembership(ctx, { membershipId: mid(4), action: 'deactivate' });
    expect(s.st.revoked.map((r) => r.membershipId)).toEqual([mid(4), mid(4)]);
    await s.port.updatePartnerMembership(ctx, { membershipId: mid(4), action: 'reactivate' });
    expect(s.st.revoked.length).toBe(2);
  });
});

describe('getTenantSettings cache (02-TRD §7.3) — C2-3, C2-5', () => {
  it('C2-3: change visible after TTL (30 s) from another process; within TTL the cached value is served; one query per miss', async () => {
    const s = setup();
    const a = s.port, b = s.mk();                                                  // two instances = two processes, same DB
    expect((await a.getTenantSettings(asUser('tech'))).idleTimeoutMinutes).toBe(15);
    s.st.settings[TENANTS.A] = { ...DEFAULT_SETTINGS, idleTimeoutMinutes: 25 };
    s.clock.advance(29_000);
    expect((await a.getTenantSettings(asUser('tech'))).idleTimeoutMinutes).toBe(15);
    expect(s.calls['tenantSettings']).toBe(1);
    s.clock.advance(1_001);
    expect((await a.getTenantSettings(asUser('tech'))).idleTimeoutMinutes).toBe(25);
    expect((await b.getTenantSettings(asUser('tech'))).idleTimeoutMinutes).toBe(25);
  });
  it('same-process write invalidates immediately (invalidateTenantSettings)', async () => {
    const s = setup();
    await s.port.getTenantSettings(asUser('tech'));
    s.st.settings[TENANTS.A] = { ...DEFAULT_SETTINGS, reportLinkTtlDays: 60 };
    s.port.invalidateTenantSettings(TENANTS.A);
    expect((await s.port.getTenantSettings(asUser('tech'))).reportLinkTtlDays).toBe(60);
  });
  it('C2-5: never returns another tenant\'s values; cache keyed by tenant', async () => {
    const s = setup({ settings: { [TENANTS.A]: { ...DEFAULT_SETTINGS, calendarDisplay: 'BS' }, [TENANTS.B]: { ...DEFAULT_SETTINGS, calendarDisplay: 'AD_BS' } } });
    const a1 = await s.port.getTenantSettings(asUser('tech'), { keys: ['calendarDisplay'] });
    const b1 = await s.port.getTenantSettings(makeCtx('B', 'user', 'admin'), { keys: ['calendarDisplay'] });
    const a2 = await s.port.getTenantSettings(asUser('tech'), { keys: ['calendarDisplay'] });
    expect([a1.calendarDisplay, b1.calendarDisplay, a2.calendarDisplay]).toEqual(['BS', 'AD_BS', 'BS']);
  });
  it('returned object is a copy: mutating it cannot poison the cache', async () => {
    const s = setup();
    const x: any = await s.port.getTenantSettings(asUser('tech'));
    try { x.idleTimeoutMinutes = 1; x.branding.legalName = 'EVIL'; x.featureFlags.evil = true; } catch { /* frozen ok */ }
    const y: any = await s.port.getTenantSettings(asUser('tech'));
    expect(y.idleTimeoutMinutes).toBe(15);
    expect(y.branding.legalName).toBe(DEFAULT_SETTINGS.branding.legalName);
    expect(y.featureFlags.evil).toBeUndefined();
  });
  it('unknown key -> common.validation_failed; missing settings row -> documented defaults (AD, Asia/Kathmandu, 15, 12, 30, 5)', async () => {
    const s = setup();
    expect(await code(s.port.getTenantSettings(asUser('tech'), { keys: ['nope' as any] }))).toBe('common.validation_failed');
    (s.repo as any).tenantSettings = async () => undefined;
    const d = await s.mk().getTenantSettings(asUser('tech'));
    expect([d.calendarDisplay, d.timezone, d.idleTimeoutMinutes, d.absoluteSessionHours, d.reportLinkTtlDays, d.retentionYears]).toEqual(['AD', 'Asia/Kathmandu', 15, 12, 30, 5]);
  });
});

describe('C2-10 / D-119 key filter for patient, portal, partner', () => {
  const actors = [['patient', 'x'], ['portal', 'default'], ['partner', 'p']] as const;
  for (const [type, persona] of actors) {
    it(`${type}: keys ⊆ {timezone, calendarDisplay} -> those keys; no keys or any other key -> auth.forbidden`, async () => {
      const s = setup();
      const ctx = () => makeCtx('A', type, persona);
      if (type === 'patient') s.st.claims.set(ctx().actor.id, { aal: 'aal1', membership_id: mid(1) });
      const ok = await s.port.getTenantSettings(ctx(), { keys: ['timezone', 'calendarDisplay'] });
      expect(Object.keys(ok).sort()).toEqual(['calendarDisplay', 'timezone']);
      expect(await code(s.port.getTenantSettings(ctx()))).toBe('auth.forbidden');
      expect(await code(s.port.getTenantSettings(ctx(), { keys: [] }))).toBe('auth.forbidden');
      expect(await code(s.port.getTenantSettings(ctx(), { keys: ['timezone', 'ird'] }))).toBe('auth.forbidden');
      expect(await code(s.port.getTenantSettings(ctx(), { keys: ['branding'] }))).toBe('auth.forbidden');
    });
  }
  it('filter holds even when the full settings are already cached by a staff caller', async () => {
    const s = setup();
    await s.port.getTenantSettings(asUser('tech'));
    expect(await code(s.port.getTenantSettings(makeCtx('A', 'partner', 'p'), { keys: ['ird'] }))).toBe('auth.forbidden');
  });
  it('staff and system actors are not restricted', async () => {
    const s = setup();
    expect((await s.port.getTenantSettings(asUser('tech'), { keys: ['ird', 'branding'] })).ird).toBeDefined();
    expect((await s.port.getTenantSettings(makeCtx('A', 'system'))).ird).toBeDefined();
  });
});

describe('C2-4 system actor permissions (CR-C2-013)', () => {
  it('holds exactly the worker-manifest permissions, centreScope.all, nothing else', async () => {
    const s = setup();
    const ctx = makeCtx('A', 'system');
    const a = await s.port.getActor(ctx);
    expect([...a.permissions]).toEqual(SYS_PERMS);
    expect(a.centreScope.all).toBe(true);
    await expect(s.port.assertRole(ctx, { permission: 'identity.signatory.read' })).resolves.toBeUndefined();
    expect(await code(s.port.assertRole(ctx, { permission: 'audit.log.read' }))).toBe('auth.forbidden');
  });
  it('system actor id unknown to the manifest -> no permissions (fail closed)', async () => {
    const s = setup();
    const ctx = makeCtx('A', 'system', 'unlisted');
    expect([...(await s.port.getActor(ctx)).permissions]).toEqual([]);
    expect(await code(s.port.assertRole(ctx, { permission: 'identity.signatory.read' }))).toBe('auth.forbidden');
  });
});

describe('C2-7 / C2-8 readBrandingAsset', () => {
  it('C2-7: user and system actors of the tenant get BrandingAssetContent', async () => {
    const s = setup();
    for (const ctx of [asUser('tech'), makeCtx('A', 'system')]) {
      expect(await s.port.readBrandingAsset(ctx, { assetId: IMG as any })).toEqual({ assetId: IMG, kind: 'logo', mimeType: 'image/png', sha256: SHA, base64: PNG });
    }
  });
  it('C2-8: a signature asset id -> common.not_found (never the bytes)', async () => {
    expect(await code(setup().port.readBrandingAsset(asUser('admin'), { assetId: SIG as any }))).toBe('common.not_found');
  });
  it('letterhead kinds allowed; unknown kind not allowed; other tenant / unknown id -> common.not_found', async () => {
    const H = '01900000-0000-7000-8000-0000000b0003', X = '01900000-0000-7000-8000-0000000b0004', Bx = '01900000-0000-7000-8000-0000000b0005';
    const s = setup({ assets: [
      { id: H, tenantId: TENANTS.A, kind: 'letterhead_header', mimeType: 'image/jpeg', sha256: SHA, base64: PNG, scanState: 'clean' },
      { id: X, tenantId: TENANTS.A, kind: 'something_else', mimeType: 'image/png', sha256: SHA, base64: PNG, scanState: 'clean' },
      { id: Bx, tenantId: TENANTS.B, kind: 'logo', mimeType: 'image/png', sha256: SHA, base64: PNG, scanState: 'clean' }] });
    expect((await s.port.readBrandingAsset(asUser('tech'), { assetId: H as any })).kind).toBe('letterhead_header');
    for (const id of [X, Bx, '01900000-0000-7000-8000-0000000bffff']) expect(await code(s.port.readBrandingAsset(asUser('tech'), { assetId: id as any })), id).toBe('common.not_found');
  });
  it('scan_state pending or quarantined -> common.upload_quarantined (P-19)', async () => {
    const P = '01900000-0000-7000-8000-0000000b0006', Q = '01900000-0000-7000-8000-0000000b0007';
    const s = setup({ assets: [
      { id: P, tenantId: TENANTS.A, kind: 'logo', mimeType: 'image/png', sha256: SHA, base64: PNG, scanState: 'pending' },
      { id: Q, tenantId: TENANTS.A, kind: 'logo', mimeType: 'image/png', sha256: SHA, base64: PNG, scanState: 'quarantined' }] });
    for (const id of [P, Q]) expect(await code(s.port.readBrandingAsset(asUser('tech'), { assetId: id as any }))).toBe('common.upload_quarantined');
  });
  it('device / patient / portal / partner actors -> auth.forbidden', async () => {
    const s = setup();
    for (const t of ['device', 'portal', 'patient', 'partner']) expect(await code(s.port.readBrandingAsset(makeCtx('A', t, t === 'partner' ? 'p' : 'default'), { assetId: IMG as any })), t).toBe('auth.forbidden');
  });
});

describe('C2-9 readSignatureImage (A21.2, A26.1)', () => {
  const sysCtx = () => makeCtx('A', 'system');
  it('system actor with identity.signatory.read -> SignatureImageContent (not BrandingAssetContent)', async () => {
    const r = await setup().port.readSignatureImage(sysCtx(), { membershipId: mid(2) as any });
    expect(r).toEqual({ membershipId: mid(2), contentBase64: PNG, mimeType: 'image/png', sha256: SHA });
  });
  it('user actor, or system actor without the permission -> auth.forbidden', async () => {
    const s = setup();
    expect(await code(s.port.readSignatureImage(asUser('admin'), { membershipId: mid(2) as any }))).toBe('auth.forbidden');
    expect(await code(s.port.readSignatureImage(makeCtx('A', 'system', 'unlisted'), { membershipId: mid(2) as any }))).toBe('auth.forbidden');
  });
  it('no signature, other tenant, or scan_state not clean -> common.not_found', async () => {
    const s = setup({ sigImages: [{ tenantId: TENANTS.A, membershipId: mid(3), mimeType: 'image/png', sha256: SHA, base64: PNG, scanState: 'pending' }] });
    for (const id of [mid(1), mid(6), mid(3), mid(99)]) expect(await code(s.port.readSignatureImage(sysCtx(), { membershipId: id as any })), id).toBe('common.not_found');
  });
});

describe('getSignatories / getStaffNotificationContact (A4.2)', () => {
  it('getSignatories: system with permission; unknown/other tenant omitted; inactive returned isActive:false; >20 ids rejected; else forbidden', async () => {
    const s = setup({ members: [member('A', 'old', 7, { status: 'deactivated', roleCodes: ['tenant_admin'], signature: { displayTitle: 'Retired' } })] });
    const out = await s.port.getSignatories(makeCtx('A', 'system'), { membershipIds: [mid(2), mid(7), mid(6), mid(99), mid(1)] as any });
    expect(out.map((x) => [x.membershipId, x.isActive])).toEqual([[mid(2), true], [mid(7), false]]);
    expect(await code(s.port.getSignatories(makeCtx('A', 'system'), { membershipIds: Array.from({ length: 21 }, (_, i) => mid(100 + i)) as any }))).toBe('common.validation_failed');
    expect(await code(s.port.getSignatories(asUser('admin'), { membershipIds: [mid(2)] as any }))).toBe('auth.forbidden');
  });
  it('getStaffNotificationContact: non-system caller -> auth.forbidden; unknown id -> common.not_found; email null -> eligible:false allowed', async () => {
    const s = setup({ members: [member('A', 'noemail', 8, { email: null, roleCodes: ['tenant_admin'] })] });
    expect(await code(s.port.getStaffNotificationContact(asUser('admin'), { membershipId: mid(2) as any, requiredPermission: 'audit.log.read' }))).toBe('auth.forbidden');
    expect(await code(s.port.getStaffNotificationContact(makeCtx('A', 'system'), { membershipId: mid(99) as any, requiredPermission: 'audit.log.read' }))).toBe('common.not_found');
    const r = await s.port.getStaffNotificationContact(makeCtx('A', 'system'), { membershipId: mid(8) as any, requiredPermission: 'audit.log.read' });
    expect(r.email).toBeNull();
    expect(r.membershipId).toBe(mid(8));
  });
  it('getStaffNotificationContact: unknown requiredPermission code -> common.validation_failed (no silent eligible:false)', async () => {
    expect(await code(setup().port.getStaffNotificationContact(makeCtx('A', 'system'), { membershipId: mid(2) as any, requiredPermission: 'nope.not.a_permission' }))).toBe('common.validation_failed');
  });
});

describe('provisionPartnerMembership / updatePartnerMembership (D-100)', () => {
  it('provision: status invited + ids; duplicate email -> identity.user_exists; suspended tenant -> identity.tenant_suspended; bad input -> common.validation_failed', async () => {
    const s = setup();
    const r = await s.port.provisionPartnerMembership(asUser('admin'), { email: 'New.Partner@Example.com', displayName: 'New Partner', partnerRole: 'partner_member' });
    expect(r.status).toBe('invited');
    expect(r.membershipId && r.userId && r.invitationId).toBeTruthy();
    expect(s.st.members.find((m) => m.membershipId === r.membershipId)?.email).toBe('new.partner@example.com');   // normalised
    expect(await code(s.port.provisionPartnerMembership(asUser('admin'), { email: 'new.partner@example.com', displayName: 'Dup', partnerRole: 'partner_member' }))).toBe('identity.user_exists');
    expect(await code(s.port.provisionPartnerMembership(asUser('admin'), { email: 'x@example.com', displayName: '', partnerRole: 'partner_member' }))).toBe('common.validation_failed');
    expect(await code(s.port.provisionPartnerMembership(asUser('admin'), { email: 'x@example.com', displayName: 'X', partnerRole: 'owner' as any }))).toBe('common.validation_failed');
    s.st.tenantStatus[TENANTS.A] = 'suspended';
    expect(await code(s.port.provisionPartnerMembership(asUser('admin'), { email: 'y@example.com', displayName: 'Y', partnerRole: 'partner_member' }))).toBe('identity.tenant_suspended');
  });
  it('partner-admin actors may call both (08 A22.2)', async () => {
    const s = setup();
    const pa = makeCtx('A', 'partner', 'p');
    const r = await s.port.provisionPartnerMembership(pa, { email: 'pm@example.com', displayName: 'PM', partnerRole: 'partner_member' });
    await expect(s.port.updatePartnerMembership(pa, { membershipId: r.membershipId, action: 'resend_invitation' })).resolves.toMatchObject({ status: 'invited' });
  });
  it('stale expectedVersion -> common.version_conflict and NO write; set_role with bad role -> validation_failed; set_role on deactivated -> identity.membership_inactive', async () => {
    const s = setup();
    const ctx = asUser('admin');
    expect(await code(s.port.updatePartnerMembership(ctx, { membershipId: mid(4), action: 'deactivate', expectedVersion: 99 }))).toBe('common.version_conflict');
    expect(s.calls['applyPartnerAction'] ?? 0).toBe(0);
    expect(await code(s.port.updatePartnerMembership(ctx, { membershipId: mid(4), action: 'set_role', partnerRole: 'boss' as any }))).toBe('common.validation_failed');
    await s.port.updatePartnerMembership(ctx, { membershipId: mid(4), action: 'deactivate' });
    expect(await code(s.port.updatePartnerMembership(ctx, { membershipId: mid(4), action: 'set_role', partnerRole: 'partner_member' }))).toBe('identity.membership_inactive');
  });
  it('omitted expectedVersion takes the row lock (SELECT … FOR UPDATE) before applying', async () => {
    const s = setup();
    await s.port.updatePartnerMembership(asUser('admin'), { membershipId: mid(4), action: 'deactivate' });
    expect(s.calls['lockMembership']).toBeGreaterThanOrEqual(1);
  });
  // T5 review item 3: memberships__deactivation_reason__ck allows only these four; anything else must be a validation error, not a raw PG 23514.
  it('deactivate: reasonCode outside the DB CHECK set -> common.validation_failed and NO write; each allowed code accepted', async () => {
    const s = setup();
    const ctx = asUser('admin');
    for (const bad of ['fired', 'x', 'Other', 'left organisation']) {
      expect(await code(s.port.updatePartnerMembership(ctx, { membershipId: mid(4), action: 'deactivate', reasonCode: bad as any })), bad).toBe('common.validation_failed');
    }
    expect(s.calls['applyPartnerAction'] ?? 0).toBe(0);
    for (const ok of ['left_organisation', 'security_concern', 'policy_violation', 'other']) {
      const s2 = setup();
      await expect(s2.port.updatePartnerMembership(asUser('admin'), { membershipId: mid(4), action: 'deactivate', reasonCode: ok as any }), ok).resolves.toBeDefined();
    }
  });
});

describe('patient methods: caller restriction (blocked paths stay fail-closed until C2 T1, 08 A25 D-218)', () => {
  it('staff user and partner callers cannot provision / open / revoke patient sessions -> auth.forbidden', async () => {
    const s = setup();
    for (const ctx of [asUser('admin'), makeCtx('A', 'partner', 'p')]) {
      expect(await code(s.port.provisionPatientMembership(ctx, { accountId: mid(1) as any }))).toBe('auth.forbidden');
      expect(await code(s.port.openPatientSession(ctx, { membershipId: mid(1) as any, appInstanceId: mid(1) as any, appPlatform: 'android' }))).toBe('auth.forbidden');
      expect(await code(s.port.revokePatientSessions(ctx, { membershipId: mid(1) as any, reason: 'x', deactivateMembership: false }))).toBe('auth.forbidden');
    }
  });
  it('revokePatientSessions: a patient may revoke only their own membership', async () => {
    const s = setup({ members: [member('A', 'pt', 20, { actorType: 'patient', roleCodes: [] }), member('A', 'pt2', 21, { actorType: 'patient', roleCodes: [] })] });
    const ctx = makeCtx('A', 'patient', 'pt');
    s.st.claims.set(ctx.actor.id, { aal: 'aal1', membership_id: mid(20), session_state: 'active' });
    await expect(s.port.revokePatientSessions(ctx, { membershipId: mid(20) as any, reason: 'logout', deactivateMembership: false })).resolves.toEqual({ revokedSessions: 1 });
    expect(await code(s.port.revokePatientSessions(ctx, { membershipId: mid(21) as any, reason: 'logout', deactivateMembership: false }))).toBe('auth.forbidden');
  });
  // T5 review item 2: sessions__revoke_reason__ck allows only these 13 reasons; anything else must be a validation error, not a raw PG 23514.
  it('revokePatientSessions: reason outside the DB CHECK set -> common.validation_failed and NO revoke; each allowed reason accepted', async () => {
    const allowed = ['logout', 'admin_revoke', 'self_revoke', 'password_change', 'role_change', 'lock', 'deactivate', 'tenant_suspended', 'mfa_failed', 'mfa_reset', 'refresh_failed', 'superseded', 'token_reuse'];
    const mk = () => {
      const s = setup({ members: [member('A', 'pt', 20, { actorType: 'patient', roleCodes: [] })] });
      const ctx = makeCtx('A', 'patient', 'pt');
      s.st.claims.set(ctx.actor.id, { aal: 'aal1', membership_id: mid(20), session_state: 'active' });
      return { s, ctx };
    };
    const { s, ctx } = mk();
    for (const bad of ['not_a_reason', 'x', 'LOGOUT', 'because']) {
      expect(await code(s.port.revokePatientSessions(ctx, { membershipId: mid(20) as any, reason: bad as any, deactivateMembership: false })), bad).toBe('common.validation_failed');
    }
    expect(s.calls['revokeSessions'] ?? 0).toBe(0);
    for (const ok of allowed) {
      const m = mk();
      await expect(m.s.port.revokePatientSessions(m.ctx, { membershipId: mid(20) as any, reason: ok as any, deactivateMembership: false }), ok).resolves.toEqual({ revokedSessions: 1 });
    }
  });
});

describe('adversarial: tenant isolation of every method', () => {
  it('tenant B callers cannot touch tenant A membership / asset / signature ids', async () => {
    const s = setup();
    const b = makeCtx('B', 'system', 'default');
    expect(await code(s.port.readSignatureImage(b, { membershipId: mid(2) as any }))).toBe('common.not_found');
    expect(await code(s.port.getStaffNotificationContact(b, { membershipId: mid(2) as any, requiredPermission: 'audit.log.read' }))).toBe('common.not_found');
    expect(await code(s.port.readBrandingAsset(b, { assetId: IMG as any }))).toBe('common.not_found');
    expect(await s.port.getSignatories(b, { membershipIds: [mid(2)] as any })).toEqual([]);
    expect(await code(s.port.updatePartnerMembership(makeCtx('B', 'user', 'admin'), { membershipId: mid(4), action: 'deactivate' }))).toBe('common.not_found');
  });
});

describe('static: core-admin.repo.ts discipline (REQ-SEC-024)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../repository/core-admin.repo.ts', import.meta.url)), 'utf8');
  it('exports createCoreAdminRepo and binds tenant_id = ctx.tenantId in tenant queries; no string-concatenated ids', () => {
    expect(src).toMatch(/export function createCoreAdminRepo/);
    expect(src).toMatch(/tenant_id\s*=\s*\$1/);
    expect(src).not.toMatch(/\$\{\s*(membershipId|assetId|email|tenantId)\s*\}/);
  });
  it('privileged re-validation SQL reads core.memberships by (tenant_id, id)', () => {
    expect(src).toMatch(/FROM core\.memberships[\s\S]{0,200}tenant_id\s*=\s*\$1[\s\S]{0,80}\bid\s*=\s*\$2/);
  });
  it('partner role change/deactivate lock the row: FOR UPDATE', () => { expect(src).toMatch(/FOR UPDATE/); });
});
