// C9 T-01 — module skeleton: manifest, permissions, config, 54 operationId stubs, phase switch (06-IMPLEMENTATION-PLAN row T-01).
// done_when: "API boots with every quality.yaml operationId mapped; LIMS_QUALITY_ENABLED=false -> 403 common.feature_disabled;
//   manifest produces=['quality.qc_run.rejected.v1']". Security: nothing mounted that is not in the spec; fail-closed auth (bearerJwt only);
//   each operation bound to one registered quality.* permission; stubs never echo request input; the phase switch answers before anything else.
// Interface expected from the writer (seams the spec does not fix are marked SEAM):
//   ../index.ts        export const manifest: ModuleManifest  (02-TRD §1: name 'quality', openapi 'contracts/openapi/quality.yaml', handlers = the 54
//                      operationIds, ports { QualityPort }, produces ['quality.qc_run.rejected.v1'])
//   ../permissions.ts  export const QUALITY_PERMISSIONS: readonly string[]  (SEAM: name; = the 8 quality.* codes of contracts/permissions.yaml, frozen)
//   ../config.ts       export function loadQualityConfig(env): QualityConfig  (SEAM: function + camelCase field names below; env names + defaults 02-TRD §12.2)
//   Phase switch (02-TRD §12.2): LIMS_QUALITY_ENABLED default false. While false EVERY handler rejects LimsError common.feature_disabled (403), in every
//   LIMS_CORE_ENV, before any other work. SEAM: whether the flag is read at import or per call is the writer's choice; the tests set env before import.
//   Stubs (SEAM, same rule as analytics/smartreport): flag true + LIMS_CORE_ENV=dev -> resolves { status: 501 }; staging/production -> rejects common.internal.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';
import { eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { AUD, ISS, makeKeys, tmpFile } from '../../../core/auth/__tests__/helpers.js';
import { loadQualityConfig } from '../config.js';
import { manifest } from '../index.js';
import { QUALITY_PERMISSIONS } from '../permissions.js';

const SPEC = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'));
const OPS = operationIds(SPEC);
const PERMS = ['quality.autoverify.manage', 'quality.autoverify.read', 'quality.config.manage', 'quality.qc.manage', 'quality.qc_run.read',
  'quality.qc_run.review', 'quality.tat_alert.ack', 'quality.tat_alert.read'];
const EXPECTED_OPS = [
  'listControlMaterials', 'createControlMaterial', 'getControlMaterial', 'updateControlMaterial', 'deactivateControlMaterial', 'createControlLevel',
  'updateControlLevel', 'createControlLot', 'listControlLots', 'updateControlLot', 'listControlIdMaps', 'createControlIdMap', 'deactivateControlIdMap',
  'listQcPlans', 'createQcPlan', 'getQcPlan', 'createQcPlanVersion', 'activateQcPlan', 'deactivateQcPlan', 'listQcTargets', 'createQcTarget',
  'establishQcTarget', 'activateQcTarget', 'retireQcTarget', 'discardQcTarget', 'listQcObservations', 'excludeQcObservation', 'listQcRuns', 'getQcRun',
  'evaluateQcRunNow', 'recordCorrectiveAction', 'closeQcRun', 'acknowledgeQcRun', 'getQcStatusBoard', 'getLeveyJenningsChart', 'getAutoverifyRuleSet',
  'createAutoverifyVersion', 'getAutoverifyVersion', 'replaceAutoverifyDraft', 'startAutoverifySimulation', 'stopAutoverifySimulation',
  'getAutoverifySimulationReport', 'activateAutoverifyVersion', 'retireAutoverifyVersion', 'discardAutoverifyDraft', 'listAutoverifyDecisions',
  'getAutoverifyDecision', 'listTatAlerts', 'getTatAlert', 'acknowledgeTatAlert', 'getQualitySettings', 'updateQualitySettings', 'listQualityCodedSet',
  'upsertQualityCode',
];
/** operationIds whose stub a later task has replaced; that task moves its ids here (tester-owned list). T-06 moved #1-#13 here. */
const IMPLEMENTED: readonly string[] = [
  ...EXPECTED_OPS.slice(0, 35),   // T-06 #1-#13, T-07 #14-#19, T-08 #20-#25, T-12 #26-#33 (listQcObservations … acknowledgeQcRun; ruling C9.T-12-ruling.md #4), T-13 #34 (getQcStatusBoard), T-14 #35 (getLeveyJenningsChart)
  // T-15 real handlers (#36-#41, #44, #45) — arbiter ruling .orchestra/notes/C9.T-06-ruling.md
  'getAutoverifyRuleSet', 'createAutoverifyVersion', 'getAutoverifyVersion', 'replaceAutoverifyDraft', 'startAutoverifySimulation',
  'stopAutoverifySimulation', 'retireAutoverifyVersion', 'discardAutoverifyDraft',
  // T-17 real handlers (#42, #43, #46, #47: simulation report, activation, decisions)
  'getAutoverifySimulationReport', 'activateAutoverifyVersion', 'listAutoverifyDecisions', 'getAutoverifyDecision',
  // T-20 real handlers (#51-#54: settings + coded sets)
  'getQualitySettings', 'updateQualitySettings', 'listQualityCodedSet', 'upsertQualityCode',
];

const FAKE_REQ = { params: {}, query: {}, headers: {}, body: {} };
const noop = () => undefined;
const fakeCtx = (operationId: string) => ({ operationId, clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } }) as any;
const PLANTED = 'PLANTED-TOKEN-9f3a';
const plantedReq = { params: { id: PLANTED }, query: { q: PLANTED }, headers: { authorization: PLANTED }, body: { name: PLANTED } };

/** Fresh import of the module under a given env; every var is set explicitly so the process env of the runner never leaks in. */
const withEnv = async (coreEnv: string, enabled: string | undefined) => {
  vi.resetModules();
  vi.stubEnv('LIMS_CORE_ENV', coreEnv);
  vi.stubEnv('NODE_ENV', coreEnv === 'dev' ? 'development' : 'production');
  vi.stubEnv('LIMS_QUALITY_ENABLED', enabled as string); // undefined => unset
  if (enabled === undefined) delete process.env['LIMS_QUALITY_ENABLED'];
  const m = (await import('../index.js')).manifest;
  const { isLimsError, toProblem } = await import('../../../core/errors.js'); // same module instance the handlers throw from (instanceof)
  return { m, isLimsError, toProblem };
};
const outcome = (p: Promise<unknown> | unknown) =>
  Promise.resolve(p).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

describe('C9 T-01 manifest', () => {
  it('is module quality bound to contracts/openapi/quality.yaml and passes the core manifest validation', () => {
    expect(manifest.name).toBe('quality');
    expect(manifest.openapi).toBe('contracts/openapi/quality.yaml');
    expect(() => validateManifest('quality', manifest, REPO_ROOT)).not.toThrow();
  });

  it("produces exactly ['quality.qc_run.rejected.v1'] (= the contracts event producer list); declares no claimsResolver / authResolvers", () => {
    expect([...manifest.produces]).toEqual(['quality.qc_run.rejected.v1']);
    expect([...(eventProducers().quality ?? [])]).toEqual(['quality.qc_run.rejected.v1']);
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual([]);
  });

  it('owns exactly one port, QualityPort (02-TRD §11.1); no other port is registered here', () => {
    expect(Object.keys(manifest.ports ?? {})).toEqual(['QualityPort']);
    expect(typeof (manifest.ports as any).QualityPort.canAutoVerify).toBe('function');
    expect(typeof (manifest.ports as any).QualityPort.qcStatusFor).toBe('function');
  });

  it('core boot validation rejects a handler set that drifts from the spec (missing and extra operationId)', () => {
    const missing = OPS[0]!;
    const { [missing]: _drop, ...rest } = manifest.handlers;
    expect(() => validateManifest('quality', { ...manifest, handlers: rest }, REPO_ROOT)).toThrow(missing);
    expect(() => validateManifest('quality', { ...manifest, handlers: { ...manifest.handlers, notInSpec: manifest.handlers[missing]! } }, REPO_ROOT))
      .toThrow('notInSpec');
  });
});

describe('C9 T-01 handler map (54 operationIds)', () => {
  it('the spec has the 54 operationIds of 02-TRD §5, unique', () => {
    expect(OPS.length).toBe(54);
    expect(new Set(OPS).size).toBe(54);
    expect([...OPS].sort()).toEqual([...EXPECTED_OPS].sort());
  });

  it('binds every operationId of quality.yaml to a function, and nothing else (AC-0D-1.2)', () => {
    expect(Object.keys(manifest.handlers).sort()).toEqual([...OPS].sort());
    for (const op of OPS) expect(typeof manifest.handlers[op], op).toBe('function');
  });

  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const stubs = OPS.filter((op) => !IMPLEMENTED.includes(op));

  it('flag on + dev: every stub answers 501 and never echoes request input (no PHI / token reflection)', async () => {
    const { m } = await withEnv('dev', 'true');
    for (const op of stubs) {
      const r = await m.handlers[op]!(plantedReq, fakeCtx(op));
      expect(r, op).toMatchObject({ status: 501 });
      expect(JSON.stringify(r), op).not.toContain(PLANTED);
    }
  });

  it('flag on + staging/production: a stub never answers 501; it rejects with common.internal (fail closed)', async () => {
    for (const env of ['staging', 'production']) {
      const { m, isLimsError } = await withEnv(env, 'true');
      for (const op of stubs) {
        const out = await outcome(m.handlers[op]!(FAKE_REQ, fakeCtx(op)));
        expect(out.ok, `${env} ${op} resolved: ${JSON.stringify(out)}`).toBe(false);
        if (!out.ok) expect(isLimsError(out.e, 'common.internal'), `${env} ${op}`).toBe(true);
      }
    }
  });
});

describe('C9 T-01 phase switch LIMS_QUALITY_ENABLED (02-TRD §12.2)', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  // unset = default false; anything that is not exactly 'true' is rejected by the config loader (see config tests), so only unset/'false' reach a handler.
  it.each([['dev', undefined], ['dev', 'false'], ['ci', undefined], ['staging', 'false'], ['production', undefined], ['production', 'false']] as const)(
    'LIMS_CORE_ENV=%s LIMS_QUALITY_ENABLED=%s: every one of the 54 operations rejects common.feature_disabled (HTTP 403), never 501/200',
    async (coreEnv, enabled) => {
      const { m, isLimsError, toProblem } = await withEnv(coreEnv, enabled);
      for (const op of OPS) {
        const out = await outcome(m.handlers[op]!(plantedReq, fakeCtx(op)));
        expect(out.ok, `${op} resolved: ${JSON.stringify(out)}`).toBe(false);
        if (!out.ok) {
          expect(isLimsError(out.e, 'common.feature_disabled'), `${op}: ${String((out.e as any)?.code)}`).toBe(true);
          expect((out.e as any).statusCode, op).toBe(403);
          const p = toProblem(out.e, '/v1/quality/x', '01a1a98a-ac40-7000-8000-000000090001');
          expect(p).toMatchObject({ status: 403, code: 'common.feature_disabled' });
          expect(JSON.stringify(p), op).not.toContain(PLANTED);
        }
      }
    }, 120_000);

  it('the switch answers before the request is looked at: an empty / malformed request still gets 403, not a validation error', async () => {
    const { m, isLimsError } = await withEnv('dev', 'false');
    for (const op of OPS) {
      const out = await outcome(m.handlers[op]!({ params: null, query: null, headers: null, body: null } as any, fakeCtx(op)));
      expect(out.ok).toBe(false);
      if (!out.ok) expect(isLimsError(out.e, 'common.feature_disabled'), op).toBe(true);
    }
  });

  it('flipping the flag to true changes the answer from feature_disabled to the stub (the flag is honoured, not hard-coded)', async () => {
    const off = await withEnv('dev', 'false');
    const on = await withEnv('dev', 'true');
    const op = OPS.find((o) => !IMPLEMENTED.includes(o))!;
    expect((await outcome(off.m.handlers[op]!(FAKE_REQ, fakeCtx(op)))).ok).toBe(false);
    expect(await on.m.handlers[op]!(FAKE_REQ, fakeCtx(op))).toMatchObject({ status: 501 });
  });
});

describe('C9 T-01 permissions', () => {
  const codes = PERMISSION_CODES.filter((c) => c.startsWith('quality.'));

  it('QUALITY_PERMISSIONS = the 8 quality.* codes of contracts/permissions.yaml (no invented code, none missing), frozen', () => {
    expect([...codes].sort()).toEqual(PERMS);
    expect([...QUALITY_PERMISSIONS].sort()).toEqual(PERMS);
    expect(new Set(QUALITY_PERMISSIONS).size).toBe(QUALITY_PERMISSIONS.length);
    expect(Object.isFrozen(QUALITY_PERMISSIONS)).toBe(true);
  });

  it('every operation: bearerJwt only (no device/portal/anonymous scheme) and exactly one registered quality permission', () => {
    const bad: string[] = [];
    let n = 0;
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        n++;
        const where = `${method.toUpperCase()} ${path} (${op.operationId})`;
        const schemes = (op.security ?? []).flatMap((s: object) => Object.keys(s));
        if (schemes.length !== 1 || schemes[0] !== 'bearerJwt') bad.push(`${where}: scheme ${JSON.stringify(schemes)}`);
        const perm: string | undefined = op['x-permission'];
        if (!perm || !(PERMISSION_CODES as readonly string[]).includes(perm) || !QUALITY_PERMISSIONS.includes(perm)) bad.push(`${where}: permission ${String(perm)}`);
      }
    }
    expect(n).toBe(54);
    expect(bad).toEqual([]);
  });

  it('privileged operations are not reachable with a read permission: every write op is qc.manage / autoverify.manage / config.manage / review / ack, never *.read', () => {
    const bad: string[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const isWrite = ['post', 'put', 'patch', 'delete'].includes(method);
        if (isWrite && /\.read$/.test(op['x-permission'])) bad.push(`${method.toUpperCase()} ${path} (${op.operationId}) uses ${op['x-permission']}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('C9 T-01 config (02-TRD §12.2, LIMS_QUALITY_*)', () => {
  const DEFAULTS = { enabled: false, syncBatch: 500, syncOverlapSeconds: 600, syncDebounceSeconds: 5, syncTimeBudgetSeconds: 25, ruleCacheMax: 200, ljMaxPoints: 2000 };
  const KEYS: Record<keyof typeof DEFAULTS, string> = {
    enabled: 'LIMS_QUALITY_ENABLED', syncBatch: 'LIMS_QUALITY_SYNC_BATCH', syncOverlapSeconds: 'LIMS_QUALITY_SYNC_OVERLAP_SECONDS',
    syncDebounceSeconds: 'LIMS_QUALITY_SYNC_DEBOUNCE_SECONDS', syncTimeBudgetSeconds: 'LIMS_QUALITY_SYNC_TIME_BUDGET_SECONDS',
    ruleCacheMax: 'LIMS_QUALITY_RULE_CACHE_MAX', ljMaxPoints: 'LIMS_QUALITY_LJ_MAX_POINTS',
  };
  const INT_KEYS = Object.entries(KEYS).filter(([f]) => f !== 'enabled').map(([, k]) => k);

  it('defaults when no env is set: the phase switch is OFF (Phase-1 honesty)', () => {
    expect(loadQualityConfig({})).toMatchObject(DEFAULTS);
  });

  it('reads overrides for every key', () => {
    const env = {
      LIMS_QUALITY_ENABLED: 'true', LIMS_QUALITY_SYNC_BATCH: '50', LIMS_QUALITY_SYNC_OVERLAP_SECONDS: '60', LIMS_QUALITY_SYNC_DEBOUNCE_SECONDS: '1',
      LIMS_QUALITY_SYNC_TIME_BUDGET_SECONDS: '10', LIMS_QUALITY_RULE_CACHE_MAX: '7', LIMS_QUALITY_LJ_MAX_POINTS: '300',
    };
    expect(loadQualityConfig(env)).toMatchObject({ enabled: true, syncBatch: 50, syncOverlapSeconds: 60, syncDebounceSeconds: 1, syncTimeBudgetSeconds: 10, ruleCacheMax: 7, ljMaxPoints: 300 });
    expect(loadQualityConfig({ LIMS_QUALITY_ENABLED: 'false' }).enabled).toBe(false);
  });

  it('is frozen (a handler cannot flip the phase switch at runtime)', () => {
    expect(Object.isFrozen(loadQualityConfig({}))).toBe(true);
  });

  it.each(INT_KEYS.flatMap((k) => ['abc', '0', '-1', '1.5', '1e3', ''].map((v) => [k, v] as const)))(
    'fails fast, naming the key: %s=%j', (key, value) => {
      expect(() => loadQualityConfig({ [key]: value })).toThrow(key);
    });

  it.each([['yes'], ['1'], ['TRUE'], ['True'], [''], [' true']])(
    'LIMS_QUALITY_ENABLED=%j is neither true nor false: fails fast naming the key (a typo never silently enables or disables the module)', (v) => {
      expect(() => loadQualityConfig({ LIMS_QUALITY_ENABLED: v })).toThrow('LIMS_QUALITY_ENABLED');
    });
});

describe('C9 T-01 boot against the real repo (default modulesDir, real quality.yaml)', () => {
  const ks = makeKeys('ES256');
  const apps: FastifyInstance[] = [];
  afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

  const boot = async () => {
    const config = loadConfig({
      LIMS_CORE_ENV: 'ci',
      LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
      LIMS_WEB_BFF_KEY_FILE: tmpFile('c9-t01-web-key-0123456789abcdef0123456789abcdef0123'),
    });
    const app = await bootstrap({ config });
    apps.push(app);
    return app;
  };
  // set_name is an enum path param (quality.yaml components.parameters.SetName) and {code} a Code: core validates these before auth, so use valid values.
  const SET_NAME = (SPEC.components.parameters.SetName.schema.enum as string[])[0]!;
  const toUrl = (path: string) => path.replace(/\{([^}]+)\}/g, (_m, name: string) =>
    name === 'set_name' ? SET_NAME : name === 'code' ? 'CODE-1' : '01a1a98a-ac40-7000-8000-000000090001');

  it('boots and mounts every quality operation at its spec path and method (54 of 54)', async () => {
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
    expect(n).toBe(54);
    expect(unmounted).toEqual([]);
  }, 300_000);

  it('fails closed: operations without required query/body answer 401 auth.* without credentials (never 200/403/501/500); non-spec path is 404', async () => {
    const app = await boot();
    const probes: { method: string; url: string }[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const requiredQuery = (op.parameters ?? []).some((p: any) => p.in === 'query' && p.required);
        if (!requiredQuery && !op.requestBody?.required) probes.push({ method: method.toUpperCase(), url: toUrl(path) });
      }
    }
    expect(probes.length).toBeGreaterThanOrEqual(10);
    for (const { method, url } of probes) {
      const r = await app.inject({ method: method as any, url });
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(401);
      expect(JSON.parse(r.body).code).toMatch(/^auth\./);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/quality/not-in-spec' })).statusCode).toBe(404);
  }, 300_000);
});
