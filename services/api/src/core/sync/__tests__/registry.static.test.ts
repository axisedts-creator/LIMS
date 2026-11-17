// T0B-SYNC-1 static probes (no database): contract <-> handler coverage (done_when 1, the boot check), the permission / idempotency table, LD-325 (b) pending list emptied,
// and source scans of the sync code (07-SECURITY §5: no personal data in logs or errors; rows never deleted; bill/receipt numbers never in blocks).
// Self-contained on purpose: imports no ./helpers.ts (that needs LIMS_TEST_APP_URL).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkHandlers, loadSpec, REPO_ROOT } from '../../module.js';
import { CORE_PENDING_OPERATIONS } from '../../core-pending.js';
import { createHealthHandlers } from '../../health.js';
import { okChecks } from '../../observability/__tests__/helpers.js';
import { createSyncHandlers, syncHandlers } from '../index.js';

const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/core.yaml'));
const OPS = Object.entries<any>(spec.paths).flatMap(([path, item]) => ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item?.[m]?.operationId)
  .map((m) => ({ id: item[m].operationId as string, method: m, path, perm: item[m]['x-permission'] as string | undefined, idem: String(item[m]['x-idempotency'] ?? '') })));
const SYNC = ['registerSyncDevice', 'listSyncDevices', 'revokeSyncDevice', 'requestSyncDeviceWipe', 'ackDeviceWipe', 'getSyncStatus', 'reserveNumberBlock'];
const EXPECT: Record<string, [string, string]> = {   // operationId -> [x-permission, x-idempotency]
  registerSyncDevice: ['sync.use', 'required'], listSyncDevices: ['sync.device.manage', 'none'], revokeSyncDevice: ['sync.device.manage', 'optional'],
  requestSyncDeviceWipe: ['sync.device.manage', 'optional'], ackDeviceWipe: ['sync.use', 'optional'], getSyncStatus: ['sync.use', 'none'], reserveNumberBlock: ['sync.use', 'required'],
};
const DIR = 'services/api/src/core/sync';
const walk = (dir: string): string[] => readdirSync(join(REPO_ROOT, dir)).flatMap((f) => {
  const rel = `${dir}/${f}`; return statSync(join(REPO_ROOT, rel)).isDirectory() ? (f === '__tests__' ? [] : walk(rel)) : [rel];
});
const SRC = walk(DIR).filter((f) => f.endsWith('.ts'));

describe('T0B-SYNC-1 done_when (1): every sync operation has a registered handler and the boot check passes', () => {
  it('the 7 sync operations are in the spec and each has a function in syncHandlers', () => {
    for (const id of SYNC) { expect(OPS.map((o) => o.id), id).toContain(id); expect(typeof (syncHandlers as any)[id], id).toBe('function'); }
    expect(Object.keys(syncHandlers).sort()).toEqual([...SYNC].sort());      // no extra handler: every key is a spec operationId
  });
  it('LD-325 (b): T0B-SYNC-1 removed its ids from CORE_PENDING_OPERATIONS, the list is empty', () => {
    expect([...CORE_PENDING_OPERATIONS]).toEqual([]);
  });
  it('checkHandlers(core) passes with health + sync handlers and an EMPTY pending list (what bootstrap does), and also without any pending list', () => {
    const handlers = { ...createHealthHandlers(okChecks()), ...syncHandlers };
    expect(() => checkHandlers('core', spec, handlers, [])).not.toThrow();
    expect(() => checkHandlers('core', spec, handlers)).not.toThrow();
    expect(Object.keys(handlers).sort()).toEqual(OPS.map((o) => o.id).sort());
  });
  it('bootstrap merges the sync handlers into the core handlers it hands to checkHandlers and mountSpec', () => {
    const boot = text('services/api/src/core/bootstrap.ts');
    expect(boot).toMatch(/syncHandlers/);
    expect(boot).toMatch(/checkHandlers\('core',\s*spec,\s*handlers/);
    expect(boot).toMatch(/mountSpec\(app,\s*'core',\s*spec,\s*handlers/);
  });
  it('createSyncHandlers returns the same 7 operations (settings injection point for the limits tests)', () => {
    expect(Object.keys(createSyncHandlers({ settings: {} })).sort()).toEqual([...SYNC].sort());
  });
});

describe('permission + idempotency table (contracts/core.yaml, contracts/permissions.yaml)', () => {
  it.each(SYNC)('%s', (id) => {
    const o = OPS.find((x) => x.id === id)!;
    expect(o.perm).toBe(EXPECT[id]![0]);
    expect(o.idem).toBe(EXPECT[id]![1]);
  });
  it('sync.device.manage is privileged; sync.use is not (admin operations need aal2, device operations do not)', () => {
    const yaml = text('contracts/permissions.yaml');
    const priv = (code: string) => new RegExp(`code: ${code.replace(/\./g, '\\.')},\\s+privileged: (true|false)`).exec(yaml)?.[1];
    expect(priv('sync.device.manage')).toBe('true');
    expect(priv('sync.use')).toBe('false');
  });
});

describe('source scans of the sync code (non-test files)', () => {
  it('the sync code exists and is not empty', () => { expect(SRC.length).toBeGreaterThan(0); });
  it('rows are never deleted: no DELETE statement and no TRUNCATE (lims_app has no DELETE grant either)', () => {
    expect(SRC.filter((f) => /\bDELETE\s+FROM\b|\bTRUNCATE\b/i.test(text(f)))).toEqual([]);
  });
  it('07 §5.1: no log call names a personal or request field (device_label, label, body, email, phone, name)', () => {
    const bad: string[] = [];
    for (const f of SRC) text(f).split('\n').forEach((l, i) => {
      if (/\blog\??\.(info|warn|error|debug)\(/.test(l) && /(device_label|\blabel\b|req\.body|\.body\b|email|phone|full_name|display_name|\bname\b)/.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
    expect(bad).toEqual([]);
  });
  it('error responses never interpolate request values (no template literal inside a LimsError)', () => {
    const bad: string[] = [];
    for (const f of SRC) text(f).split('\n').forEach((l, i) => { if (/new LimsError\(/.test(l) && /\$\{/.test(l)) bad.push(`${f}:${i + 1}`); });
    expect(bad).toEqual([]);
  });
  it('design section 4: only the series lab_code and patient_id exist in the sync code (no bill, invoice or receipt block)', () => {
    expect(SRC.filter((f) => /['"`](bill|invoice|receipt)(_no|_number)?['"`]/.test(text(f)))).toEqual([]);
  });
  it('blocks are carved from the per tenant counters of the online allocators (lab.barcode_counters, frontdesk.number_counters), so a block never overlaps an online number', () => {
    const all = SRC.map(text).join('\n');
    expect(all).toContain('lab.barcode_counters');
    expect(all).toContain('frontdesk.number_counters');
  });
  it('every SQL statement touching core.sync_device or core.number_block names tenant_id (explicit filter next to RLS)', () => {
    const bad: string[] = [];
    for (const f of SRC) {
      const src = text(f);
      for (const m of src.matchAll(/(?:FROM|UPDATE|INTO)\s+core\.(sync_device|number_block)\b[\s\S]{0,400}?(?:`|'|")/g)) if (!/tenant_id/.test(m[0]) && !/INSERT INTO/.test(m[0])) bad.push(`${f}: ${m[0].slice(0, 80).replace(/\s+/g, ' ')}`);
    }
    expect(bad).toEqual([]);
  });
  it('only staff user actors are served: the code refuses every other actor type', () => {
    expect(SRC.map(text).join('\n')).toMatch(/actor[\s\S]{0,80}type[\s\S]{0,40}!==\s*['"]user['"]|['"]user['"][\s\S]{0,80}actor/);
  });
});
