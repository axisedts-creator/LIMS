// C5 T-26 handlers: #18 listWorklistItems, #19 listPendingItems, #20 createWorksheet, #21 listWorksheets, #22 getWorksheet (02-TRD §5.3 rows 18-22 + access-log table; PRD AC-07.1-07.5; 07-SECURITY P-01, P-02, P-06, REQ-SEC-017/099;
// 05-SCHEMA worksheets / worksheet_items; 03-APP-FLOW §2.4 (outbound map cached), §3.4-3.6; plan row T-26 done_when). Fails now: handlers/index.ts maps all five to the T-01 stub (common.internal).
// Handler contract as in history.handlers.test.ts: (req:{params,query,headers,body}, ctx) -> {status, body}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated; a ctx without store/audit/ports fails closed (common.internal).
//   Schema / auth / x-permission / Idempotency-Key are enforced by the core pipeline; the handlers still assert the role (defence in depth, AC-07.5) and re-check what the contract bounds. Query values arrive as strings (core coerces nothing here).
// SEAM (names NOT in the spec, ASSUMED — the writer implements them in service/worklist.service.ts + the repo; production wiring supplies ctx.store like T-14/T-19):
//   ctx.store.listWorklistRows(tx, tenantId, { departmentId?, priority?, statuses: string[], processingCentreId?, sort, scopeCentreIds?, limit, after? })  limit = page size + 1 (the extra row only proves "more"), rows = lab.order_tests joined with
//     specimen barcode + order registration_no + result counts: { id, tenant_id, order_id, specimen_id?, barcode?, registration_no, patient_id, test_id, test_code, catalog_revision, priority, status, received_at, centre_id, processing_centre_id?,
//     department_id, result_total, result_resulted, result_verified }; scopeCentreIds is set only when the actor lacks all_centres (REQ-SEC-017: centre_id OR processing_centre_id).
//   ctx.store.listPendingRows(tx, tenantId, { departmentId?, priority?, statuses: string[], centreId?, overTarget?: true, now: Date, scopeCentreIds?, limit, after? }) rows add { registered_at, ordered_at, tat_target_seconds? }.
//   ctx.store.getOrderTestsForWorksheet(tx, tenantId, ids) -> the same joined rows (missing / other-tenant ids simply absent); ctx.store.insertWorksheet(tx, tenantId, { worksheet, items }) -> { worksheet (+created_at), items } where
//     worksheet = { id, centre_id, processing_centre_id?, title, department_id?, instrument_id?, item_count, created_by } and items = [{ id, worksheet_id, position, order_test_id, specimen_id?, centre_id, processing_centre_id?, snapshot, created_by }];
//   ctx.store.listWorksheets(tx, tenantId, { createdAtFrom?, createdAtTo?, departmentId?, scopeCentreIds?, limit, after? }) -> worksheet rows with item_count, newest first; ctx.store.getWorksheet(tx, tenantId, id) -> { worksheet, items } | undefined.
//   ctx.ports.IdentityPort.{assertRole(c,{permission}), getActor(c) -> { centreScope: { all, centreIds } }} (as specimen.service), ctx.ports.FrontdeskPort.getPatientDemographicsBatch(c,{patientIds,purpose:'lab_display'}) -> [{patientId, patientCode, fullName, sex, ageAtOrder}],
//   ctx.ports.CatalogPort.{getTest(c,{testId}) -> { analytes: [{ id }] }, mapInstrumentCode(c,{ instrumentId, direction: 'outbound', analyteId, testId }) throws catalog.instrument_code_unmapped}; ctx.audit.access.
// ASSUMED (the contract is silent): default pending statuses = all five live item statuses; pending age anchor = registered (awaiting_*: now - registered_at) | received (otherwise: now - received_at); over_target = tat_target_seconds set AND age > it;
//   the outbound-map cache key is (tenant, instrument, test, analyte, catalog_revision of the row) (02-TRD ports table "keyed (tenant, method, input, catalogRevision)"); a store row outside the actor's centre scope is dropped (defence in depth);
//   duplicate order_test_ids in #20 are rejected 400 /order_test_ids OR collapsed (never two items for one test); ids the caller cannot see -> 404 common.not_found and nothing is inserted (P-01, like T-10 bulk ids);
//   worksheet.print is logged by #22 only (02-TRD §11 row #22), once per call, entityType 'worksheet', no title / patient data; #18/#19/#20/#21 write no access row (the registered actions are exactly the six of REQ-SEC-096/097).
// SPEC GAP (see .orchestra/notes/C5.T-26-tests.md): WorksheetDto.rows is a closed schema {order_test_id, position, barcode?, test_code}; AC-07.4 / 04-UI-UX §3.15 also want registration no, patient, priority on the print view. Pinned here as the contract has it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const spec: any = parse(readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/lab.yaml', import.meta.url)), 'utf8'));
const S = spec.components.schemas;
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', OTHER_TENANT = '01a1a98a-ac40-7000-8000-00000000b002';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const NOW = new Date('2026-06-15T05:00:00Z');
const MIN = 60_000, HOUR = 3_600_000;
const u = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE_A1 = u(0xa201), CENTRE_A2 = u(0xa202), PROC = u(0xa301), DEPT_D = u(0xd1), DEPT_E = u(0xd2), INSTR = u(0x1a), PATIENT = u(0x77);
const LEAK = /tenant_id|created_by|updated_by|patient_id|processing_centre_id|department_id|catalog_revision|"version"|EVIL/;

let seq = 0x1000;
/** a joined order_test row received `receivedMinAgo` minutes before NOW. */
const row = (over: Record<string, unknown> = {}) => {
  const n = seq++;
  return {
    id: u(n), tenant_id: TENANT, order_id: u(n + 0x10000), specimen_id: u(n + 0x20000), barcode: `E26${String(n).padStart(8, '0')}`, registration_no: `R26${String(n).padStart(7, '0')}`, patient_id: PATIENT, test_id: u(0x700), test_code: 'CBC', catalog_revision: 3,
    priority: 'routine', status: 'in_process', received_at: new Date(NOW.getTime() - 30 * MIN), registered_at: new Date(NOW.getTime() - 3 * HOUR), ordered_at: new Date(NOW.getTime() - 3 * HOUR), tat_target_seconds: null,
    centre_id: CENTRE_A1, processing_centre_id: PROC, department_id: DEPT_D, result_total: 3, result_resulted: 1, result_verified: 0, ...over,
  } as Record<string, any>;
};

interface Opt {
  rows?: any[]; worksheets?: { worksheet: any; items: any[] }[]; unmapped?: Set<string>; analytes?: Record<string, string[]>; scope?: { all: boolean; centreIds: string[] };
  assertRole?: (r: any) => Promise<void>; leaky?: boolean; tenant?: string; mapError?: LimsError; noDemographics?: boolean; ignoreLimit?: boolean;
}
function ctxOf(opt: Opt = {}) {
  const calls: { fn: string; tenantId: unknown; arg: any }[] = [], access: any[] = [], asked: any[] = [], mapped: any[] = [], demo: any[] = [], published: any[] = [];
  const rec = (fn: string, tenantId: unknown, arg: any) => calls.push({ fn, tenantId, arg });
  const tenant = opt.tenant ?? TENANT;
  const all = opt.rows ?? [];
  const sheets = [...(opt.worksheets ?? [])];
  const mine = (r: any, tn: unknown) => opt.leaky || r.tenant_id === tn;
  const eqRows = (a: any, tn: unknown) => all.filter((r) => mine(r, tn)
    && (a.departmentId === undefined || r.department_id === a.departmentId) && (a.priority === undefined || r.priority === a.priority)
    && (!a.statuses || a.statuses.includes(r.status)) && (a.processingCentreId === undefined || r.processing_centre_id === a.processingCentreId) && (a.centreId === undefined || r.centre_id === a.centreId)
    && (!a.scopeCentreIds || opt.leaky || a.scopeCentreIds.includes(r.centre_id) || a.scopeCentreIds.includes(r.processing_centre_id)));
  const store = {
    async listWorklistRows(_t: unknown, tn: unknown, a: any) {
      rec('listWorklistRows', tn, a);
      const rows = eqRows(a, tn).slice().sort((x, y) => (a.sort === 'received_at' ? 0 : Number(y.priority === 'urgent') - Number(x.priority === 'urgent')) || x.received_at - y.received_at || x.id.localeCompare(y.id));
      return opt.ignoreLimit ? rows : rows.slice(0, a.limit);
    },
    async listPendingRows(_t: unknown, tn: unknown, a: any) {
      rec('listPendingRows', tn, a);
      const age = (r: any) => (NOW.getTime() - (r.status.startsWith('awaiting') ? r.registered_at : r.received_at).getTime()) / 1000;
      const rows = eqRows(a, tn).filter((r) => !a.overTarget || (r.tat_target_seconds != null && age(r) > r.tat_target_seconds)).sort((x, y) => x.ordered_at - y.ordered_at || x.id.localeCompare(y.id));
      return opt.ignoreLimit ? rows : rows.slice(0, a.limit);
    },
    async getOrderTestsForWorksheet(_t: unknown, tn: unknown, ids: string[]) { rec('getOrderTestsForWorksheet', tn, ids); return ids.map((i) => all.find((r) => r.id === i && mine(r, tn))).filter(Boolean); },
    async insertWorksheet(_t: unknown, tn: unknown, a: any) {
      rec('insertWorksheet', tn, a);
      const out = { worksheet: { ...a.worksheet, tenant_id: tn, created_at: NOW }, items: a.items.map((i: any) => ({ ...i, tenant_id: tn })) };
      sheets.push(out);
      return out;
    },
    async listWorksheets(_t: unknown, tn: unknown, a: any) {
      rec('listWorksheets', tn, a);
      const rows = sheets.map((s) => ({ ...s.worksheet, item_count: s.items.length })).filter((w) => mine(w, tn) && (a.departmentId === undefined || w.department_id === a.departmentId)
        && (!a.scopeCentreIds || opt.leaky || a.scopeCentreIds.includes(w.centre_id) || a.scopeCentreIds.includes(w.processing_centre_id))).sort((x, y) => y.created_at - x.created_at);
      return opt.ignoreLimit ? rows : rows.slice(0, a.limit);
    },
    async getWorksheet(_t: unknown, tn: unknown, id: string) { rec('getWorksheet', tn, id); return sheets.find((s) => s.worksheet.id === id && mine(s.worksheet, tn)); },
  };
  const scope = opt.scope ?? { all: true, centreIds: [] };
  const ctx = {
    operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    tenantId: tenant, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx: { id: 'tx' }, now: () => NOW, store,
    events: { async publish(e: unknown) { published.push(e); return { eventId: 'e', duplicate: false }; } },
    audit: { async access(e: unknown) { access.push(e); } },
    ports: {
      IdentityPort: { async assertRole(_c: unknown, r: any) { asked.push(r); await opt.assertRole?.(r); }, async getActor() { return { centreScope: scope }; } },
      FrontdeskPort: {
        async getPatientDemographicsBatch(_c: unknown, i: any) {
          demo.push(i);
          return opt.noDemographics ? [] : i.patientIds.map((id: string) => ({ patientId: id, patientCode: 'PC0001', fullName: 'Synthetic Patient', sex: 'female', ageAtOrder: { years: 34, months: 2, days: 1 } }));
        },
      },
      CatalogPort: {
        async getTest(_c: unknown, i: any) { return { id: i.testId, analytes: (opt.analytes?.[i.testId] ?? ['an1']).map((id) => ({ id })) }; },
        async mapInstrumentCode(_c: unknown, i: any) {
          mapped.push({ tenant, ...i });
          if (opt.mapError) throw opt.mapError;
          if (opt.unmapped?.has(i.analyteId)) throw new LimsError('catalog.instrument_code_unmapped');
          return { mappingId: u(0x99), instrumentId: i.instrumentId, instrumentCode: 'X', analyteId: i.analyteId, testId: i.testId };
        },
      },
    },
  };
  return { ctx: ctx as never, calls, access, asked, mapped, demo, published, sheets, of: (fn: string) => calls.filter((c) => c.fn === fn) };
}
const run = (op: string, req: unknown, c: unknown): Promise<any> => (handlers as any)[op](req, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const get = (query: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => ({ params, query, headers: {}, body: undefined }) as never;
const post = (body: unknown) => ({ params: {}, query: {}, headers: { 'idempotency-key': 't26-1' }, body }) as never;
const keysOf = (schema: any) => Object.keys(schema.properties);
const ids = (r: any) => r.body.data.map((d: any) => d.order_test_id);
const validationPath = (e: any) => [e.code, e.errors?.[0]?.path];

describe('T-26 contract of lab.yaml #18-#22 (the handlers must fit it)', () => {
  const op = (path: string, m: string) => spec.paths[path][m];
  it('permissions, idempotency, and paths: reads need lab.worklist.read, createWorksheet lab.worksheet.manage (CR-C5-004, idempotency required)', () => {
    expect(op('/v1/lab/worklist-items', 'get')).toMatchObject({ operationId: 'listWorklistItems', 'x-permission': 'lab.worklist.read', 'x-idempotency': 'none' });
    expect(op('/v1/lab/pending-items', 'get')).toMatchObject({ operationId: 'listPendingItems', 'x-permission': 'lab.worklist.read', 'x-idempotency': 'none' });
    expect(op('/v1/lab/worksheets', 'post')).toMatchObject({ operationId: 'createWorksheet', 'x-permission': 'lab.worksheet.manage', 'x-idempotency': 'required' });
    expect(op('/v1/lab/worksheets', 'get')).toMatchObject({ operationId: 'listWorksheets', 'x-permission': 'lab.worklist.read' });
    expect(op('/v1/lab/worksheets/{worksheet_id}', 'get')).toMatchObject({ operationId: 'getWorksheet', 'x-permission': 'lab.worklist.read' });
  });
  it('snapshot immutability at the API surface: a worksheet has no update / delete / item route (only POST list, GET list, GET one)', () => {
    expect(Object.keys(spec.paths['/v1/lab/worksheets']).sort()).toEqual(['get', 'post']);
    expect(Object.keys(spec.paths['/v1/lab/worksheets/{worksheet_id}'])).toEqual(['get']);
    expect(Object.keys(spec.paths).filter((p) => /worksheet/.test(p)).sort()).toEqual(['/v1/lab/worksheets', '/v1/lab/worksheets/{worksheet_id}']);
  });
  it('response shapes are closed allowlists (no tenant_id / created_by / patient_id), rows <= 200', () => {
    expect(S.WorklistItemDto.additionalProperties).toBe(false);
    expect(keysOf(S.WorklistItemDto).sort()).toEqual(['barcode', 'order_id', 'order_test_id', 'patient_display', 'priority', 'received_at', 'registration_no', 'result_counts', 'specimen_id', 'status', 'test_code', 'test_id']);
    expect(keysOf(S.PendingItemDto).sort()).toEqual(['age_anchor', 'age_seconds', 'centre_id', 'item_status', 'order_id', 'order_test_id', 'over_target', 'patient_display', 'priority', 'registration_no', 'tat_target_seconds', 'test_code']);
    expect(keysOf(S.WorksheetDto.properties.rows.items).sort()).toEqual(['barcode', 'order_test_id', 'position', 'test_code']);
    expect(S.WorksheetDto.properties.rows.maxItems).toBe(200);
  });
});

describe('T-26 are real handlers, not the T-01 stub (REQ-SEC-099)', () => {
  const REQS: Record<string, unknown> = {
    listWorklistItems: get(), listPendingItems: get(), listWorksheets: get(), getWorksheet: get({}, { worksheet_id: u(1) }),
    createWorksheet: post({ title: 'T', centre_id: CENTRE_A1, order_test_ids: [u(2)] }),
  };
  for (const op of Object.keys(REQS)) {
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.internal)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(op, REQS[op], bare))).code).toBe('auth.unauthenticated');
    });
    it(`${op}: authenticated ctx without store -> common.internal (fail closed, never a 200)`, async () => {
      const c: any = ctxOf({ rows: [row()] }).ctx; delete c.store;
      expect((await fail(run(op, REQS[op], c))).code).toBe('common.internal');
    });
  }
});

describe('T-26 AC-07.5 / REQ-SEC: the role is asserted, 403 auth.forbidden, nothing is read or written', () => {
  const forbid = async () => { throw new LimsError('auth.forbidden'); };
  const reads: [string, string, unknown][] = [['listWorklistItems', 'lab.worklist.read', get()], ['listPendingItems', 'lab.worklist.read', get()], ['listWorksheets', 'lab.worklist.read', get()], ['getWorksheet', 'lab.worklist.read', get({}, { worksheet_id: u(1) })]];
  for (const [op, perm, req] of reads) {
    it(`${op}: without ${perm} -> 403 auth.forbidden; the store is never touched; no access row`, async () => {
      const c = ctxOf({ rows: [row()], assertRole: forbid });
      const e = await fail(run(op, req, c.ctx));
      expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
      expect(c.asked[0]).toMatchObject({ permission: perm });
      expect(c.calls).toHaveLength(0);
      expect(c.access).toHaveLength(0);
    });
  }
  it('createWorksheet: without lab.worksheet.manage -> 403 (a worklist reader cannot create), nothing inserted', async () => {
    const r = row();
    const c = ctxOf({ rows: [r], assertRole: async (x) => { if (x.permission === 'lab.worksheet.manage') throw new LimsError('auth.forbidden'); } });
    const e = await fail(run('createWorksheet', post({ title: 'T', order_test_ids: [r.id] }), c.ctx));
    expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
    expect(c.asked.map((a: any) => a.permission)).toContain('lab.worksheet.manage');
    expect(c.of('insertWorksheet')).toHaveLength(0);
  });
});

describe('T-26 listWorklistItems (#18) (AC-07.1, AC-07.2)', () => {
  it('AC-07.1: department D filter -> only D rows, urgent first then received_at ascending; allowlist keys + patient_display from FrontdeskPort lab_display; no internals', async () => {
    const t = (m: number) => new Date(NOW.getTime() - m * MIN);
    const rows = [row({ received_at: t(90) }), row({ priority: 'urgent', received_at: t(20) }), row({ priority: 'urgent', received_at: t(60) }), row({ received_at: t(120) }), row({ department_id: DEPT_E, priority: 'urgent', received_at: t(200) })];
    const c = ctxOf({ rows });
    const r = await run('listWorklistItems', get({ department_id: DEPT_D }), c.ctx);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([rows[2]!.id, rows[1]!.id, rows[3]!.id, rows[0]!.id]);
    expect(r.body.data.every((d: any) => d.priority === 'urgent' || d.priority === 'routine')).toBe(true);
    expect(r.body.data[0]).toEqual({
      order_test_id: rows[2]!.id, order_id: rows[2]!.order_id, specimen_id: rows[2]!.specimen_id, barcode: rows[2]!.barcode, registration_no: rows[2]!.registration_no,
      patient_display: { full_name: 'Synthetic Patient', age_sex: expect.stringMatching(/34.*F/), patient_code: 'PC0001' }, test_id: u(0x700), test_code: 'CBC', priority: 'urgent', status: 'in_process',
      received_at: rows[2]!.received_at.toISOString(), result_counts: { total: 3, resulted: 1, verified: 0 },
    });
    for (const d of r.body.data) for (const k of Object.keys(d)) expect(keysOf(S.WorklistItemDto), k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
    expect(c.of('listWorklistRows')[0]).toMatchObject({ tenantId: TENANT, arg: { departmentId: DEPT_D, sort: 'priority_received' } });
    expect(c.demo[0]).toMatchObject({ purpose: 'lab_display' });
    expect(c.demo[0].patientIds).toEqual([PATIENT]);                                   // one batch call, distinct ids (no N+1)
    expect(c.demo).toHaveLength(1);
  });

  it('defaults: status in_process,resulted (verified only when asked); csv parsed; priority / processing_centre_id / sort passed to the store; sort=received_at has no urgent-first', async () => {
    const a = row({ status: 'in_process' }), b = row({ status: 'resulted' }), v = row({ status: 'verified' });
    const c = ctxOf({ rows: [a, b, v] });
    expect(ids(await run('listWorklistItems', get(), c.ctx)).sort()).toEqual([a.id, b.id].sort());
    expect(c.of('listWorklistRows')[0]!.arg.statuses.sort()).toEqual(['in_process', 'resulted']);
    expect(ids(await run('listWorklistItems', get({ status: 'verified,resulted' }), c.ctx)).sort()).toEqual([b.id, v.id].sort());
    expect(c.of('listWorklistRows')[1]!.arg.statuses.sort()).toEqual(['resulted', 'verified']);
    await run('listWorklistItems', get({ priority: 'urgent', processing_centre_id: PROC, sort: 'received_at' }), c.ctx);
    expect(c.of('listWorklistRows')[2]!.arg).toMatchObject({ priority: 'urgent', processingCentreId: PROC, sort: 'received_at' });
    expect(c.calls.every((x) => x.tenantId === TENANT)).toBe(true);
  });

  it('invalid status / sort -> 400 common.validation_failed at the field; nothing read (the core pattern is re-checked)', async () => {
    const c = ctxOf({ rows: [row()] });
    for (const [q, path] of [[{ status: 'approved' }, '/status'], [{ status: 'in_process,bogus' }, '/status'], [{ status: 'awaiting_receipt' }, '/status'], [{ sort: 'priority' }, '/sort']] as const) {
      const e = await fail(run('listWorklistItems', get(q), c.ctx));
      expect(validationPath(e), JSON.stringify(q)).toEqual(['common.validation_failed', path]);
    }
    expect(c.calls).toHaveLength(0);
  });

  it('AC-07.2: instrument filter keeps a test only when at least one of its analytes has an OUTBOUND code map for the instrument (CatalogPort.mapInstrumentCode outbound)', async () => {
    const T1 = u(0x801), T2 = u(0x802), T3 = u(0x803), I = u(0x2a);
    const rows = [row({ test_id: T1, test_code: 'AA' }), row({ test_id: T2, test_code: 'BB' }), row({ test_id: T3, test_code: 'CC' })];
    const c = ctxOf({ rows, analytes: { [T1]: ['a1'], [T2]: ['b1', 'b2'], [T3]: ['c1'] }, unmapped: new Set(['b1', 'c1']) });
    const r = await run('listWorklistItems', get({ instrument_id: I }), c.ctx);
    expect(r.body.data.map((d: any) => d.test_code).sort()).toEqual(['AA', 'BB']);
    expect(c.mapped.length).toBeGreaterThan(0);
    for (const m of c.mapped) expect(m).toMatchObject({ instrumentId: I, direction: 'outbound' });
    expect(c.mapped.some((m) => m.direction === 'inbound')).toBe(false);
  });

  it('instrument filter: no instrument_id -> CatalogPort.mapInstrumentCode is never called', async () => {
    const c = ctxOf({ rows: [row(), row()] });
    await run('listWorklistItems', get(), c.ctx);
    expect(c.mapped).toHaveLength(0);
  });

  it('instrument filter uses a cache: the same (tenant, instrument, test, analyte, catalog revision) is not asked twice — not within a request and not on the next request', async () => {
    const T = u(0x811), I = u(0x2b);
    const rows = [row({ test_id: T }), row({ test_id: T }), row({ test_id: T })];
    const first = ctxOf({ rows, analytes: { [T]: ['k1', 'k2'] }, unmapped: new Set(['k1']) });
    await run('listWorklistItems', get({ instrument_id: I }), first.ctx);
    expect(first.mapped.length).toBeLessThanOrEqual(2);                                // k1 + k2 once, not 3 rows x 2
    const second = ctxOf({ rows, analytes: { [T]: ['k1', 'k2'] }, unmapped: new Set(['k1']) });
    const r = await run('listWorklistItems', get({ instrument_id: I }), second.ctx);
    expect(second.mapped).toHaveLength(0);
    expect(r.body.data).toHaveLength(3);
  });

  it('cache is keyed by tenant and catalog revision: another tenant, or a newer revision of the row, asks again (no cross-tenant / stale map)', async () => {
    const T = u(0x821), I = u(0x2c);
    await run('listWorklistItems', get({ instrument_id: I }), ctxOf({ rows: [row({ test_id: T })], analytes: { [T]: ['m1'] } }).ctx);
    const otherTenant = ctxOf({ tenant: OTHER_TENANT, rows: [row({ test_id: T, tenant_id: OTHER_TENANT })], analytes: { [T]: ['m1'] }, unmapped: new Set(['m1']) });
    const r = await run('listWorklistItems', get({ instrument_id: I }), otherTenant.ctx);
    expect(otherTenant.mapped.length).toBeGreaterThan(0);
    expect(r.body.data).toEqual([]);                                                    // B's analyte is unmapped for B; A's cached "mapped" did not leak
    const newer = ctxOf({ rows: [row({ test_id: T, catalog_revision: 4 })], analytes: { [T]: ['m1'] } });
    await run('listWorklistItems', get({ instrument_id: I }), newer.ctx);
    expect(newer.mapped.length).toBeGreaterThan(0);
  });

  it('only catalog.instrument_code_unmapped means "not on this instrument"; any other catalog error is not swallowed into an empty list', async () => {
    const c = ctxOf({ rows: [row({ test_id: u(0x831) })], mapError: new LimsError('common.rate_limited') });
    expect((await fail(run('listWorklistItems', get({ instrument_id: u(0x2d) }), c.ctx))).code).toBe('common.rate_limited');
  });

  it('pagination: limit 2 of 5 -> 2 rows + opaque next_cursor; the last page has none; the cursor is passed back as `after`; a garbage cursor -> 400 common.invalid_cursor', async () => {
    const rows = Array.from({ length: 5 }, () => row());
    const c = ctxOf({ rows });
    const p1 = await run('listWorklistItems', get({ limit: 2 }), c.ctx);
    expect(p1.body.data).toHaveLength(2);
    expect(c.of('listWorklistRows')[0]!.arg.limit).toBe(3);
    expect(p1.body.page.limit).toBe(2);
    expect(p1.body.page.next_cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    await run('listWorklistItems', get({ limit: 2, cursor: p1.body.page.next_cursor }), c.ctx);
    expect(c.of('listWorklistRows')[1]!.arg.after).toBeTruthy();
    const last = await run('listWorklistItems', get({ limit: 50 }), c.ctx);
    expect(last.body.data).toHaveLength(5);
    expect(last.body.page).toEqual({ limit: 50 });
    const e = await fail(run('listWorklistItems', get({ cursor: 'not-a-cursor' }), c.ctx));
    expect([e.code, e.statusCode]).toEqual(['common.invalid_cursor', 400]);
    for (const bad of [0, 201, 1.5, 'x']) expect((await fail(run('listWorklistItems', get({ limit: bad }), c.ctx))).code, String(bad)).toBe('common.validation_failed');
  });

  it('P-02 / REQ-SEC-017: an actor scoped to centre A1 only sees rows whose centre OR processing centre is A1; the scope goes to the store and leaked rows are dropped; tenant B rows never appear', async () => {
    const own = row({ centre_id: CENTRE_A1, processing_centre_id: null }), viaProc = row({ centre_id: CENTRE_A2, processing_centre_id: CENTRE_A1 }), foreign = row({ centre_id: CENTRE_A2, processing_centre_id: PROC }), other = row({ tenant_id: OTHER_TENANT });
    const c = ctxOf({ rows: [own, viaProc, foreign, other], scope: { all: false, centreIds: [CENTRE_A1] }, leaky: true });
    const r = await run('listWorklistItems', get(), c.ctx);
    expect(c.of('listWorklistRows')[0]!.arg.scopeCentreIds).toEqual([CENTRE_A1]);
    expect(ids(r).sort()).toEqual([own.id, viaProc.id].sort());
    const none = ctxOf({ rows: [own], scope: { all: false, centreIds: [] } });
    expect((await run('listWorklistItems', get(), none.ctx)).body.data).toEqual([]);   // no scope = no centre (fail closed)
  });

  it('smuggling: tenant_id / patient_id in the query never reach the store', async () => {
    const c = ctxOf({ rows: [row()] });
    await run('listWorklistItems', get({ tenant_id: 'EVIL', patient_id: 'EVIL' }), c.ctx);
    expect(JSON.stringify(c.calls)).not.toContain('EVIL');
    expect(c.calls.every((x) => x.tenantId === TENANT)).toBe(true);
  });

  it('read only: no write on the store, no event, no access row; an invisible patient does not break the list', async () => {
    const c = ctxOf({ rows: [row()], noDemographics: true });
    const r = await run('listWorklistItems', get(), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(c.calls.map((x) => x.fn)).toEqual(['listWorklistRows']);
    expect(c.published).toHaveLength(0);
    expect(c.access).toHaveLength(0);
  });
});

describe('T-26 listPendingItems (#19) (AC-07.3)', () => {
  it('AC-07.3: awaiting_collection / awaiting_receipt rows are included by default, with age since REGISTERED; in_process rows age since RECEIVED; every row names its anchor', async () => {
    const aw = row({ status: 'awaiting_collection', received_at: null, specimen_id: null, barcode: null, registered_at: new Date(NOW.getTime() - 2 * HOUR) });
    const ar = row({ status: 'awaiting_receipt', received_at: null, registered_at: new Date(NOW.getTime() - 90 * MIN) });
    const ip = row({ status: 'in_process', received_at: new Date(NOW.getTime() - 15 * MIN) });
    const c = ctxOf({ rows: [aw, ar, ip] });
    const r = await run('listPendingItems', get(), c.ctx);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.data.map((d: any) => [d.order_test_id, d]));
    expect(by[aw.id]).toMatchObject({ item_status: 'awaiting_collection', age_anchor: 'registered', age_seconds: 7200, over_target: false });
    expect(by[ar.id]).toMatchObject({ item_status: 'awaiting_receipt', age_anchor: 'registered', age_seconds: 5400 });
    expect(by[ip.id]).toMatchObject({ item_status: 'in_process', age_anchor: 'received', age_seconds: 900 });
    for (const d of r.body.data) { expect(['registered', 'received']).toContain(d.age_anchor); expect(Number.isInteger(d.age_seconds)).toBe(true); }
    expect(c.of('listPendingRows')[0]!.arg.statuses.sort()).toEqual(['awaiting_collection', 'awaiting_receipt', 'in_process', 'resulted', 'verified']);
  });

  it('shows tat_target_seconds only when a target exists (key omitted otherwise); over_target = age beyond the target; allowlist keys, centre_id included, no internals', async () => {
    const within = row({ tat_target_seconds: 3600, received_at: new Date(NOW.getTime() - 30 * MIN) }), over = row({ tat_target_seconds: 1200, received_at: new Date(NOW.getTime() - 30 * MIN) }), none = row();
    const r = await run('listPendingItems', get(), ctxOf({ rows: [within, over, none] }).ctx);
    const by = Object.fromEntries(r.body.data.map((d: any) => [d.order_test_id, d]));
    expect(by[within.id]).toMatchObject({ tat_target_seconds: 3600, over_target: false });
    expect(by[over.id]).toMatchObject({ tat_target_seconds: 1200, over_target: true });
    expect(by[none.id]).not.toHaveProperty('tat_target_seconds');
    expect(by[none.id].over_target).toBe(false);
    expect(by[none.id]).toMatchObject({ centre_id: CENTRE_A1, registration_no: none.registration_no, test_code: 'CBC', priority: 'routine', patient_display: { full_name: 'Synthetic Patient', patient_code: 'PC0001' } });
    for (const d of r.body.data) for (const k of Object.keys(d)) expect(keysOf(S.PendingItemDto), k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_id|created_by|patient_id|processing_centre_id|department_id|barcode/);
  });

  it('filters: item_status csv, department, priority, centre, over_target=true (the store gets now = ctx.now()) -> only rows over target; the booleans accept "true"/"false"', async () => {
    const over = row({ tat_target_seconds: 600 }), ok = row({ tat_target_seconds: 99_999 }), awaiting = row({ status: 'awaiting_receipt', department_id: DEPT_E, priority: 'urgent', centre_id: CENTRE_A2 });
    const c = ctxOf({ rows: [over, ok, awaiting] });
    expect(ids(await run('listPendingItems', get({ over_target: 'true' }), c.ctx))).toEqual([over.id]);
    expect(c.of('listPendingRows')[0]!.arg).toMatchObject({ overTarget: true, now: NOW });
    expect(ids(await run('listPendingItems', get({ over_target: 'false' }), c.ctx)).sort()).toEqual([over.id, ok.id, awaiting.id].sort());
    expect(ids(await run('listPendingItems', get({ item_status: 'awaiting_receipt', department_id: DEPT_E, priority: 'urgent', centre_id: CENTRE_A2 }), c.ctx))).toEqual([awaiting.id]);
    expect(c.of('listPendingRows')[2]!.arg).toMatchObject({ statuses: ['awaiting_receipt'], departmentId: DEPT_E, priority: 'urgent', centreId: CENTRE_A2 });
  });

  it('invalid item_status (approved / unknown) or over_target -> 400 at the field; nothing read', async () => {
    const c = ctxOf({ rows: [row()] });
    for (const [q, path] of [[{ item_status: 'approved' }, '/item_status'], [{ item_status: 'in_process,x' }, '/item_status'], [{ over_target: 'maybe' }, '/over_target']] as const)
      expect(validationPath(await fail(run('listPendingItems', get(q), c.ctx))), JSON.stringify(q)).toEqual(['common.validation_failed', path]);
    expect(c.calls).toHaveLength(0);
  });

  it('oldest first (store order kept); pagination as #18; centre scope as #18 (a row of another centre is dropped)', async () => {
    const a = row({ ordered_at: new Date(NOW.getTime() - 5 * HOUR) }), b = row({ ordered_at: new Date(NOW.getTime() - 4 * HOUR) }), x = row({ centre_id: CENTRE_A2, processing_centre_id: PROC, ordered_at: new Date(NOW.getTime() - 6 * HOUR) });
    const c = ctxOf({ rows: [b, a, x], scope: { all: false, centreIds: [CENTRE_A1] }, leaky: true });
    expect(ids(await run('listPendingItems', get(), c.ctx))).toEqual([a.id, b.id]);
    const p = await run('listPendingItems', get({ limit: 1 }), ctxOf({ rows: [a, b] }).ctx);
    expect(p.body.data).toHaveLength(1);
    expect(p.body.page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('tenant B rows never appear, tenant filter on every store call; read only, no access row', async () => {
    const c = ctxOf({ rows: [row(), row({ tenant_id: OTHER_TENANT })], leaky: false });
    const r = await run('listPendingItems', get({ tenant_id: 'EVIL' }), c.ctx);
    expect(r.body.data).toHaveLength(1);
    expect(c.calls.every((x) => x.tenantId === TENANT)).toBe(true);
    expect(JSON.stringify(c.calls)).not.toContain('EVIL');
    expect(c.access).toHaveLength(0);
  });
});

describe('T-26 createWorksheet (#20) (AC-07.4; centre_id rule; items copy centre columns)', () => {
  const sheetRows = (n: number, over: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => row({ test_code: `T${i}`, ...over }));

  it('AC-07.4: 30 selected rows -> 201 WorksheetDto with 30 rows, positions 1..30 in request order, barcode + test_code per row; allowlist keys; stored snapshot per item', async () => {
    const rows = sheetRows(30, { department_id: DEPT_D });
    const c = ctxOf({ rows });
    const r = await run('createWorksheet', post({ title: 'Morning haematology', department_id: DEPT_D, instrument_id: INSTR, order_test_ids: rows.map((x) => x.id) }), c.ctx);
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['centre_id', 'created_at', 'department_id', 'id', 'instrument_id', 'processing_centre_id', 'rows', 'title']);
    expect(r.body).toMatchObject({ title: 'Morning haematology', department_id: DEPT_D, instrument_id: INSTR, created_at: NOW.toISOString() });
    expect(r.body.rows).toHaveLength(30);
    expect(r.body.rows.map((x: any) => x.position)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(r.body.rows[0]).toEqual({ order_test_id: rows[0]!.id, position: 1, barcode: rows[0]!.barcode, test_code: 'T0' });
    expect(r.body.rows.map((x: any) => x.order_test_id)).toEqual(rows.map((x) => x.id));
    for (const x of r.body.rows) for (const k of Object.keys(x)) expect(keysOf(S.WorksheetDto.properties.rows.items), k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_id|created_by|patient|snapshot/);
    const ins = c.of('insertWorksheet');
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ tenantId: TENANT, arg: { worksheet: { title: 'Morning haematology', item_count: 30, created_by: ACTOR } } });
    expect(ins[0]!.arg.items).toHaveLength(30);
    expect(ins[0]!.arg.items[4].snapshot).toEqual({ barcode: rows[4]!.barcode, registration_no: rows[4]!.registration_no, test_code: 'T4', priority: 'routine', received_at: rows[4]!.received_at.toISOString() });
  });

  it('worksheet centre rule: centre_id defaults to the processing centre of the FIRST row and processing_centre_id is always the first row\'s; every item copies the worksheet centre columns (finding C5 #43 / #20, 08 R3)', async () => {
    const first = row({ processing_centre_id: PROC, centre_id: CENTRE_A1 }), second = row({ processing_centre_id: u(0xa399), centre_id: CENTRE_A2 });
    const c = ctxOf({ rows: [first, second] });
    const r = await run('createWorksheet', post({ title: 'W', order_test_ids: [first.id, second.id] }), c.ctx);
    expect([r.body.centre_id, r.body.processing_centre_id]).toEqual([PROC, PROC]);
    const arg = c.of('insertWorksheet')[0]!.arg;
    expect(arg.worksheet).toMatchObject({ centre_id: PROC, processing_centre_id: PROC });
    for (const it of arg.items) expect(it).toMatchObject({ centre_id: PROC, processing_centre_id: PROC });
    expect(arg.items.map((i: any) => i.order_test_id)).toEqual([first.id, second.id]);
    expect(arg.items.map((i: any) => i.position)).toEqual([1, 2]);
    expect(arg.items.map((i: any) => i.specimen_id)).toEqual([first.specimen_id, second.specimen_id]);
  });

  it('an explicit centre_id in the actor scope is used as the worksheet centre; processing_centre_id stays the first row\'s; items copy BOTH', async () => {
    const r1 = row({ processing_centre_id: PROC });
    const c = ctxOf({ rows: [r1], scope: { all: false, centreIds: [CENTRE_A1, PROC] } });
    const r = await run('createWorksheet', post({ title: 'W', centre_id: CENTRE_A1, order_test_ids: [r1.id] }), c.ctx);
    expect([r.body.centre_id, r.body.processing_centre_id]).toEqual([CENTRE_A1, PROC]);
    expect(c.of('insertWorksheet')[0]!.arg.items[0]).toMatchObject({ centre_id: CENTRE_A1, processing_centre_id: PROC });
  });

  it('a centre_id outside the actor scope -> 403 auth.forbidden (not 404, not 400), nothing inserted; actor with all_centres may pick any centre of the tenant', async () => {
    const r1 = row({ processing_centre_id: PROC });
    const c = ctxOf({ rows: [r1], scope: { all: false, centreIds: [PROC] } });
    const e = await fail(run('createWorksheet', post({ title: 'W', centre_id: CENTRE_A2, order_test_ids: [r1.id] }), c.ctx));
    expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
    expect(c.of('insertWorksheet')).toHaveLength(0);
    const all = ctxOf({ rows: [r1], scope: { all: true, centreIds: [] } });
    expect((await run('createWorksheet', post({ title: 'W', centre_id: CENTRE_A2, order_test_ids: [r1.id] }), all.ctx)).body.centre_id).toBe(CENTRE_A2);
  });

  it('no centre_id and the first row has no processing centre -> 400 common.validation_failed at /centre_id, nothing inserted', async () => {
    const r1 = row({ processing_centre_id: null, status: 'awaiting_receipt' });
    const c = ctxOf({ rows: [r1] });
    const e = await fail(run('createWorksheet', post({ title: 'W', order_test_ids: [r1.id] }), c.ctx));
    expect(validationPath(e)).toEqual(['common.validation_failed', '/centre_id']);
    expect(c.of('insertWorksheet')).toHaveLength(0);
  });

  it('snapshot content (P-06): barcode, registration_no, test_code, priority, received_at only — no patient name / id / contact, no status, no result data', async () => {
    const r1 = row({ priority: 'urgent' });
    const c = ctxOf({ rows: [r1] });
    await run('createWorksheet', post({ title: 'W', order_test_ids: [r1.id] }), c.ctx);
    const snap = c.of('insertWorksheet')[0]!.arg.items[0].snapshot;
    expect(Object.keys(snap).sort()).toEqual(['barcode', 'priority', 'received_at', 'registration_no', 'test_code']);
    expect(snap.priority).toBe('urgent');
    expect(JSON.stringify(snap)).not.toMatch(/Synthetic|PC0001|patient|status/i);
    expect(c.demo).toHaveLength(0);                                                    // names are fetched at render, not at creation
  });

  it('validation: title 1..80, order_test_ids 1..200, uuid ids, unknown body fields -> 400 at the field, nothing read or inserted', async () => {
    const r1 = row();
    const c = ctxOf({ rows: [r1] });
    const cases: [unknown, string][] = [
      [{ order_test_ids: [r1.id] }, '/title'], [{ title: '', order_test_ids: [r1.id] }, '/title'], [{ title: 'x'.repeat(81), order_test_ids: [r1.id] }, '/title'],
      [{ title: 'W', order_test_ids: [] }, '/order_test_ids'], [{ title: 'W' }, '/order_test_ids'], [{ title: 'W', order_test_ids: Array.from({ length: 201 }, (_, i) => u(0x5000 + i)) }, '/order_test_ids'],
      [{ title: 'W', order_test_ids: ['not-a-uuid'] }, '/order_test_ids'],
    ];
    for (const [body, path] of cases) {
      const e = await fail(run('createWorksheet', post(body), c.ctx));
      expect(e.code, JSON.stringify(body).slice(0, 60)).toBe('common.validation_failed');
      expect((e.errors ?? []).some((x: any) => String(x.path).startsWith(path)), JSON.stringify(body).slice(0, 60)).toBe(true);   // '/order_test_ids' or '/order_test_ids/0'
    }
    expect(c.of('insertWorksheet')).toHaveLength(0);
  });

  it('exactly 200 ids is accepted (boundary); a title of exactly 80 chars is accepted', async () => {
    const rows = sheetRows(200);
    const r = await run('createWorksheet', post({ title: 'x'.repeat(80), order_test_ids: rows.map((x) => x.id) }), ctxOf({ rows }).ctx);
    expect([r.status, r.body.rows.length, r.body.title.length]).toEqual([201, 200, 80]);
  });

  it('P-01 / bulk ids: an id that does not exist, belongs to tenant B, or is outside the actor centre scope -> 404 common.not_found, NOTHING inserted (no partial sheet)', async () => {
    const mine = row({ centre_id: CENTRE_A1, processing_centre_id: CENTRE_A1 }), theirs = row({ tenant_id: OTHER_TENANT }), outside = row({ centre_id: CENTRE_A2, processing_centre_id: CENTRE_A2 });
    for (const [rows, extra, scope] of [[[mine, theirs], theirs.id, { all: true, centreIds: [] }], [[mine], u(0x9999), { all: true, centreIds: [] }], [[mine, outside], outside.id, { all: false, centreIds: [CENTRE_A1] }]] as const) {
      const c = ctxOf({ rows: [...rows], scope: { all: scope.all, centreIds: [...scope.centreIds] } });
      const e = await fail(run('createWorksheet', post({ title: 'W', order_test_ids: [mine.id, extra] }), c.ctx));
      expect([e.code, e.statusCode], extra).toEqual(['common.not_found', 404]);
      expect(c.of('insertWorksheet')).toHaveLength(0);
    }
  });

  it('duplicate ids never create two items for one test (rejected 400 /order_test_ids or collapsed)', async () => {
    const r1 = row(), r2 = row();
    const c = ctxOf({ rows: [r1, r2] });
    let outcome: any;
    try { outcome = await run('createWorksheet', post({ title: 'W', order_test_ids: [r1.id, r2.id, r1.id] }), c.ctx); } catch (e) { outcome = e; }
    if (outcome instanceof LimsError) expect(validationPath(outcome)).toEqual(['common.validation_failed', '/order_test_ids']);
    else expect(outcome.body.rows.map((x: any) => x.order_test_id)).toEqual([r1.id, r2.id]);
  });

  it('tenant comes from ctx only: tenant_id / created_by in the body never reach the store (rejected as unknown field or ignored); no event, no access row', async () => {
    const r1 = row();
    const c = ctxOf({ rows: [r1] });
    let e: any; try { await run('createWorksheet', post({ title: 'W', order_test_ids: [r1.id], tenant_id: 'EVIL', created_by: 'EVIL' }), c.ctx); } catch (x) { e = x; }
    if (e) expect(e.code).toBe('common.validation_failed');
    expect(JSON.stringify(c.calls)).not.toContain('EVIL');
    expect(c.calls.every((x) => x.tenantId === TENANT)).toBe(true);
    expect(c.published).toHaveLength(0);
    expect(c.access).toHaveLength(0);
  });
});

describe('T-26 listWorksheets (#21)', () => {
  const sheet = (n: number, over: Record<string, unknown> = {}, items = 2) => ({
    worksheet: { id: u(0xb000 + n), tenant_id: TENANT, centre_id: CENTRE_A1, processing_centre_id: PROC, title: `Sheet ${n}`, department_id: DEPT_D, instrument_id: INSTR, item_count: items, created_at: new Date(NOW.getTime() - n * HOUR), created_by: ACTOR, ...over },
    items: Array.from({ length: items }, (_, i) => ({ id: u(0xc000 + n * 10 + i), position: i + 1 })),
  });

  it('200 { data, page }: WorksheetSummary rows (row_count, no rows), newest first, allowlist keys; filters created_at_from/_to + department_id go to the store', async () => {
    const c = ctxOf({ worksheets: [sheet(3), sheet(1), sheet(2, { department_id: DEPT_E })] });
    const from = new Date(NOW.getTime() - 10 * HOUR).toISOString(), to = NOW.toISOString();
    const r = await run('listWorksheets', get({ created_at_from: from, created_at_to: to, department_id: DEPT_D }), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => d.id)).toEqual([u(0xb001), u(0xb003)]);
    expect(r.body.data[0]).toEqual({ id: u(0xb001), title: 'Sheet 1', centre_id: CENTRE_A1, processing_centre_id: PROC, department_id: DEPT_D, instrument_id: INSTR, created_at: new Date(NOW.getTime() - HOUR).toISOString(), row_count: 2 });
    for (const d of r.body.data) for (const k of Object.keys(d)) expect(keysOf(S.WorksheetSummary), k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_id|created_by|rows|snapshot/);
    expect(c.of('listWorksheets')[0]).toMatchObject({ tenantId: TENANT, arg: { createdAtFrom: expect.anything(), createdAtTo: expect.anything(), departmentId: DEPT_D } });
    expect(r.body.page).toEqual({ limit: 50 });
    expect(c.access).toHaveLength(0);
  });

  it('pagination and scope: limit 1 -> next_cursor; centre scope A1 hides a sheet of A2 even when the store leaks it; tenant B sheet never shown', async () => {
    const c = ctxOf({ worksheets: [sheet(1), sheet(2), sheet(3, { centre_id: CENTRE_A2, processing_centre_id: u(0xa398) }), sheet(4, { tenant_id: OTHER_TENANT })], scope: { all: false, centreIds: [CENTRE_A1] }, leaky: true });
    const r = await run('listWorksheets', get({ limit: 1 }), c.ctx);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const all = await run('listWorksheets', get(), c.ctx);
    expect(all.body.data.map((d: any) => d.id)).toEqual([u(0xb001), u(0xb002)]);
    expect(c.of('listWorksheets')[0]!.arg.scopeCentreIds).toEqual([CENTRE_A1]);
  });

  it('bad created_at_* (not an ISO UTC instant) -> 400 at the field, nothing read', async () => {
    const c = ctxOf({ worksheets: [sheet(1)] });
    expect(validationPath(await fail(run('listWorksheets', get({ created_at_from: 'yesterday' }), c.ctx)))).toEqual(['common.validation_failed', '/created_at_from']);
    expect(c.calls).toHaveLength(0);
  });
});

describe('T-26 getWorksheet (#22): the print view, worksheet.print access log, snapshot immutability', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    worksheet: { id: u(0xb100), tenant_id: TENANT, centre_id: CENTRE_A1, processing_centre_id: PROC, title: 'Print me', department_id: DEPT_D, instrument_id: INSTR, item_count: 2, created_at: NOW, created_by: ACTOR, ...over },
    items: [
      { id: u(0xc101), position: 2, order_test_id: u(0xd102), specimen_id: u(0xe102), centre_id: CENTRE_A1, processing_centre_id: PROC, snapshot: { barcode: 'E2600000102', registration_no: 'R2606150002', test_code: 'GLU', priority: 'urgent', received_at: NOW.toISOString() } },
      { id: u(0xc100), position: 1, order_test_id: u(0xd101), specimen_id: u(0xe101), centre_id: CENTRE_A1, processing_centre_id: PROC, snapshot: { barcode: 'E2600000101', registration_no: 'R2606150001', test_code: 'CBC', priority: 'routine', received_at: NOW.toISOString() } },
    ],
  });
  const WS = u(0xb100);

  it('200 WorksheetDto from the stored snapshot: rows by position, barcode + test_code, centre columns, no internals', async () => {
    const c = ctxOf({ worksheets: [stored()] });
    const r = await run('getWorksheet', get({}, { worksheet_id: WS }), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: WS, title: 'Print me', centre_id: CENTRE_A1, processing_centre_id: PROC, department_id: DEPT_D, instrument_id: INSTR, created_at: NOW.toISOString(),
      rows: [{ order_test_id: u(0xd101), position: 1, barcode: 'E2600000101', test_code: 'CBC' }, { order_test_id: u(0xd102), position: 2, barcode: 'E2600000102', test_code: 'GLU' }] });
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_id|created_by|snapshot|specimen_id/);
  });

  it('snapshot immutability: later changes to the live order test (status, code, barcode) do not change the sheet — #22 reads only the stored worksheet rows, never the live order tests', async () => {
    const live = row({ id: u(0xd101), test_code: 'CHANGED', status: 'verified', barcode: 'E2699999999' });
    const c = ctxOf({ worksheets: [stored()], rows: [live] });
    const r = await run('getWorksheet', get({}, { worksheet_id: WS }), c.ctx);
    expect(r.body.rows[0]).toMatchObject({ test_code: 'CBC', barcode: 'E2600000101' });
    expect(c.calls.map((x) => x.fn)).toEqual(['getWorksheet']);
    expect(JSON.stringify(r.body)).not.toMatch(/CHANGED|E2699999999/);
  });

  it('snapshot immutability end to end: create, then the live row changes, then get -> the created rows are returned unchanged', async () => {
    const live = row({ test_code: 'CBC', barcode: 'E2600000555' });
    const c = ctxOf({ rows: [live] });
    const made = await run('createWorksheet', post({ title: 'Snap', order_test_ids: [live.id] }), c.ctx);
    Object.assign(live, { test_code: 'ZZZ', barcode: 'E2600000999', status: 'approved' });
    const again = await run('getWorksheet', get({}, { worksheet_id: made.body.id }), c.ctx);
    expect(again.body.rows).toEqual(made.body.rows);
    expect(again.body.rows[0]).toMatchObject({ test_code: 'CBC', barcode: 'E2600000555' });
  });

  it('worksheet.print: exactly one access-log row per successful call (entity worksheet / worksheet id, outcome allowed), no title / barcode / patient data in it; a second call logs a second row', async () => {
    const c = ctxOf({ worksheets: [stored()] });
    await run('getWorksheet', get({}, { worksheet_id: WS }), c.ctx);
    expect(c.access).toHaveLength(1);
    expect(c.access[0]).toMatchObject({ action: 'worksheet.print', entityType: 'worksheet', entityId: WS, outcome: 'allowed' });
    expect(JSON.stringify(c.access)).not.toMatch(/Print me|E26000001|R2606150|CBC|Synthetic/);
    await run('getWorksheet', get({}, { worksheet_id: WS }), c.ctx);
    expect(c.access).toHaveLength(2);
  });

  it('P-01: unknown / other-tenant worksheet id -> 404 common.not_found, no access row', async () => {
    const c = ctxOf({ worksheets: [stored({ tenant_id: OTHER_TENANT })], leaky: false });
    for (const id of [u(0x9998), WS]) {
      const e = await fail(run('getWorksheet', get({}, { worksheet_id: id }), c.ctx));
      expect([e.code, e.statusCode], id).toEqual(['common.not_found', 404]);
    }
    expect(c.access).toHaveLength(0);
  });

  it('P-02: a worksheet of centre A2 for an A1-only actor is 404 (never 403) and is not logged; a worksheet whose processing centre is in scope is visible', async () => {
    const c = ctxOf({ worksheets: [stored({ centre_id: CENTRE_A2, processing_centre_id: u(0xa398) })], scope: { all: false, centreIds: [CENTRE_A1] } });
    const e = await fail(run('getWorksheet', get({}, { worksheet_id: WS }), c.ctx));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
    expect(c.access).toHaveLength(0);
    const viaProc = ctxOf({ worksheets: [stored({ centre_id: CENTRE_A2, processing_centre_id: CENTRE_A1 })], scope: { all: false, centreIds: [CENTRE_A1] } });
    expect((await run('getWorksheet', get({}, { worksheet_id: WS }), viaProc.ctx)).status).toBe(200);
  });

  it('read only: no write on the store, no event', async () => {
    const c = ctxOf({ worksheets: [stored()] });
    await run('getWorksheet', get({}, { worksheet_id: WS }), c.ctx);
    expect(c.published).toHaveLength(0);
    expect(c.calls.every((x) => x.fn === 'getWorksheet')).toBe(true);
  });
});

describe('T-26 perf (plan row: p95 <= 300 ms; REQ-SEC-025 includes the worklist) — handler + service CPU with a 200-row page and a warm instrument map; the database side is covered by the repository EXPLAIN test (T-03)', () => {
  it('listWorklistItems with instrument filter: 60 calls over 200 rows -> p95 <= 300 ms', async () => {
    const T = u(0x841), I = u(0x3a);
    const rows = Array.from({ length: 200 }, () => row({ test_id: T }));
    const c = ctxOf({ rows, analytes: { [T]: ['p1', 'p2'] }, unmapped: new Set(['p1']) });
    await run('listWorklistItems', get({ instrument_id: I, limit: 200 }), c.ctx);      // warm the cache
    const times: number[] = [];
    for (let i = 0; i < 60; i++) { const t0 = performance.now(); const r = await run('listWorklistItems', get({ instrument_id: I, limit: 200 }), c.ctx); times.push(performance.now() - t0); expect(r.body.data).toHaveLength(200); }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(times.length * 0.95) - 1]!).toBeLessThanOrEqual(300);
  });
  it('listPendingItems: 60 calls over 200 rows -> p95 <= 300 ms', async () => {
    const c = ctxOf({ rows: Array.from({ length: 200 }, () => row({ tat_target_seconds: 600 })) });
    const times: number[] = [];
    for (let i = 0; i < 60; i++) { const t0 = performance.now(); await run('listPendingItems', get({ limit: 200 }), c.ctx); times.push(performance.now() - t0); }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(times.length * 0.95) - 1]!).toBeLessThanOrEqual(300);
  });
});
