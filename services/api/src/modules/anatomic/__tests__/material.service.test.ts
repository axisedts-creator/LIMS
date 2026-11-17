// C11.T-09 — material: blocks (M1), slides (M2), bulk mark-ready (M3), stain orders (M5, M7–M10), movements (M11), movement history (M13/M14), labels (M15).
// Spec: 02-TRD §5.2 M1–M15 + "Movement guards" + §4.3 labels + §12 access log (M15 -> anatomic_label.print); 01-PRD AC-04.1…04.7, AC-05.1…05.7, AC-06.1…06.5 (06.2 history part);
//       03-APP-FLOW E14; 05-SCHEMA blocks/slides/stain_orders/object_movements CHECKs; 07-SECURITY §3 (closed bodies, bulk <= 200), §5.2 (404 for invisible), §6 (no PHI in errors/logs).
// Drives the REAL handlers (manifest.handlers) on IN-MEMORY repositories (vi.mock of cases/parts/blocks/slides/stainOrders/movements/config/drafts repos, T-04 signatures).
//
// SEAMS (spec fixes behaviour; names below are chosen here, writer follows):
//   Handlers createAnatomicBlocks, createAnatomicSlides, markAnatomicSlidesReady, createAnatomicStainOrder, startAnatomicStainOrder, completeAnatomicStainOrder, cancelAnatomicStainOrder,
//   linkAnatomicAddonItem, recordAnatomicMovements, listAnatomicBlockMovements, listAnatomicSlideMovements, getAnatomicLabels (service/material.service.ts = writer's file).
//   Order inside case-scoped handlers (M1, M2, M5, M15): load case (404) -> IdentityPort.assertRole({permission, centreId: case.centre_id}) -> status gate -> body -> write.
//   Status gate for writes (M1/M2/M5): accessioned | in_processing | ready_for_reporting; received|cancelled -> 409 anatomic.case_invalid_transition (AC-04.2);
//     signed_out without an open change draft -> 409 anatomic.signout_locked (M1 lists it; applied to every material write, D-66), with an open draft it is allowed.
//   Object-scoped handlers (M3, M7–M11, M13, M14): the object is loaded tenant-bound (getBlock/getSlide/getStainOrder -> undefined = other tenant = not found), its case via cases.repo getCase,
//     assertRole uses THAT case's centre_id (permission case.work; M13/M14 case.read).
//   Allocation: block seq = (max seq of the part's blocks) + 1, label = blockLabel(accession_no, part.letter, seq); slide seq = max seq among the block's slides (or among the part's block-less slides) + 1,
//     label = slideLabelFromBlock / slideLabelFromPart. A unique-key violation (23505) from the repo (concurrent writer) -> 409 common.version_conflict, never common.internal, never a duplicate label.
//   Stains: found by code in config.repo listStains(tx,{tenantId, activeOnly:true}); unknown/inactive code -> 400 validation_failed at /stain_code.
//   M1 -> 201 {blocks:[{id,part_id,label,seq,note?,location_status:'in_lab',slide_count,version}]}; M2 -> 201 {slides:[{id,label,block_id?,part_id,stain_code,status:'pending_stain',location_status,include_in_report,version}]}.
//   M3 -> 200 {results:[{id,outcome}]} in request order; invalid_state = slide of a cancelled case. M11 -> 200 {results}. M5 -> 201 StainOrder; M8 -> 200 {stain_order, slides}; M7/M9/M10 -> 200 StainOrder.
//   M5 stores requested_by_membership_id = ctx.actor.membershipId, status 'requested', requested_at = ctx.now(), stain_id/stain_code/stain_kind from the stain; response has requested_by_display_name (ctx.core.user).
//   M8: from requested|in_progress (else case_invalid_transition); block target must be in_lab|stored (sent_out|discarded -> block_not_available, "returned" = in_lab again); creates slide_count slides with status 'ready',
//     ready_at = now, stain_order_id, next seq of the block; order -> completed (completed_at, reagent_lot, performed_at). M9: from requested|in_progress; the add-on case item is NOT touched (AC-05.5).
//   M10: order item must be an ACTIVE item of the case's order (FrontdeskPort.getOrderSummary(ctx,{orderId}).items[{orderItemId,testId,status}]), test profile is_addon, not linked to another stain order;
//     creates case_items role 'addon' (insertCaseItem) or reuses the existing addon case item of that order item; sets stain order addon_case_item_id via updateStainOrder (NB stainOrders.repo UPDATABLE list must then include it).
//   M11 per id: object loaded tenant-bound (not_found), guard table of TRD, then insertObjectMovement + updateBlock/updateSlide {location_status, location_text}; validation of the body happens BEFORE any write (400 + no row).
//   M13/M14 -> 200 {data: Movement[] newest first, page}. M15 -> 200 {labels}; access row via ctx.audit.access({action:'anatomic_label.print', entityType:'anatomic_case', entityId: caseId, outcome:'allowed', detail:{kind,count}}), none on 404/403.
//   ids in M15 that are not of this case/tenant are omitted (no error, no leak).
// M4 / M6 / M12 are covered by the T-18 blocks at the end of this file (reviewer item 2): signed_out matrix 07-SECURITY §5.3, If-Match, adequacy coded set, paging, filters.
// NOT covered here: Idempotency-Key replay (AC-04.7, core), live-DB integration (no PG/DDL here, as T-06/T-08), UI banner text (AC-05.5, web).
// Fails now: the twelve operations are 501/common.internal stubs in handlers/index.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  cases: new Map<string, Row>(), parts: new Map<string, Row>(), blocks: new Map<string, Row>(), slides: new Map<string, Row>(), orders: new Map<string, Row>(),
  moves: [] as Row[], items: new Map<string, Row>(), profiles: new Map<string, Row>(), stains: new Map<string, Row>(), drafts: new Map<string, Row>(),
  orderSummary: undefined as Row | undefined, staleLists: false, tick: 0, itemWrites: 0, adequacy: new Map<string, Row>(),
}));
const pgErr = (constraint: string) => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint });

vi.mock('../repository/cases.repo.js', () => ({
  async getCase(_tx: unknown, i: { tenantId: string; caseId: string }) { const r = S.cases.get(i.caseId); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async updateCase() { return undefined; },
  async insertCaseTransition(_tx: unknown, row: Row) { return row; },
  async listCaseTransitions() { return []; },
  async getCaseTransition() { return undefined; },
  async listCaseItems(_tx: unknown, i: { tenantId: string; caseId: string; activeOnly?: boolean }) {
    return [...S.items.values()].filter((x) => x['tenant_id'] === i.tenantId && x['case_id'] === i.caseId && (!i.activeOnly || x['is_active'] !== false)).map((x) => ({ ...x }));
  },
  async getCaseItem(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.items.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async insertCaseItem(_tx: unknown, row: Row) { S.itemWrites++; const r = { version: 1, is_active: true, ...row }; S.items.set(r['id'], r); return { ...r }; },
  async updateCaseItem() { S.itemWrites++; return undefined; },
  async listCases() { return []; }, async listCasesByOrder() { return []; }, async insertCase(_tx: unknown, row: Row) { return row; },
}));
vi.mock('../repository/parts.repo.js', () => ({
  async getPart(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.parts.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async listParts(_tx: unknown, i: { tenantId: string; caseId: string }) { return [...S.parts.values()].filter((p) => p['tenant_id'] === i.tenantId && p['case_id'] === i.caseId).map((p) => ({ ...p })); },
  async insertPart(_tx: unknown, row: Row) { return row; }, async updatePart() { return undefined; },
}));
vi.mock('../repository/blocks.repo.js', () => ({
  async insertBlock(_tx: unknown, row: Row) {
    const all = [...S.blocks.values()];
    if (all.some((b) => b['tenant_id'] === row['tenant_id'] && b['label'] === row['label'])) throw pgErr('blocks__tenant_id_label__uq');
    if (all.some((b) => b['tenant_id'] === row['tenant_id'] && b['part_id'] === row['part_id'] && b['seq'] === row['seq'])) throw pgErr('blocks__tenant_id_part_seq__uq');
    const r = { version: 1, location_status: 'in_lab', location_text: null, note: null, ...row }; S.blocks.set(r['id'], r); return { ...r };
  },
  async getBlock(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.blocks.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async listBlocks(_tx: unknown, i: { tenantId: string; caseId: string }) {
    if (S.staleLists) return [];
    return [...S.blocks.values()].filter((b) => b['tenant_id'] === i.tenantId && b['case_id'] === i.caseId).sort((a, b) => a['seq'] - b['seq']).map((b) => ({ ...b }));
  },
  /** M12 tenant-wide page (T-18 reviewer item 2): same filters as the real repo; row order = insertion order; joins accession_no, slide_count, last_movement_at */
  async listBlocksPage(_tx: unknown, i: { tenantId: string; locationStatuses?: string[]; caseId?: string; limit: number; offset: number }) {
    return [...S.blocks.values()]
      .filter((b) => b['tenant_id'] === i.tenantId && (!i.locationStatuses || i.locationStatuses.includes(b['location_status'])) && (!i.caseId || b['case_id'] === i.caseId))
      .slice(i.offset, i.offset + i.limit)
      .map((b) => {
        const last = S.moves.filter((m) => m['object_kind'] === 'block' && m['object_id'] === b['id']).map((m) => m['created_at']).sort().pop();
        return { ...b, accession_no: S.cases.get(b['case_id'])?.['accession_no'], slide_count: [...S.slides.values()].filter((s) => s['block_id'] === b['id']).length, last_movement_at: last ?? null };
      });
  },
  async updateBlock(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    const r = S.blocks.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId }; S.blocks.set(i.id, next); return { ...next };
  },
}));
vi.mock('../repository/slides.repo.js', () => ({
  async insertSlide(_tx: unknown, row: Row) {
    const all = [...S.slides.values()];
    if (all.some((s) => s['tenant_id'] === row['tenant_id'] && s['label'] === row['label'])) throw pgErr('slides__tenant_id_label__uq');
    const r = { version: 1, location_status: 'in_lab', location_text: null, include_in_report: false, ready_at: null, status: 'pending_stain', ...row }; S.slides.set(r['id'], r); return { ...r };
  },
  async getSlide(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.slides.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async listSlides(_tx: unknown, i: { tenantId: string; caseId: string }) {
    if (S.staleLists) return [];
    return [...S.slides.values()].filter((s) => s['tenant_id'] === i.tenantId && s['case_id'] === i.caseId).sort((a, b) => a['seq'] - b['seq']).map((s) => ({ ...s }));
  },
  async updateSlide(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    const r = S.slides.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId }; S.slides.set(i.id, next); return { ...next };
  },
}));
vi.mock('../repository/stainOrders.repo.js', () => ({
  async insertStainOrder(_tx: unknown, row: Row) { const r = { version: 1, status: 'requested', ...row }; S.orders.set(r['id'], r); return { ...r }; },
  async getStainOrder(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.orders.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async listStainOrders(_tx: unknown, i: { tenantId: string; caseId: string }) { return [...S.orders.values()].filter((o) => o['tenant_id'] === i.tenantId && o['case_id'] === i.caseId).map((o) => ({ ...o })); },
  /** M6 tenant-wide queue page (T-18 reviewer item 2): same filters/sort as the real repo (requested_at, id; descending flips both) */
  async listStainOrdersPage(_tx: unknown, i: { tenantId: string; statuses: string[]; stainKinds?: string[]; centreIds?: string[]; descending: boolean; limit: number; offset: number }) {
    const key = (o: Row) => `${o['requested_at']}|${o['id']}`;
    const rows = [...S.orders.values()]
      .filter((o) => o['tenant_id'] === i.tenantId && i.statuses.includes(o['status']) && (!i.stainKinds || i.stainKinds.includes(o['stain_kind'])) && (!i.centreIds || i.centreIds.includes(o['centre_id'])))
      .sort((a, b) => (key(a) < key(b) ? -1 : 1) * (i.descending ? -1 : 1));
    return rows.slice(i.offset, i.offset + i.limit).map((o) => ({
      ...o, accession_no: S.cases.get(o['case_id'])?.['accession_no'], priority: 'routine', stain_display: [...S.stains.values()].find((s) => s['id'] === o['stain_id'])?.['display'],
      block_label: o['block_id'] ? S.blocks.get(o['block_id'])?.['label'] : null,
    }));
  },
  async updateStainOrder(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    const r = S.orders.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId }; S.orders.set(i.id, next); return { ...next };
  },
}));
vi.mock('../repository/movements.repo.js', () => ({
  async insertObjectMovement(_tx: unknown, row: Row) { const r = { ...row, created_at: new Date(Date.UTC(2026, 10, 12, 1, 0, ++S.tick)).toISOString() }; S.moves.push(r); return { ...r }; },
  async getObjectMovement() { return undefined; },
  async listObjectMovements(_tx: unknown, i: { tenantId: string; caseId: string }) { return S.moves.filter((m) => m['tenant_id'] === i.tenantId && m['case_id'] === i.caseId).map((m) => ({ ...m })); },
  /** same contract as the real repo: newest first */
  async listMovementsOfObject(_tx: unknown, i: { tenantId: string; objectKind: string; objectId: string }) {
    return S.moves.filter((m) => m['tenant_id'] === i.tenantId && m['object_kind'] === i.objectKind && m['object_id'] === i.objectId).sort((a, b) => (a['created_at'] < b['created_at'] ? 1 : -1)).map((m) => ({ ...m }));
  },
}));
vi.mock('../repository/drafts.repo.js', () => ({
  async getOpenDraft(_tx: unknown, i: { tenantId: string; caseId: string }) { const d = [...S.drafts.values()].find((x) => x['tenant_id'] === i.tenantId && x['case_id'] === i.caseId && x['status'] === 'open'); return d ? { ...d } : undefined; },
  async insertReportDraft(_tx: unknown, row: Row) { return row; }, async getReportDraft() { return undefined; }, async listReportDrafts() { return []; }, async updateReportDraft() { return undefined; },
}));
vi.mock('../repository/config.repo.js', () => ({
  async listStains(_tx: unknown, i: { tenantId: string; activeOnly?: boolean }) { return [...S.stains.values()].filter((s) => s['tenant_id'] === i.tenantId && (!i.activeOnly || s['is_active'] !== false)).map((s) => ({ ...s })); },
  async getStain(_tx: unknown, i: { tenantId: string; id: string }) { const r = [...S.stains.values()].find((s) => s['id'] === i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async getTestProfileByTestId(_tx: unknown, i: { tenantId: string; testId: string }) { const r = S.profiles.get(i.testId); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async getTestProfile(_tx: unknown, i: { id: string }) { return [...S.profiles.values()].find((p) => p['id'] === i.id); },
  async listTestProfiles() { return []; }, async getSettings() { return undefined; }, async insertSettings(_tx: unknown, row: Row) { return row; }, async updateSettings() { return undefined; },
  async insertStain(_tx: unknown, row: Row) { return row; }, async updateStain() { return undefined; },
}));

vi.mock('../repository/codedValues.repo.js', () => ({
  /** M4 adequacy check: honours activeOnly + limit/offset like the real repo (x-coded-set anatomic.cytology_adequacy) */
  async listCodedCytologyAdequacies(_tx: unknown, i: { tenantId: string; activeOnly?: boolean; limit?: number; offset?: number }) {
    const all = [...S.adequacy.values()].filter((r) => r['tenant_id'] === i.tenantId && (!i.activeOnly || r['is_active'] !== false));
    return all.slice(i.offset ?? 0, (i.offset ?? 0) + (i.limit ?? 50)).map((r) => ({ ...r }));
  },
}));

const { manifest } = await import('../index.js');

const T = '01a1a98a-ac40-7000-8000-00000000a001', OTHER_T = '01a1a98a-ac40-7000-8000-00000000b001', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const OTHER_CENTRE = '01a1a98a-ac40-7000-8000-00000000a202';
const ACTOR = '01a1a98a-ac40-7000-8000-00000000a300', MEMB = '01a1a98a-ac40-7000-8000-00000000a500';
const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-12T01:30:00Z');
const MARKER = 'PHI-MARKER-MATERIAL';
const ACC = 'S26-0042';

interface Setup { kind?: 'histology' | 'cytology' | 'ihc'; status?: string; parts?: number; tenant?: string; centre?: string; draft?: boolean; n?: number; acc?: string }
let seq = 0;
/** one case with `parts` parts (letters A, B, ...) */
function mkCase(o: Setup = {}) {
  const n = o.n ?? ++seq, t = o.tenant ?? T;
  const caseId = uid(1000 + n * 100);
  S.cases.set(caseId, { id: caseId, tenant_id: t, centre_id: o.centre ?? CENTRE, case_kind: o.kind ?? 'histology', status: o.status ?? 'accessioned', accession_no: o.kind === 'cytology' ? 'C26-0007' : (o.acc ?? ACC), order_id: uid(1001 + n * 100), version: 1 });
  const partIds: string[] = [];
  for (let i = 0; i < (o.parts ?? 1); i++) {
    const id = uid(1010 + n * 100 + i); partIds.push(id);
    S.parts.set(id, { id, tenant_id: t, centre_id: o.centre ?? CENTRE, case_id: caseId, letter: String.fromCharCode(65 + i), letter_seq: i + 1, site_text: 'Left breast', version: 1 });
  }
  if (o.draft) S.drafts.set(uid(1090 + n * 100), { id: uid(1090 + n * 100), tenant_id: t, case_id: caseId, status: 'open', kind: 'revision' });
  return { caseId, partIds, partId: partIds[0]!, n, t };
}
/** a block of part k of a case; returns its id */
function mkBlock(c: ReturnType<typeof mkCase>, bseq: number, location = 'in_lab', part = 0): string {
  const id = uid(2000 + c.n * 100 + part * 40 + bseq), letter = String.fromCharCode(65 + part);
  S.blocks.set(id, { id, tenant_id: c.t, centre_id: S.cases.get(c.caseId)!['centre_id'], case_id: c.caseId, part_id: c.partIds[part], seq: bseq, label: `${S.cases.get(c.caseId)!['accession_no']}-${letter}${bseq}`, location_status: location, location_text: null, version: 1 });
  return id;
}
let slideN = 0;
function mkSlide(c: ReturnType<typeof mkCase>, blockId: string | undefined, sseq: number, status: 'pending_stain' | 'ready' = 'pending_stain', location = 'in_lab'): string {
  const id = uid(5000 + c.n * 100 + ++slideN), blk = blockId ? S.blocks.get(blockId) : undefined;
  S.slides.set(id, {
    id, tenant_id: c.t, centre_id: S.cases.get(c.caseId)!['centre_id'], case_id: c.caseId, part_id: blk ? blk['part_id'] : c.partId, block_id: blockId ?? null, seq: sseq,
    label: blk ? `${blk['label']}-${sseq}` : `${S.cases.get(c.caseId)!['accession_no']}-A-${sseq}`, stain_code: 'HE', stain_id: uid(8001), status, ready_at: status === 'ready' ? NOW.toISOString() : null,
    location_status: location, location_text: null, include_in_report: false, version: 1,
  });
  return id;
}
function mkOrder(c: ReturnType<typeof mkCase>, o: { block?: string; part?: string; stain?: string; kind?: string; status?: string; addonItem?: string } = {}): string {
  const id = uid(6000 + c.n * 100 + ++slideN), st = S.stains.get(o.stain ?? 'IHC_ER')!;
  S.orders.set(id, {
    id, tenant_id: c.t, centre_id: S.cases.get(c.caseId)!['centre_id'], case_id: c.caseId, stain_id: st['id'], stain_code: st['code'], stain_kind: o.kind ?? st['kind'], block_id: o.block ?? null, part_id: o.block ? null : (o.part ?? c.partId),
    status: o.status ?? 'requested', note: null, reagent_lot: null, addon_case_item_id: o.addonItem ?? null, requested_at: NOW.toISOString(), requested_by_membership_id: MEMB, version: 1,
  });
  return id;
}
const blocksOf = (caseId: string) => [...S.blocks.values()].filter((b) => b['case_id'] === caseId);
const slidesOf = (caseId: string) => [...S.slides.values()].filter((s) => s['case_id'] === caseId);

interface CtxOpts { assertRole?: (c: unknown, i: Row) => Promise<unknown> }
const calls = { assertRole: [] as Row[], logs: [] as string[], access: [] as Row[], accessFails: false };
const mkCtx = (o: CtxOpts = {}) => ({
  operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999),
  log: { info: (x: object) => calls.logs.push(JSON.stringify(x)), warn: (x: object) => calls.logs.push(JSON.stringify(x)), error: (x: object) => calls.logs.push(JSON.stringify(x)) },
  tenantId: T, actor: { type: 'user', id: ACTOR, membershipId: MEMB }, tx: { async query() { return { rows: [] }; } }, now: () => NOW,
  audit: { async access(e: Row) { if (calls.accessFails) throw new Error('audit down'); calls.access.push(e); } },
  core: {
    async branch() { throw Object.assign(new Error('nf'), { code: 'common.not_found' }); },
    async user() { return { id: ACTOR, displayName: 'Synthetic Tech', isActive: true }; },
    memberships: { async list() { return []; } },
  },
  ports: {
    IdentityPort: {
      async assertRole(c: unknown, i: Row) { calls.assertRole.push(i); return o.assertRole ? o.assertRole(c, i) : undefined; },
      async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; },
    },
    FrontdeskPort: { async getOrderSummary(_c: unknown, i: { orderId: string }) { if (!S.orderSummary || S.orderSummary['orderId'] !== i.orderId) throw Object.assign(new Error('nf'), { code: 'common.not_found' }); return structuredClone(S.orderSummary); } },
  },
}) as any;

const snap = () => ({ b: structuredClone([...S.blocks]), s: structuredClone([...S.slides]), o: structuredClone([...S.orders]), m: structuredClone(S.moves), i: structuredClone([...S.items]) });
const restore = (x: ReturnType<typeof snap>) => { S.blocks = new Map(x.b) as never; S.slides = new Map(x.s) as never; S.orders = new Map(x.o) as never; S.moves = x.m as never; S.items = new Map(x.i) as never; };
/** emulates requestTx: a throwing handler rolls the whole transaction back */
async function call(op: string, req: Row, ctx = mkCtx()): Promise<any> {
  const s = snap();
  try { return await (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx); } catch (e) { restore(s); throw e; }
}
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const ifm = (v: number | string) => ({ 'if-match': `"${v}"` });
const state = () => JSON.stringify({ b: [...S.blocks], s: [...S.slides], o: [...S.orders], m: S.moves, i: [...S.items] });

const mkBlocks = (caseId: string, body: Row, ctx?: any) => call('createAnatomicBlocks', { params: { case_id: caseId }, body }, ctx);
const mkSlides = (caseId: string, body: Row, ctx?: any) => call('createAnatomicSlides', { params: { case_id: caseId }, body }, ctx);
const markReady = (ids: unknown, ctx?: any) => call('markAnatomicSlidesReady', { body: { ids } }, ctx);
const order = (caseId: string, body: Row, ctx?: any) => call('createAnatomicStainOrder', { params: { case_id: caseId }, body }, ctx);
const startOrder = (id: string, v = 1, ctx?: any) => call('startAnatomicStainOrder', { params: { stain_order_id: id }, headers: ifm(v) }, ctx);
const complete = (id: string, body: Row = { slide_count: 1 }, v = 1, ctx?: any) => call('completeAnatomicStainOrder', { params: { stain_order_id: id }, headers: ifm(v), body }, ctx);
const cancelOrder = (id: string, body: Row = { reason_text: 'Wrong block' }, v = 1, ctx?: any) => call('cancelAnatomicStainOrder', { params: { stain_order_id: id }, headers: ifm(v), body }, ctx);
const link = (id: string, body: Row, v = 1, ctx?: any) => call('linkAnatomicAddonItem', { params: { stain_order_id: id }, headers: ifm(v), body }, ctx);
const move = (body: Row, ctx?: any) => call('recordAnatomicMovements', { body }, ctx);
const labels = (caseId: string, query: Row = { kind: 'blocks' }, ctx?: any) => call('getAnatomicLabels', { params: { case_id: caseId }, query }, ctx);

beforeEach(() => {
  for (const m of [S.cases, S.parts, S.blocks, S.slides, S.orders, S.items, S.profiles, S.stains, S.drafts, S.adequacy] as Map<string, Row>[]) m.clear();
  for (const [n, code, active] of [[1, 'SAT', true], [2, 'LIM', true], [3, 'OLD', false]] as const) S.adequacy.set(code, { id: uid(8500 + n), tenant_id: T, code, display: `${code} (SYNTHETIC)`, is_active: active, sort_order: n, version: 1 });
  S.moves.length = 0; S.orderSummary = undefined; S.staleLists = false; S.tick = 0; S.itemWrites = 0; seq = 0; slideN = 0;
  const stain = (code: string, kind: string, n: number, active = true) => S.stains.set(code, { id: uid(8000 + n), tenant_id: T, code, display: `${code} (SYNTHETIC)`, kind, is_active: active, sort_order: n, version: 1 });
  stain('HE', 'routine', 1); stain('PAP', 'routine', 2); stain('PAS', 'special', 3); stain('IHC_ER', 'ihc', 4); stain('IHC_OFF', 'ihc', 5, false);
  calls.assertRole.length = 0; calls.logs.length = 0; calls.access.length = 0; calls.accessFails = false;
});

describe('C11-T09 M1 create blocks (AC-04.1, AC-04.2)', () => {
  it('AC-04.1: 3 blocks for part A -> S26-0042-A1..A3 in_lab; 2 more -> A4, A5; app-generated UUIDv7; my actor as creator; 201', async () => {
    const c = mkCase();
    const r = await mkBlocks(c.caseId, { part_id: c.partId, count: 3, note: 'Synthetic note' });
    expect(r.status).toBe(201);
    expect(r.body.blocks.map((b: Row) => b['label'])).toEqual(['S26-0042-A1', 'S26-0042-A2', 'S26-0042-A3']);
    expect(r.body.blocks[0]).toMatchObject({ part_id: c.partId, seq: 1, note: 'Synthetic note', location_status: 'in_lab', version: 1 });
    expect(JSON.stringify(r.body)).not.toContain(':null');
    const r2 = await mkBlocks(c.caseId, { part_id: c.partId, count: 2 });
    expect(r2.body.blocks.map((b: Row) => b['label'])).toEqual(['S26-0042-A4', 'S26-0042-A5']);
    const row = blocksOf(c.caseId)[0]!;
    expect(row).toMatchObject({ tenant_id: T, centre_id: CENTRE, case_id: c.caseId, created_by: ACTOR });
    expect(row['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.work', centreId: CENTRE });
  });

  it('numbering is per part: part B starts at B1; labels are unique across the tenant', async () => {
    const c = mkCase({ parts: 2 });
    await mkBlocks(c.caseId, { part_id: c.partIds[0], count: 2 });
    const r = await mkBlocks(c.caseId, { part_id: c.partIds[1], count: 2 });
    expect(r.body.blocks.map((b: Row) => b['label'])).toEqual(['S26-0042-B1', 'S26-0042-B2']);
    const all = blocksOf(c.caseId).map((b) => b['label']);
    expect(new Set(all).size).toBe(all.length);
  });

  it('count boundaries 1 and 50 are accepted; 0, 51, 1.5, "3", -1 -> 400 validation_failed and nothing written', async () => {
    const c = mkCase();
    expect((await mkBlocks(c.caseId, { part_id: c.partId, count: 1 })).status).toBe(201);
    expect((await mkBlocks(c.caseId, { part_id: c.partId, count: 50 })).body.blocks).toHaveLength(50);
    const before = state();
    for (const count of [0, 51, 1.5, '3', -1, null]) expect(await rejects(mkBlocks(c.caseId, { part_id: c.partId, count }))).toMatchObject({ code: 'common.validation_failed' });
    expect(state()).toBe(before);
  });

  it('note > 200 chars, unknown field (mass assignment: label, location_status, tenant_id), missing part_id -> 400, nothing written', async () => {
    const c = mkCase();
    for (const body of [
      { part_id: c.partId, count: 1, note: 'x'.repeat(201) }, { part_id: c.partId, count: 1, label: 'S26-9999-A1' }, { part_id: c.partId, count: 1, location_status: 'discarded' },
      { part_id: c.partId, count: 1, tenant_id: OTHER_T }, { count: 1 }, { part_id: 'not-a-uuid', count: 1 },
    ]) expect(await rejects(mkBlocks(c.caseId, body))).toMatchObject({ code: 'common.validation_failed' });
    expect(blocksOf(c.caseId)).toHaveLength(0);
  });

  it('AC-04.2: received case -> 409 anatomic.case_invalid_transition; cancelled too; no block written', async () => {
    for (const status of ['received', 'cancelled']) {
      const c = mkCase({ status });
      expect(await rejects(mkBlocks(c.caseId, { part_id: c.partId, count: 1 }))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
      expect(blocksOf(c.caseId)).toHaveLength(0);
    }
  });

  it('works in in_processing and ready_for_reporting; signed_out -> 409 anatomic.signout_locked, but allowed with an open change draft', async () => {
    // distinct accession_no per case: cases__tenant_id_accession_no__p_uq + blocks__tenant_id_label__uq (ruling T-09)
    for (const [i, status] of ['in_processing', 'ready_for_reporting'].entries()) { const c = mkCase({ status, acc: `S26-005${i}` }); expect((await mkBlocks(c.caseId, { part_id: c.partId, count: 1 })).status).toBe(201); }
    const locked = mkCase({ status: 'signed_out', acc: 'S26-0052' });
    expect(await rejects(mkBlocks(locked.caseId, { part_id: locked.partId, count: 1 }))).toMatchObject({ code: 'anatomic.signout_locked' });
    expect(blocksOf(locked.caseId)).toHaveLength(0);
    const open = mkCase({ status: 'signed_out', draft: true, acc: 'S26-0053' });
    expect((await mkBlocks(open.caseId, { part_id: open.partId, count: 1 })).status).toBe(201);
  });

  it('part of ANOTHER case (same tenant) or of another tenant -> 404 common.not_found, nothing written', async () => {
    const a = mkCase(), b = mkCase(), foreign = mkCase({ tenant: OTHER_T });
    expect(await rejects(mkBlocks(a.caseId, { part_id: b.partId, count: 1 }))).toMatchObject({ code: 'common.not_found' });
    expect(await rejects(mkBlocks(a.caseId, { part_id: foreign.partId, count: 1 }))).toMatchObject({ code: 'common.not_found' });
    expect(S.blocks.size).toBe(0);
  });

  it('case of another tenant / unknown / malformed id -> 404 before any permission check or write', async () => {
    const foreign = mkCase({ tenant: OTHER_T });
    for (const id of [foreign.caseId, uid(424242), 'zzz']) {
      calls.assertRole.length = 0;
      expect(await rejects(mkBlocks(id, { part_id: foreign.partId, count: 1 }))).toMatchObject({ code: 'common.not_found' });
      expect(calls.assertRole).toHaveLength(0);
    }
    expect(S.blocks.size).toBe(0);
  });

  it('IdentityPort denial (centre of the case) -> 403 propagated, nothing written', async () => {
    const c = mkCase();
    const denied = mkCtx({ assertRole: async () => { throw Object.assign(new Error('no'), { code: 'auth.forbidden' }); } });
    expect(await rejects(mkBlocks(c.caseId, { part_id: c.partId, count: 1 }, denied))).toMatchObject({ code: 'auth.forbidden' });
    expect(S.blocks.size).toBe(0);
  });

  it('concurrent writer (stale view of the part): unique label/seq clash -> 409 common.version_conflict, never common.internal, no duplicate label', async () => {
    const c = mkCase();
    await mkBlocks(c.caseId, { part_id: c.partId, count: 1 });
    S.staleLists = true; // second request still thinks the part has no block
    expect(await rejects(mkBlocks(c.caseId, { part_id: c.partId, count: 2 }))).toMatchObject({ code: 'common.version_conflict' });
    const labelsNow = blocksOf(c.caseId).map((b) => b['label']);
    expect(labelsNow).toEqual(['S26-0042-A1']); // rolled back as a whole: not even a half batch
  });

  it('a failing insert in the middle of a batch rolls the whole batch back', async () => {
    const c = mkCase();
    mkBlock(c, 3); // exists but listBlocks is stale -> A1, A2 insert fine, A3 clashes
    S.staleLists = true;
    expect(await rejects(mkBlocks(c.caseId, { part_id: c.partId, count: 3 }))).toMatchObject({ code: 'common.version_conflict' });
    expect(blocksOf(c.caseId)).toHaveLength(1);
  });
});

describe('C11-T09 M2 create slides (AC-04.3, AC-04.4, AC-04.5)', () => {
  it('AC-04.3: 2 H&E slides from block A1 -> S26-0042-A1-1, -A1-2; stain HE, pending_stain, in_lab; 201', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    const r = await mkSlides(c.caseId, { block_id: b, stain_code: 'HE', count: 2 });
    expect(r.status).toBe(201);
    expect(r.body.slides.map((s: Row) => s['label'])).toEqual(['S26-0042-A1-1', 'S26-0042-A1-2']);
    expect(r.body.slides[0]).toMatchObject({ block_id: b, part_id: c.partId, stain_code: 'HE', status: 'pending_stain', location_status: 'in_lab', include_in_report: false, version: 1 });
    expect(slidesOf(c.caseId)[0]).toMatchObject({ tenant_id: T, centre_id: CENTRE, case_id: c.caseId, stain_id: S.stains.get('HE')!['id'], created_by: ACTOR });
    expect(slidesOf(c.caseId)[0]!['ready_at'] ?? null).toBeNull();
    const more = await mkSlides(c.caseId, { block_id: b, stain_code: 'HE', count: 1 });
    expect(more.body.slides[0]!['label']).toBe('S26-0042-A1-3'); // continues the block's numbering
  });

  it('AC-04.4: cytology part without blocks, 4 PAP slides from the part -> C26-0007-A-1 … -A-4 (block_id absent)', async () => {
    const c = mkCase({ kind: 'cytology' });
    const r = await mkSlides(c.caseId, { part_id: c.partId, stain_code: 'PAP', count: 4 });
    expect(r.status).toBe(201);
    expect(r.body.slides.map((s: Row) => s['label'])).toEqual(['C26-0007-A-1', 'C26-0007-A-2', 'C26-0007-A-3', 'C26-0007-A-4']);
    expect(r.body.slides[0]).not.toHaveProperty('block_id');
    expect(slidesOf(c.caseId).every((s) => s['block_id'] === null || s['block_id'] === undefined)).toBe(true);
  });

  it('AC-04.5: block sent_out or discarded -> 409 anatomic.block_not_available, no slide written; in_lab and stored are fine', async () => {
    const c = mkCase();
    for (const [i, loc] of (['sent_out', 'discarded'] as const).entries()) {
      const b = mkBlock(c, i + 1, loc);
      expect(await rejects(mkSlides(c.caseId, { block_id: b, stain_code: 'HE', count: 1 }))).toMatchObject({ code: 'anatomic.block_not_available' });
    }
    expect(slidesOf(c.caseId)).toHaveLength(0);
    const stored = mkBlock(c, 3, 'stored');
    expect((await mkSlides(c.caseId, { block_id: stored, stain_code: 'HE', count: 1 })).status).toBe(201);
  });

  it('exactly one of block_id / part_id; count 1–20; unknown / inactive stain; unknown field -> 400 validation_failed (path of the field), nothing written', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    const cases: Array<[Row, string]> = [
      [{ stain_code: 'HE', count: 1 }, ''], [{ block_id: b, part_id: c.partId, stain_code: 'HE', count: 1 }, ''],
      [{ block_id: b, stain_code: 'HE', count: 0 }, '/count'], [{ block_id: b, stain_code: 'HE', count: 21 }, '/count'],
      [{ block_id: b, stain_code: 'NOPE', count: 1 }, '/stain_code'], [{ block_id: b, stain_code: 'IHC_OFF', count: 1 }, '/stain_code'],
      [{ block_id: b, stain_code: 'he', count: 1 }, '/stain_code'], [{ block_id: b, stain_code: 'HE', count: 1, status: 'ready' }, ''],
    ];
    for (const [body, path] of cases) {
      const e = await rejects(mkSlides(c.caseId, body));
      expect(e, JSON.stringify(body)).toMatchObject({ code: 'common.validation_failed' });
      if (path) expect(JSON.stringify(e.errors ?? [])).toContain(path);
    }
    expect(slidesOf(c.caseId)).toHaveLength(0);
  });

  it('count boundary 20 accepted', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    expect((await mkSlides(c.caseId, { block_id: b, stain_code: 'HE', count: 20 })).body.slides).toHaveLength(20);
  });

  it('received -> 409 case_invalid_transition; signed_out -> signout_locked; block/part of another case or tenant -> 404', async () => {
    const rec = mkCase({ status: 'received' });
    expect(await rejects(mkSlides(rec.caseId, { part_id: rec.partId, stain_code: 'HE', count: 1 }))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    const so = mkCase({ status: 'signed_out' });
    expect(await rejects(mkSlides(so.caseId, { part_id: so.partId, stain_code: 'HE', count: 1 }))).toMatchObject({ code: 'anatomic.signout_locked' });
    const a = mkCase(), b = mkCase(), f = mkCase({ tenant: OTHER_T });
    const bb = mkBlock(b, 1), fb = mkBlock(f, 1);
    expect(await rejects(mkSlides(a.caseId, { block_id: bb, stain_code: 'HE', count: 1 }))).toMatchObject({ code: 'common.not_found' });
    expect(await rejects(mkSlides(a.caseId, { block_id: fb, stain_code: 'HE', count: 1 }))).toMatchObject({ code: 'common.not_found' });
    expect(await rejects(mkSlides(a.caseId, { part_id: b.partId, stain_code: 'HE', count: 1 }))).toMatchObject({ code: 'common.not_found' });
    expect(S.slides.size).toBe(0);
  });

  it('concurrent writer: unique (tenant,label) clash -> 409 version_conflict, no duplicate label, no half batch', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    mkSlide(c, b, 1);
    S.staleLists = true;
    expect(await rejects(mkSlides(c.caseId, { block_id: b, stain_code: 'HE', count: 2 }))).toMatchObject({ code: 'common.version_conflict' });
    expect(slidesOf(c.caseId)).toHaveLength(1);
  });
});

describe('C11-T09 M3 bulk mark ready (AC-04.6)', () => {
  it('AC-04.6: pending_stain slides -> ready with ready_at = now, per-id outcome updated, in request order; already ready -> unchanged (no version bump)', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    const s1 = mkSlide(c, b, 1), s2 = mkSlide(c, b, 2), s3 = mkSlide(c, b, 3, 'ready');
    const r = await markReady([s2, s3, s1]);
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ id: s2, outcome: 'updated' }, { id: s3, outcome: 'unchanged' }, { id: s1, outcome: 'updated' }]);
    expect(S.slides.get(s1)).toMatchObject({ status: 'ready', ready_at: NOW.toISOString(), version: 2, updated_by: ACTOR });
    expect(S.slides.get(s3)!['version']).toBe(1);
    expect(calls.assertRole.every((a) => a['permission'] === 'anatomic.case.work' && a['centreId'] === CENTRE)).toBe(true);
  });

  it('mixed-tenant array: other tenant\'s and unknown ids -> per-id not_found (common.not_found semantics), own ids still updated, foreign slide untouched', async () => {
    const c = mkCase(), f = mkCase({ tenant: OTHER_T });
    const mine = mkSlide(c, mkBlock(c, 1), 1), theirs = mkSlide(f, mkBlock(f, 1), 1);
    const r = await markReady([theirs, mine, uid(777777)]);
    expect(r.body.results).toEqual([{ id: theirs, outcome: 'not_found' }, { id: mine, outcome: 'updated' }, { id: uid(777777), outcome: 'not_found' }]);
    expect(S.slides.get(theirs)).toMatchObject({ status: 'pending_stain', version: 1 });
  });

  it('slide of a cancelled case -> invalid_state, not changed', async () => {
    const c = mkCase({ status: 'cancelled' });
    const s = mkSlide(c, mkBlock(c, 1), 1);
    expect((await markReady([s])).body.results).toEqual([{ id: s, outcome: 'invalid_state' }]);
    expect(S.slides.get(s)!['status']).toBe('pending_stain');
  });

  it('ids bounds: 1 and 200 accepted; [] , 201, non-array, non-uuid, extra field -> 400 validation_failed and nothing written', async () => {
    const c = mkCase(); const s = mkSlide(c, mkBlock(c, 1), 1);
    expect((await markReady([s])).status).toBe(200);
    expect((await markReady(Array.from({ length: 200 }, (_, i) => uid(30000 + i)))).body.results).toHaveLength(200);
    const s2 = mkSlide(c, undefined, 9);
    const before = state();
    for (const ids of [[], Array.from({ length: 201 }, (_, i) => uid(30000 + i)), 'abc', null, ['not-a-uuid'], [s2, 5]]) expect(await rejects(markReady(ids))).toMatchObject({ code: 'common.validation_failed' });
    expect(await rejects(call('markAnatomicSlidesReady', { body: { ids: [s2], status: 'ready' } }))).toMatchObject({ code: 'common.validation_failed' });
    expect(state()).toBe(before);
  });

  it('IdentityPort denial for one slide\'s centre -> 403 for the request, NO slide of the batch is updated (atomic)', async () => {
    const a = mkCase(), b = mkCase({ centre: OTHER_CENTRE });
    const s1 = mkSlide(a, mkBlock(a, 1), 1), s2 = mkSlide(b, mkBlock(b, 1), 1);
    const ctx = mkCtx({ assertRole: async (_c, i) => { if (i['centreId'] === OTHER_CENTRE) throw Object.assign(new Error('no'), { code: 'auth.forbidden' }); } });
    expect(await rejects(markReady([s1, s2], ctx))).toMatchObject({ code: 'auth.forbidden' });
    expect(S.slides.get(s1)!['status']).toBe('pending_stain');
  });

  it('duplicate id in one request is applied once (version 2, not 3)', async () => {
    const c = mkCase(); const s = mkSlide(c, mkBlock(c, 1), 1);
    const r = await markReady([s, s]);
    expect(r.body.results).toHaveLength(2);
    expect(S.slides.get(s)!['version']).toBe(2);
  });
});

describe('C11-T09 M5 create stain order (AC-05.1, AC-05.2, AC-05.7, E14)', () => {
  it('AC-05.1: IHC_ER on block A2 -> 201 requested, linked to the block; stored with my membership, now, stain kind/id', async () => {
    const c = mkCase(); mkBlock(c, 1); const b2 = mkBlock(c, 2);
    const r = await order(c.caseId, { stain_code: 'IHC_ER', block_id: b2, note: 'Synthetic note' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ stain_code: 'IHC_ER', stain_kind: 'ihc', block_id: b2, block_label: 'S26-0042-A2', status: 'requested', note: 'Synthetic note', requested_by_display_name: 'Synthetic Tech', version: 1 });
    expect(JSON.stringify(r.body)).not.toContain(':null');
    const row = [...S.orders.values()][0]!;
    expect(row).toMatchObject({ tenant_id: T, centre_id: CENTRE, case_id: c.caseId, stain_id: S.stains.get('IHC_ER')!['id'], stain_kind: 'ihc', block_id: b2, status: 'requested', requested_by_membership_id: MEMB, created_by: ACTOR });
    expect(row['part_id'] ?? null).toBeNull();
    expect(new Date(row['requested_at']).toISOString()).toBe(NOW.toISOString());
  });

  it('AC-05.2: IHC without block_id (also with part_id only) -> anatomic.ihc_requires_block, nothing written', async () => {
    const c = mkCase();
    expect(await rejects(order(c.caseId, { stain_code: 'IHC_ER' }))).toMatchObject({ code: 'anatomic.ihc_requires_block' });
    expect(await rejects(order(c.caseId, { stain_code: 'IHC_ER', part_id: c.partId }))).toMatchObject({ code: 'anatomic.ihc_requires_block' });
    expect(S.orders.size).toBe(0);
  });

  it('special stain: block OR part is accepted (stored as exactly one target); both or none -> 400 validation_failed', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    const onPart = await order(c.caseId, { stain_code: 'PAS', part_id: c.partId });
    expect(onPart.body).toMatchObject({ stain_kind: 'special', part_id: c.partId });
    expect(onPart.body).not.toHaveProperty('block_id');
    expect((await order(c.caseId, { stain_code: 'PAS', block_id: b })).status).toBe(201);
    for (const body of [{ stain_code: 'PAS' }, { stain_code: 'PAS', block_id: b, part_id: c.partId }]) expect(await rejects(order(c.caseId, body))).toMatchObject({ code: 'common.validation_failed' });
    expect(S.orders.size).toBe(2);
  });

  it('AC-05.7: routine stain (HE, PAP) -> 400 common.validation_failed at /stain_code; unknown, inactive or malformed code too; nothing written', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    for (const code of ['HE', 'PAP', 'NOPE', 'IHC_OFF', '', 'ihc_er']) {
      const e = await rejects(order(c.caseId, { stain_code: code, block_id: b }));
      expect(e, code).toMatchObject({ code: 'common.validation_failed' });
      expect(JSON.stringify(e.errors ?? [])).toContain('/stain_code');
    }
    expect(S.orders.size).toBe(0);
  });

  it('AC-05.6 / E14: block sent_out -> order IS created; block discarded -> 409 anatomic.block_not_available at once (only discarded refuses at M5)', async () => {
    const c = mkCase(); const sent = mkBlock(c, 1, 'sent_out'), gone = mkBlock(c, 2, 'discarded'), stored = mkBlock(c, 3, 'stored');
    expect((await order(c.caseId, { stain_code: 'IHC_ER', block_id: sent })).status).toBe(201);
    expect((await order(c.caseId, { stain_code: 'IHC_ER', block_id: stored })).status).toBe(201);
    expect(await rejects(order(c.caseId, { stain_code: 'IHC_ER', block_id: gone }))).toMatchObject({ code: 'anatomic.block_not_available' });
    expect(S.orders.size).toBe(2);
  });

  it('block / part of another case or tenant -> 404; unknown field and note > 500 -> 400; received -> case_invalid_transition; signed_out -> signout_locked', async () => {
    const a = mkCase(), o = mkCase(), f = mkCase({ tenant: OTHER_T });
    const ob = mkBlock(o, 1), fb = mkBlock(f, 1), ab = mkBlock(a, 1);
    expect(await rejects(order(a.caseId, { stain_code: 'IHC_ER', block_id: ob }))).toMatchObject({ code: 'common.not_found' });
    expect(await rejects(order(a.caseId, { stain_code: 'IHC_ER', block_id: fb }))).toMatchObject({ code: 'common.not_found' });
    expect(await rejects(order(a.caseId, { stain_code: 'PAS', part_id: o.partId }))).toMatchObject({ code: 'common.not_found' });
    expect(await rejects(order(a.caseId, { stain_code: 'IHC_ER', block_id: ab, status: 'completed' }))).toMatchObject({ code: 'common.validation_failed' });
    expect(await rejects(order(a.caseId, { stain_code: 'IHC_ER', block_id: ab, note: 'x'.repeat(501) }))).toMatchObject({ code: 'common.validation_failed' });
    const rec = mkCase({ status: 'received' }), so = mkCase({ status: 'signed_out' });
    expect(await rejects(order(rec.caseId, { stain_code: 'PAS', part_id: rec.partId }))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    expect(await rejects(order(so.caseId, { stain_code: 'PAS', part_id: so.partId }))).toMatchObject({ code: 'anatomic.signout_locked' });
    expect(S.orders.size).toBe(0);
  });

  it('addon_order_item_id of an INACTIVE case item -> 409 anatomic.order_item_inactive; an active one is stored as addon_case_item_id', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    const live = uid(7001), dead = uid(7002);
    S.items.set(live, { id: live, tenant_id: T, case_id: c.caseId, order_item_id: uid(7101), test_id: uid(7201), role: 'addon', is_active: true });
    S.items.set(dead, { id: dead, tenant_id: T, case_id: c.caseId, order_item_id: uid(7102), test_id: uid(7202), role: 'addon', is_active: false });
    expect(await rejects(order(c.caseId, { stain_code: 'IHC_ER', block_id: b, addon_order_item_id: uid(7102) }))).toMatchObject({ code: 'anatomic.order_item_inactive' });
    expect(S.orders.size).toBe(0);
    await order(c.caseId, { stain_code: 'IHC_ER', block_id: b, addon_order_item_id: uid(7101) });
    expect([...S.orders.values()][0]!['addon_case_item_id']).toBe(live);
  });
});

describe('C11-T09 M7/M8/M9 stain order life cycle (AC-05.3, AC-05.5, AC-05.6)', () => {
  it('M7 start: requested -> in_progress with started_at; If-Match n; wrong version 409 version_conflict; 428 without; not requested -> case_invalid_transition', async () => {
    const c = mkCase(); const o = mkOrder(c, { block: mkBlock(c, 1) });
    const r = await startOrder(o);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: o, status: 'in_progress', version: 2 });
    expect(S.orders.get(o)!['started_at']).toBeTruthy();
    expect(await rejects(startOrder(o, 2))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    const o2 = mkOrder(c, { block: mkBlock(c, 2) });
    expect(await rejects(startOrder(o2, 5))).toMatchObject({ code: 'common.version_conflict' });
    expect(await rejects(call('startAnatomicStainOrder', { params: { stain_order_id: o2 }, headers: {} }))).toMatchObject({ code: 'common.precondition_required' });
    expect(S.orders.get(o2)!['status']).toBe('requested');
  });

  it('AC-05.3: complete requested order with 1 slide + lot L-TEST-01 -> slide S26-0042-A2-3 (after 2 existing), stain IHC_ER, status ready; order completed; 200', async () => {
    const c = mkCase(); mkBlock(c, 1); const b2 = mkBlock(c, 2); mkSlide(c, b2, 1); mkSlide(c, b2, 2);
    const o = mkOrder(c, { block: b2 });
    const r = await complete(o, { slide_count: 1, reagent_lot: 'L-TEST-01' });
    expect(r.status).toBe(200);
    expect(r.body.slides).toHaveLength(1);
    expect(r.body.slides[0]).toMatchObject({ label: 'S26-0042-A2-3', block_id: b2, stain_code: 'IHC_ER', status: 'ready', stain_order_id: o });
    expect(r.body.stain_order).toMatchObject({ id: o, status: 'completed', reagent_lot: 'L-TEST-01', version: 2 });
    const slide = slidesOf(c.caseId).find((s) => s['label'] === 'S26-0042-A2-3')!;
    expect(slide).toMatchObject({ status: 'ready', ready_at: NOW.toISOString(), stain_id: S.stains.get('IHC_ER')!['id'], stain_order_id: o, created_by: ACTOR });
    expect(S.orders.get(o)).toMatchObject({ status: 'completed', reagent_lot: 'L-TEST-01', completed_at: expect.anything() });
  });

  it('complete from in_progress works; part-targeted special stain makes block-less slides labelled from the part; performed_at in the past is stored, in the future -> 400 at /performed_at', async () => {
    const c = mkCase(); const o = mkOrder(c, { stain: 'PAS', part: c.partId, status: 'in_progress' });
    const r = await complete(o, { slide_count: 2, performed_at: '2026-11-11T08:00:00.000Z' });
    expect(r.body.slides.map((s: Row) => s['label'])).toEqual(['S26-0042-A-1', 'S26-0042-A-2']);
    expect(S.orders.get(o)!['performed_at']).toBeTruthy();
    const o2 = mkOrder(c, { stain: 'PAS', part: c.partId });
    const e = await rejects(complete(o2, { slide_count: 1, performed_at: '2026-11-13T01:30:00.000Z' }));
    expect(e).toMatchObject({ code: 'common.validation_failed' });
    expect(JSON.stringify(e.errors ?? [])).toContain('/performed_at');
    expect(S.orders.get(o2)!['status']).toBe('requested');
  });

  it('body bounds: slide_count 0/21/1.5, reagent_lot 65 chars, unknown field -> 400 and nothing written; boundary 20 and 64 accepted', async () => {
    const c = mkCase(); const b = mkBlock(c, 1); const o = mkOrder(c, { block: b });
    for (const body of [{ slide_count: 0 }, { slide_count: 21 }, { slide_count: 1.5 }, { slide_count: 1, reagent_lot: 'x'.repeat(65) }, { slide_count: 1, status: 'cancelled' }, {}]) {
      expect(await rejects(complete(o, body))).toMatchObject({ code: 'common.validation_failed' });
    }
    expect(slidesOf(c.caseId)).toHaveLength(0);
    expect((await complete(o, { slide_count: 20, reagent_lot: 'x'.repeat(64) })).body.slides).toHaveLength(20);
  });

  it('AC-05.6: sent_out block -> complete 409 anatomic.block_not_available (nothing written) until the block is returned; then complete works', async () => {
    const c = mkCase(); const b = mkBlock(c, 1, 'sent_out'); const o = mkOrder(c, { block: b });
    expect(await rejects(complete(o))).toMatchObject({ code: 'anatomic.block_not_available' });
    expect(slidesOf(c.caseId)).toHaveLength(0);
    expect(S.orders.get(o)!['status']).toBe('requested');
    expect((await move({ object_kind: 'block', object_ids: [b], movement: 'returned' })).body.results).toEqual([{ id: b, outcome: 'recorded' }]);
    expect((await complete(o)).status).toBe(200);
  });

  it('discarded block -> complete 409 block_not_available; completed or cancelled order -> case_invalid_transition; wrong If-Match -> version_conflict; nothing written', async () => {
    const c = mkCase();
    const gone = mkOrder(c, { block: mkBlock(c, 1, 'discarded') });
    expect(await rejects(complete(gone))).toMatchObject({ code: 'anatomic.block_not_available' });
    const done = mkOrder(c, { block: mkBlock(c, 2), status: 'completed' }), canc = mkOrder(c, { block: mkBlock(c, 3), status: 'cancelled' }), fresh = mkOrder(c, { block: mkBlock(c, 4) });
    expect(await rejects(complete(done))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    expect(await rejects(complete(canc))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    expect(await rejects(complete(fresh, { slide_count: 1 }, 9))).toMatchObject({ code: 'common.version_conflict' });
    expect(slidesOf(c.caseId)).toHaveLength(0);
  });

  it('two parallel completes of the same order: the second sees completed/stale version and creates no slides', async () => {
    const c = mkCase(); const o = mkOrder(c, { block: mkBlock(c, 1) });
    await complete(o);
    expect(await rejects(complete(o))).toMatchObject({ code: expect.stringMatching(/^(anatomic\.case_invalid_transition|common\.version_conflict)$/) });
    expect(slidesOf(c.caseId)).toHaveLength(1);
  });

  it('M9 cancel: requested/in_progress -> cancelled with reason, cancelled_at; blocks/slides untouched; completed -> case_invalid_transition; reason 1–500', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    const o = mkOrder(c, { block: b }), o2 = mkOrder(c, { block: b, status: 'in_progress' }), done = mkOrder(c, { block: b, status: 'completed' });
    const r = await cancelOrder(o, { reason_text: 'Ordered on the wrong block' });
    expect(r.body).toMatchObject({ id: o, status: 'cancelled', version: 2 });
    expect(S.orders.get(o)).toMatchObject({ status: 'cancelled', cancel_reason_text: 'Ordered on the wrong block' });
    expect(S.orders.get(o)!['cancelled_at']).toBeTruthy();
    expect((await cancelOrder(o2)).body.status).toBe('cancelled');
    expect(await rejects(cancelOrder(done))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    for (const body of [{}, { reason_text: '' }, { reason_text: 'x'.repeat(501) }, { reason_text: 'ok', status: 'requested' }]) {
      expect(await rejects(cancelOrder(mkOrder(c, { block: b }), body))).toMatchObject({ code: 'common.validation_failed' });
    }
    expect(S.blocks.get(b)).toMatchObject({ location_status: 'in_lab', version: 1 });
  });

  it('AC-05.5: cancelling an order linked to an add-on item leaves the add-on case item untouched (no insert/update/deactivate)', async () => {
    const c = mkCase(); const item = uid(7003);
    S.items.set(item, { id: item, tenant_id: T, case_id: c.caseId, order_item_id: uid(7103), test_id: uid(7203), role: 'addon', is_active: true, version: 1 });
    const o = mkOrder(c, { block: mkBlock(c, 1), addonItem: item });
    S.itemWrites = 0;
    await cancelOrder(o);
    expect(S.itemWrites).toBe(0);
    expect(S.items.get(item)).toMatchObject({ is_active: true, role: 'addon', version: 1 });
  });

  it('object-scoped probes: another tenant\'s / unknown order id -> 404 for start, complete, cancel, link-addon; no write; permission check only for visible orders', async () => {
    const f = mkCase({ tenant: OTHER_T }); const fo = mkOrder(f, { block: mkBlock(f, 1) });
    calls.assertRole.length = 0;
    for (const id of [fo, uid(888888)]) {
      expect(await rejects(startOrder(id))).toMatchObject({ code: 'common.not_found' });
      expect(await rejects(complete(id))).toMatchObject({ code: 'common.not_found' });
      expect(await rejects(cancelOrder(id))).toMatchObject({ code: 'common.not_found' });
      expect(await rejects(link(id, { order_item_id: uid(7103) }))).toMatchObject({ code: 'common.not_found' });
    }
    expect(calls.assertRole).toHaveLength(0);
    expect(S.orders.get(fo)).toMatchObject({ status: 'requested', version: 1 });
  });
});

describe('C11-T09 M10 link add-on item (AC-05.4)', () => {
  const setup = (o: { active?: boolean; addon?: boolean; existing?: 'none' | 'addon' } = {}) => {
    const c = mkCase(); const b = mkBlock(c, 1); const ord = mkOrder(c, { block: b });
    const orderItemId = uid(7300), testId = uid(7400);
    S.orderSummary = { orderId: S.cases.get(c.caseId)!['order_id'], items: [{ orderItemId, testId, status: o.active === false ? 'cancelled' : 'active', priority: 'routine' }] };
    S.profiles.set(testId, { id: uid(7500), tenant_id: T, test_id: testId, case_kind: 'histology', is_addon: o.addon ?? true, requires_gross: false, is_active: true });
    if (o.existing === 'addon') S.items.set(uid(7600), { id: uid(7600), tenant_id: T, case_id: c.caseId, order_item_id: orderItemId, test_id: testId, role: 'addon', is_active: true, version: 1 });
    return { c, ord, orderItemId, testId };
  };

  it('AC-05.4: active add-on order item (profile is_addon), not linked -> case_items row role addon exists and the stain order points at it', async () => {
    const { c, ord, orderItemId, testId } = setup();
    const r = await link(ord, { order_item_id: orderItemId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ord, addon_order_item_id: orderItemId });
    const item = [...S.items.values()].find((i) => i['order_item_id'] === orderItemId)!;
    expect(item).toMatchObject({ tenant_id: T, centre_id: CENTRE, case_id: c.caseId, test_id: testId, role: 'addon', created_by: ACTOR });
    expect(S.orders.get(ord)!['addon_case_item_id']).toBe(item['id']);
  });

  it('an add-on case item already created at intake (role addon) is reused, not duplicated', async () => {
    const { ord, orderItemId } = setup({ existing: 'addon' });
    await link(ord, { order_item_id: orderItemId });
    expect([...S.items.values()].filter((i) => i['order_item_id'] === orderItemId)).toHaveLength(1);
    expect(S.orders.get(ord)!['addon_case_item_id']).toBe(uid(7600));
  });

  it('order item not active -> 409 anatomic.order_item_inactive; profile not is_addon, item not in the order, already linked to another stain order -> 400 validation_failed at /order_item_id', async () => {
    const dead = setup({ active: false });
    expect(await rejects(link(dead.ord, { order_item_id: dead.orderItemId }))).toMatchObject({ code: 'anatomic.order_item_inactive' });
    const plain = setup({ addon: false });
    const e = await rejects(link(plain.ord, { order_item_id: plain.orderItemId }));
    expect(e).toMatchObject({ code: 'common.validation_failed' });
    expect(JSON.stringify(e.errors ?? [])).toContain('/order_item_id');
    const stray = setup();
    expect(await rejects(link(stray.ord, { order_item_id: uid(7999) }))).toMatchObject({ code: expect.stringMatching(/^(common\.validation_failed|common\.not_found)$/) });
    const dup = setup({ existing: 'addon' });
    const other = mkOrder(dup.c, { block: mkBlock(dup.c, 2), addonItem: uid(7600) });
    expect(other).toBeTruthy();
    expect(await rejects(link(dup.ord, { order_item_id: dup.orderItemId }))).toMatchObject({ code: 'common.validation_failed' });
    expect(S.orders.get(dup.ord)!['addon_case_item_id'] ?? null).toBeNull();
  });

  it('If-Match: missing 428, stale 409 version_conflict; body closed (unknown field) and order_item_id must be a uuid -> 400', async () => {
    const { ord, orderItemId } = setup();
    expect(await rejects(call('linkAnatomicAddonItem', { params: { stain_order_id: ord }, headers: {}, body: { order_item_id: orderItemId } }))).toMatchObject({ code: 'common.precondition_required' });
    expect(await rejects(link(ord, { order_item_id: orderItemId }, 9))).toMatchObject({ code: 'common.version_conflict' });
    expect(await rejects(link(ord, { order_item_id: orderItemId, test_id: uid(1) }))).toMatchObject({ code: 'common.validation_failed' });
    expect(await rejects(link(ord, { order_item_id: 'nope' }))).toMatchObject({ code: 'common.validation_failed' });
    expect(S.itemWrites).toBe(0);
  });
});

describe('C11-T09 M11 movements (AC-06.1, AC-06.4, AC-06.5)', () => {
  it('AC-06.1: block in the lab -> sent_out to "Synthetic Referral Lab" with reason second_opinion -> location sent_out and one movement row with from/to status', async () => {
    const c = mkCase(); const b = mkBlock(c, 3);
    const r = await move({ object_kind: 'block', object_ids: [b], movement: 'sent_out', destination_text: 'Synthetic Referral Lab', reason_code: 'second_opinion', note: 'Synthetic note' });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ id: b, outcome: 'recorded' }]);
    expect(S.blocks.get(b)).toMatchObject({ location_status: 'sent_out', version: 2 });
    expect(S.moves).toHaveLength(1);
    expect(S.moves[0]).toMatchObject({
      tenant_id: T, centre_id: CENTRE, case_id: c.caseId, object_kind: 'block', object_id: b, movement: 'sent_out', from_location_status: 'in_lab', to_location_status: 'sent_out',
      destination_text: 'Synthetic Referral Lab', reason_code: 'second_opinion', note: 'Synthetic note', created_by: ACTOR,
    });
    expect(S.moves[0]!['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('guard table (blocks and slides): stored from in_lab|stored; retrieved only from stored -> in_lab; sent_out from in_lab|stored; returned only from sent_out -> in_lab; discarded from in_lab|stored; everything else invalid_state', async () => {
    const c = mkCase();
    const kinds: Array<['block' | 'slide', (loc: string) => string]> = [['block', (loc) => mkBlock(c, ++seq + 10, loc)], ['slide', (loc) => mkSlide(c, undefined, ++seq + 10, 'ready', loc)]];
    const extra: Record<string, Row> = { stored: { location_text: 'Cabinet 3' }, sent_out: { destination_text: 'Synthetic Referral Lab', reason_code: 'consultation' }, discarded: { reason_code: 'retention_expired' } };
    const to: Record<string, string> = { stored: 'stored', retrieved: 'in_lab', sent_out: 'sent_out', returned: 'in_lab', discarded: 'discarded' };
    const allowed: Record<string, string[]> = { stored: ['in_lab', 'stored'], retrieved: ['stored'], sent_out: ['in_lab', 'stored'], returned: ['sent_out'], discarded: ['in_lab', 'stored'] };
    for (const [kind, make] of kinds) {
      for (const mv of Object.keys(allowed)) {
        for (const loc of ['in_lab', 'stored', 'sent_out', 'discarded']) {
          const id = make(loc);
          const before = S.moves.length;
          const r = await move({ object_kind: kind, object_ids: [id], movement: mv, ...(extra[mv] ?? {}) });
          const ok = allowed[mv]!.includes(loc);
          expect(r.body.results, `${kind} ${mv} from ${loc}`).toEqual([{ id, outcome: ok ? 'recorded' : 'invalid_state' }]);
          expect(S.moves.length - before, `${kind} ${mv} from ${loc} rows`).toBe(ok ? 1 : 0);
          const now = (kind === 'block' ? S.blocks : S.slides).get(id)!['location_status'];
          expect(now, `${kind} ${mv} from ${loc} status`).toBe(ok ? to[mv] : loc);
        }
      }
    }
  });

  it('AC-06.4: discarded block -> ANY further movement invalid_state and no row; creating slides from it -> 409 block_not_available', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    await move({ object_kind: 'block', object_ids: [b], movement: 'discarded', reason_code: 'retention_expired' });
    const rows = S.moves.length;
    for (const mv of ['stored', 'retrieved', 'sent_out', 'returned', 'discarded']) {
      const r = await move({ object_kind: 'block', object_ids: [b], movement: mv, location_text: 'Cabinet 1', destination_text: 'Lab', reason_code: 'other' });
      expect(r.body.results).toEqual([{ id: b, outcome: 'invalid_state' }]);
    }
    expect(S.moves).toHaveLength(rows);
    expect(await rejects(mkSlides(c.caseId, { block_id: b, stain_code: 'HE', count: 1 }))).toMatchObject({ code: 'anatomic.block_not_available' });
  });

  it('AC-06.5: sent_out or discarded without reason_code -> 400 validation_failed at /reason_code; stored without location_text -> /location_text; sent_out without destination_text -> /destination_text; no row, no status change', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    const cases: Array<[Row, string]> = [
      [{ movement: 'sent_out', destination_text: 'Lab' }, '/reason_code'], [{ movement: 'discarded' }, '/reason_code'], [{ movement: 'stored' }, '/location_text'],
      [{ movement: 'sent_out', reason_code: 'other' }, '/destination_text'], [{ movement: 'discarded', reason_code: 'bogus' }, '/reason_code'],
    ];
    for (const [extra, path] of cases) {
      const e = await rejects(move({ object_kind: 'block', object_ids: [b], ...extra }));
      expect(e, JSON.stringify(extra)).toMatchObject({ code: 'common.validation_failed' });
      expect(JSON.stringify(e.errors ?? [])).toContain(path);
    }
    expect(S.moves).toHaveLength(0);
    expect(S.blocks.get(b)).toMatchObject({ location_status: 'in_lab', version: 1 });
  });

  it('body validation: object_kind/movement enums, object_ids 1–200 uuids, text lengths (location 120, destination 200, note 500), unknown field -> 400 and nothing written (even for the valid ids of the batch)', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    const base = { object_kind: 'block', object_ids: [b], movement: 'retrieved' };
    const bad: Row[] = [
      { ...base, object_kind: 'case' }, { ...base, movement: 'lost' }, { ...base, object_ids: [] }, { ...base, object_ids: Array.from({ length: 201 }, (_, i) => uid(40000 + i)) },
      { ...base, object_ids: ['x'] }, { ...base, movement: 'stored', location_text: 'x'.repeat(121) }, { ...base, movement: 'sent_out', destination_text: 'x'.repeat(201), reason_code: 'other' },
      { ...base, note: 'x'.repeat(501) }, { ...base, status: 'discarded' }, { ...base, object_ids: [b, 'nope'] },
    ];
    for (const body of bad) expect(await rejects(move(body))).toMatchObject({ code: 'common.validation_failed' });
    expect(S.moves).toHaveLength(0);
    expect((await move({ ...base, object_ids: [b], movement: 'stored', location_text: 'x'.repeat(120) })).body.results[0]).toEqual({ id: b, outcome: 'recorded' });
  });

  it('mixed-tenant array: other tenant\'s block/slide ids and unknown ids -> per-id not_found, own ids recorded, the foreign object untouched, no row for it', async () => {
    const c = mkCase(), f = mkCase({ tenant: OTHER_T });
    const mine = mkBlock(c, 1), theirs = mkBlock(f, 1);
    const r = await move({ object_kind: 'block', object_ids: [theirs, mine, uid(999999)], movement: 'stored', location_text: 'Cabinet 2' });
    expect(r.body.results).toEqual([{ id: theirs, outcome: 'not_found' }, { id: mine, outcome: 'recorded' }, { id: uid(999999), outcome: 'not_found' }]);
    expect(S.blocks.get(theirs)).toMatchObject({ location_status: 'in_lab', version: 1 });
    expect(S.moves.map((m) => m['object_id'])).toEqual([mine]);
  });

  it('a slide id sent as object_kind block (kind mismatch) is not_found, not a movement', async () => {
    const c = mkCase(); const s = mkSlide(c, mkBlock(c, 1), 1);
    expect((await move({ object_kind: 'block', object_ids: [s], movement: 'retrieved' })).body.results).toEqual([{ id: s, outcome: 'not_found' }]);
    expect(S.moves).toHaveLength(0);
  });

  it('permission: assertRole(case.work) per object with that object\'s case centre; a denial rejects the request and writes nothing for the batch', async () => {
    const a = mkCase(), b = mkCase({ centre: OTHER_CENTRE });
    const x = mkBlock(a, 1), y = mkBlock(b, 1);
    const ctx = mkCtx({ assertRole: async (_c, i) => { if (i['centreId'] === OTHER_CENTRE) throw Object.assign(new Error('no'), { code: 'auth.forbidden' }); } });
    expect(await rejects(move({ object_kind: 'block', object_ids: [x, y], movement: 'stored', location_text: 'C1' }, ctx))).toMatchObject({ code: 'auth.forbidden' });
    expect(S.moves).toHaveLength(0);
    expect(S.blocks.get(x)!['location_status']).toBe('in_lab');
  });

  it('PHI hygiene: a validation error never echoes the submitted note/destination, and nothing is logged with it', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    const e = await rejects(move({ object_kind: 'block', object_ids: [b], movement: 'sent_out', destination_text: MARKER, note: MARKER, reason_code: 'bogus' }));
    expect(JSON.stringify({ code: e.code, message: e.message, errors: e.errors, detail: e.detail })).not.toContain(MARKER);
    await move({ object_kind: 'block', object_ids: [b], movement: 'sent_out', destination_text: MARKER, note: MARKER, reason_code: 'other' });
    expect(calls.logs.join('\n')).not.toContain(MARKER);
  });
});

describe('C11-T09 M13/M14 movement history (AC-06.2) and 404 probes (AC-06.3)', () => {
  it('AC-06.2: block history is newest first with movement, texts, reason, at, by_display_name; no null on the wire', async () => {
    const c = mkCase(); const b = mkBlock(c, 3);
    await move({ object_kind: 'block', object_ids: [b], movement: 'stored', location_text: 'Cabinet 3' });
    await move({ object_kind: 'block', object_ids: [b], movement: 'retrieved' });
    await move({ object_kind: 'block', object_ids: [b], movement: 'sent_out', destination_text: 'Synthetic Referral Lab', reason_code: 'second_opinion' });
    const r = await call('listAnatomicBlockMovements', { params: { block_id: b }, query: {} });
    expect(r.status).toBe(200);
    expect(r.body.data.map((m: Row) => m['movement'])).toEqual(['sent_out', 'retrieved', 'stored']);
    expect(r.body.data[0]).toMatchObject({ movement: 'sent_out', destination_text: 'Synthetic Referral Lab', reason_code: 'second_opinion', by_display_name: 'Synthetic Tech' });
    expect(r.body.data[0].at).toMatch(/^2026-11-12T01:00:0\dZ$|^2026-11-12T01:00:0\d\.000Z$/);
    expect(r.body.data[0].at > r.body.data[2].at).toBe(true);
    expect(JSON.stringify(r.body.data)).not.toContain(':null');
    expect(r.body.page).toBeDefined();
    expect(calls.assertRole.pop()).toMatchObject({ permission: 'anatomic.case.read', centreId: CENTRE });
  });

  it('slide history is newest first and holds only that slide\'s movements', async () => {
    const c = mkCase(); const s1 = mkSlide(c, undefined, 1, 'ready'), s2 = mkSlide(c, undefined, 2, 'ready');
    await move({ object_kind: 'slide', object_ids: [s1], movement: 'stored', location_text: 'Drawer 1' });
    await move({ object_kind: 'slide', object_ids: [s2], movement: 'stored', location_text: 'Drawer 2' });
    await move({ object_kind: 'slide', object_ids: [s1], movement: 'retrieved' });
    const r = await call('listAnatomicSlideMovements', { params: { slide_id: s1 }, query: {} });
    expect(r.body.data.map((m: Row) => m['movement'])).toEqual(['retrieved', 'stored']);
  });

  it('AC-06.3 analogue: another tenant\'s / unknown / malformed block or slide id -> 404 common.not_found, no permission check, nothing leaked', async () => {
    const f = mkCase({ tenant: OTHER_T }); const fb = mkBlock(f, 1), fs = mkSlide(f, fb, 1);
    S.moves.push({ id: uid(1), tenant_id: OTHER_T, case_id: f.caseId, object_kind: 'block', object_id: fb, movement: 'stored', location_text: 'SECRET-SHELF', created_at: NOW.toISOString() });
    calls.assertRole.length = 0;
    for (const id of [fb, uid(555555), 'nope']) expect(await rejects(call('listAnatomicBlockMovements', { params: { block_id: id }, query: {} }))).toMatchObject({ code: 'common.not_found' });
    for (const id of [fs, uid(555556), 'nope']) expect(await rejects(call('listAnatomicSlideMovements', { params: { slide_id: id }, query: {} }))).toMatchObject({ code: 'common.not_found' });
    expect(calls.assertRole).toHaveLength(0);
  });

  it('a block id used on the slide endpoint (and vice versa) -> 404', async () => {
    const c = mkCase(); const b = mkBlock(c, 1); const s = mkSlide(c, b, 1);
    expect(await rejects(call('listAnatomicSlideMovements', { params: { slide_id: b }, query: {} }))).toMatchObject({ code: 'common.not_found' });
    expect(await rejects(call('listAnatomicBlockMovements', { params: { block_id: s }, query: {} }))).toMatchObject({ code: 'common.not_found' });
  });

  it('limit query: limit=1 returns one row (newest) and a page object', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    await move({ object_kind: 'block', object_ids: [b], movement: 'stored', location_text: 'A' });
    await move({ object_kind: 'block', object_ids: [b], movement: 'retrieved' });
    const r = await call('listAnatomicBlockMovements', { params: { block_id: b }, query: { limit: '1' } });
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].movement).toBe('retrieved');
    expect(r.body.page).toMatchObject({ limit: 1 });
  });
});

describe('C11-T09 M15 labels data (AC-13.3 data part, access log)', () => {
  it('blocks: one label per block {object_kind, object_id, label, line2}; writes ONE access row anatomic_label.print / anatomic_case / case id with kind and count', async () => {
    const c = mkCase(); const b1 = mkBlock(c, 1), b2 = mkBlock(c, 2), b3 = mkBlock(c, 3);
    const r = await labels(c.caseId, { kind: 'blocks' });
    expect(r.status).toBe(200);
    expect(r.body.labels.map((l: Row) => l['label']).sort()).toEqual(['S26-0042-A1', 'S26-0042-A2', 'S26-0042-A3']);
    expect(r.body.labels[0]).toMatchObject({ object_kind: 'block' });
    expect([b1, b2, b3]).toContain(r.body.labels[0].object_id);
    expect(typeof r.body.labels[0].line2).toBe('string');
    expect(calls.access).toHaveLength(1);
    expect(calls.access[0]).toMatchObject({ action: 'anatomic_label.print', entityType: 'anatomic_case', entityId: c.caseId, outcome: 'allowed', detail: { kind: 'blocks', count: 3 } });
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.work', centreId: CENTRE });
  });

  it('slides: labels of the slides with object_kind slide; ids subset limits the output and count; ids of another case/tenant are omitted (no leak, no error)', async () => {
    const c = mkCase(), o = mkCase(), f = mkCase({ tenant: OTHER_T });
    const b = mkBlock(c, 1); const s1 = mkSlide(c, b, 1), s2 = mkSlide(c, b, 2), os = mkSlide(o, mkBlock(o, 1), 1), fs = mkSlide(f, mkBlock(f, 1), 1);
    const all = await labels(c.caseId, { kind: 'slides' });
    expect(all.body.labels.map((l: Row) => l['object_kind'])).toEqual(['slide', 'slide']);
    calls.access.length = 0;
    const subset = await labels(c.caseId, { kind: 'slides', ids: [s2, os, fs, uid(66666)].join(',') });
    expect(subset.body.labels.map((l: Row) => l['object_id'])).toEqual([s2]);
    expect(JSON.stringify(subset.body)).not.toContain(S.slides.get(os)!['label']);
    expect(JSON.stringify(subset.body)).not.toContain(S.slides.get(fs)!['label']);
    expect(calls.access[0]).toMatchObject({ detail: { kind: 'slides', count: 1 } });
    expect(s1).toBeTruthy();
  });

  it('no patient data on a label: line2 and the whole body never contain the case\'s patient/order ids or clinical text', async () => {
    const c = mkCase(); mkBlock(c, 1);
    S.cases.get(c.caseId)!['clinical_history_text'] = MARKER;
    const r = await labels(c.caseId, { kind: 'blocks' });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(String(S.cases.get(c.caseId)!['order_id']));
    expect(text).not.toMatch(/patient/i);
  });

  it('bounds: ids > 200, malformed id, kind missing/other -> 400 validation_failed and NO access row; 200 ids accepted', async () => {
    const c = mkCase(); mkBlock(c, 1);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => uid(50000 + i)).join(',');
    for (const q of [{ kind: 'blocks', ids: ids(201) }, { kind: 'blocks', ids: 'x,y' }, {}, { kind: 'cases' }, { kind: 'blocks', extra: '1' }]) {
      expect(await rejects(labels(c.caseId, q)), JSON.stringify(q)).toMatchObject({ code: 'common.validation_failed' });
    }
    expect(calls.access).toHaveLength(0);
    expect((await labels(c.caseId, { kind: 'blocks', ids: ids(200) })).status).toBe(200);
  });

  it('other tenant\'s / unknown case -> 404 and no access row, no permission check; denied role -> 403 and no access row', async () => {
    const f = mkCase({ tenant: OTHER_T }); mkBlock(f, 1);
    for (const id of [f.caseId, uid(424243)]) expect(await rejects(labels(id))).toMatchObject({ code: 'common.not_found' });
    expect(calls.assertRole).toHaveLength(0);
    const c = mkCase(); mkBlock(c, 1);
    const denied = mkCtx({ assertRole: async () => { throw Object.assign(new Error('no'), { code: 'auth.forbidden' }); } });
    expect(await rejects(labels(c.caseId, { kind: 'blocks' }, denied))).toMatchObject({ code: 'auth.forbidden' });
    expect(calls.access).toHaveLength(0);
  });

  it('an empty case still answers 200 {labels: []} and logs count 0 (the print screen was opened); audit failure fails the request (log and action commit together)', async () => {
    const c = mkCase();
    const r = await labels(c.caseId, { kind: 'slides' });
    expect(r.body.labels).toEqual([]);
    expect(calls.access[0]).toMatchObject({ detail: { kind: 'slides', count: 0 } });
    calls.accessFails = true;
    expect(await rejects(labels(c.caseId, { kind: 'slides' }))).toBeInstanceOf(Error);
  });

  it('labels are read-only: no block, slide, order or movement written', async () => {
    const c = mkCase(); mkBlock(c, 1); const before = state();
    await labels(c.caseId, { kind: 'blocks' });
    expect(state()).toBe(before);
  });
});

describe('C11-T09 cross-cutting', () => {
  it('every one of the twelve operations is a real handler (not the 501 / common.internal stub)', async () => {
    const ops = ['createAnatomicBlocks', 'createAnatomicSlides', 'markAnatomicSlidesReady', 'createAnatomicStainOrder', 'startAnatomicStainOrder', 'completeAnatomicStainOrder',
      'cancelAnatomicStainOrder', 'linkAnatomicAddonItem', 'recordAnatomicMovements', 'listAnatomicBlockMovements', 'listAnatomicSlideMovements', 'getAnatomicLabels'];
    for (const op of ops) {
      const e = await (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {} }, mkCtx()).then(() => undefined, (x: unknown) => x);
      expect(e?.code, op).not.toBe('common.internal'); // an empty request must fail validation / not-found, never the stub
    }
  });

  it('PHI hygiene: error problems and logs of failing M1/M2/M5 calls carry no submitted text', async () => {
    const c = mkCase(); const b = mkBlock(c, 1);
    const errs = [
      await rejects(mkBlocks(c.caseId, { part_id: c.partId, count: 1, note: MARKER + 'x'.repeat(200) })),
      await rejects(mkSlides(c.caseId, { block_id: b, stain_code: MARKER, count: 1 })),
      await rejects(order(c.caseId, { stain_code: 'IHC_ER', block_id: b, note: MARKER + 'x'.repeat(500) })),
      await rejects(cancelOrder(mkOrder(c, { block: b }), { reason_text: MARKER, unexpected: MARKER })),
    ];
    for (const e of errs) expect(e.code).toBe('common.validation_failed');
    for (const e of errs) expect(JSON.stringify({ code: e.code, message: e.message, errors: e.errors, detail: e.detail })).not.toContain(MARKER);
    expect(calls.logs.join('\n')).not.toContain(MARKER);
  });

  it('a throwing handler leaves no partial state (blocks created before a later failure are rolled back)', async () => {
    const c = mkCase();
    const before = state();
    expect(await rejects(mkBlocks(c.caseId, { part_id: c.partId, count: 51 }))).toMatchObject({ code: 'common.validation_failed' });
    expect(state()).toBe(before);
  });
});

// ---- T-18 reviewer item 2: M4 / M6 / M12 (spec: contracts/openapi/anatomic.yaml, 02-TRD §5 M4/M6/M12, 07-SECURITY §3 + §5.2 + §5.3) ----
/** v = null -> no If-Match header */
const assess = (slideId: string, body: Row, v: number | null = 1, ctx?: any) =>
  call('saveAnatomicSlideAssessment', { params: { slide_id: slideId }, headers: v === null ? {} : ifm(v), body }, ctx);
const stainQueue = (query: Row = {}, ctx?: any) => call('listAnatomicStainOrders', { query }, ctx);
const blockList = (query: Row = {}, ctx?: any) => call('listAnatomicBlocks', { query }, ctx);
const cursorAt = (o: number) => Buffer.from(JSON.stringify({ o })).toString('base64url');
const fieldPaths = (e: any) => JSON.stringify(e.errors ?? []);

describe('C11-T18 M4 save slide assessment', () => {
  it('saves adequacy_code + finding_text + include_in_report with If-Match; 200 SlideDto, version + 1, actor recorded, case.work asserted at the case centre', async () => {
    const c = mkCase({ kind: 'cytology' }); const s = mkSlide(c, undefined, 1);
    const r = await assess(s, { adequacy_code: 'SAT', finding_text: 'Synthetic finding', include_in_report: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s, adequacy_code: 'SAT', finding_text: 'Synthetic finding', include_in_report: true, version: 2 });
    expect(S.slides.get(s)).toMatchObject({ adequacy_code: 'SAT', finding_text: 'Synthetic finding', include_in_report: true, version: 2, updated_by: ACTOR });
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.work', centreId: CENTRE });
  });

  it('absent adequacy_code / finding_text are cleared to NULL (full replace), and never appear as null on the wire', async () => {
    const c = mkCase(); const s = mkSlide(c, mkBlock(c, 1), 1);
    await assess(s, { adequacy_code: 'LIM', finding_text: 'first', include_in_report: true });
    const r = await assess(s, { include_in_report: false }, 2);
    expect(S.slides.get(s)).toMatchObject({ adequacy_code: null, finding_text: null, include_in_report: false, version: 3 });
    expect(r.body).not.toHaveProperty('adequacy_code');
    expect(r.body).not.toHaveProperty('finding_text');
    expect(JSON.stringify(r.body)).not.toContain(':null');
  });

  it('07-SECURITY §5.3: signed_out case WITHOUT an open change draft -> 409 anatomic.signout_locked, slide unchanged', async () => {
    const c = mkCase({ status: 'signed_out' }); const s = mkSlide(c, mkBlock(c, 1), 1);
    const before = state();
    expect(await rejects(assess(s, { include_in_report: true }))).toMatchObject({ code: 'anatomic.signout_locked' });
    expect(state()).toBe(before);
  });

  it('07-SECURITY §5.3: signed_out case WITH an open change draft -> allowed (200)', async () => {
    const c = mkCase({ status: 'signed_out', draft: true }); const s = mkSlide(c, mkBlock(c, 1), 1);
    const r = await assess(s, { adequacy_code: 'SAT', include_in_report: true });
    expect(r.status).toBe(200);
    expect(S.slides.get(s)!['adequacy_code']).toBe('SAT');
  });

  it('works while the case is accessioned, in_processing and ready_for_reporting', async () => {
    for (const [i, status] of ['accessioned', 'in_processing', 'ready_for_reporting'].entries()) {
      const c = mkCase({ status, acc: `S26-006${i}` }); const s = mkSlide(c, mkBlock(c, 1), 1);
      expect((await assess(s, { include_in_report: true })).status, status).toBe(200);
    }
  });

  it('If-Match: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; malformed / "0" -> 400; slide unchanged', async () => {
    const c = mkCase(); const s = mkSlide(c, mkBlock(c, 1), 1);
    const before = state();
    expect(await rejects(assess(s, { include_in_report: true }, null))).toMatchObject({ code: 'common.precondition_required' });
    expect(await rejects(assess(s, { include_in_report: true }, 7))).toMatchObject({ code: 'common.version_conflict' });
    for (const h of ['1', 'W/"1"', '"0"', '"-1"', '"abc"', '"99999999999"']) {
      expect(await rejects(call('saveAnatomicSlideAssessment', { params: { slide_id: s }, headers: { 'if-match': h }, body: { include_in_report: true } })), h).toMatchObject({ code: 'common.validation_failed' });
    }
    expect(state()).toBe(before);
  });

  it('adequacy_code outside the ACTIVE coded set (inactive, unknown, wrong case, bad chars, too long, not a string) -> 400 at /adequacy_code, nothing written', async () => {
    const c = mkCase(); const s = mkSlide(c, mkBlock(c, 1), 1);
    const before = state();
    for (const adequacy_code of ['OLD', 'NOPE', 'sat', 'SA T', "SAT'; DROP TABLE x;--", 'x'.repeat(65), '', 5, null]) {
      const e = await rejects(assess(s, { adequacy_code, include_in_report: true }));
      expect(e, String(adequacy_code)).toMatchObject({ code: 'common.validation_failed' });
      expect(fieldPaths(e)).toContain('/adequacy_code');
    }
    expect(state()).toBe(before);
  });

  it('adequacy lookup pages through the coded set: an active code beyond the first 500 rows is still accepted', async () => {
    for (let n = 0; n < 600; n++) S.adequacy.set(`BULK${n}`, { id: uid(90000 + n), tenant_id: T, code: `BULK${n}`, display: 'x', is_active: true, sort_order: 10 + n, version: 1 });
    const c = mkCase(); const s = mkSlide(c, mkBlock(c, 1), 1);
    expect((await assess(s, { adequacy_code: 'BULK599', include_in_report: true })).status).toBe(200);
  });

  it('closed body: include_in_report required boolean; finding_text <= 2000; unknown / mass-assignment fields -> 400, nothing written', async () => {
    const c = mkCase(); const s = mkSlide(c, mkBlock(c, 1), 1);
    const before = state();
    const bodies: Row[] = [
      {}, { adequacy_code: 'SAT' }, { include_in_report: 'true' }, { include_in_report: 1 }, { include_in_report: null },
      { include_in_report: true, finding_text: 'x'.repeat(2001) }, { include_in_report: true, finding_text: 5 },
      { include_in_report: true, status: 'ready' }, { include_in_report: true, stain_code: 'PAS' }, { include_in_report: true, tenant_id: OTHER_T }, { include_in_report: true, label: 'S26-9999-A1-1' },
    ];
    for (const body of bodies) expect(await rejects(assess(s, body)), JSON.stringify(body).slice(0, 60)).toMatchObject({ code: 'common.validation_failed' });
    expect(state()).toBe(before);
    expect((await assess(s, { include_in_report: true, finding_text: 'x'.repeat(2000) })).status).toBe(200); // boundary
  });

  it('07-SECURITY §5.2: slide of another tenant / unknown / malformed id -> 404 common.not_found before any permission check, nothing written', async () => {
    const f = mkCase({ tenant: OTHER_T }); const theirs = mkSlide(f, mkBlock(f, 1), 1);
    const before = state();
    for (const id of [theirs, uid(424242), 'zzz']) {
      calls.assertRole.length = 0;
      expect(await rejects(assess(id, { include_in_report: true })), id).toMatchObject({ code: 'common.not_found' });
      expect(calls.assertRole).toHaveLength(0);
    }
    expect(state()).toBe(before);
  });

  it('IdentityPort denial (case centre) -> 403 propagated, slide unchanged', async () => {
    const c = mkCase(); const s = mkSlide(c, mkBlock(c, 1), 1);
    const denied = mkCtx({ assertRole: async () => { throw Object.assign(new Error('no'), { code: 'auth.forbidden' }); } });
    const before = state();
    expect(await rejects(assess(s, { include_in_report: true }, 1, denied))).toMatchObject({ code: 'auth.forbidden' });
    expect(state()).toBe(before);
  });

  it('PHI hygiene (§6): a rejected finding_text is not echoed in the problem or the logs', async () => {
    const c = mkCase(); const s = mkSlide(c, mkBlock(c, 1), 1);
    const e = await rejects(assess(s, { include_in_report: true, finding_text: MARKER + 'x'.repeat(2001), extra: MARKER }));
    expect(JSON.stringify({ code: e.code, message: e.message, errors: e.errors, detail: e.detail })).not.toContain(MARKER);
    expect(calls.logs.join('\n')).not.toContain(MARKER);
  });
});

describe('C11-T18 M6 list stain-order queue', () => {
  /** orders with distinct requested_at (minute n) so sort is observable */
  function seedOrders(n: number, status = 'requested', stain = 'PAS'): string[] {
    const c = mkCase();
    return Array.from({ length: n }, (_, i) => {
      const id = mkOrder(c, { part: c.partId, stain, status });
      S.orders.get(id)!['requested_at'] = new Date(Date.UTC(2026, 10, 12, 1, i, 0)).toISOString();
      return id;
    });
  }

  it('default filter is status requested,in_progress; each row is a StainOrderRow with case_id + accession_no; empty queue -> data [] and page.limit 50 without next_cursor', async () => {
    expect((await stainQueue()).body).toEqual({ data: [], page: { limit: 50 } });
    const c = mkCase(); const b = mkBlock(c, 1);
    const req = mkOrder(c, { block: b, stain: 'IHC_ER', status: 'requested' }), prog = mkOrder(c, { block: b, stain: 'IHC_ER', status: 'in_progress' });
    mkOrder(c, { block: b, stain: 'IHC_ER', status: 'completed' }); mkOrder(c, { block: b, stain: 'IHC_ER', status: 'cancelled' });
    const r = await stainQueue();
    expect(r.status).toBe(200);
    expect(r.body.data.map((o: Row) => o['id']).sort()).toEqual([req, prog].sort());
    expect(r.body.data[0]).toMatchObject({ case_id: c.caseId, accession_no: ACC, stain_code: 'IHC_ER', stain_kind: 'ihc', block_id: b, block_label: 'S26-0042-A1', priority: 'routine', version: 1 });
    expect(r.body.data[0]).toHaveProperty('requested_at');
    expect(JSON.stringify(r.body)).not.toContain(':null');
    expect(r.body.page).toEqual({ limit: 50 });
  });

  it('status csv selects exactly those statuses (duplicates tolerated); stain_kind and centre_id filter', async () => {
    const c = mkCase(), c2 = mkCase({ centre: OTHER_CENTRE });
    const done = mkOrder(c, { part: c.partId, stain: 'PAS', status: 'completed' }), canc = mkOrder(c, { part: c.partId, stain: 'PAS', status: 'cancelled' });
    const ihc = mkOrder(c2, { block: mkBlock(c2, 1), stain: 'IHC_ER', status: 'completed' });
    expect((await stainQueue({ status: 'completed,cancelled,completed' })).body.data.map((o: Row) => o['id']).sort()).toEqual([done, canc, ihc].sort());
    expect((await stainQueue({ status: 'completed', stain_kind: 'ihc' })).body.data.map((o: Row) => o['id'])).toEqual([ihc]);
    expect((await stainQueue({ status: 'completed', stain_kind: 'special' })).body.data.map((o: Row) => o['id'])).toEqual([done]);
    expect((await stainQueue({ status: 'completed', stain_kind: 'special,ihc' })).body.data).toHaveLength(2);
    expect((await stainQueue({ status: 'completed', centre_id: OTHER_CENTRE })).body.data.map((o: Row) => o['id'])).toEqual([ihc]);
  });

  it('sort requested_at ascending (default) / -requested_at descending', async () => {
    const ids = seedOrders(3);
    expect((await stainQueue()).body.data.map((o: Row) => o['id'])).toEqual(ids);
    expect((await stainQueue({ sort: 'requested_at' })).body.data.map((o: Row) => o['id'])).toEqual(ids);
    expect((await stainQueue({ sort: '-requested_at' })).body.data.map((o: Row) => o['id'])).toEqual([...ids].reverse());
  });

  it('paging: next_cursor only while more rows exist; following it yields the rest, no overlap; exactly `limit` rows -> no next_cursor', async () => {
    const ids = seedOrders(5);
    const p1 = (await stainQueue({ limit: '2' })).body;
    expect(p1.data.map((o: Row) => o['id'])).toEqual(ids.slice(0, 2));
    expect(p1.page).toMatchObject({ limit: 2 }); expect(typeof p1.page.next_cursor).toBe('string');
    const p2 = (await stainQueue({ limit: '2', cursor: p1.page.next_cursor })).body;
    expect(p2.data.map((o: Row) => o['id'])).toEqual(ids.slice(2, 4));
    expect(typeof p2.page.next_cursor).toBe('string');
    const p3 = (await stainQueue({ limit: '2', cursor: p2.page.next_cursor })).body;
    expect(p3.data.map((o: Row) => o['id'])).toEqual(ids.slice(4));
    expect(p3.page).toEqual({ limit: 2 });
    expect((await stainQueue({ limit: '5' })).body.page).toEqual({ limit: 5 });
    expect((await stainQueue({ limit: 5 })).body.data).toHaveLength(5); // number form accepted too
  });

  it('limit 1 and 200 accepted; 0, 201, -1, 1.5, "abc", "" and 4-digit -> 400 at /limit', async () => {
    expect((await stainQueue({ limit: '1' })).body.page.limit).toBe(1);
    expect((await stainQueue({ limit: '200' })).body.page.limit).toBe(200);
    for (const limit of ['0', '201', '-1', '1.5', 'abc', '', '0100x', '1000', 0, 201]) {
      const e = await rejects(stainQueue({ limit }));
      expect(e, String(limit)).toMatchObject({ code: 'common.validation_failed' });
      expect(fieldPaths(e)).toContain('/limit');
    }
  });

  it('bad csv / enum / uuid / unknown parameter -> 400 validation_failed at the parameter; garbage cursor -> 400 common.invalid_cursor', async () => {
    seedOrders(1);
    const cases: Array<[Row, string]> = [
      [{ status: 'bogus' }, '/status'], [{ status: 'requested,bogus' }, '/status'], [{ status: 'requested,,in_progress' }, '/status'], [{ status: '' }, '/status'], [{ status: ['requested'] }, '/status'],
      [{ status: 'requested,in_progress,completed,cancelled,requested' }, '/status'],
      [{ stain_kind: 'routine' }, '/stain_kind'], [{ stain_kind: 'ihc,' }, '/stain_kind'], [{ stain_kind: 'special,ihc,special' }, '/stain_kind'],
      [{ centre_id: 'not-a-uuid' }, '/centre_id'], [{ centre_id: `${CENTRE},nope` }, '/centre_id'],
      [{ sort: 'status' }, '/sort'], [{ sort: 'requested_at,-requested_at' }, '/sort'], [{ sort: '; DROP TABLE x' }, '/sort'],
    ];
    for (const [query, path] of cases) {
      const e = await rejects(stainQueue(query));
      expect(e, JSON.stringify(query)).toMatchObject({ code: 'common.validation_failed' });
      expect(fieldPaths(e)).toContain(path);
    }
    expect(await rejects(stainQueue({ tenant_id: OTHER_T }))).toMatchObject({ code: 'common.validation_failed' }); // closed query
    for (const cursor of ['not-a-cursor!!', '', cursorAt(-1), cursorAt(1.5), cursorAt(1_000_001), Buffer.from('{"o":"3"}').toString('base64url'), Buffer.from('null').toString('base64url')]) {
      expect(await rejects(stainQueue({ cursor })), cursor).toMatchObject({ code: 'common.invalid_cursor' });
    }
  });

  it('tenant isolation: another tenant\'s orders never appear', async () => {
    const f = mkCase({ tenant: OTHER_T });
    S.orders.set(uid(6900), { id: uid(6900), tenant_id: OTHER_T, centre_id: CENTRE, case_id: f.caseId, stain_id: uid(8100), stain_code: 'IHC_ER', stain_kind: 'ihc', status: 'requested', requested_at: NOW.toISOString(), version: 1 });
    expect((await stainQueue()).body.data).toEqual([]);
  });

  it('read-only: no order, slide, block or movement written', async () => {
    seedOrders(2); const before = state();
    await stainQueue({ limit: '1' });
    expect(state()).toBe(before);
  });
});

describe('C11-T18 M12 list blocks overview', () => {
  it('lists every block of the tenant when unfiltered; BlockRow carries case_id, accession_no, slide_count; last_movement_at only when a movement exists; no null on the wire', async () => {
    const c = mkCase(); const b1 = mkBlock(c, 1), b2 = mkBlock(c, 2);
    mkSlide(c, b1, 1); mkSlide(c, b1, 2);
    S.moves.push({ tenant_id: T, object_kind: 'block', object_id: b2, created_at: '2026-11-12T02:00:00.000Z' }, { tenant_id: T, object_kind: 'block', object_id: b2, created_at: '2026-11-12T03:00:00.000Z' });
    const r = await blockList();
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.data.map((b: Row) => [b['id'], b]));
    expect(byId[b1]).toMatchObject({ part_id: c.partId, label: 'S26-0042-A1', seq: 1, location_status: 'in_lab', slide_count: 2, version: 1, case_id: c.caseId, accession_no: ACC });
    expect(byId[b1]).not.toHaveProperty('last_movement_at');
    expect(byId[b2]).toMatchObject({ slide_count: 0, last_movement_at: '2026-11-12T03:00:00.000Z' });
    expect(JSON.stringify(r.body)).not.toContain(':null');
    expect(r.body.page).toEqual({ limit: 50 });
  });

  it('location_status csv + case_id filters; empty result -> data [] and page.limit', async () => {
    const c = mkCase(), d = mkCase();
    const a = mkBlock(c, 1, 'in_lab'), s = mkBlock(c, 2, 'stored'), o = mkBlock(c, 3, 'sent_out'), g = mkBlock(c, 4, 'discarded'), other = mkBlock(d, 1, 'sent_out');
    const ids = async (q: Row) => (await blockList(q)).body.data.map((b: Row) => b['id']).sort();
    expect(await ids({ location_status: 'sent_out' })).toEqual([o, other].sort());
    expect(await ids({ location_status: 'in_lab,stored,in_lab' })).toEqual([a, s].sort());
    expect(await ids({ case_id: d.caseId })).toEqual([other]);
    expect(await ids({ case_id: c.caseId, location_status: 'sent_out,discarded' })).toEqual([o, g].sort());
    expect((await blockList({ case_id: uid(424242) })).body).toEqual({ data: [], page: { limit: 50 } });
  });

  it('paging: next_cursor only when more rows exist; cursor continues without overlap; exactly `limit` rows -> no next_cursor', async () => {
    const c = mkCase(); const ids = [1, 2, 3, 4, 5].map((n) => mkBlock(c, n));
    const p1 = (await blockList({ limit: '2' })).body;
    expect(p1.data.map((b: Row) => b['id'])).toEqual(ids.slice(0, 2));
    expect(typeof p1.page.next_cursor).toBe('string');
    const p2 = (await blockList({ limit: '2', cursor: p1.page.next_cursor })).body;
    expect(p2.data.map((b: Row) => b['id'])).toEqual(ids.slice(2, 4));
    const p3 = (await blockList({ limit: '2', cursor: p2.page.next_cursor })).body;
    expect(p3.data.map((b: Row) => b['id'])).toEqual(ids.slice(4));
    expect(p3.page).toEqual({ limit: 2 });
    expect((await blockList({ limit: '5' })).body.page).toEqual({ limit: 5 });
  });

  it('limit 1..200 only; bad csv / enum / uuid / unknown parameter -> 400 at the parameter; garbage cursor -> common.invalid_cursor', async () => {
    mkBlock(mkCase(), 1);
    expect((await blockList({ limit: '200' })).body.page.limit).toBe(200);
    for (const limit of ['0', '201', '-1', '1.5', 'abc', '']) expect(fieldPaths(await rejects(blockList({ limit }))), limit).toContain('/limit');
    const cases: Array<[Row, string]> = [
      [{ location_status: 'bogus' }, '/location_status'], [{ location_status: 'in_lab,' }, '/location_status'], [{ location_status: '' }, '/location_status'], [{ location_status: ['in_lab'] }, '/location_status'],
      [{ location_status: 'in_lab,stored,sent_out,discarded,in_lab' }, '/location_status'], [{ case_id: 'not-a-uuid' }, '/case_id'], [{ case_id: 5 }, '/case_id'],
    ];
    for (const [query, path] of cases) {
      const e = await rejects(blockList(query));
      expect(e, JSON.stringify(query)).toMatchObject({ code: 'common.validation_failed' });
      expect(fieldPaths(e)).toContain(path);
    }
    expect(await rejects(blockList({ part_id: uid(1) }))).toMatchObject({ code: 'common.validation_failed' }); // closed query
    for (const cursor of ['not-a-cursor!!', '', cursorAt(-5), cursorAt(2_000_000)]) expect(await rejects(blockList({ cursor })), cursor).toMatchObject({ code: 'common.invalid_cursor' });
  });

  it('tenant isolation: another tenant\'s blocks never appear, even with their case_id', async () => {
    const f = mkCase({ tenant: OTHER_T }); mkBlock(f, 1);
    expect((await blockList()).body.data).toEqual([]);
    expect((await blockList({ case_id: f.caseId })).body.data).toEqual([]);
  });

  it('read-only: nothing written', async () => {
    const c = mkCase(); mkBlock(c, 1); const before = state();
    await blockList({ limit: '1' });
    expect(state()).toBe(before);
  });
});
