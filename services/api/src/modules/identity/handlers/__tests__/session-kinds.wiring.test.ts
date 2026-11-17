// T31 wiring + static guards for the six new operations (02-TRD s5.1; 08 A25 D-212/P-61; 07-SECURITY AU-T2c, AU-T13, section 5 logging rules; LD-81).
// Expected now: fail (the six handlers are common.internal stubs in the manifest; the handler files do not exist).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { REQ_ID, SYSTEM_ACTOR, rejection, tokenN } from './kinds.helpers.js';

const { manifest } = await import('../../index.js');
const MOD = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity');
const OPS = ['loginPartner', 'resolvePatientSession', 'logoutPatientSession', 'openMobileSession', 'refreshMobileSession', 'logoutMobileSession'] as const;
const FILES = [...OPS.map((o) => join(MOD, 'handlers', `${o}.ts`)), join(MOD, 'service', 'session.service.ts')];
const src = (f: string) => readFileSync(f, 'utf8');

function hctx(bffKey?: string) {
  const txCalls: any[] = []; const tx = { query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })), bindTenant: vi.fn(async () => undefined) };
  const forbidden = (n: string) => () => { throw new Error(`T31 handlers must not use ctx.db.${n}`); };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: any = { operationId: 'x', clientIp: '203.0.113.9', requestId: REQ_ID, ...(bffKey ? { bffKey } : {}), actor: { type: 'system', id: SYSTEM_ACTOR }, log, commitOnError: vi.fn(),
    db: { identityAuthTx: async (i: any, fn: any) => { txCalls.push(i); return fn(tx, { noRetry: () => undefined }); }, tx: forbidden('tx'), requestTx: forbidden('requestTx'), withTenantScope: forbidden('withTenantScope') } };
  return { ctx, tx, txCalls, log };
}
const REQ = (body: unknown, headers: Record<string, string> = {}) => ({ params: {}, query: {}, body, headers });

describe('manifest: the six handlers are real (not the common.internal stub)', () => {
  it.each(OPS)('%s: a forged / malformed body is rejected with common.validation_failed BEFORE any identityAuthTx (not "not implemented")', async (op) => {
    const bodies: Record<string, unknown[]> = {
      loginPartner: [{ email: 'a@example.test', password: 'x', tenant_id: 'x' }, {}],
      openMobileSession: [{ email: 'a@example.test', password: 'x', app_instance_id: 'x', app_platform: 'ios' }, {}],
      refreshMobileSession: [{ session_token: 'short' }, {}, { session_token: tokenN(1), tenant_id: 'x' }],
      logoutMobileSession: [{ session_token: 'short' }, {}],
      resolvePatientSession: [{ touch: 'yes' }, {}, { touch: true, tenant_id: 'x' }],
      logoutPatientSession: [],
    };
    for (const body of bodies[op]!) {
      const h = hctx('partner'); const e = await rejection((manifest.handlers as any)[op](REQ(body, op.endsWith('PatientSession') ? { 'x-lims-patient-session': tokenN(2) } : {}), h.ctx));
      expect(e.code, JSON.stringify(body)).toBe('common.validation_failed'); expect(String(e.message)).not.toMatch(/not implemented/); expect(h.txCalls).toHaveLength(0);
    }
  });
  it.each(['refreshMobileSession', 'logoutMobileSession', 'resolvePatientSession', 'logoutPatientSession'] as const)('%s: unknown token -> 401 auth.session_expired through the REAL repo: one identityAuthTx { identity, <op> }, DEFINER lookup, no write, no bindTenant', async (op) => {
    const h = hctx(); const t = tokenN(0x1234);
    const e = await rejection((manifest.handlers as any)[op](op === 'resolvePatientSession' ? REQ({ touch: false }, { 'x-lims-patient-session': t }) : op === 'logoutPatientSession' ? REQ(undefined, { 'x-lims-patient-session': t }) : REQ({ session_token: t }), h.ctx));
    expect(e.code).toBe('auth.session_expired'); expect(String(e.message)).not.toMatch(/not implemented/);
    expect(h.txCalls).toHaveLength(1); expect(h.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: op, context: 'identity_auth' }, requestId: REQ_ID, clientIp: '203.0.113.9' });
    const q = h.tx.query.mock.calls as unknown as Array<[string, unknown[]]>; expect(q[0]![0]).toMatch(/app\.identity_session_by_token/);
    for (const [sql] of q) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(h.tx.bindTenant).not.toHaveBeenCalled(); expect(JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls])).not.toContain(t);
  });
  it.each(['refreshMobileSession', 'resolvePatientSession'] as const)('%s: client IP is ctx.clientIp, never a header (P-61, AU-T2c)', async (op) => {
    const h = hctx(); const r: any = op === 'resolvePatientSession' ? REQ({ touch: false }, { 'x-lims-patient-session': tokenN(3) }) : REQ({ session_token: tokenN(3) });
    r.headers = { ...r.headers, 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '10.8.8.8', forwarded: 'for=10.7.7.7' };
    expect((await rejection((manifest.handlers as any)[op](r, h.ctx))).code).toBe('auth.session_expired'); expect(JSON.stringify(h.txCalls)).not.toMatch(/10\.(9|8|7)\.\d\.\d/);
  });
});

describe('OpenAPI contract of the six operations (contracts/openapi/identity.yaml)', () => {
  const api: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const op = (id: string) => Object.values(api.paths as Record<string, any>).flatMap((p) => Object.values(p) as any[]).find((o) => o?.operationId === id);
  it.each(OPS)('%s: identity_auth context, x-public justification, security none (the token / credentials authenticate)', (id) => {
    const o = op(id); expect(o['x-context']).toBe('identity_auth'); expect(typeof o['x-public']).toBe('string'); expect(o.security).toEqual([]);
  });
  it('rate tiers: login for loginPartner / openMobileSession, general for the rest; patient + mobile routes are edge-public, loginPartner is internal (partner BFF only)', () => {
    for (const id of ['loginPartner', 'openMobileSession']) expect(op(id)['x-rate-limit-tier'], id).toBe('login');
    for (const id of ['resolvePatientSession', 'logoutPatientSession', 'refreshMobileSession', 'logoutMobileSession']) expect(op(id)['x-rate-limit-tier'], id).toBe('general');
    expect(op('loginPartner')['x-edge-exposure']).toBe('internal'); for (const id of ['openMobileSession', 'refreshMobileSession', 'logoutMobileSession', 'resolvePatientSession', 'logoutPatientSession']) expect(op(id)['x-edge-exposure'], id).toBe('public');
  });
  it('openMobileSession declares auth.forbidden (AU-T17); resolvePatientSession requires the X-Lims-Patient-Session header', () => {
    expect(op('openMobileSession')['x-error-codes']).toContain('auth.forbidden');
    const p = (op('resolvePatientSession').parameters as any[]).find((x) => x.name === 'X-Lims-Patient-Session'); expect(p).toMatchObject({ in: 'header', required: true });
  });
});

describe('static guards on the T31 files (P-61, D-212, 07-SECURITY s5 logging rules, LD-81)', () => {
  it('all handler files and the service exist', () => { for (const f of FILES) expect(existsSync(f), f).toBe(true); });
  it.each(FILES.map((f) => [f.slice(MOD.length + 1).replace(/\\/g, '/'), f]))('%s: no X-Forwarded-For / x-real-ip read, no console.*, no secret env beyond lifetimes', (_n, f) => {
    if (!existsSync(f)) return expect(existsSync(f)).toBe(true); const s = src(f);
    expect(s).not.toMatch(/x-forwarded-for|x-real-ip|\bforwarded\b/i); expect(s).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(s).not.toMatch(/process\.env\[?\.?['"]?LIMS_IDENTITY_(TOKEN_ENC|EMAIL_HMAC|GOTRUE_SERVICE)/);
  });
  it.each(OPS)('handlers/%s.ts contains no SQL and no db.tx / requestTx / withTenantScope; the one identityAuthTx call lives in the handler or the service', (o) => {
    const h = join(MOD, 'handlers', `${o}.ts`); const sv = join(MOD, 'service', 'session.service.ts');
    for (const f of [h, sv]) {
      if (!existsSync(f)) return expect(existsSync(f)).toBe(true); const s = src(f);
      expect(s).not.toMatch(/\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+[\w.]*\s+SET|DELETE\s+FROM)\b/i); expect(s).not.toMatch(/\.(requestTx|withTenantScope)\b|db\.tx\b/);
    }
    expect(src(h) + src(sv)).toMatch(/identityAuthTx/);
  });
  it('bindTenant is never called with a value read from the request (body / params / query / headers)', () => {
    for (const f of FILES) { if (!existsSync(f)) return expect(existsSync(f)).toBe(true); expect(src(f)).not.toMatch(/bindTenant\([^)]*(body|params|query|headers)/); }
  });
  it('reuse revoke uses the CHECK-set reason token_reuse and the event session_token_reused (05-SCHEMA s4.1, 08 A3.1), and calls commitOnError', () => {
    const s = FILES.filter(existsSync).map(src).join('\n'); expect(s).toMatch(/token_reuse/); expect(s).toMatch(/session_token_reused/); expect(s).toMatch(/commitOnError/);
  });
  it('the patient path has no GoTrue call (LD-81): the patient handlers import no GoTrue gateway', () => {
    for (const o of ['resolvePatientSession', 'logoutPatientSession']) { const f = join(MOD, 'handlers', `${o}.ts`); if (!existsSync(f)) return expect(existsSync(f)).toBe(true); expect(src(f)).not.toMatch(/gotrue\/gateway(\.http)?/); }
  });
  it('tokens (session, access, refresh) are never interpolated into a log call or an Error message', () => {
    for (const f of FILES) { if (!existsSync(f)) return expect(existsSync(f)).toBe(true); expect(src(f)).not.toMatch(/(log|logger)\??\.(info|warn|error|debug)\([^)]*(refreshToken|accessToken|token)/i); expect(src(f)).not.toMatch(/new (Lims)?Error\([^)]*\$\{[^}]*(refreshToken|accessToken|session_?token)/i); }
  });
});
