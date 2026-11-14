// T-20 (C3) — probes for the import API (#96–#101, #103): cross-tenant (S-1 / AB-5), injection, mass assignment, log scan (S-13),
// error hygiene (REQ-SEC-095), handler wiring (CR-C3-008). Same seams and fake DB as integration/imports.test.ts.
// Spec: 07-SECURITY S-1, S-13, AB-5, REQ-SEC-087/095/100, A5/E4 rows; 02-TRD §5.1 (404 for foreign ids); 02-CV §11.3 items 1, 3, 4.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handlers } from '../../handlers/index.js';
import { createImportsService } from '../../service/imports.service.js';
import { isLimsError } from '../../../../core/errors.js';
import { makeIdentity } from '../helpers/identity.js';
import { makeImportsDb, TENANT_A, TENANT_B, V7 } from '../helpers/importsDb.js';
import { fakeXlsx } from '../helpers/zip.js';

const T = 20_000;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PL = V7('0000000d0001');
const PL_B = V7('0000000d0002');
const ALL = ['catalog.test.read', 'catalog.test.manage', 'catalog.price_list.read', 'catalog.price_list.manage', 'catalog.referrer.manage', 'catalog.referrer.read'];
const MARK = 'SYNTH-PROBE-MARKER-7731';

interface Svc {
  downloadTemplate(ctx: unknown, kind: string): Promise<any>;
  createImport(ctx: unknown, input: Record<string, unknown>): Promise<{ status: number; body: any }>;
  listImports(ctx: unknown, q: Record<string, unknown>): Promise<{ data: any[]; page: any }>;
  getImport(ctx: unknown, id: string): Promise<any>;
  listImportIssues(ctx: unknown, id: string, q: Record<string, unknown>): Promise<{ data: any[]; page: any }>;
  downloadImportReport(ctx: unknown, id: string): Promise<any>;
  discardImport(ctx: unknown, id: string): Promise<any>;
}
function setup() {
  const db = makeImportsDb();
  db.seed.priceList(TENANT_A, PL);
  db.seed.priceList(TENANT_B, PL_B);
  const identity = makeIdentity(ALL, 2);
  const svc = createImportsService({ identity } as never) as unknown as Svc;
  const logs: unknown[] = [];
  const log = { info: (o: unknown) => logs.push(o), warn: (o: unknown) => logs.push(o), error: (o: unknown) => logs.push(o) };
  const run = <R>(fn: (s: Svc, ctx: any) => Promise<R>, tenantId = TENANT_A) => db.run((ctx) => fn(svc, ctx), { tenantId, ctx: { log } });
  return { db, svc, run, logs };
}
const errOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as any);
const file = (tag: string, filename = 'prices.xlsx') => ({ filename, mimeType: XLSX, bytes: fakeXlsx(tag) });

describe('S-1 / AB-5: another tenant’s import ids are 404 on every id-taking operation, with no side effects and no data in the error', () => {
  const ops: Array<[string, (svc: Svc, ctx: any, id: string) => Promise<unknown>]> = [
    ['getImport', (svc, ctx, id) => svc.getImport(ctx, id)],
    ['listImportIssues', (svc, ctx, id) => svc.listImportIssues(ctx, id, {})],
    ['downloadImportReport', (svc, ctx, id) => svc.downloadImportReport(ctx, id)],
    ['discardImport', (svc, ctx, id) => svc.discardImport(ctx, id)],
  ];
  it.each(ops)('%s with tenant B’s id as tenant A -> 404 common.not_found; B’s row unchanged', async (_n, call) => {
    const s = setup();
    const report = s.db.seed.file(TENANT_B, { file_name: `${MARK}.xlsx` });
    const b = s.db.seed.import(TENANT_B, { kind: 'catalog_master', status: 'validated', file_name: `${MARK}.xlsx`, report_file_id: report.id });
    s.db.seed.issue(TENANT_B, b.id, { message: MARK });
    const before = JSON.stringify(s.db.allRows('imports').concat(s.db.allRows('files') as never));
    const e = await errOf(s.run((svc, ctx) => call(svc, ctx, b.id)));
    expect(e).toBeDefined();
    expect(isLimsError(e, 'common.not_found')).toBe(true);
    expect(JSON.stringify({ m: e.message, d: e.detail, f: e.errors })).not.toContain(MARK);
    expect(JSON.stringify(s.db.allRows('imports').concat(s.db.allRows('files') as never))).toBe(before);
    expect(s.db.writes()).toEqual([]);
  }, T);

  it('the same ids work for their own tenant (control)', async () => {
    const s = setup();
    const b = s.db.seed.import(TENANT_B, { kind: 'catalog_master', status: 'validated' });
    expect((await s.run((svc, ctx) => svc.getImport(ctx, b.id), TENANT_B)).id).toBe(b.id);
  }, T);

  it('listImports as tenant A never contains tenant B rows, however the filters are combined', async () => {
    const s = setup();
    s.db.seed.import(TENANT_B, { kind: 'catalog_master', status: 'validated' });
    s.db.seed.import(TENANT_B, { kind: 'referrers', status: 'invalid' });
    const a = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'validated' });
    for (const q of [{}, { kind: 'catalog_master' }, { status: 'validated' }, { kind: 'referrers' }, { limit: 200 }]) {
      const r = await errOf(s.run((svc, ctx) => svc.listImports(ctx, q)));
      if (r === undefined) {
        const ok = await s.run((svc, ctx) => svc.listImports(ctx, q));
        expect(ok.data.every((d) => d.id === a.id), JSON.stringify(q)).toBe(true);
      }
    }
  }, T);

  it('createImport with tenant B’s price list id as target -> 404, nothing written (body-id probe)', async () => {
    const s = setup();
    const e = await errOf(s.run((svc, ctx) => svc.createImport(ctx, { kind: 'price_list', targetPriceListId: PL_B, file: file('x') })));
    expect(isLimsError(e, 'common.not_found')).toBe(true);
    expect(s.db.writes()).toEqual([]);
  }, T);
});

describe('tenant isolation does not rely on RLS alone (03-APP-FLOW §168, T-03 precedent)', () => {
  it('every SELECT/UPDATE on the import tables carries tenant_id = $n bound to the transaction tenant; every INSERT binds it', async () => {
    const s = setup();
    const created = await s.run((svc, ctx) => svc.createImport(ctx, { kind: 'price_list', targetPriceListId: PL, file: file('iso') }));
    await s.run((svc, ctx) => svc.createImport(ctx, { kind: 'price_list', targetPriceListId: PL, file: file('iso') }));          // dedupe path
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'validated' });
    const rep = s.db.seed.file(TENANT_A);
    const withReport = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'invalid', report_file_id: rep.id });
    s.db.seed.issue(TENANT_A, imp.id, {});
    await s.run((svc, ctx) => svc.listImports(ctx, {}));
    await s.run((svc, ctx) => svc.getImport(ctx, created.body.id));
    await s.run((svc, ctx) => svc.listImportIssues(ctx, imp.id, {}));
    await s.run((svc, ctx) => svc.downloadImportReport(ctx, withReport.id));
    await s.run((svc, ctx) => svc.discardImport(ctx, imp.id));
    const touching = s.db.stmts.filter((x) => /catalog\.(imports|files|import_issues|price_lists)\b/i.test(x.text));
    expect(touching.length).toBeGreaterThan(8);
    for (const st of touching) {
      const text = st.text.replace(/\s+/g, ' ');
      if (/^\s*INSERT/i.test(text)) {
        expect(st.values, text).toContain(st.tenantId);
      } else {
        const m = /\btenant_id\s*=\s*\$(\d+)/i.exec(text);
        expect(m, `no tenant_id = $n in: ${text}`).not.toBeNull();
        expect(st.values[Number(m![1]) - 1], text).toBe(st.tenantId);
      }
    }
  }, T);
});

describe('injection and hostile input', () => {
  const hostile = `x'; DROP TABLE catalog.imports; --${MARK}.xlsx`;

  it('user-controlled strings (file name, cursor, filters, ids) are bound values, never part of SQL text', async () => {
    const s = setup();
    await s.run((svc, ctx) => svc.createImport(ctx, { kind: 'price_list', targetPriceListId: PL, file: file('inj', hostile) }));
    const imp = s.db.seed.import(TENANT_A, { kind: 'catalog_master', status: 'invalid' });
    await Promise.all([
      s.run((svc, ctx) => svc.listImports(ctx, { cursor: `'; DROP TABLE catalog.files;--`, kind: `x' OR '1'='1`, status: `x' OR '1'='1` })),
      s.run((svc, ctx) => svc.listImportIssues(ctx, imp.id, { cursor: `' OR 1=1 --`, severity: `error' OR '1'='1` })),
      s.run((svc, ctx) => svc.getImport(ctx, `${imp.id}' OR '1'='1`)),
      s.run((svc, ctx) => svc.downloadTemplate(ctx, `price_list' OR '1'='1`)),
    ].map(errOf));
    for (const st of s.db.stmts) {
      expect(st.text, st.text).not.toMatch(/DROP TABLE|OR '1'='1'|OR 1=1|SYNTH-PROBE/i);
      expect(st.text, st.text).not.toMatch(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);       // no uuid literal
      expect(st.text, st.text).not.toMatch(/'[0-9a-f]{64}'/);                               // no sha literal
    }
    expect(s.db.rows('imports').length).toBeGreaterThanOrEqual(2);                           // tables intact
  }, T);

  it('malformed ids / filters are rejected with 4xx LimsErrors, not 500 or a DB error', async () => {
    const s = setup();
    for (const id of ['not-a-uuid', '', '00000000-0000-0000-0000-000000000000', 'a'.repeat(5000)]) {
      const e = await errOf(s.run((svc, ctx) => svc.getImport(ctx, id)));
      expect(e, id.slice(0, 20)).toBeDefined();
      expect(['common.not_found', 'common.validation_failed']).toContain(e.code);
    }
    const e = await errOf(s.run((svc, ctx) => svc.listImports(ctx, { status: 'bogus' })));
    expect(e).toBeDefined();
    expect(e.code).toBe('common.validation_failed');
  }, T);

  it('mass assignment: status / tenant / creator / version / ids supplied by the client are ignored', async () => {
    const s = setup();
    const r = await s.run((svc, ctx) => svc.createImport(ctx, {
      kind: 'price_list', targetPriceListId: PL, file: file('mass'),
      status: 'validated', tenant_id: TENANT_B, tenantId: TENANT_B, created_by: V7('00000000dead'), version: 9, summary: { rows: 999 }, expires_at: '2099-01-01T00:00:00.000Z',
    }));
    expect(r.body).toMatchObject({ status: 'uploaded', version: 1 });
    expect(r.body.summary.rows ?? 0).toBe(0);
    expect(Date.parse(r.body.expires_at)).toBeLessThan(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(s.db.rows('imports', TENANT_B)).toHaveLength(0);
  }, T);
});

describe('S-13 / REQ-SEC-095: nothing personal or internal in logs or error messages', () => {
  it('file names are not logged and not echoed in 413/415/429/403 errors; failing imports leave no marker in logs', async () => {
    const s = setup();
    const name = `${MARK}.xlsx`;
    const bad = [
      s.run((svc, ctx) => svc.createImport(ctx, { kind: 'price_list', targetPriceListId: PL, file: { filename: `${MARK}.xls`, mimeType: XLSX, bytes: fakeXlsx('l1') } })),
      s.run((svc, ctx) => svc.createImport(ctx, { kind: 'price_list', targetPriceListId: PL, file: { filename: name, mimeType: XLSX, bytes: new TextEncoder().encode(`not a zip ${MARK}`) } })),
      s.run((svc, ctx) => svc.createImport(ctx, { kind: 'price_list', targetPriceListId: PL, file: { filename: name, mimeType: XLSX, bytes: new Uint8Array(15728641) } })),
    ];
    for (const e of await Promise.all(bad.map(errOf))) {
      expect(e).toBeDefined();
      expect(JSON.stringify({ m: e.message, d: e.detail, f: e.errors })).not.toContain(MARK);
    }
    s.db.fail(/enqueue_job/i, () => new Error(`boom ${MARK}`));
    await errOf(s.run((svc, ctx) => svc.createImport(ctx, { kind: 'price_list', targetPriceListId: PL, file: { filename: name, mimeType: XLSX, bytes: fakeXlsx('l2') } })));
    expect(JSON.stringify(s.logs)).not.toContain(MARK);
    expect(JSON.stringify(s.logs)).not.toMatch(/PK\u0003\u0004/);
  }, T);

  it('a 429 carries no import data, only the code and retryAfterSeconds', async () => {
    const s = setup();
    s.db.seed.import(TENANT_A, { status: 'uploaded', file_name: `${MARK}.xlsx` });
    s.db.seed.import(TENANT_A, { status: 'uploaded', file_name: `${MARK}.xlsx` });
    const e = await errOf(s.run((svc, ctx) => svc.createImport(ctx, { kind: 'price_list', targetPriceListId: PL, file: file('l429') })));
    expect(e.code).toBe('common.rate_limited');
    expect(JSON.stringify({ m: e.message, d: e.detail, f: e.errors })).not.toContain(MARK);
  }, T);
});

describe('CR-C3-008: handler wiring for the T-20 + T-23 operations', () => {
  // T-23 moved commitImport (#102) from pending to implemented: it is wired like the seven T-20 operations.
  const T20_OPS = ['downloadImportTemplate', 'createImport', 'listImports', 'getImport', 'listImportIssues', 'downloadImportReport', 'discardImport', 'commitImport'];
  const pending = JSON.parse(readFileSync(join(import.meta.dirname, 'pending.json'), 'utf8')) as string[];

  it('the eight import operations (T-20 + commitImport, T-23) are no longer in probes/pending.json', () => {
    for (const op of T20_OPS) expect(pending, op).not.toContain(op);
  });

  it.each(T20_OPS)('%s is a real handler, not the 503 not_implemented stub', async (op) => {
    const h = (handlers as Record<string, (r: unknown, c: unknown) => Promise<unknown>>)[op]!;
    expect(typeof h).toBe('function');
    const e = await errOf(h({ params: {}, query: {}, headers: {}, body: undefined }, { operationId: op, clientIp: '203.0.113.7', log: { info() {}, warn() {}, error() {} } }));
    expect(e !== undefined && isLimsError(e, 'common.service_unavailable') && e.detail === 'not_implemented').toBe(false);
  });
});
