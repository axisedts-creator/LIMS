// T4 claims/resolver.ts — 02-TRD §6.1/§6.2 (CR-C2-005; 08 R10, A12.1, A15.1, A20.1). ACs: AC-A4.1, AC-A5.1, AC-A5.2, AC-B4.1, US-E2, US-E6.
// ASSUMED API (spec fixes no factory name; implementer matches or raises a CR/dispute):
//   export function createClaimsResolver(deps: { db: { identityAuthTx(input, fn): Promise<T> }; now?: () => Date }): ClaimsResolver  // 02-TRD §6.1 ClaimsResolver
//   - exactly ONE db.identityAuthTx per resolve() ("one DB round trip"), input.operation = { module: 'identity', operationId: 'resolveSession' }
//     (in core IDENTITY_AUTH_OPS), input.requestId / input.clientIp copied from the request; `now` defaults to new Date().
//   - the tx runs ONE query: app.identity_resolve_session($1, $2) with values [jwt.sessionId, jwt.sub] (see sessions.repo.test.ts).
//   - DB errors propagate (reject); the resolver never fabricates claims.
import { describe, expect, it } from 'vitest';
import { createClaimsResolver } from '../resolver.js';
import { buildDbClaims } from '../../../../core/auth/claims.js';
import { IDENTITY_AUTH_OPS } from '../../../../core/db/allowlists.js';
import { ID, NOW, fakeDb, jwt, mins, partnerRow, patientRow, platformRow, req, staffMobileRow, supportRow, tenantRow, type Row } from './helpers.js';

const run = async (rows: Row[], j: Record<string, unknown> = {}, r: Record<string, unknown> = {}) => {
  const f = fakeDb(rows);
  const out: any = await createClaimsResolver({ db: f.db as never, now: () => NOW }).resolve(jwt(j) as never, req(r) as never);
  return { out, ...f };
};
const rejected = (out: any, code: string) => expect(out).toEqual({ kind: 'rejected', code });
const claims = (out: any) => JSON.parse(out.claimsJson);
// tenant-bound request context per session kind
const CTX: Record<string, Record<string, unknown>> = {
  tenant_staff: {}, staff_mobile: { endpointFamily: 'mobile', bffKey: undefined }, partner: { endpointFamily: 'partner', bffKey: 'partner' },
  patient: { endpointFamily: 'patient', bffKey: undefined },
};
const ROW: Record<string, (o?: Row) => Row> = { tenant_staff: tenantRow, staff_mobile: staffMobileRow, partner: partnerRow, patient: patientRow };

describe('one DB round trip through the identity-auth transaction (§6.2 step 1)', () => {
  it('calls identityAuthTx exactly once with the resolveSession operation and the request context', async () => {
    const { txCalls, queries } = await run([tenantRow()]);
    expect(txCalls).toHaveLength(1);
    expect(txCalls[0].operation).toMatchObject({ module: 'identity', operationId: 'resolveSession' });
    expect(IDENTITY_AUTH_OPS).toContain('resolveSession');
    expect(txCalls[0].requestId).toBe(ID.req);
    expect(txCalls[0].clientIp).toBe('203.0.113.7');
    expect(queries).toHaveLength(1);
  });
  it('a rejected outcome also costs one round trip', async () => {
    const { txCalls } = await run([tenantRow({ revoked_at: mins(-1) })]);
    expect(txCalls).toHaveLength(1);
  });
  it('DB failure rejects the promise (fail closed, no claims)', async () => {
    const f = fakeDb(new Error('connection terminated'));
    await expect(createClaimsResolver({ db: f.db as never, now: () => NOW }).resolve(jwt() as never, req() as never)).rejects.toThrow();
  });
});

describe('rejection branches (§6.2 step 2)', () => {
  it('no row -> auth.unauthenticated (unknown session, or wrong sub: the DEFINER filters on both)', async () => {
    rejected((await run([])).out, 'auth.unauthenticated');
  });
  it('AC-A5.1 / AC-A5.2: revoked_at set -> auth.session_expired (logout and remote revoke, next request)', async () => {
    rejected((await run([tenantRow({ revoked_at: mins(-3) })])).out, 'auth.session_expired');
  });
  it('AC-A4.1: idle timeout elapsed -> auth.session_expired; boundary now == idle_expires_at is expired (>=)', async () => {
    rejected((await run([tenantRow({ idle_expires_at: mins(-15) })])).out, 'auth.session_expired');
    rejected((await run([tenantRow({ idle_expires_at: NOW })])).out, 'auth.session_expired');
    expect((await run([tenantRow({ idle_expires_at: new Date(NOW.getTime() + 1) })])).out.kind).toBe('tenant');
  });
  it('absolute lifetime elapsed -> auth.session_expired; boundary now == absolute_expires_at is expired', async () => {
    rejected((await run([tenantRow({ absolute_expires_at: mins(-1) })])).out, 'auth.session_expired');
    rejected((await run([tenantRow({ absolute_expires_at: NOW })])).out, 'auth.session_expired');
    expect((await run([tenantRow({ absolute_expires_at: new Date(NOW.getTime() + 1) })])).out.kind).toBe('tenant');
  });
  it.each(['suspended', 'offboarded'])('US-E2: tenant status %s (no support session) -> identity.tenant_suspended', async (status) => {
    rejected((await run([tenantRow({ tenant_status: status })])).out, 'identity.tenant_suspended');
  });
  it('AC-B4.1: membership_locked -> auth.account_locked', async () => {
    rejected((await run([tenantRow({ membership_locked: true })])).out, 'auth.account_locked');
  });
  it.each(['invited', 'deactivated', 'suspended', 'pending'])('membership status %s (not active) -> identity.membership_inactive', async (status) => {
    rejected((await run([tenantRow({ membership_status: status })])).out, 'identity.membership_inactive');
  });
  it.each(['tenant_staff', 'staff_mobile', 'partner', 'patient'])('%s sessions get the same tenant/lock/membership rejections', async (kind) => {
    const mk = ROW[kind]!, c = CTX[kind]!;
    rejected((await run([mk({ tenant_status: 'suspended' })], {}, c)).out, 'identity.tenant_suspended');
    rejected((await run([mk({ membership_locked: true })], {}, c)).out, 'auth.account_locked');
    rejected((await run([mk({ membership_status: 'deactivated' })], {}, c)).out, 'identity.membership_inactive');
    rejected((await run([mk({ revoked_at: mins(-1) })], {}, c)).out, 'auth.session_expired');
    expect((await run([mk()], {}, c)).out.kind).toBe(kind === 'tenant_staff' ? 'tenant' : kind);
  });
  it('precedence follows the §6.2 list: expired > tenant_suspended > account_locked > membership_inactive', async () => {
    const all = { revoked_at: mins(-1), tenant_status: 'suspended', membership_locked: true, membership_status: 'invited' };
    rejected((await run([tenantRow(all)])).out, 'auth.session_expired');
    rejected((await run([tenantRow({ ...all, revoked_at: null })])).out, 'identity.tenant_suspended');
    rejected((await run([tenantRow({ ...all, revoked_at: null, tenant_status: 'active' })])).out, 'auth.account_locked');
    rejected((await run([tenantRow({ ...all, revoked_at: null, tenant_status: 'active', membership_locked: false })])).out, 'identity.membership_inactive');
  });
  it('a rejected result carries no claimsJson / tenant data (nothing for core to forward)', async () => {
    const { out } = await run([tenantRow({ membership_locked: true })]);
    expect(Object.keys(out).sort()).toEqual(['code', 'kind']);
  });
});

describe('US-E6 platform IP allowlist (§6.2 step 2, last branch)', () => {
  const ip = (cidrs: string[] | null, clientIp: string) => run([platformRow({ platform_allowed_cidrs: cidrs })], {}, { clientIp });
  it('IP outside a non-empty allowlist -> identity.platform_ip_denied', async () => {
    rejected((await ip(['198.51.100.0/24'], '203.0.113.7')).out, 'identity.platform_ip_denied');
    rejected((await ip(['198.51.100.0/24', '192.0.2.8/32'], '192.0.2.9')).out, 'identity.platform_ip_denied');
  });
  it('IP inside any entry passes (v4 /24 edges, /32, v6)', async () => {
    expect((await ip(['198.51.100.0/24'], '198.51.100.0')).out.kind).toBe('platform');
    expect((await ip(['198.51.100.0/24'], '198.51.100.255')).out.kind).toBe('platform');
    expect((await ip(['10.0.0.0/8', '192.0.2.8/32'], '192.0.2.8')).out.kind).toBe('platform');
    expect((await ip(['2001:db8::/32'], '2001:db8:1::5')).out.kind).toBe('platform');
  });
  it('/24 neighbours are denied; a v6 client never matches a v4-only list', async () => {
    rejected((await ip(['198.51.100.0/24'], '198.51.101.0')).out, 'identity.platform_ip_denied');
    rejected((await ip(['198.51.100.0/24'], '2001:db8::1')).out, 'identity.platform_ip_denied');
  });
  it('empty allowlist = no restriction (when non-empty only)', async () => {
    expect((await ip([], '203.0.113.7')).out.kind).toBe('platform');
  });
  it('the allowlist also binds a platform session that holds a support session', async () => {
    const out = (await run([supportRow({ platform_allowed_cidrs: ['198.51.100.0/24'] })], {}, { clientIp: '203.0.113.7' })).out;
    rejected(out, 'identity.platform_ip_denied');
  });
  it('an unparsable client IP against a non-empty allowlist is denied (fail closed), not thrown', async () => {
    const out = (await ip(['198.51.100.0/24'], 'not-an-ip')).out;
    rejected(out, 'identity.platform_ip_denied');
  });
  it('platform session whose platform_staff row is not active/found (role null) is rejected, never platform claims', async () => {
    const out = (await run([platformRow({ platform_role: null, platform_staff_id: ID.staff })])).out;
    expect(out.kind).toBe('rejected');
  });
  it('the allowlist is not applied to tenant sessions', async () => {
    expect((await run([tenantRow({ platform_allowed_cidrs: ['198.51.100.0/24'] })])).out.kind).toBe('tenant');
  });
});

describe('support sessions and tenant status (§6.2 step 2; 05-SCHEMA §6, 08 A20.1)', () => {
  it('platform support session on a suspended tenant is NOT tenant_suspended (diagnosis; scope enforced at open time)', async () => {
    const { out } = await run([supportRow({ support_tenant_status: 'suspended' })]);
    expect(out.kind).toBe('platform');
    expect(claims(out).scope).toBe('support');
  });
  it('platform session whose support session ended/expired (support_* NULL) resolves as platform without support', async () => {
    const c = claims((await run([platformRow()])).out);
    expect(c.scope).toBe('platform');
    expect(c).not.toHaveProperty('support_session_id');
  });
});

describe('claims JSON per kind (§6.2 step 3) — exact key sets, snake_case, values from the DB row / verified JWT only', () => {
  it('tenant staff', async () => {
    const { out } = await run([tenantRow({ state: 'mfa_pending' })]);
    expect(out.kind).toBe('tenant');
    expect(claims(out)).toEqual({
      sub: ID.sub, tenant_id: ID.tenant, membership_id: ID.membership, actor_type: 'user', aal: 'aal1', lims_session_id: ID.session, session_state: 'mfa_pending',
    });
    expect(out.tenantId).toBe(ID.tenant);
    expect(out.sessionState).toBe('mfa_pending');
    expect(out.actor).toBeDefined();
  });
  it('lims_session_id is identity.sessions.id (row.session_id), not the GoTrue session id', async () => {
    expect(claims((await run([tenantRow()])).out).lims_session_id).toBe(ID.session);
    expect(ID.session).not.toBe(ID.gotrue);
  });
  it('platform without support: no tenant_id, no membership_id', async () => {
    const { out } = await run([platformRow()]);
    expect(out.kind).toBe('platform');
    expect(out.platformRole).toBe('platform_support');
    expect(claims(out)).toEqual({
      sub: ID.sub, actor_type: 'user', scope: 'platform', platform_staff_id: ID.staff, platform_role: 'platform_support', aal: 'aal1', lims_session_id: ID.session,
    });
  });
  it('platform with active support session: target tenant, no membership_id (centre scope fail-closed)', async () => {
    const { out } = await run([supportRow()]);
    expect(out.kind).toBe('platform');
    expect(claims(out)).toEqual({
      sub: ID.sub, tenant_id: ID.supportTenant, actor_type: 'user', scope: 'support', support_session_id: ID.support, support_scope: 'read_only',
      platform_staff_id: ID.staff, aal: 'aal1', lims_session_id: ID.session,
    });
  });
  it('support scope admin is passed through verbatim', async () => {
    expect(claims((await run([supportRow({ support_scope: 'admin' })])).out).support_scope).toBe('admin');
  });
  it('partner: partner_role from the DEFINER output (08 A28.3), actor_type partner', async () => {
    const { out } = await run([partnerRow({ partner_role: 'partner_staff' })], {}, CTX.partner);
    expect(out.kind).toBe('partner');
    expect(claims(out)).toEqual({
      sub: ID.sub, tenant_id: ID.tenant, membership_id: ID.membership, actor_type: 'partner', partner_role: 'partner_staff', aal: 'aal1', lims_session_id: ID.session,
      session_state: 'active',
    });
  });
  it('patient: aal is always aal1 and session_state always active; no partner_role', async () => {
    const { out } = await run([patientRow({ session_aal: 'aal2', state: 'mfa_pending' })], { aal: 'aal2' }, CTX.patient);
    expect(out.kind).toBe('patient');
    expect(claims(out)).toEqual({
      sub: ID.sub, tenant_id: ID.tenant, membership_id: ID.membership, actor_type: 'patient', aal: 'aal1', lims_session_id: ID.session, session_state: 'active',
    });
  });
  it('staff_mobile: same claim shape as tenant staff (08 R10), kind staff_mobile', async () => {
    const { out } = await run([staffMobileRow()], {}, CTX.staff_mobile);
    expect(out.kind).toBe('staff_mobile');
    expect(claims(out)).toEqual({
      sub: ID.sub, tenant_id: ID.tenant, membership_id: ID.membership, actor_type: 'user', aal: 'aal1', lims_session_id: ID.session, session_state: 'active',
    });
  });
  it('claimsJson is accepted by the core buildDbClaims and a fresh string per call', async () => {
    const a = (await run([tenantRow()])).out, b = (await run([tenantRow()])).out;
    expect(buildDbClaims(a).tenant_id).toBe(ID.tenant);
    expect(buildDbClaims(a)).not.toBe(buildDbClaims(b));
  });
  it('sub always comes from the verified JWT, never from request context', async () => {
    const other = '01a1a98a-ac40-7000-8000-0000000000ff';
    const c = claims((await run([tenantRow()], { sub: other })).out);
    expect(c.sub).toBe(other);
  });
});

describe('aal: from the verified JWT, lowest wins (§6.2 step 4)', () => {
  it('DB aal2 + JWT aal1 -> aal1', async () => {
    expect(claims((await run([tenantRow({ session_aal: 'aal2' })], { aal: 'aal1' })).out).aal).toBe('aal1');
  });
  it('JWT aal2 + DB aal1 -> aal1 (lowest wins)', async () => {
    expect(claims((await run([tenantRow({ session_aal: 'aal1' })], { aal: 'aal2' })).out).aal).toBe('aal1');
  });
  it('both aal2 -> aal2; both aal1 -> aal1', async () => {
    expect(claims((await run([tenantRow({ session_aal: 'aal2' })], { aal: 'aal2' })).out).aal).toBe('aal2');
    expect(claims((await run([tenantRow({ session_aal: 'aal1' })], { aal: 'aal1' })).out).aal).toBe('aal1');
  });
  it('platform sessions: DB aal2 + JWT aal1 -> aal1', async () => {
    expect(claims((await run([platformRow({ session_aal: 'aal2' })], { aal: 'aal1' })).out).aal).toBe('aal1');
  });
});

describe('session-kind check against BFF key / endpoint family (§6.2 step 3, last bullet)', () => {
  const FAMILY: Record<string, string> = { tenant_staff: 'staff', platform: 'staff', partner: 'partner', patient: 'patient', staff_mobile: 'mobile' };
  const mk = (kind: string) => (kind === 'platform' ? platformRow() : ROW[kind]!());
  const KINDS = Object.keys(FAMILY);
  const FAMS = ['staff', 'partner', 'patient', 'mobile'];
  const pairs = KINDS.flatMap((k) => FAMS.map((f): [string, string, boolean] => [k, f, FAMILY[k] === f]));
  it.each(pairs)('session kind %s on endpoint family %s -> %s', async (kind, fam, ok) => {
    const bffKey = fam === 'staff' ? 'staff_web' : fam === 'partner' ? 'partner' : undefined;
    const { out } = await run([mk(kind)], {}, { endpointFamily: fam, bffKey });
    if (ok) expect(out.kind).not.toBe('rejected');
    else rejected(out, 'auth.session_expired');
  });
  it.each(KINDS)('endpointFamily api (module API call): %s is accepted; kind only shapes the claims', async (kind) => {
    const { out } = await run([mk(kind)], {}, { endpointFamily: 'api', bffKey: undefined });
    expect(out.kind).not.toBe('rejected');
  });
  it('partner BFF key with a tenant_staff session -> auth.session_expired', async () => {
    rejected((await run([tenantRow()], {}, { endpointFamily: 'partner', bffKey: 'partner' })).out, 'auth.session_expired');
  });
  it('staff_web BFF key with a partner session -> auth.session_expired', async () => {
    rejected((await run([partnerRow()], {}, { endpointFamily: 'staff', bffKey: 'staff_web' })).out, 'auth.session_expired');
  });
  it.each(['staff', 'partner', 'patient', 'mobile'])('bffKey portal on identity family %s -> auth.unauthenticated (08 A13 D-32)', async (fam) => {
    const kind = Object.keys(FAMILY).find((k) => FAMILY[k] === fam)!;
    rejected((await run([mk(kind)], {}, { endpointFamily: fam, bffKey: 'portal' })).out, 'auth.unauthenticated');
  });
  it('a kind-matched session with staff_web key resolves', async () => {
    expect((await run([tenantRow()])).out.kind).toBe('tenant');
  });
});

describe('time source and untrusted input', () => {
  it('uses the injected clock for idle/absolute checks (no wall-clock dependence)', async () => {
    const f = fakeDb([tenantRow({ idle_expires_at: mins(10) })]);
    const later = createClaimsResolver({ db: f.db as never, now: () => mins(10) });
    rejected(await later.resolve(jwt() as never, req() as never), 'auth.session_expired');
  });
  it('defaults to the real clock when no `now` is injected', async () => {
    const f = fakeDb([tenantRow({ idle_expires_at: new Date(Date.now() + 3_600_000), absolute_expires_at: new Date(Date.now() + 7_200_000) })]);
    expect((await createClaimsResolver({ db: f.db as never }).resolve(jwt() as never, req() as never)).kind).toBe('tenant');
  });
  it('only the typed ClaimsRequest fields influence the outcome: extra request props are ignored', async () => {
    const out: any = (await run([tenantRow()], {}, { tenant_id: ID.supportTenant, scope: 'platform', headers: { 'x-tenant-id': 'evil' } })).out;
    expect(claims(out).tenant_id).toBe(ID.tenant);
    expect(claims(out)).not.toHaveProperty('scope');
  });
  it('a hostile display-like string in the row cannot break the JSON or add claims', async () => {
    const evil = '","scope":"platform","tenant_id":"x';
    const c = claims((await run([tenantRow({ state: evil })])).out);
    expect(c.scope).toBeUndefined();
    expect(c.tenant_id).toBe(ID.tenant);
  });
});

describe('overhead budget (02-TRD §6.2 p95 <= 3 ms [CONV]; local bench, fake DB)', () => {
  it('resolver CPU overhead p95 <= 1 ms over 2000 calls (the 3 ms budget is mostly the DB round trip)', async () => {
    const f = fakeDb([tenantRow()]);
    const r = createClaimsResolver({ db: f.db as never, now: () => NOW });
    const j = jwt() as never, q = req() as never;
    for (let i = 0; i < 200; i++) await r.resolve(j, q); // warm-up
    const t: number[] = [];
    for (let i = 0; i < 2000; i++) { const s = performance.now(); await r.resolve(j, q); t.push(performance.now() - s); }
    t.sort((a, b) => a - b);
    expect(t[Math.floor(t.length * 0.95)]!).toBeLessThanOrEqual(1);
  });
});
