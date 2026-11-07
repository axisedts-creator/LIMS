// BL-T01 boot test — "core boots with module" (06-IMPLEMENTATION-PLAN BL-T01; 02-CONVENTIONS §2.2; 02-TRD §6.3 autoloader rules).
// No ACs are mapped to this task. Security-side: REQ-SEC-099 (nothing mounted outside the spec, stubs never succeed
// unauthenticated), REQ-ARCH-076 (no import from another module's folder), permission codes exist in permissions.yaml (§10.1).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../../../core/bootstrap.js';
import { loadConfig } from '../../../../core/config.js';
import { checkHandlers, eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../../core/module.js';
import { AUD, ISS, tmpFile } from '../../../../core/auth/__tests__/helpers.js';
import { manifest } from '../../index.js';

const BILLING_DIR = join(import.meta.dirname, '..', '..');
const spec = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'billing.yaml'));
const open: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => { await Promise.all(open.splice(0).map((a) => a.close())); });

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : sources(p);
    return /\.tsx?$/.test(f) ? [p] : [];
  });

describe('BL-T01 manifest (index.ts)', () => {
  it('is the billing ModuleManifest and passes the core autoloader validation', () => {
    expect(manifest.name).toBe('billing');
    expect(manifest.openapi).toBe('contracts/openapi/billing.yaml');
    expect(() => validateManifest('billing', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces exactly the three billing events (EVENT_PRODUCERS)', () => {
    const want = ['billing.balance.changed.v1', 'billing.invoice.cancelled.v1', 'billing.invoice.issued.v1'];
    expect([...manifest.produces].sort()).toEqual(want);
    expect([...(eventProducers().billing ?? [])].sort()).toEqual(want);
  });

  it('has a handler for every billing.yaml operationId and no extra handler', () => {
    expect(operationIds(spec).length).toBeGreaterThan(0);
    expect(() => checkHandlers('billing', spec, manifest.handlers)).not.toThrow();
    expect(Object.keys(manifest.handlers).sort()).toEqual([...operationIds(spec)].sort());
  });

  it('declares only ports billing owns (BillingPort, BillingCommandPort)', () => {
    for (const p of Object.keys(manifest.ports ?? {})) expect(['BillingPort', 'BillingCommandPort']).toContain(p);
  });
});

describe('BL-T01 core boots with the module (default modulesDir, real contracts)', () => {
  it('bootstrap resolves and every billing operation is mounted, none answers 2xx without credentials', async () => {
    // core requires the bearerJwt verifier config to mount bearerJwt ops (02-TRD:623-624); synthetic HS256 secret
    const config = loadConfig({
      LIMS_CORE_ENV: 'ci',
      LIMS_CORE_JWT_ALG: 'HS256',
      LIMS_CORE_JWT_ISSUER: ISS,
      LIMS_CORE_JWT_AUDIENCE: AUD,
      LIMS_CORE_JWT_KEY_FILE: tmpFile('bl-t01-synthetic-hs256-secret-0123456789abcdef', 'jwt-hs.key'),
    });
    const app = await bootstrap({ config });
    open.push(app);
    const uuid = '00000000-0000-4000-8000-000000000001';
    const bad: string[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        const op = item?.[method];
        if (!op?.operationId || op['x-public']) continue;
        const url = path.replace(/\{[^}]+\}/g, uuid);
        const r = await app.inject({ method: method.toUpperCase() as any, url, payload: method === 'get' || method === 'delete' ? undefined : {} });
        // 404/405 = not mounted; 2xx = stub succeeded unauthenticated; 500 = stub crashes instead of refusing
        if ([404, 405, 500].includes(r.statusCode) || (r.statusCode >= 200 && r.statusCode < 300)) bad.push(`${op.operationId} ${method.toUpperCase()} ${url} -> ${r.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  }, 60_000);
});

describe('BL-T01 permissions.ts', () => {
  it('only names billing.* codes that exist in contracts/permissions.yaml, and names at least one', () => {
    const src = readFileSync(join(BILLING_DIR, 'permissions.ts'), 'utf8');
    const yaml = readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8');
    const defined = new Set([...yaml.matchAll(/code:\s*(billing\.[a-z_.]+)/g)].map((m) => m[1]));
    const used = [...src.matchAll(/['"`]([a-z_]+\.[a-z_]+(?:\.[a-z_]+)*)['"`]/g)].map((m) => m[1]!).filter((c) => /^(billing|frontdesk|lab|catalog|identity|payments)\./.test(c));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((c) => !defined.has(c))).toEqual([]);
  });
});

describe('BL-T01 config.ts', () => {
  it('imports without throwing on an empty environment (lazy defaults, TRD §11)', async () => {
    await expect(import('../../config.js')).resolves.toBeDefined();
  });

  it('reads only LIMS_BILLING_* keys (plus the one C4-shared payment-result URL)', () => {
    const src = readFileSync(join(BILLING_DIR, 'config.ts'), 'utf8');
    const keys = [...src.matchAll(/\bLIMS_[A-Z0-9_]+/g)].map((m) => m[0]);
    expect(keys.filter((k) => !k.startsWith('LIMS_BILLING_') && k !== 'LIMS_FRONTDESK_PAYMENT_RESULT_URL')).toEqual([]);
  });
});

describe('BL-T01 layering (REQ-ARCH-076)', () => {
  it('no billing source file imports from another module folder', () => {
    const files = sources(BILLING_DIR);
    expect(files.length).toBeGreaterThanOrEqual(3);
    const offenders = files.filter((f) => /from\s+['"][^'"]*\/modules\/(?!billing\b)[a-z_]+\//.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    expect(existsSync(join(BILLING_DIR, 'index.ts'))).toBe(true);
  });
});
