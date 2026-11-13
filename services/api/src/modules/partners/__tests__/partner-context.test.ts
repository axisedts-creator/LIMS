// C13 T03 — partner context + authz helpers (06-IMPLEMENTATION-PLAN row T03). Tests: unit + integration + probes. ACs: US-02.6, US-15.3, US-15.4.
// done_when: "A1 works; inactive partner/deactivated user -> 403; invited -> active flip; staff token -> 403".
// Spec: 02-TRD §4.8 (partnerContext.require), §5.2 A1 (getPartnerContext, GET /v1/partners/me, partners.order.read), §5.1 PartnerContext DTO,
//       03-APP-FLOW §2.5 (invited -> active on first partner request), 07-SECURITY AB6/AB8/AB9, ST4, 05-SCHEMA §3.8 (settings defaults).
// Interface expected from the writer (seams the spec does not fix are marked SEAM):
//   ../service/partner-context.service.ts  export const partnerContext = { require(ctx): Promise<{partnerId, partnerUserId, role}> }   (TRD §4.8 name)
//        SEAM lookup SQL (one SELECT, parameterised, `tenant_id = $n` and `membership_id = $n`, FROM partners.partner_users JOIN partners.partners)
//        must alias: partner_user_id, partner_id, partner_role, user_status, partner_status, display_name, partner_code, partner_name, conversion_mode.
//        It may LEFT JOIN partners.settings (columns access_slip_enabled, include_default_price_list, NULL when no row) OR run a separate
//        SELECT on partners.settings; absent row -> defaults false / true (05-SCHEMA §3.8, TRD §10.2).
//        SEAM flip: `UPDATE partners.partner_users SET status = 'active', activated_at = ...` guarded by status = 'invited', scoped by tenant_id and id/membership_id.
//        SEAM tenant display name: ctx.core.tenant(ctx).displayName (core-repo). timezone/calendar: IdentityPort.getTenantSettings keys ⊆ {timezone, calendarDisplay} (D-119).
//        SEAM user facts: permissions + mfa.enrolled from IdentityPort.getActor(ctx).
//   ../handlers/getPartnerContext.ts       export const getPartnerContext: Handler  (also wired as manifest.handlers.getPartnerContext)
//        order: ctx.actor.type === 'partner' (else 403 auth.forbidden, before anything else) -> assertRole(partners.order.read) -> partnerContext.require.
//   ../mappers/partner.dto.ts              (exercised only through the handler: exact PartnerContext allowlist, snake_case, no extra columns)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { getPartnerContext } from '../handlers/getPartnerContext.js';
import { manifest } from '../index.js';
import { partnerContext } from '../service/partner-context.service.js';

// ---- synthetic ids (uuid-shaped, synthetic data only) ----
const id = (n: number) => `01940e00-0000-7000-8000-c1300000${String(n).padStart(4, '0')}`;
const T_A = id(1), T_B = id(2);
const P_X = id(10), P_Y = id(11), P_Z = id(12), P_B = id(13);
const U = { adminX: id(20), memberX: id(21), invitedX: id(22), deactX: id(23), adminY: id(24), activeZ: id(25), invitedZ: id(26), tenantB: id(27) };
const M = { adminX: id(30), memberX: id(31), invitedX: id(32), deactX: id(33), adminY: id(34), activeZ: id(35), invitedZ: id(36), tenantB: id(37) };
const LEAKS = ['leak@partner.invalid', id(90), 'SYN-CREDIT-PARTY'];

interface PU { id: string; tenant_id: string; partner_id: string; membership_id: string; partner_role: string; status: string; display_name: string; activated_at: Date | null }
interface PR { id: string; tenant_id: string; partner_code: string; name: string; status: string; conversion_mode: string }

function makeWorld() {
  const partners: PR[] = [
    { id: P_X, tenant_id: T_A, partner_code: 'SYN-X', name: 'Synthetic Partner X', status: 'active', conversion_mode: 'on_receipt' },
    { id: P_Y, tenant_id: T_A, partner_code: 'SYN-Y', name: 'Synthetic Partner Y', status: 'active', conversion_mode: 'on_submit' },
    { id: P_Z, tenant_id: T_A, partner_code: 'SYN-Z', name: 'Synthetic Partner Z', status: 'suspended', conversion_mode: 'on_receipt' },
    { id: P_B, tenant_id: T_B, partner_code: 'SYN-B', name: 'Synthetic Partner B', status: 'active', conversion_mode: 'on_receipt' },
  ];
  const mk = (k: keyof typeof U, tenant: string, partner: string, role: string, status: string, name: string): PU =>
    ({ id: U[k], tenant_id: tenant, partner_id: partner, membership_id: M[k], partner_role: role, status, display_name: name, activated_at: null });
  const users: PU[] = [
    mk('adminX', T_A, P_X, 'partner_admin', 'active', 'Synthetic User AdminX'),
    mk('memberX', T_A, P_X, 'partner_member', 'active', 'Synthetic User MemberX'),
    mk('invitedX', T_A, P_X, 'partner_member', 'invited', 'Synthetic User InvitedX'),
    mk('deactX', T_A, P_X, 'partner_member', 'deactivated', 'Synthetic User DeactX'),
    mk('adminY', T_A, P_Y, 'partner_admin', 'active', 'Synthetic User AdminY'),
    mk('activeZ', T_A, P_Z, 'partner_admin', 'active', 'Synthetic User ActiveZ'),
    mk('invitedZ', T_A, P_Z, 'partner_member', 'invited', 'Synthetic User InvitedZ'),
    mk('tenantB', T_B, P_B, 'partner_admin', 'active', 'Synthetic User TenantB'),
  ];
  const settings = new Map<string, { access_slip_enabled: boolean; include_default_price_list: boolean }>();
  const w = {
    partners, users, settings,
    /** true = emulate app.current_partner_id() RLS (row visible only for invited/active user of an active partner); false = handler bug / no RLS. */
    rls: true,
    log: [] as Array<{ text: string; values: unknown[] }>,
    updates: () => w.log.filter((q) => /^\s*UPDATE\b/i.test(q.text)),
    userRow(pu: PU) {
      const p = partners.find((x) => x.tenant_id === pu.tenant_id && x.id === pu.partner_id)!;
      const s = settings.get(pu.tenant_id);
      return {
        partner_user_id: pu.id, partner_id: pu.partner_id, partner_role: pu.partner_role, user_status: pu.status, partner_status: p.status,
        display_name: pu.display_name, partner_code: p.partner_code, partner_name: p.name, conversion_mode: p.conversion_mode,
        access_slip_enabled: s?.access_slip_enabled ?? null, include_default_price_list: s?.include_default_price_list ?? null,
        // planted columns that must never reach the wire (partner-facing allowlist, TRD §5.1)
        membership_id: pu.membership_id, tenant_id: pu.tenant_id, credit_party_id: LEAKS[1], contact_email: LEAKS[0], email_masked: 'a***@p***', version: 7, credit_party_name: LEAKS[2],
      };
    },
    newTx() {
      return {
        startedAt: new Date(), operation: {}, savepoint: async (fn: (t: unknown) => Promise<unknown>) => fn(w.newTx()),
        async query(text: string, values: unknown[] = []) {
          w.log.push({ text, values });
          if (/^\s*UPDATE\s+partners\.partner_users\b/i.test(text)) {
            const pu = users.find((u) => values.includes(u.tenant_id) && (values.includes(u.id) || values.includes(u.membership_id)));
            if (pu) { pu.status = 'active'; pu.activated_at = new Date(); }
            return { rows: [] };
          }
          if (/\bFROM\s+partners\.partner_users\b/i.test(text)) {
            const hit = users.filter((u) => values.includes(u.tenant_id) && values.includes(u.membership_id)
              && (!w.rls || (['invited', 'active'].includes(u.status) && partners.find((p) => p.tenant_id === u.tenant_id && p.id === u.partner_id)!.status === 'active')));
            return { rows: hit.map(w.userRow) };
          }
          if (/\bFROM\s+partners\.settings\b/i.test(text)) {
            const s = [...settings.entries()].find(([t]) => values.includes(t));
            return { rows: s ? [s[1]] : [] };
          }
          throw new Error(`unexpected SQL in partner context: ${text}`);
        },
      };
    },
  };
  return w;
}
type World = ReturnType<typeof makeWorld>;

const ALL_PERMS = ['partners.order.read', 'partners.report.read', 'partners.manifest.submit', 'partners.partner_user.manage'];

function makeCtx(w: World, who: keyof typeof U, over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const pu = w.users.find((u) => u.id === U[who])!;
  const mfaEnrolled = (over['mfaEnrolled'] as boolean | undefined) ?? true;
  const ctx: any = {
    tenantId: pu.tenant_id,
    actor: { type: 'partner', id: pu.id, membershipId: pu.membership_id },
    requestId: id(99),
    tx: w.newTx(),
    now: () => '2026-11-13T00:00:00.000Z',
    db: {}, core: {
      async tenant() { calls.push('core.tenant'); return { id: pu.tenant_id, tenantCode: 'syn_lab', displayName: 'Synthetic Lab', legalName: 'Synthetic Lab Pvt', status: 'active', timezone: 'Asia/Kathmandu' }; },
    },
    audit: { access: async () => undefined }, events: {}, uploads: {}, files: {}, storage: {}, services: {},
    log: { info: (o: object) => logs.push(JSON.stringify(o)), warn: (o: object) => logs.push(JSON.stringify(o)), error: (o: object) => logs.push(JSON.stringify(o)) },
    ports: {
      IdentityPort: {
        async assertRole(_c: unknown, req: { permission: string }) {
          calls.push(`assertRole:${req.permission}`);
          if (over['assertRoleError']) throw over['assertRoleError'];
        },
        async getActor() {
          calls.push('getActor');
          return { actor: { type: 'partner', id: pu.id }, displayName: pu.display_name, roles: [pu.partner_role], permissions: over['permissions'] ?? ALL_PERMS,
            centreScope: { all: false, centreIds: [] }, branchIds: [], mfa: { enrolled: mfaEnrolled, level: mfaEnrolled ? 'aal2' : 'aal1' }, isLocked: false };
        },
        async getTenantSettings(_c: unknown, input?: { keys?: string[] }) {
          const keys = input?.keys ?? [];
          calls.push(`getTenantSettings:${keys.join(',')}`);
          if (!keys.length || keys.some((k) => !['timezone', 'calendarDisplay'].includes(k))) throw new LimsError('auth.forbidden'); // C2 refuses other keys for partner actors (D-119)
          return { timezone: 'Asia/Kathmandu', calendarDisplay: over['calendarDisplay'] ?? 'BS' };
        },
      },
    },
    ...((over['ctx'] as object) ?? {}),
  };
  return { ctx, calls, logs, pu };
}

const REQ = { params: {}, query: {}, headers: {}, body: undefined };
const run = (ctx: unknown, req: unknown = REQ) => getPartnerContext(req as any, ctx as any) as Promise<{ status: number; body: any }>;
const fails = async (p: Promise<unknown>, code: string, status = 403) => {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e).toBeInstanceOf(LimsError);
  expect(e.code).toBe(code);
  expect(e.statusCode).toBe(status);
  return e as LimsError;
};
const noSql = (w: World) => expect(w.log).toEqual([]);

describe('T03 A1 getPartnerContext — works (done_when 1)', () => {
  it('partner_admin of X: 200 with exactly the PartnerContext DTO (TRD §5.1), data from the row bound to the token membership', async () => {
    const w = makeWorld();
    const { ctx } = makeCtx(w, 'adminX');
    const r = await run(ctx);
    expect(r.status).toBe(200);
    const { calendar_display, ...tenantRest } = r.body.tenant;
    expect(String(calendar_display).toLowerCase()).toBe('bs'); // C2 value, case form is the writer's
    expect(r.body).toEqual({
      partner: { id: P_X, partner_code: 'SYN-X', name: 'Synthetic Partner X' },
      user: { partner_user_id: U.adminX, display_name: 'Synthetic User AdminX', partner_role: 'partner_admin', mfa_enrolled: true },
      tenant: { display_name: 'Synthetic Lab', calendar_display, timezone: 'Asia/Kathmandu' },
      permissions: expect.arrayContaining(ALL_PERMS),
      features: { access_slip_enabled: false, conversion_mode: 'on_receipt', include_default_price_list: true },
    });
    expect(tenantRest).toEqual({ display_name: 'Synthetic Lab', timezone: 'Asia/Kathmandu' });
    expect([...r.body.permissions].sort()).toEqual([...ALL_PERMS].sort());
  });

  it('partner_member with TOTP not enrolled, partners.settings row present, partner on_submit: values flow to user/features', async () => {
    const w = makeWorld();
    w.settings.set(T_A, { access_slip_enabled: true, include_default_price_list: false });
    const { ctx } = makeCtx(w, 'adminY', { mfaEnrolled: false, calendarDisplay: 'AD_BS', permissions: ['partners.order.read'] });
    const r = await run(ctx);
    expect(r.status).toBe(200);
    expect(r.body.partner).toEqual({ id: P_Y, partner_code: 'SYN-Y', name: 'Synthetic Partner Y' });
    expect(r.body.user.mfa_enrolled).toBe(false);
    expect(String(r.body.tenant.calendar_display).toLowerCase()).toBe('ad_bs');
    expect(r.body.permissions).toEqual(['partners.order.read']);
    expect(r.body.features).toEqual({ access_slip_enabled: true, conversion_mode: 'on_submit', include_default_price_list: false });
  });

  it('no partners.settings row -> code defaults access_slip_enabled false, include_default_price_list true (05-SCHEMA §3.8)', async () => {
    const w = makeWorld();
    const r = await run(makeCtx(w, 'memberX').ctx);
    expect(r.body.features).toMatchObject({ access_slip_enabled: false, include_default_price_list: true });
    expect(r.body.user.partner_role).toBe('partner_member');
  });

  it('DTO is an allowlist: only declared keys, wire patterns hold, planted columns (membership/tenant/credit party/email/version) never appear', async () => {
    const w = makeWorld();
    const r = await run(makeCtx(w, 'adminX').ctx);
    expect(Object.keys(r.body).sort()).toEqual(['features', 'partner', 'permissions', 'tenant', 'user']);
    expect(Object.keys(r.body.partner).sort()).toEqual(['id', 'name', 'partner_code']);
    expect(Object.keys(r.body.user).sort()).toEqual(['display_name', 'mfa_enrolled', 'partner_role', 'partner_user_id']);
    expect(Object.keys(r.body.tenant).sort()).toEqual(['calendar_display', 'display_name', 'timezone']);
    expect(Object.keys(r.body.features).sort()).toEqual(['access_slip_enabled', 'conversion_mode', 'include_default_price_list']);
    expect(r.body.partner.partner_code).toMatch(/^[A-Z0-9_-]{1,20}$/);
    expect(['partner_admin', 'partner_member']).toContain(r.body.user.partner_role);
    expect(['on_receipt', 'on_submit']).toContain(r.body.features.conversion_mode);
    expect(r.body.permissions.length).toBeLessThanOrEqual(50);
    const wire = JSON.stringify(r.body);
    for (const leak of [...LEAKS, M.adminX, T_A, 'email_masked', 'membership_id', 'tenant_id', 'null']) expect(wire, leak).not.toContain(leak);
  });

  it('order: actor-type check, then assertRole(partners.order.read), then lookup; port reads are minimal (getTenantSettings keys ⊆ timezone/calendarDisplay)', async () => {
    const w = makeWorld();
    const { ctx, calls } = makeCtx(w, 'adminX');
    await run(ctx);
    expect(calls[0]).toBe('assertRole:partners.order.read');
    expect(calls.filter((c) => c.startsWith('assertRole'))).toEqual(['assertRole:partners.order.read']);
    const ts = calls.filter((c) => c.startsWith('getTenantSettings'));
    expect(ts.length).toBeGreaterThan(0);
    for (const c of ts) for (const k of c.split(':')[1]!.split(',')) expect(['timezone', 'calendarDisplay']).toContain(k);
    expect(w.log.length).toBeGreaterThan(0);
  });

  it('is wired: manifest.handlers.getPartnerContext is the implementation, not the T01 501/internal stub', async () => {
    const w = makeWorld();
    const r: any = await manifest.handlers['getPartnerContext']!(REQ as any, makeCtx(w, 'adminX').ctx);
    expect(r.status).toBe(200);
    expect(r.body.partner.id).toBe(P_X);
  });

  it('ignores any partner id in the request (params, query, body, headers): partner comes only from the membership row (US-15.1 / REQ-SEC-080)', async () => {
    const w = makeWorld();
    const req = { params: { partner_id: P_Y }, query: { partner_id: P_Y }, headers: { 'x-partner-id': P_Y, 'x-lims-partner-id': P_Y }, body: { partner_id: P_Y } };
    const r = await run(makeCtx(w, 'adminX').ctx, req);
    expect(r.body.partner.id).toBe(P_X);
    expect(JSON.stringify(r.body)).not.toContain('SYN-Y');
  });

  it('two partners of one tenant each see only their own context', async () => {
    const w = makeWorld();
    const x = await run(makeCtx(w, 'adminX').ctx);
    const y = await run(makeCtx(w, 'adminY').ctx);
    expect(x.body.partner.id).toBe(P_X); expect(y.body.partner.id).toBe(P_Y);
    expect(JSON.stringify(x.body)).not.toMatch(/SYN-Y|Synthetic Partner Y|AdminY/);
    expect(JSON.stringify(y.body)).not.toMatch(/SYN-X|Synthetic Partner X|AdminX/);
  });

  it('lookup SQL is parameterised and tenant + membership scoped (REQ-SEC-024); no id is interpolated into the text', async () => {
    const w = makeWorld();
    await run(makeCtx(w, 'adminX').ctx);
    const q = w.log.find((x) => /FROM\s+partners\.partner_users/i.test(x.text))!;
    expect(q).toBeTruthy();
    expect(q.text).toMatch(/tenant_id\s*=\s*\$\d/i);
    expect(q.text).toMatch(/membership_id\s*=\s*\$\d/i);
    expect(q.text).toMatch(/partners\.partners/i);
    expect(q.values).toEqual(expect.arrayContaining([T_A, M.adminX]));
    for (const lit of [T_A, M.adminX, 'adminX']) expect(q.text).not.toContain(lit);
  });

  it('writes nothing for an already-active user (read-only request)', async () => {
    const w = makeWorld();
    await run(makeCtx(w, 'adminX').ctx);
    expect(w.updates()).toEqual([]);
  });

  it('logs carry no partner/user names, e-mail or ids of other tenants (PHI/PII log rule, 07-SECURITY §5)', async () => {
    const w = makeWorld();
    const { ctx, logs } = makeCtx(w, 'adminX');
    await run(ctx);
    const all = logs.join('\n');
    for (const s of ['Synthetic Partner X', 'Synthetic User AdminX', 'Synthetic Lab', ...LEAKS]) expect(all, s).not.toContain(s);
  });
});

describe('T03 partnerContext.require (TRD §4.8)', () => {
  it('returns exactly {partnerId, partnerUserId, role}, frozen, attached as ctx.partner, memoised per request', async () => {
    const w = makeWorld();
    const { ctx } = makeCtx(w, 'memberX');
    const p = await partnerContext.require(ctx);
    expect(p).toEqual({ partnerId: P_X, partnerUserId: U.memberX, role: 'partner_member' });
    expect(Object.isFrozen(p)).toBe(true);
    expect(ctx.partner).toBe(p);
    const n = w.log.length;
    expect(await partnerContext.require(ctx)).toBe(p);
    expect(w.log.length).toBe(n); // no second lookup in the same request
  });

  it('refuses a non-partner actor itself (defence in depth: a handler that forgot the type check still gets 403, no SQL)', async () => {
    const w = makeWorld();
    const { ctx } = makeCtx(w, 'adminX');
    ctx.actor = { type: 'user', id: id(70), membershipId: M.adminX };
    await fails(partnerContext.require(ctx), 'auth.forbidden');
    noSql(w);
  });
});

describe('T03 inactive partner / deactivated user -> 403 partners.partner_inactive (done_when 2; AB8, AB9; US-02.6)', () => {
  it('deactivated partner user: RLS hides the row (helper NULL) -> 403 partners.partner_inactive, no write', async () => {
    const w = makeWorld();
    await fails(run(makeCtx(w, 'deactX').ctx), 'partners.partner_inactive');
    expect(w.updates()).toEqual([]);
  });

  it('suspended partner: active user of a suspended partner -> 403 partners.partner_inactive, no write', async () => {
    const w = makeWorld();
    await fails(run(makeCtx(w, 'activeZ').ctx), 'partners.partner_inactive');
    expect(w.updates()).toEqual([]);
  });

  it('invited user of a suspended partner is NOT flipped to active (403, row stays invited)', async () => {
    const w = makeWorld();
    await fails(run(makeCtx(w, 'invitedZ').ctx), 'partners.partner_inactive');
    expect(w.updates()).toEqual([]);
    expect(w.users.find((u) => u.id === U.invitedZ)!.status).toBe('invited');
  });

  it('defence in depth, RLS off / handler bug (rows returned regardless of status): deactivated user and suspended partner still 403, still no write', async () => {
    for (const who of ['deactX', 'activeZ', 'invitedZ'] as const) {
      const w = makeWorld();
      w.rls = false;
      await fails(run(makeCtx(w, who).ctx), 'partners.partner_inactive');
      expect(w.updates(), who).toEqual([]);
    }
    const w = makeWorld(); w.rls = false;
    await run(makeCtx(w, 'deactX').ctx).catch(() => undefined);
    expect(w.users.find((u) => u.id === U.deactX)!.status).toBe('deactivated');
  });

  it('membership of another tenant (valid row in tenant B, request in tenant A) -> 403, never tenant B data', async () => {
    const w = makeWorld();
    const { ctx } = makeCtx(w, 'tenantB');
    ctx.tenantId = T_A;
    const e = await fails(run(ctx), 'partners.partner_inactive');
    expect(JSON.stringify([e.code, e.detail, e.errors])).not.toMatch(/SYN-B|TenantB/);
  });

  it('fail closed without a membership id or tenant id on the actor/ctx: 403, no write, no data', async () => {
    for (const patch of [{ actor: { type: 'partner', id: U.adminX } }, { tenantId: undefined }]) {
      const w = makeWorld();
      const { ctx } = makeCtx(w, 'adminX');
      Object.assign(ctx, patch);
      const e: any = await run(ctx).then(() => { throw new Error('expected rejection'); }, (x) => x);
      expect(e).toBeInstanceOf(LimsError);
      expect(e.statusCode).toBe(403);
      expect(['auth.forbidden', 'partners.partner_inactive']).toContain(e.code);
      expect(w.updates()).toEqual([]);
    }
  });

  it('the 403 problem leaks nothing about the partner or user (generic detail)', async () => {
    const w = makeWorld();
    const e = await fails(run(makeCtx(w, 'activeZ').ctx), 'partners.partner_inactive');
    expect(JSON.stringify({ m: e.message, d: e.detail, e: e.errors })).not.toMatch(/SYN-Z|Synthetic|ActiveZ|@/);
  });
});

describe('T03 invited -> active on first partner request (done_when 3; 03-APP-FLOW §2.5; TRD §4.8)', () => {
  it('first request flips the mirror row once, answers 200 with the user, second request writes nothing', async () => {
    const w = makeWorld();
    const first = await run(makeCtx(w, 'invitedX').ctx);
    expect(first.status).toBe(200);
    expect(first.body.user).toMatchObject({ partner_user_id: U.invitedX, partner_role: 'partner_member' });
    const row = w.users.find((u) => u.id === U.invitedX)!;
    expect(row.status).toBe('active');
    expect(row.activated_at).toBeInstanceOf(Date);
    expect(w.updates()).toHaveLength(1);
    const second = await run(makeCtx(w, 'invitedX').ctx);
    expect(second.status).toBe(200);
    expect(w.updates()).toHaveLength(1);
  });

  it('flip UPDATE is the narrow one the guard_partner_users trigger allows: parameterised, tenant + row scoped, guarded by status invited, SET only status/activated_at (+ audit/version bookkeeping)', async () => {
    const w = makeWorld();
    await run(makeCtx(w, 'invitedX').ctx);
    const u = w.updates()[0]!;
    expect(u.text).toMatch(/UPDATE\s+partners\.partner_users/i);
    expect(u.text).toMatch(/tenant_id\s*=\s*\$\d/i);
    expect(u.text).toMatch(/\b(id|membership_id)\s*=\s*\$\d/i);
    expect(u.text.match(/status\s*=\s*'invited'/i) !== null || u.values.includes('invited')).toBe(true);
    const set = /\bSET\b([\s\S]*?)\bWHERE\b/i.exec(u.text)?.[1] ?? '';
    expect(set).toMatch(/status\s*=/i);
    expect(set).toMatch(/activated_at\s*=/i);
    expect(set).not.toMatch(/partner_role|partner_id|membership_id|display_name|email_masked|tenant_id|deactivat/i);
    expect(u.values).toEqual(expect.arrayContaining([T_A]));
    for (const lit of [T_A, U.invitedX, M.invitedX]) expect(u.text).not.toContain(lit);
  });

  it('flip never changes role or partner (member stays member, partner X stays X)', async () => {
    const w = makeWorld();
    await run(makeCtx(w, 'invitedX').ctx);
    expect(w.users.find((u) => u.id === U.invitedX)).toMatchObject({ partner_role: 'partner_member', partner_id: P_X });
  });

  it('only the caller\'s own row is touched (no other invited/active row changes)', async () => {
    const w = makeWorld();
    const before = JSON.stringify(w.users.filter((u) => u.id !== U.invitedX));
    await run(makeCtx(w, 'invitedX').ctx);
    expect(JSON.stringify(w.users.filter((u) => u.id !== U.invitedX))).toBe(before);
  });

  it('race: a concurrent first request already flipped the row (UPDATE touches 0 rows) -> still 200, no error', async () => {
    const w = makeWorld();
    const { ctx } = makeCtx(w, 'invitedX');
    const realQuery = ctx.tx.query;
    ctx.tx.query = async (text: string, values?: unknown[]) => {
      if (/^\s*UPDATE\b/i.test(text)) { w.log.push({ text, values: values ?? [] }); return { rows: [] }; } // someone else won; nothing changed here
      return realQuery(text, values);
    };
    const r = await run(ctx);
    expect(r.status).toBe(200);
  });

  it('the flip happens inside the request tx: a failing later step (assertRole denied) means no UPDATE was issued before the permission check', async () => {
    const w = makeWorld();
    const { ctx } = makeCtx(w, 'invitedX', { assertRoleError: new LimsError('auth.forbidden') });
    await fails(run(ctx), 'auth.forbidden');
    expect(w.log).toEqual([]);
    expect(w.users.find((u) => u.id === U.invitedX)!.status).toBe('invited');
  });
});

describe('T03 staff / non-partner token -> 403 auth.forbidden (done_when 4; US-15.3, US-15.4; AB6, ST4)', () => {
  const kinds: Array<[string, any]> = [
    ['staff user', { type: 'user', id: id(70), membershipId: M.adminX }],
    ['system', { type: 'system', id: id(71) }],
    ['portal', { type: 'portal', id: id(72) }],
    ['patient', { type: 'patient', id: id(73) }],
    ['device', { type: 'device', id: id(74) }],
    ['no type', { id: id(75), membershipId: M.adminX }],
    ['no actor', undefined],
  ];
  for (const [label, actor] of kinds) {
    it(`${label}: 403 auth.forbidden before any lookup, port call or write — even when assertRole would pass (partner permissions are not grantable to staff)`, async () => {
      const w = makeWorld();
      const { ctx, calls } = makeCtx(w, 'adminX'); // membership id of a real partner user: must not be usable by a non-partner actor
      ctx.actor = actor;
      await fails(run(ctx), 'auth.forbidden');
      noSql(w);
      expect(calls.filter((c) => c.startsWith('assertRole'))).toEqual([]);
      expect(w.users.find((u) => u.id === U.adminX)!.status).toBe('active');
    });
  }

  it('a staff actor carrying the membership id of an INVITED partner user cannot flip it', async () => {
    const w = makeWorld();
    const { ctx } = makeCtx(w, 'invitedX');
    ctx.actor = { type: 'user', id: id(70), membershipId: M.invitedX };
    await fails(run(ctx), 'auth.forbidden');
    expect(w.updates()).toEqual([]);
    expect(w.users.find((u) => u.id === U.invitedX)!.status).toBe('invited');
  });

  it('partner actor without partners.order.read (assertRole rejects) -> that error propagates (403 auth.forbidden), no lookup, no write', async () => {
    const w = makeWorld();
    await fails(run(makeCtx(w, 'invitedX', { assertRoleError: new LimsError('auth.forbidden') }).ctx), 'auth.forbidden');
    noSql(w);
  });

  it('manifest handler behaves the same for a staff token (wired path)', async () => {
    const w = makeWorld();
    const { ctx } = makeCtx(w, 'adminX');
    ctx.actor = { type: 'user', id: id(70) };
    await fails(Promise.resolve().then(() => manifest.handlers['getPartnerContext']!(REQ as any, ctx)), 'auth.forbidden');
    noSql(w);
  });
});

describe('T03 static guards on the new files', () => {
  const root = join(import.meta.dirname, '..');
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  it('files exist at the planned paths', () => {
    for (const p of ['service/partner-context.service.ts', 'handlers/getPartnerContext.ts', 'mappers/partner.dto.ts']) expect(() => read(p), p).not.toThrow();
  });
  it('no SQL built by string interpolation in the context service (injection guard)', () => {
    const src = read('service/partner-context.service.ts');
    const templates = src.match(/`[^`]*`/g) ?? [];
    for (const t of templates.filter((x) => /partners\.|SELECT|UPDATE/i.test(x))) expect(t, t).not.toContain('${');
    expect(src).not.toMatch(/\bquery\(\s*['"][^'"]*['"]\s*\+/);
  });
  it('handler does not read a partner id from the request (req.params/query/body/headers)', () => {
    const src = read('handlers/getPartnerContext.ts');
    expect(src).not.toMatch(/req\.(params|query|body|headers)[^;\n]*partner/i);
  });
});
