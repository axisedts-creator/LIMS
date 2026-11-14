// C5 T-01 — module skeleton: manifest, permissions, config, handler map (06-IMPLEMENTATION-PLAN row T-01).
// done_when: "API boots with all operationIds bound against lab.yaml; stubs throw common.internal (no 501 stubs)".
// Security: REQ-SEC-099 (nothing mounted that is not in a spec), fail-closed auth on every lab operation.
// Interface expected from the writer (seams the spec does not fix are marked SEAM):
//   ../index.ts           export const manifest: ModuleManifest   (name 'lab', openapi 'contracts/openapi/lab.yaml', produces = 7 lab events)
//   ../handlers/index.ts  export const handlers: Record<operationId, Handler>   (SEAM: export name `handlers`)
//   ../permissions.ts     export const LAB_PERMISSIONS: readonly string[]       (SEAM: all `lab.*` codes of contracts/permissions.yaml)
//   ../config.ts          export function loadLabConfig(env): { autoverifyHookEnabled, catalogCacheMaxEntries, labelWaitSeconds, worklistMaxRows }
//                         (SEAM: field names; env names + defaults from 02-TRD §9.2; throws an Error naming the bad LIMS_LAB_* key)
// LD-06 / LD-17 (2026-11-07, T-01) concern infra/tests/run.sh and ansible-lint; they add no requirement to these tests.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';
import { isLimsError } from '../../../core/errors.js';
import { eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { AUD, ISS, makeKeys, tmpFile } from '../../../core/auth/__tests__/helpers.js';
import { loadLabConfig } from '../config.js';
import { handlers } from '../handlers/index.js';
import { manifest } from '../index.js';
import { LAB_PERMISSIONS } from '../permissions.js';

const SPEC = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'lab.yaml'));
const OPS = operationIds(SPEC);
const LAB_EVENTS_PRODUCED = [
  'lab.critical_value.detected.v1', 'lab.order.ready_for_report.v1', 'lab.result.amended.v1', 'lab.result.approved.v1',
  'lab.result.verified.v1', 'lab.specimen.rejected.v1', 'lab.specimen.status_changed.v1',
];
/** operationIds whose stub a later task has replaced; that task moves its ids here (tester-owned list). */
const IMPLEMENTED: readonly string[] = [
  // T-07 specimen actions
  'lookupSpecimenByBarcode', 'listSpecimens', 'getSpecimen', 'collectSpecimen', 'bulkCollectSpecimens', 'bulkDispatchSpecimens',
  'receiveSpecimen', 'bulkReceiveSpecimens', 'storeSpecimen', 'discardSpecimen',
  // T-08 reject + recollection + aliquots
  'rejectSpecimen', 'requestRecollection', 'createAliquots',
  // T-14 result entry
  'bulkEnterResults', 'getResult', 'listOrderResults',
  // T-32 / LD-124 (ruling C5.T-32-ruling.md F): handlers now real, stub assertion was stale
  'getLabOrder', 'listVerificationQueue',
  // T-15 critical values
  'listCriticalValues', 'getCriticalValue', 'logCriticalNotification',
  // T-16 verify / return
  'verifyResult', 'bulkVerifyResults', 'returnResult',
  // T-10 labels
  'printSpecimenLabels', 'requestOrderLabelPrint',
  // T-17 approve / amend
  'approveResult', 'bulkApproveResults', 'amendResult', 'listResultVersions',
  // T-19 history
  'getResultHistory', 'getAnalyteTrend',
  // T-26 worklists, pending, worksheets
  'listWorklistItems', 'listPendingItems', 'createWorksheet', 'listWorksheets', 'getWorksheet',
  // T-23 ingest exception queue
  'listIngestExceptions', 'getIngestException', 'assignIngestException', 'reapplyIngestException', 'discardIngestException',
  // T-27 status board
  'getStatusBoard',
  // T-29 configuration (#47-#54)
  'getLabSettings', 'updateLabSettings', 'listDeltaCheckRules', 'createDeltaCheckRule', 'versionDeltaCheckRule', 'deactivateDeltaCheckRule', 'listLabCodedSet', 'upsertLabCode',
  // T-25 QC capture + holds (#43-#46)
  'listQcResults', 'captureQcResult', 'listQcHolds', 'releaseQcHold',
];

const FAKE_REQ = { params: {}, query: {}, headers: {}, body: {} };
const fakeCtx = (operationId: string) =>
  ({ operationId, clientIp: '127.0.0.1', log: { info() {}, warn() {}, error() {} } }) as any;

describe('T-01 manifest', () => {
  it('is module lab bound to contracts/openapi/lab.yaml and passes the core manifest validation', () => {
    expect(manifest.name).toBe('lab');
    expect(manifest.openapi).toBe('contracts/openapi/lab.yaml');
    expect(() => validateManifest('lab', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces exactly the 7 lab events (02-TRD §7.1 = EVENT_PRODUCERS.lab)', () => {
    expect([...manifest.produces].sort()).toEqual(LAB_EVENTS_PRODUCED);
    expect([...(eventProducers().lab ?? [])].sort()).toEqual(LAB_EVENTS_PRODUCED);
  });

  it('claims no identity/other-module extension points (claimsResolver, authResolvers, foreign ports)', () => {
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual([]);
    for (const p of Object.keys(manifest.ports ?? {})) expect(p).toBe('LabPort');
  });
});

describe('T-01 handler map', () => {
  it('binds every operationId of lab.yaml, and nothing else (AC-0D-1.2)', () => {
    expect(OPS.length).toBeGreaterThanOrEqual(55);
    expect(Object.keys(handlers).sort()).toEqual([...OPS].sort());
    expect(manifest.handlers).toBe(handlers);
    for (const op of OPS) expect(typeof handlers[op]).toBe('function');
  });

  const stubs = OPS.filter((op) => !IMPLEMENTED.includes(op));
  it.each(stubs)('stub %s throws common.internal (never resolves, never a 501)', async (op) => {
    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await handlers[op]!(FAKE_REQ, fakeCtx(op)) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    expect(outcome.ok, `${op} resolved: ${JSON.stringify(outcome)}`).toBe(false);
    if (outcome.ok) return;
    expect(isLimsError(outcome.error, 'common.internal')).toBe(true);
    expect((outcome.error as { statusCode: number }).statusCode).toBe(500);
  });
});

describe('T-01 permissions', () => {
  const labCodes = PERMISSION_CODES.filter((c) => c.startsWith('lab.'));

  it('LAB_PERMISSIONS = every lab.* code of contracts/permissions.yaml (no invented code, none missing)', () => {
    expect(labCodes.length).toBeGreaterThanOrEqual(17);
    expect([...LAB_PERMISSIONS].sort()).toEqual([...labCodes].sort());
    expect(new Set(LAB_PERMISSIONS).size).toBe(LAB_PERMISSIONS.length);
  });

  it('every lab operation is authenticated (bearerJwt) and gated by a registered permission', () => {
    const missing: string[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const secured = Array.isArray(op.security) && op.security.length > 0 && op.security.every((s: object) => 'bearerJwt' in s);
        const perm: string | undefined = op['x-permission'];
        if (!secured || !perm || !(PERMISSION_CODES as readonly string[]).includes(perm) || !LAB_PERMISSIONS.includes(perm)) {
          missing.push(`${method.toUpperCase()} ${path} (${op.operationId}) permission=${String(perm)}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('T-01 config (02-TRD §9.2, LIMS_LAB_*)', () => {
  it('defaults when no env is set', () => {
    expect(loadLabConfig({})).toMatchObject({
      autoverifyHookEnabled: false, catalogCacheMaxEntries: 20000, labelWaitSeconds: 15, worklistMaxRows: 500,
    });
  });

  it('reads overrides', () => {
    expect(loadLabConfig({
      LIMS_LAB_AUTOVERIFY_HOOK_ENABLED: 'true', LIMS_LAB_CATALOG_CACHE_MAX_ENTRIES: '100',
      LIMS_LAB_LABEL_WAIT_SECONDS: '5', LIMS_LAB_WORKLIST_MAX_ROWS: '50',
    })).toMatchObject({ autoverifyHookEnabled: true, catalogCacheMaxEntries: 100, labelWaitSeconds: 5, worklistMaxRows: 50 });
  });

  it.each([
    ['LIMS_LAB_AUTOVERIFY_HOOK_ENABLED', 'yes'],
    ['LIMS_LAB_AUTOVERIFY_HOOK_ENABLED', '1'],
    ['LIMS_LAB_CATALOG_CACHE_MAX_ENTRIES', 'abc'],
    ['LIMS_LAB_CATALOG_CACHE_MAX_ENTRIES', '0'],
    ['LIMS_LAB_LABEL_WAIT_SECONDS', '-1'],
    ['LIMS_LAB_LABEL_WAIT_SECONDS', '1.5'],
    ['LIMS_LAB_WORKLIST_MAX_ROWS', ''],
    ['LIMS_LAB_WORKLIST_MAX_ROWS', '1e3'],
  ])('fails fast, naming the key: %s=%j', (key, value) => {
    expect(() => loadLabConfig({ [key]: value })).toThrow(key);
  });
});

describe('T-01 boot against the real repo (default modulesDir, real lab.yaml)', () => {
  const ks = makeKeys('ES256');
  const apps: FastifyInstance[] = [];
  afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

  const boot = async () => {
    const config = loadConfig({
      LIMS_CORE_ENV: 'ci',
      LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
      LIMS_WEB_BFF_KEY_FILE: tmpFile('t01-web-key-0123456789abcdef0123456789abcdef0123'),
    });
    const app = await bootstrap({ config });
    apps.push(app);
    return app;
  };

  it('boots and mounts every lab operation at its spec path and method', async () => {
    const app = await boot();
    const unmounted: string[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        if (!app.hasRoute({ method: method.toUpperCase() as any, url: path.replace(/\{([^}]+)\}/g, ':$1') })) {
          unmounted.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(unmounted).toEqual([]);
  });

  it('fails closed: an unauthenticated lab call is 401 (never 200/501/500) and a non-spec path is 404', async () => {
    const app = await boot();
    const r = await app.inject({ method: 'GET', url: '/v1/lab/status-board?registered_at_from=2026-01-01T00:00:00.000Z' });
    expect(r.statusCode, r.body).toBe(401);
    expect(JSON.parse(r.body).code).toMatch(/^auth\./);
    expect((await app.inject({ method: 'GET', url: '/v1/lab/not-in-spec' })).statusCode).toBe(404);
  });
});
