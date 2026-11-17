// C11.T-05 — intake service (consumer logic of lab.specimen.status_changed.v1).
// Spec: 02-TRD §4.1 (+4.1.1/4.1.2), §4.2 numbering, §8 metrics (`lims_anatomic_consumer_ignored_total{reason}`), 01-PRD AC-01.1…01.10, 03-IC §3.7 (example payload),
//       05-SCHEMA (cases__open_case__p_uq, case_items__tenant_id_order_item_id__uq, specimen_links__case__ck, parts letter uq), 07-SECURITY (tenant from the envelope, forged/duplicate/stale → no-op path).
// Drives the REAL intake service (+ the real numbering service of T-06) on IN-MEMORY repositories (vi.mock of the T-04 repository signatures).
// The worker wrapper (core/consumer.ts) already does the event_inbox insert + envelope validation; the service must NOT touch the inbox and must run no raw SQL (ctx.tx.query throws here).
//
// SEAMS (spec fixes behaviour, not file/function names beyond the plan row; chosen here, writer follows):
//   ../service/intake.service.ts   export async function onSpecimenStatusChanged(ctx, env): Promise<void>      (TRD §4.1 name; env = full envelope, payload per 03-IC §3.7)
//   ctx = worker JobContext (core/manifest.ts) + { ports:{FrontdeskPort,CatalogPort,IdentityPort}, metrics?:{inc(name, labels)}, core:{branch} }:
//        ctx.now() returns an ISO STRING (JobContext), NOT a Date — numbering.service (T-06) takes a Date, so the writer converts.  ctx.actor = { type:'system', id } = created_by/updated_by/accessioned_by.
//   Repositories (all `fn(tx, input-object)`, T-04 names):
//     cases.repo: insertCase (returns undefined on open-case conflict = `INSERT … ON CONFLICT (open-case index) DO NOTHING RETURNING *`; T-04 file, same chunk — writer adds it), getCase({forUpdate}),
//                 listCasesByOrder, updateCase, insertCaseItem (undefined on (tenant,order_item_id) conflict = ON CONFLICT DO NOTHING), listCaseItems
//     parts.repo: insertPart/listParts/updatePart      specimenLinks.repo: insertSpecimenLink/updateSpecimenLink/getSpecimenLinkBySpecimen
//     config.repo: getSettings({tenantId}); profile by catalog test: getTestProfileByTestId({tenantId,testId}) (NEW seam) OR listTestProfiles({tenantId}) — the mock serves both.
//     counters.repo bumpAccessionCounter (through numbering.service).
//   Concurrency model of the mock = Postgres: getCase({forUpdate:true}) takes a row lock held until the tx ends; insertCase takes it implicitly; parts (case_id, letter) is unique, so an
//   implementation that does not serialise on the case row loses the race with a 23505 and fails here.
// Fails now: ../service/intake.service.js does not exist.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const S = vi.hoisted(() => {
  const pgErr = (code: string, constraint: string) => Object.assign(new Error(`pg ${code} ${constraint}`), { code, constraint });
  const st: any = {
    cases: new Map<string, Row>(), parts: new Map<string, Row>(), links: new Map<string, Row>(), items: new Map<string, Row>(), transitions: [] as Row[],
    profiles: [] as Row[], settings: undefined as Row | undefined, numbering: undefined as Row | undefined, counters: new Map<string, number>(), bumps: 0,
    locks: new Map<string, { owner: number; q: Array<() => void> }>(), barrierN: 0, barrierWait: [] as Array<() => void>, writes: [] as string[], pgErr,
  };
  const CLOSED = ['signed_out', 'cancelled'];
  st.isOpen = (c: Row) => !CLOSED.includes(c['status']);
  st.acquire = async (tx: { id: number }, key: string): Promise<void> => {
    const l = st.locks.get(key);
    if (!l || l.owner === tx.id) { st.locks.set(key, { owner: tx.id, q: l?.q ?? [] }); return; }
    await new Promise<void>((r) => l.q.push(r));
    return st.acquire(tx, key);
  };
  st.release = (txId: number) => {
    for (const [k, l] of [...st.locks]) if (l.owner === txId) { st.locks.delete(k); l.q.forEach((r) => r()); }
  };
  st.barrier = async () => {                                   // race test: both txs must have READ the order's cases before either inserts
    if (st.barrierN <= 0) return;
    st.barrierN--;
    if (st.barrierN === 0) { st.barrierWait.forEach((r: () => void) => r()); st.barrierWait = []; return; }
    await new Promise<void>((r) => st.barrierWait.push(r));
  };
  st.checkCase = (r: Row) => {
    if ((r['accession_no'] == null) !== (r['status'] === 'received') && r['status'] !== 'cancelled') throw pgErr('23514', 'cases__accession__ck');
  };
  st.checkLink = (r: Row) => {
    if (!['part', 'addon', 'aliquot_ignored', 'not_anatomic'].includes(r['link_kind'])) throw pgErr('23514', 'specimen_links__kind__ck');
    const hasCase = r['case_id'] != null, hasPart = r['part_id'] != null;
    if ((r['link_kind'] === 'part' || r['link_kind'] === 'addon') !== hasCase || (r['link_kind'] === 'part') !== hasPart) throw pgErr('23514', 'specimen_links__case__ck');
    if (!(r['last_seq'] >= 1) || !r['last_status']) throw pgErr('23514', 'specimen_links__seq__ck');
  };
  return st;
});

vi.mock('../repository/cases.repo.js', () => ({
  async insertCase(tx: any, row: Row) {
    S.writes.push('insertCase');
    S.checkCase({ status: 'received', accession_no: null, ...row });
    if ([...S.cases.values()].some((c: Row) => c['tenant_id'] === row['tenant_id'] && c['order_id'] === row['order_id'] && c['case_kind'] === row['case_kind'] && S.isOpen(c))) return undefined; // ON CONFLICT DO NOTHING
    const r = { version: 1, status: 'received', priority: 'routine', profile_missing: false, accession_no: null, ...row };
    S.cases.set(r['id'], r);
    await S.acquire(tx, r['id']);                                // the inserting tx holds the row until it ends
    return { ...r };
  },
  async getCase(tx: any, i: { tenantId: string; caseId: string; forUpdate?: boolean }) {
    if (i.forUpdate) await S.acquire(tx, i.caseId);
    const r = S.cases.get(i.caseId);
    return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined;
  },
  async listCases(_tx: unknown, i: { tenantId: string }) { return [...S.cases.values()].filter((c: Row) => c['tenant_id'] === i.tenantId).map((c: Row) => ({ ...c })); },
  async listCasesByOrder(_tx: unknown, i: { tenantId: string; orderId: string }) {
    const rows = [...S.cases.values()].filter((c: Row) => c['tenant_id'] === i.tenantId && c['order_id'] === i.orderId).map((c: Row) => ({ ...c }));
    await S.barrier();
    return rows;
  },
  async updateCase(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.writes.push('updateCase');
    const r = S.cases.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId };
    S.checkCase(next);
    S.cases.set(i.id, next);
    return { ...next };
  },
  async insertCaseTransition(_tx: unknown, row: Row) { S.transitions.push({ ...row }); return { ...row }; },
  async getCaseTransition() { return undefined; },
  async listCaseTransitions() { return S.transitions; },
  async insertCaseItem(_tx: unknown, row: Row) {
    S.writes.push('insertCaseItem');
    if ([...S.items.values()].some((x: Row) => x['tenant_id'] === row['tenant_id'] && x['order_item_id'] === row['order_item_id'])) return undefined; // ON CONFLICT DO NOTHING
    const r = { version: 1, role: 'primary', is_active: true, lab_approved_version_no: 0, ...row };
    S.items.set(r['id'], r);
    return { ...r };
  },
  async getCaseItem() { return undefined; },
  async listCaseItems(_tx: unknown, i: { tenantId: string; caseId: string }) { return [...S.items.values()].filter((x: Row) => x['tenant_id'] === i.tenantId && x['case_id'] === i.caseId).map((x: Row) => ({ ...x })); },
  async updateCaseItem() { return undefined; },
}));
vi.mock('../repository/parts.repo.js', () => ({
  async insertPart(_tx: unknown, row: Row) {
    S.writes.push('insertPart');
    if ([...S.parts.values()].some((p: Row) => p['tenant_id'] === row['tenant_id'] && p['case_id'] === row['case_id'] && p['letter'] === row['letter'])) throw S.pgErr('23505', 'parts__tenant_id_case_letter__uq');
    const r = { version: 1, specimen_state: 'none', ...row };
    S.parts.set(r['id'], r);
    return { ...r };
  },
  async getPart(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.parts.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async listParts(_tx: unknown, i: { tenantId: string; caseId: string }) {
    return [...S.parts.values()].filter((p: Row) => p['tenant_id'] === i.tenantId && p['case_id'] === i.caseId).sort((a: Row, b: Row) => a['letter_seq'] - b['letter_seq']).map((p: Row) => ({ ...p }));
  },
  async updatePart(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.writes.push('updatePart');
    const r = S.parts.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId };
    S.parts.set(i.id, next);
    return { ...next };
  },
}));
vi.mock('../repository/specimenLinks.repo.js', () => ({
  async insertSpecimenLink(_tx: unknown, row: Row) {
    S.writes.push('insertSpecimenLink');
    S.checkLink(row);                                            // link_kind has no default: undefined → CHECK violation
    if ([...S.links.values()].some((l: Row) => l['tenant_id'] === row['tenant_id'] && l['specimen_id'] === row['specimen_id'])) throw S.pgErr('23505', 'specimen_links__tenant_id_specimen_id__uq');
    const r = { version: 1, case_id: null, part_id: null, ...row };
    S.links.set(r['id'], r);
    return { ...r };
  },
  async getSpecimenLink(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.links.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async listSpecimenLinks(_tx: unknown, i: { tenantId: string; caseId: string }) { return [...S.links.values()].filter((l: Row) => l['tenant_id'] === i.tenantId && l['case_id'] === i.caseId).map((l: Row) => ({ ...l })); },
  async getSpecimenLinkBySpecimen(_tx: unknown, i: { tenantId: string; specimenId: string }) {
    const r = [...S.links.values()].find((l: Row) => l['tenant_id'] === i.tenantId && l['specimen_id'] === i.specimenId);
    return r ? { ...r } : undefined;
  },
  async updateSpecimenLink(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.writes.push('updateSpecimenLink');
    if (!('link_kind' in i.patch) || i.patch['link_kind'] === undefined) throw new Error('link_kind must be written explicitly on every specimen_links upsert (02-TRD §4.1)');
    const r = S.links.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId };
    S.checkLink(next);
    S.links.set(i.id, next);
    return { ...next };
  },
}));
vi.mock('../repository/config.repo.js', () => ({
  async getSettings(_tx: unknown, i: { tenantId: string }) { return S.settings && S.settings['tenant_id'] === i.tenantId ? { ...S.settings } : undefined; },
  async getTestProfileByTestId(_tx: unknown, i: { tenantId: string; testId: string }) { const r = S.profiles.find((p: Row) => p['tenant_id'] === i.tenantId && p['test_id'] === i.testId); return r ? { ...r } : undefined; },
  async listTestProfiles(_tx: unknown, i: { tenantId: string }) { return S.profiles.filter((p: Row) => p['tenant_id'] === i.tenantId).map((p: Row) => ({ ...p })); },
  async getTestProfile(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.profiles.find((p: Row) => p['tenant_id'] === i.tenantId && p['id'] === i.id); return r ? { ...r } : undefined; },
}));
vi.mock('../repository/counters.repo.js', () => ({
  async bumpAccessionCounter(_tx: unknown, k: { tenantId: string; seriesKey: string; yearAd: number }) {
    S.bumps++;
    await Promise.resolve();
    const key = `${k.tenantId}|${k.seriesKey}|${k.yearAd}`;
    const v = (S.counters.get(key) ?? 0) + 1;
    S.counters.set(key, v);
    return v;
  },
  async getAccessionCounter() { return undefined; },
}));

const { onSpecimenStatusChanged } = await import('../service/intake.service.js');

// ------------------------------------------------------------------ fixtures (synthetic ids; 03-IC §3.7 example ids for the contract case)
const id = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT = id(0x1), OTHER_TENANT = id(0x2), ACTOR = id(0xa0), CENTRE = id(0x20002), BRANCH = id(0x10001), PATIENT = id(0x40001), ORDER = id(0x50001);
const SPEC1 = id(0x90001), SPEC2 = id(0x90002), SPEC3 = id(0x90003);
const IT1 = id(0x60001), IT2 = id(0x60002), IT3 = id(0x60003);
const T_HISTO = id(0x7001), T_CYTO = id(0x7002), T_IHC = id(0x7003), T_PCR = id(0x7004), T_CBC = id(0x7005), T_NARR = id(0x7006), T_NOPROF = id(0x7007), T_NOPROF_MOL = id(0x7008);
const WORKFLOW: Record<string, string> = { [T_HISTO]: 'anatomic', [T_CYTO]: 'anatomic', [T_IHC]: 'anatomic', [T_PCR]: 'molecular', [T_CBC]: 'standard', [T_NARR]: 'narrative', [T_NOPROF]: 'anatomic', [T_NOPROF_MOL]: 'molecular' };
const NOW = '2026-11-05T03:21:00.000Z';                              // Asia/Kathmandu 2026-11-05 → default pattern {prefix}{yy}-{seq:4} = S26-0001
const CHANGED = '2026-11-05T03:20:41.300Z';
const notFound = () => Object.assign(new Error('not found'), { code: 'common.not_found' });

const W = { order: undefined as any, calls: { order: [] as any[], test: [] as any[] }, metrics: [] as Array<[string, Record<string, string> | undefined]> };
const item = (orderItemId: string, testId: string, over: Row = {}) => ({ orderItemId, orderableId: id(0x8000 + parseInt(orderItemId.slice(-2), 16)), orderableKind: 'test', testIds: [testId], priority: 'routine', status: 'active', outsourced: false, ...over });
const setOrder = (items: any[], over: Row = {}) => { W.order = { orderId: ORDER, patientId: PATIENT, centreId: CENTRE, branchId: BRANCH, priority: 'routine', status: 'registered', items, ...over }; };

let txSeq = 0, evSeq = 0;
function ports() {
  return {
    FrontdeskPort: { async getOrderSummary(_c: unknown, i: { orderId: string }) { W.calls.order.push(i); if (!W.order || i.orderId !== W.order.orderId) throw notFound(); return structuredClone(W.order); } },
    CatalogPort: {
      async getTest(_c: unknown, i: { testId: string }) {
        W.calls.test.push(i);
        const wf = WORKFLOW[i.testId]; if (!wf) throw notFound();
        return { id: i.testId, code: `SYN-${i.testId.slice(-4)}`, name: 'Synthetic test', workflowType: wf, specimenTypeCodes: ['TISSUE_BX'], isActive: true, revision: 1 };
      },
    },
    IdentityPort: { async getTenantSettings() { return { timezone: 'Asia/Kathmandu', ...(S.numbering ? { numbering: S.numbering } : {}) }; }, async assertRole() { return undefined; } },
  };
}
const logger = () => { const l: any = { debug() {}, info() {}, warn() {}, error() {} }; l.child = () => l; return l; };
function makeCtx(tenantId = TENANT) {
  const tx = { id: ++txSeq, query: async () => { throw new Error('raw SQL in intake.service — use the repositories (02-TRD §3.1); the inbox row belongs to the worker wrapper'); } };
  const ctx: any = {
    tenantId, actor: { type: 'system', id: ACTOR }, requestId: id(0xf1), tx, db: { tx: (fn: any) => fn(ctx) }, log: logger(),
    metrics: { inc: (n: string, l?: Record<string, string>) => { W.metrics.push([n, l]); } },
    now: () => NOW, isNewer: (last: number | undefined, seq: number) => last === undefined || seq > last, attempt: 1, maxAttempts: 10, jobId: '1',
    core: { async branch() { return { branchCode: 'KTM' }; } }, ports: ports(),
  };
  return { ctx, tx };
}
function env(p: Row = {}, seq = 1, over: Row = {}): any {
  const payload = { specimen_id: SPEC1, order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, processing_branch_id: BRANCH, specimen_type_code: 'TISSUE_BX', from_status: 'in_transit', to_status: 'received', changed_at: CHANGED, order_item_ids: [IT1], ...p };
  const sid = payload.specimen_id as string;
  return { event_id: id(0xe0000 + ++evSeq), event_type: 'lab.specimen.status_changed.v1', tenant_id: TENANT, occurred_at: CHANGED, actor: { type: 'user', id: id(0xa1) }, idempotency_key: `${sid}:${payload.to_status}:${seq}`,
    producer: 'lab', aggregate: { type: 'specimen', id: sid, seq }, request_id: id(0xf2), payload, ...over };
}
async function run(e: any, tenantId = TENANT) {
  const { ctx, tx } = makeCtx(tenantId);
  try { return await onSpecimenStatusChanged(ctx, e); } finally { S.release(tx.id); }
}
const cases = (): Row[] => [...S.cases.values()];
const parts = (caseId?: string): Row[] => [...S.parts.values()].filter((p: Row) => !caseId || p['case_id'] === caseId).sort((a: Row, b: Row) => a['letter_seq'] - b['letter_seq']);
const links = (): Row[] => [...S.links.values()];
const linkOf = (specimen: string) => links().find((l) => l['specimen_id'] === specimen);
const caseItems = (): Row[] => [...S.items.values()];
const ignored = (reason: string) => W.metrics.filter(([n, l]) => n === 'lims_anatomic_consumer_ignored_total' && l?.['reason'] === reason).length;
const rowsAll = () => [...cases(), ...parts(), ...links(), ...caseItems()];

const profile = (testId: string, case_kind: string, over: Row = {}) => S.profiles.push({ id: id(0x9000 + S.profiles.length), tenant_id: TENANT, test_id: testId, case_kind, is_addon: false, requires_gross: true, is_active: true, version: 1, ...over });
function seedCase(over: Row = {}): Row {
  const r = { id: id(0xc0000 + S.cases.size + 1), tenant_id: TENANT, centre_id: CENTRE, branch_id: BRANCH, order_id: ORDER, patient_id: PATIENT, case_kind: 'histology', status: 'received', priority: 'routine', accession_no: null, profile_missing: false, received_at: CHANGED, version: 1, ...over };
  S.cases.set(r['id'], r); return r;
}
function seedPart(caseId: string, letter: string, over: Row = {}): Row {
  const r = { id: id(0xd0000 + S.parts.size + 1), tenant_id: TENANT, centre_id: CENTRE, case_id: caseId, letter, letter_seq: letter.charCodeAt(0) - 64, specimen_id: null, specimen_state: 'none', version: 1, ...over };
  S.parts.set(r['id'], r); return r;
}
function seedLink(specimen: string, kind: string, over: Row = {}): Row {
  const r = { id: id(0xb0000 + S.links.size + 1), tenant_id: TENANT, centre_id: CENTRE, specimen_id: specimen, case_id: null, part_id: null, link_kind: kind, last_seq: 1, last_status: 'received', version: 1, ...over };
  S.links.set(r['id'], r); return r;
}
function seedItem(caseId: string, orderItemId: string, testId: string, role = 'primary'): Row {
  const r = { id: id(0xf0000 + S.items.size + 1), tenant_id: TENANT, centre_id: CENTRE, case_id: caseId, order_item_id: orderItemId, test_id: testId, role, version: 1, is_active: true, lab_approved_version_no: 0 };
  S.items.set(r['id'], r); return r;
}

beforeEach(() => {
  for (const m of [S.cases, S.parts, S.links, S.items, S.counters, S.locks]) m.clear();
  S.transitions.length = 0; S.writes.length = 0; S.profiles.length = 0; S.bumps = 0; S.barrierN = 0; S.barrierWait = [];
  S.settings = { id: id(0x5e7), tenant_id: TENANT, auto_accession_on_receipt: false, version: 1 };
  S.numbering = undefined;
  W.calls.order.length = 0; W.calls.test.length = 0; W.metrics.length = 0;
  profile(T_HISTO, 'histology'); profile(T_CYTO, 'cytology'); profile(T_IHC, 'histology', { is_addon: true }); profile(T_PCR, 'molecular');
  setOrder([item(IT1, T_HISTO)]);
});

// ------------------------------------------------------------------ AC-01.1 + 03-IC §3.7 example
describe('received → case + part + case_items (AC-01.1, contract example)', () => {
  it('03-IC §3.7 example payload (spec ids, no optional fields): one case `received`, no accession_no, part A linked to the specimen, one case_items row, explicit link_kind', async () => {
    const e = env({ specimen_id: SPEC1, specimen_type_code: 'EDTA_WB', from_status: 'in_transit', to_status: 'received', changed_at: '2026-11-05T03:20:41.300Z', order_item_ids: [IT1] }, 1);
    delete e.payload.parent_specimen_id; delete e.payload.replaces_specimen_id;
    await run(e);
    expect(cases()).toHaveLength(1);
    const c = cases()[0]!;
    expect(c).toMatchObject({ tenant_id: TENANT, centre_id: CENTRE, branch_id: BRANCH, order_id: ORDER, patient_id: PATIENT, case_kind: 'histology', status: 'received', priority: 'routine', profile_missing: false, created_by: ACTOR, updated_by: ACTOR });
    expect(c['accession_no'] ?? null).toBeNull();
    expect(c['received_at']).toBeTruthy();
    expect(parts()).toHaveLength(1);
    expect(parts()[0]).toMatchObject({ tenant_id: TENANT, centre_id: CENTRE, case_id: c['id'], letter: 'A', letter_seq: 1, specimen_id: SPEC1, specimen_type_code: 'EDTA_WB' });
    expect(parts()[0]!['specimen_state']).toBe('received');
    expect(caseItems()).toHaveLength(1);
    expect(caseItems()[0]).toMatchObject({ tenant_id: TENANT, case_id: c['id'], order_item_id: IT1, test_id: T_HISTO, role: 'primary', centre_id: CENTRE });
    expect(linkOf(SPEC1)).toMatchObject({ tenant_id: TENANT, centre_id: CENTRE, link_kind: 'part', case_id: c['id'], part_id: parts()[0]!['id'], last_seq: 1, last_status: 'received' });
    expect(links()).toHaveLength(1);
    expect(S.bumps).toBe(0);                                         // auto_accession_on_receipt = false → no number
  });

  it('priority = max over the case items (urgent wins)', async () => {
    setOrder([item(IT1, T_HISTO), item(IT2, T_HISTO, { priority: 'urgent' })]);
    await run(env({ order_item_ids: [IT1, IT2] }));
    expect(cases()[0]!['priority']).toBe('urgent');
    expect(caseItems()).toHaveLength(2);
  });

  it('order_item_ids absent → every ACTIVE anatomic item of the order; cancelled/other-department items are not linked', async () => {
    setOrder([item(IT1, T_HISTO), item(IT2, T_CBC), item(IT3, T_HISTO, { status: 'cancelled' })]);
    const e = env({}); delete e.payload.order_item_ids;
    await run(e);
    expect(caseItems().map((x) => x['order_item_id'])).toEqual([IT1]);
  });

  it('order_item_ids restricts the items; ids that are not on the order are ignored (cannot inject a foreign order item)', async () => {
    setOrder([item(IT1, T_HISTO), item(IT2, T_HISTO)]);
    await run(env({ order_item_ids: [IT2, id(0xdead)] }));
    expect(caseItems().map((x) => x['order_item_id'])).toEqual([IT2]);
  });
});

// ------------------------------------------------------------------ AC-01.2 (service level; event_id dedupe is the wrapper's, see the worker contract test)
describe('replay / stale (AC-01.2, AC-01.5)', () => {
  it('the same event applied twice (same aggregate.seq) writes nothing the second time', async () => {
    const e = env({}, 3);
    await run(e);
    const snap = JSON.stringify([cases(), parts(), links(), caseItems()]);
    S.writes.length = 0; W.calls.order.length = 0;
    await run(structuredClone(e));
    expect(JSON.stringify([cases(), parts(), links(), caseItems()])).toBe(snap);
    expect(S.writes).toEqual([]);
    expect(W.calls.order).toEqual([]);                               // stale check happens before any port call
    expect(ignored('stale')).toBe(1);
  });

  it('seq lower than or equal to the last applied seq is ignored; a higher seq is applied', async () => {
    const c = seedCase(); const p = seedPart(c['id'], 'A', { specimen_id: SPEC1, specimen_state: 'received' });
    seedLink(SPEC1, 'part', { case_id: c['id'], part_id: p['id'], last_seq: 5, last_status: 'received' });
    await run(env({ from_status: 'received', to_status: 'rejected' }, 4));
    await run(env({ from_status: 'received', to_status: 'rejected' }, 5));
    expect(ignored('stale')).toBe(2);
    expect([...S.parts.values()][0]!['specimen_state']).toBe('received');
    expect(linkOf(SPEC1)).toMatchObject({ last_seq: 5, last_status: 'received', version: 1 });
    await run(env({ from_status: 'received', to_status: 'rejected' }, 6));
    expect([...S.parts.values()][0]!['specimen_state']).toBe('rejected');
    expect(linkOf(SPEC1)).toMatchObject({ last_seq: 6, last_status: 'rejected', link_kind: 'part' });
  });

  it('out of order before `received`: `rejected` seq 3 first, then a stale `received` seq 2 → no case is ever created', async () => {
    await run(env({ from_status: 'in_transit', to_status: 'rejected' }, 3));
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'not_anatomic', last_seq: 3, last_status: 'rejected' });
    await run(env({ to_status: 'received' }, 2));
    expect(cases()).toEqual([]); expect(parts()).toEqual([]); expect(caseItems()).toEqual([]);
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'not_anatomic', last_seq: 3, last_status: 'rejected' });
    expect(ignored('stale')).toBe(1);
  });
});

// ------------------------------------------------------------------ AC-01.3 + open-case rules
describe('second specimen of the same order (AC-01.3)', () => {
  it('joins the open case as part B with its own items', async () => {
    setOrder([item(IT1, T_HISTO), item(IT2, T_HISTO)]);
    await run(env({ specimen_id: SPEC1, order_item_ids: [IT1] }));
    await run(env({ specimen_id: SPEC2, order_item_ids: [IT2] }));
    expect(cases()).toHaveLength(1);
    expect(parts().map((p) => [p['letter'], p['specimen_id']])).toEqual([['A', SPEC1], ['B', SPEC2]]);
    expect(parts().every((p) => p['case_id'] === cases()[0]!['id'])).toBe(true);
    expect(caseItems().map((x) => x['order_item_id']).sort()).toEqual([IT1, IT2].sort());
    expect(linkOf(SPEC2)).toMatchObject({ link_kind: 'part', case_id: cases()[0]!['id'], part_id: parts()[1]!['id'] });
  });

  it.each(['received', 'accessioned', 'in_processing', 'ready_for_reporting'])('an open case in status %s is extended', async (status) => {
    const c = seedCase({ status, accession_no: status === 'received' ? null : 'S26-0009' });
    seedPart(c['id'], 'A', { specimen_id: SPEC1, specimen_state: 'received' }); seedLink(SPEC1, 'part', { case_id: c['id'], part_id: [...S.parts.keys()][0] });
    setOrder([item(IT1, T_HISTO), item(IT2, T_HISTO)]);
    await run(env({ specimen_id: SPEC2, order_item_ids: [IT2] }));
    expect(cases()).toHaveLength(1);
    expect(parts(c['id']).map((p) => p['letter'])).toEqual(['A', 'B']);
  });

  it.each(['signed_out', 'cancelled'])('a %s case is NOT reopened: a new case with part A is created', async (status) => {
    const c = seedCase({ status, accession_no: 'S26-0001', ...(status === 'signed_out' ? { signed_out_at: CHANGED, current_version_no: 1 } : { cancelled_at: CHANGED }) });
    setOrder([item(IT1, T_HISTO), item(IT2, T_HISTO)]);
    await run(env({ specimen_id: SPEC2, order_item_ids: [IT2] }));
    expect(cases()).toHaveLength(2);
    const fresh = cases().find((x) => x['id'] !== c['id'])!;
    expect(fresh['status']).toBe('received');
    expect(parts(fresh['id']).map((p) => p['letter'])).toEqual(['A']);
    expect(parts(c['id'])).toEqual([]);
  });

  it('one case per case kind: a cytology specimen of the same order opens its own case', async () => {
    setOrder([item(IT1, T_HISTO), item(IT2, T_CYTO)]);
    await run(env({ specimen_id: SPEC1, order_item_ids: [IT1] }));
    await run(env({ specimen_id: SPEC2, order_item_ids: [IT2] }));
    expect(cases().map((c) => c['case_kind']).sort()).toEqual(['cytology', 'histology']);
  });
});

// ------------------------------------------------------------------ AC-01.4 not anatomic
describe('no anatomic items (AC-01.4)', () => {
  it.each([['standard', T_CBC], ['narrative', T_NARR]])('only %s tests → inbox/link only: one not_anatomic specimen_links row, no case/part/items, metric reason=no_anatomic_items', async (_n, t) => {
    setOrder([item(IT1, t)]);
    await run(env({}, 1));
    expect(cases()).toEqual([]); expect(parts()).toEqual([]); expect(caseItems()).toEqual([]);
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({ tenant_id: TENANT, centre_id: CENTRE, specimen_id: SPEC1, link_kind: 'not_anatomic', last_seq: 1, last_status: 'received' });
    expect(links()[0]!['case_id'] ?? null).toBeNull(); expect(links()[0]!['part_id'] ?? null).toBeNull();
    expect(ignored('no_anatomic_items')).toBe(1);
    expect(S.writes).toEqual(['insertSpecimenLink']);                // nothing else is written
  });

  it('the event names only the non-anatomic item of a mixed order → not_anatomic (the histology item belongs to another specimen)', async () => {
    setOrder([item(IT1, T_HISTO), item(IT2, T_CBC)]);
    await run(env({ order_item_ids: [IT2] }));
    expect(cases()).toEqual([]);
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'not_anatomic' });
    expect(ignored('no_anatomic_items')).toBe(1);
  });

  it('a later `received` with anatomic items converts the not_anatomic row (same specimen, one row) to part', async () => {
    await run(env({ from_status: 'ordered', to_status: 'collected' }, 1));
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'not_anatomic', last_status: 'collected' });
    await run(env({ from_status: 'collected', to_status: 'received' }, 2));
    expect(links()).toHaveLength(1);
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'part', last_seq: 2, last_status: 'received', case_id: cases()[0]!['id'], part_id: parts()[0]!['id'] });
  });
});

// ------------------------------------------------------------------ other statuses: seq bookkeeping only
describe('other statuses (seq bookkeeping only)', () => {
  it('`collected` on an unknown specimen: not_anatomic link with NO case/part (no specimen_links__case__ck violation), no port calls, no domain rows', async () => {
    await run(env({ from_status: 'ordered', to_status: 'collected' }, 1));
    expect(links()).toHaveLength(1);
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'not_anatomic', last_seq: 1, last_status: 'collected' });
    expect(linkOf(SPEC1)!['case_id'] ?? null).toBeNull(); expect(linkOf(SPEC1)!['part_id'] ?? null).toBeNull();
    expect(cases()).toEqual([]); expect(parts()).toEqual([]);
    expect(W.calls.order).toEqual([]); expect(W.calls.test).toEqual([]);
  });

  it('an unknown (x-extensible) status value is accepted as a no-op with a not_anatomic link', async () => {
    await expect(run(env({ to_status: 'quarantined_future_status' }, 1))).resolves.toBeUndefined();
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'not_anatomic', last_status: 'quarantined_future_status' });
  });

  it('a later status of a linked specimen keeps link_kind/case/part, advances last_seq/last_status, changes no domain row, and still writes link_kind explicitly', async () => {
    await run(env({}, 1));
    const before = { c: JSON.stringify(cases()), p: JSON.stringify(parts()) };
    S.writes.length = 0;
    await run(env({ from_status: 'received', to_status: 'resulted' }, 2));
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'part', last_seq: 2, last_status: 'resulted', case_id: cases()[0]!['id'], part_id: parts()[0]!['id'] });
    expect({ c: JSON.stringify(cases()), p: JSON.stringify(parts()) }).toEqual(before);
    expect(S.writes).toEqual(['updateSpecimenLink']);
  });
});

// ------------------------------------------------------------------ AC-01.6 / AC-01.7 case kind + profile_missing
describe('case kind from the profile / workflowType (AC-01.6, AC-01.7)', () => {
  it('molecular test with a molecular profile → case_kind molecular, profile_missing false (AC-01.6)', async () => {
    setOrder([item(IT1, T_PCR)]);
    await run(env({}));
    expect(cases()[0]).toMatchObject({ case_kind: 'molecular', profile_missing: false });
  });

  it('the profile case_kind wins over the workflowType default (cytology profile on an anatomic test)', async () => {
    setOrder([item(IT1, T_CYTO)]);
    await run(env({}));
    expect(cases()[0]).toMatchObject({ case_kind: 'cytology', profile_missing: false });
  });

  it('anatomic test without a profile → histology + profile_missing = true (AC-01.7)', async () => {
    setOrder([item(IT1, T_NOPROF)]);
    await run(env({}));
    expect(cases()).toHaveLength(1);
    expect(cases()[0]).toMatchObject({ case_kind: 'histology', profile_missing: true, status: 'received' });
    expect(caseItems()[0]).toMatchObject({ order_item_id: IT1, test_id: T_NOPROF, role: 'primary' });
  });

  it('molecular test without a profile → molecular + profile_missing = true (AC-01.7)', async () => {
    setOrder([item(IT1, T_NOPROF_MOL)]);
    await run(env({}));
    expect(cases()[0]).toMatchObject({ case_kind: 'molecular', profile_missing: true });
  });

  it('one specimen with a histology and a molecular item → two cases, each with part A bound to the specimen; the link points to one of them', async () => {
    setOrder([item(IT1, T_HISTO), item(IT2, T_PCR)]);
    const e = env({}); delete e.payload.order_item_ids;
    await run(e);
    expect(cases().map((c) => c['case_kind']).sort()).toEqual(['histology', 'molecular']);
    expect(parts()).toHaveLength(2);
    expect(parts().every((p) => p['letter'] === 'A' && p['specimen_id'] === SPEC1)).toBe(true);
    expect(links()).toHaveLength(1);
    const l = linkOf(SPEC1)!;
    expect(l['link_kind']).toBe('part');
    expect(parts().find((p) => p['id'] === l['part_id'])!['case_id']).toBe(l['case_id']);
  });
});

// ------------------------------------------------------------------ AC-01.8 auto accession
describe('auto accession (AC-01.8) — calls numbering.service in the same transaction', () => {
  it('auto_accession_on_receipt = true → case is `accessioned` with S26-0001 in the same event; one counter bump', async () => {
    S.settings = { ...S.settings, auto_accession_on_receipt: true };
    await run(env({}));
    expect(cases()[0]).toMatchObject({ status: 'accessioned', accession_no: 'S26-0001', accessioned_by: ACTOR });
    expect(cases()[0]!['accessioned_at']).toBeTruthy();
    expect(S.bumps).toBe(1);
  });

  it('a second specimen joining an already accessioned case does NOT allocate another number', async () => {
    S.settings = { ...S.settings, auto_accession_on_receipt: true };
    setOrder([item(IT1, T_HISTO), item(IT2, T_HISTO)]);
    await run(env({ specimen_id: SPEC1, order_item_ids: [IT1] }));
    await run(env({ specimen_id: SPEC2, order_item_ids: [IT2] }));
    expect(S.bumps).toBe(1);
    expect(cases()).toHaveLength(1);
    expect(cases()[0]).toMatchObject({ status: 'accessioned', accession_no: 'S26-0001' });
    expect(parts().map((p) => p['letter'])).toEqual(['A', 'B']);
  });

  it('two case kinds from one event are numbered per series (S… histology, M… molecular)', async () => {
    S.settings = { ...S.settings, auto_accession_on_receipt: true };
    setOrder([item(IT1, T_HISTO), item(IT2, T_PCR)]);
    const e = env({}); delete e.payload.order_item_ids;
    await run(e);
    expect(cases().map((c) => c['accession_no']).sort()).toEqual(['M26-0001', 'S26-0001']);
  });

  it('numbering failure (invalid tenant pattern) fails the job so the transaction rolls back and the worker retries', async () => {
    S.settings = { ...S.settings, auto_accession_on_receipt: true };
    S.numbering = { accessionNoPattern: '{nope}' };
    await expect(run(env({}))).rejects.toMatchObject({ code: expect.stringMatching(/accession_pattern_invalid|internal/) });
  });
});

// ------------------------------------------------------------------ AC-01.9 rejected / AC-01.10 recollection
describe('rejected + recollection (AC-01.9, AC-01.10)', () => {
  it('rejected for a specimen linked to a part → part.specimen_state = rejected, link stays `part`, no new case/part', async () => {
    await run(env({}, 1));
    await run(env({ from_status: 'received', to_status: 'rejected' }, 2));
    expect(parts()).toHaveLength(1); expect(cases()).toHaveLength(1);
    expect(parts()[0]).toMatchObject({ specimen_id: SPEC1, specimen_state: 'rejected' });
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'part', last_seq: 2, last_status: 'rejected' });
    expect(cases()[0]!['status']).toBe('received');                  // case status is not touched by a rejection
  });

  it('rejected for a specimen with no anatomic link → not_anatomic, nothing else', async () => {
    await run(env({ from_status: 'received', to_status: 'rejected' }, 1));
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'not_anatomic', last_status: 'rejected' });
    expect(cases()).toEqual([]); expect(parts()).toEqual([]);
    expect(W.calls.order).toEqual([]);
  });

  it('rejected for an add-on link (no part) changes no part and keeps link_kind addon', async () => {
    const c = seedCase(); const p = seedPart(c['id'], 'A', { specimen_id: SPEC1, specimen_state: 'received' });
    seedLink(SPEC2, 'addon', { case_id: c['id'], last_seq: 1 });
    await run(env({ specimen_id: SPEC2, from_status: 'received', to_status: 'rejected' }, 2));
    expect(linkOf(SPEC2)).toMatchObject({ link_kind: 'addon', last_status: 'rejected', last_seq: 2 });
    expect(S.parts.get(p['id'])!['specimen_state']).toBe('received');
  });

  it('recollected specimen (replaces_specimen_id) → SAME part: part.specimen_id updated, state back to `received`, old link kept as history, no new part, no duplicate case_items', async () => {
    await run(env({ specimen_id: SPEC1 }, 1));
    await run(env({ specimen_id: SPEC1, from_status: 'received', to_status: 'rejected' }, 2));
    const partId = parts()[0]!['id'];
    await run(env({ specimen_id: SPEC2, from_status: undefined, to_status: 'received', replaces_specimen_id: SPEC1, order_item_ids: [IT1] }, 1));
    expect(cases()).toHaveLength(1);
    expect(parts()).toHaveLength(1);
    expect(parts()[0]).toMatchObject({ id: partId, specimen_id: SPEC2, specimen_state: 'received', letter: 'A' });
    expect(caseItems()).toHaveLength(1);
    expect(linkOf(SPEC2)).toMatchObject({ link_kind: 'part', case_id: cases()[0]!['id'], part_id: partId, last_status: 'received' });
    expect(linkOf(SPEC1)).toMatchObject({ link_kind: 'part', part_id: partId, last_status: 'rejected' });   // history kept
    expect(links()).toHaveLength(2);
  });

  it('replaces_specimen_id that has no part in the case → falls back to a new part (no crash, no lost specimen)', async () => {
    await run(env({ specimen_id: SPEC2, to_status: 'received', replaces_specimen_id: SPEC3 }, 1));
    expect(parts()).toHaveLength(1);
    expect(parts()[0]).toMatchObject({ letter: 'A', specimen_id: SPEC2 });
  });
});

// ------------------------------------------------------------------ add-on join + aliquot
describe('add-on items (is_addon) and aliquots (4.1.1)', () => {
  it('add-on received as its own specimen while a case of that kind is open → case_items role addon on the open case, NO part, link kind addon', async () => {
    setOrder([item(IT1, T_HISTO), item(IT2, T_IHC)]);
    await run(env({ specimen_id: SPEC1, order_item_ids: [IT1] }));
    await run(env({ specimen_id: SPEC2, order_item_ids: [IT2] }));
    expect(cases()).toHaveLength(1);
    expect(parts()).toHaveLength(1);
    expect(caseItems().find((x) => x['order_item_id'] === IT2)).toMatchObject({ role: 'addon', case_id: cases()[0]!['id'], test_id: T_IHC });
    const l = linkOf(SPEC2)!;
    expect(l).toMatchObject({ link_kind: 'addon', case_id: cases()[0]!['id'], last_status: 'received' });
    expect(l['part_id'] ?? null).toBeNull();
  });

  it('add-on with NO open case of its kind → a case is created (part A) and the item is role addon', async () => {
    setOrder([item(IT2, T_IHC)]);
    await run(env({ order_item_ids: [IT2] }));
    expect(cases()).toHaveLength(1);
    expect(parts().map((p) => p['letter'])).toEqual(['A']);
    expect(caseItems()[0]).toMatchObject({ order_item_id: IT2, role: 'addon' });
    expect(linkOf(SPEC1)!['link_kind']).toBe('part');
  });

  it('aliquot of a specimen that is already linked → ignored: link aliquot_ignored (no case/part), metric reason=aliquot, no port calls', async () => {
    await run(env({ specimen_id: SPEC1 }, 1));
    const snap = JSON.stringify([cases(), parts(), caseItems()]);
    W.calls.order.length = 0;
    await run(env({ specimen_id: SPEC2, parent_specimen_id: SPEC1, to_status: 'received' }, 1));
    expect(JSON.stringify([cases(), parts(), caseItems()])).toBe(snap);
    expect(linkOf(SPEC2)).toMatchObject({ link_kind: 'aliquot_ignored', last_seq: 1, last_status: 'received' });
    expect(linkOf(SPEC2)!['case_id'] ?? null).toBeNull(); expect(linkOf(SPEC2)!['part_id'] ?? null).toBeNull();
    expect(ignored('aliquot')).toBe(1);
    expect(W.calls.order).toEqual([]);
  });

  it('a child specimen whose parent has no link is processed as a normal specimen', async () => {
    await run(env({ specimen_id: SPEC2, parent_specimen_id: SPEC3 }, 1));
    expect(linkOf(SPEC2)!['link_kind']).toBe('part');
    expect(ignored('aliquot')).toBe(0);
  });
});

// ------------------------------------------------------------------ concurrency
describe('concurrent two-specimen race (two transactions, one order)', () => {
  const race = async (autoAccession: boolean) => {
    S.settings = { ...S.settings, auto_accession_on_receipt: autoAccession };
    setOrder([item(IT1, T_HISTO), item(IT2, T_HISTO)]);
    S.barrierN = 2;                                                  // both txs read “no open case” before either inserts
    await Promise.all([run(env({ specimen_id: SPEC1, order_item_ids: [IT1] }, 1)), run(env({ specimen_id: SPEC2, order_item_ids: [IT2] }, 1))]);
  };

  it('exactly one case (open-case index), parts A and B with distinct letters, both items, two part links', async () => {
    await race(false);
    expect(cases()).toHaveLength(1);
    expect(parts().map((p) => p['letter'])).toEqual(['A', 'B']);
    expect(new Set(parts().map((p) => p['specimen_id']))).toEqual(new Set([SPEC1, SPEC2]));
    expect(caseItems().map((x) => x['order_item_id']).sort()).toEqual([IT1, IT2].sort());
    expect(links().map((l) => l['link_kind'])).toEqual(['part', 'part']);
    expect(links().every((l) => l['case_id'] === cases()[0]!['id'])).toBe(true);
  });

  it('with auto accession: one number only (the loser re-reads the locked case and sees it already accessioned)', async () => {
    await race(true);
    expect(cases()).toHaveLength(1);
    expect(cases()[0]).toMatchObject({ status: 'accessioned', accession_no: 'S26-0001' });
    expect(S.bumps).toBe(1);
    expect(parts().map((p) => p['letter'])).toEqual(['A', 'B']);
  });
});

// ------------------------------------------------------------------ failures, tolerance, tenant
describe('failures, unknown fields, tenant (07-SECURITY)', () => {
  it('port failure (order not visible → common.not_found) throws so the job retries; nothing is written', async () => {
    W.order = undefined;
    await expect(run(env({}))).rejects.toMatchObject({ code: 'common.not_found' });
    expect(rowsAll()).toEqual([]);
  });

  it('catalog failure (unknown test) throws; nothing is written', async () => {
    setOrder([item(IT1, id(0xbad))]);
    await expect(run(env({}))).rejects.toMatchObject({ code: 'common.not_found' });
    expect(rowsAll()).toEqual([]);
  });

  it('unknown payload/envelope fields are tolerated and never persisted', async () => {
    const e = env({ future_field: 'LEAK-SENTINEL-1', nested: { a: 'LEAK-SENTINEL-2' } }, 1, { new_envelope_field: 'LEAK-SENTINEL-3' });
    await expect(run(e)).resolves.toBeUndefined();
    expect(cases()).toHaveLength(1);
    expect(JSON.stringify(rowsAll())).not.toContain('LEAK-SENTINEL');
  });

  it('every row is written for the envelope tenant (RLS second wall) and the system actor', async () => {
    await run(env({}));
    expect(rowsAll().every((r) => r['tenant_id'] === TENANT)).toBe(true);
    expect(rowsAll().every((r) => r['created_by'] === undefined || r['created_by'] === ACTOR)).toBe(true);
  });

  it('envelope tenant ≠ job tenant → rejected, nothing written, no port call (worker tenant comes from the verified envelope)', async () => {
    await expect(run(env({}, 1, { tenant_id: OTHER_TENANT }))).rejects.toBeTruthy();
    expect(rowsAll()).toEqual([]); expect(W.calls.order).toEqual([]);
  });

  it('the service never runs raw SQL and never touches event_inbox (wrapper-owned) — whole happy path passes with a throwing tx.query', async () => {
    await expect(run(env({}))).resolves.toBeUndefined();
  });
});
