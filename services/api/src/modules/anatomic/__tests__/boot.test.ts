// C11 T-01 — module skeleton: manifest, permissions, config, 70 operationId stubs, boot (06-PLAN row T-01; 02-TRD §3.2, §5, §10.1; 07-SECURITY).
// done_when: "API and worker boot with fakes; every operationId of anatomic.yaml mapped; system actor holds exactly anatomic.case.work, frontdesk.order.read, catalog.test.read".
// Tests: boot test; config test (LIMS_ANATOMIC_IMAGE_MAX_BYTES > 15 MB fails boot); system-permission test. No ACs.
// SEAMS (spec does not fix them; same shape as smartreport/analytics modules):
//   ../index.ts        export const manifest: ModuleManifest — name 'anatomic', openapi 'contracts/openapi/anatomic.yaml', 70 handlers, ports {} (TRD §3.2),
//                      produces [], systemPermissions ['anatomic.case.work','frontdesk.order.read','catalog.test.read'], no resolvers.
//   ../permissions.ts  export const ANATOMIC_PERMISSIONS (frozen): the 4 anatomic.* codes of contracts/permissions.yaml.
//   ../config.ts       export function loadAnatomicConfig(env): camelCase fields imageMaxBytes, imageMaxMegapixels, listMaxLimit; env names/defaults TRD §10.1.
//                      Invalid -> Error naming the key.
//   Stub (SEAM, same as C8/C14): LIMS_CORE_ENV=dev -> resolves { status: 501 }, echoes no input; staging/production -> rejects LimsError common.internal.
// Fails now: ../index.js, ../permissions.js, ../config.js do not exist.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';
import { eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { AUD, ISS, makeKeys, tmpFile } from '../../../core/auth/__tests__/helpers.js';
import { loadAnatomicConfig } from '../config.js';
import { manifest } from '../index.js';
import { ANATOMIC_PERMISSIONS } from '../permissions.js';

const SPEC = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'anatomic.yaml'));
const OPS = operationIds(SPEC);
const PERMS = ['anatomic.case.read', 'anatomic.case.signout', 'anatomic.case.work', 'anatomic.config.manage'];
const SYSTEM_PERMS = ['anatomic.case.work', 'catalog.test.read', 'frontdesk.order.read'];
const MB15 = 15 * 1024 * 1024; // 15728640

/** operationIds whose stub a later task has replaced; that task moves its ids here (tester-owned list). Empty at T-01. */
const IMPLEMENTED: readonly string[] = ['accessionAnatomicCase', 'updateAnatomicCaseDetails', 'addAnatomicPart', 'updateAnatomicPart', 'listAnatomicAssignees',
  // C11 T-07 (A1–A3)
  'listAnatomicCases', 'lookupAnatomicObject', 'getAnatomicCase',
  // C11 T-08 (A8, A9, A11; A10 already listed)
  'saveAnatomicGross', 'startAnatomicProcessing', 'cancelAnatomicCase',
  // C11 T-11 (K1–K12, K20–K22)
  'getAnatomicSettings', 'updateAnatomicSettings', 'listAnatomicStains', 'createAnatomicStain', 'updateAnatomicStain', 'listAnatomicTestProfiles', 'upsertAnatomicTestProfile',
  'listAnatomicAssays', 'createAnatomicAssay', 'updateAnatomicAssay', 'listAnatomicCodedValues', 'upsertAnatomicCodedValue',
  'listAnatomicTextTemplates', 'createAnatomicTextTemplate', 'updateAnatomicTextTemplate',
  // C11 T-16 (Q1–Q7) + the AC-11.6 guard on A10
  'saveAnatomicMolecularResults', 'listAnatomicBatches', 'createAnatomicBatch', 'getAnatomicBatch', 'addAnatomicBatchMembers', 'removeAnatomicBatchMembers', 'closeAnatomicBatch', 'markAnatomicCaseReady'];

const FAKE_REQ = { params: {}, query: {}, headers: {}, body: {} };
const noop = () => undefined;
const fakeCtx = (operationId: string) => ({ operationId, clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } }) as any;

describe('C11-T01 manifest', () => {
  it('is module anatomic bound to contracts/openapi/anatomic.yaml and passes the core manifest validation', () => {
    expect(manifest.name).toBe('anatomic');
    expect(manifest.openapi).toBe('contracts/openapi/anatomic.yaml');
    expect(() => validateManifest('anatomic', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces no event, owns no port, no resolvers (TRD §3.2: ports {}, produces [])', () => {
    expect([...manifest.produces]).toEqual([]);
    expect([...(eventProducers().anatomic ?? [])]).toEqual([]);
    expect(Object.keys(manifest.ports ?? {})).toEqual([]);
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual([]);
  });

  it('core boot validation rejects a handler set that drifts from the spec (missing and extra operationId)', () => {
    const missing = OPS[0]!;
    const { [missing]: _drop, ...rest } = manifest.handlers;
    expect(() => validateManifest('anatomic', { ...manifest, handlers: rest }, REPO_ROOT)).toThrow(missing);
    expect(() => validateManifest('anatomic', { ...manifest, handlers: { ...manifest.handlers, notInSpec: manifest.handlers[missing]! } }, REPO_ROOT)).toThrow('notInSpec');
  });
});

describe('C11-T01 system actor (done_when: holds exactly the three permissions)', () => {
  it('systemPermissions = anatomic.case.work + frontdesk.order.read + catalog.test.read — exactly, no dupes', () => {
    const sp = [...(manifest.systemPermissions ?? [])];
    expect([...sp].sort()).toEqual(SYSTEM_PERMS);
    expect(new Set(sp).size).toBe(sp.length);
  });

  it('every system permission is a registered code; none is privileged-by-name signout/config (least privilege: no anatomic.case.signout, no anatomic.config.manage, no *.manage/*.write)', () => {
    for (const c of manifest.systemPermissions ?? []) expect(PERMISSION_CODES as readonly string[], c).toContain(c);
    for (const forbidden of ['anatomic.case.signout', 'anatomic.config.manage', 'anatomic.case.read']) expect(manifest.systemPermissions, forbidden).not.toContain(forbidden);
    expect((manifest.systemPermissions ?? []).filter((c) => /\.(manage|write|signout|approve|release)$/.test(c))).toEqual([]);
  });
});

describe('C11-T01 handler map (70 operationIds, TRD §5)', () => {
  it('the spec has 70 unique operationIds', () => {
    expect(OPS.length).toBe(70);
    expect(new Set(OPS).size).toBe(70);
  });

  it('binds every operationId of anatomic.yaml to a function, and nothing else', () => {
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
      const { isLimsError: isLE } = await import('../../../core/errors.js');
      for (const op of stubs) {
        const out = await Promise.resolve(m.handlers[op]!(FAKE_REQ, fakeCtx(op))).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
        expect(out.ok, `${env} ${op} resolved: ${JSON.stringify(out)}`).toBe(false);
        if (!out.ok) expect(isLE(out.e, 'common.internal'), `${env} ${op}`).toBe(true);
      }
    }
  });
});

describe('C11-T01 permissions (07-SECURITY: one registered permission per operation, bearerJwt only)', () => {
  const codes = PERMISSION_CODES.filter((c) => c.startsWith('anatomic.'));

  it('ANATOMIC_PERMISSIONS = the anatomic.* codes of contracts/permissions.yaml (none invented, none missing), no dupes, frozen', () => {
    expect([...codes].sort()).toEqual(PERMS);
    expect([...ANATOMIC_PERMISSIONS].sort()).toEqual(PERMS);
    expect(new Set(ANATOMIC_PERMISSIONS).size).toBe(ANATOMIC_PERMISSIONS.length);
    expect(Object.isFrozen(ANATOMIC_PERMISSIONS)).toBe(true);
  });

  it('every operation: bearerJwt only (no device/portal/anonymous scheme) and exactly one registered anatomic permission', () => {
    const bad: string[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const where = `${method.toUpperCase()} ${path} (${op.operationId})`;
        const schemes = (op.security ?? []).flatMap((s: object) => Object.keys(s));
        if (schemes.length !== 1 || schemes[0] !== 'bearerJwt') bad.push(`${where}: scheme ${JSON.stringify(schemes)}`);
        const perm: string | undefined = op['x-permission'];
        if (!perm || !(PERMISSION_CODES as readonly string[]).includes(perm) || !ANATOMIC_PERMISSIONS.includes(perm)) bad.push(`${where}: permission ${String(perm)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('sign-out is not reachable with a weaker permission: every operation using anatomic.case.signout is the privileged one (4 ops), config ops use anatomic.config.manage (14)', () => {
    const count = (perm: string) => Object.values<any>(SPEC.paths).flatMap((i) => Object.values<any>(i)).filter((o) => o?.['x-permission'] === perm).length;
    expect(count('anatomic.case.signout')).toBe(4);
    expect(count('anatomic.config.manage')).toBe(14);
    expect(count('anatomic.case.work')).toBe(30);
    expect(count('anatomic.case.read')).toBe(22);
  });
});

describe('C11-T01 config (02-TRD §10.1, LIMS_ANATOMIC_*)', () => {
  it('defaults when no env is set (15 MB, 50 megapixels, list max 200)', () => {
    expect(loadAnatomicConfig({})).toMatchObject({ imageMaxBytes: MB15, imageMaxMegapixels: 50, listMaxLimit: 200 });
  });

  it('reads overrides for every key, including exactly 15 MB (boundary accepted)', () => {
    expect(loadAnatomicConfig({
      LIMS_ANATOMIC_IMAGE_MAX_BYTES: String(MB15), LIMS_ANATOMIC_IMAGE_MAX_MEGAPIXELS: '24', LIMS_ANATOMIC_LIST_MAX_LIMIT: '100',
    })).toMatchObject({ imageMaxBytes: MB15, imageMaxMegapixels: 24, listMaxLimit: 100 });
    expect(loadAnatomicConfig({ LIMS_ANATOMIC_IMAGE_MAX_BYTES: '1048576' }).imageMaxBytes).toBe(1048576);
  });

  it('config object is frozen (no runtime mutation of the 15 MB cap)', () => {
    expect(Object.isFrozen(loadAnatomicConfig({}))).toBe(true);
  });

  it.each([
    ['LIMS_ANATOMIC_IMAGE_MAX_BYTES', String(MB15 + 1)], ['LIMS_ANATOMIC_IMAGE_MAX_BYTES', '20971520'], ['LIMS_ANATOMIC_IMAGE_MAX_BYTES', '99999999999999'],
    ['LIMS_ANATOMIC_IMAGE_MAX_BYTES', '0'], ['LIMS_ANATOMIC_IMAGE_MAX_BYTES', '-1'], ['LIMS_ANATOMIC_IMAGE_MAX_BYTES', 'abc'],
    ['LIMS_ANATOMIC_IMAGE_MAX_BYTES', '1.5'], ['LIMS_ANATOMIC_IMAGE_MAX_BYTES', '1e7'], ['LIMS_ANATOMIC_IMAGE_MAX_BYTES', ''], ['LIMS_ANATOMIC_IMAGE_MAX_BYTES', '0x100'],
    ['LIMS_ANATOMIC_IMAGE_MAX_MEGAPIXELS', '0'], ['LIMS_ANATOMIC_IMAGE_MAX_MEGAPIXELS', '-5'], ['LIMS_ANATOMIC_IMAGE_MAX_MEGAPIXELS', 'abc'], ['LIMS_ANATOMIC_IMAGE_MAX_MEGAPIXELS', ''],
    ['LIMS_ANATOMIC_LIST_MAX_LIMIT', '0'], ['LIMS_ANATOMIC_LIST_MAX_LIMIT', '201'], ['LIMS_ANATOMIC_LIST_MAX_LIMIT', 'abc'], ['LIMS_ANATOMIC_LIST_MAX_LIMIT', ''],
  ])('fails fast, naming the key: %s=%j', (key, value) => {
    expect(() => loadAnatomicConfig({ [key]: value })).toThrow(key);
  });
});

describe('C11-T01 boot against the real repo (default modulesDir, real anatomic.yaml)', () => {
  const ks = makeKeys('ES256');
  const apps: FastifyInstance[] = [];
  afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

  const boot = async () => {
    const config = loadConfig({
      LIMS_CORE_ENV: 'ci',
      LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
      LIMS_WEB_BFF_KEY_FILE: tmpFile('c11-t01-web-key-0123456789abcdef0123456789abcdef0123'),
    });
    const app = await bootstrap({ config });
    apps.push(app);
    return app;
  };
  const toUrl = (path: string) => path.replace(/\{[^}]+\}/g, '01a1a98a-ac40-7000-8000-000000090001');

  it('boots and mounts every anatomic operation at its spec path and method (70 of 70)', async () => {
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
    expect(n).toBe(70);
    expect(unmounted).toEqual([]);
  }, 240_000); // full-repo bootstrap takes ~100 s on the dev box (review C11.T-08 item 2)

  it('boot fails when LIMS_ANATOMIC_IMAGE_MAX_BYTES exceeds 15 MB (TRD §10.1: "boot fails above")', async () => {
    vi.resetModules();
    vi.stubEnv('LIMS_ANATOMIC_IMAGE_MAX_BYTES', String(MB15 + 1));
    try {
      await expect(import('../index.js')).rejects.toThrow('LIMS_ANATOMIC_IMAGE_MAX_BYTES');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('fails closed: operations without required query/body answer 401 auth.* without credentials (never 200/501/500); non-spec path is 404', async () => {
    const app = await boot();
    const probes: { method: string; url: string }[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const requiredQuery = (op.parameters ?? []).some((p: any) => p.in === 'query' && p.required);
        const requiredHeader = (op.parameters ?? []).some((p: any) => (p.in === 'header' && p.required) || /\/(IfMatch|IdempotencyKey)$/.test(p.$ref ?? '')); // $ref'd If-Match/Idempotency-Key are unresolved in raw spec (ruling C11.T-01-ruling)
        if (!requiredQuery && !requiredHeader && !op.requestBody?.required) {
          // path params with an enum or integer type must carry a valid value, else validation (400) precedes auth (ruling C11.T-01-ruling)
          const url = path.replace(/\{([^}]+)\}/g, (_m, name) => {
            const prm = (op.parameters ?? []).find((p: any) => p.in === 'path' && p.name === name);
            if (prm?.schema?.type === 'integer') return String(prm.schema.minimum ?? 1);
            return prm?.schema?.enum?.[0] ?? '01a1a98a-ac40-7000-8000-000000090001';
          });
          probes.push({ method: method.toUpperCase(), url });
        }
      }
    }
    expect(probes.length).toBeGreaterThanOrEqual(5);
    for (const { method, url } of probes) {
      const r = await app.inject({ method: method as any, url });
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(401);
      expect(JSON.parse(r.body).code).toMatch(/^auth\./);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/anatomic/not-in-spec' })).statusCode).toBe(404);
    expect(toUrl('/v1/anatomic/cases/{case_id}')).toContain('01a1a98a');
  }, 240_000);
});
