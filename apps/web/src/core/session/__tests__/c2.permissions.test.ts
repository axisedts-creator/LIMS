// AUTH-ACTOR-2 (LD-222; C0 CR T0D-14; 02-TRD SessionState): apps/web/src/core/session/c2.ts maps the C2 resolveSession body to ShellSession.
// RULE: the web NEVER derives a permission set (not from roles, not from a default); it uses session.actor.permissions, which the API sends only for an ACTIVE session.
//   - state active, kind tenant_staff | platform, permissions = string[]  -> ok, actor.permissions = that array (an empty array is a real, empty set)
//   - state active, kind tenant_staff | platform, permissions missing / not an array / not all strings -> an EXPLICIT error state: Resolution { ok: false } with a stable problem code,
//     status 500|503 (never 401: that would send the user to the sign-in screen in a loop), never a throw inside middleware, never an empty set, never permissions derived from roles
//   - state not active (password_setup | mfa_pending | mfa_enrolment_required) -> ok, permissions [] whatever the body carries (no pre-MFA session uses a permission set)
// Seams: C2Resolved.session gets `state`; the error code is one that exists in contracts/errors.yaml (common.internal 500 or common.dependency_unavailable 503).
// Expected now: the "present" and "error state" cases fail (c2.ts maps a missing list to [] and ignores state).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { c2Resolver } from '../c2';

const ERRORS_YAML = fileURLToPath(new URL('../../../../../../contracts/errors.yaml', import.meta.url));
const SID = 'S'.padEnd(43, '0');
const ACCESS = 'ACCESS-SENTINEL-never-in-an-error-a1b2c3';
const PERMS = ['lab.result.enter', 'lab.result.read'];
const PLATFORM_PERMS = ['platform.tenant.read', 'platform.audit.read'];

const body = (session: Record<string, unknown>) => ({ access_token: ACCESS, session: {
  session_id: '0190a000-0000-7000-8000-000000000001', kind: 'tenant_staff', state: 'active', aal: 'aal2',
  idle_expires_at: '2026-11-15T07:00:00.000Z', absolute_expires_at: '2026-11-15T15:00:00.000Z', ...session } });
const actor = (o: Record<string, unknown> = {}) => ({ display_name: 'Ana Demo', roles: ['lab_manager', 'technician'], tenant_code: 'lab_a', ...o });
const serve = (b: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })));
const resolve = () => c2Resolver.resolve(SID, { touch: false });
const NOT_ACTIVE = ['password_setup', 'mfa_pending', 'mfa_enrolment_required'];
let codes: Map<string, number>;

beforeAll(() => {
  codes = new Map([...readFileSync(ERRORS_YAML, 'utf8').matchAll(/code:\s*([a-z_]+\.[a-z_]+)\s*,\s*http:\s*(\d+)/g)].map((m) => [m[1]!, Number(m[2])]));
});
beforeEach(() => {
  process.env.LIMS_CORE_ENV = 'ci'; process.env.LIMS_WEB_BFF_KEY = 'synthetic-web-bff-key-0123456789'; process.env.LIMS_ORIGIN_API = 'https://api.lims-test.invalid';
  delete process.env.LIMS_WEB_BFF_KEY_FILE;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('active tenant_staff / platform session WITH actor.permissions', () => {
  it('tenant_staff: ok, actor.permissions is exactly the array the API sent', async () => {
    serve(body({ actor: actor({ permissions: PERMS }) })); const r = await resolve();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.session.actor.permissions).toEqual(PERMS); expect(r.session.actor).toMatchObject({ displayName: 'Ana Demo', tenantCode: 'lab_a', roles: ['lab_manager', 'technician'] });
    expect(r.accessToken).toBe(ACCESS); expect(r.session).toMatchObject({ kind: 'tenant_staff', aal: 'aal2' });
  });
  it('platform: ok, actor.permissions is exactly the array the API sent (the /platform tiles and menu are built from it)', async () => {
    serve(body({ kind: 'platform', actor: { display_name: 'Sam Staff', roles: ['platform_support'], permissions: PLATFORM_PERMS } })); const r = await resolve();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.session.actor.permissions).toEqual(PLATFORM_PERMS); expect(r.session.kind).toBe('platform');
  });
  it('an empty array is a real, empty set: ok with [] (not an error, not a default)', async () => {
    serve(body({ actor: actor({ permissions: [] }) })); const r = await resolve();
    expect(r.ok).toBe(true); if (r.ok) expect(r.session.actor.permissions).toEqual([]);
  });
  it('the mapped array is a copy of the response data (not shared state between requests)', async () => {
    const sent = [...PERMS]; serve(body({ actor: actor({ permissions: sent }) })); const a = await resolve(); const b = await resolve();
    if (a.ok && b.ok) { expect(a.session.actor.permissions).not.toBe(b.session.actor.permissions); (a.session.actor.permissions as string[]).push('x.y.z'); expect(b.session.actor.permissions).toEqual(PERMS); }
  });
});

describe('active session WITHOUT a usable permissions array: explicit error state, never an empty set, never derived', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['permissions missing', {}], ['permissions null', { permissions: null }], ['permissions a string', { permissions: 'lab.result.read' }],
    ['permissions an object', { permissions: { 'lab.result.read': true } }], ['an entry is not a string', { permissions: ['lab.result.read', 7] }], ['an entry is null', { permissions: [null] }],
  ];
  for (const kind of ['tenant_staff', 'platform'] as const) {
    it.each(cases)(`${kind}: %s -> ok:false, status 500|503, a stable code that exists in contracts/errors.yaml, not 401`, async (_n, extra) => {
      serve(body({ kind, actor: actor({ ...extra, roles: kind === 'platform' ? ['platform_support'] : ['lab_manager'] }) }));
      const r = await resolve();   // must RESOLVE: a throw inside middleware is a 500 page with no problem body
      expect(r.ok).toBe(false); if (r.ok) return;
      expect([500, 503]).toContain(r.status); expect(r.status).not.toBe(401);
      expect(codes.has(r.problem.code), `${r.problem.code} is in contracts/errors.yaml`).toBe(true); expect(r.problem.code).not.toBe('auth.session_expired');
      expect(r.problem.status).toBe(r.status); expect(codes.get(r.problem.code)).toBe(r.status);
    });
  }
  it('the code is the same for tenant_staff and platform and for every cause (stable, so the UI and alerts can key on it)', async () => {
    const seen = new Set<string>();
    for (const [kind, extra] of [['tenant_staff', {}], ['platform', {}], ['tenant_staff', { permissions: 'x' }], ['platform', { permissions: [1] }]] as const) {
      serve(body({ kind, actor: actor(extra) })); const r = await resolve(); if (!r.ok) seen.add(`${r.status}:${r.problem.code}`);
    }
    expect(seen.size).toBe(1);
  });
  it('roles are not turned into permissions: an active lab_manager with no list is an error, not a role-derived set', async () => {
    serve(body({ actor: actor({ roles: ['tenant_admin', 'lab_manager'] }) })); const r = await resolve();
    expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toMatch(/"permissions"/);
  });
  it('the error state leaks nothing: no access token, session id or role list in the problem', async () => {
    serve(body({ actor: actor() })); const r = await resolve(); expect(r.ok).toBe(false);
    const text = JSON.stringify(r); for (const bad of [ACCESS, '0190a000-0000-7000-8000-000000000001', 'lab_manager', 'Ana Demo', SID]) expect(text).not.toContain(bad);
  });
  it('a body that is not JSON at all or has no actor keeps the existing 503 dependency_unavailable (not a throw)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 }))); const a = await resolve(); expect(a.ok).toBe(false);
    serve(body({})); const b = await resolve(); expect(b.ok).toBe(false); if (!b.ok) expect(b.status).toBe(503);
  });
});

describe('state is not active: no permission set, and it is not an error', () => {
  it.each(NOT_ACTIVE)('state %s (tenant_staff and platform), no permissions in the body: ok with actor.permissions []', async (state) => {
    for (const kind of ['tenant_staff', 'platform'] as const) {
      serve(body({ kind, state, aal: 'aal1', actor: actor() })); const r = await resolve();
      expect(r.ok, `${kind}/${state}`).toBe(true); if (r.ok) expect(r.session.actor.permissions).toEqual([]);
    }
  });
  it.each(NOT_ACTIVE)('state %s: even if a body carries a permissions array (it must not), the web does not hand it to the shell', async (state) => {
    serve(body({ state, aal: 'aal1', actor: actor({ permissions: PERMS }) })); const r = await resolve();
    expect(r.ok).toBe(true); if (r.ok) expect(r.session.actor.permissions).toEqual([]);
  });
});

describe('the existing mapping is unchanged', () => {
  it('401 from C2 is relayed as the sign-in path expects; a 5xx or network failure is 503 dependency_unavailable', async () => {
    serve({ type: 'urn:lims:error:auth.session_expired', title: 'Session expired', status: 401, code: 'auth.session_expired' }, 401);
    const a = await resolve(); expect(a.ok).toBe(false); if (!a.ok) { expect(a.status).toBe(401); expect(a.problem.code).toBe('auth.session_expired'); }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); })); const b = await resolve(); expect(b.ok).toBe(false); if (!b.ok) { expect(b.status).toBe(503); expect(b.problem.code).toBe('common.dependency_unavailable'); }
  });
});
