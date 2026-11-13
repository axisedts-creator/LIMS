// C13 T06 — partner users (partner admin + staff). Plan row T06; tests: unit + integration + probes. ACs: US-02.1–US-02.7 (+ 07-SECURITY ST2, ST8, AB12).
// done_when: provisioning in same tx (port throws -> no partner_users row); last-admin + self-action guards; aal1 -> mfa_required;
//   U3-U5/SA10 If-Match = partner_users.version, row locked FOR UPDATE, port called without expectedVersion, returned status stored (08 A19 D-100);
//   member under partner claims cannot write another user's row (trigger guard_partner_users, D-103).
// Spec: 02-TRD §5.2 U1-U6, §5.3 SA8-SA10, §4.8; 03-APP-FLOW §2.5, §4.8; 05-SCHEMA §3.2; contracts/openapi/partners.yaml (listPartnerUsers ... reactivatePartnerUserByStaff).
// Handlers are exercised through manifest.handlers[operationId] (file names of handlers are the writer's choice).
// SEAMS (spec does not fix them; writer follows or disputes):
//  - SQL: single-table statements on partners.partner_users / partners.partners with `$n` params (see partner-user.world.ts header); no JOIN.
//  - partnerContext.require(ctx) from ../service/partner-context.service.js (T03) is the only source of the caller's partner/role in U1-U6 (faked here).
//  - Order: actor type -> IdentityPort.assertRole -> partnerContext.require -> body/If-Match validation -> lock row -> guards -> port -> store.
//  - If-Match header form `"<version>"` (02-CV §4.2): absent 428 common.precondition_required, malformed 400 common.validation_failed, stale 409 common.version_conflict.
//  - Row not visible / other partner / other tenant -> 404 common.not_found. Unknown body key -> 400 common.validation_failed (or ignored; never used).
//  - Last-admin decisions are serialised per partner (lock all admin rows, the partners row, or pg_advisory_xact_lock) before the port call — tester-derived
//    from the "A demotes B while B demotes A" race; not spelled out in the TRD.
//  - PartnerUser DTO `mfa_enrolled`/`last_login_at` source is not specified (spec gap): only the key allowlist and boolean type are asserted.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { manifest } from '../index.js';
import { id, M, makeCtx, makeWorld, NOW, P, T_A, T_B, U, type Opts, type Who, type World } from './partner-user.world.js';

const hoisted = vi.hoisted(() => ({ require: undefined as undefined | ((ctx: any) => Promise<unknown>) }));
vi.mock('../service/partner-context.service.js', () => ({
  partnerContext: { require: (c: unknown) => hoisted.require!(c), load: (c: unknown) => hoisted.require!(c) },
}));

const DTO_KEYS = ['id', 'display_name', 'email_masked', 'partner_role', 'status', 'mfa_enrolled', 'last_login_at', 'version'];
const DTO_REQUIRED = ['id', 'display_name', 'email_masked', 'partner_role', 'status', 'mfa_enrolled', 'version'];
const CLEAR_EMAIL = 'Invitee.One@Partner-X.invalid';
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const req = (o: Partial<{ params: object; query: object; headers: object; body: unknown }> = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });

async function call(w: World, op: string, who: Who, r: ReturnType<typeof req>, over: Opts = {}) {
  const { ctx } = makeCtx(w, who, (fn) => { hoisted.require = fn; }, over);
  const snap = w.snapshot();
  try {
    return (await manifest.handlers[op]!(r as any, ctx)) as { status: number; body: any };
  } catch (e) { w.restore(snap); throw e; } // the pipeline rolls the request tx back on any error
}
async function fails(p: Promise<unknown>, code: string, status?: number) {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e, String(e?.message)).toBeInstanceOf(LimsError);
  expect(e.code).toBe(code);
  if (status) expect(e.statusCode).toBe(status);
  return e as LimsError;
}
const untouched = (w: World) => { expect(w.writes()).toEqual([]); expect(w.portWrites().map((c) => c.name)).toEqual([]); };
const noSql = (w: World) => expect(w.sql).toEqual([]);
const dtoOk = (b: any) => {
  expect(Object.keys(b).every((k) => DTO_KEYS.includes(k)), JSON.stringify(Object.keys(b))).toBe(true);
  for (const k of DTO_REQUIRED) expect(b, k).toHaveProperty(k);
  expect(typeof b.mfa_enrolled).toBe('boolean');
};
const row = (w: World, k: string) => w.users.find((u) => u.id === U[k])!;
const retire = (w: World, k: string) => { const r = row(w, k); r.status = 'deactivated'; r.deactivated_at = NOW; w.memberships.get(r.membership_id)!.status = 'deactivated'; };
const locks = (w: World) => w.events.findIndex((e) => /^SQL .*FROM partners\.partner_users[\s\S]*FOR UPDATE/i.test(e));

describe('T06 wiring', () => {
  it('service file exists and the 11 user operations are implemented (not stubs)', () => {
    expect(existsSync(join(__dirname, '..', 'service', 'partner-user.service.ts'))).toBe(true);
  });
  it('static: SQL is parameterised (no template-literal interpolation in query text), no commitOnError', () => {
    const src = readFileSync(join(__dirname, '..', 'service', 'partner-user.service.ts'), 'utf8');
    expect(/query\(\s*`[^`]*\$\{/.test(src)).toBe(false);
    expect(src).not.toContain('commitOnError');
    expect(src).not.toMatch(/console\.(log|info|debug)/);
  });
});

// ------------------------------------------------------------------ U2 / SA9 invite
describe.each([
  ['U2 invitePartnerUser (partner admin)', 'invitePartnerUser', 'adminX', {}, 'partner'],
  ['SA9 invitePartnerUserByStaff (staff)', 'invitePartnerUserByStaff', 'staff', { partner_id: P.X }, 'user'],
] as const)('T06 %s', (_n, op, who, params, inviter) => {
  const body = (o: object = {}) => ({ email: CLEAR_EMAIL, display_name: 'Invitee One', partner_role: 'partner_member', ...o });

  it('US-02.1/02.2: 201 PartnerUser(invited); membership from the port stored for partner X only; port first, in the caller tx', async () => {
    const w = makeWorld();
    const r = await call(w, op, who, req({ params, body: body() }));
    expect(r.status).toBe(201);
    dtoOk(r.body);
    expect(r.body).toMatchObject({ display_name: 'Invitee One', partner_role: 'partner_member', status: 'invited', version: 1 });
    const prov = w.portCalls.filter((c) => c.name === 'provisionPartnerMembership');
    expect(prov).toHaveLength(1);
    expect(prov[0]!.input).toMatchObject({ displayName: 'Invitee One', partnerRole: 'partner_member' });
    expect(String(prov[0]!.input.email).toLowerCase()).toBe(CLEAR_EMAIL.toLowerCase());
    expect(Object.keys(prov[0]!.input).sort()).toEqual(['displayName', 'email', 'partnerRole']); // no partner id / tenant: C2 never trusts one from HTTP
    const created = w.users.find((u) => u.id === r.body.id)!;
    expect(created).toMatchObject({ tenant_id: T_A, partner_id: P.X, partner_role: 'partner_member', status: 'invited', invited_by_actor_type: inviter, activated_at: null });
    expect([...w.memberships.keys()]).toContain(created.membership_id);
    expect(w.events.findIndex((e) => e.startsWith('PORT provision'))).toBeLessThan(w.events.findIndex((e) => /^SQL INSERT INTO partners\.partner_users/i.test(e)));
  });

  it('the port receives the request ctx itself (same transaction), never a separate tx', async () => {
    const w = makeWorld();
    const { ctx } = makeCtx(w, who, (fn) => { hoisted.require = fn; });
    await manifest.handlers[op]!(req({ params, body: body() }) as any, ctx);
    expect(w.portCalls.find((c) => c.name === 'provisionPartnerMembership')!.ctxArg.tx).toBe(ctx.tx);
  });

  it('PHI: the clear e-mail goes only to the port; row holds a masked address; nothing leaks to SQL values, logs or the response', async () => {
    const w = makeWorld();
    const r = await call(w, op, who, req({ params, body: body() }));
    const hay = JSON.stringify([w.sql, w.logs, r.body]).toLowerCase();
    expect(hay).not.toContain('invitee.one');
    expect(hay).not.toContain('partner-x.invalid');
    const masked: string = w.users.find((u) => u.id === r.body.id)!.email_masked;
    expect(masked.length).toBeGreaterThanOrEqual(3);
    expect(masked.length).toBeLessThanOrEqual(64);
    expect(masked).toMatch(/^.\*+@/);
    expect(r.body.email_masked).toBe(masked);
  });

  it('done_when rollback: port throws -> rejects with its error, NO partner_users INSERT is attempted, no row', async () => {
    const w = makeWorld();
    const before = w.users.length;
    for (const err of [new LimsError('identity.user_exists'), new LimsError('identity.tenant_suspended'), new Error('boom')]) {
      const p = call(w, op, who, req({ params, body: body() }), { provisionError: err });
      await expect(p).rejects.toBe(err);
      expect(w.users).toHaveLength(before);
      expect(w.writes()).toEqual([]);
    }
  });

  it('insert fails after the port succeeded -> error surfaces (not swallowed) and the request tx rolls everything back (no orphan membership)', async () => {
    const w = makeWorld();
    const before = { users: w.users.length, memberships: w.memberships.size };
    await expect(call(w, op, who, req({ params, body: body() }), { failInsert: true })).rejects.toMatchObject({ message: 'injected insert failure' });
    expect(w.portCalls.filter((c) => c.name === 'provisionPartnerMembership')).toHaveLength(1); // port ran, then the INSERT was attempted
    expect(w.sql.some((q) => /^\s*INSERT\s+INTO\s+partners\.partner_users/i.test(q.text))).toBe(true);
    expect(w.users).toHaveLength(before.users);
    expect(w.memberships.size).toBe(before.memberships);
    expect(w.emails.size).toBe(0);
  });

  it('duplicate e-mail (any case) -> 409 identity.user_exists; exactly one partner_users row for it', async () => {
    const w = makeWorld();
    await call(w, op, who, req({ params, body: body() }));
    const n = w.users.length;
    await fails(call(w, op, who, req({ params, body: body({ email: CLEAR_EMAIL.toUpperCase() }) })), 'identity.user_exists', 409);
    expect(w.users).toHaveLength(n);
  });

  it.each([
    ['role lab_admin', { partner_role: 'lab_admin' }], ['role platform_admin', { partner_role: 'platform_admin' }], ['role empty', { partner_role: '' }],
    ['role missing', { partner_role: undefined }], ['email missing', { email: undefined }], ['email not an address', { email: 'not-an-email' }],
    ['email > 254', { email: `${'a'.repeat(250)}@x.invalid` }], ['display_name empty', { display_name: '' }], ['display_name 121', { display_name: 'n'.repeat(121) }],
    ['display_name missing', { display_name: undefined }], ['unknown key tenant_id', { tenant_id: T_B }],
  ])('validation: %s -> 400 common.validation_failed, nothing written, port not called', async (_l, o) => {
    const w = makeWorld();
    await fails(call(w, op, who, req({ params, body: body(o) })), 'common.validation_failed', 400);
    untouched(w);
  });

  it('US-02.2 / REQ-SEC-080: a partner_id of Y in the body is rejected (400) or ignored — never used; no row for Y', async () => {
    const w = makeWorld();
    const out = await call(w, op, who, req({ params, body: body({ partner_id: P.Y }) })).then((r) => r, (e) => e);
    if (out instanceof Error) expect((out as LimsError).code).toBe('common.validation_failed');
    else expect(w.users.find((u) => u.id === out.body.id)!.partner_id).toBe(P.X);
    expect(w.users.some((u) => u.partner_id === P.Y && u.display_name === 'Invitee One')).toBe(false);
  });

  it('SQL-injection-shaped display_name is stored via parameters only', async () => {
    const w = makeWorld();
    const evil = "x'); DROP TABLE partners.partner_users;--";
    const r = await call(w, op, who, req({ params, body: body({ display_name: evil }) }));
    expect(r.body.display_name).toBe(evil);
    for (const q of w.sql) expect(q.text).not.toContain('DROP TABLE');
  });
});

describe('T06 U2 authz (US-02.3, US-02.4, US-02.6, ST8)', () => {
  const b = { email: CLEAR_EMAIL, display_name: 'Invitee One', partner_role: 'partner_member' };
  it('partner member -> 403 auth.forbidden; nothing read or written, port not called', async () => {
    const w = makeWorld();
    await fails(call(w, 'invitePartnerUser', 'memberX', req({ body: b })), 'auth.forbidden', 403);
    untouched(w); noSql(w);
  });
  it('partner admin at aal1 -> 403 auth.mfa_required on every user-management operation (U1-U6), before any SQL', async () => {
    const t = U.memberX!;
    const cases: Array<[string, any]> = [
      ['listPartnerUsers', req()], ['invitePartnerUser', req({ body: b })],
      ['changePartnerUserRole', req({ params: { partner_user_id: t }, headers: ifm(2), body: { partner_role: 'partner_admin' } })],
      ['deactivatePartnerUser', req({ params: { partner_user_id: t }, headers: ifm(2), body: { reason_code: 'left_organisation' } })],
      ['reactivatePartnerUser', req({ params: { partner_user_id: U.deactX! }, headers: ifm(4) })],
      ['resendPartnerInvitation', req({ params: { partner_user_id: U.invitedX! } })],
    ];
    for (const [op, r] of cases) {
      const w = makeWorld();
      await fails(call(w, op, 'adminX', r, { aal: 'aal1' }), 'auth.mfa_required', 403);
      expect(w.assertCalls, op).toEqual(['partners.partner_user.manage']);
      noSql(w); untouched(w);
    }
  });
  it('deactivated admin and admin of a suspended partner -> 403 partners.partner_inactive (US-02.6); nothing written', async () => {
    for (const who of ['adminZ'] as const) {
      const w = makeWorld();
      await fails(call(w, 'invitePartnerUser', who, req({ body: b })), 'partners.partner_inactive', 403);
      untouched(w);
    }
    const w = makeWorld(); retire(w, 'adminX2');
    await fails(call(w, 'listPartnerUsers', 'adminX2', req()), 'partners.partner_inactive', 403);
    untouched(w);
  });
  it('non-partner actors on partner-facing operations -> 403 auth.forbidden before any SQL / membership call', async () => {
    const w = makeWorld();
    for (const op of ['listPartnerUsers', 'invitePartnerUser', 'resendPartnerInvitation']) {
      await fails(call(w, op, 'staff', req({ params: { partner_user_id: U.invitedX! }, body: b })), 'auth.forbidden', 403);
    }
    noSql(w); untouched(w);
  });
});

describe('T06 SA9 invitePartnerUserByStaff authz + partner scoping', () => {
  const b = { email: CLEAR_EMAIL, display_name: 'Invitee One', partner_role: 'partner_admin' };
  it('US-02.1: staff invites a partner_admin for X; permission checked is partners.partner.manage', async () => {
    const w = makeWorld();
    const r = await call(w, 'invitePartnerUserByStaff', 'staff', req({ params: { partner_id: P.X }, body: b }));
    expect(r.status).toBe(201);
    expect(w.assertCalls).toContain('partners.partner.manage');
    expect(r.body.partner_role).toBe('partner_admin');
  });
  it('unknown partner, other-tenant partner -> 404 common.not_found; port not called', async () => {
    const w = makeWorld();
    for (const pid of [id(999), P.B]) {
      await fails(call(w, 'invitePartnerUserByStaff', 'staff', req({ params: { partner_id: pid }, body: b })), 'common.not_found', 404);
    }
    untouched(w);
  });
  it('partner actor -> 403 auth.forbidden; staff without manage -> 403; staff aal1 -> auth.mfa_required; nothing written', async () => {
    const w = makeWorld();
    const r = req({ params: { partner_id: P.X }, body: b });
    await fails(call(w, 'invitePartnerUserByStaff', 'adminX', r), 'auth.forbidden', 403);
    await fails(call(w, 'invitePartnerUserByStaff', 'staffNoManage', r), 'auth.forbidden', 403);
    await fails(call(w, 'invitePartnerUserByStaff', 'staff', r, { aal: 'aal1' }), 'auth.mfa_required', 403);
    untouched(w);
  });
});

// ------------------------------------------------------------------ U1 / SA8 list
describe('T06 U1 listPartnerUsers / SA8 listPartnerUsersForPartner', () => {
  it('U1: admin of X sees exactly X users (any status), DTO allowlist only, page present; Y/Z/tenant-B never (RLS on and off)', async () => {
    for (const rls of [true, false]) {
      const w = makeWorld(); w.rls = rls;
      const r = await call(w, 'listPartnerUsers', 'adminX', req());
      expect(r.status).toBe(200);
      expect(r.body.data.map((d: any) => d.id).sort()).toEqual([U.adminX, U.adminX2, U.memberX, U.invitedX, U.deactX].sort());
      for (const d of r.body.data) dtoOk(d);
      expect(r.body.page).toBeTruthy();
      expect(JSON.stringify(r.body)).not.toMatch(new RegExp(`${M.adminX}|${T_A}|${P.X}|invited_by_actor_type|deactivate_reason_code`));
    }
  });
  it('U1: status filter; invalid status -> 400', async () => {
    const w = makeWorld();
    const r = await call(w, 'listPartnerUsers', 'adminX', req({ query: { status: 'invited' } }));
    expect(r.body.data.map((d: any) => d.id)).toEqual([U.invitedX]);
    await fails(call(w, 'listPartnerUsers', 'adminX', req({ query: { status: 'bogus' } })), 'common.validation_failed', 400);
  });
  it('U1: member -> 403 forbidden (no SQL)', async () => {
    const w = makeWorld();
    await fails(call(w, 'listPartnerUsers', 'memberX', req()), 'auth.forbidden', 403);
    noSql(w);
  });
  it('SA8: staff lists users of the path partner only (partners.partner.read); other tenant / unknown partner -> 404; partner actor -> 403', async () => {
    const w = makeWorld();
    const r = await call(w, 'listPartnerUsersForPartner', 'staff', req({ params: { partner_id: P.Y } }));
    expect(r.body.data.map((d: any) => d.id).sort()).toEqual([U.adminY, U.memberY].sort());
    expect(w.assertCalls).toContain('partners.partner.read');
    await fails(call(w, 'listPartnerUsersForPartner', 'staff', req({ params: { partner_id: P.B } })), 'common.not_found', 404);
    await fails(call(w, 'listPartnerUsersForPartner', 'staff', req({ params: { partner_id: id(999) } })), 'common.not_found', 404);
    await fails(call(w, 'listPartnerUsersForPartner', 'adminX', req({ params: { partner_id: P.X } })), 'auth.forbidden', 403);
  });
});

// ------------------------------------------------------------------ U3-U5 / SA10 shared contract
type Variant = { name: string; who: Who; ops: { role: string; deact: string; react: string }; perm: string };
const VARIANTS: Variant[] = [
  { name: 'partner admin (U3-U5)', who: 'adminX', ops: { role: 'changePartnerUserRole', deact: 'deactivatePartnerUser', react: 'reactivatePartnerUser' }, perm: 'partners.partner_user.manage' },
  { name: 'staff (SA10)', who: 'staff', ops: { role: 'changePartnerUserRoleByStaff', deact: 'deactivatePartnerUserByStaff', react: 'reactivatePartnerUserByStaff' }, perm: 'partners.partner.manage' },
];
const R = (userId: string, v: number | string | undefined, body?: unknown) => req({ params: { partner_user_id: userId }, headers: v === undefined ? {} : ifm(v), body });

describe.each(VARIANTS)('T06 U3-U5 contract — $name', ({ who, ops, perm }) => {
  it('role change: If-Match = partner_users.version; row locked FOR UPDATE before the port; port input has NO expectedVersion; returned status stored; version bumped (D-100)', async () => {
    const w = makeWorld();
    const v0 = row(w, 'invitedX').version;
    const r = await call(w, ops.role, who, R(U.invitedX!, v0, { partner_role: 'partner_admin' }));
    expect(r.status).toBe(200);
    dtoOk(r.body);
    expect(r.body).toMatchObject({ id: U.invitedX, partner_role: 'partner_admin', status: 'invited', version: v0 + 1 });
    const call1 = w.portCalls.find((c) => c.name === 'updatePartnerMembership')!;
    expect(call1.input).toEqual({ membershipId: M.invitedX, action: 'set_role', partnerRole: 'partner_admin' });
    expect('expectedVersion' in call1.input).toBe(false);
    expect(row(w, 'invitedX')).toMatchObject({ partner_role: 'partner_admin', status: 'invited', version: v0 + 1 });
    expect(w.assertCalls).toContain(perm);
    const lockAt = locks(w); const portAt = w.events.findIndex((e) => e.startsWith('PORT updatePartnerMembership'));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(portAt);
    const lockSql = w.sql.find((q) => /FOR\s+UPDATE/i.test(q.text) && /partner_users/i.test(q.text))!;
    expect(lockSql.values).toEqual(expect.arrayContaining([T_A, U.invitedX]));
  });

  it('deactivate: port {action deactivate, reasonCode}, no expectedVersion; stores returned status + reason + deactivated_at/by (CHECK partner_users__deact__ck)', async () => {
    const w = makeWorld();
    const v0 = row(w, 'memberX').version;
    const r = await call(w, ops.deact, who, R(U.memberX!, v0, { reason_code: 'left_organisation' }));
    expect(r.body).toMatchObject({ id: U.memberX, status: 'deactivated', version: v0 + 1 });
    const c = w.portCalls.find((x) => x.name === 'updatePartnerMembership')!;
    expect(c.input).toEqual({ membershipId: M.memberX, action: 'deactivate', reasonCode: 'left_organisation' });
    expect(row(w, 'memberX')).toMatchObject({ status: 'deactivated', deactivate_reason_code: 'left_organisation' });
    expect(row(w, 'memberX').deactivated_at).toBeTruthy();
    expect(row(w, 'memberX').deactivated_by).toBeTruthy();
  });

  it('deactivate: reason_code required (400) and unknown body keys rejected; nothing written', async () => {
    const w = makeWorld();
    await fails(call(w, ops.deact, who, R(U.memberX!, row(w, 'memberX').version, {})), 'common.validation_failed', 400);
    await fails(call(w, ops.deact, who, R(U.memberX!, row(w, 'memberX').version, { reason_code: 'left_organisation', status: 'active' })), 'common.validation_failed', 400);
    untouched(w);
  });

  it('reactivate: stores the status C2 returns (active or invited), clears deactivation columns', async () => {
    for (const st of ['active', 'invited'] as const) {
      const w = makeWorld();
      const v0 = row(w, 'deactX').version;
      const r = await call(w, ops.react, who, R(U.deactX!, v0), { reactivateStatus: st });
      expect(r.body).toMatchObject({ id: U.deactX, status: st, version: v0 + 1 });
      expect(w.portCalls.find((x) => x.name === 'updatePartnerMembership')!.input).toEqual({ membershipId: M.deactX, action: 'reactivate' });
      expect(row(w, 'deactX')).toMatchObject({ status: st, deactivated_at: null, deactivated_by: null, deactivate_reason_code: null });
    }
  });

  it('If-Match: missing -> 428 common.precondition_required; malformed -> 400; stale -> 409 common.version_conflict; nothing written, port not called', async () => {
    const w = makeWorld();
    const v = row(w, 'memberX').version;
    const body = { partner_role: 'partner_admin' };
    await fails(call(w, ops.role, who, R(U.memberX!, undefined, body)), 'common.precondition_required', 428);
    for (const bad of ['abc', '"0"', '"-1"', `${v}`, '"1.5"', '*', '']) await fails(call(w, ops.role, who, R(U.memberX!, bad, body)), 'common.validation_failed', 400);
    await fails(call(w, ops.role, who, R(U.memberX!, v + 1, body)), 'common.version_conflict', 409);
    await fails(call(w, ops.deact, who, R(U.memberX!, v - 1, { reason_code: 'left_organisation' })), 'common.version_conflict', 409);
    await fails(call(w, ops.react, who, R(U.deactX!, row(w, 'deactX').version + 1)), 'common.version_conflict', 409);
    untouched(w);
  });

  it('concurrency: replaying the same If-Match after a success is a version_conflict (stored version moved on)', async () => {
    const w = makeWorld();
    const v = row(w, 'memberX').version;
    await call(w, ops.role, who, R(U.memberX!, v, { partner_role: 'partner_admin' }));
    const n = w.portWrites().length;
    await fails(call(w, ops.role, who, R(U.memberX!, v, { partner_role: 'partner_member' })), 'common.version_conflict', 409);
    expect(w.portWrites()).toHaveLength(n);
    expect(row(w, 'memberX').partner_role).toBe('partner_admin');
  });

  it('role escalation probes: only partner_admin | partner_member accepted (400 otherwise); nothing written', async () => {
    const w = makeWorld();
    for (const role of ['lab_admin', 'platform_admin', 'staff', '', null, 7]) {
      await fails(call(w, ops.role, who, R(U.memberX!, row(w, 'memberX').version, { partner_role: role })), 'common.validation_failed', 400);
    }
    untouched(w);
  });

  it('invalid transitions -> 409 partners.partner_user_invalid_transition without calling the port', async () => {
    const w = makeWorld();
    await fails(call(w, ops.deact, who, R(U.deactX!, row(w, 'deactX').version, { reason_code: 'left_organisation' })), 'partners.partner_user_invalid_transition', 409);
    await fails(call(w, ops.react, who, R(U.memberX!, row(w, 'memberX').version)), 'partners.partner_user_invalid_transition', 409);
    await fails(call(w, ops.role, who, R(U.deactX!, row(w, 'deactX').version, { partner_role: 'partner_admin' })), 'partners.partner_user_invalid_transition', 409);
    untouched(w);
  });

  it('port errors (identity.membership_inactive, common.version_conflict, unexpected) propagate and leave the partner_users row unchanged', async () => {
    for (const err of [new LimsError('identity.membership_inactive'), new LimsError('common.version_conflict'), new Error('boom')]) {
      const w = makeWorld();
      const before = structuredClone(row(w, 'memberX'));
      await expect(call(w, ops.deact, who, R(U.memberX!, before.version, { reason_code: 'left_organisation' }), { updateError: err })).rejects.toBe(err);
      expect(row(w, 'memberX')).toEqual(before);
    }
  });

  it('other tenant\'s user id -> 404 common.not_found (RLS on and off); no port call, no write', async () => {
    for (const rls of [true, false]) {
      const w = makeWorld(); w.rls = rls;
      await fails(call(w, ops.deact, who, R(U.adminB!, row(w, 'adminB').version, { reason_code: 'left_organisation' })), 'common.not_found', 404);
      await fails(call(w, ops.react, who, R(id(998), 1)), 'common.not_found', 404);
      untouched(w);
    }
  });

  it('last-admin decisions are serialised per partner before the port call (A demotes B while B demotes A must not leave 0 admins)', async () => {
    const w = makeWorld();
    await call(w, ops.deact, who, R(U.adminX2!, row(w, 'adminX2').version, { reason_code: 'left_organisation' }));
    const portAt = w.events.findIndex((e) => e.startsWith('PORT updatePartnerMembership'));
    const before = w.events.slice(0, portAt);
    const serial = before.some((e) =>
      (/^SQL .*FROM partners\.partner_users/i.test(e) && /FOR UPDATE/i.test(e) && !/\bid\s*=/i.test(e.replace(/tenant_id|partner_id|membership_id/gi, '')))
      || (/^SQL .*FROM partners\.partners\b/i.test(e) && /FOR UPDATE/i.test(e)) || /pg_advisory_xact_lock/i.test(e));
    expect(serial, before.join('\n')).toBe(true);
  });
});

describe('T06 partner-admin-only guards (U3-U5)', () => {
  it('self-action: admin cannot deactivate or demote themself -> 409 partners.self_action_forbidden (even with other admins); nothing written', async () => {
    const w = makeWorld();
    const v = row(w, 'adminX').version;
    await fails(call(w, 'deactivatePartnerUser', 'adminX', R(U.adminX!, v, { reason_code: 'left_organisation' })), 'partners.self_action_forbidden', 409);
    await fails(call(w, 'changePartnerUserRole', 'adminX', R(U.adminX!, v, { partner_role: 'partner_member' })), 'partners.self_action_forbidden', 409);
    untouched(w);
  });
  it('US-02.5: admin A may deactivate / demote another admin B while A remains (not the last admin)', async () => {
    const w = makeWorld();
    const r = await call(w, 'changePartnerUserRole', 'adminX', R(U.adminX2!, row(w, 'adminX2').version, { partner_role: 'partner_member' }));
    expect(r.body.partner_role).toBe('partner_member');
    expect(w.users.filter((u) => u.partner_id === P.X && u.partner_role === 'partner_admin' && u.status === 'active')).toHaveLength(1);
  });
  it('member -> 403 auth.forbidden on U3/U4/U5/U6 (no SQL write, no port call)', async () => {
    const w = makeWorld();
    for (const [op, r] of [
      ['changePartnerUserRole', R(U.memberX!, 2, { partner_role: 'partner_admin' })],
      ['deactivatePartnerUser', R(U.adminX!, 3, { reason_code: 'left_organisation' })],
      ['reactivatePartnerUser', R(U.deactX!, 4)],
      ['resendPartnerInvitation', R(U.invitedX!, undefined)],
    ] as const) await fails(call(w, op, 'memberX', r), 'auth.forbidden', 403);
    untouched(w);
  });
  it('D-103 defence in depth: even if the permission check wrongly passes for a member, the service refuses (no UPDATE reaches the trigger) — auth.forbidden', async () => {
    const w = makeWorld();
    const before = structuredClone(w.users);
    await fails(call(w, 'changePartnerUserRole', 'memberX', R(U.memberX!, 2, { partner_role: 'partner_admin' }), { assertRoleAllowsAll: true }), 'auth.forbidden', 403);
    await fails(call(w, 'deactivatePartnerUser', 'memberX', R(U.adminX!, 3, { reason_code: 'left_organisation' }), { assertRoleAllowsAll: true }), 'auth.forbidden', 403);
    await fails(call(w, 'invitePartnerUser', 'memberX', req({ body: { email: CLEAR_EMAIL, display_name: 'A', partner_role: 'partner_admin' } }), { assertRoleAllowsAll: true }), 'auth.forbidden', 403);
    expect(w.writes()).toEqual([]);
    expect(w.users).toEqual(before);
    untouched(w);
  });
  it('probe ST2: admin of X targeting a user of Y -> 404 common.not_found for U3/U4/U5/U6 (RLS on and off); Y row untouched; no port call', async () => {
    for (const rls of [true, false]) {
      const w = makeWorld(); w.rls = rls;
      const y = structuredClone(row(w, 'memberY'));
      for (const [op, r] of [
        ['changePartnerUserRole', R(U.memberY!, y.version, { partner_role: 'partner_admin' })],
        ['deactivatePartnerUser', R(U.memberY!, y.version, { reason_code: 'left_organisation' })],
        ['reactivatePartnerUser', R(U.memberY!, y.version)],
        ['resendPartnerInvitation', R(U.memberY!, undefined)],
      ] as const) await fails(call(w, op, 'adminX', r), 'common.not_found', 404);
      expect(row(w, 'memberY')).toEqual(y);
      untouched(w);
    }
  });
  it('actor type: staff token on U3-U5 -> 403 auth.forbidden before any SQL', async () => {
    const w = makeWorld();
    await fails(call(w, 'deactivatePartnerUser', 'staff', R(U.memberX!, 2, { reason_code: 'left_organisation' })), 'auth.forbidden', 403);
    noSql(w);
  });
});

describe('T06 staff-only guards (SA10)', () => {
  const dea = (k: string) => R(U[k]!, row(world, k).version, { reason_code: 'left_organisation' });
  let world: World;
  it('US-02.5: last active partner_admin cannot be deactivated or demoted -> 409 partners.last_partner_admin; nothing written', async () => {
    world = makeWorld(); retire(world, 'adminX2');
    const v = row(world, 'adminX').version;
    await fails(call(world, 'deactivatePartnerUserByStaff', 'staff', dea('adminX')), 'partners.last_partner_admin', 409);
    await fails(call(world, 'changePartnerUserRoleByStaff', 'staff', R(U.adminX!, v, { partner_role: 'partner_member' })), 'partners.last_partner_admin', 409);
    untouched(world);
  });
  it('an invited partner_admin counts as an admin; a deactivated one does not', async () => {
    world = makeWorld(); row(world, 'adminX2').status = 'invited'; row(world, 'adminX2').activated_at = null;
    const r = await call(world, 'deactivatePartnerUserByStaff', 'staff', dea('adminX'));
    expect(r.body.status).toBe('deactivated');
    world = makeWorld(); retire(world, 'adminX2');
    await fails(call(world, 'deactivatePartnerUserByStaff', 'staff', dea('adminX')), 'partners.last_partner_admin', 409);
  });
  it('staff override only by first promoting another admin: promote member, then the old last admin can be demoted', async () => {
    world = makeWorld(); retire(world, 'adminX2');
    await fails(call(world, 'changePartnerUserRoleByStaff', 'staff', R(U.adminX!, row(world, 'adminX').version, { partner_role: 'partner_member' })), 'partners.last_partner_admin', 409);
    await call(world, 'changePartnerUserRoleByStaff', 'staff', R(U.memberX!, row(world, 'memberX').version, { partner_role: 'partner_admin' }));
    const r = await call(world, 'changePartnerUserRoleByStaff', 'staff', R(U.adminX!, row(world, 'adminX').version, { partner_role: 'partner_member' }));
    expect(r.body.partner_role).toBe('partner_member');
  });
  it('admins of other partners do not count: Y has a single admin even though X has two', async () => {
    world = makeWorld(); row(world, 'memberY').partner_role = 'partner_member';
    await fails(call(world, 'deactivatePartnerUserByStaff', 'staff', R(U.adminY!, row(world, 'adminY').version, { reason_code: 'left_organisation' })), 'partners.last_partner_admin', 409);
  });
  it('partner actor (even an admin) on SA10 -> 403 auth.forbidden; staff without manage -> 403; staff aal1 -> auth.mfa_required; nothing written', async () => {
    world = makeWorld();
    const r = dea('memberX');
    await fails(call(world, 'deactivatePartnerUserByStaff', 'adminX', r), 'auth.forbidden', 403);
    await fails(call(world, 'deactivatePartnerUserByStaff', 'staffNoManage', r), 'auth.forbidden', 403);
    await fails(call(world, 'deactivatePartnerUserByStaff', 'staff', r, { aal: 'aal1' }), 'auth.mfa_required', 403);
    untouched(world);
  });
  it('staff of tenant B cannot touch a tenant-A partner user (404), RLS on and off', async () => {
    for (const rls of [true, false]) {
      world = makeWorld(); world.rls = rls;
      await fails(call(world, 'deactivatePartnerUserByStaff', 'staffB', dea('memberX')), 'common.not_found', 404);
      untouched(world);
    }
  });
  it('staff may act on a user of any partner of the tenant (X and Y)', async () => {
    world = makeWorld();
    await call(world, 'deactivatePartnerUserByStaff', 'staff', dea('memberX'));
    await call(world, 'deactivatePartnerUserByStaff', 'staff', dea('memberY'));
    expect([row(world, 'memberX').status, row(world, 'memberY').status]).toEqual(['deactivated', 'deactivated']);
  });
});

// ------------------------------------------------------------------ U6 resend
describe('T06 U6 resendPartnerInvitation', () => {
  it('invited user: 202 {}, port {membershipId, action resend_invitation} without expectedVersion; row status unchanged', async () => {
    const w = makeWorld();
    const r = await call(w, 'resendPartnerInvitation', 'adminX', R(U.invitedX!, undefined));
    expect(r.status).toBe(202);
    expect(r.body ?? {}).toEqual({});
    expect(w.portCalls.find((c) => c.name === 'updatePartnerMembership')!.input).toEqual({ membershipId: M.invitedX, action: 'resend_invitation' });
    expect(row(w, 'invitedX').status).toBe('invited');
  });
  it('not invited (active / deactivated) -> 409 partners.partner_user_invalid_transition, port not called', async () => {
    const w = makeWorld();
    for (const k of ['memberX', 'deactX']) await fails(call(w, 'resendPartnerInvitation', 'adminX', R(U[k]!, undefined)), 'partners.partner_user_invalid_transition', 409);
    untouched(w);
  });
  it('unknown id -> 404; port error propagates', async () => {
    const w = makeWorld();
    await fails(call(w, 'resendPartnerInvitation', 'adminX', R(id(997), undefined)), 'common.not_found', 404);
    const err = new LimsError('identity.membership_inactive');
    await expect(call(w, 'resendPartnerInvitation', 'adminX', R(U.invitedX!, undefined), { updateError: err })).rejects.toBe(err);
  });
});

describe('T06 first sign-in flip stays allowed for a member (D-103 exception, T03 path)', () => {
  it('fake trigger: a member may only flip its own invited -> active; any other write by a member raises immutable_row', async () => {
    const w = makeWorld();
    const { ctx } = makeCtx(w, 'invitedX', (fn) => { hoisted.require = fn; });
    const flip = "UPDATE partners.partner_users SET status = 'active', activated_at = $3, updated_at = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND status = 'invited'";
    await ctx.tx.query(flip, [T_A, U.invitedX, NOW]);
    expect(row(w, 'invitedX').status).toBe('active');
    const { ctx: c2 } = makeCtx(w, 'memberX', (fn) => { hoisted.require = fn; });
    await expect(c2.tx.query("UPDATE partners.partner_users SET partner_role = 'partner_admin' WHERE tenant_id = $1 AND id = $2", [T_A, U.memberX])).rejects.toMatchObject({ message: 'immutable_row' });
    await expect(c2.tx.query("UPDATE partners.partner_users SET status = 'deactivated', deactivated_at = now() WHERE tenant_id = $1 AND id = $2", [T_A, U.adminX])).rejects.toMatchObject({ message: 'immutable_row' });
  });
});
