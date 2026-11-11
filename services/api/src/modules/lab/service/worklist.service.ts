// T-26: #18 listWorklistItems, #19 listPendingItems, #20 createWorksheet, #21 listWorksheets, #22 getWorksheet (02-TRD §5.3 rows 18-22; PRD AC-07.1-07.5; 07-SECURITY P-01, P-02, P-06).
// Tenant / actor from ctx only (REQ-SEC-024); the role is asserted here as defence in depth (AC-07.5); the store is never trusted (tenant + centre scope are re-checked per row, REQ-SEC-017).
// Store seam (ctx.store.*, repository/worklist.repo.ts) is wired like T-14/T-19 (open point in C5.T-26-impl.md).
// [CONV] worklist/pending/worksheet reads write NO access row except #22 `worksheet.print`; #20 stores a snapshot without patient data (P-06), names are fetched at render.
// [CONV] #18 instrument filter is applied after the page is read (cursor stays consistent, a filtered page may be short); the outbound code-map answers are cached per (tenant, instrument, test, analyte, catalog_revision).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { toResultDto } from '../mappers/result.mapper.js';
import { worklistStore } from '../store/worklist.store.js';
import { ageSex } from './label.service.js';
import { bad, isObj, scopeOf, strict, UUID, uuidParam, visible, type Obj } from './specimen.service.js';

interface Result { readonly status: number; readonly body: unknown }
interface Store {
  listWorklistRows(tx: unknown, tenantId: string, a: Obj): Promise<Obj[]>;
  listPendingRows(tx: unknown, tenantId: string, a: Obj): Promise<Obj[]>;
  getOrderTestsForWorksheet(tx: unknown, tenantId: string, ids: string[]): Promise<Obj[]>;
  insertWorksheet(tx: unknown, tenantId: string, a: { worksheet: Obj; items: Obj[] }): Promise<{ worksheet: Obj; items: Obj[] }>;
  listWorksheets(tx: unknown, tenantId: string, a: Obj): Promise<Obj[]>;
  getWorksheet(tx: unknown, tenantId: string, id: string): Promise<{ worksheet: Obj; items: Obj[] } | undefined>;
  listQueueRows(tx: unknown, tenantId: string, a: Obj): Promise<Obj[]>;
}
interface Ctx {
  tenantId: string; tx: object; actor: { id: string }; now(): Date; store: Store; audit: { access(e: Obj): Promise<void> };
  ports: {
    IdentityPort: { assertRole(c: unknown, r: { permission: string }): Promise<unknown>; getActor(c: unknown): Promise<{ centreScope?: { all?: boolean; centreIds?: readonly string[] } }> };
    FrontdeskPort?: { getPatientDemographicsBatch(c: unknown, i: { patientIds: string[]; purpose: string }): Promise<readonly Obj[]> };
    CatalogPort?: {
      getTest(c: unknown, i: { testId: string }): Promise<{ analytes?: readonly { id: string }[] }>;
      mapInstrumentCode(c: unknown, i: { instrumentId: string; direction: 'outbound'; analyteId: string; testId: string }): Promise<unknown>;
    };
  };
}

const READ = 'lab.worklist.read', MANAGE = 'lab.worksheet.manage', PRINT = 'worksheet.print';
const WORKLIST_STATUS = ['in_process', 'resulted', 'verified'], PENDING_STATUS = ['awaiting_collection', 'awaiting_receipt', 'in_process', 'resulted', 'verified'];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const KEY = /^[0-9A-Za-z:.|+ -]{1,64}$/;

/** fail closed: no tenant / actor / tx -> 401; production wiring (store, audit, identity port) missing -> 500. */
function ctxOf(h: unknown): Ctx {
  const c = h as Partial<Ctx> | null;
  if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  if (typeof c.audit?.access !== 'function' || !c.ports?.IdentityPort || typeof c.now !== 'function') throw new LimsError('common.internal');
  return (c.store ? c : Object.assign(Object.create(c), { store: worklistStore() })) as Ctx;   // LD-124: ctx.store ?? the production store (caller's tx, RLS guard)
}
const role = (c: Ctx, permission: string) => c.ports.IdentityPort.assertRole(c, { permission });
const omit = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const iso = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : new Date(v as string | number | Date).toISOString());
const present = (v: unknown): boolean => v !== null && v !== undefined;

// ---- query parsing (the core pattern is re-checked; fixed error texts, no value echoed) ----
const qOf = (q: unknown): Obj => (isObj(q) ? q : {});
function limitOf(q: Obj): number {
  const raw = q['limit'];
  if (raw === undefined) return 50;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
  return n;
}
function uuidQ(q: Obj, name: string): string | undefined {
  const v = q[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !UUID.test(v)) throw bad(`/${name}`);
  return v.toLowerCase();
}
function csvQ(q: Obj, name: string, allowed: readonly string[], dflt: readonly string[]): string[] {
  const v = q[name];
  if (v === undefined) return [...dflt];
  const parts = typeof v === 'string' ? v.split(',') : [];
  if (parts.length === 0 || parts.some((p) => !allowed.includes(p))) throw bad(`/${name}`);
  return [...new Set(parts)];
}
function instantQ(q: Obj, name: string): string | undefined {
  const v = q[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) throw bad(`/${name}`);
  return v;
}
function priorityQ(q: Obj): string | undefined {
  const v = q['priority'];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(v)) throw bad('/priority');
  return v;
}

// ---- keyset cursor: [tag, key, id] base64url (opaque to the client) ----
const encode = (tag: string, key: string, id: string): string => Buffer.from(JSON.stringify([tag, key, id]), 'utf8').toString('base64url');
function decode(raw: unknown, tag: string): { key: string; id: string } | undefined {
  if (raw === undefined) return undefined;
  const invalid = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw invalid();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!Array.isArray(v) || v.length !== 3 || v[0] !== tag || typeof v[1] !== 'string' || !KEY.test(v[1]) || typeof v[2] !== 'string' || !UUID.test(v[2])) throw invalid();
  return { key: v[1], id: v[2] };
}

type Scope = Awaited<ReturnType<typeof scopeOf>>;
const scopeIds = (s: Scope): string[] | undefined => (s.all ? undefined : [...s.centreIds]);

/** tenant + centre scope re-check, then cut the extra row that only proves "more" and build the page. */
function paged(rows: Obj[], c: Ctx, s: Scope, limit: number, tag: string, keyOf: (r: Obj) => string): { rows: Obj[]; page: Obj } {
  const more = rows.length > limit;
  const slice = rows.slice(0, limit);
  const last = slice[slice.length - 1];
  const kept = slice.filter((r) => r['tenant_id'] === c.tenantId && visible(s, r));
  return { rows: kept, page: { limit, ...(more && last ? { next_cursor: encode(tag, keyOf(last), String(last['id'])) } : {}) } };
}

// ---- patient_display (FrontdeskPort lab_display, never stored by C5) ----
async function patientDisplays(c: Ctx, rows: Obj[]): Promise<Map<string, Obj>> {
  const out = new Map<string, Obj>();
  const patientIds = [...new Set(rows.map((r) => r['patient_id'] as string))];
  if (patientIds.length === 0) return out;
  if (!c.ports.FrontdeskPort) throw new LimsError('common.internal');
  for (const d of await c.ports.FrontdeskPort.getPatientDemographicsBatch(c, { patientIds, purpose: 'lab_display' }))
    out.set(String(d['patientId']), { full_name: String(d['fullName'] ?? '').slice(0, 200), age_sex: ageSex(d as never), patient_code: String(d['patientCode'] ?? '').slice(0, 40) });
  return out;
}
const display = (m: Map<string, Obj>, r: Obj): Obj => m.get(r['patient_id']) ?? { full_name: '-', age_sex: '', patient_code: '' };   // invisible patient: the list still works

// ---- instrument filter: outbound map, cached (03-APP-FLOW §2.4) ----
// ponytail: process-local Map, cleared when full; share via Redis if more than one API node must warm together.
const MAP_CACHE = new Map<string, boolean>(), ANALYTE_CACHE = new Map<string, string[]>(), CACHE_MAX = 20_000;
const remember = <V>(m: Map<string, V>, k: string, v: V): V => { if (m.size >= CACHE_MAX) m.clear(); m.set(k, v); return v; };

async function onInstrument(c: Ctx, instrumentId: string, testId: string, revision: unknown): Promise<boolean> {
  const catalog = c.ports.CatalogPort;
  if (!catalog) throw new LimsError('common.internal');
  const aKey = `${c.tenantId}|${testId}|${revision}`;
  let analytes = ANALYTE_CACHE.get(aKey);
  if (!analytes) analytes = remember(ANALYTE_CACHE, aKey, ((await catalog.getTest(c, { testId })).analytes ?? []).map((a) => a.id));
  for (const analyteId of analytes) {
    const key = `${c.tenantId}|${instrumentId}|${testId}|${analyteId}|${revision}`;
    let mapped = MAP_CACHE.get(key);
    if (mapped === undefined) {
      try { await catalog.mapInstrumentCode(c, { instrumentId, direction: 'outbound', analyteId, testId }); mapped = true; }
      catch (e) { if (e instanceof LimsError && e.code === 'catalog.instrument_code_unmapped') mapped = false; else throw e; }   // anything else is not "not on this instrument"
      remember(MAP_CACHE, key, mapped);
    }
    if (mapped) return true;
  }
  return false;
}

// ---- #18 ----
export async function listWorklistItems(hctx: unknown, query: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  await role(c, READ);
  const q = qOf(query);
  const limit = limitOf(q);
  const statuses = csvQ(q, 'status', WORKLIST_STATUS, ['in_process', 'resulted']);
  const sort = q['sort'] === undefined ? 'priority_received' : q['sort'];
  if (sort !== 'priority_received' && sort !== 'received_at') throw bad('/sort');
  const departmentId = uuidQ(q, 'department_id'), processingCentreId = uuidQ(q, 'processing_centre_id'), instrumentId = uuidQ(q, 'instrument_id'), priority = priorityQ(q);
  const after = decode(q['cursor'], sort);
  const s = await scopeOf(c as never);
  const scopeCentreIds = scopeIds(s);
  const raw = await c.store.listWorklistRows(c.tx, c.tenantId, omit({ departmentId, priority, statuses, processingCentreId, sort, scopeCentreIds, limit: limit + 1, after }));
  const key = (r: Obj): string => `${sort === 'priority_received' && r['priority'] !== 'urgent' ? 1 : 0}|${iso(r['received_at'] ?? r['ordered_at'])}`;
  const { rows: scoped, page } = paged(raw, c, s, limit, sort, key);
  let rows = scoped;
  if (instrumentId) {
    const memo = new Map<string, boolean>(), keep: Obj[] = [];
    for (const r of rows) {
      const k = `${r['test_id']}|${r['catalog_revision']}`;
      let ok = memo.get(k);
      if (ok === undefined) { ok = await onInstrument(c, instrumentId, r['test_id'], r['catalog_revision']); memo.set(k, ok); }
      if (ok) keep.push(r);
    }
    rows = keep;
  }
  const names = await patientDisplays(c, rows);
  const data = rows.map((r) => omit({
    order_test_id: r['id'], order_id: r['order_id'], specimen_id: r['specimen_id'], barcode: r['barcode'], registration_no: r['registration_no'], patient_display: display(names, r),
    test_id: r['test_id'], test_code: r['test_code'], priority: r['priority'], status: r['status'], received_at: iso(r['received_at']),
    result_counts: { total: Number(r['result_total'] ?? 0), resulted: Number(r['result_resulted'] ?? 0), verified: Number(r['result_verified'] ?? 0) },
  }));
  return { status: 200, body: { data, page } };
}

// ---- #34 listVerificationQueue (02-TRD §5.4; T-32 / P-03 / P-10): stage verify = resulted rows, approve = verified rows; oldest result first, centre-scoped. ----
export async function listVerificationQueue(hctx: unknown, query: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  await role(c, 'lab.result.read');
  const q = qOf(query);
  const stage = q['stage'];
  if (stage !== 'verify' && stage !== 'approve') throw bad('/stage');
  const limit = limitOf(q);
  const f = q['flagged_only'];
  if (f !== undefined && f !== 'true' && f !== 'false' && typeof f !== 'boolean') throw bad('/flagged_only');
  const departmentId = uuidQ(q, 'department_id'), priority = priorityQ(q);
  const after = decode(q['cursor'], stage);
  const s = await scopeOf(c as never);
  const raw = await c.store.listQueueRows(c.tx, c.tenantId, omit({ status: stage === 'verify' ? 'resulted' : 'verified', departmentId, priority, flaggedOnly: f === true || f === 'true' ? true : undefined,
    scopeCentreIds: scopeIds(s), limit: limit + 1, after }));
  const { rows, page } = paged(raw, c, s, limit, stage, (r) => String(iso(r['queue_at'])));
  const names = await patientDisplays(c, rows);
  const data = rows.map((r) => omit({ result: toResultDto(r), registration_no: r['registration_no'], barcode: r['barcode'], patient_display: display(names, r), priority: r['order_priority'] }));
  return { status: 200, body: { data, page } };
}

// ---- #19 ----
export async function listPendingItems(hctx: unknown, query: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  await role(c, READ);
  const q = qOf(query);
  const limit = limitOf(q);
  const statuses = csvQ(q, 'item_status', PENDING_STATUS, PENDING_STATUS);
  const ot = q['over_target'];
  if (ot !== undefined && ot !== 'true' && ot !== 'false' && typeof ot !== 'boolean') throw bad('/over_target');
  const overTarget = ot === true || ot === 'true' ? true : undefined;
  const departmentId = uuidQ(q, 'department_id'), centreId = uuidQ(q, 'centre_id'), priority = priorityQ(q);
  const after = decode(q['cursor'], 'ordered_at');
  const s = await scopeOf(c as never);
  const now = c.now();
  const raw = await c.store.listPendingRows(c.tx, c.tenantId, omit({ departmentId, priority, statuses, centreId, overTarget, now, scopeCentreIds: scopeIds(s), limit: limit + 1, after }));
  const { rows, page } = paged(raw, c, s, limit, 'ordered_at', (r) => String(iso(r['ordered_at'])));
  const names = await patientDisplays(c, rows);
  const data = rows.map((r) => {
    const awaiting = String(r['status']).startsWith('awaiting');
    const anchor = (awaiting ? r['registered_at'] : r['received_at']) as Date | string | null | undefined;
    const age = present(anchor) ? Math.max(0, Math.floor((now.getTime() - new Date(anchor as Date | string).getTime()) / 1000)) : 0;
    const target = present(r['tat_target_seconds']) ? Number(r['tat_target_seconds']) : undefined;
    return omit({
      order_test_id: r['id'], order_id: r['order_id'], registration_no: r['registration_no'], patient_display: display(names, r), test_code: r['test_code'], item_status: r['status'],
      priority: r['priority'], centre_id: r['centre_id'], age_seconds: age, age_anchor: awaiting ? 'registered' : 'received', tat_target_seconds: target, over_target: target !== undefined && age > target,
    });
  });
  return { status: 200, body: { data, page } };
}

// ---- #20 ----
const rowDto = (items: readonly Obj[]): Obj[] => [...items].sort((a, b) => a['position'] - b['position']).map((i) => omit({
  order_test_id: i['order_test_id'], position: i['position'], barcode: i['snapshot']?.barcode, test_code: i['snapshot']?.test_code,
}));
const sheetHead = (w: Obj): Obj => omit({
  id: w['id'], title: w['title'], centre_id: w['centre_id'], processing_centre_id: w['processing_centre_id'], department_id: w['department_id'], instrument_id: w['instrument_id'], created_at: iso(w['created_at']),
});

export async function createWorksheet(hctx: unknown, body: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  await role(c, MANAGE);
  const b = strict(body, ['title', 'centre_id', 'department_id', 'instrument_id', 'order_test_ids']);
  const ids = b['order_test_ids'];
  if (typeof b['title'] !== 'string' || b['title'].trim() === '' || b['title'].length > 80 || b['title'].includes('\u0000')) throw bad('/title');
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200 || ids.some((x) => typeof x !== 'string' || !UUID.test(x))) throw bad('/order_test_ids');
  const want = (ids as string[]).map((x) => x.toLowerCase());
  if (new Set(want).size !== want.length) throw bad('/order_test_ids');                // never two items for one test
  const centreId = uuidQ(b, 'centre_id'), departmentId = uuidQ(b, 'department_id'), instrumentId = uuidQ(b, 'instrument_id');
  const s = await scopeOf(c as never);
  const found = new Map((await c.store.getOrderTestsForWorksheet(c.tx, c.tenantId, want)).filter((r) => r['tenant_id'] === c.tenantId && visible(s, r)).map((r) => [String(r['id']), r]));
  const rows = want.map((id) => found.get(id));
  if (rows.some((r) => !r)) throw new LimsError('common.not_found');                  // P-01: unknown / other tenant / out of scope, nothing inserted
  const first = rows[0] as Obj;
  const processing = first['processing_centre_id'] ?? undefined;
  const centre = centreId ?? processing;                                              // 08 R3 / #43: default = processing centre of the first row
  if (!centre) throw bad('/centre_id');
  if (!s.all && !s.centreIds.includes(centre)) throw new LimsError('auth.forbidden');
  const worksheetId = uuidv7(), actor = c.actor.id;
  const items = (rows as Obj[]).map((r, i) => omit({
    id: uuidv7(), worksheet_id: worksheetId, position: i + 1, order_test_id: r['id'], specimen_id: r['specimen_id'], centre_id: centre, processing_centre_id: processing, created_by: actor,
    snapshot: omit({ barcode: r['barcode'], registration_no: r['registration_no'], test_code: r['test_code'], priority: r['priority'], received_at: iso(r['received_at']) }),   // P-06: no patient data
  }));
  const saved = await c.store.insertWorksheet(c.tx, c.tenantId, {
    worksheet: omit({ id: worksheetId, centre_id: centre, processing_centre_id: processing, title: b['title'], department_id: departmentId, instrument_id: instrumentId, item_count: items.length, created_by: actor }) as Obj,
    items,
  });
  return { status: 201, body: { ...sheetHead(saved.worksheet), rows: rowDto(saved.items) } };
}

// ---- #21 ----
export async function listWorksheets(hctx: unknown, query: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  await role(c, READ);
  const q = qOf(query);
  const limit = limitOf(q);
  const createdAtFrom = instantQ(q, 'created_at_from'), createdAtTo = instantQ(q, 'created_at_to'), departmentId = uuidQ(q, 'department_id');
  const after = decode(q['cursor'], 'created_at');
  const s = await scopeOf(c as never);
  const raw = await c.store.listWorksheets(c.tx, c.tenantId, omit({ createdAtFrom, createdAtTo, departmentId, scopeCentreIds: scopeIds(s), limit: limit + 1, after }));
  const { rows, page } = paged(raw, c, s, limit, 'created_at', (r) => String(iso(r['created_at'])));
  return { status: 200, body: { data: rows.map((w) => ({ ...sheetHead(w), row_count: Number(w['item_count'] ?? 0) })), page } };
}

// ---- #22 ----
export async function getWorksheet(hctx: unknown, params: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  await role(c, READ);
  const id = uuidParam(params, 'worksheet_id');
  const s = await scopeOf(c as never);
  const found = await c.store.getWorksheet(c.tx, c.tenantId, id);                       // reads the stored snapshot only, never the live order tests (AC-07.4 immutability)
  if (!found || found.worksheet['tenant_id'] !== c.tenantId || !visible(s, found.worksheet)) throw new LimsError('common.not_found');   // P-01 / P-02: 404, never 403
  await c.audit.access({ action: PRINT, entityType: 'worksheet', entityId: id, ...(present(found.worksheet['centre_id']) ? { centreId: found.worksheet['centre_id'] } : {}), outcome: 'allowed' });
  return { status: 200, body: { ...sheetHead(found.worksheet), rows: rowDto(found.items) } };
}
