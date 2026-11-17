// WIRE-ID (C1) — the identity manifest exports the real IdentityPort, FAIL CLOSED (LD-187; 02-TRD s6.3 port registry, AC-0D-6.1/6.2/6.4;
// CR-C2-013 ctx.core.systemActorPermissions; LD-81 patient access token signer stays unwired). AUTH-SENSITIVE.
// Synthetic data only. No database, no network: ctx.tx is an in-memory stub that records every query.
// Expected: ../index.ts `manifest.ports = { IdentityPort }` = createIdentityPort({ repo: createCoreAdminRepo(), systemActorPermissions: () => [] (no core source at
// construction, so every id is "unknown" = []), metrics default }). No mintPatientAccessToken, no env read, no file read, no connection at construction.
// The claimsResolver placeholder (db.identityAuthTx rejects common.internal, CR-C2-020 open point) is NOT part of this task and must not change.
import { randomUUID } from 'node:crypto';
import fs, { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORT_OWNERS, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { resolvePorts } from '../../../core/ports/registry.js';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';

const noop = () => undefined;
const log = { debug: noop, info: noop, warn: noop, error: noop };
const metrics = { setGauge: noop, inc: noop };

// Every other port as an inert marker: only IdentityPort is under test, the rest must not change its resolution.
const fakes = Object.fromEntries(Object.keys(PORT_OWNERS).map((p) => [p, { kind: 'fake', port: p }]));
const consumers = Object.fromEntries(Object.keys(PORT_OWNERS).map((p) => [p, ['frontdesk'] as readonly string[]]));
const otherOwners = (): Array<{ name: string; ports: Record<string, unknown> }> => {
  const byOwner = new Map<string, Record<string, unknown>>();
  for (const [port, owner] of Object.entries(PORT_OWNERS)) {
    if (port === 'IdentityPort') continue;
    byOwner.set(owner, { ...(byOwner.get(owner) ?? {}), [port]: { kind: 'real', port } });
  }
  return [...byOwner].map(([name, ports]) => ({ name, ports }));
};

const METHODS = ['getActor', 'assertRole', 'getTenantSettings', 'getSignatories', 'readBrandingAsset', 'provisionPartnerMembership', 'updatePartnerMembership',
  'provisionPatientMembership', 'openPatientSession', 'revokePatientSessions', 'getStaffNotificationContact', 'readSignatureImage', 'invalidateTenantSettings'];

// A planted signing-key file: its path fragment and content must never be opened, read or echoed (LD-187 rule 3).
const work = mkdtempSync(join(tmpdir(), 'wire-id-'));
const KEY_DIR_FRAGMENT = 'keydir-zq81-wire-id';
const KEY_FILE = join(mkdtempSync(join(work, `${KEY_DIR_FRAGMENT}-`)), 'patient-jwt.key');
const KEY_SENTINEL = 'PLANTED-wire-id-signing-key-3f9a61c0d27b';
writeFileSync(KEY_FILE, KEY_SENTINEL);

const TENANT = '123e4567-e89b-42d3-a456-426614174000';
const IDS = { membership: '223e4567-e89b-42d3-a456-426614174001', user: '323e4567-e89b-42d3-a456-426614174002', app: '423e4567-e89b-42d3-a456-426614174003' };

/** ctx.tx stub: answers only claims + membership reads, records every statement. Anything else is an empty result. */
function makeTx(claims: Record<string, unknown>, membership?: Record<string, unknown>) {
  const queries: string[] = [];
  return {
    queries,
    async query(text: string) {
      queries.push(text);
      if (/app\.current_claims\(\)/.test(text)) return { rows: [{ c: claims }] };
      if (membership && /FROM core\.memberships m/.test(text)) return { rows: [membership] };
      return { rows: [] };
    },
  };
}
const ctxOf = (actor: { type: string; id: string }, tx: unknown) => ({ tenantId: TENANT, requestId: randomUUID(), actor, tx }) as any;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

async function loadManifest(env: Record<string, string> = {}): Promise<any> {
  vi.resetModules();
  for (const k of Object.keys(process.env)) if (k.startsWith('LIMS_')) vi.stubEnv(k, undefined as never);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import('../index.js')).manifest;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../ports/IdentityPort.impl.js');
  vi.doUnmock('../repository/core-admin.repo.js');
  vi.resetModules();
});

describe('identity manifest ports (LD-187)', () => {
  it('validateManifest accepts the manifest', async () => {
    const manifest = await loadManifest();
    expect(() => validateManifest('identity', manifest, REPO_ROOT)).not.toThrow();
  });

  it('ports keys equal exactly [IdentityPort]', async () => {
    const manifest = await loadManifest();
    expect(Object.keys(manifest.ports ?? {})).toEqual(['IdentityPort']);
  });

  it('the port has every IdentityPort method (+ invalidateTenantSettings)', async () => {
    const port = (await loadManifest()).ports?.IdentityPort;
    expect(port).toBeDefined();
    for (const m of METHODS) expect(typeof port[m], m).toBe('function');
  });

  it('two imports share one instance (one process-wide port, one settings cache)', async () => {
    const m1 = await loadManifest();
    const { manifest: m2 } = await import('../index.js');
    expect(m2.ports.IdentityPort).toBe(m1.ports.IdentityPort);
    expect(m1.ports.IdentityPort).toBe(m1.ports.IdentityPort); // not a getter that builds a new port per read
  });

  it('boot with no LIMS_IDENTITY_* variable (every LIMS_* removed) succeeds', async () => {
    const manifest = await loadManifest({});
    expect(Object.keys(process.env).filter((k) => k.startsWith('LIMS_'))).toEqual([]);
    expect(manifest.ports.IdentityPort).toBeDefined();
    expect(manifest.ports.IdentityPort.getActor).toBeTypeOf('function');
  });

  it('the existing manifest members are kept: name, openapi, handlers, produces, createServices', async () => {
    const m = await loadManifest();
    expect(m.name).toBe('identity');
    expect(m.openapi).toBe('contracts/openapi/identity.yaml');
    expect(m.produces).toEqual([]);
    expect(Object.keys(m.handlers).length).toBeGreaterThan(0);
    expect(typeof m.createServices).toBe('function');
    expect(typeof m.claimsResolver?.resolve).toBe('function');
  });
});

describe('registry resolution (02-TRD s6.3, AC-0D-6.1/6.2/6.4)', () => {
  const resolve = (env: string, mods: unknown[], forceFake?: string[]) =>
    resolvePorts({ env, modules: mods as never, forceFake, fakes, stubs: {}, phaseStubs: [], owners: PORT_OWNERS, consumers, log, metrics });

  it('staging, PORT_OWNERS, no fakes forced: IdentityPort resolves real', async () => {
    const manifest = await loadManifest();
    const { resolution } = resolve('staging', [{ name: 'identity', ports: manifest.ports }, ...otherOwners()]);
    expect(resolution.IdentityPort).toBe('real');
  });

  it('production: IdentityPort resolves real', async () => {
    const manifest = await loadManifest();
    const { resolution } = resolve('production', [{ name: 'identity', ports: manifest.ports }, ...otherOwners()]);
    expect(resolution.IdentityPort).toBe('real');
  });

  it('staging: the exported port is the one handed to a listed consumer', async () => {
    const manifest = await loadManifest();
    const { portsFor } = resolve('staging', [{ name: 'identity', ports: manifest.ports }, ...otherOwners()]);
    expect((portsFor('frontdesk') as any).IdentityPort).toBe(manifest.ports.IdentityPort);
  });

  it.each(['dev', 'ci'])('%s: real beats the fake once the owner exports it', async (env) => {
    const manifest = await loadManifest();
    const { resolution } = resolve(env, [{ name: 'identity', ports: manifest.ports }]);
    expect(resolution.IdentityPort).toBe('real');
  });

  it('dev/ci: LIMS_CORE_FAKE_PORTS=IdentityPort still forces the fake (registry not weakened)', async () => {
    const manifest = await loadManifest();
    const { resolution } = resolve('ci', [{ name: 'identity', ports: manifest.ports }], ['IdentityPort']);
    expect(resolution.IdentityPort).toBe('fake');
  });

  it('staging/production: forcing the fake is still a boot failure', async () => {
    const manifest = await loadManifest();
    expect(() => resolve('production', [{ name: 'identity', ports: manifest.ports }, ...otherOwners()], ['IdentityPort'])).toThrow(/not allowed in production/);
  });

  it('staging without the identity module still fails (the manifest line is the only thing that fixes IdentityPort)', () => {
    expect(() => resolve('staging', otherOwners())).toThrow(/IdentityPort: owner module identity not loaded/);
  });
});

describe('construction (LD-187 rules 1-3: createCoreAdminRepo() + fail-closed systemActorPermissions, nothing else)', () => {
  async function withSpies(env: Record<string, string> = {}) {
    const repo = { marker: 'repo' };
    const port = { marker: 'port' };
    const createCoreAdminRepo = vi.fn(() => repo);
    const createIdentityPort = vi.fn(() => port);
    vi.resetModules();
    vi.doMock('../repository/core-admin.repo.js', async (orig) => ({ ...(await orig<object>()), createCoreAdminRepo }));
    vi.doMock('../ports/IdentityPort.impl.js', async (orig) => ({ ...(await orig<object>()), createIdentityPort }));
    for (const k of Object.keys(process.env)) if (k.startsWith('LIMS_')) vi.stubEnv(k, undefined as never);
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const manifest = (await import('../index.js')).manifest as any;
    void manifest.ports.IdentityPort; // construction may be eager or lazy; reading it must trigger it by now
    const again = (await import('../index.js')).manifest as any;
    void again.ports.IdentityPort;
    return { manifest, repo, port, createCoreAdminRepo, createIdentityPort };
  }

  it('repo = createCoreAdminRepo() once (no storage, no deps); port = createIdentityPort({ repo, systemActorPermissions }) once', async () => {
    const { manifest, repo, port, createCoreAdminRepo, createIdentityPort } = await withSpies();
    expect(createCoreAdminRepo).toHaveBeenCalledTimes(1);
    expect(createCoreAdminRepo.mock.calls[0]?.[0] ?? {}).toEqual({});
    expect(createIdentityPort).toHaveBeenCalledTimes(1);
    const deps = (createIdentityPort.mock.calls[0] as unknown[])[0] as any;
    expect(deps.repo).toBe(repo);
    expect(typeof deps.systemActorPermissions).toBe('function');
    expect(manifest.ports.IdentityPort).toBe(port);
  });

  it('systemActorPermissions is fail closed: [] for every id (unknown id gives [], never a default that allows anything)', async () => {
    const { createIdentityPort } = await withSpies();
    const deps = (createIdentityPort.mock.calls[0] as unknown[])[0] as any;
    const ids = [randomUUID(), '', 'system', 'identity', 'worker-reporting', 'platform', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'a'.repeat(5000)];
    for (const id of ids) {
      const got = deps.systemActorPermissions(id);
      expect(Array.isArray(got), `id ${id.slice(0, 20)}`).toBe(true);
      expect([...got], `id ${id.slice(0, 20)}`).toEqual([]);
    }
  });

  it('LD-81: mintPatientAccessToken and every patient writer are NOT passed (patient session minting stays unwired)', async () => {
    const { createIdentityPort, createCoreAdminRepo } = await withSpies({ LIMS_IDENTITY_PATIENT_JWT_KEY_FILE: KEY_FILE });
    const deps = (createIdentityPort.mock.calls[0] as unknown[])[0] as any;
    expect(deps.mintPatientAccessToken).toBeUndefined();
    expect(Object.keys(deps).sort()).toEqual(expect.not.arrayContaining(['mintPatientAccessToken', 'newToken', 'newId']));
    expect(createCoreAdminRepo).toHaveBeenCalledTimes(1);
  });

  it('LIMS_IDENTITY_* variables do not change construction (nothing is read from env)', async () => {
    const bare = await withSpies({});
    const bareDeps = Object.keys((bare.createIdentityPort.mock.calls[0] as unknown[])[0] as object).sort();
    const full = await withSpies({
      LIMS_IDENTITY_EMAIL_HMAC_KEY: 'synthetic-hmac-key-0123456789abcdef', LIMS_IDENTITY_PATIENT_JWT_KEY_FILE: KEY_FILE,
      LIMS_IDENTITY_TOKEN_ENC_KEYS: 'synthetic', LIMS_IDENTITY_GOTRUE_URL: 'https://gotrue.invalid', LIMS_IDENTITY_GOTRUE_SERVICE_KEY: 'synthetic',
    });
    expect(Object.keys((full.createIdentityPort.mock.calls[0] as unknown[])[0] as object).sort()).toEqual(bareDeps);
  });
});

describe('construction does no I/O: no env read, no file read, no connection (LD-187 rule 3)', () => {
  it('importing the manifest and reading the port reads no LIMS_IDENTITY_* env var, opens no file, no socket, no fetch', async () => {
    const real = process.env;
    const reads: string[] = [];
    const opened: string[] = [];
    const rec = (args: unknown[]) => { const p = args[0]; if (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) opened.push(String(p)); };
    const wrap = (obj: any, name: string) => { const orig = obj[name]; vi.spyOn(obj, name).mockImplementation(((...a: unknown[]) => { rec(a); return orig.apply(obj, a); }) as never); };
    for (const n of ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream', 'statSync', 'accessSync', 'existsSync']) wrap(fs, n);
    for (const n of ['readFile', 'open']) wrap(fs.promises, n);
    syncBuiltinESMExports();
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await loadManifest({ LIMS_IDENTITY_PATIENT_JWT_KEY_FILE: KEY_FILE });
      Object.defineProperty(process, 'env', {
        configurable: true, enumerable: true, writable: true,
        value: new Proxy(real, { get(t, k, r) { if (typeof k === 'string' && k.startsWith('LIMS_IDENTITY_')) reads.push(k); return Reflect.get(t, k, r); } }),
      });
      vi.resetModules();
      const manifest = (await import('../index.js')).manifest as any;
      void manifest.ports.IdentityPort;
      // positive control: the file spy really sees a read made from a test-module named import (otherwise this test proves nothing)
      const before = opened.length;
      readFileSync(KEY_FILE);
      expect(opened.length, 'fs spy must observe named-import reads').toBeGreaterThan(before);
      opened.length = before;
    } finally {
      Object.defineProperty(process, 'env', { configurable: true, enumerable: true, writable: true, value: real });
    }
    expect(reads, 'LIMS_IDENTITY_* env read during construction').toEqual([]);
    expect(opened.filter((p) => p.includes(KEY_DIR_FRAGMENT)), 'planted signing key opened').toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('fail closed: the system actor has no permission (CR-C2-013 unknown id gives [])', () => {
  const systemCtx = (id: string, tx = makeTx({})) => ctxOf({ type: 'system', id }, tx);

  it('getActor of an unknown system actor id: permissions [] (no widening); existing profile shape unchanged', async () => {
    const port = (await loadManifest()).ports.IdentityPort;
    const tx = makeTx({});
    const profile = await port.getActor(systemCtx(randomUUID(), tx));
    expect(profile.permissions).toEqual([]);
    expect(profile.actor).toMatchObject({ type: 'system' });
    expect(profile.displayName).toBe('System');
    expect(profile.centreScope).toEqual({ all: true, centreIds: [] });
    expect(tx.queries).toHaveLength(1); // claims only: nothing else is read for a system actor
  });

  it('getSignatories / readSignatureImage by a system actor are forbidden before any db read (needs identity.signatory.read)', async () => {
    const port = (await loadManifest()).ports.IdentityPort;
    for (const id of [randomUUID(), 'identity-system', '__proto__', 'constructor']) {
      const tx = makeTx({});
      const e1 = await rejection(port.getSignatories(systemCtx(id, tx), { membershipIds: [IDS.membership] }));
      expect(e1.code, id).toBe('auth.forbidden');
      const e2 = await rejection(port.readSignatureImage(systemCtx(id, tx), { membershipId: IDS.membership }));
      expect(e2.code, id).toBe('auth.forbidden');
      expect(tx.queries, `no query for ${id}`).toEqual([]);
    }
  });

  it('assertRole: a system actor is forbidden for EVERY known permission code (nothing is granted by default)', async () => {
    const port = (await loadManifest()).ports.IdentityPort;
    const ctx = systemCtx(randomUUID());
    const granted: string[] = [];
    for (const permission of PERMISSION_CODES) {
      try { await port.assertRole(ctx, { permission }); granted.push(permission); } catch (e: any) { expect(e.code, permission).toBe('auth.forbidden'); }
    }
    expect(granted).toEqual([]);
  });

  it('authorization outcome metric is still emitted through the bound sink (lims_identity_authz_decisions_total{outcome=forbidden})', async () => {
    const manifest = await loadManifest();
    const inc = vi.fn();
    manifest.createServices({ metrics: { inc, setGauge: vi.fn() } });
    const e = await rejection(manifest.ports.IdentityPort.assertRole(systemCtx(randomUUID()), { permission: 'identity.signatory.read' }));
    expect(e.code).toBe('auth.forbidden');
    expect(inc).toHaveBeenCalledWith('lims_identity_authz_decisions_total', expect.objectContaining({ outcome: 'forbidden' }), undefined);
  });
});

describe('LD-81: patient session minting stays unwired (no signer, no patient writer)', () => {
  const patientRow = () => ({
    id: IDS.membership, user_id: IDS.user, tenant_id: TENANT, actor_type: 'patient', status: 'active', locked_at: null, all_centres: false, version: 1,
    partner_role: null, signatory_display_title: null, signatory_registration_no: null, signature_image_ref: null,
    display_name: 'Synthetic Patient', email_normalized: null, role_codes: [], permissions: [], centre_ids: [], branch_ids: [], mfa_enrolled: false,
  });
  const preAuth = (tx: unknown) => ctxOf({ type: 'patient', id: IDS.user }, tx);
  const open = { membershipId: IDS.membership, appInstanceId: IDS.app, appPlatform: 'android' };

  it('openPatientSession (needs mintPatientAccessToken) throws common.internal "patient writer not wired"; no write, no token, key file untouched', async () => {
    const port = (await loadManifest({ LIMS_IDENTITY_PATIENT_JWT_KEY_FILE: KEY_FILE })).ports.IdentityPort;
    const tx = makeTx({ patient_stage: 'pre_auth' }, patientRow());
    const out: string[] = [];
    for (const s of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, s).mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as never);
    const e = await rejection(port.openPatientSession(preAuth(tx), open));
    expect(e.code).toBe('common.internal');
    expect(e.detail).toMatch(/patient writer not wired/);
    expect(tx.queries.some((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q))).toBe(false);
    const leaked = [e.message, e.detail, e.stack, ...out].join('\n');
    expect(leaked).not.toContain(KEY_SENTINEL);
    expect(leaked).not.toContain(KEY_DIR_FRAGMENT);
  });

  it('provisionPatientMembership (no patient writer in the real repo) throws common.internal "not wired"; no write', async () => {
    const port = (await loadManifest()).ports.IdentityPort;
    const tx = makeTx({ patient_stage: 'pre_auth' });
    const e = await rejection(port.provisionPatientMembership(preAuth(tx), { accountId: IDS.app }));
    expect(e.code).toBe('common.internal');
    expect(e.detail).toMatch(/not wired/);
    expect(tx.queries.some((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q))).toBe(false);
  });

  it('openPatientSession is still forbidden for a non pre_auth patient and for a non-patient actor (authorization outcome unchanged)', async () => {
    const port = (await loadManifest()).ports.IdentityPort;
    expect((await rejection(port.openPatientSession(preAuth(makeTx({ patient_stage: 'authenticated' }, patientRow())), open))).code).toBe('auth.forbidden');
    expect((await rejection(port.openPatientSession(ctxOf({ type: 'system', id: randomUUID() }, makeTx({})), open))).code).toBe('auth.forbidden');
  });
});

describe('claimsResolver placeholder is unchanged (CR-C2-020 open point, not this task)', () => {
  const jwt = { sub: IDS.user, sessionId: IDS.membership, aal: 'aal1', exp: 4_102_444_800, iat: 1_700_000_000 };
  const req = { clientIp: '203.0.113.7', requestId: randomUUID(), endpointFamily: 'staff' };

  it('a well-formed JWT rejects with common.internal while no db is handed over (never authenticates)', async () => {
    const m = await loadManifest();
    const e = await rejection(m.claimsResolver.resolve(jwt, req));
    expect(e.code).toBe('common.internal');
    expect(e.detail).toBe('identity: ctx.db not wired into module construction');
  });

  it('a malformed JWT is still rejected as auth.unauthenticated without touching a db', async () => {
    const m = await loadManifest();
    const out = await m.claimsResolver.resolve({ ...jwt, sub: 'not-a-uuid' }, req);
    expect(out).toEqual({ kind: 'rejected', code: 'auth.unauthenticated' });
  });

  it('the IdentityPort wiring does not hand the placeholder db anything: ports and claimsResolver stay separate objects', async () => {
    const m = await loadManifest();
    expect(m.ports.IdentityPort).not.toBe(m.claimsResolver);
    expect(m.claimsResolver).not.toHaveProperty('identityAuthTx');
  });
});
