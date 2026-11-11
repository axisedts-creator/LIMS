// C7 API-T01 — module skeleton: manifest, permissions, config, handler map (06-IMPLEMENTATION-PLAN row API-T01).
// done_when: "core boot validates handler set"; tests: boot test. No ACs. Security: REQ-SEC-099 (nothing mounted that is
// not in a spec), fail-closed auth on every instruments operation, REQ-SEC-072 (device actors hold only instruments.ingest.*),
// AC-21.3 (sketch drivers never in production — 02-TRD §11).
// Interface expected from the writer (seams the spec does not fix are marked SEAM):
//   ../index.ts           export const manifest: ModuleManifest  (name 'instruments', openapi 'contracts/openapi/instruments.yaml',
//                         produces = the 4 instruments.* events, no ports, no claimsResolver, authResolvers only `deviceToken` (API-T03 adds it))
//   ../handlers/index.ts  export const handlers: Record<operationId, Handler>   (SEAM: export name `handlers`, like lab)
//   ../permissions.ts     export const INSTRUMENTS_PERMISSIONS: readonly string[]  (SEAM: all `instruments.*` codes of contracts/permissions.yaml)
//   ../config.ts          export function loadInstrumentsConfig(env): InstrumentsConfig   (SEAM: field names below; env names + defaults 02-TRD §11)
//                         { maxMessageBytes, maxBatchBodyBytes, batchTimeBudgetMs, enrolmentCodeTtlHours, credentialTouchSeconds,
//                           offlineAfterIntervals, hostQueryMaxBarcodes, attachmentBucket, allowSketchDrivers,
//                           configSigningKeyFile, configSigningKeyId, releasesDir }
//   "production-like" = NODE_ENV=production OR LIMS_CORE_ENV in {staging, production} (SEAM; TRD says "required in staging/prod").
//   Invalid value -> throws Error whose message names the LIMS_INSTRUMENTS_* key. Stubs throw LimsError common.internal (no 501), as in lab T-01.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';
import { isLimsError } from '../../../core/errors.js';
import { eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { AUD, ISS, makeKeys, tmpFile } from '../../../core/auth/__tests__/helpers.js';
import { loadInstrumentsConfig } from '../config.js';
import { handlers } from '../handlers/index.js';
import { manifest } from '../index.js';
import { INSTRUMENTS_PERMISSIONS } from '../permissions.js';

const SPEC = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'instruments.yaml'));
const OPS = operationIds(SPEC);
const EVENTS_PRODUCED = [
  'instruments.agent.health_changed.v1', 'instruments.calibration.received.v1',
  'instruments.qc.received.v1', 'instruments.result.received.v1',
];
const INGEST = ['instruments.ingest.config_read', 'instruments.ingest.enrol', 'instruments.ingest.heartbeat',
  'instruments.ingest.host_query', 'instruments.ingest.submit'];
/** operationIds whose stub a later task has replaced; that task moves its ids here (tester-owned list). */
const IMPLEMENTED: readonly string[] = [
  'listAgents', 'createAgent', 'getAgent', 'updateAgent', 'issueEnrolmentCode', 'revokeAgent',
  'retireAgent', 'requestAgentCommand', 'listAgentCommands', 'listAgentHealthTransitions',
  'getAgentLogBundle', 'listAgentReleases',
  'enrolAgent', 'getAgentConfig', 'submitAgentHeartbeat', 'submitAgentLogBundle', 'downloadAgentRelease', // API-T06
  'submitMessageBatch', // API-T09
  'submitAttachment', 'downloadInstrumentAttachment', // API-T11
  'listInstrumentMessages', 'searchInstrumentMessages', 'getInstrumentMessage', 'getInstrumentMessageRaw', 'listMessageRejections', // API-T12
  'reprocessInstrumentMessage', 'rematchInstrumentRecord', // API-T13
  // INT-T03 (wiring of API-T05 E22-E32/E40/E41, API-T10 E05)
  'submitHostQuery', 'listDrivers', 'listInstruments', 'createInstrument', 'getInstrument', 'updateInstrument',
  'startInstrumentCommissioning', 'goLiveInstrument', 'suspendInstrument', 'resumeInstrument', 'retireInstrument',
  'listObservedInstrumentCodes', 'getInstrumentSettings', 'updateInstrumentSettings',
];

const FAKE_REQ = { params: {}, query: {}, headers: {}, body: {} };
const fakeCtx = (operationId: string) =>
  ({ operationId, clientIp: '127.0.0.1', log: { info() {}, warn() {}, error() {} } }) as any;

describe('API-T01 manifest', () => {
  it('is module instruments bound to contracts/openapi/instruments.yaml and passes the core manifest validation', () => {
    expect(manifest.name).toBe('instruments');
    expect(manifest.openapi).toBe('contracts/openapi/instruments.yaml');
    expect(() => validateManifest('instruments', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces exactly the 4 instruments events (EVENT_PRODUCERS.instruments)', () => {
    expect([...manifest.produces].sort()).toEqual(EVENTS_PRODUCED);
    expect([...(eventProducers().instruments ?? [])].sort()).toEqual(EVENTS_PRODUCED);
  });

  it('claims no foreign extension points: no claimsResolver, no port (PORT_OWNERS has none), authResolvers only deviceToken', () => {
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.ports ?? {})).toEqual([]);
    for (const k of Object.keys(manifest.authResolvers ?? {})) expect(k).toBe('deviceToken');
  });

  it('core boot validation rejects a handler set that drifts from the spec (missing and extra operationId)', () => {
    const missing = OPS[0]!;
    const { [missing]: _drop, ...rest } = handlers;
    expect(() => validateManifest('instruments', { ...manifest, handlers: rest }, REPO_ROOT)).toThrow(missing);
    expect(() => validateManifest('instruments', { ...manifest, handlers: { ...handlers, notInSpec: handlers[missing]! } }, REPO_ROOT))
      .toThrow('notInSpec');
  });
});

describe('API-T01 handler map', () => {
  it('binds every operationId of instruments.yaml, and nothing else (AC-0D-1.2)', () => {
    expect(OPS.length).toBe(41);
    expect(new Set(OPS).size).toBe(OPS.length);
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

describe('API-T01 permissions', () => {
  const codes = PERMISSION_CODES.filter((c) => c.startsWith('instruments.'));

  it('INSTRUMENTS_PERMISSIONS = every instruments.* code of contracts/permissions.yaml (no invented code, none missing)', () => {
    expect(codes.length).toBe(11);
    expect([...INSTRUMENTS_PERMISSIONS].sort()).toEqual([...codes].sort());
    expect(new Set(INSTRUMENTS_PERMISSIONS).size).toBe(INSTRUMENTS_PERMISSIONS.length);
  });

  it('every operation has exactly one scheme and a registered permission; device ops <-> instruments.ingest.* (REQ-SEC-072)', () => {
    const bad: string[] = [];
    let device = 0;
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const where = `${method.toUpperCase()} ${path} (${op.operationId})`;
        const perm: string | undefined = op['x-permission'];
        const schemes = (op.security ?? []).flatMap((s: object) => Object.keys(s));
        const isDevice = schemes.length === 1 && schemes[0] === 'deviceToken';
        const isUser = schemes.length === 1 && schemes[0] === 'bearerJwt';
        if (!isDevice && !isUser) bad.push(`${where}: scheme ${JSON.stringify(schemes)}`);
        if (!perm || !(PERMISSION_CODES as readonly string[]).includes(perm) || !INSTRUMENTS_PERMISSIONS.includes(perm)) bad.push(`${where}: permission ${String(perm)}`);
        if (isDevice !== INGEST.includes(perm ?? '')) bad.push(`${where}: ${schemes[0]} with ${String(perm)}`);
        if (isDevice) device++;
      }
    }
    expect(bad).toEqual([]);
    expect(device).toBe(8);
  });
});

describe('API-T01 config (02-TRD §11, LIMS_INSTRUMENTS_*)', () => {
  const PROD_KEYS = {
    LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE: '/run/secrets/c7-config-signing.pem',
    LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID: 'cfg-2026-01',
    LIMS_INSTRUMENTS_RELEASES_DIR: '/srv/agent-releases',
  };

  it('defaults when no env is set (dev-like): sketch drivers allowed, secret-store keys optional', () => {
    expect(loadInstrumentsConfig({})).toMatchObject({
      maxMessageBytes: 1048576, maxBatchBodyBytes: 4194304, batchTimeBudgetMs: 8000, enrolmentCodeTtlHours: 24,
      credentialTouchSeconds: 300, offlineAfterIntervals: 3, hostQueryMaxBarcodes: 50,
      attachmentBucket: 'instruments-attachments', allowSketchDrivers: true,
    });
  });

  it('reads overrides', () => {
    expect(loadInstrumentsConfig({
      LIMS_INSTRUMENTS_MAX_MESSAGE_BYTES: '2048', LIMS_INSTRUMENTS_MAX_BATCH_BODY_BYTES: '8192',
      LIMS_INSTRUMENTS_BATCH_TIME_BUDGET_MS: '500', LIMS_INSTRUMENTS_ENROLMENT_CODE_TTL_HOURS: '72',
      LIMS_INSTRUMENTS_CREDENTIAL_TOUCH_SECONDS: '60', LIMS_INSTRUMENTS_OFFLINE_AFTER_INTERVALS: '5',
      LIMS_INSTRUMENTS_HOST_QUERY_MAX_BARCODES: '10', LIMS_INSTRUMENTS_ATTACHMENT_BUCKET: 'b2',
      LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS: 'false', ...PROD_KEYS,
    })).toMatchObject({
      maxMessageBytes: 2048, maxBatchBodyBytes: 8192, batchTimeBudgetMs: 500, enrolmentCodeTtlHours: 72,
      credentialTouchSeconds: 60, offlineAfterIntervals: 5, hostQueryMaxBarcodes: 10, attachmentBucket: 'b2',
      allowSketchDrivers: false, configSigningKeyFile: PROD_KEYS.LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE,
      configSigningKeyId: 'cfg-2026-01', releasesDir: '/srv/agent-releases',
    });
  });

  it('enrolment-code TTL accepts the 1..72 h range edges', () => {
    expect(loadInstrumentsConfig({ LIMS_INSTRUMENTS_ENROLMENT_CODE_TTL_HOURS: '1' }).enrolmentCodeTtlHours).toBe(1);
    expect(loadInstrumentsConfig({ LIMS_INSTRUMENTS_ENROLMENT_CODE_TTL_HOURS: '72' }).enrolmentCodeTtlHours).toBe(72);
  });

  it.each([
    ['LIMS_INSTRUMENTS_ENROLMENT_CODE_TTL_HOURS', '0'],
    ['LIMS_INSTRUMENTS_ENROLMENT_CODE_TTL_HOURS', '73'],
    ['LIMS_INSTRUMENTS_ENROLMENT_CODE_TTL_HOURS', '1.5'],
    ['LIMS_INSTRUMENTS_MAX_MESSAGE_BYTES', 'abc'],
    ['LIMS_INSTRUMENTS_MAX_MESSAGE_BYTES', '0'],
    ['LIMS_INSTRUMENTS_MAX_BATCH_BODY_BYTES', '-1'],
    ['LIMS_INSTRUMENTS_BATCH_TIME_BUDGET_MS', ''],
    ['LIMS_INSTRUMENTS_CREDENTIAL_TOUCH_SECONDS', '1e3'],
    ['LIMS_INSTRUMENTS_OFFLINE_AFTER_INTERVALS', '0'],
    ['LIMS_INSTRUMENTS_HOST_QUERY_MAX_BARCODES', 'NaN'],
    ['LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS', 'yes'],
    ['LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS', '1'],
  ])('fails fast, naming the key: %s=%j', (key, value) => {
    expect(() => loadInstrumentsConfig({ [key]: value })).toThrow(key);
  });

  it('AC-21.3: production forces sketch drivers off by default and refuses an explicit true', () => {
    expect(loadInstrumentsConfig({ NODE_ENV: 'production', ...PROD_KEYS }).allowSketchDrivers).toBe(false);
    expect(() => loadInstrumentsConfig({ NODE_ENV: 'production', LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS: 'true', ...PROD_KEYS }))
      .toThrow('LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS');
    expect(loadInstrumentsConfig({ NODE_ENV: 'development', LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS: 'true' }).allowSketchDrivers).toBe(true);
  });

  it.each(Object.keys(PROD_KEYS))('staging/production refuse to boot without %s (REQ-SEC-128)', (key) => {
    for (const LIMS_CORE_ENV of ['staging', 'production']) {
      const env = { LIMS_CORE_ENV, ...PROD_KEYS, [key]: undefined };
      expect(() => loadInstrumentsConfig(env)).toThrow(key);
      expect(() => loadInstrumentsConfig({ ...env, [key]: '' })).toThrow(key);
    }
  });
});

describe('API-T01 boot against the real repo (default modulesDir, real instruments.yaml)', () => {
  const ks = makeKeys('ES256');
  const apps: FastifyInstance[] = [];
  afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

  const boot = async () => {
    const config = loadConfig({
      LIMS_CORE_ENV: 'ci',
      LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
      LIMS_WEB_BFF_KEY_FILE: tmpFile('api-t01-web-key-0123456789abcdef0123456789abcdef0123'),
    });
    const app = await bootstrap({ config });
    apps.push(app);
    return app;
  };

  it('boots and mounts every instruments operation at its spec path and method', async () => {
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
  }, 120_000); // LD-86: harness timeout only (cold bootstrap on shared machine)

  it('fails closed: user and device routes without credentials are 401 (never 200/501/500); a non-spec path is 404', async () => {
    const app = await boot();
    for (const url of ['/v1/instruments/agents', '/v1/instruments/agent/config']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, `${url}: ${r.body}`).toBe(401);
      expect(JSON.parse(r.body).code).toMatch(/^auth\./);
    }
    const enrol = await app.inject({ method: 'POST', url: '/v1/instruments/agent/enrolments', payload: { host_fingerprint_sha256: '3f2a'.repeat(16), agent_version: '1.2.0', launcher_version: '1.0.1', os_version: 'Windows 10.0.19045' } });
    expect(enrol.statusCode, enrol.body).toBe(401);
    expect(JSON.parse(enrol.body).code).toMatch(/^auth\./);
    expect((await app.inject({ method: 'GET', url: '/v1/instruments/not-in-spec' })).statusCode).toBe(404);
  }, 120_000); // LD-86
});
