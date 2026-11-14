// Material — M1 blocks, M2 slides, M3 bulk mark-ready, M4 slide assessment, M6 stain-order list, M12 block list, M5/M7–M10 stain orders, M11 movements, M13/M14 movement history, M15 label data
// (02-TRD §5.2 M1–M15 + "Movement guards", §4.3 labels, §12 access log; AC-04.x, AC-05.x, AC-06.x).
// Case-scoped (M1, M2, M5, M15): load case (404) -> IdentityPort.assertRole(case.work, case centre) -> status gate -> body -> write.
// Object-scoped (M3, M7–M11, M13, M14): the object is loaded tenant-bound (other tenant = not found), its case gives the centre for assertRole.
// No submitted value is echoed or logged (REQ-SEC-098); a throw rolls the caller's transaction back (a unique-key clash -> 409 common.version_conflict).
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { blockLabel, slideLabelFromBlock, slideLabelFromPart } from '../domain/labels.js';
import { getCase, getCaseItem, insertCaseItem, listCaseItems } from '../repository/cases.repo.js';
import { getStain, getTestProfileByTestId, listStains } from '../repository/config.repo.js';
import { getOpenDraft } from '../repository/drafts.repo.js';
import { getBlock, insertBlock, listBlocks, listBlocksPage, updateBlock } from '../repository/blocks.repo.js';
import { listCodedCytologyAdequacies } from '../repository/codedValues.repo.js';
import { insertObjectMovement, listMovementsOfObject } from '../repository/movements.repo.js';
import { getPart, listParts } from '../repository/parts.repo.js';
import { getSlide, insertSlide, listSlides, updateSlide } from '../repository/slides.repo.js';
import { getStainOrder, insertStainOrder, listStainOrders, listStainOrdersPage, updateStainOrder } from '../repository/stainOrders.repo.js';
import type { Row } from '../repository/_sql.js';
import { UUID, anatomicCtx, assertAt, bad, isObj, iso, loadCase, put, strict, text, uuid } from './case.service.js';
import { decodeCursor, encodeCursor } from './config.service.js';
import { ifMatch } from './gross.service.js';
import type { AnatomicCtx } from './numbering.service.js';

type Obj = Record<string, unknown>;
type Result = { status: number; body: unknown };
/** AnatomicCtx plus the request-context members this service uses (02-TRD §6.2). */
type Ctx = AnatomicCtx & {
  readonly audit: { access(entry: Record<string, unknown>): Promise<void> };
  readonly core: AnatomicCtx['core'] & { user(ctx: unknown, i: { userId: string }): Promise<{ displayName: string }> };
  readonly ports: AnatomicCtx['ports'] & { readonly FrontdeskPort: { getOrderSummary(ctx: unknown, i: { orderId: string }): Promise<{ items: ReadonlyArray<Obj> }> } };
};
const mctx = (c: unknown): Ctx => anatomicCtx(c) as Ctx;

const notFound = (): LimsError => new LimsError('common.not_found');
const invalid = (): LimsError => new LimsError('anatomic.case_invalid_transition');
const conflict = (): LimsError => new LimsError('common.version_conflict');
const int = (v: unknown, path: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(path);
  return v;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], path: string): T => {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw bad(path);
  return v as T;
};
/** A unique-key violation means a concurrent writer took the number: 409, never a duplicate and never common.internal. */
async function unique<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) {
    if ((e as { code?: unknown } | null)?.code === '23505') throw conflict();
    throw e;
  }
}
/** Memoised display-name lookup (one core call per user per request). */
function names(c: Ctx): (userId: unknown) => Promise<string> {
  const seen = new Map<string, string>();
  return async (userId) => {
    if (typeof userId !== 'string') return '';
    let n = seen.get(userId);
    if (n === undefined) {
      try { n = (await c.core.user(c, { userId })).displayName; } catch { n = ''; } // a removed user must not break the history
      seen.set(userId, n);
    }
    return n;
  };
}

/** Writes that create material (M1, M2, M5): accessioned | in_processing | ready_for_reporting; signed_out only with an open change draft (D-66). */
async function gate(c: Ctx, cs: Row): Promise<void> {
  const s = cs['status'];
  if (s === 'received' || s === 'cancelled') throw invalid(); // AC-04.2
  if (s === 'signed_out' && !(await getOpenDraft(c.tx, { tenantId: c.tenantId, caseId: cs['id'] }))) throw new LimsError('anatomic.signout_locked');
}
async function caseWork(hctx: unknown, params: unknown): Promise<{ c: Ctx; cs: Row }> {
  const c = mctx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined);
  await assertAt(c, 'anatomic.case.work', cs);
  return { c, cs };
}
const accessionOf = (cs: Row): string => { if (typeof cs['accession_no'] !== 'string') throw invalid(); return cs['accession_no']; };
const maxSeq = (rows: Row[]): number => rows.reduce((m, r) => Math.max(m, Number(r['seq'])), 0);
const available = (b: Row): boolean => b['location_status'] === 'in_lab' || b['location_status'] === 'stored';

// ---- DTOs (no null on the wire) ----
function blockDto(b: Row, slideCount: number): Obj {
  const o: Obj = { id: b['id'], part_id: b['part_id'], label: b['label'], seq: Number(b['seq']), location_status: b['location_status'], slide_count: slideCount, version: Number(b['version']) };
  put(o, 'note', b['note']); put(o, 'location_text', b['location_text']);
  return o;
}
function slideDto(s: Row, stainDisplay: unknown): Obj {
  const o: Obj = {
    id: s['id'], label: s['label'], part_id: s['part_id'], stain_code: s['stain_code'], stain_display: stainDisplay ?? s['stain_code'], status: s['status'],
    location_status: s['location_status'], include_in_report: s['include_in_report'] === true, version: Number(s['version']),
  };
  put(o, 'block_id', s['block_id']); put(o, 'location_text', s['location_text']); put(o, 'stain_order_id', s['stain_order_id']);
  put(o, 'adequacy_code', s['adequacy_code']); put(o, 'finding_text', s['finding_text']);
  return o;
}
async function orderDto(c: Ctx, o: Row, nameOf: (id: unknown) => Promise<string>): Promise<Obj> {
  const stain = await getStain(c.tx, { tenantId: c.tenantId, id: o['stain_id'] });
  const block = typeof o['block_id'] === 'string' ? await getBlock(c.tx, { tenantId: c.tenantId, id: o['block_id'] }) : undefined;
  const addon = typeof o['addon_case_item_id'] === 'string' ? await getCaseItem(c.tx, { tenantId: c.tenantId, id: o['addon_case_item_id'] }) : undefined;
  const d: Obj = {
    id: o['id'], stain_code: o['stain_code'], stain_display: stain?.['display'] ?? o['stain_code'], stain_kind: o['stain_kind'], status: o['status'],
    requested_at: iso(o['requested_at']), requested_by_display_name: await nameOf(o['created_by'] ?? o['updated_by'] ?? c.actor.id), version: Number(o['version']),
  };
  put(d, 'block_id', o['block_id']); put(d, 'block_label', block?.['label']); put(d, 'part_id', o['part_id']); put(d, 'note', o['note']); put(d, 'reagent_lot', o['reagent_lot']);
  put(d, 'addon_order_item_id', addon?.['order_item_id']); put(d, 'completed_at', iso(o['completed_at']));
  return d;
}

// ---- M1 createAnatomicBlocks ----
export async function createBlocks(hctx: unknown, params: unknown, body: unknown): Promise<Result> {
  const { c, cs } = await caseWork(hctx, params);
  await gate(c, cs);
  const b = strict(body, ['part_id', 'count', 'note']);
  const partId = uuid(b['part_id'], '/part_id');
  const count = int(b['count'], '/count', 1, 50);
  const note = b['note'] === undefined ? undefined : text(b['note'], '/note', 200);
  const part = await getPart(c.tx, { tenantId: c.tenantId, id: partId });
  if (!part || part['case_id'] !== cs['id']) throw notFound();

  const acc = accessionOf(cs);
  const start = maxSeq((await listBlocks(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).filter((x) => x['part_id'] === part['id']));
  const out: Obj[] = [];
  for (let i = 1; i <= count; i++) {
    const row: Row = {
      id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], part_id: part['id'], seq: start + i,
      label: blockLabel(acc, String(part['letter']), start + i), location_status: 'in_lab', created_by: c.actor.id, updated_by: c.actor.id,
    };
    if (note !== undefined) row['note'] = note;
    out.push(blockDto(await unique(() => insertBlock(c.tx, row)), 0));
  }
  return { status: 201, body: { blocks: out } };
}

// ---- M2 createAnatomicSlides ----
async function activeStain(c: Ctx, code: unknown, path: string): Promise<Row> {
  if (typeof code !== 'string') throw bad(path);
  const stain = (await listStains(c.tx, { tenantId: c.tenantId, activeOnly: true })).find((s) => s['code'] === code);
  if (!stain) throw bad(path);
  return stain;
}
/** Next slide rows for a block (label from the block) or a block-less part (label from the accession + part letter). */
function slideRows(c: Ctx, cs: Row, target: { block?: Row | undefined; part: Row }, existing: Row[], count: number, stain: Row, extra: Row): Row[] {
  const peers = existing.filter((s) => (target.block ? s['block_id'] === target.block['id'] : !s['block_id'] && s['part_id'] === target.part['id']));
  const start = maxSeq(peers);
  const rows: Row[] = [];
  for (let i = 1; i <= count; i++) {
    const label = target.block ? slideLabelFromBlock(String(target.block['label']), start + i) : slideLabelFromPart(accessionOf(cs), String(target.part['letter']), start + i);
    const row: Row = {
      id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], part_id: target.part['id'], seq: start + i, label,
      stain_id: stain['id'], stain_code: stain['code'], location_status: 'in_lab', include_in_report: false, created_by: c.actor.id, updated_by: c.actor.id, ...extra,
    };
    if (target.block) row['block_id'] = target.block['id'];
    rows.push(row);
  }
  return rows;
}
export async function createSlides(hctx: unknown, params: unknown, body: unknown): Promise<Result> {
  const { c, cs } = await caseWork(hctx, params);
  await gate(c, cs);
  const b = strict(body, ['block_id', 'part_id', 'stain_code', 'count']);
  if ((b['block_id'] === undefined) === (b['part_id'] === undefined)) throw bad('/block_id', '/part_id'); // exactly one
  const blockId = b['block_id'] === undefined ? undefined : uuid(b['block_id'], '/block_id');
  const partId = b['part_id'] === undefined ? undefined : uuid(b['part_id'], '/part_id');
  const count = int(b['count'], '/count', 1, 20);
  const stain = await activeStain(c, b['stain_code'], '/stain_code');

  let block: Row | undefined;
  let part: Row | undefined;
  if (blockId) {
    block = await getBlock(c.tx, { tenantId: c.tenantId, id: blockId });
    if (!block || block['case_id'] !== cs['id']) throw notFound();
    if (!available(block)) throw new LimsError('anatomic.block_not_available'); // sent_out | discarded (AC-04.5)
    part = await getPart(c.tx, { tenantId: c.tenantId, id: block['part_id'] });
  } else {
    part = await getPart(c.tx, { tenantId: c.tenantId, id: partId! });
  }
  if (!part || part['case_id'] !== cs['id']) throw notFound();

  const existing = await listSlides(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  const out: Obj[] = [];
  for (const row of slideRows(c, cs, { block, part }, existing, count, stain, { status: 'pending_stain' })) out.push(slideDto(await unique(() => insertSlide(c.tx, row)), stain['display']));
  return { status: 201, body: { slides: out } };
}

// ---- M3 markAnatomicSlidesReady ----
/** Per-case lookup + one assertRole per centre; shared by M3 and M11. */
function caseResolver(c: Ctx): (caseId: unknown) => Promise<Row | undefined> {
  const cases = new Map<string, Row | undefined>();
  const checked = new Set<string>();
  return async (caseId) => {
    if (typeof caseId !== 'string') return undefined;
    if (!cases.has(caseId)) cases.set(caseId, await getCase(c.tx, { tenantId: c.tenantId, caseId }));
    const cs = cases.get(caseId);
    if (cs && !checked.has(String(cs['centre_id']))) { await assertAt(c, 'anatomic.case.work', cs); checked.add(String(cs['centre_id'])); }
    return cs;
  };
}
function idList(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 200) throw bad(path);
  return v.map((x, i) => uuid(x, `${path}/${i}`));
}
export async function markSlidesReady(hctx: unknown, body: unknown): Promise<Result> {
  const c = mctx(hctx);
  const ids = idList(strict(body, ['ids'])['ids'], '/ids');
  const caseOf = caseResolver(c);
  const results: Obj[] = [];
  for (const id of ids) {
    const s = await getSlide(c.tx, { tenantId: c.tenantId, id });
    const cs = s ? await caseOf(s['case_id']) : undefined;
    if (!s || !cs) { results.push({ id, outcome: 'not_found' }); continue; }
    if (cs['status'] === 'cancelled') results.push({ id, outcome: 'invalid_state' });
    else if (s['status'] === 'ready') results.push({ id, outcome: 'unchanged' });
    else {
      const u = await updateSlide(c.tx, { tenantId: c.tenantId, id, expectedVersion: Number(s['version']), actorId: c.actor.id, patch: { status: 'ready', ready_at: c.now().toISOString() } });
      if (!u) throw conflict();
      results.push({ id, outcome: 'updated' });
    }
  }
  return { status: 200, body: { results } };
}

// ---- M4 saveAnatomicSlideAssessment ----
async function adequacyActive(c: Ctx, code: string): Promise<boolean> {
  for (let offset = 0; ; offset += 500) {
    const rows = await listCodedCytologyAdequacies(c.tx, { tenantId: c.tenantId, activeOnly: true, limit: 500, offset });
    if (rows.some((r) => r['code'] === code)) return true;
    if (rows.length < 500) return false;
  }
}
const ADEQUACY_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
export async function saveSlideAssessment(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = mctx(hctx);
  const id = isObj(params) ? params['slide_id'] : undefined;
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
  const s = await getSlide(c.tx, { tenantId: c.tenantId, id });
  const cs = s ? await getCase(c.tx, { tenantId: c.tenantId, caseId: s['case_id'] }) : undefined;
  if (!s || !cs) throw notFound();
  await assertAt(c, 'anatomic.case.work', cs);
  const status = cs['status'];
  if (status === 'signed_out' && !(await getOpenDraft(c.tx, { tenantId: c.tenantId, caseId: cs['id'] }))) throw new LimsError('anatomic.signout_locked'); // D-66 (b), AC-03.4

  const version = ifMatch(headers, false);
  const b = strict(body, ['adequacy_code', 'finding_text', 'include_in_report']);
  if (typeof b['include_in_report'] !== 'boolean') throw bad('/include_in_report');
  let adequacy: string | null = null;
  if (b['adequacy_code'] !== undefined) {
    const v = b['adequacy_code'];
    if (typeof v !== 'string' || !ADEQUACY_CODE.test(v) || !(await adequacyActive(c, v))) throw bad('/adequacy_code'); // x-coded-set anatomic.cytology_adequacy
    adequacy = v;
  }
  const finding = b['finding_text'] === undefined ? null : text(b['finding_text'], '/finding_text', 2000);
  if (Number(s['version']) !== version) throw conflict();
  const u = await updateSlide(c.tx, { tenantId: c.tenantId, id, expectedVersion: version, actorId: c.actor.id, patch: { adequacy_code: adequacy, finding_text: finding, include_in_report: b['include_in_report'] } });
  if (!u) throw conflict();
  const stain = await getStain(c.tx, { tenantId: c.tenantId, id: u['stain_id'] });
  return { status: 200, body: slideDto(u, stain?.['display']) };
}

// ---- M6 / M12 lists (tenant-wide; centre scoping is RLS, the route gate is anatomic.case.read) ----
function csvOf(v: unknown, path: string, ok: (s: string) => boolean, max: number): string[] {
  if (typeof v !== 'string') throw bad(path);
  const parts = v.split(',');
  if (parts.length > max || !parts.every(ok)) throw bad(path);
  return [...new Set(parts)];
}
function pageArgs(q: Obj): { limit: number; offset: number } {
  let limit = 50;
  if (q['limit'] !== undefined) {
    const raw = q['limit']; // query strings arrive as strings
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
    limit = n;
  }
  return { limit, offset: q['cursor'] === undefined ? 0 : decodeCursor(q['cursor']) };
}
const pageInfo = (rows: number, limit: number, offset: number): Obj => ({ limit, ...(rows > limit ? { next_cursor: encodeCursor(offset + limit) } : {}) });

export async function listStainOrdersQueue(hctx: unknown, query: unknown): Promise<Result> {
  const c = mctx(hctx);
  const q = strict(query ?? {}, ['status', 'stain_kind', 'centre_id', 'sort', 'limit', 'cursor']);
  const statuses = q['status'] === undefined ? ['requested', 'in_progress'] : csvOf(q['status'], '/status', (x) => ['requested', 'in_progress', 'completed', 'cancelled'].includes(x), 4);
  const input: Parameters<typeof listStainOrdersPage>[1] = { tenantId: c.tenantId, statuses, descending: false, limit: 0, offset: 0 };
  if (q['stain_kind'] !== undefined) input.stainKinds = csvOf(q['stain_kind'], '/stain_kind', (x) => x === 'special' || x === 'ihc', 2);
  if (q['centre_id'] !== undefined) input.centreIds = csvOf(q['centre_id'], '/centre_id', (x) => UUID.test(x), 20);
  if (q['sort'] !== undefined) input.descending = oneOf(q['sort'], ['requested_at', '-requested_at'] as const, '/sort') === '-requested_at';
  const { limit, offset } = pageArgs(q);
  Object.assign(input, { limit: limit + 1, offset });
  const rows = await listStainOrdersPage(c.tx, input);
  const nameOf = names(c);
  const data: Obj[] = [];
  for (const o of rows.slice(0, limit)) {
    const d: Obj = {
      id: o['id'], stain_code: o['stain_code'], stain_display: o['stain_display'] ?? o['stain_code'], stain_kind: o['stain_kind'], status: o['status'],
      requested_at: iso(o['requested_at']), requested_by_display_name: await nameOf(o['created_by']), version: Number(o['version']),
      case_id: o['case_id'], accession_no: o['accession_no'], priority: o['priority'],
    };
    put(d, 'block_id', o['block_id']); put(d, 'block_label', o['block_label']); put(d, 'part_id', o['part_id']); put(d, 'note', o['note']); put(d, 'reagent_lot', o['reagent_lot']);
    put(d, 'addon_order_item_id', o['addon_order_item_id']); put(d, 'completed_at', iso(o['completed_at']));
    data.push(d);
  }
  return { status: 200, body: { data, page: pageInfo(rows.length, limit, offset) } };
}

export async function listBlocksOverview(hctx: unknown, query: unknown): Promise<Result> {
  const c = mctx(hctx);
  const q = strict(query ?? {}, ['location_status', 'case_id', 'limit', 'cursor']);
  const input: Parameters<typeof listBlocksPage>[1] = { tenantId: c.tenantId, limit: 0, offset: 0 };
  if (q['location_status'] !== undefined) input.locationStatuses = csvOf(q['location_status'], '/location_status', (x) => ['in_lab', 'stored', 'sent_out', 'discarded'].includes(x), 4);
  if (q['case_id'] !== undefined) input.caseId = uuid(q['case_id'], '/case_id');
  const { limit, offset } = pageArgs(q);
  Object.assign(input, { limit: limit + 1, offset });
  const rows = await listBlocksPage(c.tx, input);
  const data = rows.slice(0, limit).map((b) => {
    const d = blockDto(b, Number(b['slide_count'] ?? 0));
    d['case_id'] = b['case_id']; d['accession_no'] = b['accession_no'];
    put(d, 'last_movement_at', iso(b['last_movement_at']));
    return d;
  });
  return { status: 200, body: { data, page: pageInfo(rows.length, limit, offset) } };
}

// ---- M5 createAnatomicStainOrder ----
export async function createStainOrder(hctx: unknown, params: unknown, body: unknown): Promise<Result> {
  const { c, cs } = await caseWork(hctx, params);
  await gate(c, cs);
  const b = strict(body, ['stain_code', 'block_id', 'part_id', 'note', 'addon_order_item_id']);
  const stain = await activeStain(c, b['stain_code'], '/stain_code');
  if (stain['kind'] === 'routine') throw bad('/stain_code'); // routine stains are made with M2 (AC-05.7)
  const blockId = b['block_id'] === undefined ? undefined : uuid(b['block_id'], '/block_id');
  const partId = b['part_id'] === undefined ? undefined : uuid(b['part_id'], '/part_id');
  if (stain['kind'] === 'ihc') { if (!blockId) throw new LimsError('anatomic.ihc_requires_block'); } // AC-05.2
  if ((blockId === undefined) === (partId === undefined) || (blockId !== undefined && partId !== undefined)) throw bad('/block_id', '/part_id');
  const note = b['note'] === undefined ? undefined : text(b['note'], '/note', 500);
  const addonOrderItemId = b['addon_order_item_id'] === undefined ? undefined : uuid(b['addon_order_item_id'], '/addon_order_item_id');
  const membershipId = c.actor.membershipId;
  if (!membershipId) throw new LimsError('auth.unauthenticated'); // requested_by_membership_id is NOT NULL

  if (blockId) {
    const block = await getBlock(c.tx, { tenantId: c.tenantId, id: blockId });
    if (!block || block['case_id'] !== cs['id']) throw notFound();
    if (block['location_status'] === 'discarded') throw new LimsError('anatomic.block_not_available'); // a sent_out block may be ordered on (E14); M8 then needs it back
  } else {
    const part = await getPart(c.tx, { tenantId: c.tenantId, id: partId! });
    if (!part || part['case_id'] !== cs['id']) throw notFound();
  }
  let addonItem: Row | undefined;
  if (addonOrderItemId) {
    addonItem = (await listCaseItems(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).find((i) => i['order_item_id'] === addonOrderItemId);
    if (!addonItem) throw bad('/addon_order_item_id');
    if (addonItem['is_active'] === false) throw new LimsError('anatomic.order_item_inactive');
  }

  const row: Row = {
    id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], stain_id: stain['id'], stain_code: stain['code'], stain_kind: stain['kind'],
    status: 'requested', requested_at: c.now().toISOString(), requested_by_membership_id: membershipId, created_by: c.actor.id, updated_by: c.actor.id,
  };
  if (blockId) row['block_id'] = blockId; else row['part_id'] = partId;
  if (note !== undefined) row['note'] = note;
  if (addonItem) row['addon_case_item_id'] = addonItem['id'];
  return { status: 201, body: await orderDto(c, await insertStainOrder(c.tx, row), names(c)) };
}

// ---- M7–M10 stain-order life cycle ----
async function loadOrder(hctx: unknown, params: unknown): Promise<{ c: Ctx; o: Row; cs: Row }> {
  const c = mctx(hctx);
  const id = isObj(params) ? params['stain_order_id'] : undefined;
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
  const o = await getStainOrder(c.tx, { tenantId: c.tenantId, id });
  const cs = o ? await getCase(c.tx, { tenantId: c.tenantId, caseId: o['case_id'] }) : undefined;
  if (!o || !cs) throw notFound();
  await assertAt(c, 'anatomic.case.work', cs);
  return { c, o, cs };
}
/** If-Match must equal the order's version; then the order must be in one of `from`. */
function expect(o: Row, version: number, from: readonly string[]): void {
  if (Number(o['version']) !== version) throw conflict();
  if (!from.includes(String(o['status']))) throw invalid();
}
async function saveOrder(c: Ctx, o: Row, patch: Row): Promise<Row> {
  const u = await updateStainOrder(c.tx, { tenantId: c.tenantId, id: o['id'], expectedVersion: Number(o['version']), actorId: c.actor.id, patch });
  if (!u) throw conflict(); // a parallel writer won
  return u;
}

export async function startStainOrder(hctx: unknown, params: unknown, headers: unknown): Promise<Result> {
  const { c, o } = await loadOrder(hctx, params);
  expect(o, ifMatch(headers, false), ['requested']);
  return { status: 200, body: await orderDto(c, await saveOrder(c, o, { status: 'in_progress', started_at: c.now().toISOString() }), names(c)) };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export async function completeStainOrder(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const { c, o, cs } = await loadOrder(hctx, params);
  const version = ifMatch(headers, false);
  const b = strict(body, ['slide_count', 'reagent_lot', 'performed_at']);
  const count = int(b['slide_count'], '/slide_count', 1, 20);
  const lot = b['reagent_lot'] === undefined ? undefined : text(b['reagent_lot'], '/reagent_lot', 64);
  let performedAt: string | undefined;
  if (b['performed_at'] !== undefined) {
    const v = b['performed_at'];
    if (typeof v !== 'string' || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v)) || Date.parse(v) > c.now().getTime()) throw bad('/performed_at');
    performedAt = v;
  }
  expect(o, version, ['requested', 'in_progress']);

  let block: Row | undefined;
  let part: Row | undefined;
  if (typeof o['block_id'] === 'string') {
    block = await getBlock(c.tx, { tenantId: c.tenantId, id: o['block_id'] });
    if (!block) throw notFound();
    if (!available(block)) throw new LimsError('anatomic.block_not_available'); // sent_out until returned (AC-05.6), or discarded
    part = await getPart(c.tx, { tenantId: c.tenantId, id: block['part_id'] });
  } else {
    part = await getPart(c.tx, { tenantId: c.tenantId, id: o['part_id'] });
  }
  if (!part) throw notFound();

  const now = c.now().toISOString();
  const patch: Row = { status: 'completed', completed_at: now };
  if (lot !== undefined) patch['reagent_lot'] = lot;
  if (performedAt !== undefined) patch['performed_at'] = performedAt;
  const done = await saveOrder(c, o, patch); // first: a lost race creates no slides

  const stain = { id: o['stain_id'], code: o['stain_code'] } as Row;
  const rows = slideRows(c, cs, { block, part }, await listSlides(c.tx, { tenantId: c.tenantId, caseId: cs['id'] }), count, stain, { status: 'ready', ready_at: now, stain_order_id: o['id'] });
  const display = (await getStain(c.tx, { tenantId: c.tenantId, id: o['stain_id'] }))?.['display'];
  const slides: Obj[] = [];
  for (const row of rows) slides.push(slideDto(await unique(() => insertSlide(c.tx, row)), display));
  return { status: 200, body: { stain_order: await orderDto(c, done, names(c)), slides } };
}

export async function cancelStainOrder(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const { c, o } = await loadOrder(hctx, params);
  const version = ifMatch(headers, false);
  const reason = text(strict(body, ['reason_text'])['reason_text'], '/reason_text', 500, 1);
  expect(o, version, ['requested', 'in_progress']);
  // AC-05.5: an add-on case item linked to the order is deliberately left as it is
  return { status: 200, body: await orderDto(c, await saveOrder(c, o, { status: 'cancelled', cancelled_at: c.now().toISOString(), cancel_reason_text: reason }), names(c)) };
}

export async function linkAddonItem(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const { c, o, cs } = await loadOrder(hctx, params);
  const version = ifMatch(headers, false);
  const orderItemId = uuid(strict(body, ['order_item_id'])['order_item_id'], '/order_item_id');
  if (Number(o['version']) !== version) throw conflict();

  const summary = await c.ports.FrontdeskPort.getOrderSummary(c, { orderId: String(cs['order_id']) });
  const item = summary.items.find((i) => i['orderItemId'] === orderItemId);
  if (!item) throw bad('/order_item_id'); // not an item of this case's order
  if (item['status'] !== 'active') throw new LimsError('anatomic.order_item_inactive'); // AC-09.9
  const profile = await getTestProfileByTestId(c.tx, { tenantId: c.tenantId, testId: String(item['testId']) });
  if (profile?.['is_addon'] !== true) throw bad('/order_item_id');

  let caseItem = (await listCaseItems(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).find((i) => i['order_item_id'] === orderItemId);
  if (caseItem && caseItem['is_active'] === false) throw new LimsError('anatomic.order_item_inactive');
  if (caseItem && (await listStainOrders(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).some((x) => x['id'] !== o['id'] && x['addon_case_item_id'] === caseItem!['id'])) throw bad('/order_item_id'); // linked elsewhere
  if (!caseItem) {
    caseItem = await insertCaseItem(c.tx, {
      id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], order_item_id: orderItemId, test_id: item['testId'], role: 'addon', created_by: c.actor.id, updated_by: c.actor.id,
    });
    if (!caseItem) throw conflict(); // the order item was claimed by a parallel writer
  }
  return { status: 200, body: await orderDto(c, await saveOrder(c, o, { addon_case_item_id: caseItem['id'] }), names(c)) };
}

// ---- M11 recordAnatomicMovements ----
const MOVEMENTS = ['stored', 'retrieved', 'sent_out', 'returned', 'discarded'] as const;
const REASONS = ['second_opinion', 'external_stain', 'consultation', 'retention_expired', 'other'] as const;
/** TRD "Movement guards": from-states per movement and the resulting location_status. */
const GUARD: Record<(typeof MOVEMENTS)[number], { from: readonly string[]; to: string }> = {
  stored: { from: ['in_lab', 'stored'], to: 'stored' }, retrieved: { from: ['stored'], to: 'in_lab' }, sent_out: { from: ['in_lab', 'stored'], to: 'sent_out' },
  returned: { from: ['sent_out'], to: 'in_lab' }, discarded: { from: ['in_lab', 'stored'], to: 'discarded' },
};
export async function recordMovements(hctx: unknown, body: unknown): Promise<Result> {
  const c = mctx(hctx);
  const b = strict(body, ['object_kind', 'object_ids', 'movement', 'location_text', 'destination_text', 'reason_code', 'note']);
  const kind = oneOf(b['object_kind'], ['block', 'slide'] as const, '/object_kind');
  const ids = idList(b['object_ids'], '/object_ids');
  const movement = oneOf(b['movement'], MOVEMENTS, '/movement');
  const locationText = b['location_text'] === undefined ? undefined : text(b['location_text'], '/location_text', 120, movement === 'stored' ? 1 : 0);
  const destination = b['destination_text'] === undefined ? undefined : text(b['destination_text'], '/destination_text', 200, movement === 'sent_out' ? 1 : 0);
  const reason = b['reason_code'] === undefined ? undefined : oneOf(b['reason_code'], REASONS, '/reason_code');
  const note = b['note'] === undefined ? undefined : text(b['note'], '/note', 500);
  if (movement === 'stored' && locationText === undefined) throw bad('/location_text');
  if (movement === 'sent_out' && destination === undefined) throw bad('/destination_text');
  if ((movement === 'sent_out' || movement === 'discarded') && reason === undefined) throw bad('/reason_code');

  const guard = GUARD[movement];
  const caseOf = caseResolver(c);
  const results: Obj[] = [];
  for (const id of ids) {
    const obj = kind === 'block' ? await getBlock(c.tx, { tenantId: c.tenantId, id }) : await getSlide(c.tx, { tenantId: c.tenantId, id });
    const cs = obj ? await caseOf(obj['case_id']) : undefined;
    if (!obj || !cs) { results.push({ id, outcome: 'not_found' }); continue; }
    const from = String(obj['location_status']);
    if (!guard.from.includes(from)) { results.push({ id, outcome: 'invalid_state' }); continue; } // incl. everything after discarded (AC-06.4)

    const row: Row = {
      id: uuidv7(), tenant_id: c.tenantId, centre_id: obj['centre_id'], case_id: obj['case_id'], object_kind: kind, object_id: id, movement,
      from_location_status: from, to_location_status: guard.to, created_by: c.actor.id,
    };
    if (locationText !== undefined) row['location_text'] = locationText;
    if (destination !== undefined) row['destination_text'] = destination;
    if (reason !== undefined) row['reason_code'] = reason;
    if (note !== undefined) row['note'] = note;
    await insertObjectMovement(c.tx, row);
    const patch: Row = { location_status: guard.to, location_text: movement === 'stored' ? locationText ?? null : null };
    const args = { tenantId: c.tenantId, id, expectedVersion: Number(obj['version']), actorId: c.actor.id, patch };
    if (!(kind === 'block' ? await updateBlock(c.tx, args) : await updateSlide(c.tx, args))) throw conflict();
    results.push({ id, outcome: 'recorded' });
  }
  return { status: 200, body: { results } };
}

// ---- M13 / M14 movement history ----
async function history(hctx: unknown, kind: 'block' | 'slide', id: unknown, query: unknown): Promise<Result> {
  const c = mctx(hctx);
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
  const obj = kind === 'block' ? await getBlock(c.tx, { tenantId: c.tenantId, id }) : await getSlide(c.tx, { tenantId: c.tenantId, id });
  const cs = obj ? await getCase(c.tx, { tenantId: c.tenantId, caseId: obj['case_id'] }) : undefined;
  if (!obj || !cs) throw notFound();
  await assertAt(c, 'anatomic.case.read', cs);
  const q = strict(query ?? {}, ['limit', 'cursor']);
  let limit = 50;
  if (q['limit'] !== undefined) {
    limit = Number(q['limit']);
    if (typeof q['limit'] === 'boolean' || !Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('/limit');
  }
  const offset = q['cursor'] === undefined ? 0 : decodeCursor(q['cursor']);
  const rows = await listMovementsOfObject(c.tx, { tenantId: c.tenantId, objectKind: kind, objectId: id }); // newest first
  const nameOf = names(c);
  const data: Obj[] = [];
  for (const m of rows.slice(offset, offset + limit)) {
    const d: Obj = { id: m['id'], movement: m['movement'], at: iso(m['created_at']), by_display_name: await nameOf(m['created_by']) };
    put(d, 'location_text', m['location_text']); put(d, 'destination_text', m['destination_text']); put(d, 'reason_code', m['reason_code']); put(d, 'note', m['note']);
    data.push(d);
  }
  return { status: 200, body: { data, page: { limit, ...(rows.length > offset + limit ? { next_cursor: encodeCursor(offset + limit) } : {}) } } };
}
export const listBlockMovements = (hctx: unknown, params: unknown, query: unknown): Promise<Result> => history(hctx, 'block', isObj(params) ? params['block_id'] : undefined, query);
export const listSlideMovements = (hctx: unknown, params: unknown, query: unknown): Promise<Result> => history(hctx, 'slide', isObj(params) ? params['slide_id'] : undefined, query);

// ---- M15 getAnatomicLabels ----
export async function getLabels(hctx: unknown, params: unknown, query: unknown): Promise<Result> {
  const { c, cs } = await caseWork(hctx, params);
  const q = strict(query ?? {}, ['kind', 'ids']);
  const kind = oneOf(q['kind'], ['blocks', 'slides'] as const, '/kind');
  let subset: Set<string> | undefined;
  if (q['ids'] !== undefined) {
    if (typeof q['ids'] !== 'string') throw bad('/ids');
    const parts = q['ids'].split(',');
    if (parts.length > 200 || !parts.every((p) => UUID.test(p))) throw bad('/ids');
    subset = new Set(parts);
  }
  const tenantId = c.tenantId, caseId = cs['id'];
  let labels: Obj[];
  if (kind === 'blocks') {
    const letters = new Map((await listParts(c.tx, { tenantId, caseId })).map((p) => [p['id'], p['letter']]));
    labels = (await listBlocks(c.tx, { tenantId, caseId })).filter((x) => !subset || subset.has(String(x['id']))).map((x) => ({ object_kind: 'block', object_id: x['id'], label: x['label'], line2: String(letters.get(x['part_id']) ?? '') }));
  } else {
    labels = (await listSlides(c.tx, { tenantId, caseId })).filter((x) => !subset || subset.has(String(x['id']))).map((x) => ({ object_kind: 'slide', object_id: x['id'], label: x['label'], line2: String(x['stain_code']) }));
  }
  await c.audit.access({ action: 'anatomic_label.print', entityType: 'anatomic_case', entityId: caseId, outcome: 'allowed', detail: { kind, count: labels.length } }); // one row; commits with the request
  return { status: 200, body: { labels } };
}
