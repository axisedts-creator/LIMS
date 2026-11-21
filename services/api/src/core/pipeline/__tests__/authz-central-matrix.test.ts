// SEC-AUTHZ-2 (LD-261, LD-189; CR SEC-AUTHZ-1.1 Test plan 2-4): behaviour matrix per module group, mode config, exception file.
// Operation names and permissions are read from contracts/openapi/*.yaml (a line scan, as tests/security/authz-classification.test.mjs does),
// never typed here. Pinned interface: see authz-central.test.ts.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../config.js';
import { denies, rejects, rig, staffOp, SUB, TENANT_A, user } from './authz-central-rig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');
const CONTRACTS = path.join(ROOT, 'contracts', 'openapi');

interface C { module: string; operationId: string; permission: string | null; isPublic: boolean; bearer: boolean; method: string }
function scan(): C[] {
  const out: C[] = [];
  for (const f of readdirSync(CONTRACTS).filter((n) => n.endsWith('.yaml') && !n.startsWith('_')).sort()) {
    let cur: C | undefined; let method = ''; let inSecurity = false;
    for (const line of readFileSync(path.join(CONTRACTS, f), 'utf8').split(/\r?\n/)) {
      const mm = line.match(/^ {4}(get|put|post|patch|delete):\s*$/);
      if (mm) { method = mm[1]!.toUpperCase(); continue; }
      let m = line.match(/^ {6}operationId:\s*(\S+)\s*$/);
      if (m) { cur = { module: f.replace(/\.yaml$/, ''), operationId: m[1]!, permission: null, isPublic: false, bearer: false, method }; out.push(cur); inSecurity = false; continue; }
      if (!cur) continue;
      if (/^ {6}security:/.test(line)) { inSecurity = true; continue; }
      if (inSecurity && /^ {8}-/.test(line)) { if (/bearerJwt/.test(line)) cur.bearer = true; continue; }
      if (inSecurity && !/^ {8}/.test(line)) inSecurity = false;
      m = line.match(/^ {6}x-permission:\s*(\S+)\s*$/);
      if (m) cur.permission = m[1]!;
      if (/^ {6}x-public:/.test(line)) cur.isPublic = true;
    }
  }
  return out;
}
const ALL = scan();
const staffOps = ALL.filter((c) => c.bearer && !c.isPublic && c.permission && !c.permission.startsWith('platform.'));
const byModule = new Map<string, C[]>();
for (const c of staffOps) byModule.set(c.module, [...(byModule.get(c.module) ?? []), c]);
// two samples per module group (first and last, so reads and writes of a file are both likely), plus the four named gaps of the CR
const samples: C[] = [];
for (const [, list] of byModule) { samples.push(list[0]!); if (list.length > 1) samples.push(list[list.length - 1]!); }
for (const id of ['inviteUser', 'approveSupportSession', 'denySupportSession', 'revokeSupportSession']) {
  const c = staffOps.find((x) => x.operationId === id);
  if (c && !samples.includes(c)) samples.push(c);
}
const opOf = (c: C) => staffOp({ module: c.module, operationId: c.operationId, method: c.method, permission: c.permission, scheme: 'bearerJwt' });

describe('behaviour matrix: contract scan sanity', () => {
  it('finds every module group the CR names and the four gaps', () => {
    const mods = new Set(staffOps.map((c) => c.module));
    for (const m of ['identity', 'catalog', 'frontdesk', 'billing', 'lab', 'instruments', 'reporting', 'analytics', 'quality', 'micro', 'anatomic', 'inventory', 'partners', 'smartreport', 'payments', 'engagement', 'homecollection'])
      expect(mods.has(m), `module ${m} has a bearerJwt staff operation in contracts/openapi`).toBe(true);
    for (const id of ['inviteUser', 'approveSupportSession', 'denySupportSession', 'revokeSupportSession'])
      expect(staffOps.some((c) => c.operationId === id), id).toBe(true);
  });
});

describe.each(samples.map((c) => [`${c.module}.${c.operationId}`, c] as const))('matrix %s', (_name, c) => {
  const claims = user;
  it('enforce: user without the permission is denied (auth.forbidden), handler and repository not called', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [] } });
    const e = await rejects(r.run({ op: opOf(c), claims }));
    expect(e.code).toBe('auth.forbidden');
    expect(r.handlerCalls).toEqual([]);
    expect(r.repoCalls).toEqual([]);
    expect(r.asserted).toEqual([{ permission: c.permission }]);
  });

  it('enforce: user with exactly the permission reaches the handler', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [c.permission!] } });
    expect((await r.run({ op: opOf(c), claims })).status).toBe(200);
    expect(r.handlerCalls).toEqual(['handler']);
    expect(denies(r)).toEqual([]);
  });

  it('enforce: user holding only a DIFFERENT permission is denied', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [`${c.permission}.other`, 'catalog.test.read'].filter((p) => p !== c.permission) } });
    expect((await rejects(r.run({ op: opOf(c), claims }))).code).toBe('auth.forbidden');
    expect(r.handlerCalls).toEqual([]);
  });

  it('shadow: user without the permission reaches the handler and authz_central_deny is logged with this operation_id', async () => {
    const r = rig({ mode: 'shadow', profile: { permissions: [] } });
    expect((await r.run({ op: opOf(c), claims })).status).toBe(200);
    expect(r.handlerCalls).toEqual(['handler']);
    expect(denies(r)[0]?.obj).toMatchObject({ operation_id: c.operationId, actor_type: 'user', permission: c.permission, mode: 'shadow' });
    expect(r.incs).toContainEqual(['lims_core_authz_central_deny_total', { operation_id: c.operationId }]);
  });

  it.each(['patient', 'partner', 'portal'] as const)('enforce: %s actor is denied on this staff operation', async (actor_type) => {
    const r = rig({ mode: 'enforce', profile: { permissions: [c.permission!] } });
    const e = await rejects(r.run({ op: opOf(c), claims: { sub: SUB, tenant_id: TENANT_A, actor_type } }));
    expect(e.code).toBe('auth.forbidden');
    expect(r.handlerCalls).toEqual([]);
    expect(r.repoCalls).toEqual([]);
  });

  it('enforce: mfa_pending -> auth.mfa_required, password_setup -> auth.forbidden', async () => {
    const a = rig({ mode: 'enforce', profile: { permissions: [c.permission!], state: 'mfa_pending' } });
    expect((await rejects(a.run({ op: opOf(c), claims }))).code).toBe('auth.mfa_required');
    const b = rig({ mode: 'enforce', profile: { permissions: [c.permission!], state: 'password_setup' } });
    expect((await rejects(b.run({ op: opOf(c), claims }))).code).toBe('auth.forbidden');
  });
});

describe('LIMS_CORE_AUTHZ_MODE (config; unknown value stops boot, default shadow)', () => {
  const base = { LIMS_CORE_ENV: 'staging' };
  it.each(['dev', 'ci', 'staging', 'production'])('unset in %s -> shadow (LD-261: default shadow in every environment)', (env) => {
    expect((loadConfig({ LIMS_CORE_ENV: env }) as any).authzMode).toBe('shadow');
  });
  it.each(['shadow', 'enforce'])('accepts %s', (v) => {
    expect((loadConfig({ ...base, LIMS_CORE_AUTHZ_MODE: v }) as any).authzMode).toBe(v);
  });
  it.each(['', 'off', 'Enforce', 'SHADOW', ' shadow', 'true', '1', 'audit'])('rejects %j naming the key (boot stops)', (v) => {
    expect(() => loadConfig({ ...base, LIMS_CORE_AUTHZ_MODE: v })).toThrow(/LIMS_CORE_AUTHZ_MODE/);
  });
  it('production with the variable unset is shadow, not enforce, until SEC-AUTHZ-9', () => {
    expect((loadConfig({ LIMS_CORE_ENV: 'production' }) as any).authzMode).toBe('shadow');
  });
});

describe('authz-exceptions.json (documented shape; the loader validates every entry)', () => {
  const FILE = path.join(ROOT, 'services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json');
  const ids = new Set(ALL.map((c) => c.operationId));

  it('the file exists and is a list (empty or entries of { operationId, handlerPermission, reason })', () => {
    expect(existsSync(FILE), 'services/api/src/core/pipeline/authz-exceptions.json must exist').toBe(true);
    const list = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(Array.isArray(list)).toBe(true);
    for (const e of list) {
      expect(Object.keys(e).sort()).toEqual(['handlerPermission', 'operationId', 'reason']);
      expect(ids.has(e.operationId), `${e.operationId} must be an existing operationId of contracts/openapi`).toBe(true);
      expect(typeof e.handlerPermission === 'string' && e.handlerPermission.length > 0, `${e.operationId}: handlerPermission`).toBe(true);
      expect(typeof e.reason === 'string' && e.reason.trim().length > 0, `${e.operationId}: non-empty reason`).toBe(true);
    }
    expect(new Set(list.map((e: any) => e.operationId)).size, 'no operationId listed twice').toBe(list.length);
  });

  it('validateAuthzExceptions accepts a good list and the empty list', async () => {
    const { validateAuthzExceptions } = await import('../authz-central.js');
    expect(() => validateAuthzExceptions([], ids)).not.toThrow();
    expect(() => validateAuthzExceptions([{ operationId: 'inviteUser', handlerPermission: 'identity.user.manage', reason: 'handler checks the manage code' }], ids)).not.toThrow();
  });

  it.each([
    ['unknown operationId', [{ operationId: 'noSuchOperation', handlerPermission: 'a.b', reason: 'x' }]],
    ['empty reason', [{ operationId: 'inviteUser', handlerPermission: 'a.b', reason: '' }]],
    ['blank reason', [{ operationId: 'inviteUser', handlerPermission: 'a.b', reason: '   ' }]],
    ['missing reason', [{ operationId: 'inviteUser', handlerPermission: 'a.b' }]],
    ['missing handlerPermission', [{ operationId: 'inviteUser', reason: 'x' }]],
    ['empty handlerPermission', [{ operationId: 'inviteUser', handlerPermission: '', reason: 'x' }]],
    ['not a list', { operationId: 'inviteUser' }],
    ['duplicate operationId', [{ operationId: 'inviteUser', handlerPermission: 'a.b', reason: 'x' }, { operationId: 'inviteUser', handlerPermission: 'a.c', reason: 'y' }]],
    ['entry is not an object', ['inviteUser']],
  ])('validateAuthzExceptions rejects: %s', async (_n, entries) => {
    const { validateAuthzExceptions } = await import('../authz-central.js');
    expect(() => validateAuthzExceptions(entries, ids)).toThrow();
  });
});

describe('scope guards for SEC-AUTHZ-2 (no permission widened, stage 9 file comment-only)', () => {
  it('authz-guard.ts still exports the stage 9 surface unchanged (createAuthzGuard, markAsserted; RequestAuthz.identity/bind)', async () => {
    const mod = await import('../../ports/authz-guard.js');
    expect(typeof mod.createAuthzGuard).toBe('function');
    expect(typeof mod.markAsserted).toBe('function');
    const g = mod.createAuthzGuard({ env: 'ci', log: { error() {}, warn() {}, info() {}, debug() {} } as any, metrics: { inc() {}, setGauge() {} } as any });
    const req = g.forRequest();
    expect(typeof req.identity).toBe('function');
    expect(typeof req.bind).toBe('function');
    expect(req.asserted).toBe(false);
  });
});
