// T-20 (C3) — Import API: template download, createImport, list/get/issues/report/discard (#96–#101, #103).
// Spec: 06-PLAN row T-20; 02-TRD §5.2 rows 96–103, §8.1 (createImport flow), §8.2 (templates), §10 / 05-SCHEMA §7 (files, imports, import_issues),
//       03-APP-FLOW §2.2 (state machine) + §4 guard table; PRD AC-16.1, AC-16.3, AC-16.8, AC-16.9 (API part), AC-16.11;
//       07-SECURITY REQ-SEC-087, 100, S-4 (permission branches), S-9 (no <f> in templates), 08 R12b / A13 P-10.
// Interface expected from the writer (names marked SEAM are not fixed by the spec; see .orchestra/notes/T-20-tests.md):
//   catalog/service/imports.service.ts   export function createImportsService(deps: { identity: { assertRole(ctx, { permission }): Promise<void> }; config?: CatalogConfig })   (SEAM)
//     ctx = core HandlerContext subset { tenantId, actor:{id}, requestId, tx:{query}, now(): ISO string, log? } (as in T-03); all SQL via ctx.tx.query, values bound.
//     downloadTemplate(ctx, kind)                    -> { fileName, contentType, bytes }
//     createImport(ctx, { kind, targetPriceListId?, file: { filename, mimeType, bytes } }) -> { status: 201 | 200, body: Import }   (200 = deduplicated: true)
//     listImports(ctx, { kind?, status?, cursor?, limit? })                 -> { data: Import[], page: { limit, next_cursor? } }
//     getImport(ctx, importId)                       -> Import
//     listImportIssues(ctx, importId, { severity?, cursor?, limit? })        -> { data: ImportIssue[], page }
//     downloadImportReport(ctx, importId)            -> { fileName, contentType, bytes }
//     discardImport(ctx, importId)                   -> Import
//   The per-kind permission (P-10) is asserted inside these methods through deps.identity.assertRole(ctx, { permission });
//   the handlers (handlers/<operationId>.ts) only translate HTTP <-> these calls. Row-based methods assert AFTER the row is loaded (tenant-scoped).
//   All SQL must fit the dialect of helpers/importsDb.ts (documented at its top). Fake DB: real tx/lock semantics, 05-SCHEMA constraints.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createImportsService } from '../../service/imports.service.js';
import { makeIdentity } from '../helpers/identity.js';
import { makeImportsDb, NOW, TENANT_A, TENANT_B, USER, V7 } from '../helpers/importsDb.js';
import { UUIDV7 } from '../helpers/catalogDb.js';
import { fakeXlsx, makeZip, readZip } from '../helpers/zip.js';

const T = 20_000;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PL = V7('0000000d0001');
const PL_B = V7('0000000d0002');
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const SECONDS = (s: number) => new Date(Date.parse(NOW) + s * 1000).toISOString();
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ALL = ['catalog.test.read', 'catalog.test.manage', 'catalog.price_list.read', 'catalog.price_list.manage', 'catalog.referrer.manage', 'catalog.referrer.read'];
const IMPORT_KEYS = ['id', 'kind', 'target_price_list_id', 'base_version_no', 'status', 'file_name', 'file_sha256', 'summary', 'deduplicated', 'result_price_list_version_id', 'expires_at', 'created_at', 'created_by', 'version'];
const KIND_PERM: Record<string, string> = { price_list: 'catalog.price_list.manage', credit_parties: 'catalog.price_list.manage', catalog_master: 'catalog.test.manage', referrers: 'catalog.referrer.manage' };

interface Svc {
  downloadTemplate(ctx: unknown, kind: string): Promise<{ fileName: string; contentType: string; bytes: Uint8Array }>;
  createImport(ctx: unknown, input: Record<string, unknown>): Promise<{ status: number; body: any }>;
  listImports(ctx: unknown, q: Record<string, unknown>): Promise<{ data: any[]; page: any }>;
  getImport(ctx: unknown, id: string): Promise<any>;
  listImportIssues(ctx: unknown, id: string, q: Record<string, unknown>): Promise<{ data: any[]; page: any }>;
  downloadImportReport(ctx: unknown, id: string): Promise<{ fileName: string; contentType: string; bytes: Uint8Array }>;
  discardImport(ctx: unknown, id: string): Promise<any>;
}
function setup(o: { grants?: readonly string[]; aal?: 1 | 2 } = {}) {
  const db = makeImportsDb();
  db.seed.priceList(TENANT_A, PL);
  db.seed.priceList(TENANT_B, PL_B);
  const identity = makeIdentity(o.grants ?? ALL, o.aal ?? 2);
  const svc = createImportsService({ identity } as never) as unknown as Svc;
  const accessLog: Array<Record<string, unknown>> = [];                       // fake ctx.audit.access (02-TRD §5.2 access-log table, :366)
  const audit = { access: async (e: Record<string, unknown>) => { accessLog.push(e); } };
  const run = <R>(fn: (s: Svc, ctx: any) => Promise<R>, tenantId = TENANT_A) => db.run((ctx) => fn(svc, ctx), { tenantId, ctx: { audit } });
  return { db, identity, svc, run, accessLog };
}
type S = ReturnType<typeof setup>;
const fileOf = (bytes: Uint8Array = fakeXlsx('a'), filename = 'prices.xlsx', mimeType = XLSX) => ({ filename, mimeType, bytes });
const up = (s: S, over: Record<string, unknown> = {}, tenantId = TENANT_A) =>
  s.run((svc, ctx) => svc.createImport(ctx, { kind: 'price_list', targetPriceListId: PL, file: fileOf(), ...over }), tenantId);
const errOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as any);
const expectErr = async (p: Promise<unknown>, code: string, detail?: string) => {
  const e = await errOf(p);
  expect(e, `expected rejection ${code}`).toBeDefined();
  expect(e.code).toBe(code);
  if (detail !== undefined) expect(e.detail).toBe(detail);
  return e;
};
const noWrites = (s: S) => expect(s.db.writes().map((w) => w.text)).toEqual([]);

describe('AC-16.3 createImport: file + import row + validate job', () => {
  it('201 Import in state uploaded, shaped like the Import schema, without internal columns', async () => {
    const s = setup();
    const bytes = fakeXlsx('happy');
    const r = await up(s, { file: fileOf(bytes) });
    expect(r.status).toBe(201);
    const b = r.body;
    expect(b.id).toMatch(UUIDV7);
    expect(b).toMatchObject({ kind: 'price_list', target_price_list_id: PL, status: 'uploaded', file_name: 'prices.xlsx', file_sha256: sha(bytes), version: 1, created_by: USER });
    expect(b.deduplicated === true).toBe(false);
    expect(Object.keys(b).every((k) => IMPORT_KEYS.includes(k)), `unexpected keys: ${Object.keys(b)}`).toBe(true);
    for (const k of ['id', 'kind', 'status', 'file_name', 'file_sha256', 'summary', 'expires_at', 'created_at', 'created_by', 'version']) expect(b, k).toHaveProperty(k);
    expect(b.expires_at).toMatch(ISO);
    expect(b.created_at).toMatch(ISO);
    expect(Date.parse(b.expires_at)).toBeGreaterThan(Date.parse(NOW));
    for (const k of ['rows', 'added', 'changed', 'removed', 'unchanged', 'errors', 'warnings']) expect(typeof b.summary[k], `summary.${k}`).toBe('number');
  }, T);

  it('stores the bytes in catalog.files (import_upload) with expires_at = created_at + 168 h + 30 d', async () => {
    const s = setup();
    const bytes = fakeXlsx('stored');
    const r = await up(s, { file: fileOf(bytes) });
    const files = s.db.rows('files');
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f).toMatchObject({ tenant_id: TENANT_A, purpose: 'import_upload', file_name: 'prices.xlsx', content_type: XLSX, byte_size: bytes.length, sha256: sha(bytes), created_by: USER });
    expect(f.id).toMatch(UUIDV7);
    expect(Buffer.compare(f.content, Buffer.from(bytes))).toBe(0);           // stored verbatim, never re-encoded
    expect((f.expires_at as Date).toISOString()).toBe(SECONDS((168 * 3600) + 30 * 86400));
    const row = s.db.rows('imports')[0]!;
    expect(row).toMatchObject({ id: r.body.id, tenant_id: TENANT_A, kind: 'price_list', target_price_list_id: PL, status: 'uploaded', file_sha256: sha(bytes), created_by: USER, updated_by: USER, version: 1 });
    expect(row.upload_file_id).toBe(f.id);
  }, T);

  it('enqueues catalog.import_validate (job_key = import id, payload {tenant_id, import_id} only) in the SAME transaction, after both inserts', async () => {
    const s = setup();
    const r = await up(s);
    expect(s.db.jobs).toHaveLength(1);
    const j = s.db.jobs[0]!;
    expect(j.identifier).toBe('catalog.import_validate');
    expect(j.jobKey).toBe(r.body.id);
    expect(j.payload).toEqual({ tenant_id: TENANT_A, import_id: r.body.id });   // no file name, bytes or other data in the payload
    const tx = s.db.writes().filter((w) => w.txId === j.txId).map((w) => w.text);
    const iFile = tx.findIndex((t) => /INSERT INTO catalog\.files/i.test(t));
    const iImp = tx.findIndex((t) => /INSERT INTO catalog\.imports/i.test(t));
    const iJob = tx.findIndex((t) => /enqueue_job/i.test(t));
    expect(iFile).toBeGreaterThanOrEqual(0);
    expect(iImp).toBeGreaterThanOrEqual(0);
    expect(iJob).toBeGreaterThan(Math.max(iFile, iImp));
  }, T);

  it('is atomic: a failing enqueue leaves no file, no import, no job; a failing import insert leaves no file and no job', async () => {
    const a = setup();
    a.db.fail(/enqueue_job/i);
    await expect(up(a)).rejects.toThrow();
    expect(a.db.allRows('files')).toHaveLength(0);
    expect(a.db.allRows('imports')).toHaveLength(0);
    expect(a.db.jobs).toHaveLength(0);

    const b = setup();
    b.db.fail(/INSERT INTO catalog\.imports/i);
    await expect(up(b)).rejects.toThrow();
    expect(b.db.allRows('files')).toHaveLength(0);
    expect(b.db.jobs).toHaveLength(0);
  }, T);

  it.each([
    ['price_list', { targetPriceListId: PL }],
    ['credit_parties', {}],
    ['catalog_master', {}],
    ['referrers', {}],
  ])('kind %s: accepted with its permission, one import, one job', async (kind, extra) => {
    const s = setup();
    const r = await up(s, { kind, targetPriceListId: undefined, ...extra, file: fileOf(fakeXlsx(`k-${kind}`)) });
    expect(r.status).toBe(201);
    expect(r.body.kind).toBe(kind);
    expect(s.db.jobs).toHaveLength(1);
  }, T);

  it('input validation: price_list needs a target; other kinds must not have one; unknown kind; unknown or foreign target -> nothing written', async () => {
    const s = setup();
    await expectErr(up(s, { targetPriceListId: undefined }), 'common.validation_failed');
    await expectErr(up(s, { kind: 'referrers', targetPriceListId: PL }), 'common.validation_failed');
    await expectErr(up(s, { kind: 'bogus', targetPriceListId: undefined }), 'common.validation_failed');
    await expectErr(up(s, { targetPriceListId: V7('0000000dffff') }), 'common.not_found');
    await expectErr(up(s, { targetPriceListId: PL_B }), 'common.not_found');         // tenant B's price list
    noWrites(s);
  }, T);

  it('ignores client-supplied status/tenant/creator fields (mass assignment)', async () => {
    const s = setup();
    const r = await up(s, { status: 'validated', tenantId: TENANT_B, tenant_id: TENANT_B, createdBy: V7('00000000dead'), created_by: V7('00000000dead'), version: 9, id: V7('00000000beef') });
    expect(r.body).toMatchObject({ status: 'uploaded', created_by: USER, version: 1 });
    expect(r.body.id).not.toBe(V7('00000000beef'));
    expect(s.db.rows('imports', TENANT_B)).toHaveLength(0);
  }, T);

  it('sanitises the stored file name (no path parts, no control characters, <= 200 chars)', async () => {
    const s = setup();
    const r = await up(s, { file: fileOf(fakeXlsx('n1'), '..\\..\\etc/passwd\u0000\n.xlsx') });
    expect(r.body.file_name).not.toMatch(/[\\/\u0000-\u001f]/);
    expect(r.body.file_name.endsWith('.xlsx')).toBe(true);
    const long = await up(s, { file: fileOf(fakeXlsx('n2'), `${'a'.repeat(300)}.xlsx`) });
    expect(long.body.file_name.length).toBeLessThanOrEqual(200);
    expect(s.db.rows('files').every((f) => f.file_name.length >= 1 && f.file_name.length <= 200)).toBe(true);
  }, T);
});

describe('AC-16.9 (API part) 413 / 415 before anything is written; archive contents are not inspected here', () => {
  const MAX = 15728640;
  const withHeader = (n: number) => { const b = new Uint8Array(n); b.set([0x50, 0x4b, 0x03, 0x04]); return b; };

  it('413 common.payload_too_large for 15 MB + 1 byte; exactly 15 MB is accepted', async () => {
    const s = setup();
    await expectErr(up(s, { file: fileOf(withHeader(MAX + 1)) }), 'common.payload_too_large');
    noWrites(s);
    const ok = await up(s, { file: fileOf(withHeader(MAX)) });
    expect(ok.status).toBe(201);
    expect(s.db.rows('files')[0]!.byte_size).toBe(MAX);
  }, 60_000);

  it.each([
    ['not a ZIP (PDF magic)', fileOf(new TextEncoder().encode('%PDF-1.7 synthetic'), 'prices.xlsx')],
    ['plain text renamed .xlsx', fileOf(new TextEncoder().encode('code,price\nT1,10\n'), 'prices.xlsx')],
    ['empty-archive record PK\\5\\6, not a local header', fileOf(new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'prices.xlsx')],
    ['empty file', fileOf(new Uint8Array(0), 'prices.xlsx')],
    ['.xls extension', fileOf(fakeXlsx('x1'), 'prices.xls')],
    ['.xlsm extension', fileOf(fakeXlsx('x2'), 'prices.xlsm')],
    ['.csv extension', fileOf(fakeXlsx('x3'), 'prices.csv')],
    ['no extension', fileOf(fakeXlsx('x4'), 'prices')],
    ['double extension .xlsx.exe', fileOf(fakeXlsx('x5'), 'prices.xlsx.exe')],
    ['declared type application/pdf', fileOf(fakeXlsx('x6'), 'prices.xlsx', 'application/pdf')],
    ['declared type text/csv', fileOf(fakeXlsx('x7'), 'prices.xlsx', 'text/csv')],
  ])('415 common.unsupported_media_type: %s', async (_name, file) => {
    const s = setup();
    await expectErr(up(s, { file }), 'common.unsupported_media_type');
    noWrites(s);
  }, T);

  it('accepts an upper-case .XLSX extension', async () => {
    const s = setup();
    expect((await up(s, { file: fileOf(fakeXlsx('up'), 'PRICES.XLSX') })).status).toBe(201);
  }, T);

  it('does NOT open the archive: macro, external-link, 201-entry and bomb-shaped ZIPs are accepted as uploaded (the worker marks them invalid, T-21/T-22)', async () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`xl/media/f${i}.bin`, 'x']));
    const crafted: Array<[string, Uint8Array]> = [
      ['vba', fakeXlsx('vba', { 'xl/vbaProject.bin': 'MACRO' })],
      ['extlink', fakeXlsx('ext', { 'xl/externalLinks/externalLink1.xml': '<externalLink/>' })],
      ['entries', makeZip(many)],
      ['traversal', fakeXlsx('dots', { '../evil.xml': 'x' })],
    ];
    for (const [tag, bytes] of crafted) {
      const s = setup();                                    // fresh tenant state: the 2-active limit is not under test here
      const r = await up(s, { file: fileOf(bytes) });
      expect(r.status, tag).toBe(201);
      expect(r.body.status, tag).toBe('uploaded');
      expect(s.db.jobs, tag).toHaveLength(1);
    }
  }, T);

  it('REQ-SEC-087: imports.service.ts never imports a spreadsheet/zip library or the worker xlsx wrappers', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'service', 'imports.service.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"](?:write-excel-file|read-excel-file|exceljs|xlsx|sheetjs|jszip|fflate|adm-zip|yauzl|unzipper|node-stream-zip|zip\.js)\b/);
    expect(src).not.toMatch(/wrk\/xlsx|worker\/src\/xlsx|XlsxReader|ZipInspector/);
  });
});

describe('AC-16.8 dedupe on (tenant, kind, target, sha256)', () => {
  it('same bytes again -> 200, deduplicated: true, same import; no second file, import or job', async () => {
    const s = setup();
    const first = await up(s);
    const again = await up(s, { file: fileOf(fakeXlsx('a'), 'renamed-copy.xlsx') });      // key is the hash, not the name
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.id).toBe(first.body.id);
    expect(s.db.rows('imports')).toHaveLength(1);
    expect(s.db.rows('files')).toHaveLength(1);
    expect(s.db.jobs).toHaveLength(1);
  }, T);

  it.each(['uploaded', 'scanning', 'validating', 'validated', 'committing', 'committed'])('existing import in state %s is returned', async (status) => {
    const s = setup();
    const bytes = fakeXlsx(`dd-${status}`);
    const seeded = s.db.seed.import(TENANT_A, { kind: 'price_list', target_price_list_id: PL, file_sha256: sha(bytes), status });
    const r = await up(s, { file: fileOf(bytes) });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(seeded.id);
    expect(r.body.deduplicated).toBe(true);
    noWrites(s);
  }, T);

  it.each(['invalid', 'quarantined', 'commit_failed', 'discarded', 'expired', 'failed'])('existing import in state %s is NOT reused -> a new import', async (status) => {
    const s = setup();
    const bytes = fakeXlsx(`nd-${status}`);
    const seeded = s.db.seed.import(TENANT_A, { kind: 'price_list', target_price_list_id: PL, file_sha256: sha(bytes), status });
    const r = await up(s, { file: fileOf(bytes) });
    expect(r.status).toBe(201);
    expect(r.body.id).not.toBe(seeded.id);
    expect(s.db.jobs).toHaveLength(1);
  }, T);

  it('an import past its expires_at is not reused even if its status is still validated', async () => {
    const s = setup();
    const bytes = fakeXlsx('old');
    const seeded = s.db.seed.import(TENANT_A, { kind: 'price_list', target_price_list_id: PL, file_sha256: sha(bytes), status: 'validated', expires_at: SECONDS(-60) });
    const r = await up(s, { file: fileOf(bytes) });
    expect(r.status).toBe(201);
    expect(r.body.id).not.toBe(seeded.id);
  }, T);

  it('the key includes kind, target and tenant: different kind / other price list / other tenant -> new import, never another tenant’s', async () => {
    const s = setup();
    const bytes = fakeXlsx('shared');
    const PL2 = s.db.seed.priceList(TENANT_A, V7('0000000d0003'));
    s.db.seed.priceList(TENANT_B, V7('0000000d0004'));
    // the matching import is 'validated' (not active), so the 2-active limit does not interfere
    const base = s.db.seed.import(TENANT_A, { kind: 'price_list', target_price_list_id: PL, file_sha256: sha(bytes), status: 'validated' });
    const baseB = s.db.seed.import(TENANT_B, { kind: 'price_list', target_price_list_id: PL_B, file_sha256: sha(bytes), status: 'validated' });
    const otherTarget = await up(s, { targetPriceListId: PL2, file: fileOf(bytes) });
    const otherKind = await up(s, { kind: 'credit_parties', targetPriceListId: undefined, file: fileOf(bytes) });
    expect([otherTarget.status, otherKind.status]).toEqual([201, 201]);
    expect([otherTarget.body.id, otherKind.body.id]).not.toContain(base.id);
    // tenant B uploading the same bytes for its own list gets B's own existing import, never A's
    const again = await up(s, { targetPriceListId: PL_B, file: fileOf(bytes) }, TENANT_B);
    expect(again.body.id).toBe(baseB.id);
    expect(again.body.id).not.toBe(base.id);
  }, T);

  it('tenant A uploading bytes that only tenant B has gets a NEW import in A; B’s rows are untouched', async () => {
    const s = setup();
    const onlyB = fakeXlsx('only-b');
    const b = s.db.seed.import(TENANT_B, { kind: 'price_list', target_price_list_id: PL_B, file_sha256: sha(onlyB), status: 'validated' });
    const a = await up(s, { file: fileOf(onlyB) });
    expect(a.status).toBe(201);
    expect(a.body.id).not.toBe(b.id);
    expect(s.db.rows('imports', TENANT_B)).toHaveLength(1);
    expect(s.db.rows('files', TENANT_B)).toHaveLength(0);
  }, T);

  it('a caller without the kind permission gets 403, not a dedupe hit (existence is not revealed)', async () => {
    const s = setup({ grants: ['catalog.test.read'] });
    const bytes = fakeXlsx('hidden');
    s.db.seed.import(TENANT_A, { kind: 'price_list', target_price_list_id: PL, file_sha256: sha(bytes) });
    await expectErr(up(s, { file: fileOf(bytes) }), 'auth.forbidden');
  }, T);

  it('E5: two identical uploads racing (double click) -> exactly one 201 and one 200, one import, one job', async () => {
    const s = setup();
    const bytes = fakeXlsx('race');
    const out = await Promise.all([up(s, { file: fileOf(bytes) }), up(s, { file: fileOf(bytes) })]);
    expect(out.map((o) => o.status).sort()).toEqual([200, 201]);
    expect(out[0]!.body.id).toBe(out[1]!.body.id);
    expect(s.db.rows('imports')).toHaveLength(1);
    expect(s.db.rows('files')).toHaveLength(1);
    expect(s.db.jobs).toHaveLength(1);
  }, T);
});

describe('REQ-SEC-100 / 02-TRD §5.1: at most 2 active imports per tenant -> 429 common.rate_limited, Retry-After 30', () => {
  const active = ['uploaded', 'scanning', 'validating', 'committing'];
  const idle = ['validated', 'invalid', 'quarantined', 'committed', 'commit_failed', 'discarded', 'expired', 'failed'];

  it('two uploads are fine; the third (different bytes) is 429 with retryAfterSeconds 30 and writes nothing', async () => {
    const s = setup();
    await up(s, { file: fileOf(fakeXlsx('l1')) });
    await up(s, { file: fileOf(fakeXlsx('l2')) });
    const before = s.db.writes().length;
    const e = await expectErr(up(s, { file: fileOf(fakeXlsx('l3')) }), 'common.rate_limited');
    expect(e.retryAfterSeconds).toBe(30);
    expect(s.db.writes().length).toBe(before);
    expect(s.db.jobs).toHaveLength(2);
  }, T);

  it.each(active)('an existing %s import counts toward the limit (any kind)', async (status) => {
    const s = setup();
    s.db.seed.import(TENANT_A, { kind: 'referrers', status });
    s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'uploaded' });
    await expectErr(up(s, { file: fileOf(fakeXlsx(`c-${status}`)) }), 'common.rate_limited');
  }, T);

  it.each(idle)('an import in state %s does not count', async (status) => {
    const s = setup();
    s.db.seed.import(TENANT_A, { status });
    s.db.seed.import(TENANT_A, { status });
    s.db.seed.import(TENANT_A, { status: 'uploaded' });
    expect((await up(s, { file: fileOf(fakeXlsx(`i-${status}`)) })).status).toBe(201);
  }, T);

  it('the limit is per tenant: tenant B’s active imports do not block tenant A', async () => {
    const s = setup();
    s.db.seed.import(TENANT_B, { status: 'uploaded' });
    s.db.seed.import(TENANT_B, { status: 'validating' });
    expect((await up(s)).status).toBe(201);
  }, T);

  it('uploading the same bytes as an active import is a dedupe (200), not a 429, even at the limit (double-click safety)', async () => {
    const s = setup();
    const bytes = fakeXlsx('dup-at-limit');
    const a = s.db.seed.import(TENANT_A, { kind: 'price_list', target_price_list_id: PL, file_sha256: sha(bytes), status: 'uploaded' });
    s.db.seed.import(TENANT_A, { status: 'validating' });
    const r = await up(s, { file: fileOf(bytes) });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(a.id);
  }, T);

  it('many users at once: 6 concurrent distinct uploads on an idle tenant -> exactly 2 succeed, 4 are 429; 2 imports, 2 jobs', async () => {
    const s = setup();
    const res = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => up(s, { file: fileOf(fakeXlsx(`cc${i}`)) })));
    const ok = res.filter((r) => r.status === 'fulfilled');
    const bad = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(2);
    expect(bad.map((b) => b.reason.code)).toEqual(Array(4).fill('common.rate_limited'));
    expect(s.db.rows('imports')).toHaveLength(2);
    expect(s.db.rows('files')).toHaveLength(2);
    expect(s.db.jobs).toHaveLength(2);
  }, T);
});

describe('AC-16.11 / 08 A13 P-10: per-kind permission asserted in the service (hand-written branch tests, S-4)', () => {
  const perms = ['catalog.test.manage', 'catalog.price_list.manage', 'catalog.referrer.manage'];
  const kinds = Object.keys(KIND_PERM);

  it.each(kinds.flatMap((k) => perms.filter((p) => p !== KIND_PERM[k]).map((p) => [k, p] as const)))(
    'createImport kind %s with only the floor + %s -> 403 auth.forbidden, nothing written', async (kind, other) => {
      const s = setup({ grants: ['catalog.test.read', other] });
      await expectErr(up(s, { kind, targetPriceListId: kind === 'price_list' ? PL : undefined }), 'auth.forbidden');
      noWrites(s);
    }, T);

  it.each(kinds)('createImport kind %s asserts exactly its own permission (%s) via IdentityPort.assertRole', async (kind) => {
    const s = setup();
    await up(s, { kind, targetPriceListId: kind === 'price_list' ? PL : undefined, file: fileOf(fakeXlsx(`p-${kind}`)) });
    const asserted = s.identity.calls.map((c) => c.permission).filter((p) => p !== 'catalog.test.read');
    expect(asserted).toContain(KIND_PERM[kind]);
    expect(asserted.every((p) => p === KIND_PERM[kind])).toBe(true);
    expect(s.identity.calls.every((c) => c.ctx !== undefined && c.ctx !== null)).toBe(true);
  }, T);

  it.each(['price_list', 'credit_parties'])('createImport %s at aal1 (privileged catalog.price_list.manage) -> 403 auth.mfa_required, nothing written', async (kind) => {
    const s = setup({ aal: 1 });
    await expectErr(up(s, { kind, targetPriceListId: kind === 'price_list' ? PL : undefined }), 'auth.mfa_required');
    noWrites(s);
  }, T);

  it.each(['catalog_master', 'referrers'])('createImport %s at aal1 works (not privileged)', async (kind) => {
    const s = setup({ aal: 1 });
    expect((await up(s, { kind, targetPriceListId: undefined })).status).toBe(201);
  }, T);

  it('permission is checked before the file is looked at: a forbidden caller with an oversize or non-ZIP file gets 403, not 413/415', async () => {
    const s = setup({ grants: ['catalog.test.read'] });
    await expectErr(up(s, { file: fileOf(new Uint8Array(15728641)) }), 'auth.forbidden');
    await expectErr(up(s, { file: fileOf(new TextEncoder().encode('hello')) }), 'auth.forbidden');
  }, T);

  const TEMPLATE_PERM: Array<[string, string | undefined]> = [['price_list', 'catalog.price_list.read'], ['credit_parties', 'catalog.price_list.read'], ['referrers', 'catalog.referrer.read'], ['catalog_master', undefined]];
  it.each(TEMPLATE_PERM.filter(([, p]) => p))('downloadImportTemplate %s needs %s on top of the floor -> 403 without it', async (kind, perm) => {
    const denied = setup({ grants: ALL.filter((g) => g !== perm) });
    await expectErr(denied.run((svc, ctx) => svc.downloadTemplate(ctx, kind)), 'auth.forbidden');
    const ok = setup({ grants: ['catalog.test.read', perm!] });
    expect((await ok.run((svc, ctx) => svc.downloadTemplate(ctx, kind))).bytes.length).toBeGreaterThan(0);
  }, T);

  it('downloadImportTemplate catalog_master needs only the floor (no extra permission)', async () => {
    const s = setup({ grants: ['catalog.test.read'] });
    expect((await s.run((svc, ctx) => svc.downloadTemplate(ctx, 'catalog_master'))).bytes.length).toBeGreaterThan(0);
  }, T);

  const rowOps: Array<[string, (svc: Svc, ctx: any, id: string) => Promise<unknown>]> = [
    ['getImport', (svc, ctx, id) => svc.getImport(ctx, id)],
    ['listImportIssues', (svc, ctx, id) => svc.listImportIssues(ctx, id, {})],
    ['downloadImportReport', (svc, ctx, id) => svc.downloadImportReport(ctx, id)],
    ['discardImport', (svc, ctx, id) => svc.discardImport(ctx, id)],
  ];
  describe.each(rowOps)('%s: permission of the import’s kind, asserted after the row is loaded', (_op, call) => {
    it.each(kinds)('import of kind %s: caller without that kind’s permission -> 403; with it -> allowed', async (kind) => {
      const perm = KIND_PERM[kind]!;
      const seedRow = (s: S) => {
        const report = s.db.seed.file(TENANT_A);
        return s.db.seed.import(TENANT_A, { kind, target_price_list_id: kind === 'price_list' ? PL : null, status: 'validated', report_file_id: report.id });
      };
      const denied = setup({ grants: ALL.filter((g) => g !== perm) });
      await expectErr(denied.run((svc, ctx) => call(svc, ctx, seedRow(denied).id)), 'auth.forbidden');
      const allowed = setup({ grants: ['catalog.test.read', perm] });
      await expect(allowed.run((svc, ctx) => call(svc, ctx, seedRow(allowed).id))).resolves.toBeDefined();
    }, T);

    it('a price_list import at aal1 -> 403 auth.mfa_required (as #97)', async () => {
      const s = setup({ aal: 1 });
      const row = s.db.seed.import(TENANT_A, { kind: 'price_list', target_price_list_id: PL, status: 'validated' });
      await expectErr(s.run((svc, ctx) => call(svc, ctx, row.id)), 'auth.mfa_required');
    }, T);

    it('unknown import id -> 404 common.not_found (also for a caller with no permission at all: the row decides the permission)', async () => {
      const s = setup({ grants: ['catalog.test.read'] });
      await expectErr(s.run((svc, ctx) => call(svc, ctx, V7('00000000ffff'))), 'common.not_found');
    }, T);
  });
});

describe('#98 listImports', () => {
  it('returns only imports of kinds the caller may manage, scoped to the tenant', async () => {
    const s = setup({ grants: ['catalog.test.read', 'catalog.price_list.manage'] });
    s.db.seed.import(TENANT_A, { kind: 'price_list', target_price_list_id: PL });
    s.db.seed.import(TENANT_A, { kind: 'credit_parties' });
    s.db.seed.import(TENANT_A, { kind: 'catalog_master' });
    s.db.seed.import(TENANT_A, { kind: 'referrers' });
    s.db.seed.import(TENANT_B, { kind: 'price_list', target_price_list_id: PL_B });
    const r = await s.run((svc, ctx) => svc.listImports(ctx, {}));
    expect(r.data.map((i) => i.kind).sort()).toEqual(['credit_parties', 'price_list']);
    expect(r.page.limit).toBeGreaterThan(0);
  }, T);

  it('?kind= for a kind the caller may not manage never returns that kind’s rows (403 or an empty page)', async () => {
    const s = setup({ grants: ['catalog.test.read', 'catalog.price_list.manage'] });
    s.db.seed.import(TENANT_A, { kind: 'referrers' });
    const e = await errOf(s.run((svc, ctx) => svc.listImports(ctx, { kind: 'referrers' })));
    if (e) expect(e.code).toBe('auth.forbidden');
    else expect((await s.run((svc, ctx) => svc.listImports(ctx, { kind: 'referrers' }))).data).toEqual([]);
  }, T);

  it('filters by kind and status; response items have the Import shape only', async () => {
    const s = setup();
    s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'validated' });
    s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'invalid' });
    s.db.seed.import(TENANT_A, { kind: 'referrers', status: 'validated' });
    const r = await s.run((svc, ctx) => svc.listImports(ctx, { kind: 'catalog_master', status: 'validated' }));
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({ kind: 'catalog_master', status: 'validated' });
    expect(Object.keys(r.data[0]).every((k) => IMPORT_KEYS.includes(k))).toBe(true);
  }, T);

  it('cursor pagination visits every row exactly once; a malformed cursor is 400 common.invalid_cursor', async () => {
    const s = setup();
    const ids = Array.from({ length: 5 }, () => s.db.seed.import(TENANT_A, { kind: 'catalog_master' }).id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await s.run((svc, ctx) => svc.listImports(ctx, { limit: 2, cursor }));
      expect(r.data.length).toBeLessThanOrEqual(2);
      seen.push(...r.data.map((d) => d.id));
      cursor = r.page.next_cursor;
      if (!cursor) break;
      expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    }
    expect(seen.sort()).toEqual([...ids].sort());
    await expectErr(s.run((svc, ctx) => svc.listImports(ctx, { cursor: '!!not-a-cursor!!' })), 'common.invalid_cursor');
  }, T);
});

describe('#99 getImport / #100 listImportIssues', () => {
  it('getImport maps the row: summary counts, result id, ISO timestamps, no internal columns', async () => {
    const s = setup();
    const row = s.db.seed.import(TENANT_A, {
      kind: 'price_list', target_price_list_id: PL, base_version_no: 3, status: 'validated', file_name: 'p.xlsx',
      summary: { rows: 10, added: 2, changed: 3, removed: 1, unchanged: 4, errors: 0, warnings: 1 },
      upload_file_id: V7('00000000f001'), report_file_id: V7('00000000f002'),
    });
    const b = await s.run((svc, ctx) => svc.getImport(ctx, row.id));
    expect(b).toMatchObject({ id: row.id, kind: 'price_list', target_price_list_id: PL, base_version_no: 3, status: 'validated', version: 1, created_by: USER });
    expect(b.summary).toEqual({ rows: 10, added: 2, changed: 3, removed: 1, unchanged: 4, errors: 0, warnings: 1 });
    expect(b.expires_at).toMatch(ISO);
    expect(b.created_at).toMatch(ISO);
    expect(Object.keys(b).every((k) => IMPORT_KEYS.includes(k)), `unexpected keys: ${Object.keys(b)}`).toBe(true);
  }, T);

  const seedIssues = (s: S, importId: string, n: number) => {
    for (let i = 1; i <= n; i++) s.db.seed.issue(TENANT_A, importId, { seq: i, severity: i % 2 ? 'error' : 'warning', row_no: i + 1, column_key: i === 5 ? null : 'unit_price_npr' });
  };
  it('listImportIssues: ordered by seq, column_key is exposed as `column`, no tenant/created/expires columns, severity filter', async () => {
    const s = setup();
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'invalid' });
    seedIssues(s, imp.id, 5);
    const all = await s.run((svc, ctx) => svc.listImportIssues(ctx, imp.id, {}));
    expect(all.data.map((d) => d.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all.data[0]).toEqual({ seq: 1, severity: 'error', sheet: 'Prices', row_no: 2, column: 'unit_price_npr', issue_code: 'row.price_invalid', message: 'Price is not valid.' });
    expect(all.data[4]).not.toHaveProperty('column_key');
    expect(all.data[4]!.column ?? null).toBeNull();
    const errs = await s.run((svc, ctx) => svc.listImportIssues(ctx, imp.id, { severity: 'error' }));
    expect(errs.data.map((d) => d.seq)).toEqual([1, 3, 5]);
  }, T);

  it('listImportIssues pages by cursor without gaps or repeats; bad cursor -> 400 common.invalid_cursor', async () => {
    const s = setup();
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'invalid' });
    seedIssues(s, imp.id, 5);
    const seq: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await s.run((svc, ctx) => svc.listImportIssues(ctx, imp.id, { limit: 2, cursor }));
      seq.push(...r.data.map((d) => d.seq));
      cursor = r.page.next_cursor;
      if (!cursor) break;
    }
    expect(seq).toEqual([1, 2, 3, 4, 5]);
    await expectErr(s.run((svc, ctx) => svc.listImportIssues(ctx, imp.id, { cursor: '***' })), 'common.invalid_cursor');
  }, T);

  it('a cursor taken from one import cannot be replayed against another to read it (still tenant/import scoped)', async () => {
    const s = setup();
    const a = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'invalid' });
    const b = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'invalid' });
    seedIssues(s, a.id, 4);
    s.db.seed.issue(TENANT_A, b.id, { seq: 1, message: 'Other import.' });
    const p1 = await s.run((svc, ctx) => svc.listImportIssues(ctx, a.id, { limit: 2 }));
    const r = await errOf(s.run((svc, ctx) => svc.listImportIssues(ctx, b.id, { cursor: p1.page.next_cursor })));
    const data = r === undefined ? (await s.run((svc, ctx) => svc.listImportIssues(ctx, b.id, { cursor: p1.page.next_cursor }))).data : [];
    expect(data.every((d) => d.message === 'Other import.')).toBe(true);
  }, T);
});

describe('#101 downloadImportReport', () => {
  it('report not built yet -> 409 common.version_conflict, detail file_not_ready', async () => {
    const s = setup();
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'validating', report_file_id: null });
    await expectErr(s.run((svc, ctx) => svc.downloadImportReport(ctx, imp.id)), 'common.version_conflict', 'file_not_ready');
  }, T);

  it('returns the generated report bytes as an xlsx attachment', async () => {
    const s = setup();
    const content = fakeXlsx('report-bytes');
    const rep = s.db.seed.file(TENANT_A, { purpose: 'import_report', file_name: 'import-report.xlsx', content });
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'invalid', report_file_id: rep.id });
    const r = await s.run((svc, ctx) => svc.downloadImportReport(ctx, imp.id));
    expect(r.contentType).toBe(XLSX);
    expect(r.fileName).toMatch(/^[A-Za-z0-9._-]+\.xlsx$/);
    expect(Buffer.compare(Buffer.from(r.bytes), Buffer.from(content))).toBe(0);
  }, T);

  it('never re-serves an uploaded file (purpose import_upload), even if report_file_id points at one', async () => {
    const s = setup();
    const upload = s.db.seed.file(TENANT_A, { purpose: 'import_upload', content: fakeXlsx('customer-upload') });
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'invalid', upload_file_id: upload.id, report_file_id: upload.id });
    const e = await errOf(s.run((svc, ctx) => svc.downloadImportReport(ctx, imp.id)));
    expect(e, 'must not return the upload').toBeDefined();
    expect(['common.version_conflict', 'common.not_found']).toContain(e.code);
  }, T);
});

describe('#103 discardImport (03-APP-FLOW §2.2)', () => {
  it.each(['validated', 'invalid'])('%s -> discarded: 200 Import, version + 1, persisted', async (status) => {
    const s = setup();
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status });
    const b = await s.run((svc, ctx) => svc.discardImport(ctx, imp.id));
    expect(b).toMatchObject({ id: imp.id, status: 'discarded', version: 2 });
    const row = s.db.rows('imports').find((r) => r.id === imp.id)!;
    expect(row).toMatchObject({ status: 'discarded', version: 2, updated_by: USER });
  }, T);

  it.each(['uploaded', 'scanning', 'validating', 'quarantined', 'committing', 'committed', 'commit_failed', 'discarded', 'expired', 'failed'])(
    '%s cannot be discarded: 409 catalog.import_not_committable, row unchanged', async (status) => {
      const s = setup();
      const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status });
      await expectErr(s.run((svc, ctx) => svc.discardImport(ctx, imp.id)), 'catalog.import_not_committable');
      expect(s.db.rows('imports').find((r) => r.id === imp.id)).toMatchObject({ status, version: 1 });
    }, T);

  it('two concurrent discards: exactly one succeeds, the other is 409 catalog.import_not_committable', async () => {
    const s = setup();
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'validated' });
    const res = await Promise.allSettled([s.run((svc, ctx) => svc.discardImport(ctx, imp.id)), s.run((svc, ctx) => svc.discardImport(ctx, imp.id))]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = res.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(rej.reason.code).toBe('catalog.import_not_committable');
    expect(s.db.rows('imports').find((r) => r.id === imp.id)).toMatchObject({ status: 'discarded', version: 2 });
  }, T);

  it('does not enqueue any job', async () => {
    const s = setup();
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'validated' });
    await s.run((svc, ctx) => svc.discardImport(ctx, imp.id));
    expect(s.db.jobs).toHaveLength(0);
  }, T);
});

describe('AC-16.1 downloadImportTemplate: xlsx with Instructions, data sheets and hidden _meta', () => {
  const sheets = (z: Map<string, Buffer>) => [...z.get('xl/workbook.xml')!.toString('utf8').matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: /\bname="([^"]*)"/.exec(m[0])![1]!, hidden: /\bstate="(?:hidden|veryHidden)"/.test(m[0]),
  }));
  const allText = (z: Map<string, Buffer>) => [...z.entries()].filter(([n]) => n.endsWith('.xml')).map(([, b]) => b.toString('utf8')).join('\n');
  const get = async (kind: string) => {
    const s = setup();
    return s.run((svc, ctx) => svc.downloadTemplate(ctx, kind));
  };

  it('price_list: sheets Instructions, Prices, hidden _meta; headers; template_kind row; xlsx content type + attachment-safe file name', async () => {
    const t = await get('price_list');
    expect(t.contentType).toBe(XLSX);
    expect(t.fileName).toMatch(/^[A-Za-z0-9._-]+\.xlsx$/);
    expect(Array.from(t.bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const z = readZip(t.bytes);
    const sh = sheets(z);
    expect(sh.map((x) => x.name)).toEqual(expect.arrayContaining(['Instructions', 'Prices', '_meta']));
    expect(sh.find((x) => x.name === '_meta')!.hidden).toBe(true);
    expect(sh.find((x) => x.name === 'Prices')!.hidden).toBe(false);
    const text = allText(z);
    for (const needle of ['template_kind', 'price_list', 'template_version', 'base_version_no', 'orderable_code', 'unit_price_npr']) expect(text, needle).toContain(needle);
  }, T);

  it.each(['price_list', 'catalog_master', 'referrers', 'credit_parties'])('%s: no formula cells (<f>), no macros, no external links, template_kind = kind (S-9, REQ-SEC-087)', async (kind) => {
    const t = await get(kind);
    const z = readZip(t.bytes);
    const names = [...z.keys()];
    expect(names.some((n) => /vbaProject|externalLinks\//i.test(n))).toBe(false);
    for (const [n, b] of z) if (/^xl\/worksheets\/.*\.xml$/.test(n)) expect(b.toString('utf8'), n).not.toMatch(/<f[\s>]/);
    const sh = sheets(z);
    expect(sh.map((x) => x.name)).toEqual(expect.arrayContaining(['Instructions', '_meta']));
    expect(sh.find((x) => x.name === '_meta')!.hidden).toBe(true);
    expect(allText(z)).toContain('template_kind');
    expect(allText(z)).toContain(kind);
  }, T);

  it('catalog_master: one sheet per section of 02-TRD §8.2', async () => {
    const z = readZip((await get('catalog_master')).bytes);
    const want = ['Departments', 'SpecimenTypes', 'Containers', 'Methods', 'Units', 'ValueSets', 'Tests', 'Analytes', 'ReferenceRanges', 'CriticalLimits', 'Panels', 'PanelMembers', 'CommentCodes', 'TatTargets'];
    expect(sheets(z).map((x) => x.name)).toEqual(expect.arrayContaining(want));
  }, T);

  it('unknown kind -> 400 common.validation_failed (never reaches a file path or SQL)', async () => {
    const s = setup();
    await expectErr(s.run((svc, ctx) => svc.downloadTemplate(ctx, '../../etc/passwd')), 'common.validation_failed');
    noWrites(s);
  }, T);
});

describe('02-TRD §5.2 access log: #96 / #101 write one data.export entry, #97–#100 and #103 none', () => {
  it('#96 downloadTemplate: exactly one entry {data.export, catalog_file, detail.kind, allowed}', async () => {
    const s = setup();
    await s.run((svc, ctx) => svc.downloadTemplate(ctx, 'price_list'));
    expect(s.accessLog).toHaveLength(1);
    expect(s.accessLog[0]).toMatchObject({ action: 'data.export', entityType: 'catalog_file', detail: { kind: 'price_list' }, outcome: 'allowed' });
  }, T);

  it('#101 downloadImportReport: exactly one entry {data.export, catalog_file, entityId = report_file_id, allowed}', async () => {
    const s = setup();
    const rep = s.db.seed.file(TENANT_A, { purpose: 'import_report', file_name: 'import-report.xlsx', content: fakeXlsx('rep') });
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'invalid', report_file_id: rep.id });
    await s.run((svc, ctx) => svc.downloadImportReport(ctx, imp.id));
    expect(s.accessLog).toHaveLength(1);
    expect(s.accessLog[0]).toMatchObject({ action: 'data.export', entityType: 'catalog_file', entityId: rep.id, outcome: 'allowed' });
  }, T);

  it('report not ready (409) or permission denied: no "allowed" entry', async () => {
    const s = setup();
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'validating', report_file_id: null });
    await errOf(s.run((svc, ctx) => svc.downloadImportReport(ctx, imp.id)));
    const d = setup({ grants: [] });
    await errOf(d.run((svc, ctx) => svc.downloadTemplate(ctx, 'price_list')));
    expect([...s.accessLog, ...d.accessLog].filter((e) => e.outcome === 'allowed')).toEqual([]);
  }, T);

  it('#97 createImport, #98 list, #99 get, #100 issues, #103 discard write no access-log entry', async () => {
    const s = setup();
    const r = await up(s);
    await s.run((svc, ctx) => svc.listImports(ctx, {}));
    await s.run((svc, ctx) => svc.getImport(ctx, r.body.id));
    await s.run((svc, ctx) => svc.listImportIssues(ctx, r.body.id, {}));
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'validated' });
    await s.run((svc, ctx) => svc.discardImport(ctx, imp.id));
    expect(s.accessLog).toEqual([]);
  }, T);
});
