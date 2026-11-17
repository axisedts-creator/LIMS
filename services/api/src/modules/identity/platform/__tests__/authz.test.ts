// T21 PlatformAuthz (02-TRD s5.10, s7.2 step 3; 03-APP-FLOW s9; 08 R10 item 4): the ONLY check for platform.* permissions. Expected now: fails to load (../authz.js missing).
// Matrix is hard-coded from contracts/permissions.yaml (independent of the generated constants): superadmin = 5 codes, support = tenant.read + support_session.open.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PlatformAuthz } from '../authz.js';
import { rejection } from '../../service/__tests__/support.helpers.js';

const SUPER = ['platform.tenant.read', 'platform.tenant.manage', 'platform.support_session.open', 'platform.dead_letter.manage', 'platform.staff.manage'];
const SUPPORT = ['platform.tenant.read', 'platform.support_session.open'];
const ctx = (o: Record<string, unknown> = {}) => ({ actor: { type: 'user', id: 'u' }, platformRole: 'platform_support', platformStaffId: 's', aal: 'aal2', ...o });
const check = (c: unknown, p: unknown) => rejection(async () => PlatformAuthz.assertPlatform(c as never, p as never));
const ok = async (c: unknown, p: unknown) => { await PlatformAuthz.assertPlatform(c as never, p as never); };

describe('role -> permission matrix', () => {
  it.each(SUPER)('platform_superadmin holds %s', async (p) => { await ok(ctx({ platformRole: 'platform_superadmin' }), p); });
  it.each(SUPPORT)('platform_support holds %s', async (p) => { await ok(ctx(), p); });
  it.each(SUPER.filter((p) => !SUPPORT.includes(p)))('platform_support is refused %s (E-6: cannot manage tenants/staff, cannot replay dead letters)', async (p) => {
    expect((await check(ctx(), p)).code).toBe('auth.forbidden');
  });
});

describe('fail closed', () => {
  it.each([undefined, null, '', 'platform_admin', 'tenant_admin', 'PLATFORM_SUPERADMIN', '__proto__', 'constructor', 'toString', 42])('platformRole %j -> auth.forbidden', async (r) => {
    expect((await check(ctx({ platformRole: r }), 'platform.tenant.read')).code).toBe('auth.forbidden');
  });
  it('a tenant user context (membership, tenantId, no platformRole) is refused', async () => {
    const e = await check({ actor: { type: 'user', id: 'u', membershipId: 'm' }, tenantId: 't', aal: 'aal2' }, 'platform.tenant.read');
    expect(e.code).toBe('auth.forbidden');
  });
  it.each(['system', 'device', 'patient', 'partner', 'portal'])('non-user actor type %s with a platformRole is refused', async (t) => {
    expect((await check(ctx({ actor: { type: t, id: 'x' }, platformRole: 'platform_superadmin' }), 'platform.tenant.read')).code).toBe('auth.forbidden');
  });
  it('missing / malformed context never allows', async () => {
    for (const c of [undefined, null, {}, 'x', 7]) expect((await check(c, 'platform.tenant.read')).code).toMatch(/^auth\.(forbidden|unauthenticated)$/);
  });
  it.each(['identity.user.read', 'audit.log.read', 'lab.result.read', 'Platform.tenant.read', 'platform.', '', undefined, null, 5, {}, ['platform.tenant.read']])(
    'non-platform / malformed permission %j is never allowed (even for a superadmin)', async (p) => {
      const e = await check(ctx({ platformRole: 'platform_superadmin' }), p);
      expect(e.code).toMatch(/^(auth\.forbidden|common\.validation_failed)$/);
    });
  it.each(['platform.nope', 'platform.tenant.delete', '__proto__', 'constructor'])('unknown code %s -> forbidden or validation_failed', async (p) => {
    expect((await check(ctx({ platformRole: 'platform_superadmin' }), p)).code).toMatch(/^(auth\.forbidden|common\.validation_failed)$/);
  });
});

describe('aal2 for every privileged platform permission (REQ-SEC-067, 04 A4)', () => {
  it.each(SUPPORT)('aal1 caller with the right role -> auth.mfa_required for %s', async (p) => {
    expect((await check(ctx({ aal: 'aal1' }), p)).code).toBe('auth.mfa_required');
  });
  it.each([undefined, null, '', 'AAL2', 'aal3', 2])('aal %j is not aal2 -> auth.mfa_required', async (a) => {
    expect((await check(ctx({ aal: a }), 'platform.support_session.open')).code).toBe('auth.mfa_required');
  });
  it('wrong role stays auth.forbidden at aal2 (a lower assurance level never turns a refusal into an allow or a hint)', async () => {
    expect((await check(ctx({ aal: 'aal2' }), 'platform.tenant.manage')).code).toBe('auth.forbidden');
  });
});

describe('a platform caller who holds a support session may still call platform endpoints (endSupportSession needs it)', () => {
  it('actor.supportSessionId set: allowed for the same permission', async () => {
    await ok(ctx({ actor: { type: 'user', id: 'u', supportSessionId: 'ss' } }), 'platform.support_session.open');
  });
});

describe('static: authz.ts', () => {
  const src = (() => { const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'authz.ts'); return existsSync(p) ? readFileSync(p, 'utf8') : ''; })();
  it('exists, runs no SQL, reads no env, never delegates to IdentityPort.assertRole', () => {
    expect(src.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[\s\S]{0,80}\b(core|identity|audit|app)\./);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/assertRole\s*\(/);
  });
});
