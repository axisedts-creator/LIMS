// Molecular service — Q1 results, Q2–Q7 batches, A10 molecular guard (02-TRD §4.2 "batch" counter, §4.5.3, §5.5, §5.7, §7 C4; AC-11.1, 11.4–11.6).
// Every operation: load through the tenant-bound repository (404 if invisible) -> IdentityPort.assertRole -> validate -> write. The caller's transaction (requestTx) rolls back on any throw.
// No submitted value is echoed in an error and nothing is logged (REQ-SEC-098; comment_text is P3 data).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { accessionYearAd } from '../domain/accession-pattern.js';
import { assertTransition, type CaseStatus } from '../domain/case.state.js';
import { validateMolecularResult, type AssayDefinition } from '../domain/molecular.js';
import { getBatch, insertBatch, insertBatchMember, listBatches, listBatchMembers, updateBatch, updateBatchMember } from '../repository/batches.repo.js';
import { getCase, insertCaseTransition, updateCase } from '../repository/cases.repo.js';
import * as cfg from '../repository/config.repo.js';
import { bumpAccessionCounter } from '../repository/counters.repo.js';
import { getOpenDraft } from '../repository/drafts.repo.js';
import { insertMolecularResult, listMolecularResults, updateMolecularResult } from '../repository/molecular.repo.js';
import { listParts } from '../repository/parts.repo.js';
import type { Row } from '../repository/_sql.js';
import { anatomicCtx, assertAt, bad, caseDto, isObj, iso, loadCase, put, strict, text, UUID, uuid } from './case.service.js';
import { decodeCursor, encodeCursor, ifMatch } from './config.service.js';
import type { AnatomicCtx } from './numbering.service.js';

type Obj = Record<string, unknown>;
type Result = { status: number; body: unknown };

const CODE = /^[A-Z0-9_]{1,32}$/, RESULT_CODE = /^[a-z0-9_]{1,32}$/;
const fe = (path: string): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' });
const MAX = 500;

// ---- field parsers (shape only; the assay rules live in domain/molecular.ts) ----
const must = <T>(o: Obj, k: string, p: string, f: (v: unknown, path: string) => T): T => { if (o[k] === undefined) throw bad(`${p}/${k}`); return f(o[k], `${p}/${k}`); };
const may = <T>(o: Obj, k: string, p: string, f: (v: unknown, path: string) => T): T | undefined => (o[k] === undefined ? undefined : f(o[k], `${p}/${k}`));
const code = (re: RegExp) => (v: unknown, p: string): string => { const s = text(v, p, 32, 1); if (!re.test(s)) throw bad(p); return s; };
const label = (max: number) => (v: unknown, p: string): string => text(v, p, max, 1);
function isoDate(v: unknown, p: string): string {
  const s = text(v, p, 10, 10);
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(p);
  return s;
}
function isoUtc(v: unknown, p: string): string {
  const s = text(v, p, 40, 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(s) || Number.isNaN(Date.parse(s))) throw bad(p);
  return s;
}
/** pg returns `date` as a local-midnight Date; the mocks and text columns return a string */
function dateOnly(v: unknown): string | undefined {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return typeof v === 'string' ? v.slice(0, 10) : undefined;
}
const ver = (r: Row): number => Number(r['version']);
const dup = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === '23505';
const audit = (c: AnatomicCtx) => ({ id: uuidv7(), tenant_id: c.tenantId, created_by: c.actor.id, updated_by: c.actor.id });
const sentinel = (c: AnatomicCtx, permission: 'anatomic.case.work' | 'anatomic.case.read') => c.ports.IdentityPort.assertRole(c, { permission });

// ---- assay lookup (Q1, Q2, Q3) ----
interface AssayInfo { row: Row; def: AssayDefinition; targets: Map<string, { row: Row; values: Map<string, Row> }> }
/** ponytail: linear scan over the assay list (a tenant holds a handful); add a code-keyed repo lookup if that ever changes. */
async function findAssay(c: AnatomicCtx, assayCode: string): Promise<Row | undefined> {
  for (let offset = 0; ; offset += MAX) {
    const rows = await cfg.listAssays(c.tx, { tenantId: c.tenantId, limit: MAX, offset });
    const hit = rows.find((r) => r['code'] === assayCode);
    if (hit || rows.length < MAX) return hit;
  }
}
export async function loadAssay(c: AnatomicCtx, assayCode: string): Promise<AssayInfo | undefined> {
  const row = await findAssay(c, assayCode);
  if (!row) return undefined;
  const targets: AssayInfo['targets'] = new Map();
  const def: AssayDefinition = { code: row['code'], is_active: !!row['is_active'], targets: [] };
  for (const t of await cfg.listAssayTargets(c.tx, { tenantId: c.tenantId, assayId: row['id'] })) {
    const values = await cfg.listAssayTargetValues(c.tx, { tenantId: c.tenantId, targetId: t['id'] });
    targets.set(t['code'], { row: t, values: new Map(values.map((v) => [v['code'], v])) });
    def.targets.push({
      code: t['code'], is_active: !!t['is_active'], allows_quantitative: !!t['allows_quantitative'],
      ...(t['unit_code'] != null ? { unit_code: t['unit_code'] } : {}), ...(t['decimals'] != null ? { decimals: Number(t['decimals']) } : {}),
      result_values: values.map((v) => ({ code: v['code'], display: v['display'], is_abnormal: !!v['is_abnormal'], is_active: !!v['is_active'] })),
    });
  }
  return { row, def, targets };
}

// ---- Q1 saveAnatomicMolecularResults ----
const RESULT_KEYS = ['assay_code', 'target_code', 'result_code', 'value_decimal', 'unit_code', 'method_text', 'kit_name', 'kit_lot', 'kit_expiry_on', 'batch_id', 'comment_text'] as const;
function parseResult(raw: unknown, n: number): Obj {
  const p = `/results/${n}`, r = strict(raw, RESULT_KEYS, p);
  const o: Obj = { assay_code: must(r, 'assay_code', p, code(CODE)), target_code: must(r, 'target_code', p, code(CODE)), result_code: must(r, 'result_code', p, code(RESULT_CODE)) };
  for (const [k, f] of [
    ['value_decimal', (v: unknown, q: string) => text(v, q, 20)], ['unit_code', label(32)], ['method_text', label(200)], ['kit_name', label(120)], ['kit_lot', label(64)],
    ['kit_expiry_on', isoDate], ['batch_id', uuid], ['comment_text', label(1000)],
  ] as const) {
    const v = may(r, k, p, f);
    if (v !== undefined) o[k] = v;
  }
  return o;
}

export async function saveResults(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined);
  await assertAt(c, 'anatomic.case.work', cs);
  if (cs['case_kind'] !== 'molecular' || cs['status'] === 'cancelled') throw new LimsError('anatomic.case_invalid_transition');
  if (cs['status'] === 'signed_out' && !(await getOpenDraft(c.tx, { tenantId: c.tenantId, caseId: cs['id'] }))) throw new LimsError('anatomic.signout_locked'); // D-66 (b)
  const rev = ifMatch(headers); // molecular_rev; "0" is valid
  const b = strict(body, ['results']);
  if (!Array.isArray(b['results']) || b['results'].length > 50) throw bad('/results');
  const rows = b['results'].map(parseResult);

  // validate every row against the assay definition; collect all errors (AC-11.1–11.3)
  const errors: FieldError[] = [], seen = new Set<string>(), assays = new Map<string, AssayInfo | undefined>(), batches = new Map<string, Row | undefined>();
  const plan: { in: Obj; assay: AssayInfo; target: Row; value: Row }[] = [];
  for (const [n, r] of rows.entries()) {
    const p = `/results/${n}`, ac = r['assay_code'] as string;
    if (!assays.has(ac)) assays.set(ac, await loadAssay(c, ac));
    const assay = assays.get(ac);
    if (!assay) { errors.push(fe(`${p}/assay_code`)); continue; }
    const chk = validateMolecularResult(assay.def, r as never);
    if (!chk.ok) for (const e of chk.errors) errors.push(fe(p + e.path));
    if (r['batch_id'] !== undefined) {
      const id = r['batch_id'] as string;
      if (!batches.has(id)) batches.set(id, await getBatch(c.tx, { tenantId: c.tenantId, id }));
      if (!batches.get(id)) errors.push(fe(`${p}/batch_id`));
    }
    if (!chk.ok) continue;
    const key = `${ac}|${r['target_code']}`;
    if (seen.has(key)) { errors.push(fe(`${p}/target_code`)); continue; } // one active result per case and target
    seen.add(key);
    const t = assay.targets.get(r['target_code'] as string)!;
    plan.push({ in: r, assay, target: t.row, value: t.values.get(r['result_code'] as string)! });
  }
  if (errors.length) throw new LimsError('common.validation_failed', undefined, errors);

  if (Number(cs['molecular_rev']) !== rev) throw new LimsError('common.version_conflict');
  // the molecular_rev bump is the serialisation point: a lost race is a version_conflict, never a raw unique violation
  const updated = await updateCase(c.tx, { tenantId: c.tenantId, id: cs['id'], expectedVersion: ver(cs), actorId: c.actor.id, patch: { molecular_rev: rev + 1 } });
  if (!updated) throw new LimsError('common.version_conflict');
  for (const old of await listMolecularResults(c.tx, { tenantId: c.tenantId, caseId: cs['id'], activeOnly: true })) { // full replace; history is kept
    if (!(await updateMolecularResult(c.tx, { tenantId: c.tenantId, id: old['id'], expectedVersion: ver(old), actorId: c.actor.id, patch: { is_active: false } }))) throw new LimsError('common.version_conflict');
  }
  const results: Obj[] = [];
  for (const p of plan) {
    const i = p.in;
    let row: Row;
    try {
      row = await insertMolecularResult(c.tx, {
        ...audit(c), centre_id: cs['centre_id'], case_id: cs['id'], assay_id: p.assay.row['id'], assay_code: i['assay_code'], target_id: p.target['id'], target_code: i['target_code'],
        result_value_id: p.value['id'], result_code: i['result_code'], value_decimal: i['value_decimal'], unit_code: i['unit_code'], method_text: i['method_text'], kit_name: i['kit_name'],
        kit_lot: i['kit_lot'], kit_expiry_on: i['kit_expiry_on'], batch_id: i['batch_id'], comment_text: i['comment_text'],
      });
    } catch (e) { throw dup(e) ? new LimsError('common.version_conflict') : e; }
    const o: Obj = {
      id: row['id'], assay_code: row['assay_code'], assay_display: p.assay.row['display'], target_code: row['target_code'], target_display: p.target['display'],
      result_code: row['result_code'], result_display: p.value['display'], is_abnormal: !!p.value['is_abnormal'],
    };
    for (const k of ['value_decimal', 'unit_code', 'method_text', 'kit_name', 'kit_lot', 'batch_id', 'comment_text']) put(o, k, row[k]);
    put(o, 'kit_expiry_on', dateOnly(row['kit_expiry_on']));
    if (i['batch_id'] !== undefined) put(o, 'batch_no', batches.get(i['batch_id'] as string)?.['batch_no']);
    results.push(o);
  }
  results.sort((x, y) => (String(x['target_code']) < String(y['target_code']) ? -1 : String(x['target_code']) > String(y['target_code']) ? 1 : 0));
  return { status: 200, body: { molecular_rev: Number(updated['molecular_rev']), results } };
}

// ---- batch DTOs ----
const batchDto = (b: Row, assayCode: string, memberCount: number): Obj => {
  const o: Obj = { id: b['id'], batch_no: b['batch_no'], assay_code: assayCode, status: b['status'], capacity: Number(b['capacity']), member_count: memberCount, version: ver(b) };
  for (const k of ['kit_name', 'kit_lot', 'instrument_text']) put(o, k, b[k]);
  put(o, 'kit_expiry_on', dateOnly(b['kit_expiry_on'])); put(o, 'run_at', iso(b['run_at']));
  return o;
};
async function assayCodeOf(c: AnatomicCtx, b: Row): Promise<string> {
  const a = await cfg.getAssay(c.tx, { tenantId: c.tenantId, id: b['assay_id'] });
  if (!a) throw new LimsError('common.internal');
  return a['code'];
}
/** ponytail: one getCase per member (<= 384); join the accession numbers in the repo if batch screens get slow. */
async function batchDetail(c: AnatomicCtx, b: Row): Promise<Obj> {
  const members = await listBatchMembers(c.tx, { tenantId: c.tenantId, batchId: b['id'], activeOnly: true });
  const out: Obj = batchDto(b, await assayCodeOf(c, b), members.length);
  out['members'] = [];
  for (const m of members) {
    const mc = await getCase(c.tx, { tenantId: c.tenantId, caseId: m['case_id'] });
    const o: Obj = { case_id: m['case_id'] };
    put(o, 'accession_no', mc?.['accession_no']); o['position'] = Number(m['position']);
    (out['members'] as Obj[]).push(o);
  }
  return out;
}
async function loadBatch(c: AnatomicCtx, params: unknown, forUpdate = false): Promise<Row> {
  const id = isObj(params) ? params['batch_id'] : undefined;
  if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
  const b = await getBatch(c.tx, { tenantId: c.tenantId, id, forUpdate });
  if (!b) throw new LimsError('common.not_found');
  return b;
}
const assertOpen = (b: Row): void => { if (b['status'] === 'closed') throw new LimsError('anatomic.batch_closed'); };

// ---- Q2 listAnatomicBatches ----
export async function listAllBatches(hctx: unknown, query: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  await sentinel(c, 'anatomic.case.read');
  const q = strict(query ?? {}, ['status', 'assay_code', 'limit', 'cursor']);
  let status: string | undefined;
  if (q['status'] !== undefined) {
    const parts = typeof q['status'] === 'string' ? q['status'].split(',') : [];
    if (!parts.length || parts.some((s) => s !== 'open' && s !== 'closed')) throw bad('/status');
    status = new Set(parts).size === 1 ? parts[0] : undefined; // open,closed = no filter
  }
  const assayCode = may(q, 'assay_code', '', code(CODE));
  let limit = 50;
  if (q['limit'] !== undefined) {
    const raw = q['limit'], n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
    limit = n;
  }
  const offset = q['cursor'] === undefined ? 0 : decodeCursor(q['cursor']);
  let assayId: string | undefined;
  if (assayCode !== undefined) {
    assayId = (await findAssay(c, assayCode))?.['id'];
    if (!assayId) return { status: 200, body: { data: [], page: { limit } } }; // unknown assay: nothing matches
  }
  const rows = await listBatches(c.tx, { tenantId: c.tenantId, ...(status ? { status } : {}), ...(assayId ? { assayId } : {}), limit: limit + 1, offset });
  const codes = new Map<string, string>(), data: Obj[] = [];
  for (const b of rows.slice(0, limit)) {
    if (!codes.has(b['assay_id'])) codes.set(b['assay_id'], await assayCodeOf(c, b));
    const members = await listBatchMembers(c.tx, { tenantId: c.tenantId, batchId: b['id'], activeOnly: true }); // ponytail: N+1, <= 200 per page
    data.push(batchDto(b, codes.get(b['assay_id'])!, members.length));
  }
  return { status: 200, body: { data, page: { limit, ...(rows.length > limit ? { next_cursor: encodeCursor(offset + limit) } : {}) } } };
}

// ---- Q3 createAnatomicBatch ----
export async function createBatch(hctx: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  await sentinel(c, 'anatomic.case.work');
  const b = strict(body, ['assay_code', 'kit_name', 'kit_lot', 'kit_expiry_on', 'instrument_text', 'run_at', 'capacity']);
  const assayCode = must(b, 'assay_code', '', code(CODE));
  const row: Row = { kit_name: may(b, 'kit_name', '', label(120)), kit_lot: may(b, 'kit_lot', '', label(64)), kit_expiry_on: may(b, 'kit_expiry_on', '', isoDate), instrument_text: may(b, 'instrument_text', '', label(120)), run_at: may(b, 'run_at', '', isoUtc) };
  if (b['capacity'] !== undefined) {
    const n = b['capacity'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 384) throw bad('/capacity');
    row['capacity'] = n;
  }
  const assay = await findAssay(c, assayCode);
  if (!assay || !assay['is_active']) throw bad('/assay_code');
  // validation is done: only now consume a number (a rolled-back request gives it back)
  let yearAd: number;
  try {
    const tz = (await c.ports.IdentityPort.getTenantSettings(c, { keys: ['timezone'] }))['timezone'];
    yearAd = accessionYearAd(c.now(), String(tz));
  } catch { throw new LimsError('common.internal'); } // bad tz: never fall back to UTC
  const seq = await bumpAccessionCounter(c.tx, { tenantId: c.tenantId, seriesKey: 'batch', yearAd, actorId: c.actor.id });
  if (seq > 9999) throw new LimsError('anatomic.accession_pattern_invalid');
  const batch = await insertBatch(c.tx, { ...audit(c), ...row, batch_no: `MB${String(yearAd % 100).padStart(2, '0')}${String(seq).padStart(4, '0')}`, assay_id: assay['id'] });
  return { status: 201, body: batchDto(batch, assayCode, 0) };
}

// ---- Q4 getAnatomicBatch ----
export async function getBatchDetail(hctx: unknown, params: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const b = await loadBatch(c, params);
  await sentinel(c, 'anatomic.case.read');
  return { status: 200, body: await batchDetail(c, b) };
}

// ---- Q5 addAnatomicBatchMembers ----
export async function addMembers(hctx: unknown, params: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const b = await loadBatch(c, params, true);
  await sentinel(c, 'anatomic.case.work');
  const raw = strict(body, ['members'])['members'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 96) throw bad('/members');
  const capacity = Number(b['capacity']), ids = new Set<string>();
  const members = raw.map((m, n) => {
    const p = `/members/${n}`, o = strict(m, ['case_id', 'position'], p);
    const caseId = must(o, 'case_id', p, uuid), position = o['position'];
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 1 || position > capacity) throw bad(`${p}/position`);
    if (ids.has(caseId)) throw bad(`${p}/case_id`);
    ids.add(caseId);
    return { caseId, position };
  });
  assertOpen(b); // before anything else is looked at (AC-11.5)
  for (const m of members) { // unknown / other-tenant id -> 404 for the call; every case checked at its own centre
    const cs = await getCase(c.tx, { tenantId: c.tenantId, caseId: m.caseId });
    if (!cs) throw new LimsError('common.not_found');
    await assertAt(c, 'anatomic.case.work', cs);
  }
  const taken = new Set((await listBatchMembers(c.tx, { tenantId: c.tenantId, batchId: b['id'], activeOnly: true })).map((m) => Number(m['position'])));
  const wanted = new Set<number>();
  for (const m of members) {
    if (taken.has(m.position) || wanted.has(m.position)) throw new LimsError('anatomic.batch_position_taken');
    wanted.add(m.position);
  }
  for (const m of members) {
    try {
      await insertBatchMember(c.tx, { ...audit(c), batch_id: b['id'], case_id: m.caseId, position: m.position });
    } catch (e) { // the unique indexes are the final word (parallel adds): (batch, position) -> taken; (batch, case) -> the case is already in
      if (dup(e)) throw String((e as { constraint?: unknown }).constraint).includes('position') ? new LimsError('anatomic.batch_position_taken') : bad('/members');
      throw e;
    }
  }
  return { status: 200, body: await batchDetail(c, b) };
}

// ---- Q6 removeAnatomicBatchMembers ----
export async function removeMembers(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const b = await loadBatch(c, params, true);
  await sentinel(c, 'anatomic.case.work');
  const version = ifMatch(headers);
  const raw = strict(body, ['case_ids'])['case_ids'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 96) throw bad('/case_ids');
  const caseIds = raw.map((v, n) => uuid(v, `/case_ids/${n}`));
  if (new Set(caseIds).size !== caseIds.length) throw bad('/case_ids');
  assertOpen(b);
  if (ver(b) !== version) throw new LimsError('common.version_conflict');
  const active = await listBatchMembers(c.tx, { tenantId: c.tenantId, batchId: b['id'], activeOnly: true });
  const hits = caseIds.map((id) => active.find((m) => m['case_id'] === id));
  if (hits.some((m) => !m)) throw new LimsError('common.not_found'); // per-id not_found, nothing removed
  const now = c.now().toISOString();
  for (const m of hits as Row[]) { // soft delete frees the position
    if (!(await updateBatchMember(c.tx, { tenantId: c.tenantId, id: m['id'], expectedVersion: ver(m), actorId: c.actor.id, patch: { is_active: false, removed_at: now } }))) throw new LimsError('common.version_conflict');
  }
  return { status: 200, body: await batchDetail(c, b) };
}

// ---- Q7 closeAnatomicBatch ----
export async function closeBatch(hctx: unknown, params: unknown, headers: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const b = await loadBatch(c, params, true);
  await sentinel(c, 'anatomic.case.work');
  const version = ifMatch(headers);
  assertOpen(b);
  if (ver(b) !== version) throw new LimsError('common.version_conflict');
  const updated = await updateBatch(c.tx, { tenantId: c.tenantId, id: b['id'], expectedVersion: version, actorId: c.actor.id, patch: { status: 'closed', closed_at: c.now().toISOString() } });
  if (!updated) throw new LimsError('common.version_conflict');
  return { status: 200, body: await batchDetail(c, updated) };
}

// ---- A10 markAnatomicCaseReady, molecular branch (C4: >= 1 active molecular result) ----
/** undefined = not a molecular case: the histology/cytology/ihc guard (>= 1 slide ready) belongs to C11 T-08. */
export async function markMolecularReady(hctx: unknown, params: unknown, headers: unknown): Promise<Result | undefined> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined);
  await assertAt(c, 'anatomic.case.work', cs);
  if (cs['case_kind'] !== 'molecular') return undefined;
  const version = ifMatch(headers);
  if (ver(cs) !== version) throw new LimsError('common.version_conflict');
  assertTransition(cs['status'] as CaseStatus, 'ready_for_reporting');
  if (cs['status'] !== 'in_processing' || (await listMolecularResults(c.tx, { tenantId: c.tenantId, caseId: cs['id'], activeOnly: true })).length < 1) throw new LimsError('anatomic.case_invalid_transition');
  const updated = await updateCase(c.tx, { tenantId: c.tenantId, id: cs['id'], expectedVersion: version, actorId: c.actor.id, patch: { status: 'ready_for_reporting' } });
  if (!updated) throw new LimsError('common.version_conflict');
  await insertCaseTransition(c.tx, { id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], from_status: cs['status'], to_status: 'ready_for_reporting', created_by: c.actor.id });
  return { status: 200, body: caseDto(updated, await listParts(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })) };
}
