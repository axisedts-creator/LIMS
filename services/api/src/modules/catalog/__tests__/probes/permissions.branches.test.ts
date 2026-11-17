// T-36 (C3) — S-4 hand-written permission tests for every conditional branch (08 A13 P-10), driven through the REAL handlers map
// (so a stub or a missing handler fails here): #34 (both permissions), #96–#107 per kind, #102 range publication (AB-21, D-18).
// Spec: 02-TRD §5.2 rows 34, 96–107 + §5.0; 07-SECURITY S-4, AB-6/7/8/21; 06 T-36 ("hand-written permission tests for every conditional branch").
// Seam: handlers read ctx.{tenantId, actor, tx, now, audit?, ports.IdentityPort} exactly like imports.handlers.ts; identity = helpers/identity.ts fake
// (missing permission -> auth.forbidden; privileged permission at aal1 -> auth.mfa_required). Floor `x-permission` (catalog.test.read) is the core
// pipeline's and is granted to every caller here; only the handler-asserted per-kind permission is under test.
// Today: #96–#103 are real (service-level branches already proved in T-20/23/25; re-proved here at handler level); #104–#107 are 503 stubs -> red.
import { describe, expect, it } from 'vitest';
import { handlers } from '../../handlers/index.js';
import { makeIdentity } from '../helpers/identity.js';
import { makeImportsDb, NOW, TENANT_A, V7 } from '../helpers/importsDb.js';
import { makeExportsDb, XLSX_CT } from '../helpers/exportsDb.js';
import { fakeXlsx } from '../helpers/zip.js';
import { HB_V2, pBody, setup7 } from '../helpers/t7.js';

const T = 20_000;
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const FLOOR = 'catalog.test.read';
const PUBLISH = 'catalog.reference_range.publish';
const PL = V7('0000000d0001');
const PLV3 = V7('0000000d0003');
const REASON = 'Permission branch (synthetic)';

type Kind = 'price_list' | 'credit_parties' | 'catalog_master' | 'referrers';
// [kind, permission asserted by the handler/service for that kind, privileged?] — 02-TRD rows 97 and 104
const IMPORT_KINDS: ReadonlyArray<readonly [Kind, string, boolean]> = [
  ['price_list', 'catalog.price_list.manage', true],
  ['credit_parties', 'catalog.price_list.manage', true],
  ['catalog_master', 'catalog.test.manage', false],
  ['referrers', 'catalog.referrer.manage', false],
];
const TEMPLATE_EXTRA: Record<Kind, string | undefined> = { price_list: 'catalog.price_list.read', credit_parties: 'catalog.price_list.read', catalog_master: undefined, referrers: 'catalog.referrer.read' };
const EXPORT_KINDS: ReadonlyArray<readonly [string, string, boolean]> = [
  ['price_list', 'catalog.price_list.manage', true],
  ['catalog_master', 'catalog.test.manage', false],
  ['referrers', 'catalog.referrer.export', true],
];
const ALL_PERMS = ['catalog.test.read', 'catalog.test.manage', 'catalog.price_list.read', 'catalog.price_list.manage', 'catalog.referrer.read', 'catalog.referrer.manage', 'catalog.referrer.export', PUBLISH];

const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const errOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as any);

function imports(grants: readonly string[], aal: 1 | 2 = 2) {
  const db = makeImportsDb();
  db.seed.priceList(TENANT_A, PL);
  const identity = makeIdentity(grants, aal);
  const call = (op: string, r: ReturnType<typeof req>) => db.run((ctx) => H[op]!(r, { ...ctx, ...bare(op), ports: { IdentityPort: identity } }), { tenantId: TENANT_A });
  const seed = (kind: Kind, over: Record<string, unknown> = {}) =>
    db.seed.import(TENANT_A, { kind, status: 'validated', target_price_list_id: kind === 'price_list' ? PL : null, base_version_no: kind === 'price_list' ? 0 : null, summary: { rows: 4, added: 4, changed: 0, removed: 0, unchanged: 0, errors: 0, warnings: 0 }, ...over });
  return { db, identity, call, seed };
}
function exportsEnv(grants: readonly string[], aal: 1 | 2 = 2) {
  const db = makeExportsDb();
  db.seed.rows('price_list_versions', { id: PLV3, tenant_id: TENANT_A, price_list_id: PL, version_no: 3, status: 'published' });
  const identity = makeIdentity(grants, aal);
  const accessLog: Array<Record<string, unknown>> = [];
  const audit = { access: async (e: Record<string, unknown>) => { accessLog.push(e); } };
  const call = (op: string, r: ReturnType<typeof req>) => db.run((ctx) => H[op]!(r, { ...ctx, ...bare(op), ports: { IdentityPort: identity } }), { tenantId: TENANT_A, ctx: { audit } });
  const ready = (kind: string) => {
    const f = db.seed.file(TENANT_A, { content: new Uint8Array([0x50, 0x4b, 3, 4, 1]), file_name: `${kind}.xlsx` });
    return db.seed.export(TENANT_A, { kind, status: 'ready', file_id: f.id, expires_at: new Date(Date.parse(NOW) + 30 * 86400_000) });
  };
  return { db, identity, call, ready, accessLog };
}
const createImportReq = (kind: Kind) => req({
  headers: { 'idempotency-key': `k-${kind}` },
  body: { kind, ...(kind === 'price_list' ? { target_price_list_id: PL } : {}), file: { filename: 'in.xlsx', mimetype: XLSX_CT, data: fakeXlsx(`perm-${kind}`) } },
});
const commitReq = (id: string, version: number) => req({ params: { import_id: id }, headers: { 'if-match': `"${version}"`, 'idempotency-key': 'k-commit' }, body: { change_reason: REASON } });

describe('#96 downloadImportTemplate: floor + the per-kind read permission (price_list/credit_parties -> price_list.read; referrers -> referrer.read; catalog_master -> floor only)', () => {
  it.each(IMPORT_KINDS)('%s: floor only', async (kind) => {
    const s = imports([FLOOR]);
    const need = TEMPLATE_EXTRA[kind];
    const e = await errOf(s.call('downloadImportTemplate', req({ params: { kind } })));
    if (need) { expect(e?.code, kind).toBe('auth.forbidden'); expect(s.identity.calls.map((c) => c.permission)).toContain(need); }
    else expect(e, kind).toBeUndefined();
  }, T);
  it.each(IMPORT_KINDS)('%s: floor + its read permission -> 200 attachment', async (kind) => {
    const s = imports([FLOOR, TEMPLATE_EXTRA[kind] ?? FLOOR]);
    const r = await s.call('downloadImportTemplate', req({ params: { kind } }));
    expect(r.status).toBe(200);
    expect(r.headers?.['content-disposition']).toMatch(/^attachment/);
  }, T);
  it('a manage permission does not stand in for the read permission of another kind (referrer.manage cannot download the price_list template)', async () => {
    const s = imports([FLOOR, 'catalog.referrer.manage', 'catalog.test.manage']);
    expect((await errOf(s.call('downloadImportTemplate', req({ params: { kind: 'price_list' } }))))?.code).toBe('auth.forbidden');
  }, T);
});

describe('#97 createImport: floor + per-kind manage permission; the two price-list kinds are privileged (aal2)', () => {
  it.each(IMPORT_KINDS)('%s with ONLY the other kinds’ permissions -> 403 auth.forbidden; nothing stored', async (kind, perm) => {
    const s = imports(ALL_PERMS.filter((p) => p !== perm));
    expect((await errOf(s.call('createImport', createImportReq(kind))))?.code).toBe('auth.forbidden');
    expect(s.identity.calls.map((c) => c.permission)).toContain(perm);
    expect(s.db.allRows('imports')).toHaveLength(0);
    expect(s.db.allRows('files')).toHaveLength(0);
  }, T);
  it.each(IMPORT_KINDS)('%s with %s at aal2 -> 201 Import', async (kind, perm) => {
    const s = imports([FLOOR, perm]);
    const r = await s.call('createImport', createImportReq(kind));
    expect([200, 201]).toContain(r.status);
    expect(r.body.kind).toBe(kind);
  }, T);
  it.each(IMPORT_KINDS)('%s at aal1: privileged kinds -> 403 auth.mfa_required (AB-7), the others are unaffected', async (kind, perm, privileged) => {
    const s = imports([FLOOR, perm], 1);
    const e = await errOf(s.call('createImport', createImportReq(kind)));
    if (privileged) { expect(e?.code).toBe('auth.mfa_required'); expect(s.db.allRows('imports')).toHaveLength(0); }
    else expect(e).toBeUndefined();
  }, T);
  it('front_desk-like caller (read permissions only) cannot create any kind (AB-6)', async () => {
    for (const [kind] of IMPORT_KINDS) {
      const s = imports([FLOOR, 'catalog.price_list.read', 'catalog.referrer.read']);
      expect((await errOf(s.call('createImport', createImportReq(kind))))?.code, kind).toBe('auth.forbidden');
    }
  }, T);
});

describe('#98 listImports: rows are filtered to the kinds the caller may manage', () => {
  const cases: ReadonlyArray<readonly [string, readonly string[], readonly Kind[]]> = [
    ['price_list.manage', [FLOOR, 'catalog.price_list.manage'], ['price_list', 'credit_parties']],
    ['test.manage', [FLOOR, 'catalog.test.manage'], ['catalog_master']],
    ['referrer.manage', [FLOOR, 'catalog.referrer.manage'], ['referrers']],
    ['all manage permissions', [FLOOR, 'catalog.price_list.manage', 'catalog.test.manage', 'catalog.referrer.manage'], ['price_list', 'credit_parties', 'catalog_master', 'referrers']],
    ['floor only', [FLOOR], []],
  ];
  it.each(cases)('%s -> only the rows of the permitted kinds', async (_n, grants, kinds) => {
    const s = imports(grants);
    for (const [k] of IMPORT_KINDS) s.seed(k);
    const r = await s.call('listImports', req());
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => d.kind).sort()).toEqual([...kinds].sort());
  }, T);
});

describe('#99 getImport, #100 listImportIssues, #101 downloadImportReport, #103 discardImport: "as #97 for the import’s kind" (decided after the row is loaded)', () => {
  const ops: ReadonlyArray<readonly [string, (id: string, v: number) => ReturnType<typeof req>, Record<string, unknown>]> = [
    ['getImport', (id) => req({ params: { import_id: id } }), {}],
    ['listImportIssues', (id) => req({ params: { import_id: id } }), {}],
    ['downloadImportReport', (id) => req({ params: { import_id: id } }), { report: true }],
    ['discardImport', (id, v) => req({ params: { import_id: id }, headers: { 'if-match': `"${v}"` } }), {}],
  ];
  describe.each(ops)('%s', (op, mk, opts) => {
    it.each(IMPORT_KINDS)('%s row without its permission -> 403 auth.forbidden; row untouched', async (kind, perm) => {
      const s = imports(ALL_PERMS.filter((p) => p !== perm));
      const rep = opts.report ? s.db.seed.file(TENANT_A, { purpose: 'import_report' }) : undefined;
      const imp = s.seed(kind, rep ? { report_file_id: rep.id } : {});
      const before = JSON.stringify(s.db.allRows('imports'));
      expect((await errOf(s.call(op, mk(imp.id, imp.version))))?.code).toBe('auth.forbidden');
      expect(s.identity.calls.map((c) => c.permission)).toContain(perm);
      expect(JSON.stringify(s.db.allRows('imports'))).toBe(before);
    }, T);
    it.each(IMPORT_KINDS)('%s row with its permission (aal2) -> allowed', async (kind, perm) => {
      const s = imports([FLOOR, perm]);
      const rep = opts.report ? s.db.seed.file(TENANT_A, { purpose: 'import_report' }) : undefined;
      const imp = s.seed(kind, rep ? { report_file_id: rep.id } : {});
      expect(await errOf(s.call(op, mk(imp.id, imp.version)))).toBeUndefined();
    }, T);
    it.each(IMPORT_KINDS.filter(([, , p]) => p))('%s row at aal1 -> 403 auth.mfa_required (privileged)', async (kind, perm) => {
      const s = imports([FLOOR, perm], 1);
      const rep = opts.report ? s.db.seed.file(TENANT_A, { purpose: 'import_report' }) : undefined;
      const imp = s.seed(kind, rep ? { report_file_id: rep.id } : {});
      expect((await errOf(s.call(op, mk(imp.id, imp.version))))?.code).toBe('auth.mfa_required');
    }, T);
  });
});

describe('#102 commitImport: per-kind permission + catalog.reference_range.publish when a catalog_master commit publishes analyte versions / range sets / critical sets (AB-21, D-18)', () => {
  it.each(IMPORT_KINDS)('%s: without its permission -> 403; with it -> 202 committing', async (kind, perm) => {
    const no = imports(ALL_PERMS.filter((p) => p !== perm));
    const imp0 = no.seed(kind);
    expect((await errOf(no.call('commitImport', commitReq(imp0.id, imp0.version))))?.code).toBe('auth.forbidden');
    expect(no.db.allRows('imports')[0]).toMatchObject({ status: 'validated' });
    const yes = imports([FLOOR, perm]);
    const imp1 = yes.seed(kind);
    const r = await yes.call('commitImport', commitReq(imp1.id, imp1.version));
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('committing');
  }, T);
  it.each(IMPORT_KINDS.filter(([, , p]) => p))('%s at aal1 -> 403 auth.mfa_required, import still validated, nothing enqueued', async (kind, perm) => {
    const s = imports([FLOOR, perm], 1);
    const imp = s.seed(kind);
    expect((await errOf(s.call('commitImport', commitReq(imp.id, imp.version))))?.code).toBe('auth.mfa_required');
    expect(s.db.allRows('imports')[0]).toMatchObject({ status: 'validated' });
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  describe('range / analyte-version publication inside a catalog_master commit', () => {
    const clinical = ['analyte_versions', 'range_sets', 'critical_sets'] as const;
    it.each(clinical)('summary.%s > 0: test.manage alone -> 403 auth.forbidden, asserts catalog.reference_range.publish; import untouched', async (key) => {
      const s = imports([FLOOR, 'catalog.test.manage']);
      const imp = s.seed('catalog_master', { summary: { rows: 4, added: 4, changed: 0, removed: 0, unchanged: 0, errors: 0, warnings: 0, [key]: 2 } });
      expect((await errOf(s.call('commitImport', commitReq(imp.id, imp.version))))?.code).toBe('auth.forbidden');
      expect(s.identity.calls.map((c) => c.permission)).toContain(PUBLISH);
      expect(s.db.allRows('imports')[0]).toMatchObject({ status: 'validated' });
      expect(s.db.jobs).toHaveLength(0);
    }, T);
    it.each(clinical)('summary.%s > 0: test.manage + publish at aal1 -> 403 auth.mfa_required (AB-21)', async (key) => {
      const s = imports([FLOOR, 'catalog.test.manage', PUBLISH], 1);
      const imp = s.seed('catalog_master', { summary: { rows: 4, added: 4, changed: 0, removed: 0, unchanged: 0, errors: 0, warnings: 0, [key]: 2 } });
      expect((await errOf(s.call('commitImport', commitReq(imp.id, imp.version))))?.code).toBe('auth.mfa_required');
      expect(s.db.jobs).toHaveLength(0);
    }, T);
    it.each(clinical)('summary.%s > 0: publish alone (no test.manage) -> 403 auth.forbidden', async (key) => {
      const s = imports([FLOOR, PUBLISH]);
      const imp = s.seed('catalog_master', { summary: { rows: 4, added: 4, changed: 0, removed: 0, unchanged: 0, errors: 0, warnings: 0, [key]: 2 } });
      expect((await errOf(s.call('commitImport', commitReq(imp.id, imp.version))))?.code).toBe('auth.forbidden');
    }, T);
    it.each(clinical)('summary.%s > 0: both permissions at aal2 -> 202', async (key) => {
      const s = imports([FLOOR, 'catalog.test.manage', PUBLISH]);
      const imp = s.seed('catalog_master', { summary: { rows: 4, added: 4, changed: 0, removed: 0, unchanged: 0, errors: 0, warnings: 0, [key]: 2 } });
      expect((await s.call('commitImport', commitReq(imp.id, imp.version))).status).toBe(202);
    }, T);
    it('no clinical changes: test.manage at aal1 is enough and the publish permission is never asked for', async () => {
      const s = imports([FLOOR, 'catalog.test.manage'], 1);
      const imp = s.seed('catalog_master');
      expect((await s.call('commitImport', commitReq(imp.id, imp.version))).status).toBe(202);
      expect(s.identity.calls.map((c) => c.permission)).not.toContain(PUBLISH);
    }, T);
    it('the kind decides: a referrers / credit_parties summary carrying clinical keys never asks for the publish permission', async () => {
      for (const [kind, perm] of [['referrers', 'catalog.referrer.manage'], ['credit_parties', 'catalog.price_list.manage']] as const) {
        const s = imports([FLOOR, perm]);
        const imp = s.seed(kind, { summary: { rows: 4, added: 4, changed: 0, removed: 0, unchanged: 0, errors: 0, warnings: 0, analyte_versions: 9 } });
        expect((await s.call('commitImport', commitReq(imp.id, imp.version))).status, kind).toBe(202);
        expect(s.identity.calls.map((c) => c.permission), kind).not.toContain(PUBLISH);
      }
    }, T);
  });
});

describe('#104 createExport: floor + per-kind permission (price_list.manage and referrer.export are privileged; catalog_master is not, D-22)', () => {
  const body = (kind: string) => ({ kind, ...(kind === 'price_list' ? { price_list_version_id: PLV3 } : {}) });
  it.each(EXPORT_KINDS)('%s without %s -> 403 auth.forbidden; no row, no job', async (kind, perm) => {
    const s = exportsEnv(ALL_PERMS.filter((p) => p !== perm));
    expect((await errOf(s.call('createExport', req({ headers: { 'idempotency-key': 'k' }, body: body(kind) }))))?.code).toBe('auth.forbidden');
    expect(s.db.rows('exports')).toHaveLength(0);
    expect(s.db.jobs).toHaveLength(0);
  }, T);
  it.each(EXPORT_KINDS)('%s with %s at aal2 -> 202 queued', async (kind, perm) => {
    const s = exportsEnv([FLOOR, perm]);
    const r = await s.call('createExport', req({ headers: { 'idempotency-key': 'k' }, body: body(kind) }));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ kind, status: 'queued' });
  }, T);
  it.each(EXPORT_KINDS)('%s at aal1 -> privileged kinds 403 auth.mfa_required (AB-7/AB-23-style), catalog_master allowed', async (kind, perm, privileged) => {
    const s = exportsEnv([FLOOR, perm], 1);
    const e = await errOf(s.call('createExport', req({ headers: { 'idempotency-key': 'k' }, body: body(kind) })));
    if (privileged) { expect(e?.code).toBe('auth.mfa_required'); expect(s.db.rows('exports')).toHaveLength(0); }
    else expect(e).toBeUndefined();
  }, T);
});

describe('#105 getExport and #106 downloadExportFile: "as #104 for the export’s kind"', () => {
  it.each(EXPORT_KINDS)('#105 %s row without %s -> 403 auth.forbidden', async (kind, perm) => {
    const s = exportsEnv(ALL_PERMS.filter((p) => p !== perm));
    const e = s.ready(kind);
    expect((await errOf(s.call('getExport', req({ params: { export_id: e.id } }))))?.code).toBe('auth.forbidden');
  }, T);
  it.each(EXPORT_KINDS)('#105 %s row with %s -> 200', async (kind, perm) => {
    const s = exportsEnv([FLOOR, perm]);
    const e = s.ready(kind);
    expect((await s.call('getExport', req({ params: { export_id: e.id } }))).body).toMatchObject({ id: e.id, kind });
  }, T);
  it.each(EXPORT_KINDS.filter(([, , p]) => p))('#105 %s row at aal1 -> 403 auth.mfa_required', async (kind, perm) => {
    const s = exportsEnv([FLOOR, perm], 1);
    const e = s.ready(kind);
    expect((await errOf(s.call('getExport', req({ params: { export_id: e.id } }))))?.code).toBe('auth.mfa_required');
  }, T);
  it.each(EXPORT_KINDS)('#106 %s row without %s -> 403 auth.forbidden; no access-log row, no bytes', async (kind, perm) => {
    const s = exportsEnv(ALL_PERMS.filter((p) => p !== perm));
    const e = s.ready(kind);
    expect((await errOf(s.call('downloadExportFile', req({ params: { export_id: e.id } }))))?.code).toBe('auth.forbidden');
    expect(s.accessLog).toHaveLength(0);
  }, T);
  it.each(EXPORT_KINDS)('#106 %s row with %s -> 200 attachment + one access-log row', async (kind, perm) => {
    const s = exportsEnv([FLOOR, perm]);
    const e = s.ready(kind);
    const r = await s.call('downloadExportFile', req({ params: { export_id: e.id } }));
    expect(r.status).toBe(200);
    expect(s.accessLog).toHaveLength(1);
  }, T);
  it.each(EXPORT_KINDS.filter(([, , p]) => p))('#106 %s row at aal1 -> 403 auth.mfa_required; no access-log row', async (kind, perm) => {
    const s = exportsEnv([FLOOR, perm], 1);
    const e = s.ready(kind);
    expect((await errOf(s.call('downloadExportFile', req({ params: { export_id: e.id } }))))?.code).toBe('auth.mfa_required');
    expect(s.accessLog).toHaveLength(0);
  }, T);
});

describe('#107 listExports: rows filtered to the kinds the caller may export; an explicit ?kind= without permission is an error, not an empty list', () => {
  const cases: ReadonlyArray<readonly [string, readonly string[], 1 | 2, readonly string[]]> = [
    ['price_list.manage (aal2)', [FLOOR, 'catalog.price_list.manage'], 2, ['price_list']],
    ['test.manage (aal2)', [FLOOR, 'catalog.test.manage'], 2, ['catalog_master']],
    ['referrer.export (aal2)', [FLOOR, 'catalog.referrer.export'], 2, ['referrers']],
    ['all three at aal1: privileged kinds drop out', [FLOOR, 'catalog.price_list.manage', 'catalog.test.manage', 'catalog.referrer.export'], 1, ['catalog_master']],
    ['floor only', [FLOOR], 2, []],
  ];
  it.each(cases)('%s', async (_n, grants, aal, kinds) => {
    const s = exportsEnv(grants, aal);
    for (const [k] of EXPORT_KINDS) s.ready(k);
    const r = await s.call('listExports', req());
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => d.kind).sort()).toEqual([...kinds].sort());
  }, T);
  it.each(EXPORT_KINDS)('?kind=%s without %s -> 403 auth.forbidden', async (kind, perm) => {
    const s = exportsEnv(ALL_PERMS.filter((p) => p !== perm));
    s.ready(kind);
    expect((await errOf(s.call('listExports', req({ query: { kind } }))))?.code).toBe('auth.forbidden');
  }, T);
});

describe('#34 publishAnalyteVersion: catalog.test.manage ALWAYS (asserted in the handler) + the privileged catalog.reference_range.publish (floor)', () => {
  // Full publish flow: integration/analyteVersions.handlers.test.ts. This re-proves the two-permission branch table through the handlers map (T-36 pack).
  const run = (grants: readonly string[], aal: 1 | 2) => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const identity = makeIdentity(grants, aal);
    const r = req({ params: { analyte_version_id: HB_V2.id }, headers: { 'if-match': '"1"', 'idempotency-key': 'k' }, body: pBody() });
    return { e, identity, done: errOf(e.db.run((ctx) => H['publishAnalyteVersion']!(r, { ...ctx, ports: { IdentityPort: identity } }))) };
  };
  it.each([
    ['only catalog.test.manage', ['catalog.test.manage'], 2, 'auth.forbidden'],
    ['only catalog.reference_range.publish (pathologist)', [PUBLISH], 2, 'auth.forbidden'],
    ['both at aal1 (lab_manager without TOTP)', ['catalog.test.manage', PUBLISH], 1, 'auth.mfa_required'],
    ['neither', [FLOOR], 2, 'auth.forbidden'],
  ] as const)('%s -> %s; the version stays a draft', async (_n, grants, aal, code) => {
    const r = run(grants, aal);
    expect((await r.done)?.code).toBe(code);
    expect(r.e.db.row('analyte_versions', HB_V2.id as string)).toMatchObject({ status: 'draft', version: 1 });
  }, T);
  it('both at aal2: 200, and the handler asserted catalog.test.manage AND catalog.reference_range.publish', async () => {
    const r = run(['catalog.test.manage', PUBLISH], 2);
    expect(await r.done).toBeUndefined();
    const asked = r.identity.calls.map((c) => c.permission);
    expect(asked).toContain('catalog.test.manage');
    expect(asked).toContain(PUBLISH);
  }, T);
});
