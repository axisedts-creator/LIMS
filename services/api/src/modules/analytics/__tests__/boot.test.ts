// C8 AN-T01 — module skeleton: manifest, permissions, config, 30 operationId stubs (06-IMPLEMENTATION-PLAN row AN-T01).
// done_when: "API boots with all operationIds mapped"; tests: boot test. No ACs. Security: nothing mounted that is not in the spec,
// fail-closed auth on every analytics operation (bearerJwt only), each op bound to one registered analytics.* permission,
// stubs answer 501 only in dev and never echo request input (no PHI / token reflection).
// Interface expected from the writer (seams the spec does not fix are marked SEAM):
//   ../index.ts        export const manifest: ModuleManifest  (02-TRD §9.4: name 'analytics', openapi 'contracts/openapi/analytics.yaml',
//                      handlers = the 30 operationIds, ports {}, produces [], systemPermissions [], no claimsResolver, no authResolvers)
//   ../permissions.ts  export const ANALYTICS_PERMISSIONS: readonly string[]   (SEAM: name; = the 5 analytics.* codes of permissions.yaml)
//   ../config.ts       export function loadAnalyticsConfig(env): AnalyticsConfig  (SEAM: function + camelCase field names below;
//                      env names + defaults 02-TRD §11). Invalid value -> throws Error whose message names the LIMS_ANALYTICS_* key.
//   Stubs (SEAM, plan: "501 only in dev via core stub"): LIMS_CORE_ENV=dev -> resolves { status: 501 }; production-like
//   (LIMS_CORE_ENV staging/production) -> never resolves 501: rejects with LimsError common.internal. Env is set before import.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';
import { eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { AUD, ISS, makeKeys, tmpFile } from '../../../core/auth/__tests__/helpers.js';
import { loadAnalyticsConfig } from '../config.js';
import { manifest } from '../index.js';
import { ANALYTICS_PERMISSIONS } from '../permissions.js';

const SPEC = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'analytics.yaml'));
const OPS = operationIds(SPEC);
const PERMS = ['analytics.collections.read', 'analytics.dashboard.read', 'analytics.data.export',
  'analytics.referral_report.read', 'analytics.schedule.manage'];
const EXPECTED_OPS = [
  'getAnalyticsDashboard', 'getIncomeReport', 'getDepartmentIncomeReport', 'getCollectionsReport', 'getVolumeReport',
  'getTopReferrersReport', 'getTopCentresReport', 'getReferralIncentiveReport', 'getTestsDoneReport', 'getTatReport',
  'getPendingTestsSummary', 'listPendingTests', 'getQualityIndicatorsReport', 'getDeliveryReport', 'getInterfacesReport',
  'getAnalyticsFilterOptions', 'searchAnalyticsReferrers', 'getAnalyticsFreshness', 'requestAnalyticsRefresh',
  'createAnalyticsExport', 'listAnalyticsExports', 'getAnalyticsExport', 'downloadAnalyticsExport', 'listReportSchedules',
  'createReportSchedule', 'getReportSchedule', 'updateReportSchedule', 'deactivateReportSchedule', 'getReportRun',
  'getCollectionsFilterOptions',
];
/** operationIds whose stub a later task has replaced; that task moves its ids here (tester-owned list). */
const IMPLEMENTED: readonly string[] = [
  'getIncomeReport', 'getDepartmentIncomeReport', // AN-T08
  'getVolumeReport', 'getTopCentresReport', 'getTopReferrersReport', 'getCollectionsReport', 'searchAnalyticsReferrers', 'getAnalyticsFilterOptions', 'getCollectionsFilterOptions', // AN-T09
  'getReferralIncentiveReport', // AN-T10
  'getTestsDoneReport', 'getQualityIndicatorsReport', 'getDeliveryReport', 'getInterfacesReport', // AN-T11
  'getTatReport', // AN-T12
  'getPendingTestsSummary', 'listPendingTests', // AN-T13
  'getAnalyticsDashboard', 'getAnalyticsFreshness', 'requestAnalyticsRefresh', // AN-T14
  'createAnalyticsExport', 'listAnalyticsExports', 'getAnalyticsExport', 'downloadAnalyticsExport', // AN-T15
  'listReportSchedules', 'createReportSchedule', 'getReportSchedule', 'updateReportSchedule', 'deactivateReportSchedule', 'getReportRun', // AN-T16
];

const FAKE_REQ = { params: {}, query: {}, headers: {}, body: {} };
const noop = () => undefined;
const fakeCtx = (operationId: string) => ({ operationId, clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } }) as any;

describe('AN-T01 manifest', () => {
  it('is module analytics bound to contracts/openapi/analytics.yaml and passes the core manifest validation', () => {
    expect(manifest.name).toBe('analytics');
    expect(manifest.openapi).toBe('contracts/openapi/analytics.yaml');
    expect(() => validateManifest('analytics', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces no event (C8 is consumer-only), owns no port, declares no systemPermissions / claimsResolver / authResolvers', () => {
    expect([...manifest.produces]).toEqual([]);
    expect([...(eventProducers().analytics ?? [])]).toEqual([]);
    expect(Object.keys(manifest.ports ?? {})).toEqual([]);
    expect([...(manifest.systemPermissions ?? [])]).toEqual([]);
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual([]);
  });

  it('core boot validation rejects a handler set that drifts from the spec (missing and extra operationId)', () => {
    const missing = OPS[0]!;
    const { [missing]: _drop, ...rest } = manifest.handlers;
    expect(() => validateManifest('analytics', { ...manifest, handlers: rest }, REPO_ROOT)).toThrow(missing);
    expect(() => validateManifest('analytics', { ...manifest, handlers: { ...manifest.handlers, notInSpec: manifest.handlers[missing]! } }, REPO_ROOT))
      .toThrow('notInSpec');
  });
});

describe('AN-T01 handler map (30 operationIds)', () => {
  it('the spec has the 30 operationIds of 06-PLAN, unique', () => {
    expect(OPS.length).toBe(30);
    expect(new Set(OPS).size).toBe(30);
    expect([...OPS].sort()).toEqual([...EXPECTED_OPS].sort());
  });

  it('binds every operationId of analytics.yaml to a function, and nothing else (AC-0D-1.2)', () => {
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

describe('AN-T01 permissions', () => {
  const codes = PERMISSION_CODES.filter((c) => c.startsWith('analytics.'));

  it('ANALYTICS_PERMISSIONS = the 5 analytics.* codes of contracts/permissions.yaml (no invented code, none missing), frozen', () => {
    expect([...codes].sort()).toEqual(PERMS);
    expect([...ANALYTICS_PERMISSIONS].sort()).toEqual(PERMS);
    expect(new Set(ANALYTICS_PERMISSIONS).size).toBe(ANALYTICS_PERMISSIONS.length);
    expect(Object.isFrozen(ANALYTICS_PERMISSIONS)).toBe(true);
  });

  it('every operation: bearerJwt only (no device/portal/anonymous scheme) and exactly one registered analytics permission', () => {
    const bad: string[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const where = `${method.toUpperCase()} ${path} (${op.operationId})`;
        const schemes = (op.security ?? []).flatMap((s: object) => Object.keys(s));
        if (schemes.length !== 1 || schemes[0] !== 'bearerJwt') bad.push(`${where}: scheme ${JSON.stringify(schemes)}`);
        const perm: string | undefined = op['x-permission'];
        if (!perm || !(PERMISSION_CODES as readonly string[]).includes(perm) || !ANALYTICS_PERMISSIONS.includes(perm)) bad.push(`${where}: permission ${String(perm)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('privileged reports are not reachable with the broad dashboard permission (referral, collections, export, schedules)', () => {
    const permOf = (id: string) => {
      for (const item of Object.values<any>(SPEC.paths)) for (const op of Object.values<any>(item)) if (op?.operationId === id) return op['x-permission'];
    };
    expect(permOf('getReferralIncentiveReport')).toBe('analytics.referral_report.read');
    expect(permOf('getCollectionsReport')).toBe('analytics.collections.read');
    expect(permOf('getCollectionsFilterOptions')).toBe('analytics.collections.read');
    for (const op of ['createAnalyticsExport', 'listAnalyticsExports', 'getAnalyticsExport', 'downloadAnalyticsExport']) expect(permOf(op), op).toBe('analytics.data.export');
    for (const op of ['listReportSchedules', 'createReportSchedule', 'getReportSchedule', 'updateReportSchedule', 'deactivateReportSchedule']) expect(permOf(op), op).toBe('analytics.schedule.manage');
  });
});

describe('AN-T01 config (02-TRD §11, LIMS_ANALYTICS_*)', () => {
  const DEFAULTS = {
    maxRangeDays: 366, debounceSeconds: 60, sweepChunkDays: 7, nightlyDays: 40, staleDirtyMinutes: 20, staleSuccessMinutes: 30,
    backlogLookbackDays: 30, yesterdayUntilLocal: '06:00', manualRefreshMinutes: 5, exportsPerUserHour: 10, exportsPerTenantDay: 50,
    exportMaxRows: 100000, exportMaxBytes: 20971520, exportTtlHours: 24, exportDownloads: 3, pdfEnabled: false,
    maxSchedulesPerTenant: 20, tatRetentionFy: 3,
  };
  const KEYS: Record<keyof typeof DEFAULTS, string> = {
    maxRangeDays: 'LIMS_ANALYTICS_MAX_RANGE_DAYS', debounceSeconds: 'LIMS_ANALYTICS_DEBOUNCE_SECONDS',
    sweepChunkDays: 'LIMS_ANALYTICS_SWEEP_CHUNK_DAYS', nightlyDays: 'LIMS_ANALYTICS_NIGHTLY_DAYS',
    staleDirtyMinutes: 'LIMS_ANALYTICS_STALE_DIRTY_MINUTES', staleSuccessMinutes: 'LIMS_ANALYTICS_STALE_SUCCESS_MINUTES',
    backlogLookbackDays: 'LIMS_ANALYTICS_BACKLOG_LOOKBACK_DAYS', yesterdayUntilLocal: 'LIMS_ANALYTICS_YESTERDAY_UNTIL_LOCAL',
    manualRefreshMinutes: 'LIMS_ANALYTICS_MANUAL_REFRESH_MINUTES', exportsPerUserHour: 'LIMS_ANALYTICS_EXPORTS_PER_USER_HOUR',
    exportsPerTenantDay: 'LIMS_ANALYTICS_EXPORTS_PER_TENANT_DAY', exportMaxRows: 'LIMS_ANALYTICS_EXPORT_MAX_ROWS',
    exportMaxBytes: 'LIMS_ANALYTICS_EXPORT_MAX_BYTES', exportTtlHours: 'LIMS_ANALYTICS_EXPORT_TTL_HOURS',
    exportDownloads: 'LIMS_ANALYTICS_EXPORT_DOWNLOADS', pdfEnabled: 'LIMS_ANALYTICS_PDF_ENABLED',
    maxSchedulesPerTenant: 'LIMS_ANALYTICS_MAX_SCHEDULES_PER_TENANT', tatRetentionFy: 'LIMS_ANALYTICS_TAT_RETENTION_FY',
  };
  const INT_KEYS = Object.entries(KEYS).filter(([f]) => typeof (DEFAULTS as any)[f] === 'number').map(([, k]) => k);

  it('defaults when no env is set (TRD §11 [CONV] values; PDF off until C6 ships RenderPort)', () => {
    expect(loadAnalyticsConfig({})).toMatchObject(DEFAULTS);
  });

  it('reads overrides for every key', () => {
    const env = {
      LIMS_ANALYTICS_MAX_RANGE_DAYS: '90', LIMS_ANALYTICS_DEBOUNCE_SECONDS: '5', LIMS_ANALYTICS_SWEEP_CHUNK_DAYS: '1',
      LIMS_ANALYTICS_NIGHTLY_DAYS: '10', LIMS_ANALYTICS_STALE_DIRTY_MINUTES: '2', LIMS_ANALYTICS_STALE_SUCCESS_MINUTES: '3',
      LIMS_ANALYTICS_BACKLOG_LOOKBACK_DAYS: '7', LIMS_ANALYTICS_YESTERDAY_UNTIL_LOCAL: '04:30', LIMS_ANALYTICS_MANUAL_REFRESH_MINUTES: '1',
      LIMS_ANALYTICS_EXPORTS_PER_USER_HOUR: '2', LIMS_ANALYTICS_EXPORTS_PER_TENANT_DAY: '4', LIMS_ANALYTICS_EXPORT_MAX_ROWS: '500',
      LIMS_ANALYTICS_EXPORT_MAX_BYTES: '1024', LIMS_ANALYTICS_EXPORT_TTL_HOURS: '1', LIMS_ANALYTICS_EXPORT_DOWNLOADS: '1',
      LIMS_ANALYTICS_PDF_ENABLED: 'true', LIMS_ANALYTICS_MAX_SCHEDULES_PER_TENANT: '3', LIMS_ANALYTICS_TAT_RETENTION_FY: '2',
    };
    expect(loadAnalyticsConfig(env)).toMatchObject({
      maxRangeDays: 90, debounceSeconds: 5, sweepChunkDays: 1, nightlyDays: 10, staleDirtyMinutes: 2, staleSuccessMinutes: 3,
      backlogLookbackDays: 7, yesterdayUntilLocal: '04:30', manualRefreshMinutes: 1, exportsPerUserHour: 2, exportsPerTenantDay: 4,
      exportMaxRows: 500, exportMaxBytes: 1024, exportTtlHours: 1, exportDownloads: 1, pdfEnabled: true, maxSchedulesPerTenant: 3, tatRetentionFy: 2,
    });
  });

  it.each(INT_KEYS.flatMap((k) => ['abc', '0', '-1', '1.5', '1e3', ''].map((v) => [k, v] as const)))(
    'fails fast, naming the key: %s=%j', (key, value) => {
      expect(() => loadAnalyticsConfig({ [key]: value })).toThrow(key);
    });

  it.each([['LIMS_ANALYTICS_PDF_ENABLED', 'yes'], ['LIMS_ANALYTICS_PDF_ENABLED', '1'], ['LIMS_ANALYTICS_PDF_ENABLED', ''],
    ['LIMS_ANALYTICS_YESTERDAY_UNTIL_LOCAL', '6'], ['LIMS_ANALYTICS_YESTERDAY_UNTIL_LOCAL', '25:00'],
    ['LIMS_ANALYTICS_YESTERDAY_UNTIL_LOCAL', '06:60'], ['LIMS_ANALYTICS_YESTERDAY_UNTIL_LOCAL', ''],
  ])('fails fast on a non-boolean / non-HH:MM value, naming the key: %s=%j', (key, value) => {
    expect(() => loadAnalyticsConfig({ [key]: value })).toThrow(key);
  });

});

describe('AN-T01 boot against the real repo (default modulesDir, real analytics.yaml)', () => {
  const ks = makeKeys('ES256');
  const apps: FastifyInstance[] = [];
  afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

  const boot = async () => {
    const config = loadConfig({
      LIMS_CORE_ENV: 'ci',
      LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
      LIMS_WEB_BFF_KEY_FILE: tmpFile('an-t01-web-key-0123456789abcdef0123456789abcdef0123'),
    });
    const app = await bootstrap({ config });
    apps.push(app);
    return app;
  };
  const toUrl = (path: string) => path.replace(/\{[^}]+\}/g, '01a1a98a-ac40-7000-8000-000000090001');

  it('boots and mounts every analytics operation at its spec path and method (30 of 30)', async () => {
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
    expect(n).toBe(30);
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
    expect((await app.inject({ method: 'GET', url: '/v1/analytics/not-in-spec' })).statusCode).toBe(404);
  }, 60_000);
});
