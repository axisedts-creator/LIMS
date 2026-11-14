// FD-T01 boot test — C4 frontdesk module skeleton + manifests (06-IMPLEMENTATION-PLAN row FD-T01, 02-TRD §3.1/§3.3/§7/§11.1).
// done_when: core boots with module; unimplemented handlers throw common.service_unavailable; nav entry hidden; CI path check green
// (the path check lives in tests/frontdesk/FD-T01.paths.test.mjs). Security: REQ-SEC-099 (nothing mounted outside the spec),
// fail closed (no payload echo from a stub, no handler reachable unauthenticated). Synthetic data only.
// Tests load the module files by path so each test fails on its own while the files do not exist yet.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { AUD, ISS, makeKeys } from '../../../../core/auth/__tests__/helpers.js';
import { bootstrap } from '../../../../core/bootstrap.js';
import { loadConfig } from '../../../../core/config.js';
import { isLimsError } from '../../../../core/errors.js';
import { autoload, DEFAULT_MODULES_DIR, eventProducers, operationIds, REPO_ROOT, validateManifest } from '../../../../core/module.js';

const F = 'services/api/src/modules/frontdesk';
const FILES = {
  index: `${F}/index.ts`,
  permissions: `${F}/permissions.ts`,
  config: `${F}/config.ts`,
  handlers: `${F}/handlers/index.ts`,
  worker: 'services/worker/src/jobs/frontdesk/index.ts',
  nav: 'apps/web/src/features/frontdesk/nav.manifest.ts',
};
const load = (rel: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(join(REPO_ROOT, rel)).href);
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');
const spec = (): any => parse(read('contracts/openapi/frontdesk.yaml'));
const UUID = '0190a000-0000-7000-8000-00000000a001';

// 02-TRD §7 (frontdesk line) — verbatim.
const PERMISSIONS = [
  'frontdesk.registration.create', 'frontdesk.patient.read', 'frontdesk.order.read', 'frontdesk.order.edit',
  'frontdesk.order.cancel', 'frontdesk.discount.apply', 'frontdesk.discount.approve', 'frontdesk.trf.upload',
  'frontdesk.settings.manage', 'frontdesk.patient.anonymise',
];
// 02-TRD §3.1 index.ts / 03-IC §3.1–3.3.
const PRODUCES = ['frontdesk.order.created.v1', 'frontdesk.order.items_changed.v1', 'frontdesk.order.cancelled.v1'];

// Core fails boot closed without a JWT verifier (C0 TRD:945, :623) and frontdesk.yaml uses bearerJwt: pass all four (synthetic key).
const keys = makeKeys('ES256');
const bootConfig = () => loadConfig({
  LIMS_CORE_ENV: 'ci', LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: keys.verifyKeyFile,
});

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

/** [method, url, operationId] for every operation in the real frontdesk spec. */
function operations(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const [p, item] of Object.entries<any>(spec().paths)) {
    for (const m of ['get', 'put', 'post', 'delete', 'patch']) {
      if (item[m]?.operationId) out.push([m.toUpperCase(), p.replace(/\{[^}]+\}/g, UUID), item[m].operationId]);
    }
  }
  return out;
}

describe('FD-T01 files exist (06-IMPLEMENTATION-PLAN FD-T01)', () => {
  it.each(Object.entries(FILES))('%s: %s is present', (_k, rel) => {
    expect(existsSync(join(REPO_ROOT, rel)), rel).toBe(true);
  });
});

describe('manifest (02-TRD §3.1, §6.3 autoloader rules)', () => {
  it('name, openapi and produces are exactly the spec values', async () => {
    const { manifest } = await load(FILES.index);
    expect(manifest.name).toBe('frontdesk');
    expect(manifest.openapi).toBe('contracts/openapi/frontdesk.yaml');
    expect([...manifest.produces].sort()).toEqual([...PRODUCES].sort());
    expect([...manifest.produces].sort()).toEqual([...eventProducers().frontdesk!].sort());
  });

  it('passes the core manifest validation against the real contracts (handlers == operationIds, produces == EVENT_PRODUCERS)', async () => {
    const { manifest } = await load(FILES.index);
    expect(() => validateManifest('frontdesk', manifest, REPO_ROOT)).not.toThrow();
  });

  it('declares no cross-module powers: no claimsResolver, no authResolvers', async () => {
    const { manifest } = await load(FILES.index);
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual([]);
  });

  it('is found by the autoloader in the default modules directory', async () => {
    const mods = await autoload(DEFAULT_MODULES_DIR, REPO_ROOT);
    expect(mods.map((m) => m.manifest.name)).toContain('frontdesk');
  }, 60_000);
});

describe('done_when: core boots with module (AC-0D-1.1/1.2 through the real bootstrap, real repo root)', () => {
  it('bootstrap with default repoRoot/modulesDir resolves (every operationId has a handler)', async () => {
    const app = await bootstrap({ config: bootConfig() });
    apps.push(app);
    const { manifest } = await load(FILES.index);
    expect(Object.keys(manifest.handlers).sort()).toEqual(operationIds(spec()).sort());
  }, 60_000);

  it('every frontdesk operation is mounted (never 404/405) and answers unauthenticated calls with 400/401, never by running a stub', async () => {
    const app = await bootstrap({ config: bootConfig() });
    apps.push(app);
    const ops = operations();
    expect(ops.length).toBe(29);
    for (const [method, url, op] of ops) {
      const r = await app.inject({ method: method as any, url });
      expect([400, 401], `${op} ${method} ${url} -> ${r.statusCode}`).toContain(r.statusCode);
      expect(JSON.parse(r.body).code, op).not.toBe('common.service_unavailable');
    }
    const r = await app.inject({ method: 'GET', url: '/v1/frontdesk/settings' });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.body).code).toMatch(/^auth\./);
  }, 60_000);

  it('mounts nothing outside the spec (REQ-SEC-099)', async () => {
    const app = await bootstrap({ config: bootConfig() });
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/v1/frontdesk/__nothing__' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/frontdesk/orders/../../etc/passwd' })).statusCode).toBe(404);
  }, 60_000);
});

describe('done_when: unimplemented handlers throw common.service_unavailable', () => {
  it('handlers/index.ts exports one function per operationId and nothing else', async () => {
    const mod = await load(FILES.handlers);
    const h = mod.handlers ?? mod.default;
    expect(h, 'handlers/index.ts must export `handlers` (the manifest.handlers map)').toBeTypeOf('object');
    expect(Object.keys(h).sort()).toEqual(operationIds(spec()).sort());
    for (const fn of Object.values(h)) expect(fn).toBeTypeOf('function');
    const { manifest } = await load(FILES.index);
    expect(manifest.handlers).toBe(h);
  });

  // Ruling FD-T04-ruling.md (TESTS_WRONG): the stub requirement (06-IMPLEMENTATION-PLAN:11) lasts only "until their task merges".
  // Still-stub operationIds come from probes/pending.json (LD-70, writer-owned stub inventory) when it exists; until the
  // writer generates it, fall back to every operation minus the six FD-T04 ops (06-IMPLEMENTATION-PLAN:14).
  // FD-T05 (06-IMPLEMENTATION-PLAN:15) turns quoteRegistration into a real handler the same way.
  // FD-T06 (06-IMPLEMENTATION-PLAN:16) turns createRegistration into a real handler the same way.
  // FD-T07 (06-IMPLEMENTATION-PLAN:17) turns F15-F19 into real handlers the same way (LD-70: pending.json is the writer's).
  const FD_T04_OPS = ['searchPatients', 'createPatient', 'getPatient', 'updatePatient', 'recordPatientConsent', 'listPatientOrders', 'quoteRegistration', 'createRegistration',
    'requestDiscountApproval', 'listDiscountApprovals', 'getDiscountApproval', 'approveDiscount', 'rejectDiscount'];
  const stubOps = (): string[] => {
    const p = join(REPO_ROOT, F, '__tests__/probes/pending.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as string[];
    return operationIds(spec()).filter((op: string) => !FD_T04_OPS.includes(op));
  };

  it('every still-unimplemented handler rejects with LimsError common.service_unavailable (503)', async () => {
    const { manifest } = await load(FILES.index);
    const ctx = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    const req = { params: {}, query: {}, headers: {}, body: {} };
    for (const op of stubOps()) {
      let err: unknown;
      try { await manifest.handlers[op](req, { ...ctx, operationId: op }); } catch (e) { err = e; }
      expect(isLimsError(err, 'common.service_unavailable'), `${op} must throw common.service_unavailable, got ${String(err)}`).toBe(true);
      expect((err as any).statusCode, op).toBe(503);
    }
  });

  it('a stub never echoes request data (no PII in the error)', async () => {
    const { manifest } = await load(FILES.index);
    const secret = 'SYNTHETIC-PATIENT-Sita-Test-9800000000';
    const req = { params: { patient_id: secret }, query: { q: secret }, headers: { authorization: `Bearer ${secret}` }, body: { full_name: secret } };
    // Ruling FD-T15-ruling.md (TESTS_WRONG): an empty stub inventory is the required end state after FD-T15.
    if (stubOps().length === 0) return;
    const stub = stubOps().includes('anonymisePatient') ? 'anonymisePatient' : stubOps()[0]!;
    const ctx = { operationId: stub, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    let err: any;
    try { await manifest.handlers[stub](req, ctx); } catch (e) { err = e; }
    expect(isLimsError(err, 'common.service_unavailable')).toBe(true);
    expect(JSON.stringify({ m: err.message, d: err.detail, e: err.errors })).not.toContain(secret);
  });

  it('a stub is not a silent success: no handler resolves for an empty request', async () => {
    const { manifest } = await load(FILES.index);
    const ctx = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    const settled = await Promise.allSettled(Object.values<any>(manifest.handlers).map((h) => h({ params: {}, query: {}, headers: {}, body: undefined }, ctx)));
    expect(settled.filter((s) => s.status === 'fulfilled')).toEqual([]);
  });
});

describe('permissions.ts (02-TRD §7)', () => {
  const strings = (v: unknown, out: Set<string> = new Set()): Set<string> => {
    if (typeof v === 'string') out.add(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
    return out;
  };

  it('exposes exactly the ten frontdesk codes of TRD §7 (no merge, no invented code)', async () => {
    const codes = [...strings(await load(FILES.permissions))].filter((s) => s.startsWith('frontdesk.'));
    expect(codes.sort()).toEqual([...PERMISSIONS].sort());
  });

  it('every code is registered in contracts/permissions.yaml', () => {
    const registry = read('contracts/permissions.yaml');
    for (const c of PERMISSIONS) expect(registry, c).toMatch(new RegExp(`code:\\s*${c.replaceAll('.', '\\.')}\\b`));
  });

  it('every x-permission used by the frontdesk spec is in the module permission set', () => {
    const used = new Set<string>();
    for (const m of read('contracts/openapi/frontdesk.yaml').matchAll(/x-permission:\s*([a-z_.]+)/g)) used.add(m[1]!);
    expect(used.size).toBeGreaterThan(0);
    for (const p of used) expect(PERMISSIONS, p).toContain(p);
  });
});

describe('config.ts (02-TRD §11.1: LIMS_FRONTDESK_* with documented defaults)', () => {
  // The export shape is the writer's choice; the keys and defaults are the spec's.
  it.each([
    ['LIMS_FRONTDESK_TRF_MAX_BYTES', '15728640'],
    ['LIMS_FRONTDESK_SEARCH_MAX_RESULTS', '20'],
    ['LIMS_FRONTDESK_APPROVAL_TTL_MINUTES', '15'],
    ['LIMS_FRONTDESK_TRF_DRAFT_TTL_HOURS', '24'],
  ])('%s defaults to %s', (key, def) => {
    const src = read(FILES.config);
    expect(src).toContain(key);
    expect(src).toMatch(new RegExp(`${key}[\\s\\S]{0,160}?${def}`));
  });

  it('declares LIMS_FRONTDESK_PAYMENT_RESULT_URL with no default and holds no URL/secret literal', () => {
    const src = read(FILES.config);
    expect(src).toContain('LIMS_FRONTDESK_PAYMENT_RESULT_URL');
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/(secret|password|api[_-]?key)\s*[:=]\s*['"][^'"]+['"]/i);
  });

  it('reads only LIMS_FRONTDESK_* keys (no billing / foreign env)', () => {
    const keys = [...read(FILES.config).matchAll(/\bLIMS_[A-Z0-9_]+/g)].map((m) => m[0]);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k, k).toMatch(/^LIMS_FRONTDESK_/);
  });
});

describe('worker manifest (02-TRD §3.3, §7.2 build-time checks)', () => {
  it('exports `manifest` for module frontdesk and passes validateManifests', async () => {
    const { manifest } = await load(FILES.worker);
    const { validateManifests } = await load('services/worker/src/core/manifest.ts');
    expect(manifest.module).toBe('frontdesk');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('only declares tasks and subscriptions the TRD lists', async () => {
    const { manifest } = await load(FILES.worker);
    const tasks = ['frontdesk.trf_scan', 'frontdesk.trf_draft_purge', 'frontdesk.discount_approval_expire'];
    const subs = ['lab.specimen.rejected.v1', 'lab.specimen.status_changed.v1', 'catalog.changed.v1', 'engagement.booking.confirmed.v1', 'engagement.booking.cancelled.v1'];
    for (const t of Object.keys(manifest.tasks ?? {})) expect(tasks, t).toContain(t);
    for (const s of Object.keys(manifest.subscriptions ?? {})) expect(subs, s).toContain(s);
  });
});

describe('done_when: nav entry hidden (apps/web nav.manifest.ts, 04-UI-UX §3)', () => {
  it('exports navManifest for module frontdesk with no visible entry yet', async () => {
    const { navManifest } = await load(FILES.nav);
    expect(navManifest.module).toBe('frontdesk');
    expect(Array.isArray(navManifest.entries)).toBe(true);
    expect(navManifest.entries).toEqual([]);
  });

  it('build-nav accepts the real features dir: no errors and no frontdesk entry in the resolved nav', async () => {
    const { buildNav } = await load('apps/web/src/core/nav/build-nav.ts');
    const r = await buildNav(join(REPO_ROOT, 'apps/web/src/features'), read('contracts/routes.yaml'));
    expect(r.errors).toEqual([]);
    expect(r.entries.filter((e: any) => e.module === 'frontdesk')).toEqual([]);
  });
});
