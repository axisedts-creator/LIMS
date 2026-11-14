// T-36 (C3) — S-1 / AB-5 cross-tenant probes for the export API (#104–#107), S-10 download headers + access log, S-13 error hygiene, and the CR-C3-008
// "pending.json is empty at M6" gate. All through the REAL handlers map (the exports handlers are still 503 stubs today -> red).
// Spec: 07-SECURITY S-1, S-10, S-13, AB-5; 02-TRD §5.2 rows 104–107 (404 for foreign ids; #106 headers `Content-Disposition: attachment`, `Cache-Control: no-store`,
// `X-Content-Type-Options: nosniff`; access-log row per download), §13; 06 T-36 ("pending.json empty"); LD-70: pending.json is edited by the task writers, never by the tester.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handlers } from '../../handlers/index.js';
import { isLimsError } from '../../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { makeIdentity } from '../helpers/identity.js';
import { makeExportsDb, NOW, TENANT_A, TENANT_B, V7 } from '../helpers/exportsDb.js';

const T = 20_000;
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const GRANTS = ['catalog.test.read', 'catalog.test.manage', 'catalog.price_list.manage', 'catalog.referrer.export'];
const MARK = 'SYNTH-EXPORT-MARKER-5512';
const PL = V7('0000000d0001');
const PLV3 = V7('0000000d0003');
const PLV3_B = V7('0000000d00b3');
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const errOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as any);

function env() {
  const db = makeExportsDb();
  db.seed.rows('price_list_versions',
    { id: PLV3, tenant_id: TENANT_A, price_list_id: PL, version_no: 3, status: 'published' },
    { id: PLV3_B, tenant_id: TENANT_B, price_list_id: V7('0000000d0002'), version_no: 3, status: 'published' });
  const identity = makeIdentity(GRANTS, 2);
  const logs: unknown[] = [];
  const log = { info: (o: unknown) => logs.push(o), warn: (o: unknown) => logs.push(o), error: (o: unknown) => logs.push(o) };
  const accessLog: Array<Record<string, unknown>> = [];
  const audit = { access: async (e: Record<string, unknown>) => { accessLog.push(e); } };
  const call = (op: string, r: ReturnType<typeof req>, tenantId = TENANT_A) =>
    db.run((ctx) => H[op]!(r, { ...ctx, operationId: op, clientIp: '203.0.113.9', log, ports: { IdentityPort: identity } }), { tenantId, ctx: { audit, log } });
  const ready = (tenantId: string, kind: string, over: Record<string, unknown> = {}) => {
    const f = db.seed.file(tenantId, { content: new Uint8Array([0x50, 0x4b, 3, 4, 9]), file_name: `${MARK}.xlsx` });
    return { f, e: db.seed.export(tenantId, { kind, status: 'ready', file_id: f.id, expires_at: new Date(Date.parse(NOW) + 30 * 86400_000), ...over }) };
  };
  return { db, identity, logs, accessLog, call, ready };
}

describe('CR-C3-008 / 06 T-36: probes/pending.json is empty and no operation is a not_implemented stub', () => {
  const pending = JSON.parse(readFileSync(join(import.meta.dirname, 'pending.json'), 'utf8')) as string[];
  it('pending.json is []', () => { expect(pending).toEqual([]); });

  it('every operationId in catalog.yaml has a handler that is not the 503 not_implemented stub', async () => {
    const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
    const ids: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
    expect(ids).toHaveLength(107);
    const stubs: string[] = [];
    for (const id of ids) {
      const h = H[id];
      if (typeof h !== 'function') { stubs.push(`${id} (missing)`); continue; }
      const e = await errOf(h(req(), { operationId: id, clientIp: '203.0.113.7', log: { info() {}, warn() {}, error() {} } }));
      if (e && isLimsError(e, 'common.service_unavailable') && e.detail === 'not_implemented') stubs.push(id);
    }
    expect(stubs).toEqual([]);
  }, T);
});

describe('S-1 / AB-5: another tenant’s export / file / price-list-version ids -> 404 common.not_found, no data, no side effects', () => {
  it.each(['getExport', 'downloadExportFile'])('%s with tenant B’s export id as tenant A -> 404; B’s rows unchanged; no access-log row; marker not echoed', async (op) => {
    const s = env();
    const { e } = s.ready(TENANT_B, 'catalog_master');
    const before = JSON.stringify([s.db.rows('exports'), s.db.rows('files')]);
    const x = await errOf(s.call(op, req({ params: { export_id: e.id } })));
    expect(x && isLimsError(x, 'common.not_found'), String(x?.code)).toBe(true);
    expect(JSON.stringify({ m: x.message, d: x.detail, f: x.errors })).not.toContain(MARK);
    expect(JSON.stringify([s.db.rows('exports'), s.db.rows('files')])).toBe(before);
    expect(s.accessLog).toHaveLength(0);
  }, T);

  it('listExports as tenant A never contains tenant B rows (however filtered)', async () => {
    const s = env();
    s.ready(TENANT_B, 'catalog_master'); s.ready(TENANT_B, 'referrers'); s.ready(TENANT_B, 'price_list');
    const a = s.ready(TENANT_A, 'catalog_master').e;
    for (const q of [{}, { kind: 'catalog_master' }, { kind: 'referrers' }, { status: 'ready' }, { limit: 200 }]) {
      const r = await s.call('listExports', req({ query: q }));
      expect(r.body.data.every((d: any) => d.id === a.id), JSON.stringify(q)).toBe(true);
    }
  }, T);

  it('createExport(price_list) with tenant B’s price_list_version_id -> 404 common.not_found; no exports row, no job', async () => {
    const s = env();
    const x = await errOf(s.call('createExport', req({ headers: { 'idempotency-key': 'k' }, body: { kind: 'price_list', price_list_version_id: PLV3_B } })));
    expect(x && isLimsError(x, 'common.not_found'), String(x?.code)).toBe(true);
    expect(s.db.rows('exports')).toHaveLength(0);
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('the same ids work for their own tenant (control)', async () => {
    const s = env();
    const { e } = s.ready(TENANT_B, 'catalog_master');
    expect((await s.call('getExport', req({ params: { export_id: e.id } }), TENANT_B)).body.id).toBe(e.id);
  }, T);

  it('a malformed id is a validation error, never a 500 and never an SQL error', async () => {
    const s = env();
    for (const op of ['getExport', 'downloadExportFile']) {
      const x = await errOf(s.call(op, req({ params: { export_id: "x'; DROP TABLE catalog.exports;--" } })));
      expect(x && ['common.not_found', 'common.validation_failed'].includes(x.code), `${op}: ${x?.code}`).toBe(true);
    }
  }, T);
});

describe('S-10: #106 download headers and access log', () => {
  it.each(['catalog_master', 'price_list', 'referrers'])('%s: 200, attachment + nosniff + no-store, one access-log row (data.export), bytes unchanged', async (kind) => {
    const s = env();
    const { e, f } = s.ready(TENANT_A, kind);
    const r = await s.call('downloadExportFile', req({ params: { export_id: e.id } }));
    expect(r.status).toBe(200);
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    expect(h['content-disposition']).toMatch(/^attachment/);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['cache-control']).toMatch(/no-store/);
    expect(h['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(Buffer.from(r.body as Uint8Array).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
    expect(s.accessLog).toHaveLength(1);
    expect(s.accessLog[0]).toMatchObject({ action: 'data.export', entityId: f.id, outcome: 'allowed' });
  }, T);

  it.each(['queued', 'building', 'failed', 'expired'])('a %s export -> 409 common.version_conflict / file_not_ready (D-20); no access-log row', async (status) => {
    const s = env();
    const e = s.db.seed.export(TENANT_A, { kind: 'catalog_master', status, file_id: null });
    const x = await errOf(s.call('downloadExportFile', req({ params: { export_id: e.id } })));
    expect(x && isLimsError(x, 'common.version_conflict') && x.detail === 'file_not_ready', String(x?.code)).toBe(true);
    expect(s.accessLog).toHaveLength(0);
  }, T);
});

describe('S-13: nothing from a file name / export row reaches the logs on the error paths', () => {
  it('foreign-id 404, forbidden and file_not_ready paths log no marker text', async () => {
    const s = env();
    const { e } = s.ready(TENANT_B, 'catalog_master');
    await errOf(s.call('getExport', req({ params: { export_id: e.id } })));
    const pending = s.db.seed.export(TENANT_A, { kind: 'catalog_master', status: 'queued', file_id: null });
    await errOf(s.call('downloadExportFile', req({ params: { export_id: pending.id } })));
    expect(JSON.stringify(s.logs)).not.toContain(MARK);
  }, T);
});
