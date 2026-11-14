// C10 T-01 — module skeleton: manifest, permissions, config, 49 operationId stubs (06-IMPLEMENTATION-PLAN row T-01; 02-TRD §3.2, §6, §8.1).
// done_when: "API and worker boot with fakes; each operation throws common.internal until its task (none returns 501)"; manifest produces: [] CI check.
// Security (07 REQ-SEC-099): every operation has x-permission, none is x-public; fail-closed auth on all of them (bearerJwt only).
// Interface expected from the writer (SEAMS = spec does not fix them; same shape as modules/analytics):
//   ../index.ts        export const manifest: ModuleManifest — name 'micro', openapi 'contracts/openapi/micro.yaml', handlers = the 49 operationIds,
//                      ports {} (TRD §7.2 none), produces [] (TRD §8.1 none), no systemPermissions / claimsResolver / authResolvers on the API side.
//   ../permissions.ts  export const MICRO_PERMISSIONS (frozen) = the four micro.* codes of contracts/permissions.yaml.
//   ../config.ts       export function loadMicroConfig(env): MicroConfig — fields importMaxBytes, importMaxLines, importTimeoutMs, specimenLookupPort,
//                      reconcileBatch (env keys + defaults TRD §6; LIMS_MICRO_BFF_LOOKUP_CONCURRENCY is web env, not read here). Bad value throws, naming the key.
//   Stubs: "none returns 501" -> in EVERY LIMS_CORE_ENV (dev included) a stub rejects LimsError common.internal and never echoes request input.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';
import { eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { AUD, ISS, makeKeys, tmpFile } from '../../../core/auth/__tests__/helpers.js';
import { loadMicroConfig } from '../config.js';
import { manifest } from '../index.js';
import { MICRO_PERMISSIONS } from '../permissions.js';

const SPEC = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'micro.yaml'));
const OPS = operationIds(SPEC);
const PERMS = ['micro.breakpoint.manage', 'micro.config.manage', 'micro.culture.read', 'micro.culture.work'];
/** operationIds whose stub a later task has replaced; that task moves its ids here (tester-owned list). */
const IMPLEMENTED: readonly string[] = [
  // T-05: M23–M28, M39, M40
  'listMicroCodedSet', 'upsertMicroCode', 'listPlatingProtocols', 'createPlatingProtocol', 'versionPlatingProtocol', 'deactivatePlatingProtocol', 'getMicroSettings', 'updateMicroSettings',
  // T-07: M1, M2, M15, M16
  'listCultures', 'getCulture', 'listCultureReportVersions', 'getCultureReportVersion',
  // T-08: M3–M6
  'setupCulture', 'addCulturePlate', 'discardCulturePlate', 'recordCultureObservation',
  // T-09: M7–M10
  'createIsolate', 'identifyIsolate', 'describeIsolate', 'withdrawIsolate',
  // T-10: M11, M12, M29–M32
  'assignAstPanel', 'recordAstResults', 'listAstPanels', 'createAstPanel', 'versionAstPanel', 'deactivateAstPanel',
  // T-11: M41–M45, M49
  'listBreakpointSets', 'createBreakpointImport', 'getBreakpointSet', 'listBreakpointImportIssues', 'listBreakpointRows', 'downloadBreakpointTemplate',
  // T-13: M46–M48, M13
  'activateBreakpointSet', 'retireBreakpointSet', 'discardBreakpointSet', 'previewAstInterpretation',
  // T-14: M19–M22, M33–M38
  'listMicroInstrumentRecords', 'assignMicroInstrumentRecord', 'applyMicroInstrumentRecord', 'ignoreMicroInstrumentRecord',
  'listInstrumentVocabMaps', 'createInstrumentVocabMap', 'updateInstrumentVocabMap', 'deactivateInstrumentVocabMap',
  'listInstrumentAstDefaults', 'putInstrumentAstDefault',
  // T-15: M14
  'submitCultureReport',
  // T-16: M17, M18
  'reopenCulture', 'cancelCulture',
];

const FAKE_REQ = { params: {}, query: {}, headers: {}, body: {} };
const noop = () => undefined;
const fakeCtx = (operationId: string) => ({ operationId, clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } }) as any;

function opsOf(spec: any): { path: string; method: string; op: any }[] {
  const out: { path: string; method: string; op: any }[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) for (const [method, op] of Object.entries<any>(item)) if (op?.operationId) out.push({ path, method, op });
  return out;
}

describe('C10-T01 manifest', () => {
  it('is module micro bound to contracts/openapi/micro.yaml and passes the core manifest validation', () => {
    expect(manifest.name).toBe('micro');
    expect(manifest.openapi).toBe('contracts/openapi/micro.yaml');
    expect(() => validateManifest('micro', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces no event (TRD §8.1), owns no port (§7.2), declares no systemPermissions / claimsResolver / authResolvers', () => {
    expect([...manifest.produces]).toEqual([]);
    expect([...(eventProducers().micro ?? [])]).toEqual([]);
    expect(Object.keys(manifest.ports ?? {})).toEqual([]);
    expect([...(manifest.systemPermissions ?? [])]).toEqual([]);
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual([]);
  });

  it('core boot validation rejects drift: missing handler, extra handler, non-empty produces', () => {
    const missing = OPS[0]!;
    const { [missing]: _drop, ...rest } = manifest.handlers;
    expect(() => validateManifest('micro', { ...manifest, handlers: rest }, REPO_ROOT)).toThrow(missing);
    expect(() => validateManifest('micro', { ...manifest, handlers: { ...manifest.handlers, notInSpec: manifest.handlers[missing]! } }, REPO_ROOT)).toThrow('notInSpec');
    expect(() => validateManifest('micro', { ...manifest, produces: ['lab.result.approved.v1'] }, REPO_ROOT)).toThrow(/produces/);
  });
});

describe('C10-T01 handler map (49 operationIds, M1–M49)', () => {
  it('the spec has 49 unique operationIds', () => {
    expect(OPS.length).toBe(49);
    expect(new Set(OPS).size).toBe(49);
  });

  it('binds every operationId of micro.yaml to a function, and nothing else (AC-0D-1.2)', () => {
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

  it('in every environment (dev included) a stub rejects LimsError common.internal — never resolves, never 501', async () => {
    for (const env of ['dev', 'ci', 'staging', 'production']) {
      const m = await withEnv(env);
      const { isLimsError: isLE } = await import('../../../core/errors.js'); // same registry as the stub (withEnv reset modules)
      for (const op of stubs) {
        const out = await Promise.resolve(m.handlers[op]!(FAKE_REQ, fakeCtx(op))).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
        expect(out.ok, `${env} ${op} resolved: ${JSON.stringify(out)}`).toBe(false);
        if (!out.ok) expect(isLE(out.e, 'common.internal'), `${env} ${op}`).toBe(true);
      }
    }
  });

  it('a stub never echoes request input (no PHI / token / barcode reflection) in its error', async () => {
    const m = await withEnv('dev');
    const planted = 'PLANTED-BARCODE-9f3a';
    for (const op of stubs) {
      const e: any = await Promise.resolve(m.handlers[op]!({ params: { id: planted }, query: { q: planted }, headers: { authorization: planted }, body: { barcode: planted } }, fakeCtx(op))).catch((x) => x);
      expect(JSON.stringify({ message: e?.message, detail: e?.detail, code: e?.code, extra: e?.extra }), op).not.toContain(planted);
    }
  });
});

describe('C10-T01 permissions (REQ-SEC-099)', () => {
  it('MICRO_PERMISSIONS = the four micro.* codes of contracts/permissions.yaml (none invented, none missing), frozen', () => {
    expect((PERMISSION_CODES as readonly string[]).filter((c) => c.startsWith('micro.')).sort()).toEqual(PERMS);
    expect([...MICRO_PERMISSIONS].sort()).toEqual(PERMS);
    expect(new Set(MICRO_PERMISSIONS).size).toBe(MICRO_PERMISSIONS.length);
    expect(Object.isFrozen(MICRO_PERMISSIONS)).toBe(true);
  });

  it('every operation: bearerJwt only, no x-public, exactly one registered micro permission', () => {
    const bad: string[] = [];
    for (const { path, method, op } of opsOf(SPEC)) {
      const where = `${method.toUpperCase()} ${path} (${op.operationId})`;
      const schemes = (op.security ?? []).flatMap((s: object) => Object.keys(s));
      if (schemes.length !== 1 || schemes[0] !== 'bearerJwt') bad.push(`${where}: scheme ${JSON.stringify(schemes)}`);
      if (op['x-public']) bad.push(`${where}: x-public`);
      const perm: string | undefined = op['x-permission'];
      if (typeof perm !== 'string' || !(PERMISSION_CODES as readonly string[]).includes(perm) || !MICRO_PERMISSIONS.includes(perm)) bad.push(`${where}: permission ${String(perm)}`);
    }
    expect(bad).toEqual([]);
  });

  it('permission split is the TRD §5 one: 13 culture.read, 17 culture.work, 12 config.manage, 7 breakpoint.manage (privileged, aal2)', () => {
    const n: Record<string, number> = {};
    for (const { op } of opsOf(SPEC)) n[op['x-permission']] = (n[op['x-permission']] ?? 0) + 1;
    expect(n).toEqual({ 'micro.culture.read': 13, 'micro.culture.work': 17, 'micro.config.manage': 12, 'micro.breakpoint.manage': 7 });
  });
});

describe('C10-T01 config (02-TRD §6, LIMS_MICRO_*)', () => {
  const DEFAULTS = { importMaxBytes: 5242880, importMaxLines: 20000, importTimeoutMs: 60000, specimenLookupPort: false, reconcileBatch: 200 };
  const INT_KEYS = ['LIMS_MICRO_IMPORT_MAX_BYTES', 'LIMS_MICRO_IMPORT_MAX_LINES', 'LIMS_MICRO_IMPORT_TIMEOUT_MS', 'LIMS_MICRO_RECONCILE_BATCH'];

  it('defaults when no env is set (TRD §6; specimen lookup port off until C5 implements it)', () => {
    expect(loadMicroConfig({})).toMatchObject(DEFAULTS);
  });

  it('reads overrides for every key', () => {
    expect(loadMicroConfig({
      LIMS_MICRO_IMPORT_MAX_BYTES: '1024', LIMS_MICRO_IMPORT_MAX_LINES: '10', LIMS_MICRO_IMPORT_TIMEOUT_MS: '500',
      LIMS_MICRO_SPECIMEN_LOOKUP_PORT: 'true', LIMS_MICRO_RECONCILE_BATCH: '7',
    })).toMatchObject({ importMaxBytes: 1024, importMaxLines: 10, importTimeoutMs: 500, specimenLookupPort: true, reconcileBatch: 7 });
  });

  it.each(INT_KEYS.flatMap((k) => ['abc', '0', '-1', '1.5', '1e3', ''].map((v) => [k, v] as const)))(
    'fails fast, naming the key: %s=%j', (key, value) => {
      expect(() => loadMicroConfig({ [key]: value })).toThrow(key);
    });

  it.each([['LIMS_MICRO_SPECIMEN_LOOKUP_PORT', 'yes'], ['LIMS_MICRO_SPECIMEN_LOOKUP_PORT', '1'], ['LIMS_MICRO_SPECIMEN_LOOKUP_PORT', '']])(
    'fails fast on a non-boolean, naming the key: %s=%j', (key, value) => {
      expect(() => loadMicroConfig({ [key]: value })).toThrow(key);
    });

  it('the CSV size cap may not exceed the 15 MB core upload cap (TRD §6 "≤ core 15 MB cap")', () => {
    expect(loadMicroConfig({ LIMS_MICRO_IMPORT_MAX_BYTES: String(15 * 1024 * 1024) })).toMatchObject({ importMaxBytes: 15 * 1024 * 1024 });
    expect(() => loadMicroConfig({ LIMS_MICRO_IMPORT_MAX_BYTES: String(15 * 1024 * 1024 + 1) })).toThrow('LIMS_MICRO_IMPORT_MAX_BYTES');
  });
});

describe('C10-T01 boot against the real repo (default modulesDir, real micro.yaml)', () => {
  const ks = makeKeys('ES256');
  const apps: FastifyInstance[] = [];
  afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

  const boot = async () => {
    const config = loadConfig({
      LIMS_CORE_ENV: 'ci',
      LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
      LIMS_WEB_BFF_KEY_FILE: tmpFile('c10-t01-web-key-0123456789abcdef0123456789abcdef0123'),
    });
    const app = await bootstrap({ config });
    apps.push(app);
    return app;
  };
  // Ruling C10.T-01 (#1, #2): substitute a schema-valid value per path param (enum -> enum[0], integer -> 1,
  // else UUID), so a 400 common.validation_failed (conventions §422) cannot pre-empt the 401 auth.* assertion.
  const toUrl = (path: string, op: any) =>
    path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
      const p = (op.parameters ?? []).find((q: any) => q.in === 'path' && q.name === name);
      if (Array.isArray(p?.schema?.enum)) return String(p.schema.enum[0]);
      return p?.schema?.type === 'integer' ? '1' : '01950c10-0000-7000-8000-000000000001';
    });

  it('boots and mounts every micro operation at its spec path and method (49 of 49)', async () => {
    const app = await boot();
    const unmounted: string[] = [];
    const all = opsOf(SPEC);
    for (const { path, method } of all) {
      if (!app.hasRoute({ method: method.toUpperCase() as any, url: path.replace(/\{([^}]+)\}/g, ':$1') })) unmounted.push(`${method.toUpperCase()} ${path}`);
    }
    expect(all.length).toBe(49);
    expect(unmounted).toEqual([]);
  });

  it('fails closed: operations without required query/body answer 401 auth.* without credentials (never 200/501/500); non-spec path is 404', async () => {
    const app = await boot();
    const probes = opsOf(SPEC)
      .filter(({ op }) => !(op.parameters ?? []).some((p: any) => p.in === 'query' && p.required) && !op.requestBody?.required)
      .map(({ method, path, op }) => ({ method: method.toUpperCase(), url: toUrl(path, op) }));
    expect(probes.length).toBeGreaterThanOrEqual(5);
    for (const { method, url } of probes) {
      const r = await app.inject({ method: method as any, url });
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(401);
      expect(JSON.parse(r.body).code).toMatch(/^auth\./);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/micro/not-in-spec' })).statusCode).toBe(404);
  });
});
