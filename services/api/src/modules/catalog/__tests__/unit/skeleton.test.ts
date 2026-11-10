// T-01 (C3) — module skeleton, manifest, permissions, config, stub inventory.
// Spec: C3 02-TRD §3 (layout, manifest), §5.0 (9 permissions, 107 ops), §11 (config keys + defaults),
//       06-PLAN T-01, CR-C3-008 (stubs + probes/pending.json), 02-CV §2.2 (handler per operationId), 07-SECURITY REQ-SEC-099.
// Interface these tests expect (see .orchestra/notes/T-01-tests.md):
//   catalog/index.ts          export const manifest  (name 'catalog', openapi, produces, handlers)
//   catalog/handlers/index.ts export const handlers  (Record<operationId, Handler>)
//   catalog/permissions.ts    export const CATALOG_PERMISSIONS: readonly string[]  (the 9 codes)
//   catalog/config.ts         export function loadCatalogConfig(env): CatalogConfig  (camelCase of key minus LIMS_CATALOG_)
//   catalog/__tests__/probes/pending.json   JSON array of operationId strings
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isLimsError, toProblem } from '../../../../core/errors.js';
import { autoload, DEFAULT_MODULES_DIR, operationIds, REPO_ROOT, validateManifest, type Handler } from '../../../../core/module.js';
import { loadCatalogConfig } from '../../config.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { CATALOG_PERMISSIONS } from '../../permissions.js';

const readYaml = (...p: string[]) => parse(readFileSync(join(REPO_ROOT, ...p), 'utf8'));
const spec = readYaml('contracts', 'openapi', 'catalog.yaml');
const OPS: string[] = operationIds(spec);
const pending: unknown = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));

const NINE = [
  'catalog.test.read', 'catalog.test.manage', 'catalog.price_list.read', 'catalog.price_list.manage',
  'catalog.referrer.manage', 'catalog.instrument_code_map.manage',
  'catalog.referrer.read', 'catalog.reference_range.publish', 'catalog.referrer.export',
];
const REQ = { params: {}, query: {}, headers: {}, body: undefined };
const CTX = { operationId: 'x', clientIp: '203.0.113.7', log: { info() {}, warn() {}, error() {} } };
const isStub = async (h: Handler): Promise<boolean> => {
  try {
    await h(REQ, CTX);
    return false;
  } catch (e) {
    return isLimsError(e, 'common.service_unavailable') && e.detail === 'not_implemented';
  }
};

describe('manifest + autoload (02-TRD §3, §6.3 of core)', () => {
  it('catalog.yaml declares the 107 operations of 02-TRD §5', () => {
    expect(OPS).toHaveLength(107);
  });

  it('manifest has name, openapi path and produces exactly catalog.changed.v1', () => {
    expect(manifest.name).toBe('catalog');
    expect(manifest.openapi).toBe('contracts/openapi/catalog.yaml');
    expect([...manifest.produces]).toEqual(['catalog.changed.v1']);
  });

  it('passes the core manifest validation (handler key set == spec operationId set)', () => {
    expect(() => validateManifest('catalog', manifest, REPO_ROOT)).not.toThrow();
  });

  it('is found by the core autoloader with no central list', async () => {
    const mods = await autoload(DEFAULT_MODULES_DIR, REPO_ROOT);
    expect(mods.map((m) => m.manifest.name)).toContain('catalog');
  }, 120000); // ruling C3.T-30: cold autoload exceeds the 5000ms default (5.8s per ruling; 18-30s+ measured when run alongside the health tests)

  it('has exactly one function handler per catalog.yaml operationId; manifest.handlers is handlers/index', () => {
    expect(Object.keys(handlers).sort()).toEqual([...OPS].sort());
    for (const id of OPS) expect(typeof handlers[id], id).toBe('function');
    expect(manifest.handlers).toBe(handlers);
  });
});

describe('permissions.ts (02-TRD §5.0, REQ-SEC-099)', () => {
  it('lists exactly the 9 catalog.* codes, no duplicates', () => {
    expect([...CATALOG_PERMISSIONS].sort()).toEqual([...NINE].sort());
  });

  it('every code is registered in contracts/permissions.yaml', () => {
    const registered = new Set<string>(readYaml('contracts', 'permissions.yaml').permissions.map((p: any) => p.code));
    for (const c of CATALOG_PERMISSIONS) expect(registered.has(c), c).toBe(true);
  });

  it('every operation has an x-permission from the 9 and none is x-public', () => {
    for (const item of Object.values<any>(spec.paths)) {
      for (const op of Object.values<any>(item)) {
        if (!op?.operationId) continue;
        expect(op['x-public'], op.operationId).toBeUndefined();
        expect(CATALOG_PERMISSIONS, op.operationId).toContain(op['x-permission']);
      }
    }
  });
});

describe('config.ts (02-TRD §11)', () => {
  const DEFAULTS: Record<string, number> = {
    cacheMaxEntries: 50000, cacheTtlSeconds: 600, importMaxBytes: 15728640, importMaxUncompressedBytes: 52428800,
    importMaxZipEntries: 200, importMaxCompressionRatio: 100, importMaxRows: 20000, importMaxIssues: 5000,
    importParseTimeoutMs: 60000, importTtlHours: 168, fileRetentionDays: 30, maxActiveImportsPerTenant: 2,
    panelMaxDepth: 4, formulaMaxChainDepth: 5, effectiveFromToleranceSeconds: 300, priceChangeWarnPct: 50,
  };
  const KEY = (field: string) => 'LIMS_CATALOG_' + field.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();

  it('needs no env and returns the 16 typed defaults', () => {
    expect({ ...loadCatalogConfig({}) }).toEqual(DEFAULTS);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(loadCatalogConfig({}))).toBe(true);
  });

  it.each(Object.keys(DEFAULTS))('%s is overridden by its LIMS_CATALOG_ key', (field) => {
    const cfg: any = loadCatalogConfig({ [KEY(field)]: '7' });
    expect(cfg[field]).toBe(7);
    for (const other of Object.keys(DEFAULTS).filter((f) => f !== field)) expect(cfg[other]).toBe(DEFAULTS[other]);
  });

  it.each(Object.keys(DEFAULTS))('%s rejects non-integers and names the key', (field) => {
    for (const bad of ['abc', '', ' 5', '5 ', '-1', '1.5', '1e3', '0x10', 'NaN', '99999999999999999999']) {
      expect(() => loadCatalogConfig({ [KEY(field)]: bad }), `${KEY(field)}=${JSON.stringify(bad)}`).toThrow(KEY(field));
    }
  });

  it('ignores unrelated and foreign keys', () => {
    expect({ ...loadCatalogConfig({ LIMS_CORE_ENV: 'ci', LIMS_CATALOG_UNKNOWN: 'x', PATH: '/bin' }) }).toEqual(DEFAULTS);
  });
});

describe('stub inventory (CR-C3-008, 06-PLAN T-01)', () => {
  it('pending.json is a duplicate-free array of operationIds that exist in catalog.yaml', () => {
    expect(Array.isArray(pending)).toBe(true);
    const list = pending as string[];
    for (const id of list) expect(typeof id).toBe('string');
    expect(new Set(list).size).toBe(list.length);
    for (const id of list) expect(OPS, id).toContain(id);
  });

  it('pending.json lists exactly the handlers that still throw common.service_unavailable/not_implemented', async () => {
    const stubs: string[] = [];
    for (const id of OPS) if (await isStub(handlers[id]!)) stubs.push(id);
    expect([...(pending as string[])].sort()).toEqual(stubs.sort());
  });

  it('a stub rejects (async) with LimsError common.service_unavailable, detail not_implemented, HTTP 503', async () => {
    const stub = OPS.map((id) => handlers[id]!);
    let seen = 0;
    for (const h of stub) {
      if (!(await isStub(h))) continue;
      seen++;
      const p = h(REQ, CTX);
      await expect(p).rejects.toMatchObject({ code: 'common.service_unavailable', detail: 'not_implemented', statusCode: 503 });
    }
    // while T-01 is the only task done every operation is a stub; later tasks shrink this, never grow it
    expect(seen).toBe((pending as string[]).length);
  });

  // Ruling C3.T-30: pick a handler that is still a stub (pending.json), not a fixed OPS[0] that a later task makes real.
  it.skipIf((pending as string[]).length === 0)('a stub renders as a 503 problem and leaks nothing about the request', async () => {
    const err = await handlers[(pending as string[])[0]!]!({ ...REQ, body: { secret: 'S3CR3T' } }, CTX).catch((e: unknown) => e);
    const p = toProblem(err, '/v1/catalog/x', '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
    expect(p).toMatchObject({ status: 503, code: 'common.service_unavailable' });
    expect(JSON.stringify(p)).not.toContain('S3CR3T');
  });
});
