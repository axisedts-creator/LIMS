// T-24 (C3) — Export API: createExport, getExport, downloadExportFile, listExports (#104–#107).
// Spec: 06-PLAN row T-24; 02-TRD §5.2 rows 104–107 + access-log table (:361-366), §8.7, §10 (catalog.export_build enqueued by createExport),
//       05-SCHEMA §7 (exports, files) + §10.1 (purged file -> 404); 03-APP-FLOW export states (only `ready` downloads, else 409 file_not_ready);
//       PRD AC-17.6 (referrer export = privileged catalog.referrer.export + access log); 07-SECURITY S-4 (per-kind permission branches,
//       aal1 on a privileged kind -> auth.mfa_required), REQ-SEC-096/097/100, 08 A13 P-3/P-10/D-20/D-22.
// Interface expected from the writer (SEAM names; mirrors imports.service.ts):
//   catalog/service/exports.service.ts   export function createExportsService(deps: { identity: { assertRole(ctx, { permission }): Promise<void> }; config?: CatalogConfig })
//     ctx = core HandlerContext subset { tenantId, actor:{id}, tx:{query}, now(): ISO string, audit?: { access(entry) } }; all SQL via ctx.tx.query, values bound,
//     every statement binds tenant_id. SQL must fit the dialect documented at the top of helpers/exportsDb.ts.
//     createExport(ctx, { kind, priceListVersionId? })        -> { status: 202, body: Export }
//     getExport(ctx, exportId)                                 -> Export
//     downloadExportFile(ctx, exportId)                        -> { fileName, contentType, bytes }
//     listExports(ctx, { kind?, status?, cursor?, limit? })    -> { data: Export[], page: { limit, next_cursor? } }
//   Export (openapi `Export`): { id, kind, status, file_name?, byte_size?, expires_at?, version } — nothing else leaves the service.
// ASSUMED (spec silent; the writer may not change these tests, only raise a CR):
//   * createExport stores params = { price_list_version_id } for kind price_list ({} otherwise) and enqueues
//     app.enqueue_job('catalog.export_build', { tenant_id, export_id }, job_key = export_id) in the same transaction.
//   * price_list_version_id is required for price_list and rejected for the other kinds (common.validation_failed); a version that is
//     unknown / of another tenant -> common.not_found. Any non-ready status (queued, building, failed, expired) -> 409 file_not_ready.
//   * keyset pagination on id DESC (UUIDv7 = newest first), cursor errors as #98 (common.invalid_cursor).
import { describe, expect, it } from 'vitest';
import { createExportsService } from '../../service/exports.service.js';
import { makeIdentity } from '../helpers/identity.js';
import { makeExportsDb, NOW, TENANT_A, TENANT_B, USER, V7, XLSX_CT } from '../helpers/exportsDb.js';
import { UUIDV7 } from '../helpers/catalogDb.js';

const T = 20_000;
const PL = V7('0000000d0001');
const PLV3 = V7('0000000d0003');
const PLV3_B = V7('0000000d00b3');
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const ALL = ['catalog.test.read', 'catalog.test.manage', 'catalog.price_list.manage', 'catalog.referrer.export'];
const KIND_PERM: Record<string, string> = { price_list: 'catalog.price_list.manage', catalog_master: 'catalog.test.manage', referrers: 'catalog.referrer.export' };
const EXPORT_KEYS = ['id', 'kind', 'status', 'file_name', 'byte_size', 'expires_at', 'version'];
const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);

interface Svc {
  createExport(ctx: unknown, input: Record<string, unknown>): Promise<{ status: number; body: any }>;
  getExport(ctx: unknown, id: string): Promise<any>;
  downloadExportFile(ctx: unknown, id: string): Promise<{ fileName: string; contentType: string; bytes: Uint8Array }>;
  listExports(ctx: unknown, q?: Record<string, unknown>): Promise<{ data: any[]; page: any }>;
}
function setup(o: { grants?: readonly string[]; aal?: 1 | 2 } = {}) {
  const db = makeExportsDb();
  db.seed.rows('price_list_versions',
    { id: PLV3, tenant_id: TENANT_A, price_list_id: PL, version_no: 3, status: 'published' },
    { id: PLV3_B, tenant_id: TENANT_B, price_list_id: V7('0000000d0002'), version_no: 3, status: 'published' });
  const identity = makeIdentity(o.grants ?? ALL, o.aal ?? 2);
  const svc = createExportsService({ identity } as never) as unknown as Svc;
  const accessLog: Array<Record<string, unknown>> = [];
  const audit = { access: async (e: Record<string, unknown>) => { accessLog.push(e); } };
  const run = <R>(fn: (s: Svc, ctx: any) => Promise<R>, tenantId = TENANT_A) => db.run((ctx) => fn(svc, ctx), { tenantId, ctx: { audit } });
  return { db, identity, svc, run, accessLog };
}
type S = ReturnType<typeof setup>;
const errOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as any);
const expectErr = async (p: Promise<unknown>, code: string, detail?: string) => {
  const e = await errOf(p);
  expect(e, `expected rejection ${code}`).toBeDefined();
  expect(e.code).toBe(code);
  if (detail !== undefined) expect(e.detail).toBe(detail);
  return e;
};
const start = (s: S, kind = 'catalog_master', extra: Record<string, unknown> = {}, tenantId = TENANT_A) =>
  s.run((svc, ctx) => svc.createExport(ctx, { kind, ...extra }), tenantId);
const readyExport = (s: S, kind: string, tenantId = TENANT_A, over: Record<string, unknown> = {}) => {
  const f = s.db.seed.file(tenantId, { content: BYTES, file_name: `${kind}-export.xlsx` });
  const e = s.db.seed.export(tenantId, { kind, status: 'ready', file_id: f.id, expires_at: new Date(Date.parse(NOW) + 30 * 86400_000), ...over });
  return { f, e };
};

describe('createExport (#104)', () => {
  it('catalog_master: 202 Export(queued), exports row + enqueue in one tx', async () => {
    const s = setup();
    const r = await start(s);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ kind: 'catalog_master', status: 'queued', version: 1 });
    expect(r.body.id).toMatch(UUIDV7);
    expect(Object.keys(r.body).every((k) => EXPORT_KEYS.includes(k))).toBe(true);
    const rows = s.db.rows('exports', TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.body.id, tenant_id: TENANT_A, kind: 'catalog_master', status: 'queued', created_by: USER, updated_by: USER, file_id: null });
    expect(s.db.jobs).toHaveLength(1);
    expect(s.db.jobs[0]).toMatchObject({ identifier: 'catalog.export_build', payload: { tenant_id: TENANT_A, export_id: r.body.id }, jobKey: r.body.id });
  }, T);

  it('price_list: params carry price_list_version_id (AC-16.2 export of v3)', async () => {
    const s = setup();
    const r = await start(s, 'price_list', { priceListVersionId: PLV3 });
    expect(r.status).toBe(202);
    expect(s.db.rows('exports', TENANT_A)[0]!.params).toEqual({ price_list_version_id: PLV3 });
    expect(s.db.jobs[0]!.payload).toEqual({ tenant_id: TENANT_A, export_id: r.body.id });
  }, T);

  it('referrers: 202', async () => {
    const s = setup();
    expect((await start(s, 'referrers')).body).toMatchObject({ kind: 'referrers', status: 'queued' });
  }, T);

  it.each(Object.entries(KIND_PERM))('%s asserts exactly %s (P-10)', async (kind, perm) => {
    const s = setup();
    await start(s, kind, kind === 'price_list' ? { priceListVersionId: PLV3 } : {});
    expect(s.identity.calls.map((c) => c.permission)).toEqual([perm]);
  }, T);

  it.each(Object.entries(KIND_PERM))('%s without its permission -> auth.forbidden, nothing written, nothing enqueued', async (kind, perm) => {
    const s = setup({ grants: ALL.filter((g) => g !== perm) });
    await expectErr(start(s, kind, kind === 'price_list' ? { priceListVersionId: PLV3 } : {}), 'auth.forbidden');
    expect(s.db.rows('exports')).toHaveLength(0);
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('privileged kinds at aal1 -> auth.mfa_required; catalog_master is not privileged (D-22) and works at aal1', async () => {
    const s = setup({ aal: 1 });
    await expectErr(start(s, 'price_list', { priceListVersionId: PLV3 }), 'auth.mfa_required');
    await expectErr(start(s, 'referrers'), 'auth.mfa_required');
    expect((await start(s, 'catalog_master')).status).toBe(202);
    expect(s.db.rows('exports')).toHaveLength(1);
  }, T);

  it.each([
    ['unknown kind', { kind: 'credit_parties' }],
    ['kind missing', {}],
    ['price_list without version', { kind: 'price_list' }],
    ['price_list with non-uuid version', { kind: 'price_list', priceListVersionId: 'x' }],
    ['version on catalog_master', { kind: 'catalog_master', priceListVersionId: PLV3 }],
    ['version on referrers', { kind: 'referrers', priceListVersionId: PLV3 }],
  ])('%s -> common.validation_failed', async (_n, input) => {
    const s = setup();
    await expectErr(s.run((svc, ctx) => svc.createExport(ctx, input)), 'common.validation_failed');
    expect(s.db.rows('exports')).toHaveLength(0);
  }, T);

  it('price-list version of another tenant, or unknown -> common.not_found (no leak, nothing written)', async () => {
    const s = setup();
    await expectErr(start(s, 'price_list', { priceListVersionId: PLV3_B }), 'common.not_found');
    await expectErr(start(s, 'price_list', { priceListVersionId: V7('0000000dffff') }), 'common.not_found');
    expect(s.db.rows('exports')).toHaveLength(0);
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('mass assignment: client status / tenant / creator / file are ignored', async () => {
    const s = setup();
    const r = await start(s, 'catalog_master', { status: 'ready', tenant_id: TENANT_B, tenantId: TENANT_B, createdBy: TENANT_B, fileId: V7('0000000dfff1'), version: 9 });
    expect(r.body).toMatchObject({ status: 'queued', version: 1 });
    const row = s.db.rows('exports')[0]!;
    expect(row).toMatchObject({ tenant_id: TENANT_A, status: 'queued', created_by: USER, file_id: null, version: 1 });
    expect(s.db.rows('exports', TENANT_B)).toHaveLength(0);
  }, T);

  it('failed enqueue rolls the exports row back (no orphan queued export)', async () => {
    const s = setup();
    s.db.fail(/enqueue_job/i);
    expect(await errOf(start(s))).toBeDefined();
    expect(s.db.rows('exports')).toHaveLength(0);
  }, T);

  it('two concurrent exports get distinct ids and jobs', async () => {
    const s = setup();
    const [a, b] = await Promise.all([start(s), start(s)]);
    expect(a.body.id).not.toBe(b.body.id);
    expect(s.db.jobs.map((j) => j.jobKey).sort()).toEqual([a.body.id, b.body.id].sort());
  }, T);
});

describe('getExport (#105)', () => {
  it('queued: Export without file fields', async () => {
    const s = setup();
    const e = s.db.seed.export(TENANT_A, { kind: 'catalog_master' });
    const r = await s.run((svc, ctx) => svc.getExport(ctx, e.id));
    expect(r).toMatchObject({ id: e.id, kind: 'catalog_master', status: 'queued', version: 1 });
    expect(r.file_name).toBeUndefined();
  }, T);

  it('ready: file_name, byte_size, expires_at (ISO) from the file row; no content / sha / file_id / params / created_by', async () => {
    const s = setup();
    const { f, e } = readyExport(s, 'catalog_master');
    const r = await s.run((svc, ctx) => svc.getExport(ctx, e.id));
    expect(r).toMatchObject({ id: e.id, status: 'ready', file_name: f.file_name, byte_size: BYTES.length });
    expect(r.expires_at).toMatch(ISO);
    expect(Object.keys(r).every((k) => EXPORT_KEYS.includes(k))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(f.id);
  }, T);

  it.each(Object.entries(KIND_PERM))('%s export needs %s (as #104 for the kind); other kinds do not', async (kind, perm) => {
    const s = setup({ grants: ALL.filter((g) => g !== perm) });
    const e = s.db.seed.export(TENANT_A, { kind });
    await expectErr(s.run((svc, ctx) => svc.getExport(ctx, e.id)), 'auth.forbidden');
  }, T);

  it('referrers export at aal1 -> auth.mfa_required', async () => {
    const s = setup({ aal: 1 });
    const e = s.db.seed.export(TENANT_A, { kind: 'referrers' });
    await expectErr(s.run((svc, ctx) => svc.getExport(ctx, e.id)), 'auth.mfa_required');
  }, T);

  it('tenant B export, unknown id, malformed id -> common.not_found (before any permission check)', async () => {
    const s = setup();
    const b = s.db.seed.export(TENANT_B, { kind: 'catalog_master' });
    for (const id of [b.id, V7('0000000dffff'), 'not-a-uuid', "x' OR '1'='1"]) await expectErr(s.run((svc, ctx) => svc.getExport(ctx, id)), 'common.not_found');
    expect(s.identity.calls).toHaveLength(0);
  }, T);

  it('every statement binds the tenant id', async () => {
    const s = setup();
    const e = s.db.seed.export(TENANT_A, { kind: 'catalog_master' });
    await s.run((svc, ctx) => svc.getExport(ctx, e.id));
    expect(s.db.stmts.length).toBeGreaterThan(0);
    for (const st of s.db.stmts) expect(st.values).toContain(TENANT_A);
  }, T);
});

describe('downloadExportFile (#106)', () => {
  it.each(['price_list', 'catalog_master'])('%s ready: xlsx bytes + one access-log entry {data.export, catalog_file, file id, allowed}', async (kind) => {
    const s = setup();
    const { f, e } = readyExport(s, kind);
    const r = await s.run((svc, ctx) => svc.downloadExportFile(ctx, e.id));
    expect(r.contentType).toBe(XLSX_CT);
    expect(r.fileName).toBe(f.file_name);
    expect(Buffer.from(r.bytes).equals(Buffer.from(BYTES))).toBe(true);
    expect(s.accessLog).toHaveLength(1);
    expect(s.accessLog[0]).toMatchObject({ action: 'data.export', entityType: 'catalog_file', entityId: f.id, outcome: 'allowed' });
  }, T);

  it('referrers (AC-17.6): privileged, entityType referrer_export, entityId = file id', async () => {
    const s = setup();
    const { f, e } = readyExport(s, 'referrers');
    await s.run((svc, ctx) => svc.downloadExportFile(ctx, e.id));
    expect(s.identity.calls.map((c) => c.permission)).toEqual(['catalog.referrer.export']);
    expect(s.accessLog).toHaveLength(1);
    expect(s.accessLog[0]).toMatchObject({ action: 'data.export', entityType: 'referrer_export', entityId: f.id, outcome: 'allowed' });
  }, T);

  it('referrers without catalog.referrer.export -> auth.forbidden, no bytes, no access-log entry', async () => {
    const s = setup({ grants: ALL.filter((g) => g !== 'catalog.referrer.export') });
    const { e } = readyExport(s, 'referrers');
    await expectErr(s.run((svc, ctx) => svc.downloadExportFile(ctx, e.id)), 'auth.forbidden');
    expect(s.accessLog).toHaveLength(0);
  }, T);

  it('referrers / price_list at aal1 -> auth.mfa_required, no access-log entry', async () => {
    const s = setup({ aal: 1 });
    for (const kind of ['referrers', 'price_list']) {
      const { e } = readyExport(s, kind);
      await expectErr(s.run((svc, ctx) => svc.downloadExportFile(ctx, e.id)), 'auth.mfa_required');
    }
    expect(s.accessLog).toHaveLength(0);
  }, T);

  it.each(['queued', 'building', 'failed', 'expired'])('status %s -> 409 common.version_conflict, detail file_not_ready (D-20); no access-log entry', async (status) => {
    const s = setup();
    const e = s.db.seed.export(TENANT_A, { kind: 'catalog_master', status });
    const err = await expectErr(s.run((svc, ctx) => svc.downloadExportFile(ctx, e.id)), 'common.version_conflict', 'file_not_ready');
    expect(err.statusCode).toBe(409);
    expect(s.accessLog).toHaveLength(0);
  }, T);

  it('ready but file purged (file_id NULL, or file row gone) -> 404 common.not_found (05-SCHEMA §10.1), no access-log entry', async () => {
    const s = setup();
    const a = s.db.seed.export(TENANT_A, { kind: 'catalog_master', status: 'ready', file_id: null });
    const b = s.db.seed.export(TENANT_A, { kind: 'catalog_master', status: 'ready', file_id: V7('0000000dfff2') });
    for (const e of [a, b]) await expectErr(s.run((svc, ctx) => svc.downloadExportFile(ctx, e.id)), 'common.not_found');
    expect(s.accessLog).toHaveLength(0);
  }, T);

  it('tenant B export / its file cannot be downloaded by tenant A (404, no access-log entry)', async () => {
    const s = setup();
    const { e } = readyExport(s, 'catalog_master', TENANT_B);
    await expectErr(s.run((svc, ctx) => svc.downloadExportFile(ctx, e.id)), 'common.not_found');
    // own export row pointing at tenant B's file id
    const fb = s.db.seed.file(TENANT_B, { content: BYTES });
    const own = s.db.seed.export(TENANT_A, { kind: 'catalog_master', status: 'ready', file_id: fb.id });
    await expectErr(s.run((svc, ctx) => svc.downloadExportFile(ctx, own.id)), 'common.not_found');
    expect(s.accessLog).toHaveLength(0);
  }, T);

  it('import files are never served through the export download (purpose must be export)', async () => {
    const s = setup();
    const up = s.db.seed.file(TENANT_A, { purpose: 'import_upload', content: BYTES });
    const e = s.db.seed.export(TENANT_A, { kind: 'catalog_master', status: 'ready', file_id: up.id });
    await expectErr(s.run((svc, ctx) => svc.downloadExportFile(ctx, e.id)), 'common.not_found');
    expect(s.accessLog).toHaveLength(0);
  }, T);

  it('malformed id -> 404', async () => {
    const s = setup();
    await expectErr(s.run((svc, ctx) => svc.downloadExportFile(ctx, '../../etc/passwd')), 'common.not_found');
  }, T);
});

describe('listExports (#107)', () => {
  const seed3 = (s: S) => ({
    a: s.db.seed.export(TENANT_A, { kind: 'catalog_master', status: 'ready' }),
    b: s.db.seed.export(TENANT_A, { kind: 'price_list', status: 'queued' }),
    c: s.db.seed.export(TENANT_A, { kind: 'referrers', status: 'failed' }),
  });

  it('newest first; data are Export objects; page.limit echoed', async () => {
    const s = setup();
    const { a, b, c } = seed3(s);
    const r = await s.run((svc, ctx) => svc.listExports(ctx, {}));
    expect(r.data.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(r.page.limit).toBe(50);
    for (const x of r.data) expect(Object.keys(x).every((k) => EXPORT_KEYS.includes(k))).toBe(true);
  }, T);

  it('rows are filtered to the kinds the caller may export', async () => {
    const s = setup({ grants: ['catalog.test.read', 'catalog.test.manage'] });
    const { a } = seed3(s);
    const r = await s.run((svc, ctx) => svc.listExports(ctx, {}));
    expect(r.data.map((x) => x.id)).toEqual([a.id]);
  }, T);

  it('floor only (no kind permission) -> empty list, not an error', async () => {
    const s = setup({ grants: ['catalog.test.read'] });
    seed3(s);
    expect((await s.run((svc, ctx) => svc.listExports(ctx, {}))).data).toEqual([]);
  }, T);

  it('aal1: privileged kinds drop out of the unfiltered list; ?kind=referrers -> auth.mfa_required', async () => {
    const s = setup({ aal: 1 });
    const { a } = seed3(s);
    expect((await s.run((svc, ctx) => svc.listExports(ctx, {}))).data.map((x) => x.id)).toEqual([a.id]);
    await expectErr(s.run((svc, ctx) => svc.listExports(ctx, { kind: 'referrers' })), 'auth.mfa_required');
  }, T);

  it('?kind of a kind the caller may not export -> auth.forbidden', async () => {
    const s = setup({ grants: ['catalog.test.read', 'catalog.test.manage'] });
    await expectErr(s.run((svc, ctx) => svc.listExports(ctx, { kind: 'referrers' })), 'auth.forbidden');
  }, T);

  it('filters kind and status', async () => {
    const s = setup();
    const { b, c } = seed3(s);
    expect((await s.run((svc, ctx) => svc.listExports(ctx, { kind: 'price_list' }))).data.map((x) => x.id)).toEqual([b.id]);
    expect((await s.run((svc, ctx) => svc.listExports(ctx, { status: 'failed' }))).data.map((x) => x.id)).toEqual([c.id]);
    await expectErr(s.run((svc, ctx) => svc.listExports(ctx, { status: 'nope' })), 'common.validation_failed');
    await expectErr(s.run((svc, ctx) => svc.listExports(ctx, { kind: 'credit_parties' })), 'common.validation_failed');
  }, T);

  it('cursor pagination covers every row once; bad cursor / limit rejected', async () => {
    const s = setup();
    const { a, b, c } = seed3(s);
    const p1 = await s.run((svc, ctx) => svc.listExports(ctx, { limit: 2 }));
    expect(p1.data.map((x) => x.id)).toEqual([c.id, b.id]);
    expect(typeof p1.page.next_cursor).toBe('string');
    const p2 = await s.run((svc, ctx) => svc.listExports(ctx, { limit: 2, cursor: p1.page.next_cursor }));
    expect(p2.data.map((x) => x.id)).toEqual([a.id]);
    expect(p2.page.next_cursor).toBeUndefined();
    await expectErr(s.run((svc, ctx) => svc.listExports(ctx, { cursor: '!!!' })), 'common.invalid_cursor');
    for (const limit of [0, 201, -1, 1.5, 'x']) await expectErr(s.run((svc, ctx) => svc.listExports(ctx, { limit })), 'common.validation_failed');
  }, T);

  it('never lists tenant B exports', async () => {
    const s = setup();
    const own = s.db.seed.export(TENANT_A, { kind: 'catalog_master' });
    s.db.seed.export(TENANT_B, { kind: 'catalog_master' });
    expect((await s.run((svc, ctx) => svc.listExports(ctx, {}))).data.map((x) => x.id)).toEqual([own.id]);
    for (const st of s.db.stmts) expect(st.values).toContain(TENANT_A);
  }, T);

  it('listing does not write an access-log entry (only downloads do)', async () => {
    const s = setup();
    seed3(s);
    await s.run((svc, ctx) => svc.listExports(ctx, {}));
    expect(s.accessLog).toHaveLength(0);
  }, T);
});
