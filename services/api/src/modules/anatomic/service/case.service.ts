// Case service — A4 accession, A5 details, A6/A7 parts, A12 assignees (02-TRD §5 "Every handler" rule, D-66 signout_locked, §6.2, §7 C2).
// Every operation: load through the tenant-bound repository (404 if invisible) -> IdentityPort.assertRole(permission, centreId: case.centre_id) -> validate -> write.
// No submitted value is echoed in an error and nothing is logged (REQ-SEC-098). The caller's transaction (requestTx) rolls back on any throw.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { assertTransition, type CaseStatus } from '../domain/case.state.js';
import type { CaseKind } from '../domain/case.js';
import { partLetter } from '../domain/labels.js';
import { getCase, insertCaseTransition, updateCase } from '../repository/cases.repo.js';
import { getOpenDraft } from '../repository/drafts.repo.js';
import { getPart, insertPart, listParts, updatePart } from '../repository/parts.repo.js';
import { getSpecimenLinkBySpecimen } from '../repository/specimenLinks.repo.js';
import type { Row } from '../repository/_sql.js';
import { allocateAccessionNumber, type AnatomicCtx } from './numbering.service.js';

type Obj = Record<string, unknown>;
type Result = { status: number; body: unknown };

const MAX_PARTS = 52;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- helpers ----
export function anatomicCtx(c: unknown): AnatomicCtx {
  const x = c as Partial<AnatomicCtx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || typeof x.now !== 'function' || !x.ports?.IdentityPort || !x.core) {
    throw new LimsError('auth.unauthenticated');
  }
  return x as AnatomicCtx;
}
export const bad = (...paths: string[]): LimsError => new LimsError('common.validation_failed', undefined,
  paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Closed object (AB-5): any key outside `allowed` -> 400 common.unknown_field, the value is never echoed. */
export function strict(v: unknown, allowed: readonly string[], path = ''): Obj {
  if (!isObj(v)) throw bad(path);
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [{ path: `${path}/${k}`, code: 'common.unknown_field', message: 'Unknown field' }]);
  }
  return v;
}
export const uuid = (v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(path); return v; };
export function text(v: unknown, path: string, max: number, min = 0): string {
  if (typeof v !== 'string' || v.includes('\u0000') || v.length > max || [...v].length < min) throw bad(path);
  return v;
}
/** If-Match: "<version>" (02-CV §4.2). Absent -> 428; malformed -> 400. */
function expectedVersion(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) throw bad('/headers/if-match');
  return Number(m[1]);
}

export async function loadCase(c: AnatomicCtx, caseId: unknown, forUpdate = false): Promise<Row> {
  if (typeof caseId !== 'string' || !UUID.test(caseId)) throw new LimsError('common.not_found');
  const row = await getCase(c.tx, { tenantId: c.tenantId, caseId, forUpdate });
  if (!row) throw new LimsError('common.not_found'); // RLS / other tenant look the same
  return row;
}
export const assertAt = (c: AnatomicCtx, permission: 'anatomic.case.work' | 'anatomic.case.read', cs: Row) =>
  c.ports.IdentityPort.assertRole(c, { permission, centreId: cs['centre_id'] });

export const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined);
export const put = (o: Obj, k: string, v: unknown): void => { if (v !== null && v !== undefined) o[k] = v; }; // no null on the wire

export function partDto(p: Row): Obj {
  const o: Obj = { id: p['id'], letter: p['letter'], specimen_state: p['specimen_state'] ?? 'none', version: Number(p['version']) };
  put(o, 'site_text', p['site_text']); put(o, 'description_text', p['description_text']); put(o, 'specimen_id', p['specimen_id']); put(o, 'specimen_type_code', p['specimen_type_code']);
  return o;
}
/** Case header + parts. The aggregate sections of CaseDetail (blocks, slides, …) belong to A3 (getAnatomicCase). */
export function caseDto(r: Row, parts: Row[]): Obj {
  const o: Obj = {
    id: r['id'], case_kind: r['case_kind'], status: r['status'], priority: r['priority'], centre_id: r['centre_id'], order_id: r['order_id'], patient_id: r['patient_id'],
    part_count: parts.length, version: Number(r['version']), parts: parts.map(partDto),
  };
  put(o, 'accession_no', r['accession_no']); put(o, 'received_at', iso(r['received_at'])); put(o, 'accessioned_at', iso(r['accessioned_at'])); put(o, 'signed_out_at', iso(r['signed_out_at']));
  put(o, 'clinical_history_text', r['clinical_history_text']); put(o, 'assigned_pathologist_membership_id', r['assigned_pathologist_membership_id']);
  return o;
}

// ---- A4 accessionAnatomicCase ----
export async function accessionCase(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined);
  await assertAt(c, 'anatomic.case.work', cs);
  const version = expectedVersion(headers);
  const b = strict(body, ['clinical_history_text', 'assigned_pathologist_membership_id', 'parts']);
  const history = b['clinical_history_text'] === undefined ? undefined : text(b['clinical_history_text'], '/clinical_history_text', 4000);
  const pathologist = b['assigned_pathologist_membership_id'] === undefined ? undefined : uuid(b['assigned_pathologist_membership_id'], '/assigned_pathologist_membership_id');
  const items = b['parts'];
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_PARTS) throw bad('/parts');
  const wanted = new Map<string, { site: string; description?: string }>();
  items.forEach((raw, n) => {
    const it = strict(raw, ['part_id', 'site_text', 'description_text'], `/parts/${n}`);
    const id = uuid(it['part_id'], `/parts/${n}/part_id`);
    if (wanted.has(id)) throw bad(`/parts/${n}/part_id`);
    const entry: { site: string; description?: string } = { site: text(it['site_text'], `/parts/${n}/site_text`, 200, 1) };
    if (it['description_text'] !== undefined) entry.description = text(it['description_text'], `/parts/${n}/description_text`, 1000);
    wanted.set(id, entry);
  });

  if (Number(cs['version']) !== version) throw new LimsError('common.version_conflict');
  assertTransition(cs['status'] as CaseStatus, 'accessioned'); // anything but `received` -> 409 anatomic.case_invalid_transition (AC-02.5)
  const existing = await listParts(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  if (existing.length !== wanted.size || existing.some((p) => !wanted.has(p['id']))) throw bad('/parts'); // every existing part, nothing else

  const no = await allocateAccessionNumber(c, { caseKind: cs['case_kind'] as CaseKind, branchId: cs['branch_id'] ?? null });
  const patch: Row = {
    accession_no: no.accessionNo, accession_series: no.seriesKey, accession_year: no.yearAd, status: 'accessioned', accessioned_at: c.now().toISOString(), accessioned_by: c.actor.id,
  };
  if (history !== undefined) patch['clinical_history_text'] = history;
  if (pathologist !== undefined) patch['assigned_pathologist_membership_id'] = pathologist;
  let updated: Row | undefined;
  try {
    updated = await updateCase(c.tx, { tenantId: c.tenantId, id: cs['id'], expectedVersion: version, actorId: c.actor.id, patch });
  } catch (e) {
    // the only unique key this UPDATE can break is (tenant_id, accession_no) (AC-02.6); the number is not put in the problem
    if ((e as { code?: unknown } | null)?.code === '23505') throw new LimsError('anatomic.accession_duplicate');
    throw e;
  }
  if (!updated) throw new LimsError('common.version_conflict');

  const parts: Row[] = [];
  for (const p of existing) {
    const w = wanted.get(p['id'])!;
    const ppatch: Row = { site_text: w.site };
    if (w.description !== undefined) ppatch['description_text'] = w.description;
    const np = await updatePart(c.tx, { tenantId: c.tenantId, id: p['id'], expectedVersion: Number(p['version']), actorId: c.actor.id, patch: ppatch });
    if (!np) throw new LimsError('common.version_conflict');
    parts.push(np);
  }
  await insertCaseTransition(c.tx, { id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], from_status: cs['status'], to_status: 'accessioned', created_by: c.actor.id });
  return { status: 200, body: caseDto(updated, parts) };
}

// ---- A5 updateAnatomicCaseDetails ----
export async function updateCaseDetails(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined);
  await assertAt(c, 'anatomic.case.work', cs);
  if (cs['status'] === 'signed_out') throw new LimsError('anatomic.signout_locked'); // clinical history is snapshotted content (D-66 (c))
  const version = expectedVersion(headers);
  const b = strict(body, ['clinical_history_text', 'assigned_pathologist_membership_id']);
  const history = b['clinical_history_text'] === undefined ? null : text(b['clinical_history_text'], '/clinical_history_text', 4000);
  const pathologist = b['assigned_pathologist_membership_id'] === undefined ? null : uuid(b['assigned_pathologist_membership_id'], '/assigned_pathologist_membership_id');
  if (Number(cs['version']) !== version) throw new LimsError('common.version_conflict');
  // full replace: omitted = cleared. accession_no / status are not in the patch, so they cannot change here.
  const updated = await updateCase(c.tx, {
    tenantId: c.tenantId, id: cs['id'], expectedVersion: version, actorId: c.actor.id, patch: { clinical_history_text: history, assigned_pathologist_membership_id: pathologist },
  });
  if (!updated) throw new LimsError('common.version_conflict');
  return { status: 200, body: caseDto(updated, await listParts(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })) };
}

// ---- A6 addAnatomicPart ----
export async function addPart(hctx: unknown, params: unknown, _headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  // case row lock (FOR UPDATE) serialises concurrent A6 on one case, so two calls never pick the same letter
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined, true);
  await assertAt(c, 'anatomic.case.work', cs);
  if (cs['status'] === 'signed_out') throw new LimsError('anatomic.signout_locked'); // never add parts after sign-out (D-66 (c))
  if (cs['status'] === 'cancelled') throw new LimsError('anatomic.case_invalid_transition');
  const b = strict(body, ['site_text', 'description_text', 'specimen_id']);
  const site = text(b['site_text'], '/site_text', 200, 1);
  const description = b['description_text'] === undefined ? undefined : text(b['description_text'], '/description_text', 1000);
  let specimenId: string | undefined;
  if (b['specimen_id'] !== undefined) {
    specimenId = uuid(b['specimen_id'], '/specimen_id');
    const link = await getSpecimenLinkBySpecimen(c.tx, { tenantId: c.tenantId, specimenId });
    if (!link || link['case_id'] !== cs['id']) throw bad('/specimen_id'); // must already be linked to this case
  }
  const existing = await listParts(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  if (existing.length >= MAX_PARTS) throw bad('/site_text'); // 52 parts per case (Part.letter ≤ AZ)
  const seq = existing.reduce((m, p) => Math.max(m, Number(p['letter_seq'])), 0) + 1; // letters are never reused
  const row: Row = {
    id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], letter: partLetter(seq), letter_seq: seq, site_text: site,
    created_by: c.actor.id, updated_by: c.actor.id,
  };
  if (description !== undefined) row['description_text'] = description;
  if (specimenId !== undefined) row['specimen_id'] = specimenId;
  return { status: 201, body: partDto(await insertPart(c.tx, row)) }; // any 23505 rethrows (common.internal)
}

// ---- A7 updateAnatomicPart ----
export async function updateCasePart(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const p = isObj(params) ? params : {};
  const cs = await loadCase(c, p['case_id']);
  await assertAt(c, 'anatomic.case.work', cs);
  const partId = typeof p['part_id'] === 'string' && UUID.test(p['part_id']) ? p['part_id'] : undefined;
  const part = partId ? await getPart(c.tx, { tenantId: c.tenantId, id: partId }) : undefined;
  if (!part || part['case_id'] !== cs['id']) throw new LimsError('common.not_found');
  if (cs['status'] === 'signed_out' && !(await getOpenDraft(c.tx, { tenantId: c.tenantId, caseId: cs['id'] }))) throw new LimsError('anatomic.signout_locked'); // D-66 (b)
  const version = expectedVersion(headers);
  const b = strict(body, ['site_text', 'description_text']);
  const site = text(b['site_text'], '/site_text', 200, 1);
  const description = b['description_text'] === undefined ? null : text(b['description_text'], '/description_text', 1000); // PUT: omitted = cleared
  if (Number(part['version']) !== version) throw new LimsError('common.version_conflict');
  const updated = await updatePart(c.tx, { tenantId: c.tenantId, id: part['id'], expectedVersion: version, actorId: c.actor.id, patch: { site_text: site, description_text: description } });
  if (!updated) throw new LimsError('common.version_conflict');
  return { status: 200, body: partDto(updated) };
}

// ---- A12 listAnatomicAssignees ----
const DEFAULT_LIMIT = 20, MAX_LIMIT = 50;
export async function listAssignees(hctx: unknown, query: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const q = strict(query ?? {}, ['case_id', 'q', 'limit'], '');
  const caseId = q['case_id'] === undefined ? undefined : uuid(q['case_id'], '/case_id');
  const prefix = q['q'] === undefined ? '' : text(q['q'], '/q', 60);
  let limit = DEFAULT_LIMIT;
  if (q['limit'] !== undefined) {
    const raw = q['limit'];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : NaN; // query strings arrive as strings
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw bad('/limit');
    limit = n;
  }
  const filter: { permission: string; centreId?: string; activeOnly: boolean; limit: number } = { permission: 'anatomic.case.signout', activeOnly: true, limit: 500 };
  if (caseId) {
    const cs = await loadCase(c, caseId);
    await assertAt(c, 'anatomic.case.read', cs);
    filter.centreId = cs['centre_id'];
  } // without case_id the route-level x-permission gate (anatomic.case.read) is the check: there is no centre to assert at
  const staff = await c.core.memberships.list(c, filter);
  const lower = prefix.toLowerCase(); // literal prefix compare in memory: % and _ are not wildcards (REQ-SEC-082)
  const data = staff
    .filter((m) => m.displayName.toLowerCase().startsWith(lower))
    .slice(0, limit)
    .map((m) => ({ membership_id: m.membershipId, display_name: m.displayName }));
  return { status: 200, body: { data } };
}
