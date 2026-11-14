// C13 T01 — module scaffold: manifest, permissions, config, 68 operationId stubs (06-IMPLEMENTATION-PLAN row T01).
// done_when: "API boots with empty handler map against draft spec (handler stubs return 501 in dev only)". tests: boot test. No ACs.
// NOTE: the plan row was written against a draft spec; contracts/openapi/partners.yaml is now the real 68-op transcription (LD-103),
// and core boot validation (AC-0D-1.2) fails on any missing operationId, so "empty map" means: every operationId is a stub, none implemented.
// Security (07-SECURITY): nothing mounted that is not in the spec; fail-closed auth (bearerJwt only); each op bound to one registered partners.* permission;
// partner-actor permissions never on staff (/admin) operations and vice versa; stubs 501 only in dev and never echo request input.
// Interface expected from the writer (seams the spec does not fix are marked SEAM):
//   ../index.ts        export const manifest: ModuleManifest (02-TRD §3.4: name 'partners', openapi 'contracts/openapi/partners.yaml', handlers = the 68
//                      operationIds, ports {}, produces [], systemPermissions §9.3, no claimsResolver, no authResolvers)
//   ../permissions.ts  export const PARTNERS_PERMISSIONS: readonly string[]  (SEAM: name; = the 14 partners.* codes of permissions.yaml, frozen)
//   ../config.ts       export function loadPartnersConfig(env): PartnersConfig  (SEAM: function + camelCase field names; env names + defaults 02-TRD §10.1)
//   Stubs (SEAM, plan: "501 only in dev"): LIMS_CORE_ENV=dev -> resolves { status: 501 }; staging/production -> rejects with LimsError common.internal.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';
import { eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { AUD, ISS, makeKeys, tmpFile } from '../../../core/auth/__tests__/helpers.js';
import { loadPartnersConfig } from '../config.js';
import { manifest } from '../index.js';
import { PARTNERS_PERMISSIONS } from '../permissions.js';

const SPEC = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'partners.yaml'));
const OPS = operationIds(SPEC);
const PERMS = ['partners.manifest.receive', 'partners.manifest.submit', 'partners.order.read', 'partners.partner.manage',
  'partners.partner.read', 'partners.partner_user.manage', 'partners.pickup.manage', 'partners.pickup.request',
  'partners.price_list.read', 'partners.referrer.manage', 'partners.referrer.map', 'partners.referrer.read',
  'partners.report.read', 'partners.statement.read'];
/** Codes held only by partner actors (02-TRD §9.2): never valid on a staff `/v1/partners/admin/...` operation. */
const PARTNER_ONLY = ['partners.order.read', 'partners.manifest.submit', 'partners.report.read', 'partners.statement.read',
  'partners.price_list.read', 'partners.pickup.request', 'partners.referrer.read', 'partners.referrer.manage'];
/** operationIds whose stub a later task has replaced; that task moves its ids here (tester-owned list). */
const IMPLEMENTED: readonly string[] = [
  'getPartnerContext', // T03 (A1)
  'getPartnerDashboard', // T18 (A2)
  'listPartnerUsers', 'invitePartnerUser', 'changePartnerUserRole', 'deactivatePartnerUser', 'reactivatePartnerUser', 'resendPartnerInvitation', // T06 U1-U6
  'listPartnerUsersForPartner', 'invitePartnerUserByStaff', 'changePartnerUserRoleByStaff', 'deactivatePartnerUserByStaff', 'reactivatePartnerUserByStaff', // T06 SA8-SA10
  'listPartners', 'createPartner', 'getPartner', 'updatePartner', 'suspendPartner', 'reactivatePartner', 'resyncPartnerProjections', // T07 (SA1-SA7)
  'listPartnerPriceList', 'listPartnerStatements', 'getPartnerStatement', // T17 (P1, S1, S2)
  'listPartnerReferrers', 'createPartnerReferrer', 'updatePartnerReferrer', 'deactivatePartnerReferrer', 'reactivatePartnerReferrer', // T11 F1-F5
  'listReferrerMappings', 'mapPartnerReferrer', 'rejectPartnerReferrerMapping', 'unmapPartnerReferrer', // T11 SR1-SR3 (+ list)
  'createPickupRequest', 'listPickupRequests', 'getPickupRequest', 'cancelPickupRequest', // T15 K1-K4
  'listInboundPickups', 'schedulePickup', 'markPickupCollected', 'rejectPickup', // T15 SP1-SP4
  'createManifest', 'listManifests', 'getManifest', 'updateManifest', 'addManifestLine', 'replaceManifestLine', 'deleteManifestLine', 'discardManifest', 'searchPartnerOrderables', // T08 (M1-M7, M10, P2)
  'submitManifest', 'withdrawManifest', 'getManifestPrintView', // T09 (M8, M9, M11)
  'listInboundManifests', 'getInboundManifest', 'receiveManifest', 'retryManifestLineConversion', 'markManifestLineNotReceived', // T10 (SI1-SI5)
  'listPartnerOrders', 'searchPartnerOrders', 'getPartnerOrder', 'listPartnerReports', 'markPartnerReportsSeen', 'downloadPartnerReport', // T13 (O1-O3, R1-R3)
  'issuePatientAccessSlip', 'getPatientAccessSlip', 'downloadPatientAccessSlip', // T14 (R4-R6)
];

const FAKE_REQ = { params: {}, query: {}, headers: {}, body: {} };
const noop = () => undefined;
const fakeCtx = (operationId: string) => ({ operationId, clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } }) as any;
const allOps = () => Object.entries<any>(SPEC.paths).flatMap(([path, item]) =>
  Object.entries<any>(item).filter(([, op]) => op?.operationId).map(([method, op]) => ({ path, method, op })));

describe('T01 manifest', () => {
  it('is module partners bound to contracts/openapi/partners.yaml and passes the core manifest validation', () => {
    expect(manifest.name).toBe('partners');
    expect(manifest.openapi).toBe('contracts/openapi/partners.yaml');
    expect(() => validateManifest('partners', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces no event, owns no port, no claimsResolver / authResolvers; systemPermissions per TRD §9.3 (never platform.*)', () => {
    expect([...manifest.produces]).toEqual([]);
    expect([...(eventProducers().partners ?? [])]).toEqual([]);
    expect(Object.keys(manifest.ports ?? {})).toEqual([]);
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual([]);
    const sys = [...(manifest.systemPermissions ?? [])];
    expect(sys).toEqual(expect.arrayContaining(['partners.manifest.receive', 'partners.partner.read']));
    for (const p of sys) {
      expect((PERMISSION_CODES as readonly string[]).includes(p), p).toBe(true);
      expect(p.startsWith('platform.'), p).toBe(false);
    }
  });

  it('core boot validation rejects a handler set that drifts from the spec (missing and extra operationId)', () => {
    const missing = OPS[0]!;
    const { [missing]: _drop, ...rest } = manifest.handlers;
    expect(() => validateManifest('partners', { ...manifest, handlers: rest }, REPO_ROOT)).toThrow(missing);
    expect(() => validateManifest('partners', { ...manifest, handlers: { ...manifest.handlers, notInSpec: manifest.handlers[missing]! } }, REPO_ROOT))
      .toThrow('notInSpec');
  });
});

describe('T01 handler map (68 operationIds of partners.yaml)', () => {
  it('the spec has 68 unique operationIds', () => {
    expect(OPS.length).toBe(68);
    expect(new Set(OPS).size).toBe(68);
  });

  it('binds every operationId of partners.yaml to a function, and nothing else (AC-0D-1.2)', () => {
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
      const { isLimsError: isLE } = await import('../../../core/errors.js'); // same registry as the stub (withEnv resets modules)
      for (const op of stubs) {
        const out = await Promise.resolve(m.handlers[op]!(FAKE_REQ, fakeCtx(op))).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
        expect(out.ok, `${env} ${op} resolved: ${JSON.stringify(out)}`).toBe(false);
        if (!out.ok) expect(isLE(out.e, 'common.internal'), `${env} ${op}`).toBe(true);
      }
    }
  });
});

describe('T01 permissions', () => {
  const codes = PERMISSION_CODES.filter((c) => c.startsWith('partners.'));

  it('PARTNERS_PERMISSIONS = the 14 partners.* codes of contracts/permissions.yaml (no invented code, none missing), frozen', () => {
    expect([...codes].sort()).toEqual(PERMS);
    expect([...PARTNERS_PERMISSIONS].sort()).toEqual(PERMS);
    expect(new Set(PARTNERS_PERMISSIONS).size).toBe(PARTNERS_PERMISSIONS.length);
    expect(Object.isFrozen(PARTNERS_PERMISSIONS)).toBe(true);
  });

  it('every operation: bearerJwt only (no device/portal/anonymous scheme) and exactly one registered partners permission', () => {
    const bad: string[] = [];
    for (const { path, method, op } of allOps()) {
      const where = `${method.toUpperCase()} ${path} (${op.operationId})`;
      const schemes = (op.security ?? []).flatMap((s: object) => Object.keys(s));
      if (schemes.length !== 1 || schemes[0] !== 'bearerJwt') bad.push(`${where}: scheme ${JSON.stringify(schemes)}`);
      const perm: string | undefined = op['x-permission'];
      if (!perm || !(PERMISSION_CODES as readonly string[]).includes(perm) || !PARTNERS_PERMISSIONS.includes(perm)) bad.push(`${where}: permission ${String(perm)}`);
    }
    expect(bad).toEqual([]);
  });

  it('role separation: partner-actor codes never guard a staff /admin operation, and staff-side codes never guard a partner-facing path', () => {
    const bad: string[] = [];
    for (const { path, method, op } of allOps()) {
      const admin = path.startsWith('/v1/partners/admin/');
      const perm: string = op['x-permission'];
      if (admin && PARTNER_ONLY.includes(perm)) bad.push(`${method.toUpperCase()} ${path}: partner-actor permission ${perm} on staff route`);
      if (!admin && ['partners.partner.manage', 'partners.partner.read', 'partners.manifest.receive', 'partners.pickup.manage', 'partners.referrer.map'].includes(perm))
        bad.push(`${method.toUpperCase()} ${path}: staff permission ${perm} on partner-facing route`);
    }
    expect(bad).toEqual([]);
  });
});

describe('T01 config (02-TRD §10.1, LIMS_PARTNERS_*)', () => {
  const DEFAULTS = { convertingStaleMinutes: 30, reconcileBatch: 500, statementMonths: 24, downloadSignedUrlMaxSeconds: 300 };
  const KEYS: Record<keyof typeof DEFAULTS, string> = {
    convertingStaleMinutes: 'LIMS_PARTNERS_CONVERTING_STALE_MINUTES', reconcileBatch: 'LIMS_PARTNERS_RECONCILE_BATCH',
    statementMonths: 'LIMS_PARTNERS_STATEMENT_MONTHS', downloadSignedUrlMaxSeconds: 'LIMS_PARTNERS_DOWNLOAD_SIGNED_URL_MAX_SECONDS',
  };

  it('defaults when no env is set (TRD §10.1 [CONV] values)', () => {
    expect(loadPartnersConfig({})).toMatchObject(DEFAULTS);
  });

  it('reads overrides for every key', () => {
    expect(loadPartnersConfig({
      LIMS_PARTNERS_CONVERTING_STALE_MINUTES: '5', LIMS_PARTNERS_RECONCILE_BATCH: '50', LIMS_PARTNERS_STATEMENT_MONTHS: '12',
      LIMS_PARTNERS_DOWNLOAD_SIGNED_URL_MAX_SECONDS: '60',
    })).toMatchObject({ convertingStaleMinutes: 5, reconcileBatch: 50, statementMonths: 12, downloadSignedUrlMaxSeconds: 60 });
  });

  it.each(Object.values(KEYS).flatMap((k) => ['abc', '0', '-1', '1.5', '1e3', ''].map((v) => [k, v] as const)))(
    'fails fast, naming the key: %s=%j', (key, value) => {
      expect(() => loadPartnersConfig({ [key]: value })).toThrow(key);
    });

  it('config never carries the BFF secret: LIMS_PARTNER_BFF_KEY_FILE is not read or echoed by the API config (08 A19 P-45)', () => {
    const cfg = loadPartnersConfig({ LIMS_PARTNER_BFF_KEY_FILE: '/run/secrets/PLANTED-KEYFILE' });
    expect(JSON.stringify(cfg)).not.toContain('PLANTED-KEYFILE');
  });
});

const COMMON = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', '_common.yaml'));
/** Resolves `_common.yaml#/components/parameters/<Name>` refs (and passes inline params through). */
const resolveParam = (p: any): any => {
  const name = /#\/components\/parameters\/(\w+)$/.exec(p?.$ref ?? '')?.[1];
  return name ? (COMMON as any).components?.parameters?.[name] ?? {} : p ?? {};
};

describe('T01 boot against the real repo (default modulesDir, real partners.yaml)', () => {
  const ks = makeKeys('ES256');
  const apps: FastifyInstance[] = [];
  afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

  const boot = async () => {
    const config = loadConfig({
      LIMS_CORE_ENV: 'ci',
      LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
      LIMS_WEB_BFF_KEY_FILE: tmpFile('c13-t01-web-key-0123456789abcdef0123456789abcdef0123'),
    });
    const app = await bootstrap({ config });
    apps.push(app);
    return app;
  };
  // version_no is an integer path param (partners.yaml:1800), period_month is YYYY-MM (partners.yaml:7879); a UUID there would 400 before auth.
  const toUrl = (path: string) => path.replace(/\{version_no\}/g, '1').replace(/\{period_month\}/g, '2026-01').replace(/\{[^}]+\}/g, '01940e00-0000-7000-8000-c13000000001');

  it('boots and mounts every partners operation at its spec path and method (68 of 68)', async () => {
    const app = await boot();
    const unmounted: string[] = [];
    for (const { path, method } of allOps()) {
      if (!app.hasRoute({ method: method.toUpperCase() as any, url: path.replace(/\{([^}]+)\}/g, ':$1') })) unmounted.push(`${method.toUpperCase()} ${path}`);
    }
    expect(allOps().length).toBe(68);
    expect(unmounted).toEqual([]);
  }, 600_000); // LD-152: 12 lanes share one machine; boot of all 15 modules exceeded 300 s

  it('fails closed: operations without required query/body answer 401 auth.* without credentials (never 200/501/500); non-spec path is 404', async () => {
    const app = await boot();
    const probes: { method: string; url: string }[] = [];
    for (const { path, method, op } of allOps()) {
      const requiredQuery = (op.parameters ?? []).some((p: any) => p.in === 'query' && p.required);
      // ruling C13.T01-ruling: a required header (x-idempotency: required / IdempotencyKey $ref) makes 400 common.idempotency_key_required a spec-listed outcome, same class as required query/body.
      const requiredHeader = op['x-idempotency'] === 'required'
        || (op.parameters ?? []).some((p: any) => { const r = resolveParam(p); return r.in === 'header' && r.required; });
      if (!requiredQuery && !requiredHeader && !op.requestBody?.required) probes.push({ method: method.toUpperCase(), url: toUrl(path) });
    }
    expect(probes.length).toBeGreaterThanOrEqual(10);
    for (const { method, url } of probes) {
      const r = await app.inject({ method: method as any, url });
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(401);
      expect(JSON.parse(r.body).code).toMatch(/^auth\./);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/partners/not-in-spec' })).statusCode).toBe(404);
  }, 600_000); // LD-152
});
