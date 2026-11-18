// T0B-SYNC-2 static probes (no database): done_when (1) every T0C-SYNC-2 operation has a registered handler and the module boot check passes, the pending list is emptied
// (LD-325 b), the permission / idempotency table of the 5 new operations, the closed error code of an operation type without adapter, the metric names, and source scans of the
// engine (07-SECURITY §5: no personal data in logs or errors, rows never deleted, tenant filter next to RLS, pull whitelist).
// Self-contained on purpose: imports no ./helpers.ts (that needs LIMS_TEST_APP_URL). Fails today: createSyncPart2Handlers / syncPart2Handlers do not exist and the pending list holds 5 ids.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkHandlers, loadSpec, REPO_ROOT } from '../../module.js';
import { CORE_PENDING_OPERATIONS } from '../../core-pending.js';
import { createHealthHandlers } from '../../health.js';
import { okChecks } from '../../observability/__tests__/helpers.js';
import { createSyncHandlers, createSyncPart2Handlers, syncHandlers, syncPart2Handlers } from '../index.js';

const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/core.yaml'));
const OPS = Object.entries<any>(spec.paths).flatMap(([path, item]) => ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item?.[m]?.operationId)
  .map((m) => ({ id: item[m].operationId as string, method: m, path, perm: item[m]['x-permission'] as string | undefined, idem: String(item[m]['x-idempotency'] ?? '') })));
const PART2 = ['pushSyncBatch', 'pullChanges', 'listSyncConflicts', 'getSyncConflict', 'resolveSyncConflict'];
const PART1 = ['registerSyncDevice', 'listSyncDevices', 'revokeSyncDevice', 'requestSyncDeviceWipe', 'ackDeviceWipe', 'getSyncStatus', 'reserveNumberBlock'];
const EXPECT: Record<string, [string, string]> = {   // operationId -> [x-permission, x-idempotency]
  pushSyncBatch: ['sync.use', 'none'], pullChanges: ['sync.use', 'none'], listSyncConflicts: ['sync.conflict.resolve', 'none'],
  getSyncConflict: ['sync.conflict.resolve', 'none'], resolveSyncConflict: ['sync.conflict.resolve', 'required'],
};
const DIR = 'services/api/src/core/sync';
const walk = (dir: string): string[] => readdirSync(join(REPO_ROOT, dir)).flatMap((f) => {
  const rel = `${dir}/${f}`; return statSync(join(REPO_ROOT, rel)).isDirectory() ? (f === '__tests__' ? [] : walk(rel)) : [rel];
});
const SRC = walk(DIR).filter((f) => f.endsWith('.ts'));

describe('T0B-SYNC-2 done_when (1): every operation of the contract has a registered handler and the boot check passes', () => {
  it('the 5 part 2 operations are in the spec and each has a function in syncPart2Handlers; no extra key', () => {
    for (const id of PART2) { expect(OPS.map((o) => o.id), id).toContain(id); expect(typeof (syncPart2Handlers as any)[id], id).toBe('function'); }
    expect(Object.keys(syncPart2Handlers).sort()).toEqual([...PART2].sort());
  });
  it('part 1 stays exactly the 7 operations of T0B-SYNC-1 (syncHandlers / createSyncHandlers unchanged)', () => {
    expect(Object.keys(syncHandlers).sort()).toEqual([...PART1].sort());
    expect(Object.keys(createSyncHandlers({ settings: {} })).sort()).toEqual([...PART1].sort());
  });
  it('LD-325 (b): T0B-SYNC-2 removed its 5 ids from CORE_PENDING_OPERATIONS, the list is empty', () => {
    expect([...CORE_PENDING_OPERATIONS]).toEqual([]);
  });
  it('checkHandlers(core) passes with health + part 1 + part 2 handlers and an EMPTY pending list, and also without any pending list', () => {
    const handlers = { ...createHealthHandlers(okChecks()), ...syncHandlers, ...syncPart2Handlers };
    expect(() => checkHandlers('core', spec, handlers, [])).not.toThrow();
    expect(() => checkHandlers('core', spec, handlers)).not.toThrow();
    expect(Object.keys(handlers).sort()).toEqual(OPS.map((o) => o.id).sort());
  });
  it('bootstrap merges the part 2 handlers into the core handlers it hands to checkHandlers and mountSpec', () => {
    const boot = text('services/api/src/core/bootstrap.ts');
    expect(boot).toMatch(/syncPart2Handlers/);
    expect(boot).toMatch(/checkHandlers\('core',\s*spec,\s*handlers/);
    expect(boot).toMatch(/mountSpec\(app,\s*'core',\s*spec,\s*handlers/);
  });
  it('createSyncPart2Handlers returns the same 5 operations (settings and adapters injection point for the tests)', () => {
    expect(Object.keys(createSyncPart2Handlers({ settings: {}, adapters: [] })).sort()).toEqual([...PART2].sort());
    expect(Object.keys(createSyncPart2Handlers()).sort()).toEqual([...PART2].sort());
  });
});

describe('permission + idempotency table (contracts/core.yaml, contracts/permissions.yaml)', () => {
  it.each(PART2)('%s', (id) => {
    const o = OPS.find((x) => x.id === id)!;
    expect(o.perm).toBe(EXPECT[id]![0]);
    expect(o.idem).toBe(EXPECT[id]![1]);
  });
  it('sync.conflict.resolve exists in permissions.yaml', () => { expect(text('contracts/permissions.yaml')).toMatch(/code: sync\.conflict\.resolve\b/); });
});

describe('closed error code of an operation type without an adapter (done_when 1) and the metric names (done_when 7)', () => {
  const errors: Array<{ code: string; http: number; owner: string; title: string; meaning: string }> = parse(text('contracts/errors.yaml'));
  it('sync.op_type_not_available is registered in contracts/errors.yaml (owner C0, 422) with no personal data in title or meaning', () => {
    const e = errors.find((x) => x.code === 'sync.op_type_not_available');
    expect(e, 'add it to contracts/errors.yaml (and regenerate the clients): the brief names it and the engine must answer it per operation').toBeDefined();
    expect(e!.owner).toBe('C0'); expect(e!.http).toBe(422);
    expect(`${e!.title} ${e!.meaning}`).not.toMatch(/\{|\$|@/);
  });
  it('it is a member of the closed SyncErrorCode enum of the push result, so the response validates', () => {
    expect(spec.components.schemas.SyncErrorCode.enum).toContain('sync.op_type_not_available');
  });
  it('every code of SyncErrorCode is registered (the engine only ever answers registered codes)', () => {
    const reg = new Set(errors.map((e) => e.code));
    for (const c of spec.components.schemas.SyncErrorCode.enum as string[]) expect(reg.has(c), c).toBe(true);
  });
  it('the sync metrics exist in observability/metrics.ts with bounded labels (no id or personal label)', () => {
    const m = text('services/api/src/core/observability/metrics.ts');
    expect(m).toMatch(/lims_core_sync_operations_total:\s*\['counter',\s*\['status'\]/);
    expect(m).toMatch(/lims_core_sync_batches_total:\s*\['counter',\s*\['outcome'\]/);
    expect(m).toMatch(/lims_core_sync_oldest_unsynced_age_seconds:\s*\['gauge',\s*\['tenant_id'\]/);
  });
});

describe('source scans of the engine (non-test files)', () => {
  it('the sync code exists and is not empty', () => { expect(SRC.length).toBeGreaterThan(0); });
  it('rows are never deleted: no DELETE statement and no TRUNCATE (lims_app has no DELETE grant either)', () => {
    expect(SRC.filter((f) => /\bDELETE\s+FROM\b|\bTRUNCATE\b/i.test(text(f)))).toEqual([]);
  });
  it('07 §5.1: no log call names the payload, body or a personal field', () => {
    const bad: string[] = [];
    for (const f of SRC) text(f).split('\n').forEach((l, i) => {
      if (/\blog\??\.(info|warn|error|debug)\(/.test(l) && /(payload|local_payload|server_payload|merged_payload|document|req\.body|\.body\b|email|phone|full_name|display_name|\bname\b|device_label)/.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
    expect(bad).toEqual([]);
  });
  it('error responses never interpolate request values (no template literal inside a LimsError)', () => {
    const bad: string[] = [];
    for (const f of SRC) text(f).split('\n').forEach((l, i) => { if (/new LimsError\(/.test(l) && /\$\{/.test(l)) bad.push(`${f}:${i + 1}`); });
    expect(bad).toEqual([]);
  });
  it('every SQL statement touching core.sync_operation or core.sync_conflict names tenant_id (explicit filter next to RLS)', () => {
    const bad: string[] = [];
    for (const f of SRC) {
      const src = text(f);
      for (const m of src.matchAll(/(?:FROM|UPDATE|INTO|JOIN)\s+core\.(sync_operation|sync_conflict)\b[\s\S]{0,500}?(?:`|'|")/g)) if (!/tenant_id/.test(m[0]) && !/INSERT INTO/.test(m[0])) bad.push(`${f}: ${m[0].slice(0, 80).replace(/\s+/g, ' ')}`);
    }
    expect(bad).toEqual([]);
  });
  it('one transaction per operation: the engine runs each operation through ctx.db.tx (SAVEPOINT) and takes one advisory lock per device with the non waiting try variant', () => {
    const all = SRC.map(text).join('\n');
    expect(all).toMatch(/db\??\.tx\??\./);
    expect(all).toMatch(/pg_try_advisory_xact_lock/);
    expect(all).not.toMatch(/pg_advisory_xact_lock\s*\(/);        // a waiting lock would queue 200 devices behind each other
  });
  it('the pull whitelist is the SyncEntityType enum of the contract and nothing else (never users, credentials, roles)', () => {
    const all = SRC.map(text).join('\n');
    for (const t of spec.components.schemas.SyncEntityType.enum as string[]) expect(all, t).toContain(t);
    expect(all).not.toMatch(/FROM\s+core\.(users|memberships|credentials|sessions|refresh_tokens|roles)\b/i);
    expect(all).not.toMatch(/FROM\s+identity\./i);
  });
  it('the pull never interpolates a request value into SQL: no template literal with ${entity_type|cursor|limit} next to FROM', () => {
    const bad: string[] = [];
    for (const f of SRC) text(f).split('\n').forEach((l, i) => { if (/\bFROM\b/i.test(l) && /\$\{\s*(req|body|b|q|entity|entityType|cursor|c)\b/.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`); });
    expect(bad).toEqual([]);
  });
  it('the engine reads the time from ctx.now() (the transaction start), never Date.now() / new Date() for server_received_at or the limits', () => {
    const bad: string[] = [];
    for (const f of SRC) text(f).split('\n').forEach((l, i) => { if (/\bDate\.now\(\)|new Date\(\)/.test(l) && !/^\s*\/\//.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`); });
    expect(bad).toEqual([]);
  });
  it('a plain Error thrown by an adapter is never rendered: the engine maps it to common.internal (no error.message in a result)', () => {
    const all = SRC.map(text).join('\n');
    expect(all).toContain('common.internal');
    expect(all).not.toMatch(/error_code:\s*(e|err|error)\.message/);
  });
});
