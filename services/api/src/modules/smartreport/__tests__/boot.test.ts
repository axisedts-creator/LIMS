// C14 T01 — module skeleton: manifest, permissions, config, 35 operationId stubs, boot (06-PLAN row T01; 02-TRD §3.1, §5, §10; 08 A17 P-20).
// done_when: "API boots with C14 module; every operationId has a 501 stub handler behind a test flag". No ACs. Tests: boot test.
// SEAMS (spec does not fix them; same shape as analytics/payments modules):
//   ../index.ts        export const manifest: ModuleManifest — name 'smartreport', openapi 'contracts/openapi/smartreport.yaml', 35 handlers,
//                      ports { SmartReportPort }, produces [], systemPermissions ['lab.result.read','frontdesk.order.read'] (TRD §3.1), no resolvers.
//   ../permissions.ts  export const SMARTREPORT_PERMISSIONS (frozen): the 4 smartreport.* codes of contracts/permissions.yaml.
//   ../config.ts       export function loadSmartreportConfig(env): camelCase fields below; env names/defaults/ranges TRD §10. Invalid -> Error naming the key.
//   Stub (SEAM, same as C8): LIMS_CORE_ENV=dev -> resolves { status: 501 }, echoes no input; staging/production -> rejects LimsError common.internal.
// Fails now: ../index.js, ../permissions.js, ../config.js do not exist.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';
import { eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { AUD, ISS, makeKeys, tmpFile } from '../../../core/auth/__tests__/helpers.js';
import { loadSmartreportConfig } from '../config.js';
import { manifest } from '../index.js';
import { SMARTREPORT_PERMISSIONS } from '../permissions.js';

const SPEC = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'smartreport.yaml'));
const OPS = operationIds(SPEC);
const PERMS = ['smartreport.summary.approve', 'smartreport.summary.read', 'smartreport.template.approve', 'smartreport.template.manage'];
/** operationIds whose stub a later task has replaced; that task moves its ids here (tester-owned list). Empty at T01. */
const IMPLEMENTED: readonly string[] = ['listSmartDenyTerms', 'createSmartDenyTerm', 'deactivateSmartDenyTerm', 'getSmartCodedSet', 'getSmartLibraryCodedSet', // C14-T03
  'listSmartLibraryVersions', 'createSmartLibraryVersion', 'getSmartLibraryVersion', 'updateSmartLibraryVersion', 'listSmartTemplateBlocks', 'createSmartTemplateBlock',
  'replaceSmartTemplateBlock', 'deleteSmartTemplateBlock', 'listSmartRules', 'createSmartRule', 'replaceSmartRule', 'deleteSmartRule', 'listSmartAnalyteGroups',
  'putSmartAnalyteGroup', 'deleteSmartAnalyteGroup', 'listSmartGroupSettings', 'putSmartGroupSetting', 'validateSmartLibraryVersion', 'submitSmartLibraryVersion',
  'approveSmartLibraryVersion', 'returnSmartLibraryVersion', // C14-T11 (#1-#21)
  'listSmartSummaries', 'getSmartSummary', 'getCurrentSmartSummary', 'buildSmartSummary', 'approveSmartSummary', 'rejectSmartSummary', // C14-T15 (#27-#32)
  'requestSmartLlmRephrase', 'listSmartLlmRuns']; // C14-T28

const FAKE_REQ = { params: {}, query: {}, headers: {}, body: {} };
const noop = () => undefined;
const fakeCtx = (operationId: string) => ({ operationId, clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } }) as any;

describe('C14-T01 manifest', () => {
  it('is module smartreport bound to contracts/openapi/smartreport.yaml and passes the core manifest validation', () => {
    expect(manifest.name).toBe('smartreport');
    expect(manifest.openapi).toBe('contracts/openapi/smartreport.yaml');
    expect(() => validateManifest('smartreport', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces no event, owns exactly SmartReportPort, systemPermissions = lab.result.read + frontdesk.order.read, no resolvers', () => {
    expect([...manifest.produces]).toEqual([]);
    expect([...(eventProducers().smartreport ?? [])]).toEqual([]);
    expect(Object.keys(manifest.ports ?? {})).toEqual(['SmartReportPort']);
    expect(typeof (manifest.ports as any).SmartReportPort.buildSummary).toBe('function');
    expect([...(manifest.systemPermissions ?? [])].sort()).toEqual(['frontdesk.order.read', 'lab.result.read']);
    for (const c of manifest.systemPermissions ?? []) expect(PERMISSION_CODES as readonly string[], c).toContain(c);
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual([]);
  });

  it('core boot validation rejects a handler set that drifts from the spec (missing and extra operationId)', () => {
    const missing = OPS[0]!;
    const { [missing]: _drop, ...rest } = manifest.handlers;
    expect(() => validateManifest('smartreport', { ...manifest, handlers: rest }, REPO_ROOT)).toThrow(missing);
    expect(() => validateManifest('smartreport', { ...manifest, handlers: { ...manifest.handlers, notInSpec: manifest.handlers[missing]! } }, REPO_ROOT)).toThrow('notInSpec');
  });
});

describe('C14-T01 handler map (35 operationIds, TRD §5)', () => {
  it('the spec has 35 unique operationIds', () => {
    expect(OPS.length).toBe(35);
    expect(new Set(OPS).size).toBe(35);
  });

  it('binds every operationId of smartreport.yaml to a function, and nothing else', () => {
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

describe('C14-T01 permissions (07-SECURITY: one registered permission per operation, bearerJwt only)', () => {
  const codes = PERMISSION_CODES.filter((c) => c.startsWith('smartreport.'));

  it('SMARTREPORT_PERMISSIONS = the smartreport.* codes of contracts/permissions.yaml (none invented, none missing), no dupes, frozen', () => {
    expect([...codes].sort()).toEqual(PERMS);
    expect([...SMARTREPORT_PERMISSIONS].sort()).toEqual(PERMS);
    expect(new Set(SMARTREPORT_PERMISSIONS).size).toBe(SMARTREPORT_PERMISSIONS.length);
    expect(Object.isFrozen(SMARTREPORT_PERMISSIONS)).toBe(true);
  });

  it('every operation: bearerJwt only (no device/portal/anonymous scheme) and exactly one registered smartreport permission', () => {
    const bad: string[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const where = `${method.toUpperCase()} ${path} (${op.operationId})`;
        const schemes = (op.security ?? []).flatMap((s: object) => Object.keys(s));
        if (schemes.length !== 1 || schemes[0] !== 'bearerJwt') bad.push(`${where}: scheme ${JSON.stringify(schemes)}`);
        const perm: string | undefined = op['x-permission'];
        if (!perm || !(PERMISSION_CODES as readonly string[]).includes(perm) || !SMARTREPORT_PERMISSIONS.includes(perm)) bad.push(`${where}: permission ${String(perm)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('privileged actions are not reachable with the read permission (build/approve/reject/rephrase need summary.approve; library approve/return need template.approve)', () => {
    const permOf = (id: string) => {
      for (const item of Object.values<any>(SPEC.paths)) for (const op of Object.values<any>(item)) if (op?.operationId === id) return op['x-permission'];
    };
    for (const op of ['buildSmartSummary', 'approveSmartSummary', 'rejectSmartSummary', 'requestSmartLlmRephrase', 'listSmartLlmRuns']) expect(permOf(op), op).toBe('smartreport.summary.approve');
    for (const op of ['approveSmartLibraryVersion', 'returnSmartLibraryVersion']) expect(permOf(op), op).toBe('smartreport.template.approve');
    for (const op of ['getSmartSummary', 'listSmartSummaries', 'getCurrentSmartSummary', 'getSmartCodedSet']) expect(permOf(op), op).toBe('smartreport.summary.read');
  });
});

describe('C14-T01 config (02-TRD §10, LIMS_SMARTREPORT_*)', () => {
  it('defaults when no env is set (prebuild on, 120 s, LLM adapter disabled, 20 s timeout, concurrency 1, no endpoint/model/hosts)', () => {
    expect(loadSmartreportConfig({})).toMatchObject({
      prebuildEnabled: true, prebuildDelaySeconds: 120, llmAdapter: 'disabled', llmTimeoutMs: 20000, llmMaxConcurrency: 1, llmAllowedHosts: [],
    });
    const c: any = loadSmartreportConfig({});
    expect(c.llmEndpoint).toBeUndefined();
    expect(c.llmModelRef).toBeUndefined();
  });

  it('reads overrides for every key', () => {
    expect(loadSmartreportConfig({
      LIMS_SMARTREPORT_PREBUILD_ENABLED: 'false', LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS: '30', LIMS_SMARTREPORT_LLM_ADAPTER: 'internal-x',
      LIMS_SMARTREPORT_LLM_ENDPOINT: 'https://llm.internal.example/v1', LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS: 'llm.internal.example,b.example',
      LIMS_SMARTREPORT_LLM_TIMEOUT_MS: '1000', LIMS_SMARTREPORT_LLM_MAX_CONCURRENCY: '8', LIMS_SMARTREPORT_LLM_MODEL_REF: 'model-label',
    })).toMatchObject({
      prebuildEnabled: false, prebuildDelaySeconds: 30, llmAdapter: 'internal-x', llmEndpoint: 'https://llm.internal.example/v1',
      llmAllowedHosts: ['llm.internal.example', 'b.example'], llmTimeoutMs: 1000, llmMaxConcurrency: 8, llmModelRef: 'model-label',
    });
  });

  it.each([
    ['LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS', '29'], ['LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS', '3601'], ['LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS', 'abc'],
    ['LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS', '1.5'], ['LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS', ''],
    ['LIMS_SMARTREPORT_LLM_TIMEOUT_MS', '999'], ['LIMS_SMARTREPORT_LLM_TIMEOUT_MS', '60001'], ['LIMS_SMARTREPORT_LLM_TIMEOUT_MS', '-1'],
    ['LIMS_SMARTREPORT_LLM_MAX_CONCURRENCY', '0'], ['LIMS_SMARTREPORT_LLM_MAX_CONCURRENCY', '9'], ['LIMS_SMARTREPORT_LLM_MAX_CONCURRENCY', '1e1'],
    ['LIMS_SMARTREPORT_PREBUILD_ENABLED', 'yes'], ['LIMS_SMARTREPORT_PREBUILD_ENABLED', '1'], ['LIMS_SMARTREPORT_PREBUILD_ENABLED', ''],
    ['LIMS_SMARTREPORT_LLM_MODEL_REF', 'x'.repeat(101)],
    ['LIMS_SMARTREPORT_LLM_ENDPOINT', 'http://llm.internal.example'], ['LIMS_SMARTREPORT_LLM_ENDPOINT', 'not a url'],
  ])('fails fast, naming the key: %s=%j', (key, value) => {
    expect(() => loadSmartreportConfig({ [key]: value })).toThrow(key);
  });
});

describe('C14-T01 boot against the real repo (default modulesDir, real smartreport.yaml)', () => {
  const ks = makeKeys('ES256');
  const apps: FastifyInstance[] = [];
  afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

  const boot = async () => {
    const config = loadConfig({
      LIMS_CORE_ENV: 'ci',
      LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
      LIMS_WEB_BFF_KEY_FILE: tmpFile('c14-t01-web-key-0123456789abcdef0123456789abcdef0123'),
    });
    const app = await bootstrap({ config });
    apps.push(app);
    return app;
  };
  const toUrl = (path: string) => path.replace(/\{[^}]+\}/g, '01a1a98a-ac40-7000-8000-000000090001');

  it('boots and mounts every smartreport operation at its spec path and method (35 of 35)', async () => {
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
    expect(n).toBe(35);
    expect(unmounted).toEqual([]);
  }, 60_000);

  it('fails closed: operations without required query/body answer 401 auth.* without credentials (never 200/501/500); non-spec path is 404', async () => {
    const app = await boot();
    const probes: { method: string; url: string }[] = [];
    for (const [path, item] of Object.entries<any>(SPEC.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!op?.operationId) continue;
        const requiredQuery = (op.parameters ?? []).some((p: any) => p.in === 'query' && p.required);
        const requiredHeader = (op.parameters ?? []).some((p: any) => (p.in === 'header' && p.required) || /\/IfMatch$/.test(p.$ref ?? '')); // $ref'd If-Match is unresolved in raw spec
        if (!requiredQuery && !requiredHeader && !op.requestBody?.required) {
          // path params with an enum must carry a valid value, else validation (400) precedes auth
          const url = path.replace(/\{([^}]+)\}/g, (_m, name) => {
            const prm = (op.parameters ?? []).find((p: any) => p.in === 'path' && p.name === name);
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
    expect((await app.inject({ method: 'GET', url: '/v1/smartreport/not-in-spec' })).statusCode).toBe(404);
  }, 60_000);
});
