// T21 support.service (platform side): AC-E4.1, E4.4 (platform half), E4.5 (state side), plus 02-TRD s5.10, 03-APP-FLOW s2.4 SP1/SP2/SP6/SP8, s8, 07-SECURITY E-5/E-6/P-6/P-8.
// Behaviour against the injected fake repo (support.helpers.ts documents every seam). Expected now: fails to load (../support.service.js missing).
import { describe, expect, it } from 'vitest';
import { createSupportService } from '../support.service.js';
import {
  NOW, OPEN, OTHER_STAFF_ID, PSESSION, STAFF_ID, STAFF_USER, SUPER, TENANT_A, TENANT_B, TENANT_C, idN, makeCtx, makeRepo, mins, nextId, rejection, srow, tenant, type FakeRepo,
} from './support.helpers.js';

const SID = idN(0x701), SID2 = idN(0x702);
const setup = (seed: Parameters<typeof makeRepo>[0] = {}, ctxOver: Record<string, unknown> = {}) => {
  const f = makeRepo(seed); const c = makeCtx(f, ctxOver); const svc = createSupportService({ repo: f.repo, newId: nextId } as never) as any;
  return { f, ...c, svc };
};
const writes = (f: FakeRepo) => f.calls.filter((c) => ['insert', 'update', 'bindPlatformSession', 'endActiveForPlatformSession', 'insertAccessLog', 'insertNotice'].includes(c.m));
const code = async (p: unknown) => (await rejection(p)).code;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const SCHEMA_KEYS = ['support_session_id', 'tenant_id', 'platform_staff_id', 'platform_staff_display_name', 'scope', 'reason_text', 'ticket_ref', 'duration_minutes', 'status', 'requested_at',
  'decided_at', 'decision_note', 'started_at', 'expires_at', 'ended_at', 'end_reason', 'version'];
const hasNull = (v: unknown): boolean => v === null || (typeof v === 'object' && v !== null && Object.values(v).some(hasNull));

describe('openSupportSession - notify tenant (AC-E4.1, SP1)', () => {
  it('201: status active, started now, expires now+duration, bound to the caller\'s platform session, SupportSession schema (no extra keys, no nulls)', async () => {
    const { svc, ctx, f } = setup();
    const r = await svc.openSupportSession(ctx, OPEN);
    expect(r.status).toBe(201); expect(r.version).toBe(1);
    expect(r.body).toMatchObject({ tenant_id: TENANT_A, platform_staff_id: STAFF_ID, scope: 'read_only', status: 'active', duration_minutes: 30, ticket_ref: 'SUP-1001', version: 1 });
    expect(r.body.started_at).toBe(NOW.toISOString()); expect(r.body.expires_at).toBe(mins(30).toISOString());
    expect(r.body.support_session_id).toMatch(/^[0-9a-f-]{36}$/);
    for (const k of Object.keys(r.body)) expect(SCHEMA_KEYS).toContain(k);
    expect(hasNull(r.body)).toBe(false); expect(r.body.requested_at).toMatch(ISO); expect(r.body).not.toHaveProperty('platform_session_id');
    expect(f.binding.get(PSESSION)).toBe(r.body.support_session_id);
    expect(f.rows).toHaveLength(1); expect(f.rows[0]!.platform_session_id).toBe(PSESSION);
  });
  it('acting identity comes from ctx only: the insert carries ctx staff id / user id / session id, never input values', async () => {
    const { svc, ctx, f } = setup();
    await svc.openSupportSession(ctx, { ...OPEN, platformStaffId: OTHER_STAFF_ID, actorId: 'evil', platformSessionId: 'evil', status: 'ended', version: 99 });
    const a: any = f.by('insert')[0]!.args[0];
    expect(a).toMatchObject({ platformStaffId: STAFF_ID, platformSessionId: PSESSION, actorId: STAFF_USER, status: 'active', tenantId: TENANT_A });
  });
  it('access-log support_session.open (entity support_session) and an admin notice are written INSIDE withTenantScope(target tenant) only (D-214)', async () => {
    const { svc, ctx, f, scopes, withTenantScope, tx } = setup();
    const r = await svc.openSupportSession(ctx, OPEN);
    expect(scopes).toEqual([TENANT_A]); expect(withTenantScope).toHaveBeenCalledWith(tx, TENANT_A, expect.any(Function));
    expect(f.logs).toEqual([expect.objectContaining({ tenantId: TENANT_A, action: 'support_session.open', entityType: 'support_session', entityId: r.body.support_session_id, outcome: 'allowed' })]);
    expect(f.notices).toEqual([{ tenantId: TENANT_A, kind: 'support_session_started', subjectType: 'support_session', subjectId: r.body.support_session_id }]);
    for (const c of f.calls.filter((x) => x.m === 'insertAccessLog' || x.m === 'insertNotice')) expect(c.scope).toBe(TENANT_A);
    for (const c of f.calls.filter((x) => !['insertAccessLog', 'insertNotice'].includes(x.m))) expect(c.scope).toBeNull();
  });
  it('the reason text (P2, may hold names) and ticket ref are not written to the access log, the notice, or the application log (07-SECURITY threat 6)', async () => {
    const reason = 'Patient Ram Bahadur cannot see report'; const { svc, ctx, f, log } = setup();
    await svc.openSupportSession(ctx, { ...OPEN, reasonText: reason });
    expect(JSON.stringify([f.logs, f.notices])).not.toContain('Ram Bahadur'); expect(JSON.stringify(f.logs)).not.toContain('SUP-1001');
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain('Ram Bahadur');
  });
  it('SP: opening a second session ends the first (superseded) before binding the new one; superseded close is logged in ITS tenant scope', async () => {
    const { svc, ctx, f, scopes } = setup({ tenants: [tenant(TENANT_A), tenant(TENANT_B)], rows: [srow({ id: SID, tenant_id: TENANT_B, status: 'active', started_at: NOW, expires_at: mins(20), platform_session_id: PSESSION })] });
    const r = await svc.openSupportSession(ctx, OPEN);
    expect(f.rows.find((x) => x.id === SID)).toMatchObject({ status: 'ended', end_reason: 'superseded' });
    expect(f.binding.get(PSESSION)).toBe(r.body.support_session_id); expect(f.rows.filter((x) => x.status === 'active' && x.platform_session_id === PSESSION)).toHaveLength(1);
    const order = f.calls.map((c) => c.m); expect(order.indexOf('endActiveForPlatformSession')).toBeLessThan(order.indexOf('insert'));
    expect(f.logs.find((l) => l.entityId === SID)).toMatchObject({ tenantId: TENANT_B, action: 'support_session.close' }); expect(scopes).toContain(TENANT_B);
  });
  it('the binding is per platform session: another staff member\'s active session is not touched', async () => {
    const other = srow({ id: SID, platform_staff_id: OTHER_STAFF_ID, status: 'active', started_at: NOW, expires_at: mins(20), platform_session_id: idN(0xe9) });
    const { svc, ctx, f } = setup({ rows: [other] });
    await svc.openSupportSession(ctx, OPEN);
    expect(f.rows.find((x) => x.id === SID)!.status).toBe('active');
  });
});

describe('openSupportSession - approval_required tenant (AC-E4.4 platform half, SP2)', () => {
  const seed = { tenants: [tenant(TENANT_A, { supportAccessMode: 'approval_required' }), tenant(TENANT_B)] };
  it('201: status requested, no started_at/expires_at, NOT bound, notice support_session_requested, no support_session.open access-log yet', async () => {
    const { svc, ctx, f } = setup(seed);
    const r = await svc.openSupportSession(ctx, OPEN);
    expect(r.status).toBe(201); expect(r.body.status).toBe('requested');
    expect(r.body).not.toHaveProperty('started_at'); expect(r.body).not.toHaveProperty('expires_at'); expect(hasNull(r.body)).toBe(false);
    expect(f.by('bindPlatformSession')).toHaveLength(0); expect(f.binding.has(PSESSION)).toBe(false);
    expect(f.notices).toEqual([{ tenantId: TENANT_A, kind: 'support_session_requested', subjectType: 'support_session', subjectId: r.body.support_session_id }]);
    expect(f.logs.filter((l) => l.action === 'support_session.open')).toHaveLength(0);
  });
  it('a requested session does not end the caller\'s other active session (nothing is bound yet)', async () => {
    const act = srow({ id: SID, tenant_id: TENANT_B, status: 'active', started_at: NOW, expires_at: mins(20), platform_session_id: PSESSION });
    const { svc, ctx, f } = setup({ ...seed, rows: [act] });
    await svc.openSupportSession(ctx, OPEN);
    expect(f.rows.find((x) => x.id === SID)!.status).toBe('active'); expect(f.by('endActiveForPlatformSession')).toHaveLength(0);
  });
  it('activate while still requested (not yet approved) -> 409 common.version_conflict; nothing is bound (AC-E4.4)', async () => {
    const { svc, ctx, f } = setup({ ...seed, rows: [srow({ id: SID, status: 'requested' })] });
    expect(await code(svc.activateSupportSession(ctx, { supportSessionId: SID, expectedVersion: 1 }))).toBe('common.version_conflict');
    expect(f.by('bindPlatformSession')).toHaveLength(0); expect(f.rows[0]!.status).toBe('requested');
  });
  it.each(['denied', 'expired', 'ended', 'revoked', 'active'] as const)('activate on a %s session -> 409 common.version_conflict', async (status) => {
    const { svc, ctx, f } = setup({ rows: [srow({ id: SID, status, decided_at: NOW })] });
    expect(await code(svc.activateSupportSession(ctx, { supportSessionId: SID, expectedVersion: 1 }))).toBe('common.version_conflict');
    expect(f.by('update')).toHaveLength(0); expect(f.by('bindPlatformSession')).toHaveLength(0);
  });
});

describe('openSupportSession - role and tenant guards (E-5, E-6, 03-APP-FLOW s2.4 SP1)', () => {
  it('admin scope by platform_support -> 403 auth.forbidden, before any write; superadmin may', async () => {
    const a = setup(); expect(await code(a.svc.openSupportSession(a.ctx, { ...OPEN, scope: 'admin' }))).toBe('auth.forbidden'); expect(writes(a.f)).toHaveLength(0);
    const b = setup({}, SUPER); const r = await b.svc.openSupportSession(b.ctx, { ...OPEN, scope: 'admin' });
    expect(r.body).toMatchObject({ scope: 'admin', status: 'active' });
  });
  it.each([['provisioning', true], ['active', true], ['suspended', false], ['offboarded', false]] as const)('admin scope on a %s tenant: allowed=%s (suspended -> 403 identity.tenant_suspended)', async (status, allowed) => {
    const { svc, ctx, f } = setup({ tenants: [tenant(TENANT_A, { status })] }, SUPER);
    if (allowed) { expect((await svc.openSupportSession(ctx, { ...OPEN, scope: 'admin' })).body.status).toBe('active'); return; }
    const e = await rejection(svc.openSupportSession(ctx, { ...OPEN, scope: 'admin' }));
    expect(e.code).toBe(status === 'suspended' ? 'identity.tenant_suspended' : e.code); expect(e).toBeTruthy(); expect(writes(f)).toHaveLength(0);
  });
  it.each(['provisioning', 'active', 'suspended'] as const)('read_only on a %s tenant is allowed (diagnosis, 5.10 note)', async (status) => {
    const { svc, ctx } = setup({ tenants: [tenant(TENANT_A, { status })] });
    expect((await svc.openSupportSession(ctx, OPEN)).body.status).toBe('active');
  });
  it('read_only on an offboarded tenant is refused (SP1 guard: tenant not offboarded); nothing written', async () => {
    const { svc, ctx, f } = setup({ tenants: [tenant(TENANT_A, { status: 'offboarded' })] });
    await rejection(svc.openSupportSession(ctx, OPEN)); expect(writes(f)).toHaveLength(0);
  });
  it('unknown tenant -> 404 common.not_found; nothing written, no scope entered', async () => {
    const { svc, ctx, f, scopes } = setup();
    expect(await code(svc.openSupportSession(ctx, { ...OPEN, tenantId: TENANT_C }))).toBe('common.not_found'); expect(writes(f)).toHaveLength(0); expect(scopes).toEqual([]);
  });
  it('aal1 -> auth.mfa_required; tenant-user context -> auth.forbidden; both before any repo call (P-8, authz first)', async () => {
    const a = setup({}, { aal: 'aal1' }); expect(await code(a.svc.openSupportSession(a.ctx, OPEN))).toBe('auth.mfa_required'); expect(a.f.calls).toHaveLength(0);
    const b = setup({}, { platformRole: undefined, tenantId: TENANT_A, actor: { type: 'user', id: STAFF_USER, membershipId: idN(0xaa) } });
    expect(await code(b.svc.openSupportSession(b.ctx, OPEN))).toBe('auth.forbidden'); expect(b.f.calls).toHaveLength(0);
  });
  it('a failure inside the scoped write (notice insert) aborts the whole open: error propagates, scope is closed, request tx is the caller\'s to roll back', async () => {
    const { svc, ctx, f } = setup(); f.state.fail['insertNotice'] = new Error('db down');
    await expect(svc.openSupportSession(ctx, OPEN)).rejects.toThrow('db down'); expect(f.state.scope).toBeNull();
  });
});

describe('openSupportSession - input validation (02-TRD s5.10; support_sessions CHECKs)', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['reason 9 chars', { reasonText: 'x'.repeat(9) }], ['reason 501 chars', { reasonText: 'x'.repeat(501) }], ['reason not a string', { reasonText: 12345678901 }], ['reason missing', { reasonText: undefined }],
    ['ticket empty', { ticketRef: '' }], ['ticket 61 chars', { ticketRef: 'T'.repeat(61) }], ['ticket missing', { ticketRef: undefined }],
    ['duration 4', { durationMinutes: 4 }], ['duration 61', { durationMinutes: 61 }], ['duration 0', { durationMinutes: 0 }], ['duration -30', { durationMinutes: -30 }],
    ['duration 30.5', { durationMinutes: 30.5 }], ['duration "30"', { durationMinutes: '30' }], ['duration NaN', { durationMinutes: NaN }], ['duration missing', { durationMinutes: undefined }],
    ['scope owner', { scope: 'owner' }], ['scope Admin', { scope: 'Admin' }], ['scope __proto__', { scope: '__proto__' }], ['scope missing', { scope: undefined }],
    ['tenant id malformed', { tenantId: 'not-a-uuid' }], ['tenant id sql', { tenantId: `${TENANT_A}' OR 1=1 --` }], ['tenant id missing', { tenantId: undefined }],
  ];
  it.each(bad)('%s -> 400 common.validation_failed; no repo call, no scope', async (_n, patch) => {
    const { svc, ctx, f, scopes } = setup({}, SUPER);
    expect(await code(svc.openSupportSession(ctx, { ...OPEN, ...patch }))).toBe('common.validation_failed'); expect(writes(f)).toHaveLength(0); expect(scopes).toEqual([]);
  });
  it.each([[5], [60], [30]])('duration boundary %i is accepted', async (d) => {
    const { svc, ctx } = setup(); const r = await svc.openSupportSession(ctx, { ...OPEN, durationMinutes: d });
    expect(r.body.duration_minutes).toBe(d); expect(r.body.expires_at).toBe(mins(d).toISOString());
  });
  it('reason boundary 10 and 500 chars and ticket 1 and 60 chars are accepted', async () => {
    for (const p of [{ reasonText: 'x'.repeat(10), ticketRef: 'T' }, { reasonText: 'x'.repeat(500), ticketRef: 'T'.repeat(60) }]) { const { svc, ctx } = setup(); expect((await svc.openSupportSession(ctx, { ...OPEN, ...p })).status).toBe(201); }
  });
});

describe('activateSupportSession (SP6)', () => {
  const approved = (o: Record<string, unknown> = {}) => srow({ id: SID, status: 'approved', decided_at: NOW, ...o });
  it('approved + same requester -> active; started now, expires now+duration; bound to the caller\'s platform session; access-log support_session.activate in scope; version bumped', async () => {
    const { svc, ctx, f, scopes } = setup({ rows: [approved()] });
    const r = await svc.activateSupportSession(ctx, { supportSessionId: SID, expectedVersion: 1 });
    expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ support_session_id: SID, status: 'active', version: 2, started_at: NOW.toISOString(), expires_at: mins(30).toISOString() }); expect(hasNull(r.body)).toBe(false);
    expect(f.binding.get(PSESSION)).toBe(SID); expect(scopes).toEqual([TENANT_A]);
    expect(f.logs).toEqual([expect.objectContaining({ tenantId: TENANT_A, action: 'support_session.activate', entityType: 'support_session', entityId: SID, outcome: 'allowed' })]);
    expect((f.by('update')[0]!.args[2] as any).actorId).toBe(STAFF_USER);
  });
  it('another active session of the same platform session is ended first (one active per platform session)', async () => {
    const act = srow({ id: SID2, tenant_id: TENANT_B, status: 'active', started_at: NOW, expires_at: mins(20), platform_session_id: PSESSION });
    const { svc, ctx, f } = setup({ rows: [approved(), act] });
    await svc.activateSupportSession(ctx, { supportSessionId: SID, expectedVersion: 1 });
    expect(f.rows.find((x) => x.id === SID2)).toMatchObject({ status: 'ended', end_reason: 'superseded' }); expect(f.binding.get(PSESSION)).toBe(SID);
  });
  it('caller must be the requester: another staff member -> 403 auth.forbidden, session untouched', async () => {
    const { svc, ctx, f } = setup({ rows: [approved({ platform_staff_id: OTHER_STAFF_ID })] });
    expect(await code(svc.activateSupportSession(ctx, { supportSessionId: SID, expectedVersion: 1 }))).toBe('auth.forbidden'); expect(f.by('update')).toHaveLength(0); expect(f.by('bindPlatformSession')).toHaveLength(0);
  });
  it('within 60 min of approval [CONV]: 59 min ok, 61 min -> 409 common.version_conflict', async () => {
    const ok = setup({ rows: [approved({ decided_at: mins(-59) })] }); expect((await ok.svc.activateSupportSession(ok.ctx, { supportSessionId: SID, expectedVersion: 1 })).body.status).toBe('active');
    const late = setup({ rows: [approved({ decided_at: mins(-61) })] });
    expect(await code(late.svc.activateSupportSession(late.ctx, { supportSessionId: SID, expectedVersion: 1 }))).toBe('common.version_conflict'); expect(late.f.by('bindPlatformSession')).toHaveLength(0);
  });
  it('If-Match: absent -> 428 common.precondition_required; 0/non-integer -> 400; stale -> 409; unknown id -> 404; malformed id -> 400', async () => {
    const mk = () => setup({ rows: [approved({ version: 3 })] });
    let t = mk(); expect(await code(t.svc.activateSupportSession(t.ctx, { supportSessionId: SID, expectedVersion: undefined }))).toBe('common.precondition_required');
    for (const v of [0, -1, 1.5, '3', NaN]) { t = mk(); expect(await code(t.svc.activateSupportSession(t.ctx, { supportSessionId: SID, expectedVersion: v }))).toBe('common.validation_failed'); }
    t = mk(); expect(await code(t.svc.activateSupportSession(t.ctx, { supportSessionId: SID, expectedVersion: 2 }))).toBe('common.version_conflict'); expect(t.f.by('bindPlatformSession')).toHaveLength(0);
    t = mk(); expect(await code(t.svc.activateSupportSession(t.ctx, { supportSessionId: SID2, expectedVersion: 1 }))).toBe('common.not_found');
    t = mk(); expect(await code(t.svc.activateSupportSession(t.ctx, { supportSessionId: 'nope', expectedVersion: 3 }))).toBe('common.validation_failed');
  });
  it('a lost update race (repo.update -> undefined) is 409 common.version_conflict and binds nothing', async () => {
    const { svc, ctx, f } = setup({ rows: [approved()] }); f.repo.update = async () => undefined;
    expect(await code(svc.activateSupportSession(ctx, { supportSessionId: SID, expectedVersion: 1 }))).toBe('common.version_conflict'); expect(f.by('bindPlatformSession')).toHaveLength(0);
  });
  it('authz first: aal1 -> auth.mfa_required with no repo call', async () => {
    const { svc, ctx, f } = setup({ rows: [approved()] }, { aal: 'aal1' });
    expect(await code(svc.activateSupportSession(ctx, { supportSessionId: SID, expectedVersion: 1 }))).toBe('auth.mfa_required'); expect(f.calls).toHaveLength(0);
  });
});

describe('endSupportSession (SP8)', () => {
  const active = (o: Record<string, unknown> = {}) => srow({ id: SID, status: 'active', started_at: mins(-5), expires_at: mins(25), platform_session_id: PSESSION, ...o });
  it('active -> ended (ended_by_staff, ended_at now, ended_by caller); unbinds; access-log support_session.close in scope', async () => {
    const { svc, ctx, f, scopes } = setup({ rows: [active()] });
    const r = await svc.endSupportSession(ctx, { supportSessionId: SID });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ support_session_id: SID, status: 'ended', end_reason: 'ended_by_staff', ended_at: NOW.toISOString() }); expect(hasNull(r.body)).toBe(false);
    expect(f.binding.get(PSESSION)).toBeNull(); expect(f.rows[0]).toMatchObject({ status: 'ended', ended_by: STAFF_USER }); expect(scopes).toEqual([TENANT_A]);
    expect(f.logs).toEqual([expect.objectContaining({ tenantId: TENANT_A, action: 'support_session.close', entityType: 'support_session', entityId: SID })]);
  });
  it('works for the caller whose claims are scope=support right now (actor.supportSessionId set) - the very state endSupportSession exists for', async () => {
    const { svc, ctx } = setup({ rows: [active()] }, { actor: { type: 'user', id: STAFF_USER, supportSessionId: SID } });
    expect((await svc.endSupportSession(ctx, { supportSessionId: SID })).body.status).toBe('ended');
  });
  it('only the owner ends it: another staff member -> 403 auth.forbidden, still active and bound', async () => {
    const { svc, ctx, f } = setup({ rows: [active({ platform_staff_id: OTHER_STAFF_ID })] });
    expect(await code(svc.endSupportSession(ctx, { supportSessionId: SID }))).toBe('auth.forbidden'); expect(f.rows[0]!.status).toBe('active'); expect(f.by('bindPlatformSession')).toHaveLength(0);
  });
  it.each(['ended', 'expired', 'revoked', 'denied', 'requested', 'approved'] as const)('a %s session cannot be ended again -> 409 common.version_conflict; no unbind, no access-log', async (status) => {
    const { svc, ctx, f } = setup({ rows: [active({ status })] });
    expect(await code(svc.endSupportSession(ctx, { supportSessionId: SID }))).toBe('common.version_conflict'); expect(f.by('bindPlatformSession')).toHaveLength(0); expect(f.logs).toHaveLength(0);
  });
  it('unknown id -> 404; malformed id -> 400; aal1 -> mfa_required', async () => {
    const t = setup({ rows: [active()] }); expect(await code(t.svc.endSupportSession(t.ctx, { supportSessionId: SID2 }))).toBe('common.not_found');
    expect(await code(t.svc.endSupportSession(t.ctx, { supportSessionId: '1; DROP TABLE x' }))).toBe('common.validation_failed');
    const u = setup({ rows: [active()] }, { aal: 'aal1' }); expect(await code(u.svc.endSupportSession(u.ctx, { supportSessionId: SID }))).toBe('auth.mfa_required');
  });
});

describe('expiry is enforced by time, not by a flag (AC-E4.5, SP9)', () => {
  it('opening at T with 30 min: expires_at = T+30min exactly; a later clock does not extend it (activate recomputes from ITS now)', async () => {
    const { svc, ctx } = setup({ rows: [srow({ id: SID, status: 'approved', decided_at: NOW, duration_minutes: 45 })] });
    const later = { ...ctx, now: () => mins(10) }; const r = await svc.activateSupportSession(later, { supportSessionId: SID, expectedVersion: 1 });
    expect(r.body.started_at).toBe(mins(10).toISOString()); expect(r.body.expires_at).toBe(mins(55).toISOString());
  });
  it('ending a session whose expires_at already passed but was not yet swept by the cron still ends it as ended (idempotent for the operator) or conflicts - never reopens it', async () => {
    const { svc, ctx, f } = setup({ rows: [srow({ id: SID, status: 'active', started_at: mins(-40), expires_at: mins(-10), platform_session_id: PSESSION })] });
    const out = await svc.endSupportSession(ctx, { supportSessionId: SID }).then((r: any) => r.body.status, (e: any) => e.code);
    expect(['ended', 'expired', 'common.version_conflict']).toContain(out); expect(f.rows[0]!.status).not.toBe('active');
  });
});

describe('listPlatformSupportSessions (platform.tenant.read)', () => {
  const rows = () => [srow({ id: SID, tenant_id: TENANT_A, status: 'active' }), srow({ id: SID2, tenant_id: TENANT_B, status: 'requested', platform_staff_id: OTHER_STAFF_ID })];
  it('200 SupportSessionPage {data, page}; filters tenant_id / status / platform_staff_id reach the repo 1:1; both roles may list', async () => {
    for (const role of ['platform_support', 'platform_superadmin']) {
      const { svc, ctx, f } = setup({ rows: rows() }, { platformRole: role });
      const r = await svc.listPlatformSupportSessions(ctx, { tenantId: TENANT_B, status: 'requested', platformStaffId: OTHER_STAFF_ID });
      expect(r.status).toBe(200); expect(r.body.data.map((x: any) => x.support_session_id)).toEqual([SID2]); expect(typeof r.body.page).toBe('object');
      expect(f.by('list')[0]!.args[0]).toMatchObject({ tenantId: TENANT_B, status: 'requested', platformStaffId: OTHER_STAFF_ID });
      for (const row of r.body.data) { for (const k of Object.keys(row)) expect(SCHEMA_KEYS).toContain(k); expect(hasNull(row)).toBe(false); }
    }
  });
  it('no filters -> all tenants\' rows (platform view); no withTenantScope is entered for a read', async () => {
    const { svc, ctx, scopes } = setup({ rows: rows() }); const r = await svc.listPlatformSupportSessions(ctx, {});
    expect(r.body.data).toHaveLength(2); expect(scopes).toEqual([]);
  });
  it.each([['status', 'open'], ['status', 'ACTIVE'], ['status', '__proto__'], ['tenantId', 'x'], ['platformStaffId', "1' OR '1'='1"], ['limit', 0], ['limit', 201], ['limit', 1.5]])('invalid %s=%j -> 400 common.validation_failed, repo untouched', async (k, v) => {
    const { svc, ctx, f } = setup({ rows: rows() });
    expect(await code(svc.listPlatformSupportSessions(ctx, { [k]: v }))).toBe('common.validation_failed'); expect(f.calls).toHaveLength(0);
  });
  it('tenant-user context -> auth.forbidden; aal1 -> mfa_required (read is privileged too)', async () => {
    const a = setup({ rows: rows() }, { platformRole: undefined }); expect(await code(a.svc.listPlatformSupportSessions(a.ctx, {}))).toBe('auth.forbidden');
    const b = setup({ rows: rows() }, { aal: 'aal1' }); expect(await code(b.svc.listPlatformSupportSessions(b.ctx, {}))).toBe('auth.mfa_required');
    expect(a.f.calls).toHaveLength(0); expect(b.f.calls).toHaveLength(0);
  });
});
