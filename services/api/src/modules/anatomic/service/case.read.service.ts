// Case reads — A1 listAnatomicCases, A2 lookupAnatomicObject, A3 getAnatomicCase (02-TRD §5 A1–A3, §5.7, §4.8, §12; 03-APP-FLOW §4.1).
// Read-only. Nothing submitted is echoed in an error; logs carry ids / error codes only (REQ-SEC-098). Access log: A3 anatomic_case.view, A2 anatomic_object.lookup
// (success only); A1 writes none (not a registered code, TRD §12).
import { LimsError, isLimsError } from '../../../core/errors.js';
import { CASE_KINDS, CASE_QUEUES, CASE_SORTS, type CaseQueue, type CaseSort } from '../domain/case.js';
import { canTransition, type CaseStatus } from '../domain/case.state.js';
import {
  toAddendum, toBlock, toCaseSummary, toGross, toImage, toItem, toOpenDraft, toPart, toPatientLine, toSlide, toStainOrder, toTransition, type Assignee, type PatientLine,
} from '../mappers/case.dto.js';
import { listAddenda } from '../repository/addenda.repo.js';
import { listBlocks } from '../repository/blocks.repo.js';
import { listCaseItems, listCasesPage, listCaseTransitions, lookupObjectByLabel } from '../repository/cases.repo.js';
import { listStains } from '../repository/config.repo.js';
import { getOpenDraft } from '../repository/drafts.repo.js';
import { listGrossRecords } from '../repository/gross.repo.js';
import { listImages } from '../repository/images.repo.js';
import { listMolecularResults } from '../repository/molecular.repo.js';
import { listParts } from '../repository/parts.repo.js';
import { listSlides } from '../repository/slides.repo.js';
import { listStainOrders } from '../repository/stainOrders.repo.js';
import { listItemSubmissions } from '../repository/submissions.repo.js';
import type { Row } from '../repository/_sql.js';
import { anatomicCtx, assertAt, bad, isObj, loadCase, strict, UUID } from './case.service.js';
import { labStatusByOrderItem, type LabCtx } from './labstatus.service.js';
import { loadAssay } from './molecular.service.js';
import type { AnatomicCtx } from './numbering.service.js';

type Obj = Record<string, unknown>;
type Result = { status: number; body: unknown };
interface ReadCtx extends AnatomicCtx {
  readonly actor: { readonly id: string; readonly membershipId?: string };
  readonly audit: { access(entry: Obj): Promise<void> };
  readonly core: AnatomicCtx['core'] & { user(c: unknown, i: { userId: string }): Promise<{ displayName: string }> };
  readonly ports: AnatomicCtx['ports'] & LabCtx['ports'] & {
    readonly FrontdeskPort: { getPatientDemographicsBatch(c: unknown, i: { patientIds: string[]; purpose: 'lab_display' }): Promise<ReadonlyArray<Row>> };
    readonly CatalogPort?: { getTest(c: unknown, i: { testId: string }): Promise<{ name: string }> };
  };
}
const readCtx = (h: unknown): ReadCtx => anatomicCtx(h) as ReadCtx;
const errCode = (e: unknown): string => (isLimsError(e) ? e.code : 'unknown');
const forbidden = (e: unknown): boolean => isLimsError(e) && e.code === 'auth.forbidden';
const dedupe = (xs: unknown[]): string[] => [...new Set(xs.filter((x): x is string => typeof x === 'string' && x !== ''))];

// ---- shared lookups ----
/** REQ-SEC-081: patient lines only for frontdesk.patient.read holders; one batched FrontdeskPort call; unavailable -> omitted ("omitted if unavailable", §5.7). */
async function patientLines(c: ReadCtx, patientIds: string[], centreId?: string): Promise<Map<string, PatientLine>> {
  const out = new Map<string, PatientLine>();
  const ids = dedupe(patientIds);
  if (!ids.length) return out;
  try {
    await c.ports.IdentityPort.assertRole(c, centreId ? { permission: 'frontdesk.patient.read', centreId } : { permission: 'frontdesk.patient.read' });
  } catch (e) { if (forbidden(e)) return out; throw e; }
  try {
    for (const d of await c.ports.FrontdeskPort.getPatientDemographicsBatch(c, { patientIds: ids, purpose: 'lab_display' })) {
      if (typeof d['patientId'] === 'string' && ids.includes(d['patientId'])) out.set(d['patientId'], toPatientLine(d));
    }
  } catch (e) { c.log.warn({ code: errCode(e) }, 'anatomic.patient_lines_unavailable'); out.clear(); }
  return out;
}
/** membership id -> display name (08 A17 P-17 via ctx.core); a failure leaves names out, it never fails the read. */
async function memberNames(c: ReadCtx, ids: unknown[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = dedupe(ids).filter((x) => UUID.test(x));
  for (let i = 0; i < want.length; i += 200) { // core caps one call at 200 ids
    try {
      const rows = await c.core.memberships.list(c, { membershipIds: want.slice(i, i + 200), activeOnly: false, limit: 200 } as never);
      for (const m of rows) if (want.includes(m.membershipId) && m.displayName) out.set(m.membershipId, m.displayName);
    } catch (e) { c.log.warn({ code: errCode(e) }, 'anatomic.member_names_unavailable'); }
  }
  return out;
}
const assigneeOf = (r: Row, names: Map<string, string>): Assignee | undefined => {
  const id = r['assigned_pathologist_membership_id'];
  const n = typeof id === 'string' ? names.get(id) : undefined;
  return n ? { membership_id: id, display_name: n } : undefined;
};
/** test_id -> name through CatalogPort (02-TRD §3: C11 reads no other schema); port errors pass through unchanged (08 P-23). */
async function testNames(c: ReadCtx, ids: unknown[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of dedupe(ids)) out.set(id, (await c.ports.CatalogPort!.getTest(c, { testId: id })).name);
  return out;
}

// ---- A1 listAnatomicCases ----
const DEFAULT_LIMIT = 50, MAX_LIMIT = 200, MAX_CENTRES = 20;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw bad(path);
  return v as T;
}
function csv<T extends string>(v: unknown, path: string, ok: (s: string) => boolean, max = 20): T[] {
  if (typeof v !== 'string') throw bad(path);
  const parts = v.split(',');
  if (parts.length > max || !parts.every(ok)) throw bad(path);
  return [...new Set(parts)] as T[];
}
function timestamp(v: unknown, path: string): string {
  if (typeof v !== 'string' || !ISO_TS.test(v) || Number.isNaN(Date.parse(v))) throw bad(path);
  return v;
}

/** cursor = base64url(JSON{ v:1, q: queue, s: sort, k: sort keys, i: id }) — opaque, bound to queue + sort, carries no authority (02-CV §4.3). */
const sortKeys = (sort: CaseSort, r: Row): string[] => {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? 'infinity'));
  if (sort === 'priority_received_at') return [r['priority'] === 'urgent' ? '0' : '1', ts(r['received_at'])];
  return [ts(sort.endsWith('received_at') ? r['received_at'] : r['accessioned_at'])];
};
const encodeCursor = (q: CaseQueue, s: CaseSort, r: Row): string => Buffer.from(JSON.stringify({ v: 1, q, s, k: sortKeys(s, r), i: r['id'] })).toString('base64url');
function decodeCursor(raw: unknown, q: CaseQueue, s: CaseSort): { keys: string[]; id: string } {
  const invalid = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!isObj(o) || o['v'] !== 1 || o['q'] !== q || o['s'] !== s || typeof o['i'] !== 'string' || !UUID.test(o['i']) || !Array.isArray(o['k'])) throw invalid();
  const k = o['k'] as unknown[];
  const tsOk = (v: unknown) => typeof v === 'string' && (CURSOR_TS.test(v) || (s.endsWith('accessioned_at') && v === 'infinity'));
  const ok = s === 'priority_received_at' ? k.length === 2 && (k[0] === '0' || k[0] === '1') && tsOk(k[1]) : k.length === 1 && tsOk(k[0]);
  if (!ok) throw invalid();
  return { keys: k as string[], id: o['i'] };
}

export async function listCases(hctx: unknown, query: unknown): Promise<Result> {
  const c = readCtx(hctx);
  const q = strict(query ?? {}, ['queue', 'case_kind', 'centre_id', 'priority', 'assigned_pathologist', 'received_at_from', 'received_at_to', 'sort', 'limit', 'cursor']);
  const queue = q['queue'] === undefined ? 'all' : oneOf(q['queue'], '/queue', CASE_QUEUES);
  const sort = q['sort'] === undefined ? 'priority_received_at' : oneOf(q['sort'], '/sort', CASE_SORTS);
  let limit = DEFAULT_LIMIT;
  if (q['limit'] !== undefined) {
    const raw = q['limit'];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : NaN; // query strings arrive as strings
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw bad('/limit');
    limit = n;
  }
  const input: Parameters<typeof listCasesPage>[1] = { tenantId: c.tenantId, queue, sort, limit: limit + 1 };
  if (q['case_kind'] !== undefined) input.caseKinds = csv(q['case_kind'], '/case_kind', (s) => (CASE_KINDS as readonly string[]).includes(s));
  if (q['centre_id'] !== undefined) input.centreIds = csv(q['centre_id'], '/centre_id', (s) => UUID.test(s), MAX_CENTRES);
  if (q['priority'] !== undefined) input.priority = csv(q['priority'], '/priority', (s) => s === 'routine' || s === 'urgent');
  if (q['assigned_pathologist'] !== undefined) {
    const a = q['assigned_pathologist'];
    if (a === 'me') {
      if (typeof c.actor.membershipId !== 'string' || !UUID.test(c.actor.membershipId)) throw bad('/assigned_pathologist');
      input.assignedMembershipId = c.actor.membershipId;
    } else if (typeof a === 'string' && UUID.test(a)) input.assignedMembershipId = a;
    else throw bad('/assigned_pathologist');
  }
  if (q['received_at_from'] !== undefined) input.receivedFrom = timestamp(q['received_at_from'], '/received_at_from');
  if (q['received_at_to'] !== undefined) input.receivedTo = timestamp(q['received_at_to'], '/received_at_to');
  if (q['cursor'] !== undefined) input.after = decodeCursor(q['cursor'], queue, sort);
  // the check is the route-level x-permission gate (anatomic.case.read), as for A12: there is no single centre to assert at; centre scoping is RLS (AC-13.2)

  const rows = await listCasesPage(c.tx, input); // the list never calls C5 per row (03-APP-FLOW §4.1 DECISION)
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? encodeCursor(queue, sort, page[page.length - 1]!) : null;
  const missing = page.filter((r) => !Array.isArray(r['test_names']));
  if (missing.length) {
    const names = await testNames(c, missing.flatMap((r) => (Array.isArray(r['test_ids']) ? r['test_ids'] : [])));
    for (const r of missing) r['test_names'] = ((r['test_ids'] ?? []) as string[]).map((id) => names.get(id) ?? '');
  }
  const patients = await patientLines(c, page.map((r) => r['patient_id']));
  const names = await memberNames(c, page.map((r) => r['assigned_pathologist_membership_id']));
  const data = page.map((r) => toCaseSummary(r, patients.get(r['patient_id']), assigneeOf(r, names)));
  return { status: 200, body: { data, page: { next_cursor: next, limit } } };
}

// ---- A2 lookupAnatomicObject ----
const LABEL = /^[A-Z0-9-]{1,32}$/;
export async function lookupObject(hctx: unknown, body: unknown): Promise<Result> {
  const c = readCtx(hctx);
  const b = strict(body, ['label']);
  const label = b['label'];
  if (typeof label !== 'string' || !LABEL.test(label)) throw bad('/label'); // label travels in the body, never in a URL or a log (REQ-SEC-098)
  const hit = await lookupObjectByLabel(c.tx, { tenantId: c.tenantId, label });
  if (!hit) throw new LimsError('common.not_found'); // unknown, other tenant, other centre (RLS): all identical
  await c.ports.IdentityPort.assertRole(c, { permission: 'anatomic.case.read', centreId: hit['centre_id'] });
  const out: Obj = { object_kind: hit['object_kind'], case_id: hit['case_id'] };
  if (hit['object_kind'] !== 'case' && hit['block_id']) out['block_id'] = hit['block_id'];
  if (hit['object_kind'] === 'slide' && hit['slide_id']) out['slide_id'] = hit['slide_id'];
  await c.audit.access({ action: 'anatomic_object.lookup', entityType: 'anatomic_case', entityId: hit['case_id'], centreId: hit['centre_id'], outcome: 'allowed' });
  return { status: 200, body: out };
}

// ---- A3 getAnatomicCase ----
const MAX_TRANSITIONS = 100;
/** operationIds the caller may run next: state table (TRD §7) x permission at the case centre. */
async function allowedActions(c: ReadCtx, cs: Row): Promise<string[]> {
  const holds = async (permission: string) => {
    try { await c.ports.IdentityPort.assertRole(c, { permission, centreId: cs['centre_id'] }); return true; } catch (e) { if (forbidden(e)) return false; throw e; }
  };
  const s = cs['status'] as CaseStatus;
  const out: string[] = [];
  if (await holds('anatomic.case.work')) {
    if (canTransition(s, 'accessioned')) out.push('accessionAnatomicCase');
    if (canTransition(s, 'in_processing')) out.push('startAnatomicProcessing');
    if (canTransition(s, 'ready_for_reporting')) out.push('markAnatomicCaseReady');
    if (canTransition(s, 'cancelled')) out.push('cancelAnatomicCase');
  }
  if (await holds('anatomic.case.signout')) {
    if (canTransition(s, 'signed_out') && s !== 'signed_out') out.push('signOutAnatomicCase');
    if (s === 'signed_out') out.push('startAnatomicCaseChange', 'createAnatomicAddendum');
  }
  return out;
}
async function stainDisplays(c: ReadCtx): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let offset = 0; ; offset += 500) {
    const rows = await listStains(c.tx, { tenantId: c.tenantId, limit: 500, offset });
    for (const r of rows) out.set(r['code'], r['display']);
    if (rows.length < 500) return out;
  }
}
async function molecularDtos(c: ReadCtx, rows: Row[]): Promise<Obj[]> {
  const assays = new Map<string, Awaited<ReturnType<typeof loadAssay>>>();
  const out: Obj[] = [];
  for (const r of rows) {
    if (r['is_active'] === false) continue;
    const ac = r['assay_code'] as string;
    if (!assays.has(ac)) assays.set(ac, await loadAssay(c, ac));
    const a = assays.get(ac), t = a?.targets.get(r['target_code']), v = t?.values.get(r['result_code']);
    const o: Obj = {
      id: r['id'], assay_code: ac, assay_display: a?.row['display'] ?? ac, target_code: r['target_code'], target_display: t?.row['display'] ?? r['target_code'],
      result_code: r['result_code'], result_display: v?.['display'] ?? r['result_code'], is_abnormal: !!v?.['is_abnormal'],
    };
    for (const k of ['value_decimal', 'unit_code', 'method_text', 'kit_name', 'kit_lot', 'batch_id', 'comment_text']) if (r[k] !== null && r[k] !== undefined) o[k] = r[k];
    if (r['kit_expiry_on']) o['kit_expiry_on'] = r['kit_expiry_on'] instanceof Date ? r['kit_expiry_on'].toISOString().slice(0, 10) : String(r['kit_expiry_on']).slice(0, 10);
    out.push(o);
  }
  return out;
}

export async function getCaseDetail(hctx: unknown, params: unknown): Promise<Result> {
  const c = readCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined); // malformed / invisible / other tenant -> 404
  await assertAt(c, 'anatomic.case.read', cs);
  const k = { tenantId: c.tenantId, caseId: cs['id'] as string };
  const [items, transitions, parts, gross, blocks, slides, stains, images, addenda, molecular, submissions, draft] = [
    await listCaseItems(c.tx, k), await listCaseTransitions(c.tx, k), await listParts(c.tx, k), await listGrossRecords(c.tx, k), await listBlocks(c.tx, k),
    await listSlides(c.tx, k), await listStainOrders(c.tx, k), await listImages(c.tx, { ...k, activeOnly: true }), await listAddenda(c.tx, k),
    await listMolecularResults(c.tx, { ...k, activeOnly: true }), await listItemSubmissions(c.tx, k), await getOpenDraft(c.tx, k),
  ];
  const lab = await labStatusByOrderItem(c, cs['order_id']); // per request, never cached (PHI P3); undefined = no lab.result.read
  const patients = await patientLines(c, [cs['patient_id']], cs['centre_id']);
  const names = await memberNames(c, [cs['assigned_pathologist_membership_id'], ...gross.map((g) => g['grossed_by_membership_id']),
    ...stains.map((s) => s['requested_by_membership_id']), ...addenda.map((a) => a['signed_by_membership_id'])]);
  const tests = await testNames(c, items.filter((i) => typeof i['test_name'] !== 'string').map((i) => i['test_id']));
  const stainNames = slides.length || stains.length ? await stainDisplays(c) : new Map<string, string>();

  const lastSubmitted = new Map<string, number>();
  for (const s of submissions) lastSubmitted.set(s['case_item_id'], Math.max(lastSubmitted.get(s['case_item_id']) ?? 0, Number(s['item_version_no'])));
  const recent = [...transitions].reverse().slice(0, MAX_TRANSITIONS); // newest first
  const users = new Map<string, string>();
  for (const id of dedupe(recent.map((t) => t['created_by']))) {
    try { users.set(id, (await c.core.user(c, { userId: id })).displayName); } catch (e) { if (!isLimsError(e)) throw e; } // ponytail: system actors have no user row -> 'System'
  }
  const grossByPart = new Map(gross.map((g) => [g['part_id'], g]));
  const blockLabel = new Map(blocks.map((b) => [b['id'], b['label']]));
  const pid = (k2: string, r: Row) => names.get(r[k2]);

  const body: Obj = toCaseSummary({ ...cs, part_count: parts.length, test_names: items.filter((i) => i['is_active'] !== false).map((i) => i['test_name'] ?? tests.get(i['test_id']) ?? ''),
    specimen_rejected: parts.some((p) => p['specimen_state'] === 'rejected'), open_change: !!draft && draft['kind'] !== 'initial',
    pending_stain_orders: stains.filter((s) => s['status'] === 'requested' || s['status'] === 'in_progress').length,
    parts_missing_site: parts.some((p) => !String(p['site_text'] ?? '').trim()) }, patients.get(cs['patient_id']), assigneeOf(cs, names));
  if (cs['clinical_history_text']) body['clinical_history_text'] = cs['clinical_history_text'];
  if (cs['branch_id']) body['branch_id'] = cs['branch_id'];
  Object.assign(body, {
    current_version_no: Number(cs['current_version_no'] ?? 0),
    parts: parts.map((p) => { const g = grossByPart.get(p['id']); return toPart(p, g ? toGross(g, pid('grossed_by_membership_id', g)) : undefined); }),
    blocks: blocks.map((b) => toBlock(b, slides.filter((s) => s['block_id'] === b['id']).length)),
    slides: slides.map((s) => toSlide(s, stainNames.get(s['stain_code']))),
    stain_orders: stains.map((s) => toStainOrder(s, stainNames.get(s['stain_code']), blockLabel.get(s['block_id']), pid('requested_by_membership_id', s))),
    images: images.filter((i) => i['is_active'] !== false).map(toImage),
    items: items.map((i) => toItem(i, i['test_name'] ?? tests.get(i['test_id']), lab?.get(i['order_item_id']), lastSubmitted.get(i['id']))),
    molecular_rev: Number(cs['molecular_rev'] ?? 0),
    molecular_results: await molecularDtos(c, molecular),
    addenda: addenda.map((a) => toAddendum(a, pid('signed_by_membership_id', a))),
    transitions: recent.map((t) => toTransition(t, users.get(t['created_by']) ?? 'System')),
    allowed_actions: await allowedActions(c, cs),
  });
  if (draft) body['open_draft'] = toOpenDraft(draft);
  await c.audit.access({ action: 'anatomic_case.view', entityType: 'anatomic_case', entityId: cs['id'], centreId: cs['centre_id'], outcome: 'allowed' });
  return { status: 200, body };
}
