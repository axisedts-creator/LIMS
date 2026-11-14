// C17 HC-T01 — module skeleton: manifest, permissions, config, 26 operationId stubs (06-IMPLEMENTATION-PLAN row HC-T01).
// done_when: "API boots with module; every operationId has a handler returning 501 (dev only)"; tests: boot test. No ACs.
// Security (07-SECURITY / 02-TRD §5): nothing mounted that is not in the spec, fail-closed bearerJwt on every operation, each op bound to
// one registered homecollection.* permission (privileged ones not reachable with a broader permission), stubs answer 501 only in dev and
// never echo request input (no PHI / token reflection).
// Interface expected from the writer (seams the spec does not fix are marked SEAM; modelled on modules/analytics):
//   ../index.ts        export const manifest: ModuleManifest (02-TRD §3.1: name 'homecollection', openapi 'contracts/openapi/homecollection.yaml',
//                      handlers = the 26 operationIds, ports {}, produces ['homecollection.collection.synced.v1'])
//   ../permissions.ts  export const HOMECOLLECTION_PERMISSIONS: readonly string[]  (SEAM: name; = the 6 homecollection.* codes of permissions.yaml, frozen)
//   ../config.ts       export function loadHomecollectionConfig(env): HomecollectionConfig  (SEAM: function + camelCase field names below;
//                      env names + defaults 02-TRD §11.1). Invalid value -> throws Error whose message names the LIMS_HOMECOLLECTION_* key.
//   Stubs (SEAM, plan: "501 only in dev"): LIMS_CORE_ENV=dev -> resolves { status: 501 }; staging/production -> never resolves 501:
//   rejects with LimsError common.internal. Env is set before import.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';
import { eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { AUD, ISS, makeKeys, tmpFile } from '../../../core/auth/__tests__/helpers.js';
import { loadHomecollectionConfig } from '../config.js';
import { manifest } from '../index.js';
import { HOMECOLLECTION_PERMISSIONS } from '../permissions.js';

const SPEC = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'homecollection.yaml'));
const OPS = operationIds(SPEC);
const PERMS = ['homecollection.device.manage', 'homecollection.handover.receive', 'homecollection.settings.manage',
  'homecollection.sync.upload', 'homecollection.visit.assign', 'homecollection.visit.read'];
// 02-TRD §5.1 H1..H21 + §5.2 A1..A5
const EXPECTED_OPS = [
  'listHomeVisits', 'getHomeVisit', 'assignHomeVisit', 'unassignHomeVisit', 'scheduleHomeVisit', 'cancelHomeVisit', 'createHomeRevisit',
  'resolveHomeVisitFlag', 'reviewHeldCollection', 'listHomeRoutes', 'resequenceHomeRoute', 'listEligiblePhlebotomists', 'listHandovers',
  'getHandover', 'confirmHandover', 'listPhleboDevices', 'requestDeviceWipe', 'getHomecollectionSettings', 'updateHomecollectionSettings',
  'listHomecollectionReasons', 'revealHomeVisitPhone',
  'registerPhleboDevice', 'getSyncSnapshot', 'pushSyncMutations', 'ackSync', 'signOffPhleboDevice',
];
/** operationIds whose stub a later task has replaced; that task moves its ids here (tester-owned list). */
const IMPLEMENTED: readonly string[] = ['getHomecollectionSettings', 'updateHomecollectionSettings', 'listHomecollectionReasons'];

const FAKE_REQ = { params: {}, query: {}, headers: {}, body: {} };
const noop = () => undefined;
const fakeCtx = (operationId: string) => ({ operationId, clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } }) as any;

describe('HC-T01 manifest', () => {
  it('is module homecollection bound to contracts/openapi/homecollection.yaml and passes the core manifest validation', () => {
    expect(manifest.name).toBe('homecollection');
    expect(manifest.openapi).toBe('contracts/openapi/homecollection.yaml');
    expect(() => validateManifest('homecollection', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces exactly homecollection.collection.synced.v1 (matches the event catalog), owns no port, no claimsResolver / authResolvers', () => {
    expect([...manifest.produces]).toEqual(['homecollection.collection.synced.v1']);
    expect([...(eventProducers().homecollection ?? [])]).toEqual(['homecollection.collection.synced.v1']);
    expect(Object.keys(manifest.ports ?? {})).toEqual([]);
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual([]);
  });

  it('core boot validation rejects a handler set that drifts from the spec (missing and extra operationId)', () => {
    const missing = OPS[0]!;
    const { [missing]: _drop, ...rest } = manifest.handlers;
    expect(() => validateManifest('homecollection', { ...manifest, handlers: rest }, REPO_ROOT)).toThrow(missing);
    expect(() => validateManifest('homecollection', { ...manifest, handlers: { ...manifest.handlers, notInSpec: manifest.handlers[missing]! } }, REPO_ROOT))
      .toThrow('notInSpec');
  });
});

describe('HC-T01 handler map (26 operationIds)', () => {
  it('the spec has the 26 operationIds of 02-TRD §5 (H1-H21, A1-A5), unique', () => {
    expect(OPS.length).toBe(26);
    expect(new Set(OPS).size).toBe(26);
    expect([...OPS].sort()).toEqual([...EXPECTED_OPS].sort());
  });

  it('binds every operationId of homecollection.yaml to a function, and nothing else (AC-0D-1.2)', () => {
    expect(Object.keys(manifest.handlers).sort()).toEqual([...OPS].sort());
    for (const op of OPS) expect(typeof manifest.handlers[op], op).toBe('function');
  });

  const stubs = OPS.filter((op) => !IMPLEMENTED.includes(op));
  const withEnv = async (env: string) => {
    vi.resetModules();
    vi.stubEnv('LIMS_CORE_ENV', env);
    vi.stubEnv('NODE_ENV', env === 'dev' ? 'development' : 'production');
    return (await import('../index.js')).manifest;
  };
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('in dev every stub answers 501 and never echoes request input (no PHI / token reflection)', async () => {
    const m = await withEnv('dev');
    const planted = 'PLANTED-TOKEN-9f3a';
    for (const op of stubs) {
      const r = await m.handlers[op]!({ params: { id: planted }, query: { q: planted }, headers: { authorization: planted }, body: { name: planted } }, fakeCtx(op));
      expect(r, op).toMatchObject({ status: 501 });
      expect(JSON.stringify(r), op).not.toContain(planted);
    }
  });

  it('in staging/production a stub never answers 501: it rejects with common.internal', async () => {
    for (const env of ['staging', 'production']) {
      const m = await withEnv(env);
      // same module registry as the stub (withEnv resets modules), so instanceof is meaningful
      const { isLimsError: isLE } = await import('../../../core/errors.js');
      for (const op of stubs) {
        const out = await Promise.resolve(m.handlers[op]!(FAKE_REQ, fakeCtx(op))).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
        expect(out.ok, `${env} ${op} resolved: ${JSON.stringify(out)}`).toBe(false);
        if (!out.ok) expect(isLE(out.e, 'common.internal'), `${env} ${op}`).toBe(true);
      }
    }
  });
});

describe('HC-T01 permissions', () => {
  const codes = PERMISSION_CODES.filter((c) => c.startsWith('homecollection.'));
  const permOf = (id: string): string | undefined => {
    for (const item of Object.values<any>(SPEC.paths)) for (const op of Object.values<any>(item)) if (op?.operationId === id) return op['x-permission'];
    return undefined;
  };

  it('HOMECOLLECTION_PERMISSIONS = the 6 homecollection.* codes of contracts/permissions.yaml (no invented code, none missing), frozen', () => {
    expect([...codes].sort()).toEqual(PERMS);
    expect([...HOMECOLLECTION_PERMISSIONS].sort()).toEqual(PERMS);
    expect(new Set(HOMECOLLECTION_PERMISSIONS).size).toBe(HOMECOLLECTION_PERMISSIONS.length);
    expect(Object.isFrozen(HOMECOLLECTION_PERMISSIONS)).toBe(true);
  });

  it('every operation: bearerJwt only (no anonymous scheme) and exactly one registered homecollection permission', () => {
    const bad: string[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const where = `${method.toUpperCase()} ${path} (${op.operationId})`;
        const schemes = (op.security ?? []).flatMap((s: object) => Object.keys(s));
        if (schemes.length !== 1 || schemes[0] !== 'bearerJwt') bad.push(`${where}: scheme ${JSON.stringify(schemes)}`);
        const perm: string | undefined = op['x-permission'];
        if (!perm || !(PERMISSION_CODES as readonly string[]).includes(perm) || !HOMECOLLECTION_PERMISSIONS.includes(perm)) bad.push(`${where}: permission ${String(perm)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('privileged operations keep their own permission (CR-C17-008): handovers, devices, settings are not reachable with visit.read/assign', () => {
    for (const op of ['listHandovers', 'getHandover', 'confirmHandover']) expect(permOf(op), op).toBe('homecollection.handover.receive');
    for (const op of ['listPhleboDevices', 'requestDeviceWipe']) expect(permOf(op), op).toBe('homecollection.device.manage');
    for (const op of ['getHomecollectionSettings', 'updateHomecollectionSettings']) expect(permOf(op), op).toBe('homecollection.settings.manage');
    for (const op of ['registerPhleboDevice', 'getSyncSnapshot', 'pushSyncMutations', 'ackSync', 'signOffPhleboDevice']) expect(permOf(op), op).toBe('homecollection.sync.upload');
    for (const op of ['listHomeVisits', 'getHomeVisit', 'listHomeRoutes', 'listHomecollectionReasons']) expect(permOf(op), op).toBe('homecollection.visit.read');
    for (const op of ['assignHomeVisit', 'unassignHomeVisit', 'scheduleHomeVisit', 'cancelHomeVisit', 'createHomeRevisit', 'resolveHomeVisitFlag',
      'reviewHeldCollection', 'resequenceHomeRoute', 'listEligiblePhlebotomists', 'revealHomeVisitPhone']) expect(permOf(op), op).toBe('homecollection.visit.assign');
  });
});

describe('HC-T01 config (02-TRD §11.1, LIMS_HOMECOLLECTION_*)', () => {
  const DEFAULTS = { pushMaxMutations: 100, pushMaxBytes: 524288, snapshotMaxVisits: 60, specimenRefreshSeconds: 60 };
  const KEYS: Record<keyof typeof DEFAULTS, string> = {
    pushMaxMutations: 'LIMS_HOMECOLLECTION_PUSH_MAX_MUTATIONS', pushMaxBytes: 'LIMS_HOMECOLLECTION_PUSH_MAX_BYTES',
    snapshotMaxVisits: 'LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS', specimenRefreshSeconds: 'LIMS_HOMECOLLECTION_SPECIMEN_REFRESH_SECONDS',
  };

  it('defaults when no env is set (TRD §11.1 values)', () => {
    expect(loadHomecollectionConfig({})).toMatchObject(DEFAULTS);
  });

  it('reads overrides for every key', () => {
    expect(loadHomecollectionConfig({
      LIMS_HOMECOLLECTION_PUSH_MAX_MUTATIONS: '10', LIMS_HOMECOLLECTION_PUSH_MAX_BYTES: '1024',
      LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS: '30', LIMS_HOMECOLLECTION_SPECIMEN_REFRESH_SECONDS: '15',
    })).toMatchObject({ pushMaxMutations: 10, pushMaxBytes: 1024, snapshotMaxVisits: 30, specimenRefreshSeconds: 15 });
  });

  it.each(Object.values(KEYS).flatMap((k) => ['abc', '0', '-1', '1.5', '1e3', ''].map((v) => [k, v] as const)))(
    'fails fast, naming the key: %s=%j', (key, value) => {
      expect(() => loadHomecollectionConfig({ [key]: value })).toThrow(key);
    });

  it('snapshotMaxVisits cannot exceed the spec cap of 60 (route sequence 1..60, snapshot never truncates)', () => {
    expect(() => loadHomecollectionConfig({ LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS: '61' })).toThrow('LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS');
  });
});

describe('HC-T01 boot against the real repo (default modulesDir, real homecollection.yaml)', () => {
  const ks = makeKeys('ES256');
  const apps: FastifyInstance[] = [];
  afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

  const boot = async () => {
    const config = loadConfig({
      LIMS_CORE_ENV: 'ci',
      LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
      LIMS_WEB_BFF_KEY_FILE: tmpFile('hc-t01-web-key-0123456789abcdef0123456789abcdef0123'),
    });
    const app = await bootstrap({ config });
    apps.push(app);
    return app;
  };
  const toUrl = (path: string) => path.replace(/\{[^}]+\}/g, '01a1a98a-ac40-7000-8000-000000090001');

  it('boots and mounts every homecollection operation at its spec path and method (26 of 26)', async () => {
    const app = await boot();
    const unmounted: string[] = [];
    let n = 0;
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        n++;
        if (!app.hasRoute({ method: method.toUpperCase() as any, url: path.replace(/\{([^}]+)\}/g, ':$1') })) unmounted.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(n).toBe(26);
    expect(unmounted).toEqual([]);
  }, 30_000);

  it('fails closed: operations without required query/body answer 401 auth.* without credentials (never 200/501/500); non-spec path is 404', async () => {
    const app = await boot();
    const probes: { method: string; url: string }[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const requiredQuery = (op.parameters ?? []).some((p: any) => p.in === 'query' && p.required);
        if (!requiredQuery && !op.requestBody?.required) probes.push({ method: method.toUpperCase(), url: toUrl(path) });
      }
    }
    expect(probes.length).toBeGreaterThanOrEqual(5);
    for (const { method, url } of probes) {
      const r = await app.inject({ method: method as any, url });
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(401);
      expect(JSON.parse(r.body).code).toMatch(/^auth\./);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/homecollection/not-in-spec' })).statusCode).toBe(404);
  }, 60_000);
});
