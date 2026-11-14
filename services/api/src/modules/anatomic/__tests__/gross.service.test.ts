// C11.T-08 — gross record (A8) + stage transitions (A9 start-processing, A10 mark-ready) + cancel (A11) + signout_locked edit matrix for A6/A7/A8.
// Spec: 02-TRD §5 A8–A11 + "Every handler" rule + "Edits on a signed_out case" (D-66), §7 state table C3/C4/C7 + forbidden examples,
//       01-PRD AC-03.1…03.5, AC-15.1, AC-15.2; 07-SECURITY §3 (draft/gross saves: If-Match, no PHI in problem detail, signout_locked), §5.2 (404 for invisible case),
//       §5.3 (signed-out edit matrix), §6 (no PHI in logs); 05-SCHEMA gross_records (CHECK is_complete = (completed_at IS NOT NULL)), cases__cancel__ck.
// Drives the REAL handlers (manifest.handlers) on IN-MEMORY repositories (vi.mock of cases/parts/gross/blocks/slides/molecular/drafts/submissions/config/codedValues repos, T-04 signatures).
//
// SEAMS (spec fixes behaviour; the names below are chosen here, writer follows):
//   handlers saveAnatomicGross / startAnatomicProcessing / markAnatomicCaseReady / cancelAnatomicCase in handlers/index.ts (service/gross.service.ts = writer's choice of file; reached via the handlers).
//   Order inside every handler (same as T-06): load case (404) -> IdentityPort.assertRole({permission:'anatomic.case.work', centreId: case.centre_id}) -> state/lock guard -> If-Match -> body -> version check -> write.
//   A8 : gross is found by part (listGrossRecords(tx,{tenantId,caseId}) filtered by part_id); If-Match "0" = create (insertGrossRecord), "<n>" = updateGrossRecord(expectedVersion n);
//        grossed_by_membership_id = ctx.actor.membershipId; completed_at = ctx.now() when is_complete turns true and is KEPT while it stays true (AC-03.3); cleared when is_complete false (DB CHECK).
//        status gate: accessioned | in_processing | ready_for_reporting; signed_out only with an open change draft (getOpenDraft); received|cancelled -> 409 anatomic.case_invalid_transition.
//        200 body (both create and update) = { id, part_id, gross_text, pieces_count?, dimensions_mm?, weight_g?, is_complete, completed_at?, version } (no null on the wire).
//   A9 : needs status accessioned; guard C3 per case kind; settings via repository/config.repo getSettings (missing row => require_gross_complete_for_processing = true);
//        "requires_gross" = the test profile (config.repo getTestProfileByTestId) of an ACTIVE case item (cases.repo listCaseItems activeOnly): when any active item's profile requires gross, EVERY part needs an is_complete gross
//        [INTERPRETATION of "every part with requires_gross profile"; parts carry no profile of their own]. Guard failure -> 409 anatomic.case_invalid_transition (the only code A9 lists).
//   A10: needs status in_processing; histology/cytology/ihc: >=1 slide with status 'ready'; molecular: >=1 ACTIVE molecular result. Failure -> 409 anatomic.case_invalid_transition.
//   A11: body { reason_code, reason_text? <=500 }; reason_code must be an active code of the cancel_reasons set (cases.repo-independent: codedValues.repo listGlobalCancelReasons + listCodedCancelReasons), else 400 validation_failed;
//        allowed from received|accessioned|in_processing|ready_for_reporting when listItemSubmissions is empty; sets status/cancelled_at/cancel_reason_code/cancel_reason_text; blocks/slides untouched.
//   A9–A11 write one case_transitions row (insertCaseTransition) and return 200 { id, status, version, ... } (CaseDetail header; the aggregate belongs to A3).
//   ctx/request shape = T-06 (accession.service.test.ts) plus ctx.actor.membershipId.
// Fails now: the four operations are 501/common.internal stubs in handlers/index.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  cases: new Map<string, Row>(), parts: new Map<string, Row>(), gross: new Map<string, Row>(), blocks: new Map<string, Row>(), slides: new Map<string, Row>(),
  molecular: new Map<string, Row>(), items: new Map<string, Row>(), profiles: new Map<string, Row>(), submissions: new Map<string, Row>(), drafts: new Map<string, Row>(),
  transitions: [] as Row[], hidden: new Set<string>(), settings: undefined as Row | undefined, hideGrossFromList: false,
  globalReasons: [] as Row[], tenantReasons: [] as Row[], writes: 0, materialWrites: 0, failTransition: false,
}));
const pgErr = (code: string, constraint: string) => Object.assign(new Error('duplicate key value violates unique constraint'), { code, constraint });

vi.mock('../repository/cases.repo.js', () => ({
  async getCase(_tx: unknown, i: { tenantId: string; caseId: string }) {
    const r = S.cases.get(i.caseId);
    return r && r['tenant_id'] === i.tenantId && !S.hidden.has(i.caseId) ? { ...r } : undefined;
  },
  async updateCase(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.writes++;
    const r = S.cases.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId };
    S.cases.set(i.id, next);
    return { ...next };
  },
  async insertCaseTransition(_tx: unknown, row: Row) { S.writes++; if (S.failTransition) throw new Error('boom'); S.transitions.push({ ...row }); return { ...row }; },
  async listCaseTransitions(_tx: unknown, i: { caseId: string }) { return S.transitions.filter((t) => t['case_id'] === i.caseId); },
  async getCaseTransition() { return undefined; },
  async listCaseItems(_tx: unknown, i: { tenantId: string; caseId: string; activeOnly?: boolean }) {
    return [...S.items.values()].filter((x) => x['tenant_id'] === i.tenantId && x['case_id'] === i.caseId && (!i.activeOnly || x['is_active'] !== false)).map((x) => ({ ...x }));
  },
  async getCaseItem(_tx: unknown, i: { id: string }) { const r = S.items.get(i.id); return r ? { ...r } : undefined; },
  async insertCaseItem(_tx: unknown, row: Row) { return row; },
  async updateCaseItem() { return undefined; },
  async listCases() { return [...S.cases.values()]; },
  async listCasesByOrder() { return []; },
  async insertCase(_tx: unknown, row: Row) { S.cases.set(row['id'], { ...row }); return row; },
}));
vi.mock('../repository/parts.repo.js', () => ({
  async getPart(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.parts.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async listParts(_tx: unknown, i: { tenantId: string; caseId: string }) {
    return [...S.parts.values()].filter((p) => p['tenant_id'] === i.tenantId && p['case_id'] === i.caseId).sort((a, b) => a['letter_seq'] - b['letter_seq']).map((p) => ({ ...p }));
  },
  async insertPart(_tx: unknown, row: Row) { S.writes++; const r = { version: 1, specimen_state: 'none', ...row }; S.parts.set(r['id'], r); return { ...r }; },
  async updatePart(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.writes++;
    const r = S.parts.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId };
    S.parts.set(i.id, next);
    return { ...next };
  },
}));
vi.mock('../repository/gross.repo.js', () => ({
  async insertGrossRecord(_tx: unknown, row: Row) {
    S.writes++;
    if ([...S.gross.values()].some((g) => g['tenant_id'] === row['tenant_id'] && g['part_id'] === row['part_id'])) throw pgErr('23505', 'gross_records__tenant_id_part__uq');
    const r = { version: 1, is_complete: false, completed_at: null, ...row }; S.gross.set(r['id'], r); return { ...r };
  },
  async getGrossRecord(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.gross.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async listGrossRecords(_tx: unknown, i: { tenantId: string; caseId: string }) {
    if (S.hideGrossFromList) return [];
    return [...S.gross.values()].filter((g) => g['tenant_id'] === i.tenantId && g['case_id'] === i.caseId).map((g) => ({ ...g }));
  },
  async updateGrossRecord(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.writes++;
    const r = S.gross.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId };
    S.gross.set(i.id, next);
    return { ...next };
  },
}));
vi.mock('../repository/blocks.repo.js', () => ({
  async insertBlock(_tx: unknown, row: Row) { S.materialWrites++; return row; },
  async getBlock(_tx: unknown, i: { id: string }) { const r = S.blocks.get(i.id); return r ? { ...r } : undefined; },
  async listBlocks(_tx: unknown, i: { tenantId: string; caseId: string }) { return [...S.blocks.values()].filter((b) => b['tenant_id'] === i.tenantId && b['case_id'] === i.caseId).map((b) => ({ ...b })); },
  async updateBlock() { S.materialWrites++; return undefined; },
}));
vi.mock('../repository/slides.repo.js', () => ({
  async insertSlide(_tx: unknown, row: Row) { S.materialWrites++; return row; },
  async getSlide(_tx: unknown, i: { id: string }) { const r = S.slides.get(i.id); return r ? { ...r } : undefined; },
  async listSlides(_tx: unknown, i: { tenantId: string; caseId: string }) { return [...S.slides.values()].filter((s) => s['tenant_id'] === i.tenantId && s['case_id'] === i.caseId).map((s) => ({ ...s })); },
  async updateSlide() { S.materialWrites++; return undefined; },
}));
vi.mock('../repository/molecular.repo.js', () => ({
  async insertMolecularResult(_tx: unknown, row: Row) { S.materialWrites++; return row; },
  async getMolecularResult(_tx: unknown, i: { id: string }) { const r = S.molecular.get(i.id); return r ? { ...r } : undefined; },
  async listMolecularResults(_tx: unknown, i: { tenantId: string; caseId: string; activeOnly?: boolean }) {
    return [...S.molecular.values()].filter((m) => m['tenant_id'] === i.tenantId && m['case_id'] === i.caseId && (!i.activeOnly || m['is_active'] !== false)).map((m) => ({ ...m }));
  },
  async updateMolecularResult() { S.materialWrites++; return undefined; },
}));
vi.mock('../repository/drafts.repo.js', () => ({
  async insertReportDraft(_tx: unknown, row: Row) { return row; },
  async getReportDraft(_tx: unknown, i: { id: string }) { const r = S.drafts.get(i.id); return r ? { ...r } : undefined; },
  async listReportDrafts(_tx: unknown, i: { caseId: string }) { return [...S.drafts.values()].filter((d) => d['case_id'] === i.caseId).map((d) => ({ ...d })); },
  async updateReportDraft() { return undefined; },
  async getOpenDraft(_tx: unknown, i: { tenantId: string; caseId: string }) {
    const d = [...S.drafts.values()].find((x) => x['tenant_id'] === i.tenantId && x['case_id'] === i.caseId && x['status'] === 'open');
    return d ? { ...d } : undefined;
  },
}));
vi.mock('../repository/submissions.repo.js', () => ({
  async insertItemSubmission(_tx: unknown, row: Row) { return row; },
  async getItemSubmission(_tx: unknown, i: { id: string }) { const r = S.submissions.get(i.id); return r ? { ...r } : undefined; },
  async listItemSubmissions(_tx: unknown, i: { tenantId: string; caseId: string }) { return [...S.submissions.values()].filter((s) => s['tenant_id'] === i.tenantId && s['case_id'] === i.caseId).map((s) => ({ ...s })); },
  async getItemSubmissionByKey() { return undefined; },
}));
vi.mock('../repository/config.repo.js', () => ({
  async getSettings(_tx: unknown, i: { tenantId: string }) { return S.settings && S.settings['tenant_id'] === i.tenantId ? { ...S.settings } : undefined; },
  async getTestProfileByTestId(_tx: unknown, i: { tenantId: string; testId: string }) { const r = S.profiles.get(i.testId); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async getTestProfile(_tx: unknown, i: { id: string }) { return [...S.profiles.values()].find((p) => p['id'] === i.id); },
  async listTestProfiles(_tx: unknown, i: { tenantId: string; activeOnly?: boolean }) { return [...S.profiles.values()].filter((p) => p['tenant_id'] === i.tenantId && (!i.activeOnly || p['is_active'] !== false)).map((p) => ({ ...p })); },
  async insertSettings(_tx: unknown, row: Row) { return row; },
  async updateSettings() { return undefined; },
}));
vi.mock('../repository/codedValues.repo.js', () => ({
  async listGlobalCancelReasons() { return S.globalReasons.map((r) => ({ ...r })); },
  async listCodedCancelReasons(_tx: unknown, i: { tenantId: string; activeOnly?: boolean }) { return S.tenantReasons.filter((r) => r['tenant_id'] === i.tenantId && (!i.activeOnly || r['is_active'] !== false)).map((r) => ({ ...r })); },
  async getCodedCancelReason(_tx: unknown, i: { id: string }) { return S.tenantReasons.find((r) => r['id'] === i.id); },
  async insertCodedCancelReason(_tx: unknown, row: Row) { return row; },
  async updateCodedCancelReason() { return undefined; },
}));

const { manifest } = await import('../index.js');

const T = '01a1a98a-ac40-7000-8000-00000000a001', OTHER_T = '01a1a98a-ac40-7000-8000-00000000b001', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const ACTOR = '01a1a98a-ac40-7000-8000-00000000a300', MEMB = '01a1a98a-ac40-7000-8000-00000000a500';
const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-12T01:30:00Z');
const NOW_ISO = NOW.toISOString();
const EARLIER = '2026-11-10T09:00:00.000Z';
const MARKER = 'PHI-MARKER-GROSS';

type Kind = 'histology' | 'cytology' | 'ihc' | 'molecular';
interface Setup {
  kind?: Kind; status?: string; version?: number; parts?: number; blocks?: number; slides?: Array<'ready' | 'pending_stain'>;
  gross?: Array<'complete' | 'incomplete' | 'none'>; molecular?: boolean[]; requiresGross?: boolean; submissions?: number; draft?: boolean; tenant?: string;
}
/** builds one case (n) with its parts/blocks/slides/gross/molecular/items; returns the ids */
function build(n: number, o: Setup = {}) {
  const kind = o.kind ?? 'histology';
  const caseId = uid(100 + n);
  S.cases.set(caseId, {
    id: caseId, tenant_id: o.tenant ?? T, centre_id: CENTRE, branch_id: null, order_id: uid(500 + n), patient_id: uid(600 + n), case_kind: kind, status: o.status ?? 'accessioned',
    priority: 'routine', accession_no: 'S26-0001', clinical_history_text: null, assigned_pathologist_membership_id: null, received_at: '2026-11-10T04:00:00.000Z', version: o.version ?? 1,
  });
  const partIds: string[] = [];
  const nParts = o.parts ?? 1;
  for (let i = 0; i < nParts; i++) {
    const id = uid(200 + n * 10 + i); partIds.push(id);
    S.parts.set(id, { id, tenant_id: o.tenant ?? T, centre_id: CENTRE, case_id: caseId, letter: String.fromCharCode(65 + i), letter_seq: i + 1, site_text: 'Left breast', description_text: null, version: 1 });
    const g = o.gross?.[i] ?? 'none';
    if (g !== 'none') {
      const gid = uid(300 + n * 10 + i);
      S.gross.set(gid, {
        id: gid, tenant_id: T, centre_id: CENTRE, case_id: caseId, part_id: id, gross_text: 'Synthetic gross', pieces_count: 1, dimensions_mm: ['10'], weight_g: '1',
        is_complete: g === 'complete', completed_at: g === 'complete' ? EARLIER : null, grossed_by_membership_id: MEMB, version: 1, created_by: ACTOR, updated_by: ACTOR,
      });
    }
  }
  for (let i = 0; i < (o.blocks ?? 0); i++) { const id = uid(400 + n * 10 + i); S.blocks.set(id, { id, tenant_id: T, centre_id: CENTRE, case_id: caseId, part_id: partIds[0], seq: i + 1, label: `S26-0001-A${i + 1}`, version: 1 }); }
  (o.slides ?? []).forEach((st, i) => { const id = uid(450 + n * 10 + i); S.slides.set(id, { id, tenant_id: T, centre_id: CENTRE, case_id: caseId, part_id: partIds[0], seq: i + 1, label: `S26-0001-A1-${i + 1}`, status: st, version: 1 }); });
  (o.molecular ?? []).forEach((active, i) => { const id = uid(480 + n * 10 + i); S.molecular.set(id, { id, tenant_id: T, centre_id: CENTRE, case_id: caseId, assay_code: 'SYN', target_code: 'T1', result_code: 'POS', is_active: active, version: 1 }); });
  const testId = uid(700 + n), itemId = uid(750 + n);
  S.items.set(itemId, { id: itemId, tenant_id: T, case_id: caseId, test_id: testId, role: 'primary', is_active: true });
  S.profiles.set(testId, { id: uid(790 + n), tenant_id: T, test_id: testId, case_kind: kind, requires_gross: o.requiresGross ?? true, is_active: true });
  for (let i = 0; i < (o.submissions ?? 0); i++) { const id = uid(900 + n * 10 + i); S.submissions.set(id, { id, tenant_id: T, case_id: caseId, case_item_id: itemId, item_version_no: 1, lab_status: 'pending' }); }
  if (o.draft) { const id = uid(950 + n); S.drafts.set(id, { id, tenant_id: T, case_id: caseId, kind: 'revision', status: 'open', version: 1 }); }
  return { caseId, partIds, partId: partIds[0]! };
}

interface CtxOpts { assertRole?: (c: unknown, i: Row) => Promise<unknown> }
const calls = { assertRole: [] as Row[], logs: [] as string[] };
const mkCtx = (o: CtxOpts = {}) => ({
  operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999),
  log: { info: (x: object) => calls.logs.push(JSON.stringify(x)), warn: (x: object) => calls.logs.push(JSON.stringify(x)), error: (x: object) => calls.logs.push(JSON.stringify(x)) },
  tenantId: T, actor: { type: 'user', id: ACTOR, membershipId: MEMB }, tx: { async query() { return { rows: [] }; } }, now: () => NOW,
  core: {
    async branch() { throw Object.assign(new Error('nf'), { code: 'common.not_found' }); },
    async user() { return { id: ACTOR, displayName: 'Synthetic Tech', isActive: true }; },
    memberships: { async list() { return []; } },
  },
  ports: { IdentityPort: {
    async assertRole(c: unknown, i: Row) { calls.assertRole.push(i); return o.assertRole ? o.assertRole(c, i) : undefined; },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; },
  } },
}) as any;

const snap = () => ({ c: structuredClone([...S.cases]), p: structuredClone([...S.parts]), g: structuredClone([...S.gross]), t: structuredClone(S.transitions) });
const restore = (s: ReturnType<typeof snap>) => { S.cases = new Map(s.c) as never; S.parts = new Map(s.p) as never; S.gross = new Map(s.g) as never; S.transitions = s.t as never; };
/** emulates requestTx: a throwing handler rolls the whole transaction back */
async function call(op: string, req: Row, ctx = mkCtx()): Promise<any> {
  const s = snap();
  try {
    return await (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx);
  } catch (e) { restore(s); throw e; }
}
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const ifm = (v: number | string) => ({ 'if-match': `"${v}"` });
const snapshot = () => JSON.stringify({ c: [...S.cases], p: [...S.parts], g: [...S.gross], t: S.transitions });

const VALID = { gross_text: 'Synthetic gross text', pieces_count: 3, dimensions_mm: ['12', '8', '4'], weight_g: '0.6', is_complete: false };
const saveGross = (caseId: string, partId: string, body: Row = {}, version: number | string = 0, ctx?: any, replace = false) =>
  call('saveAnatomicGross', { params: { case_id: caseId, part_id: partId }, headers: ifm(version), body: replace ? body : { ...VALID, ...body } }, ctx);
const start = (caseId: string, version = 1, ctx?: any) => call('startAnatomicProcessing', { params: { case_id: caseId }, headers: ifm(version) }, ctx);
const ready = (caseId: string, version = 1, ctx?: any) => call('markAnatomicCaseReady', { params: { case_id: caseId }, headers: ifm(version) }, ctx);
const cancel = (caseId: string, body: Row = { reason_code: 'duplicate_case' }, version = 1, ctx?: any) =>
  call('cancelAnatomicCase', { params: { case_id: caseId }, headers: ifm(version), body }, ctx);
const grossOf = (partId: string) => [...S.gross.values()].find((g) => g['part_id'] === partId);

beforeEach(() => {
  for (const m of [S.cases, S.parts, S.gross, S.blocks, S.slides, S.molecular, S.items, S.profiles, S.submissions, S.drafts] as Map<string, Row>[]) m.clear();
  S.transitions.length = 0; S.hidden.clear(); S.settings = undefined; S.hideGrossFromList = false; S.writes = 0; S.materialWrites = 0; S.failTransition = false;
  S.globalReasons = ['duplicate_case', 'entered_in_error', 'specimen_not_received', 'order_cancelled', 'other'].map((code, i) => ({ id: uid(5000 + i), code, display: code, is_active: true }));
  S.tenantReasons = [{ id: uid(5100), tenant_id: T, code: 'tenant_reason', display: 'Tenant reason (SYNTHETIC)', is_active: true }];
  calls.assertRole.length = 0; calls.logs.length = 0;
});

describe('C11-T08 AC-03.1 A8 save gross', () => {
  it('creates the gross of part A: text, 3 pieces, 12 x 8 x 4 mm, 0.6 g; stored with my membership; If-Match "0" creates', async () => {
    const { caseId, partId } = build(1);
    const r = await saveGross(caseId, partId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ part_id: partId, gross_text: 'Synthetic gross text', pieces_count: 3, dimensions_mm: ['12', '8', '4'], weight_g: '0.6', is_complete: false, version: 1 });
    expect(JSON.stringify(r.body)).not.toContain(':null');
    const row = grossOf(partId)!;
    expect(row).toMatchObject({
      tenant_id: T, centre_id: CENTRE, case_id: caseId, part_id: partId, gross_text: 'Synthetic gross text', pieces_count: 3, dimensions_mm: ['12', '8', '4'], weight_g: '0.6',
      is_complete: false, grossed_by_membership_id: MEMB, created_by: ACTOR,
    });
    expect(row['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // app-generated UUIDv7 (04 D9)
    expect(row['completed_at'] ?? null).toBeNull();
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.work', centreId: CENTRE });
  });

  it('optional fields may be omitted (only gross_text + is_complete)', async () => {
    const { caseId, partId } = build(1);
    const r = await saveGross(caseId, partId, { gross_text: 'Only text', is_complete: false }, 0, undefined, true);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ gross_text: 'Only text', is_complete: false, version: 1 });
    expect(r.body).not.toHaveProperty('weight_g');
  });

  it('boundary values are accepted: pieces 0 and 999, dimensions 0.1 and 9999.9, weight 0.01 and 99999.99, 20000-char text, 1 dimension', async () => {
    const { caseId, partId } = build(1);
    expect((await saveGross(caseId, partId, { pieces_count: 0, dimensions_mm: ['0.1'], weight_g: '0.01', gross_text: 'x'.repeat(20000) })).status).toBe(200);
    expect((await saveGross(caseId, partId, { pieces_count: 999, dimensions_mm: ['9999.9', '1', '2'], weight_g: '99999.99' }, 1)).status).toBe(200);
    expect(grossOf(partId)).toMatchObject({ pieces_count: 999, weight_g: '99999.99', version: 2 });
  });

  it('If-Match "<n>" updates the same row (no second row for the part); version + 1', async () => {
    const { caseId, partId } = build(1);
    await saveGross(caseId, partId);
    const r = await saveGross(caseId, partId, { gross_text: 'Edited text' }, 1);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ gross_text: 'Edited text', version: 2 });
    expect([...S.gross.values()].filter((g) => g['part_id'] === partId)).toHaveLength(1);
  });

  it('If-Match mismatch -> 409 common.version_conflict and the stored record is unchanged', async () => {
    const { caseId, partId } = build(1, { gross: ['incomplete'] }); // stored version 1
    const before = snapshot();
    const e = await rejects(saveGross(caseId, partId, { gross_text: 'Lost update' }, 2));
    expect(e).toMatchObject({ code: 'common.version_conflict' });
    expect(snapshot()).toBe(before);
  });

  it('If-Match "0" while a gross already exists -> 409 common.version_conflict (no second create)', async () => {
    const { caseId, partId } = build(1, { gross: ['incomplete'] });
    const before = snapshot();
    expect(await rejects(saveGross(caseId, partId, {}, 0))).toMatchObject({ code: 'common.version_conflict' });
    expect(snapshot()).toBe(before);
  });

  it('two parallel creates with "0": the loser hits the unique (tenant, part) key and gets 409 version_conflict, not common.internal', async () => {
    const { caseId, partId } = build(1);
    S.hideGrossFromList = true; // both requests "see" no gross, so the race is decided by the DB unique key
    const first = await saveGross(caseId, partId);
    expect(first.status).toBe(200);
    expect(await rejects(saveGross(caseId, partId, { gross_text: 'second writer' }))).toMatchObject({ code: 'common.version_conflict' });
    expect([...S.gross.values()].filter((g) => g['part_id'] === partId)).toHaveLength(1);
    expect(grossOf(partId)!['gross_text']).toBe('Synthetic gross text');
  });

  it('missing If-Match -> 428 common.precondition_required; malformed -> 400 validation_failed; nothing written', async () => {
    const { caseId, partId } = build(1);
    expect(await rejects(call('saveAnatomicGross', { params: { case_id: caseId, part_id: partId }, headers: {}, body: VALID }))).toMatchObject({ code: 'common.precondition_required' });
    for (const bad of ['abc', '', '"-1"', '"01"', '"99999999999"', '1']) {
      const e = await rejects(call('saveAnatomicGross', { params: { case_id: caseId, part_id: partId }, headers: { 'if-match': bad }, body: VALID }));
      expect(e).toMatchObject({ code: 'common.validation_failed' });
    }
    expect(S.gross.size).toBe(0);
  });

  it('works in accessioned, in_processing and ready_for_reporting', async () => {
    for (const [i, status] of (['accessioned', 'in_processing', 'ready_for_reporting'] as const).entries()) {
      const { caseId, partId } = build(i + 1, { status });
      expect((await saveGross(caseId, partId)).status).toBe(200);
    }
  });

  it('received and cancelled cases cannot be grossed -> 409 anatomic.case_invalid_transition (TRD §7: edits allowed from accessioned)', async () => {
    for (const [i, status] of (['received', 'cancelled'] as const).entries()) {
      const { caseId, partId } = build(i + 1, { status });
      expect(await rejects(saveGross(caseId, partId))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    }
    expect(S.gross.size).toBe(0);
  });
});

describe('C11-T08 AC-03.2 A8 validation -> 400 common.validation_failed with the field path', () => {
  const cases: Array<[string, Row, string]> = [
    ['dimension with 2 decimals', { dimensions_mm: ['12', '8.55'] }, '/dimensions_mm/1'],
    ['dimension 0', { dimensions_mm: ['0'] }, '/dimensions_mm/0'],
    ['dimension 0.0', { dimensions_mm: ['12', '0.0'] }, '/dimensions_mm/1'],
    ['negative dimension', { dimensions_mm: ['-1'] }, '/dimensions_mm/0'],
    ['dimension with 5 integer digits', { dimensions_mm: ['12345'] }, '/dimensions_mm/0'],
    ['dimension not numeric', { dimensions_mm: ['abc'] }, '/dimensions_mm/0'],
    ['dimension as JSON number', { dimensions_mm: [12] }, '/dimensions_mm/0'],
    ['dimension with exponent', { dimensions_mm: ['1e3'] }, '/dimensions_mm/0'],
    ['dimension with comma decimal', { dimensions_mm: ['1,5'] }, '/dimensions_mm/0'],
    ['empty dimension list', { dimensions_mm: [] }, '/dimensions_mm'],
    ['4 dimensions', { dimensions_mm: ['1', '2', '3', '4'] }, '/dimensions_mm'],
    ['dimensions not an array', { dimensions_mm: '12' }, '/dimensions_mm'],
    ['weight 0', { weight_g: '0' }, '/weight_g'],
    ['weight 0.00', { weight_g: '0.00' }, '/weight_g'],
    ['weight with 3 decimals', { weight_g: '1.234' }, '/weight_g'],
    ['weight with 6 integer digits', { weight_g: '123456' }, '/weight_g'],
    ['negative weight', { weight_g: '-1' }, '/weight_g'],
    ['weight as JSON number', { weight_g: 0.6 }, '/weight_g'],
    ['pieces -1', { pieces_count: -1 }, '/pieces_count'],
    ['pieces 1000', { pieces_count: 1000 }, '/pieces_count'],
    ['pieces fractional', { pieces_count: 1.5 }, '/pieces_count'],
    ['pieces as string', { pieces_count: '3' }, '/pieces_count'],
    ['gross_text 20001 chars', { gross_text: 'x'.repeat(20001) }, '/gross_text'],
    ['gross_text not a string', { gross_text: 12 }, '/gross_text'],
    ['gross_text with NUL', { gross_text: 'a\u0000b' }, '/gross_text'],
    ['is_complete not boolean', { is_complete: 'true' }, '/is_complete'],
  ];
  it.each(cases)('%s', async (_n, patch, path) => {
    const { caseId, partId } = build(1);
    const before = snapshot();
    const e = await rejects(saveGross(caseId, partId, patch));
    expect(e).toMatchObject({ code: 'common.validation_failed' });
    expect(e.errors?.some((f: any) => String(f.path).startsWith(path))).toBe(true);
    expect(snapshot()).toBe(before);
    expect(S.writes).toBe(0);
  });

  it('gross_text and is_complete are required; body must be an object', async () => {
    const { caseId, partId } = build(1);
    expect(await rejects(saveGross(caseId, partId, { is_complete: false }, 0, undefined, true))).toMatchObject({ code: 'common.validation_failed' });
    expect(await rejects(saveGross(caseId, partId, { gross_text: 'x' }, 0, undefined, true))).toMatchObject({ code: 'common.validation_failed' });
    for (const body of [null, [], 'x', 5]) {
      expect(await rejects(call('saveAnatomicGross', { params: { case_id: caseId, part_id: partId }, headers: ifm(0), body }))).toMatchObject({ code: 'common.validation_failed' });
    }
    expect(S.writes).toBe(0);
  });

  it('mass assignment: server-owned fields in the body -> 400 common.unknown_field, nothing stored', async () => {
    const { caseId, partId } = build(1);
    const extras = [{ grossed_by_membership_id: uid(1) }, { completed_at: EARLIER }, { version: 9 }, { case_id: uid(2) }, { id: uid(3) }, { part_id: uid(4) }, { tenant_id: OTHER_T }];
    const bodies: Row[] = extras.map((x) => ({ ...VALID, ...x }));
    bodies.push(JSON.parse(`{"gross_text":"x","is_complete":false,"__proto__":{"is_complete":true}}`)); // own "__proto__" key from JSON
    for (const body of bodies) {
      const e = await rejects(call('saveAnatomicGross', { params: { case_id: caseId, part_id: partId }, headers: ifm(0), body }));
      expect(e).toMatchObject({ code: 'common.validation_failed' });
      expect(e.errors?.some((f: any) => f.code === 'common.unknown_field')).toBe(true);
    }
    expect(S.gross.size).toBe(0);
  });
});

describe('C11-T08 AC-03.3 A8 completion', () => {
  it('complete on create: is_complete true -> completed_at = now', async () => {
    const { caseId, partId } = build(1);
    const r = await saveGross(caseId, partId, { is_complete: true });
    expect(r.body).toMatchObject({ is_complete: true, completed_at: NOW_ISO });
    expect(new Date(grossOf(partId)!['completed_at']).toISOString()).toBe(NOW_ISO);
  });

  it('incomplete -> complete sets completed_at = now', async () => {
    const { caseId, partId } = build(1, { gross: ['incomplete'] });
    const r = await saveGross(caseId, partId, { is_complete: true }, 1);
    expect(r.body).toMatchObject({ is_complete: true, completed_at: NOW_ISO, version: 2 });
  });

  it('editing a completed gross before sign-out is allowed and completed_at stays', async () => {
    const { caseId, partId } = build(1, { gross: ['complete'], status: 'in_processing' });
    const r = await saveGross(caseId, partId, { gross_text: 'Corrected measurement', is_complete: true }, 1);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ gross_text: 'Corrected measurement', is_complete: true, version: 2 });
    expect(new Date(grossOf(partId)!['completed_at']).toISOString()).toBe(EARLIER);
    expect(new Date(r.body.completed_at).toISOString()).toBe(EARLIER);
  });

  it('un-completing keeps the DB invariant is_complete = (completed_at IS NOT NULL)', async () => {
    const { caseId, partId } = build(1, { gross: ['complete'] });
    await saveGross(caseId, partId, { is_complete: false }, 1);
    const g = grossOf(partId)!;
    expect(g['is_complete']).toBe(false);
    expect(g['completed_at'] ?? null).toBeNull();
  });
});

describe('C11-T08 AC-03.4 / AC-03.5 signed_out edit rules (08 A17 D-66) — signout_locked after sign-out', () => {
  it('A8 on a signed_out case WITHOUT an open change draft -> 409 anatomic.signout_locked, nothing written (existing and new gross)', async () => {
    const a = build(1, { status: 'signed_out', gross: ['complete'] });
    const b = build(2, { status: 'signed_out' });
    const before = snapshot();
    expect(await rejects(saveGross(a.caseId, a.partId, { gross_text: 'late edit' }, 1))).toMatchObject({ code: 'anatomic.signout_locked' });
    expect(await rejects(saveGross(b.caseId, b.partId))).toMatchObject({ code: 'anatomic.signout_locked' });
    expect(snapshot()).toBe(before);
    expect(S.writes).toBe(0);
  });

  it('A8 on a signed_out case WITH an open revision/amendment draft is saved (update and create)', async () => {
    const a = build(1, { status: 'signed_out', gross: ['complete'], draft: true });
    const b = build(2, { status: 'signed_out', draft: true });
    expect((await saveGross(a.caseId, a.partId, { gross_text: 'revised' }, 1)).body).toMatchObject({ gross_text: 'revised', version: 2 });
    expect((await saveGross(b.caseId, b.partId)).status).toBe(200);
  });

  it('a draft of ANOTHER case does not unlock this case', async () => {
    const a = build(1, { status: 'signed_out', gross: ['complete'] });
    build(2, { status: 'signed_out', draft: true });
    expect(await rejects(saveGross(a.caseId, a.partId, {}, 1))).toMatchObject({ code: 'anatomic.signout_locked' });
  });

  it('A7 part site/description: signed_out without draft -> signout_locked; with an open draft -> saved (regression of T-06 on the D-66 (b) path)', async () => {
    const a = build(1, { status: 'signed_out' });
    const b = build(2, { status: 'signed_out', draft: true });
    const put = (x: { caseId: string; partId: string }) => call('updateAnatomicPart', { params: { case_id: x.caseId, part_id: x.partId }, headers: ifm(1), body: { site_text: 'Right breast' } });
    expect(await rejects(put(a))).toMatchObject({ code: 'anatomic.signout_locked' });
    expect((await put(b)).body).toMatchObject({ site_text: 'Right breast', version: 2 });
  });

  it('A6 new part on a signed_out case is signout_locked even WITH an open draft (D-66 (c))', async () => {
    const b = build(1, { status: 'signed_out', draft: true });
    const before = snapshot();
    expect(await rejects(call('addAnatomicPart', { params: { case_id: b.caseId }, headers: {}, body: { site_text: 'New site' } }))).toMatchObject({ code: 'anatomic.signout_locked' });
    expect(snapshot()).toBe(before);
  });

  it('stage transitions on a signed_out case are invalid transitions, not signout_locked (A9/A10/A11)', async () => {
    const x = build(1, { status: 'signed_out', blocks: 1, gross: ['complete'], slides: ['ready'] });
    for (const op of [() => start(x.caseId), () => ready(x.caseId), () => cancel(x.caseId)]) {
      expect(await rejects(op())).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    }
  });
});

describe('C11-T08 A9 startAnatomicProcessing — guard C3 per case kind', () => {
  type Row9 = [string, Setup, boolean, Row?];
  const matrix: Row9[] = [
    // histology: >=1 block and (setting, default true) every part complete gross when the profile requires gross
    ['histology: no block, gross complete', { kind: 'histology', blocks: 0, gross: ['complete'] }, false],
    ['histology: no block, setting off', { kind: 'histology', blocks: 0, gross: ['complete'] }, false, { require_gross_complete_for_processing: false }],
    ['histology: block, no gross record', { kind: 'histology', blocks: 1, gross: ['none'] }, false],
    ['histology: block, gross not complete', { kind: 'histology', blocks: 1, gross: ['incomplete'] }, false],
    ['histology: 2 parts, one complete one missing', { kind: 'histology', parts: 2, blocks: 1, gross: ['complete', 'none'] }, false],
    ['histology: 2 parts, one complete one incomplete', { kind: 'histology', parts: 2, blocks: 1, gross: ['complete', 'incomplete'] }, false],
    ['histology: block, every part complete', { kind: 'histology', parts: 2, blocks: 1, gross: ['complete', 'complete'] }, true],
    ['histology: block, no gross, require_gross_complete_for_processing = false', { kind: 'histology', blocks: 1, gross: ['none'] }, true, { require_gross_complete_for_processing: false }],
    ['histology: block, no gross, test profile does not require gross', { kind: 'histology', blocks: 1, gross: ['none'], requiresGross: false }, true],
    ['histology: block, setting explicitly true, gross incomplete', { kind: 'histology', blocks: 1, gross: ['incomplete'] }, false, { require_gross_complete_for_processing: true }],
    // cytology: >=1 slide or block; gross is not a gate
    ['cytology: no slide, no block', { kind: 'cytology' }, false],
    ['cytology: one pending_stain slide, no gross', { kind: 'cytology', slides: ['pending_stain'] }, true],
    ['cytology: one block, no gross', { kind: 'cytology', blocks: 1 }, true],
    // ihc: >=1 block (a slide alone is not enough)
    ['ihc: no block', { kind: 'ihc' }, false],
    ['ihc: slide but no block', { kind: 'ihc', slides: ['ready'] }, false],
    ['ihc: one block, no gross', { kind: 'ihc', blocks: 1 }, true],
    // molecular: >=1 part
    ['molecular: no part', { kind: 'molecular', parts: 0 }, false],
    ['molecular: one part', { kind: 'molecular', parts: 1 }, true],
  ];
  it.each(matrix)('%s', async (_n, setup, ok, settings) => {
    if (settings) S.settings = { tenant_id: T, ...settings };
    const { caseId } = build(1, setup);
    if (ok) {
      const r = await start(caseId);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id: caseId, status: 'in_processing', version: 2 });
      expect(S.cases.get(caseId)).toMatchObject({ status: 'in_processing', version: 2, updated_by: ACTOR });
      expect(S.transitions).toHaveLength(1);
      expect(S.transitions[0]).toMatchObject({ tenant_id: T, centre_id: CENTRE, case_id: caseId, from_status: 'accessioned', to_status: 'in_processing', created_by: ACTOR });
    } else {
      expect(await rejects(start(caseId))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
      expect(S.cases.get(caseId)).toMatchObject({ status: 'accessioned', version: 1 });
      expect(S.transitions).toHaveLength(0);
      expect(S.writes).toBe(0);
    }
  });

  it('only an accessioned case can start: received, in_processing, ready_for_reporting, signed_out, cancelled -> 409 case_invalid_transition (guards satisfied)', async () => {
    for (const [i, status] of (['received', 'in_processing', 'ready_for_reporting', 'signed_out', 'cancelled'] as const).entries()) {
      const { caseId } = build(i + 1, { status, blocks: 1, gross: ['complete'] });
      expect(await rejects(start(caseId))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
      expect(S.cases.get(caseId)!['status']).toBe(status);
    }
    expect(S.transitions).toHaveLength(0);
  });

  it('If-Match: missing -> 428; stale -> 409 common.version_conflict', async () => {
    const { caseId } = build(1, { blocks: 1, gross: ['complete'], version: 3 });
    expect(await rejects(call('startAnatomicProcessing', { params: { case_id: caseId }, headers: {} }))).toMatchObject({ code: 'common.precondition_required' });
    expect(await rejects(start(caseId, 2))).toMatchObject({ code: 'common.version_conflict' });
    expect(S.cases.get(caseId)).toMatchObject({ status: 'accessioned', version: 3 });
  });

  it('a body cannot choose the target state (mass assignment): extra fields are ignored or rejected, status is always in_processing', async () => {
    const { caseId } = build(1, { blocks: 1, gross: ['complete'] });
    const r = await call('startAnatomicProcessing', { params: { case_id: caseId }, headers: ifm(1), body: { status: 'signed_out', accession_no: 'HACK-1' } }).catch((e) => e);
    if (r instanceof Error) expect(r).toMatchObject({ code: 'common.validation_failed' });
    else expect(r.body).toMatchObject({ status: 'in_processing' });
    expect(S.cases.get(caseId)!['accession_no']).toBe('S26-0001');
    expect(['accessioned', 'in_processing']).toContain(S.cases.get(caseId)!['status']);
  });
});

describe('C11-T08 A10 markAnatomicCaseReady — guard C4 per case kind', () => {
  type Row10 = [string, Setup, boolean];
  const matrix: Row10[] = [
    ['histology: no slides', { kind: 'histology', status: 'in_processing', blocks: 1 }, false],
    ['histology: only pending_stain slides', { kind: 'histology', status: 'in_processing', slides: ['pending_stain', 'pending_stain'] }, false],
    ['histology: one ready slide among pending', { kind: 'histology', status: 'in_processing', slides: ['pending_stain', 'ready'] }, true],
    ['histology: a molecular result does not count', { kind: 'histology', status: 'in_processing', molecular: [true] }, false],
    ['cytology: no slides', { kind: 'cytology', status: 'in_processing' }, false],
    ['cytology: one ready slide', { kind: 'cytology', status: 'in_processing', slides: ['ready'] }, true],
    ['ihc: only pending_stain', { kind: 'ihc', status: 'in_processing', blocks: 1, slides: ['pending_stain'] }, false],
    ['ihc: one ready slide', { kind: 'ihc', status: 'in_processing', blocks: 1, slides: ['ready'] }, true],
    ['molecular: no result', { kind: 'molecular', status: 'in_processing' }, false],
    ['molecular: only inactive results', { kind: 'molecular', status: 'in_processing', molecular: [false, false] }, false],
    ['molecular: a ready slide does not count', { kind: 'molecular', status: 'in_processing', slides: ['ready'] }, false],
    ['molecular: one active result', { kind: 'molecular', status: 'in_processing', molecular: [false, true] }, true],
  ];
  it.each(matrix)('%s', async (_n, setup, ok) => {
    const { caseId } = build(1, setup);
    if (ok) {
      const r = await ready(caseId);
      expect(r.body).toMatchObject({ id: caseId, status: 'ready_for_reporting', version: 2 });
      expect(S.transitions).toHaveLength(1);
      expect(S.transitions[0]).toMatchObject({ tenant_id: T, centre_id: CENTRE, case_id: caseId, from_status: 'in_processing', to_status: 'ready_for_reporting', created_by: ACTOR });
    } else {
      expect(await rejects(ready(caseId))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
      expect(S.cases.get(caseId)).toMatchObject({ status: 'in_processing', version: 1 });
      expect(S.transitions).toHaveLength(0);
    }
  });

  it('only an in_processing case can be marked ready: received, accessioned, ready_for_reporting, signed_out, cancelled -> 409 (guards satisfied)', async () => {
    for (const [i, status] of (['received', 'accessioned', 'ready_for_reporting', 'signed_out', 'cancelled'] as const).entries()) {
      const { caseId } = build(i + 1, { status, slides: ['ready'] });
      expect(await rejects(ready(caseId))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    }
    expect(S.transitions).toHaveLength(0);
  });

  it('If-Match: missing -> 428; stale -> 409 common.version_conflict', async () => {
    const { caseId } = build(1, { status: 'in_processing', slides: ['ready'], version: 4 });
    expect(await rejects(call('markAnatomicCaseReady', { params: { case_id: caseId }, headers: {} }))).toMatchObject({ code: 'common.precondition_required' });
    expect(await rejects(ready(caseId, 1))).toMatchObject({ code: 'common.version_conflict' });
  });

  it('full path accessioned -> in_processing -> ready_for_reporting with the returned versions as If-Match', async () => {
    const { caseId } = build(1, { kind: 'cytology', slides: ['ready'] });
    const a = await start(caseId, 1);
    const b = await ready(caseId, a.body.version);
    expect(b.body).toMatchObject({ status: 'ready_for_reporting', version: 3 });
    expect(S.transitions.map((t) => `${t['from_status']}>${t['to_status']}`)).toEqual(['accessioned>in_processing', 'in_processing>ready_for_reporting']);
  });
});

describe('C11-T08 AC-15.1 / AC-15.2 A11 cancelAnatomicCase', () => {
  it('AC-15.1: case without submission, reason duplicate_case -> cancelled; blocks and slides remain listed and untouched', async () => {
    const { caseId } = build(1, { status: 'in_processing', blocks: 2, slides: ['ready', 'pending_stain'], gross: ['complete'] });
    const r = await cancel(caseId, { reason_code: 'duplicate_case', reason_text: 'Entered twice (SYNTHETIC)' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: caseId, status: 'cancelled', version: 2 });
    expect(S.cases.get(caseId)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'duplicate_case', cancel_reason_text: 'Entered twice (SYNTHETIC)', updated_by: ACTOR });
    expect(new Date(S.cases.get(caseId)!['cancelled_at']).toISOString()).toBe(NOW_ISO); // cases__cancel__ck: (status = 'cancelled') = (cancelled_at IS NOT NULL)
    expect(S.transitions).toHaveLength(1);
    expect(S.transitions[0]).toMatchObject({ tenant_id: T, centre_id: CENTRE, case_id: caseId, from_status: 'in_processing', to_status: 'cancelled', reason_code: 'duplicate_case', created_by: ACTOR });
    expect([...S.blocks.values()].filter((b) => b['case_id'] === caseId)).toHaveLength(2);
    expect([...S.slides.values()].filter((s) => s['case_id'] === caseId)).toHaveLength(2);
    expect(S.materialWrites).toBe(0);
  });

  it.each(['received', 'accessioned', 'in_processing', 'ready_for_reporting'] as const)('cancel allowed from %s (C7)', async (status) => {
    const { caseId } = build(1, { status });
    expect((await cancel(caseId)).body).toMatchObject({ status: 'cancelled' });
    expect(S.transitions[0]).toMatchObject({ from_status: status, to_status: 'cancelled' });
  });

  it('reason_text is optional; the stored text is absent then', async () => {
    const { caseId } = build(1);
    await cancel(caseId, { reason_code: 'other' });
    expect(S.cases.get(caseId)!['cancel_reason_text'] ?? null).toBeNull();
  });

  it('a tenant-defined cancel reason is accepted too (tenant set shadows/extends the global set)', async () => {
    const { caseId } = build(1);
    expect((await cancel(caseId, { reason_code: 'tenant_reason' })).body).toMatchObject({ status: 'cancelled' });
  });

  it('AC-15.2: a case with any item submission -> 409 anatomic.case_invalid_transition, unchanged', async () => {
    const { caseId } = build(1, { status: 'ready_for_reporting', submissions: 1 });
    const before = snapshot();
    expect(await rejects(cancel(caseId))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    expect(snapshot()).toBe(before);
  });

  it('AC-15.2: a signed_out case (with or without submission rows) -> 409 anatomic.case_invalid_transition', async () => {
    const a = build(1, { status: 'signed_out', submissions: 2 });
    const b = build(2, { status: 'signed_out' });
    for (const id of [a.caseId, b.caseId]) expect(await rejects(cancel(id))).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    expect(S.transitions).toHaveLength(0);
  });

  it('a cancelled case cannot be cancelled again nor leave cancelled (A9/A10)', async () => {
    const { caseId } = build(1, { status: 'cancelled', blocks: 1, slides: ['ready'], gross: ['complete'] });
    for (const op of [() => cancel(caseId), () => start(caseId), () => ready(caseId)]) {
      expect(await rejects(op())).toMatchObject({ code: 'anatomic.case_invalid_transition' });
    }
  });

  it('reason_code is required and must be a known cancel reason -> 400 common.validation_failed with the path', async () => {
    const { caseId } = build(1);
    const before = snapshot();
    for (const body of [{}, { reason_code: 'not_a_reason' }, { reason_code: '' }, { reason_code: 5 }, { reason_code: null }, { reason_code: 'DUPLICATE_CASE' }, { reason_text: 'only text' }]) {
      const e = await rejects(cancel(caseId, body as Row));
      expect(e).toMatchObject({ code: 'common.validation_failed' });
      expect(e.errors?.some((f: any) => String(f.path).startsWith('/reason_code'))).toBe(true);
    }
    expect(snapshot()).toBe(before);
  });

  it('a deactivated tenant reason and another tenant\'s reason are not accepted', async () => {
    S.tenantReasons = [
      { id: uid(5200), tenant_id: T, code: 'retired_reason', display: 'Retired (SYNTHETIC)', is_active: false },
      { id: uid(5201), tenant_id: OTHER_T, code: 'foreign_reason', display: 'Foreign (SYNTHETIC)', is_active: true },
    ];
    const { caseId } = build(1);
    for (const code of ['retired_reason', 'foreign_reason']) expect(await rejects(cancel(caseId, { reason_code: code }))).toMatchObject({ code: 'common.validation_failed' });
    expect(S.cases.get(caseId)!['status']).toBe('accessioned');
  });

  it('reason_text > 500 chars, non-string, NUL byte and unknown fields -> 400 (unknown field code common.unknown_field)', async () => {
    const { caseId } = build(1);
    for (const reason_text of ['x'.repeat(501), 5, 'a\u0000b']) {
      const e = await rejects(cancel(caseId, { reason_code: 'other', reason_text }));
      expect(e).toMatchObject({ code: 'common.validation_failed' });
      expect(e.errors?.some((f: any) => String(f.path).startsWith('/reason_text'))).toBe(true);
    }
    expect((await cancel(caseId, { reason_code: 'other', reason_text: 'x'.repeat(500) })).status).toBe(200);
    const c2 = build(2);
    const e = await rejects(cancel(c2.caseId, { reason_code: 'other', status: 'accessioned', cancelled_at: EARLIER }));
    expect(e.errors?.some((f: any) => f.code === 'common.unknown_field')).toBe(true);
  });

  it('If-Match: missing -> 428; stale -> 409 common.version_conflict', async () => {
    const { caseId } = build(1, { version: 2 });
    expect(await rejects(call('cancelAnatomicCase', { params: { case_id: caseId }, headers: {}, body: { reason_code: 'other' } }))).toMatchObject({ code: 'common.precondition_required' });
    expect(await rejects(cancel(caseId, { reason_code: 'other' }, 1))).toMatchObject({ code: 'common.version_conflict' });
  });

  it('atomicity: when the transition row cannot be written the whole cancel is rolled back (error is not swallowed)', async () => {
    const { caseId } = build(1);
    S.failTransition = true;
    const before = snapshot();
    await rejects(cancel(caseId));
    expect(snapshot()).toBe(before);
  });
});

describe('C11-T08 authorization, visibility and concurrency (07-SECURITY §3, §5.2, §5.3)', () => {
  const ops: Array<[string, (x: { caseId: string; partId: string }, ctx?: any) => Promise<any>, Setup]> = [
    ['saveAnatomicGross', (x, ctx) => saveGross(x.caseId, x.partId, {}, 0, ctx), {}],
    ['startAnatomicProcessing', (x, ctx) => start(x.caseId, 1, ctx), { blocks: 1, gross: ['complete'] }],
    ['markAnatomicCaseReady', (x, ctx) => ready(x.caseId, 1, ctx), { status: 'in_processing', slides: ['ready'] }],
    ['cancelAnatomicCase', (x, ctx) => cancel(x.caseId, { reason_code: 'other' }, 1, ctx), {}],
  ];

  it.each(ops)('%s asserts anatomic.case.work at the case centre; a forbidden caller writes nothing', async (_op, run, setup) => {
    const x = build(1, setup);
    const deny = mkCtx({ assertRole: async () => { throw Object.assign(new Error('x'), { code: 'auth.forbidden', name: 'LimsError' }); } });
    const before = snapshot();
    const e = await rejects(run(x, deny));
    expect(e.code).toBe('auth.forbidden');
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.work', centreId: CENTRE });
    expect(snapshot()).toBe(before);
    expect(S.writes).toBe(0);
  });

  it.each(ops)('%s: a case of another tenant / invisible to RLS / malformed id -> 404 common.not_found without touching the role check', async (_op, run, setup) => {
    const foreign = build(1, { ...setup, tenant: OTHER_T });
    const hiddenCase = build(2, setup); S.hidden.add(hiddenCase.caseId);
    for (const x of [foreign, hiddenCase, { caseId: 'not-a-uuid', partId: foreign.partId }, { caseId: uid(424242), partId: foreign.partId }]) {
      expect(await rejects(run(x))).toMatchObject({ code: 'common.not_found' });
    }
    expect(calls.assertRole).toHaveLength(0);
    expect(S.writes).toBe(0);
  });

  it('A8 with a part that belongs to another case -> 404 (no cross-case write)', async () => {
    const a = build(1), b = build(2);
    expect(await rejects(saveGross(a.caseId, b.partId))).toMatchObject({ code: 'common.not_found' });
    expect(await rejects(saveGross(a.caseId, 'not-a-uuid'))).toMatchObject({ code: 'common.not_found' });
    expect(await rejects(saveGross(a.caseId, uid(777777)))).toMatchObject({ code: 'common.not_found' });
    expect(S.gross.size).toBe(0);
  });

  it('two parallel A9 on the same version: exactly one wins and exactly one transition is recorded', async () => {
    const { caseId } = build(1, { blocks: 1, gross: ['complete'] });
    const h = (manifest.handlers as any).startAnatomicProcessing;
    const run = () => h({ params: { case_id: caseId }, query: {}, headers: ifm(1), body: {} }, mkCtx());
    const out = await Promise.allSettled([run(), run()]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(['common.version_conflict', 'anatomic.case_invalid_transition']).toContain(lost.reason.code);
    expect(S.transitions).toHaveLength(1);
    expect(S.cases.get(caseId)).toMatchObject({ status: 'in_processing', version: 2 });
  });

  it('two parallel A11 on the same version: exactly one cancel is recorded', async () => {
    const { caseId } = build(1);
    const h = (manifest.handlers as any).cancelAnatomicCase;
    const run = () => h({ params: { case_id: caseId }, query: {}, headers: ifm(1), body: { reason_code: 'other' } }, mkCtx());
    const out = await Promise.allSettled([run(), run()]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(S.transitions).toHaveLength(1);
  });
});

describe('C11-T08 PHI hygiene (07-SECURITY §6, REQ-SEC-098): submitted text is never echoed or logged', () => {
  it('problem detail/errors and logs of rejected requests do not contain gross text, reason text or accession numbers', async () => {
    const a = build(1, { status: 'signed_out', gross: ['complete'] });
    const b = build(2);
    const c = build(3, { blocks: 0 });
    const errs: any[] = [];
    errs.push(await rejects(saveGross(a.caseId, a.partId, { gross_text: MARKER }, 1)));                       // signout_locked
    errs.push(await rejects(saveGross(b.caseId, b.partId, { gross_text: MARKER, dimensions_mm: ['0'] })));  // validation
    errs.push(await rejects(saveGross(b.caseId, b.partId, { gross_text: MARKER, note: MARKER } as Row)));   // unknown field
    errs.push(await rejects(cancel(b.caseId, { reason_code: MARKER, reason_text: MARKER })));               // bad reason
    errs.push(await rejects(start(c.caseId)));                                                               // guard
    for (const e of errs) {
      const text = JSON.stringify({ m: e.message, d: e.detail, errors: e.errors });
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain('S26-0001');
    }
    expect(calls.logs.join('\n')).not.toContain(MARKER);
    expect(calls.logs.join('\n')).not.toContain('S26-0001');
  });
});
