// C11.T-07 — case reads: A1 listAnatomicCases, A2 lookupAnatomicObject, A3 getAnatomicCase (LabPort read-through) + mappers/case.dto.
// Spec: 02-TRD §5 A1–A3, §5.7 (CaseSummary/CaseDetail field lists + field-level rule REQ-SEC-081), §4.8 (C5 chain status read-through), §12 (access log codes, no PHI in logs),
//       03-APP-FLOW §4.1 (queue definitions), 01-PRD AC-13.1/13.2/13.4, 07-SECURITY (REQ-SEC-081/098, centre scoping → 404, AB-5 unknown fields, invalid_cursor).
// Drives the REAL handlers (manifest.handlers) on IN-MEMORY repos (vi.mock). What a JS mock CANNOT prove — the SQL of the queue definitions (awaiting_lab on item_submissions /
// case_items.lab_approved_version_no), RLS centre scoping (AC-13.2), ordering — is proved by integration/case.reads.live.test.ts (GATED like T-04/T-06). Here the unit tests pin
// what the handler hands to the repository (queue/filters/sort/limit+1) and what it maps back.
//
// SEAMS (spec fixes behaviour; names chosen here, writer follows or disputes):
//   repository/cases.repo.ts  listCasesPage(tx, { tenantId, queue, caseKinds?: string[], centreIds?: string[], priority?: string[], assignedMembershipId?: string,
//        receivedFrom?: string, receivedTo?: string, sort, limit /* page size + 1 */, after?: unknown /* decoded cursor */ }) → Row[]  (cases columns + the computed columns
//        part_count, test_names, profile_missing, specimen_rejected, open_change, pending_stain_orders, parts_missing_site)
//   repository/cases.repo.ts  lookupObjectByLabel(tx, { tenantId, label }) → { object_kind: 'case'|'block'|'slide', case_id, block_id?, slide_id?, centre_id } | undefined
//   detail reads (existing T-04 repos): getCase, listCaseItems (rows may carry test_name), listCaseTransitions, listParts, listGrossRecords, listBlocks, listSlides, listStainOrders,
//        listImages({activeOnly:true}), listAddenda, listMolecularResults, getOpenDraft, listItemSubmissions.
//   mappers/case.dto.ts       toCaseSummary(row, patient?) → CaseSummary (closed key set; patient = { display_name, sex, age_text, patient_code } | undefined)
//   ctx: T-06 ctx + audit.access(entry) (vi.fn) + core.memberships.list/user + ports { IdentityPort.assertRole(ctx,{permission,centreId?}) (rejects LimsError auth.forbidden),
//        FrontdeskPort.getPatientDemographicsBatch(ctx,{patientIds,purpose:'lab_display'}), LabPort.getOrderResults(ctx,{orderId,scope:'all_visible'}) }.
//   request: { query, params, body }; list → { status:200, body:{ data, page:{ next_cursor, limit } } }.
// Fails now: handlers A1–A3 are 501 / common.internal stubs and ../mappers/case.dto.js does not exist.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError, isLimsError } from '../../../core/errors.js';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  cases: new Map<string, Row>(), items: [] as Row[], transitions: [] as Row[], parts: [] as Row[], gross: [] as Row[], blocks: [] as Row[], slides: [] as Row[], stains: [] as Row[],
  images: [] as Row[], addenda: [] as Row[], molecular: [] as Row[], submissions: [] as Row[], openDraft: undefined as Row | undefined, hidden: new Set<string>(),
  pageRows: [] as Row[], pageThrows: undefined as unknown, pageCalls: [] as Row[], lookupCalls: [] as Row[], objects: new Map<string, Row>(), writes: 0, listImagesArgs: [] as Row[],
}));

vi.mock('../repository/cases.repo.js', () => ({
  async getCase(_tx: unknown, i: { tenantId: string; caseId: string }) { const r = S.cases.get(i.caseId); return r && r['tenant_id'] === i.tenantId && !S.hidden.has(i.caseId) ? { ...r } : undefined; },
  async listCasesPage(_tx: unknown, i: Row) { S.pageCalls.push(structuredClone(i)); if (S.pageThrows) throw S.pageThrows; return S.pageRows.map((r) => ({ ...r })); },
  async lookupObjectByLabel(_tx: unknown, i: Row) { S.lookupCalls.push({ ...i }); const o = S.objects.get(i['label']); return o && o['tenant_id'] === i['tenantId'] ? { ...o } : undefined; },
  async listCaseItems(_tx: unknown, i: Row) { return S.items.filter((x) => x['case_id'] === i['caseId']).map((x) => ({ ...x })); },
  async listCaseTransitions(_tx: unknown, i: Row) { return S.transitions.filter((x) => x['case_id'] === i['caseId']).map((x) => ({ ...x })); },
  async listCases() { return [...S.cases.values()]; }, async listCasesByOrder() { return []; }, async getCaseItem() { return undefined; }, async getCaseTransition() { return undefined; },
  async insertCase() { S.writes++; }, async updateCase() { S.writes++; }, async insertCaseItem() { S.writes++; }, async updateCaseItem() { S.writes++; }, async insertCaseTransition() { S.writes++; },
}));
const byCase = (xs: Row[]) => async (_tx: unknown, i: Row) => xs.filter((x) => x['case_id'] === i['caseId']).map((x) => ({ ...x }));
vi.mock('../repository/parts.repo.js', () => ({ listParts: (...a: [unknown, Row]) => byCase(S.parts)(...a), async getPart() { return undefined; }, async insertPart() { S.writes++; }, async updatePart() { S.writes++; } }));
vi.mock('../repository/gross.repo.js', () => ({ listGrossRecords: (...a: [unknown, Row]) => byCase(S.gross)(...a), async getGrossRecord() { return undefined; }, async insertGrossRecord() { S.writes++; }, async updateGrossRecord() { S.writes++; } }));
vi.mock('../repository/blocks.repo.js', () => ({ listBlocks: (...a: [unknown, Row]) => byCase(S.blocks)(...a), async getBlock() { return undefined; }, async insertBlock() { S.writes++; }, async updateBlock() { S.writes++; } }));
vi.mock('../repository/slides.repo.js', () => ({ listSlides: (...a: [unknown, Row]) => byCase(S.slides)(...a), async getSlide() { return undefined; }, async insertSlide() { S.writes++; }, async updateSlide() { S.writes++; } }));
vi.mock('../repository/stainOrders.repo.js', () => ({ listStainOrders: (...a: [unknown, Row]) => byCase(S.stains)(...a), async getStainOrder() { return undefined; }, async insertStainOrder() { S.writes++; }, async updateStainOrder() { S.writes++; } }));
vi.mock('../repository/images.repo.js', () => ({
  async listImages(_tx: unknown, i: Row) { S.listImagesArgs.push({ ...i }); return S.images.filter((x) => x['case_id'] === i['caseId'] && (!i['activeOnly'] || x['is_active'])).map((x) => ({ ...x })); },
  async getImage() { return undefined; }, async insertImage() { S.writes++; }, async updateImage() { S.writes++; },
}));
vi.mock('../repository/addenda.repo.js', () => ({ listAddenda: (...a: [unknown, Row]) => byCase(S.addenda)(...a), async getAddendum() { return undefined; }, async insertAddendum() { S.writes++; }, async updateAddendum() { S.writes++; } }));
vi.mock('../repository/molecular.repo.js', () => ({ listMolecularResults: (...a: [unknown, Row]) => byCase(S.molecular)(...a), async getMolecularResult() { return undefined; }, async insertMolecularResult() { S.writes++; }, async updateMolecularResult() { S.writes++; } }));
vi.mock('../repository/submissions.repo.js', () => ({ listItemSubmissions: (...a: [unknown, Row]) => byCase(S.submissions)(...a), async getItemSubmission() { return undefined; }, async getItemSubmissionByKey() { return undefined; }, async insertItemSubmission() { S.writes++; } }));
vi.mock('../repository/drafts.repo.js', () => ({
  async getOpenDraft() { return S.openDraft ? { ...S.openDraft } : undefined; }, async listReportDrafts() { return []; }, async getReportDraft() { return undefined; },
  async insertReportDraft() { S.writes++; }, async updateReportDraft() { S.writes++; },
}));

const { manifest } = await import('../index.js');

const T = '01a1a98a-ac40-7000-8000-00000000a001', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201', CENTRE2 = '01a1a98a-ac40-7000-8000-00000000a202';
const ACTOR = '01a1a98a-ac40-7000-8000-00000000a300', MEMB = '01a1a98a-ac40-7000-8000-00000000a500', PATH = '01a1a98a-ac40-7000-8000-00000000a501';
const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PATIENT_NAME = 'Synthetic Patient Alpha', ACC = 'S26-0042', PHI_TEXT = 'SYNTHETIC-HISTORY-TEXT';

const mkCase = (n: number, over: Row = {}): Row => ({
  id: uid(100 + n), tenant_id: T, centre_id: CENTRE, branch_id: null, order_id: uid(500 + n), patient_id: uid(600 + n), case_kind: 'histology', status: 'accessioned', priority: 'routine',
  accession_no: ACC, accession_series: 'histology', accession_year: 2026, clinical_history_text: PHI_TEXT, assigned_pathologist_membership_id: null, profile_missing: false,
  received_at: '2026-11-10T04:00:00.000Z', accessioned_at: '2026-11-10T05:00:00.000Z', signed_out_at: null, current_version_no: 0, molecular_rev: 0, version: 3,
  created_by: ACTOR, updated_by: ACTOR, cancel_reason_text: 'SYNTHETIC-CANCEL', ...over,
});
/** a repository page row: cases columns + the computed columns of the seam */
const pageRow = (n: number, over: Row = {}): Row => ({
  ...mkCase(n), part_count: 2, test_names: ['Histopathology (SYNTHETIC)'], specimen_rejected: false, open_change: false, pending_stain_orders: 1, parts_missing_site: true, ...over,
});
const SUMMARY_KEYS = ['id', 'accession_no', 'case_kind', 'status', 'priority', 'centre_id', 'order_id', 'patient_id', 'patient', 'test_names', 'part_count', 'received_at', 'accessioned_at',
  'signed_out_at', 'assigned_pathologist', 'flags', 'version'];
const FLAG_KEYS = ['open_change', 'parts_missing_site', 'pending_stain_orders', 'profile_missing', 'specimen_rejected'];
const DETAIL_KEYS = [...SUMMARY_KEYS, 'clinical_history_text', 'branch_id', 'current_version_no', 'parts', 'blocks', 'slides', 'stain_orders', 'images', 'items', 'molecular_rev',
  'molecular_results', 'open_draft', 'addenda', 'transitions', 'allowed_actions'];
const FORBIDDEN_COLUMNS = ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'accession_series', 'accession_year', 'cancel_reason_text', 'cancel_reason_code', 'accessioned_by',
  'assigned_pathologist_membership_id'];

interface CtxOpts { deny?: string[]; denyLab?: boolean; labResults?: Row; labThrows?: unknown; fdThrows?: unknown; demographics?: Row[]; members?: Row[] }
const calls = { assertRole: [] as Row[], access: [] as Row[], lab: [] as Row[], fd: [] as Row[], members: [] as Row[], logs: [] as string[], order: [] as string[] };
const forbidden = () => new LimsError('auth.forbidden');
const mkCtx = (o: CtxOpts = {}) => ({
  operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999),
  log: { info: (x: object) => calls.logs.push(JSON.stringify(x)), warn: (x: object) => calls.logs.push(JSON.stringify(x)), error: (x: object) => calls.logs.push(JSON.stringify(x)) },
  tenantId: T, actor: { type: 'user', id: ACTOR, membershipId: MEMB }, tx: { async query() { S.writes++; return { rows: [] }; } }, now: () => new Date('2026-11-12T01:30:00Z'),
  audit: { async access(e: Row) { calls.order.push('access'); calls.access.push(structuredClone(e)); } },
  core: {
    async user() { return { id: ACTOR, displayName: 'Synthetic Tech', isActive: true }; },
    async branch() { return { id: uid(1), branchCode: 'B1', name: 'B', isProcessingLab: true, isActive: true }; },
    memberships: { async list(_c: unknown, i: Row) { calls.members.push(i); return (o.members ?? [{ membershipId: PATH, displayName: 'Dr Synthetic Pathologist' }]).map((m) => ({ roleCodes: [], allCentres: false, isActive: true, ...m })); } },
  },
  ports: {
    IdentityPort: {
      async assertRole(_c: unknown, i: Row) { calls.assertRole.push(structuredClone(i)); if (o.deny?.includes(i['permission'])) throw forbidden(); },
      async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; },
    },
    FrontdeskPort: {
      async getPatientDemographicsBatch(_c: unknown, i: Row) {
        calls.fd.push(structuredClone(i));
        if (o.fdThrows) throw o.fdThrows;
        return (o.demographics ?? (i['patientIds'] as string[]).map((id) => ({ patientId: id, patientCode: `P-${id.slice(-4)}`, fullName: PATIENT_NAME, sex: 'F', ageAtOrder: { years: 54, months: 2, days: 0 }, status: 'active', consents: {} })));
      },
    },
    LabPort: {
      async getOrderResults(_c: unknown, i: Row) {
        calls.order.push('lab'); calls.lab.push(structuredClone(i));
        if (o.denyLab) throw forbidden();
        if (o.labThrows) throw o.labThrows;
        return o.labResults ?? { orderId: i['orderId'], specimens: [], items: [], approvedSetHash: 'h' };
      },
    },
  },
}) as any;

const call = (op: string, req: Row, ctx = mkCtx()): Promise<any> => (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx);
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const list = (query: Row = {}, ctx = mkCtx()) => call('listAnatomicCases', { query }, ctx);
const detail = (caseId: string, ctx = mkCtx()) => call('getAnatomicCase', { params: { case_id: caseId } }, ctx);
const lookup = (body: Row, ctx = mkCtx()) => call('lookupAnatomicObject', { body }, ctx);
const lastPage = () => S.pageCalls[S.pageCalls.length - 1]!;

beforeEach(() => {
  S.cases.clear(); for (const k of ['items', 'transitions', 'parts', 'gross', 'blocks', 'slides', 'stains', 'images', 'addenda', 'molecular', 'submissions', 'pageRows', 'pageCalls', 'lookupCalls', 'listImagesArgs'] as const) S[k].length = 0;
  S.objects.clear(); S.hidden.clear(); S.pageThrows = undefined; S.openDraft = undefined; S.writes = 0;
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k].length = 0;
});

// ======================================================================================================= A1 list
describe('A1 listAnatomicCases — queue → repository filter, default order, paging (AC-13.1)', () => {
  it('AC-13.1: queue=to_accession is handed to the repository as such, default sort priority_received_at (urgent first, then oldest); page size 50 → asks for 51', async () => {
    S.pageRows = [pageRow(1, { status: 'received' })];
    const r = await list({ queue: 'to_accession' });
    expect(r.status).toBe(200);
    expect(lastPage()).toMatchObject({ tenantId: T, queue: 'to_accession', sort: 'priority_received_at', limit: 51 });
    expect(r.body.page).toEqual({ next_cursor: null, limit: 50 });
    expect(r.body.data).toHaveLength(1);
  });
  it('no queue → "all"; every documented queue and sort value is accepted and forwarded verbatim', async () => {
    await list(); expect(lastPage().queue).toBe('all');
    for (const q of ['to_accession', 'grossing', 'bench', 'reporting', 'awaiting_lab', 'signed_out', 'cancelled', 'all']) { await list({ queue: q }); expect(lastPage().queue).toBe(q); }
    for (const s of ['received_at', '-received_at', 'accessioned_at', '-accessioned_at', 'priority_received_at']) { await list({ sort: s }); expect(lastPage().sort).toBe(s); }
  });
  it('sort=accessioned_at is forwarded as ascending accessioned_at (not silently replaced by the default)', async () => {
    await list({ sort: 'accessioned_at', queue: 'signed_out' });
    expect(lastPage()).toMatchObject({ queue: 'signed_out', sort: 'accessioned_at' });
  });
  it('awaiting_lab never calls C5 per row (no LabPort call from the list, TRD §11 / APP-FLOW §4.1)', async () => {
    S.pageRows = [pageRow(1, { status: 'signed_out' }), pageRow(2, { status: 'signed_out' })];
    const ctx = mkCtx(); await list({ queue: 'awaiting_lab' }, ctx);
    expect(calls.lab).toEqual([]);
  });
  it('filters: case_kind csv, centre_id csv, priority, assigned_pathologist=me → caller membership, uuid → itself, received_at window', async () => {
    await list({ case_kind: 'histology,ihc', centre_id: `${CENTRE},${CENTRE2}`, priority: 'urgent', assigned_pathologist: 'me', received_at_from: '2026-11-01T00:00:00Z', received_at_to: '2026-11-30T00:00:00Z' });
    expect(lastPage()).toMatchObject({ caseKinds: ['histology', 'ihc'], centreIds: [CENTRE, CENTRE2], priority: ['urgent'], assignedMembershipId: MEMB });
    expect(lastPage().receivedFrom).toBeDefined(); expect(lastPage().receivedTo).toBeDefined();
    await list({ assigned_pathologist: PATH }); expect(lastPage().assignedMembershipId).toBe(PATH);
  });
  it('limit 1–200: explicit limit is honoured (+1 probe row), 200 allowed, string form accepted', async () => {
    await list({ limit: '10' }); expect(lastPage().limit).toBe(11);
    await list({ limit: 200 }); expect(lastPage().limit).toBe(201);
  });
  it.each([['limit=0', { limit: 0 }], ['limit=201', { limit: 201 }], ['limit=abc', { limit: 'abc' }], ['limit=-1', { limit: '-1' }], ['bad queue', { queue: 'everything' }], ['bad sort', { sort: 'accession_no' }],
    ['sort injection', { sort: 'received_at; DROP TABLE anatomic.cases' }], ['bad case_kind', { case_kind: 'histology,xray' }], ['bad priority', { priority: 'asap' }], ['non-uuid centre', { centre_id: 'A1' }],
    ['21 centres', { centre_id: Array.from({ length: 21 }, (_, i) => uid(300 + i)).join(',') }], ['assigned_pathologist garbage', { assigned_pathologist: 'someone' }],
    ['bad date', { received_at_from: 'yesterday' }], ['unknown query key (AB-5)', { tenant_id: T }]])('%s → 400 common.validation_failed, repository never reached', async (_n, q) => {
    const e = await rejects(list(q as Row));
    expect(isLimsError(e) && e.code).toBe('common.validation_failed');
    expect(S.pageCalls).toEqual([]);
    expect(JSON.stringify(e)).not.toContain('DROP TABLE'); // submitted value is never echoed
  });
  it('cursor round-trip: limit+1 rows → exactly limit returned + next_cursor; the next call hands a decoded cursor ("after") back; last page → next_cursor null', async () => {
    S.pageRows = [pageRow(1), pageRow(2), pageRow(3)];
    const p1 = await list({ limit: 2 });
    expect(p1.body.data.map((c: Row) => c.id)).toEqual([uid(101), uid(102)]);
    expect(typeof p1.body.page.next_cursor).toBe('string');
    expect(p1.body.page.next_cursor).not.toContain(T); // opaque, no tenant id / row data in clear
    expect(lastPage().after).toBeUndefined();
    S.pageRows = [pageRow(3)];
    const p2 = await list({ limit: 2, cursor: p1.body.page.next_cursor });
    expect(lastPage().after).toBeDefined();
    expect(p2.body.page.next_cursor).toBeNull();
  });
  it.each([['not base64', '%%%not-a-cursor%%%'], ['empty', ''], ['oversized', 'a'.repeat(5000)], ['valid base64 of garbage', Buffer.from('{"x":1').toString('base64url')],
    ['forged __proto__', Buffer.from('{"__proto__":{"admin":true}}').toString('base64url')], ['sql in cursor', Buffer.from("{\"id\":\"1' OR '1'='1\"}").toString('base64url')]])('hostile cursor (%s) → 400 common.invalid_cursor, no repository read', async (_n, cursor) => {
    const e = await rejects(list({ cursor }));
    expect(isLimsError(e) && e.code).toBe('common.invalid_cursor');
    expect(S.pageCalls).toEqual([]);
  });
  it('a cursor minted for one sort/queue is not accepted for another (cursor bound to the query shape)', async () => {
    S.pageRows = [pageRow(1), pageRow(2), pageRow(3)];
    const p1 = await list({ limit: 2, queue: 'grossing', sort: 'received_at' });
    S.pageCalls.length = 0;
    const e = await rejects(list({ limit: 2, queue: 'signed_out', sort: '-accessioned_at', cursor: p1.body.page.next_cursor }));
    expect(isLimsError(e) && e.code).toBe('common.invalid_cursor');
    expect(S.pageCalls).toEqual([]);
  });
  it('a list writes nothing and writes no access_log row (not a registered code, TRD §12); logs hold ids only — no accession no., name or history text', async () => {
    S.pageRows = [pageRow(1), pageRow(2)];
    const ctx = mkCtx(); await list({}, ctx);
    expect(S.writes).toBe(0); expect(calls.access).toEqual([]);
    const logs = calls.logs.join('\n');
    for (const secret of [ACC, PATIENT_NAME, PHI_TEXT]) expect(logs).not.toContain(secret);
  });
  it('repository error propagates unchanged (fail closed, no partial page)', async () => {
    S.pageRows = [pageRow(1)]; S.pageThrows = new LimsError('common.rate_limited');
    const e = await rejects(list({}));
    expect(S.pageCalls).toHaveLength(1);
    expect(isLimsError(e) && e.code).toBe('common.rate_limited');
  });
});

// ======================================================================================================= A1 mapper / field allowlist
describe('A1 CaseSummary mapper — exact field list; patient only with frontdesk.patient.read (REQ-SEC-081)', () => {
  it('emits exactly the §5.7 CaseSummary keys: no tenant_id/created_by/accession_series/cancel_reason_text/clinical history; flags has the five documented keys', async () => {
    S.pageRows = [pageRow(1, { assigned_pathologist_membership_id: PATH, signed_out_at: null })];
    const c = (await list()).body.data[0];
    expect(Object.keys(c).filter((k) => !SUMMARY_KEYS.includes(k))).toEqual([]);
    for (const k of FORBIDDEN_COLUMNS) expect(c).not.toHaveProperty(k);
    expect(c).not.toHaveProperty('clinical_history_text');
    expect(Object.keys(c.flags).sort()).toEqual(FLAG_KEYS);
    expect(c).toMatchObject({ id: uid(101), accession_no: ACC, case_kind: 'histology', status: 'accessioned', priority: 'routine', centre_id: CENTRE, patient_id: uid(601), part_count: 2,
      test_names: ['Histopathology (SYNTHETIC)'], version: 3, flags: { profile_missing: false, specimen_rejected: false, open_change: false, pending_stain_orders: 1, parts_missing_site: true } });
    expect(typeof c.flags.pending_stain_orders).toBe('number'); expect(typeof c.flags.parts_missing_site).toBe('boolean');
  });
  it('a not-yet-accessioned case has no accession_no key (optional field, never null/empty string)', async () => {
    S.pageRows = [pageRow(1, { status: 'received', accession_no: null, accessioned_at: null })];
    const c = (await list()).body.data[0];
    expect(c).not.toHaveProperty('accession_no'); expect(c).not.toHaveProperty('accessioned_at');
  });
  it('holder of frontdesk.patient.read: patient { display_name, sex, age_text, patient_code } from ONE batched FrontdeskPort call (purpose lab_display, de-duplicated ids)', async () => {
    S.pageRows = [pageRow(1), pageRow(2), pageRow(3, { patient_id: uid(601) })]; // case 3 shares case 1's patient
    const r = await list();
    expect(calls.fd).toHaveLength(1);
    expect(calls.fd[0]).toMatchObject({ purpose: 'lab_display' });
    expect([...calls.fd[0].patientIds].sort()).toEqual([uid(601), uid(602)]);
    expect(calls.assertRole.some((a) => a.permission === 'frontdesk.patient.read')).toBe(true);
    const p = r.body.data[0].patient;
    expect(Object.keys(p).sort()).toEqual(['age_text', 'display_name', 'patient_code', 'sex']);
    expect(p).toMatchObject({ display_name: PATIENT_NAME, sex: 'F' }); expect(p.age_text).toContain('54'); expect(p.patient_code).toBe(`P-${uid(601).slice(-4)}`);
    expect(r.body.data[2].patient.display_name).toBe(PATIENT_NAME);
  });
  it('WITHOUT frontdesk.patient.read: no "patient" key on any row (patient_id stays), FrontdeskPort is not called, the list still succeeds, no name anywhere in the response', async () => {
    S.pageRows = [pageRow(1), pageRow(2)];
    const ctx = mkCtx({ deny: ['frontdesk.patient.read'] });
    const r = await list({}, ctx);
    expect(r.status).toBe(200);
    for (const c of r.body.data) { expect(c).not.toHaveProperty('patient'); expect(c.patient_id).toBeDefined(); }
    expect(calls.fd).toEqual([]);
    expect(JSON.stringify(r.body)).not.toContain(PATIENT_NAME);
  });
  it('FrontdeskPort failure (unavailable) → patient omitted ("omitted if unavailable"), list still 200', async () => {
    S.pageRows = [pageRow(1)];
    const r = await list({}, mkCtx({ fdThrows: new LimsError('common.internal') }));
    expect(r.status).toBe(200); expect(r.body.data[0]).not.toHaveProperty('patient');
  });
  it('patient missing from the port answer (merged / other tenant / anonymised) → omitted for that row only; the port\'s other fields (phone, email, birthOn, consents) never leak', async () => {
    S.pageRows = [pageRow(1), pageRow(2)];
    const demo = [{ patientId: uid(601), patientCode: 'P-1', fullName: PATIENT_NAME, sex: 'F', ageAtOrder: { years: 3, months: 0, days: 0 }, phoneE164: '+9779800000000', email: 'x@example.invalid', birthOn: '1970-01-01', consents: { sms: true }, status: 'active' }];
    const r = await list({}, mkCtx({ demographics: demo }));
    expect(r.body.data[0].patient).toMatchObject({ display_name: PATIENT_NAME });
    expect(r.body.data[1]).not.toHaveProperty('patient');
    const s = JSON.stringify(r.body);
    for (const leak of ['+9779800000000', 'x@example.invalid', '1970-01-01', 'consents', 'phone', 'email']) expect(s).not.toContain(leak);
  });
  it('assigned_pathologist { membership_id, display_name } resolved via ctx.core (08 A17 P-17), only for assigned cases', async () => {
    S.pageRows = [pageRow(1, { assigned_pathologist_membership_id: PATH }), pageRow(2)];
    const r = await list();
    expect(r.body.data[0].assigned_pathologist).toEqual({ membership_id: PATH, display_name: 'Dr Synthetic Pathologist' });
    expect(r.body.data[1]).not.toHaveProperty('assigned_pathologist');
  });
  it('mapper unit: toCaseSummary(row, patient) is pure, closed-key, and omits patient when none is given', async () => {
    const { toCaseSummary } = await import('../mappers/case.dto.js');
    const row = pageRow(1);
    const without = toCaseSummary(row, undefined) as Row;
    expect(Object.keys(without).filter((k) => !SUMMARY_KEYS.includes(k))).toEqual([]);
    expect(without).not.toHaveProperty('patient');
    const withP = toCaseSummary(row, { display_name: 'N', sex: 'F', age_text: '54y', patient_code: 'P-1' }) as Row;
    expect(withP.patient).toEqual({ display_name: 'N', sex: 'F', age_text: '54y', patient_code: 'P-1' });
    expect(row).toEqual(pageRow(1)); // input row untouched
  });
});

// ======================================================================================================= A3 detail
const seedDetail = (over: Row = {}) => {
  const c = mkCase(1, { assigned_pathologist_membership_id: PATH, status: 'signed_out', current_version_no: 1, ...over });
  S.cases.set(c['id'], c);
  const id = c['id'] as string;
  S.items = [
    { id: uid(701), tenant_id: T, case_id: id, order_item_id: uid(801), test_id: uid(901), test_name: 'Histopathology (SYNTHETIC)', role: 'primary', is_active: true, lab_approved_version_no: 0 },
    { id: uid(702), tenant_id: T, case_id: id, order_item_id: uid(802), test_id: uid(902), test_name: 'IHC add-on (SYNTHETIC)', role: 'addon', is_active: true, lab_approved_version_no: 0 },
  ];
  S.parts = [{ id: uid(201), tenant_id: T, case_id: id, letter: 'A', letter_seq: 1, site_text: 'Left breast', description_text: null, specimen_id: null, specimen_state: 'none', version: 1 }];
  S.submissions = [{ id: uid(1001), tenant_id: T, case_id: id, case_item_id: uid(701), item_version_no: 1, lab_status: 'resulted', lab_version_no: 1, submitted_at: '2026-11-11T05:00:00Z' },
    { id: uid(1002), tenant_id: T, case_id: id, case_item_id: uid(701), item_version_no: 2, lab_status: 'resulted', lab_version_no: 1, submitted_at: '2026-11-12T05:00:00Z' }];
  S.transitions = [{ id: uid(401), case_id: id, from_status: null, to_status: 'received', created_at: '2026-11-10T04:00:00Z', created_by: ACTOR },
    { id: uid(402), case_id: id, from_status: 'received', to_status: 'accessioned', created_at: '2026-11-10T05:00:00Z', created_by: ACTOR }];
  return id;
};
const labFor = (versionNo: number, status: string, origin = 'module', orderItemId = uid(801)) => ({
  orderId: uid(501), specimens: [], approvedSetHash: 'h',
  items: [{ orderItemId, testId: uid(901), departmentId: uid(950), results: [{ resultId: uid(1100), orderItemId, testId: uid(901), analyteId: uid(960), versionNo, status, origin, commentCodes: [], attachments: [] }] }],
});

describe('A3 getAnatomicCase — detail, permission, access log, LabPort read-through (AC-13.4, TRD §4.8)', () => {
  it('200 CaseDetail with exactly the §5.7 keys (no tenant_id / audit columns), nested collections present, transitions newest first', async () => {
    const id = seedDetail();
    const r = await detail(id);
    expect(r.status).toBe(200);
    const b = r.body;
    expect(Object.keys(b).filter((k) => !DETAIL_KEYS.includes(k))).toEqual([]);
    for (const k of FORBIDDEN_COLUMNS) expect(b).not.toHaveProperty(k);
    for (const k of ['parts', 'blocks', 'slides', 'stain_orders', 'images', 'items', 'molecular_results', 'addenda', 'transitions', 'allowed_actions']) expect(Array.isArray(b[k])).toBe(true);
    expect(b).toMatchObject({ id, status: 'signed_out', current_version_no: 1, clinical_history_text: PHI_TEXT, molecular_rev: 0 });
    expect(b.parts[0]).toMatchObject({ letter: 'A', site_text: 'Left breast', specimen_state: 'none' });
    expect(b.parts[0]).not.toHaveProperty('tenant_id');
    expect(b.transitions.map((t: Row) => t.to_status)).toEqual(['accessioned', 'received']);
    expect(b.transitions.every((t: Row) => typeof t.by_display_name === 'string' && t.by_display_name.length > 0)).toBe(true);
    expect(b.assigned_pathologist).toEqual({ membership_id: PATH, display_name: 'Dr Synthetic Pathologist' });
    expect(S.writes).toBe(0);
  });
  it('images list is active-only; an open draft is summarised as { kind, version, updated_at } without any draft text', async () => {
    const id = seedDetail();
    S.images = [{ id: uid(1201), tenant_id: T, case_id: id, kind: 'gross', state: 'ready', is_active: true, version: 1 }, { id: uid(1202), tenant_id: T, case_id: id, kind: 'gross', state: 'ready', is_active: false, version: 1 }];
    S.openDraft = { id: uid(1301), case_id: id, kind: 'revision', version: 4, updated_at: '2026-11-12T00:00:00Z', gross_text: 'SECRET-DRAFT-TEXT', impression_text: 'SECRET-DRAFT-TEXT' };
    const b = (await detail(id)).body;
    expect(b.images.map((i: Row) => i.id)).toEqual([uid(1201)]);
    expect(b.open_draft).toEqual({ kind: 'revision', version: 4, updated_at: '2026-11-12T00:00:00Z' });
    expect(JSON.stringify(b)).not.toContain('SECRET-DRAFT-TEXT');
  });
  it('access log: exactly one ctx.audit.access { action anatomic_case.view, entityType anatomic_case, entityId = case id, outcome allowed } on success', async () => {
    const id = seedDetail();
    const ctx = mkCtx(); await detail(id, ctx);
    expect(calls.access).toHaveLength(1);
    expect(calls.access[0]).toMatchObject({ action: 'anatomic_case.view', entityType: 'anatomic_case', entityId: id, outcome: 'allowed' });
    expect(JSON.stringify(calls.access[0])).not.toContain(ACC); // no accession no. / PHI in the audit detail
    expect(JSON.stringify(calls.access[0])).not.toContain(PHI_TEXT);
  });
  it('no anatomic_case.view row when the case is not visible (404), when assertRole refuses (403), or when the case id is malformed (404)', async () => {
    const id = seedDetail(); S.hidden.add(id);
    let ctx = mkCtx(); let e = await rejects(detail(id, ctx));
    expect(isLimsError(e) && e.code).toBe('common.not_found'); expect(calls.access).toEqual([]); expect(calls.lab).toEqual([]);
    S.hidden.clear(); ctx = mkCtx({ deny: ['anatomic.case.read'] }); e = await rejects(detail(id, ctx));
    expect(isLimsError(e) && e.code).toBe('auth.forbidden'); expect(calls.access).toEqual([]); expect(calls.lab).toEqual([]); expect(calls.fd).toEqual([]);
    e = await rejects(detail('not-a-uuid')); expect(isLimsError(e) && e.code).toBe('common.not_found');
  });
  it('permission check is anatomic.case.read AT the case centre (centre-scoped caller: other centre = refused)', async () => {
    const id = seedDetail(); const ctx = mkCtx(); await detail(id, ctx);
    expect(calls.assertRole).toContainEqual({ permission: 'anatomic.case.read', centreId: CENTRE });
  });
  it('another tenant\'s case id → 404 common.not_found, nothing read from LabPort / FrontdeskPort, no access row', async () => {
    const id = seedDetail(); S.cases.get(id)!['tenant_id'] = '01a1a98a-ac40-7000-8000-00000000b001';
    const ctx = mkCtx(); const e = await rejects(detail(id, ctx));
    expect(isLimsError(e) && e.code).toBe('common.not_found'); expect(calls.lab).toEqual([]); expect(calls.fd).toEqual([]); expect(calls.access).toEqual([]);
  });

  it('LabPort read-through: one call getOrderResults({ orderId, scope: "all_visible" }); per item lab_status + lab_version_no from the origin=module result matched by orderItemId', async () => {
    const id = seedDetail();
    const ctx = mkCtx({ labResults: labFor(2, 'approved') }); const b = (await detail(id, ctx)).body;
    expect(calls.lab).toEqual([{ orderId: uid(501), scope: 'all_visible' }]);
    const primary = b.items.find((i: Row) => i.case_item_id === uid(701)), addon = b.items.find((i: Row) => i.case_item_id === uid(702));
    expect(primary).toMatchObject({ order_item_id: uid(801), test_id: uid(901), role: 'primary', is_active: true, lab_status: 'approved', lab_version_no: 2 });
    expect(addon).toMatchObject({ role: 'addon', order_item_id: uid(802) });
    expect(addon).not.toHaveProperty('lab_status'); // no module result for this order item
  });
  it('last_submitted_version_no = highest item_version_no of that case item\'s submissions (item without submissions → key absent)', async () => {
    const id = seedDetail(); const b = (await detail(id, mkCtx({ labResults: labFor(1, 'resulted') }))).body;
    expect(b.items.find((i: Row) => i.case_item_id === uid(701)).last_submitted_version_no).toBe(2);
    expect(b.items.find((i: Row) => i.case_item_id === uid(702))).not.toHaveProperty('last_submitted_version_no');
  });
  it('only origin=module results count: an instrument/manual result for the same order item never sets lab_status', async () => {
    const id = seedDetail(); const b = (await detail(id, mkCtx({ labResults: labFor(5, 'approved', 'instrument') }))).body;
    const primary = b.items.find((i: Row) => i.case_item_id === uid(701));
    expect(primary.lab_status).not.toBe('approved'); expect(primary.lab_version_no).not.toBe(5);
  });
  it('lab_status OMITTED when the caller lacks lab.result.read: LabPort throws auth.forbidden → 200, every item without lab_status/lab_version_no, all other fields intact', async () => {
    const id = seedDetail(); const ctx = mkCtx({ denyLab: true }); const r = await detail(id, ctx);
    expect(r.status).toBe(200);
    for (const it of r.body.items) { expect(it).not.toHaveProperty('lab_status'); expect(it).not.toHaveProperty('lab_version_no'); expect(it.case_item_id).toBeDefined(); expect(it.order_item_id).toBeDefined(); }
    expect(r.body.parts).toHaveLength(1);
    expect(calls.access).toHaveLength(1); // the view itself is still logged
  });
  it('any OTHER LabPort error is not swallowed (rethrown unchanged, 08 A17 P-23) and the view is not logged as allowed', async () => {
    const id = seedDetail(); const ctx = mkCtx({ labThrows: new LimsError('common.rate_limited') });
    const e = await rejects(detail(id, ctx));
    expect(calls.lab).toHaveLength(1);
    expect(isLimsError(e) && e.code).toBe('common.rate_limited'); expect(calls.access).toEqual([]);
  });
  it('never cached beyond the request: two detail calls → two LabPort calls (PHI P3)', async () => {
    const id = seedDetail(); const ctx = mkCtx({ labResults: labFor(1, 'resulted') }); await detail(id, ctx); await detail(id, ctx);
    expect(calls.lab).toHaveLength(2);
  });
  it('detail patient rule is the same as the list: present only with frontdesk.patient.read', async () => {
    const id = seedDetail();
    expect((await detail(id)).body.patient).toMatchObject({ display_name: PATIENT_NAME });
    const b = (await detail(id, mkCtx({ deny: ['frontdesk.patient.read'] }))).body;
    expect(b).not.toHaveProperty('patient'); expect(JSON.stringify(b)).not.toContain(PATIENT_NAME);
  });
  it('many users at once: 12 interleaved detail calls with different LabPort answers never share lab_status', async () => {
    const id = seedDetail();
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => detail(id, mkCtx({ labResults: labFor(i + 1, i % 2 ? 'approved' : 'resulted') }))));
    rs.forEach((r, i) => expect(r.body.items.find((x: Row) => x.case_item_id === uid(701))).toMatchObject({ lab_version_no: i + 1, lab_status: i % 2 ? 'approved' : 'resulted' }));
  });
  it('logs ids only: no accession no., patient name, history text during a detail read', async () => {
    const id = seedDetail(); await detail(id);
    const logs = calls.logs.join('\n'); for (const s of [ACC, PATIENT_NAME, PHI_TEXT]) expect(logs).not.toContain(s);
  });
});

// ======================================================================================================= A2 lookup
describe('A2 lookupAnatomicObject — scan resolves to the case (AC-13.4), success-only access log, label in body only', () => {
  const obj = (label: string, o: Row) => S.objects.set(label, { tenant_id: T, centre_id: CENTRE, ...o });
  it('AC-13.4: accession number → { object_kind: "case", case_id }', async () => {
    obj(ACC, { object_kind: 'case', case_id: uid(101) });
    const r = await lookup({ label: ACC });
    expect(r.status).toBe(200); expect(r.body).toEqual({ object_kind: 'case', case_id: uid(101) });
    expect(S.lookupCalls).toEqual([{ tenantId: T, label: ACC }]);
  });
  it('block label → object_kind block + block_id; slide label → object_kind slide + slide_id (+ block_id when the slide has one is not required)', async () => {
    obj('S26-0042-A1', { object_kind: 'block', case_id: uid(101), block_id: uid(301) });
    obj('S26-0042-A1-1', { object_kind: 'slide', case_id: uid(101), slide_id: uid(401) });
    expect((await lookup({ label: 'S26-0042-A1' })).body).toEqual({ object_kind: 'block', case_id: uid(101), block_id: uid(301) });
    const s = (await lookup({ label: 'S26-0042-A1-1' })).body;
    expect(s).toMatchObject({ object_kind: 'slide', case_id: uid(101), slide_id: uid(401) });
    expect(Object.keys(s).filter((k) => !['object_kind', 'case_id', 'block_id', 'slide_id'].includes(k))).toEqual([]);
  });
  it('access log on success only: anatomic_object.lookup / anatomic_case / case id (no label, no detail with the scanned text)', async () => {
    obj(ACC, { object_kind: 'case', case_id: uid(101) });
    const ctx = mkCtx(); await lookup({ label: ACC }, ctx);
    expect(calls.access).toHaveLength(1);
    expect(calls.access[0]).toMatchObject({ action: 'anatomic_object.lookup', entityType: 'anatomic_case', entityId: uid(101), outcome: 'allowed' });
    expect(JSON.stringify(calls.access[0])).not.toContain(ACC);
  });
  it('unknown label → 404 common.not_found, NO access row, the label is not echoed in the error or the logs', async () => {
    const ctx = mkCtx(); const e = await rejects(lookup({ label: 'ZZ9-0001' }, ctx));
    expect(isLimsError(e) && e.code).toBe('common.not_found'); expect(calls.access).toEqual([]);
    expect(JSON.stringify(e)).not.toContain('ZZ9-0001'); expect(calls.logs.join('\n')).not.toContain('ZZ9-0001');
  });
  it('label of ANOTHER tenant → identical 404 (repository is tenant-bound; never "found but forbidden")', async () => {
    S.objects.set('B26-0001', { tenant_id: '01a1a98a-ac40-7000-8000-00000000b001', centre_id: CENTRE, object_kind: 'case', case_id: uid(190) });
    const ctx = mkCtx(); const e = await rejects(lookup({ label: 'B26-0001' }, ctx));
    expect(isLimsError(e) && e.code).toBe('common.not_found'); expect(S.lookupCalls[0]!.tenantId).toBe(T); expect(calls.access).toEqual([]);
  });
  it.each([['empty', ''], ['lowercase', 's26-0042'], ['space', 'S26 0042'], ['33 chars', 'A'.repeat(33)], ['wildcard', 'S26-%'], ['sql', "S26-0042' OR '1'='1"], ['unicode', 'S26-００４２'], ['number', 42], ['null', null], ['array', ['S26-0042']]])(
    'label %s → 400 common.validation_failed before any repository read', async (_n, label) => {
      const e = await rejects(lookup({ label } as Row));
      expect(isLimsError(e) && e.code).toBe('common.validation_failed'); expect(S.lookupCalls).toEqual([]);
    });
  it('missing label, unknown extra field (AB-5), non-object body → 400, no read', async () => {
    for (const body of [{}, { label: ACC, case_id: uid(101) }, { label: ACC, tenant_id: T }, 'S26-0042' as any, null as any]) {
      const e = await rejects(lookup(body)); expect(isLimsError(e) && e.code).toBe('common.validation_failed');
    }
    expect(S.lookupCalls).toEqual([]);
  });
  it('32-char label (maximum) is accepted', async () => {
    const l = 'A'.repeat(32); obj(l, { object_kind: 'case', case_id: uid(101) });
    expect((await lookup({ label: l })).status).toBe(200);
  });
  it('lookup is read-only: no writes', async () => { obj(ACC, { object_kind: 'case', case_id: uid(101) }); await lookup({ label: ACC }); expect(S.writes).toBe(0); });
});

// ======================================================================================================= contract: wiring
describe('contract — operationIds are really implemented (not stubs)', () => {
  it('A1–A3 handlers exist in the manifest and are not the 501 / common.internal stub', async () => {
    S.pageRows = [];
    expect((await list()).status).toBe(200);
    const e = await rejects(lookup({ label: 'ZZ9-0001' })); expect(isLimsError(e) && e.code).toBe('common.not_found');
    const e2 = await rejects(detail(uid(777))); expect(isLimsError(e2) && e2.code).toBe('common.not_found');
  });
});
