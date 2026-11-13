// C11.T-16 — molecular results and batches: Q1 saveAnatomicMolecularResults, Q2 listAnatomicBatches, Q3 createAnatomicBatch, Q4 getAnatomicBatch, Q5 addAnatomicBatchMembers,
// Q6 removeAnatomicBatchMembers, Q7 closeAnatomicBatch, plus the AC-11.6 guard on markAnatomicCaseReady (C4: molecular needs >= 1 molecular result).
// Spec: 02-TRD §5.5 (Q-table), §5.7 (MolecularResult / Batch / BatchDetail), §4.2 ("batch" counter, pattern MB{yy}{seq:4}), §4.5.3 + §7 C4, 05-SCHEMA §6 (molecular_results, batches, batch_members
//       + their unique indexes), 01-PRD AC-11.1…11.6, 07-SECURITY (tenant isolation → 404, per-id not_found for bulk arrays, AB-5 unknown fields, no payload in logs, 08 A17 D-66 (b) signout_locked).
// Drives the REAL handlers (manifest.handlers) on IN-MEMORY repositories (vi.mock of molecular/batches/counters/config/cases/drafts repo with the T-04 signatures); the mocks emulate the DB
// constraints that matter (partial unique indexes on (case,target) and (batch,position)/(batch,case), batches status/closed_at CHECK, If-Match versions). Real RLS + real indexes: integration/molecular.live.test.ts (GATED).
//
// SEAMS (spec fixes behaviour; names chosen here, the writer follows or disputes):
//   * Every handler: load through the tenant-bound repo (404 if invisible) -> IdentityPort.assertRole -> validate -> write. Q2/Q4 = 'anatomic.case.read'; Q1/Q3/Q5/Q6/Q7 = 'anatomic.case.work'.
//     listBatches is called as { tenantId, status?, assayId?, limit, offset } (status omitted for 'open,closed'; assay_code resolved to assayId through config.repo.listAssays); the Q1 save bumps
//     molecular_rev through updateCase FIRST (it is the serialisation point: a lost race is common.version_conflict, never a raw unique violation).
//     Q1 and mark-ready pass centreId = case.centre_id; Q5 asserts once per member case with that case's centre_id (a port error such as not_found passes through unchanged).
//   * Q1 If-Match = case.molecular_rev ("0" is valid: the column starts at 0). Stale/other -> common.version_conflict, absent -> common.precondition_required. Success bumps molecular_rev by 1 through
//     cases.repo.updateCase (expectedVersion = case.version). Full replace: old active rows of the case end up is_active=false (updateMolecularResult), new rows via insertMolecularResult; the partial unique
//     index on (case,target) WHERE is_active is emulated, so the service must deactivate/update BEFORE it inserts a row for the same target.
//   * Validation uses domain/molecular.ts validateMolecularResult against assay + targets + result values loaded through config.repo (listAssays by code, listAssayTargets, listAssayTargetValues);
//     errors -> 400 common.validation_failed with JSON-pointer paths '/results/<i>/<field>' (all rows checked, errors collected). batch_id must be a batch of this tenant (400 at /results/<i>/batch_id).
//   * Q1 on a non-molecular case -> 409 anatomic.case_invalid_transition (CR); signed_out without an open draft (drafts.repo.getOpenDraft) -> 409 anatomic.signout_locked; with an open draft -> allowed.
//   * Q3: batch_no from counters.repo.bumpAccessionCounter({ tenantId, seriesKey:'batch', yearAd, actorId }) rendered MB{yy}{seq:4} (year of ctx.now() in the tenant timezone from
//     IdentityPort.getTenantSettings); validation happens BEFORE the counter is bumped. Response 201 Batch { id, batch_no, assay_code, status:'open', capacity (default 96), member_count, version:1, ... }.
//   * Q2: { data: Batch[], page:{ limit, next_cursor? } } default limit 50, cursor = opaque string over an offset, next_cursor ABSENT on the last page (like T-11 K11), invalid cursor -> common.invalid_cursor.
//     Query status = 'open' | 'closed' | 'open,closed'; assay_code filters through the assay.
//   * Q4/Q5/Q6/Q7 answer BatchDetail { ...Batch, members:[{ case_id, accession_no?, position }] } ordered by position, active members only; status 200.
//   * Q5 (no If-Match): closed batch -> 409 anatomic.batch_closed BEFORE anything else is written; a taken position (DB index error 23505 on batch_members__tenant_id_batch_position__p_uq, or a pre-check, or a
//     duplicate inside the request) -> 409 anatomic.batch_position_taken; the whole request is atomic. Unknown / other-tenant case id -> 404 common.not_found (07-SECURITY "per-id not_found").
//   * Q6/Q7 need If-Match = batch.version. Q6 sets is_active=false + removed_at on the member (frees the position); a case that is not an active member -> 404 common.not_found. Q7 sets status='closed' + closed_at
//     (the CHECK ties them); closing a closed batch -> 409 anatomic.batch_closed.
//   * markAnatomicCaseReady (A10, request { params.case_id, headers If-Match = case.version }): molecular case in_processing with no ACTIVE molecular result -> 409 anatomic.case_invalid_transition,
//     nothing written; with >= 1 -> 200, body.status 'ready_for_reporting', one case_transitions row. Other repos the handler touches are answered empty by the mocks.
// Fails now: Q1–Q7 and markAnatomicCaseReady are 501 / common.internal stubs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError, isLimsError } from '../../../core/errors.js';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  cases: new Map<string, Row>(), assays: new Map<string, Row>(), targets: new Map<string, Row>(), values: new Map<string, Row>(), results: new Map<string, Row>(),
  batches: new Map<string, Row>(), members: new Map<string, Row>(), transitions: [] as Row[], counters: new Map<string, number>(), bumps: [] as Row[], openDrafts: new Set<string>(),
  writes: 0, seq: 0,
}));
const pgErr = (code: string, constraint: string) => Object.assign(new Error('constraint violation'), { code, constraint });
const touch = (write = false) => { if (write) S.writes++; };
const undo = (tx: unknown, f: () => void) => { (tx as { undo?: (() => void)[] } | undefined)?.undo?.push(f); };
const mine = (m: Map<string, Row>, i: Row) => [...m.values()].filter((r) => r['tenant_id'] === i['tenantId']);
const lim = (i: Row) => { const l = Math.trunc(Number(i['limit'] ?? 200)); return Number.isFinite(l) && l >= 1 ? Math.min(l, 500) : 200; };
const off = (i: Row) => { const o = Math.trunc(Number(i['offset'] ?? 0)); return Number.isFinite(o) && o >= 0 ? o : 0; };
const cmp = (a: Row, b: Row, keys: string[]) => { for (const k of keys) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; };
const newId = () => `0190c411-ffff-7000-8000-${String(++S.seq).padStart(12, '0')}`;

const RESULT_COLS = ['result_value_id', 'result_code', 'value_decimal', 'unit_code', 'method_text', 'kit_name', 'kit_lot', 'kit_expiry_on', 'batch_id', 'comment_text', 'is_active'];
const BATCH_COLS = ['status', 'kit_name', 'kit_lot', 'kit_expiry_on', 'instrument_text', 'run_at', 'capacity', 'closed_at'];
const MEMBER_COLS = ['position', 'is_active', 'removed_at'];
const CASE_COLS = ['branch_id', 'status', 'priority', 'accession_no', 'accession_series', 'accession_year', 'clinical_history_text', 'assigned_pathologist_membership_id', 'profile_missing', 'current_version_no',
  'molecular_rev', 'accessioned_at', 'accessioned_by', 'signed_out_at', 'cancelled_at', 'cancel_reason_code', 'cancel_reason_text'];
const optimistic = (m: Map<string, Row>, cols: string[], check?: (next: Row) => void) => async (tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) => {
  touch(true);
  for (const k of Object.keys(i.patch)) if (i.patch[k] !== undefined && !cols.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
  const r = m.get(i.id);
  if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
  const next = { ...r, ...Object.fromEntries(Object.entries(i.patch).filter(([, v]) => v !== undefined)), version: r['version'] + 1, updated_by: i.actorId };
  check?.(next);
  m.set(i.id, next); undo(tx, () => m.set(i.id, r)); return { ...next };
};

vi.mock('../repository/config.repo.js', () => ({
  async getAssay(_tx: unknown, i: Row) { const r = S.assays.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async listAssays(_tx: unknown, i: Row) {
    return mine(S.assays, i).filter((r) => !i['activeOnly'] || r['is_active']).sort((a, b) => cmp(a, b, ['code', 'id'])).slice(off(i), off(i) + lim(i)).map((r) => ({ ...r }));
  },
  async listAssayTargets(_tx: unknown, i: Row) {
    return mine(S.targets, i).filter((r) => r['assay_id'] === i['assayId'] && (!i['activeOnly'] || r['is_active'])).sort((a, b) => cmp(a, b, ['sort_order', 'code', 'id'])).map((r) => ({ ...r }));
  },
  async listAssayTargetValues(_tx: unknown, i: Row) {
    return mine(S.values, i).filter((r) => r['target_id'] === i['targetId'] && (!i['activeOnly'] || r['is_active'])).sort((a, b) => cmp(a, b, ['sort_order', 'code', 'id'])).map((r) => ({ ...r }));
  },
  async getAssayTarget(_tx: unknown, i: Row) { const r = S.targets.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async getAssayTargetValue(_tx: unknown, i: Row) { const r = S.values.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
}));
vi.mock('../repository/cases.repo.js', () => ({
  async getCase(_tx: unknown, i: Row) { const r = S.cases.get(i['caseId']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  updateCase: optimistic(S.cases, CASE_COLS),
  async insertCaseTransition(tx: unknown, row: Row) { touch(true); S.transitions.push({ ...row }); undo(tx, () => { S.transitions.pop(); }); return { ...row }; },
  async listCaseTransitions(_tx: unknown, i: Row) { return S.transitions.filter((t) => t['tenant_id'] === i['tenantId'] && t['case_id'] === i['caseId']); },
  async listCases(_tx: unknown, i: Row) { return mine(S.cases, i); }, async listCasesByOrder() { return []; }, async insertCase() { touch(true); }, async listCaseItems() { return []; },
  async getCaseItem() { return undefined; }, async insertCaseItem() { touch(true); }, async updateCaseItem() { touch(true); }, async getCaseTransition() { return undefined; },
}));
vi.mock('../repository/drafts.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return { ...m, async getOpenDraft(_tx: unknown, i: Row) { return S.openDrafts.has(i['caseId']) ? { id: 'draft', case_id: i['caseId'], tenant_id: i['tenantId'], kind: 'revision', version: 1 } : undefined; } };
});
vi.mock('../repository/molecular.repo.js', () => ({
  async insertMolecularResult(tx: unknown, row: Row) {
    touch(true);
    if (!row['case_id'] || !row['target_id'] || !row['result_value_id'] || !row['assay_id'] || !row['centre_id'] || !row['created_by']) throw pgErr('23502', 'molecular_results__notnull');
    if (row['value_decimal'] != null && !/^-?[0-9]{1,12}(\.[0-9]{1,6})?$/.test(row['value_decimal'])) throw pgErr('23514', 'molecular_results__decimal__ck');
    for (const [k, max] of [['unit_code', 32], ['method_text', 200], ['kit_name', 120], ['kit_lot', 64], ['comment_text', 1000]] as const) if (String(row[k] ?? '').length > max) throw pgErr('23514', 'molecular_results__lens__ck');
    const dup = [...S.results.values()].some((r) => r['tenant_id'] === row['tenant_id'] && r['case_id'] === row['case_id'] && r['target_id'] === row['target_id'] && r['is_active']);
    if (dup) throw pgErr('23505', 'molecular_results__tenant_id_case_target__p_uq');
    const r = { id: newId(), version: 1, is_active: true, created_at: '2026-11-12T01:30:00Z', updated_at: '2026-11-12T01:30:00Z', ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) };
    S.results.set(r['id'], r); undo(tx, () => S.results.delete(r['id'])); return { ...r };
  },
  async getMolecularResult(_tx: unknown, i: Row) { const r = S.results.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async listMolecularResults(_tx: unknown, i: Row) {
    return mine(S.results, i).filter((r) => r['case_id'] === i['caseId'] && (!i['activeOnly'] || r['is_active'])).sort((a, b) => cmp(a, b, ['target_code', 'id'])).map((r) => ({ ...r }));
  },
  updateMolecularResult: optimistic(S.results, RESULT_COLS, (n) => {
    if (n['is_active'] && [...S.results.values()].some((r) => r['id'] !== n['id'] && r['tenant_id'] === n['tenant_id'] && r['case_id'] === n['case_id'] && r['target_id'] === n['target_id'] && r['is_active'])) {
      throw pgErr('23505', 'molecular_results__tenant_id_case_target__p_uq');
    }
  }),
}));
vi.mock('../repository/batches.repo.js', () => ({
  async insertBatch(tx: unknown, row: Row) {
    touch(true);
    if ([...S.batches.values()].some((b) => b['tenant_id'] === row['tenant_id'] && b['batch_no'] === row['batch_no'])) throw pgErr('23505', 'batches__tenant_id_batch_no__uq');
    const cap = row['capacity'] ?? 96;
    if (!(cap >= 1 && cap <= 384)) throw pgErr('23514', 'batches__capacity__ck');
    const b = { id: row['id'] ?? newId(), version: 1, status: 'open', capacity: 96, closed_at: null, created_at: `2026-11-12T01:30:0${S.seq % 10}Z`, updated_at: '2026-11-12T01:30:00Z', ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null)) };
    S.batches.set(b['id'], b); undo(tx, () => S.batches.delete(b['id'])); return { ...b };
  },
  async getBatch(_tx: unknown, i: Row) { const r = S.batches.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async listBatches(_tx: unknown, i: Row) {
    return mine(S.batches, i).filter((b) => (!i['status'] || b['status'] === i['status']) && (!i['assayId'] || b['assay_id'] === i['assayId']))
      .sort((a, b) => (a['created_at'] < b['created_at'] ? 1 : a['created_at'] > b['created_at'] ? -1 : a['id'] < b['id'] ? -1 : 1)).slice(off(i), off(i) + lim(i)).map((b) => ({ ...b }));
  },
  updateBatch: optimistic(S.batches, BATCH_COLS, (n) => { if (!((n['status'] === 'closed') === (n['closed_at'] != null))) throw pgErr('23514', 'batches__status__ck'); }),
  async insertBatchMember(tx: unknown, row: Row) {
    touch(true);
    const act = [...S.members.values()].filter((m) => m['tenant_id'] === row['tenant_id'] && m['batch_id'] === row['batch_id'] && m['is_active']);
    if (act.some((m) => m['position'] === row['position'])) throw pgErr('23505', 'batch_members__tenant_id_batch_position__p_uq');
    if (act.some((m) => m['case_id'] === row['case_id'])) throw pgErr('23505', 'batch_members__tenant_id_batch_case__p_uq');
    const m = { id: newId(), version: 1, is_active: true, removed_at: null, created_at: '2026-11-12T01:30:00Z', updated_at: '2026-11-12T01:30:00Z', ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) };
    S.members.set(m['id'], m); undo(tx, () => S.members.delete(m['id'])); return { ...m };
  },
  async getBatchMember(_tx: unknown, i: Row) { const r = S.members.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async listBatchMembers(_tx: unknown, i: Row) {
    return mine(S.members, i).filter((m) => m['batch_id'] === i['batchId'] && (!i['activeOnly'] || m['is_active'])).sort((a, b) => cmp(a, b, ['position', 'id'])).map((m) => ({ ...m }));
  },
  updateBatchMember: optimistic(S.members, MEMBER_COLS, (n) => { if (n['is_active'] !== (n['removed_at'] == null)) throw pgErr('23514', 'batch_members__active__ck'); }),
}));
vi.mock('../repository/counters.repo.js', () => ({
  async bumpAccessionCounter(tx: unknown, k: Row) {
    touch(true);
    const key = `${k['tenantId']}|${k['seriesKey']}|${k['yearAd']}`; const n = (S.counters.get(key) ?? 0) + 1;
    S.counters.set(key, n); S.bumps.push({ ...k }); undo(tx, () => { S.counters.set(key, n - 1); });
    return n;
  },
  async getAccessionCounter(_tx: unknown, k: Row) { return S.counters.get(`${k['tenantId']}|${k['seriesKey']}|${k['yearAd']}`); },
}));
// repos this task does not own: answer empty so a handler that reads them (e.g. the CaseDetail aggregate of mark-ready) works without extra seams
const emptyRepo = vi.hoisted(() => async (orig: () => Promise<unknown>) => {
  const m = (await orig()) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(m).map((k) => [k, async () => (k.startsWith('list') ? [] : undefined)]));
});
vi.mock('../repository/parts.repo.js', emptyRepo); vi.mock('../repository/slides.repo.js', emptyRepo); vi.mock('../repository/blocks.repo.js', emptyRepo);
vi.mock('../repository/gross.repo.js', emptyRepo); vi.mock('../repository/images.repo.js', emptyRepo); vi.mock('../repository/stainOrders.repo.js', emptyRepo);
vi.mock('../repository/addenda.repo.js', emptyRepo); vi.mock('../repository/versions.repo.js', emptyRepo); vi.mock('../repository/movements.repo.js', emptyRepo);
vi.mock('../repository/specimenLinks.repo.js', emptyRepo); vi.mock('../repository/submissions.repo.js', emptyRepo); vi.mock('../repository/templates.repo.js', emptyRepo);
vi.mock('../repository/codedValues.repo.js', emptyRepo);

const { manifest } = await import('../index.js');

const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '01a1a98a-ac40-7000-8000-00000000a001', T_OTHER = '01a1a98a-ac40-7000-8000-00000000b001', ACTOR = '01a1a98a-ac40-7000-8000-00000000a300';
const C_A1 = '01a1a98a-ac40-7000-8000-00000000a201', C_A2 = '01a1a98a-ac40-7000-8000-00000000a202', C_B1 = '01a1a98a-ac40-7000-8000-00000000b201';
const ASSAY_1 = uid(401), ASSAY_2 = uid(402), ASSAY_OFF = uid(403), ASSAY_OTHER = uid(499);
const TG = { T1: uid(411), T2: uid(412), T1_OFF: uid(413), B1: uid(414) };
const CASE = { MOL: uid(101), MOL2: uid(102), MOL3: uid(103), MOL4: uid(104), HISTO: uid(105), SIGNED: uid(106), OTHER: uid(107), A2: uid(108), NOMOL: uid(109), READY_OK: uid(110) };
const BATCH = { OPEN1: uid(801), CLOSED: uid(802), OPEN2: uid(803), OTHER: uid(899), EMPTY: uid(804) };
const NO_PHI_MARKER = 'SYNTHETIC-MOLECULAR-COMMENT-MARKER';
const FORBIDDEN_KEYS = ['tenant_id', 'centre_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'assay_id', 'target_id', 'result_value_id', 'case_id_internal'];

interface CtxOpts { deny?: Record<string, string>; tenant?: string; denyCentre?: string }
const calls = { assertRole: [] as Row[], logs: [] as string[] };
const mkCtx = (o: CtxOpts = {}) => ({
  operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999),
  log: { info: (x: object) => calls.logs.push(JSON.stringify(x)), warn: (x: object) => calls.logs.push(JSON.stringify(x)), error: (x: object) => calls.logs.push(JSON.stringify(x)) },
  tenantId: o.tenant ?? T, actor: { type: 'user', id: ACTOR, membershipId: uid(5000) }, tx: { undo: [] as (() => void)[], async query() { touch(true); return { rows: [] }; } }, now: () => new Date('2026-11-12T01:30:00Z'),
  core: { async branch() { return { branchCode: 'KTM' }; }, memberships: { async list() { return []; } } },
  ports: {
    IdentityPort: {
      async assertRole(_c: unknown, i: Row) {
        calls.assertRole.push(structuredClone(i));
        const d = o.deny?.[i['permission']]; if (d) throw new LimsError(d);
        if (o.denyCentre && i['centreId'] === o.denyCentre) throw new LimsError('common.not_found');
      },
      async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; },
    },
  },
}) as any;
const NO_WORK = { 'anatomic.case.work': 'auth.forbidden' } as const;

/** emulates requestTx: a throwing handler rolls back every write made through ctx.tx (undo journal kept by the mocks) */
async function call(op: string, req: Row, ctx = mkCtx()): Promise<any> {
  try { return await (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx); } catch (e) {
    for (const u of [...ctx.tx.undo].reverse()) u();
    throw e;
  }
}
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const stored = () => JSON.stringify({ r: [...S.results], b: [...S.batches], m: [...S.members], c: [...S.cases], n: [...S.counters], t: S.transitions });
const validationFailed = (e: any, path?: string) => {
  expect(isLimsError(e, 'common.validation_failed'), `code ${e?.code}`).toBe(true);
  if (path) expect((e as LimsError).errors?.some((f) => f.path === path), `errors[] has ${path}: ${JSON.stringify((e as LimsError).errors)}`).toBe(true);
};
const conflict = (e: any, code: string) => { expect(isLimsError(e, code), `expected ${code}, got ${e?.code}`).toBe(true); expect((e as LimsError).statusCode).toBe(409); };
const hasNoNulls = (x: unknown): boolean => x === null ? false : Array.isArray(x) ? x.every(hasNoNulls) : x && typeof x === 'object' ? Object.values(x).every(hasNoNulls) : true;
const keysDeep = (x: unknown): string[] => Array.isArray(x) ? x.flatMap(keysDeep) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...keysDeep(v)]) : [];
const activeResults = (caseId: string) => [...S.results.values()].filter((r) => r['case_id'] === caseId && r['is_active']);
const activeMembers = (batchId: string) => [...S.members.values()].filter((m) => m['batch_id'] === batchId && m['is_active']).sort((a, b) => a['position'] - b['position']);

const base = (id: string, over: Row = {}): Row => ({ id, tenant_id: T, version: 1, is_active: true, sort_order: 0, created_by: ACTOR, updated_by: ACTOR, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over });
const caseRow = (id: string, over: Row = {}): Row => ({ id, tenant_id: T, centre_id: C_A1, case_kind: 'molecular', status: 'in_processing', version: 7, molecular_rev: 3, accession_no: `SYN-M-${id.slice(-3)}`, ...over });
const batchRow = (id: string, over: Row = {}): Row => base(id, { batch_no: `MB26${id.slice(-3).padStart(4, '0')}`, assay_id: ASSAY_1, status: 'open', capacity: 4, closed_at: null, ...over });
function seed() {
  S.assays.set(ASSAY_1, base(ASSAY_1, { code: 'SYN_PCR_A', display: 'Synthetic PCR A', method_text_default: 'Synthetic method' }));
  S.assays.set(ASSAY_2, base(ASSAY_2, { code: 'SYN_PCR_B', display: 'Synthetic PCR B' }));
  S.assays.set(ASSAY_OFF, base(ASSAY_OFF, { code: 'SYN_PCR_OFF', display: 'Retired assay', is_active: false }));
  S.assays.set(ASSAY_OTHER, base(ASSAY_OTHER, { tenant_id: T_OTHER, code: 'SYN_PCR_X', display: 'Other tenant assay' }));
  S.targets.set(TG.T1, base(TG.T1, { assay_id: ASSAY_1, code: 'T1', display: 'Target 1', allows_quantitative: false, sort_order: 1 }));
  S.targets.set(TG.T2, base(TG.T2, { assay_id: ASSAY_1, code: 'T2', display: 'Target 2', allows_quantitative: true, unit_code: 'copies_per_ml', decimals: 2, sort_order: 2 }));
  S.targets.set(TG.T1_OFF, base(TG.T1_OFF, { assay_id: ASSAY_1, code: 'T3_OFF', display: 'Retired target', sort_order: 3, is_active: false }));
  S.targets.set(TG.B1, base(TG.B1, { assay_id: ASSAY_2, code: 'B1', display: 'Target B1', sort_order: 1 }));
  const val = (n: number, target: string, code: string, display: string, over: Row = {}) => S.values.set(uid(n), base(uid(n), { target_id: target, code, display, is_abnormal: false, ...over }));
  val(421, TG.T1, 'detected', 'Detected', { is_abnormal: true, sort_order: 1 }); val(422, TG.T1, 'not_detected', 'Not detected', { sort_order: 2 }); val(423, TG.T1, 'invalid', 'Invalid', { sort_order: 3 });
  val(424, TG.T1, 'gone', 'Retired value', { sort_order: 4, is_active: false });
  val(425, TG.T2, 'detected', 'Detected', { is_abnormal: true, sort_order: 1 }); val(426, TG.T2, 'not_detected', 'Not detected', { sort_order: 2 });
  val(427, TG.B1, 'detected', 'Detected', { sort_order: 1 });
  for (const id of [CASE.MOL, CASE.MOL2, CASE.MOL3, CASE.MOL4]) S.cases.set(id, caseRow(id));
  S.cases.set(CASE.HISTO, caseRow(CASE.HISTO, { case_kind: 'histology' }));
  S.cases.set(CASE.SIGNED, caseRow(CASE.SIGNED, { status: 'signed_out' }));
  S.cases.set(CASE.OTHER, caseRow(CASE.OTHER, { tenant_id: T_OTHER, centre_id: C_B1 }));
  S.cases.set(CASE.A2, caseRow(CASE.A2, { centre_id: C_A2 }));
  S.cases.set(CASE.NOMOL, caseRow(CASE.NOMOL, { molecular_rev: 0 }));
  S.cases.set(CASE.READY_OK, caseRow(CASE.READY_OK));
  S.batches.set(BATCH.OPEN1, batchRow(BATCH.OPEN1, { created_at: '2026-11-10T00:00:00Z', kit_lot: 'LOT-1' }));
  S.batches.set(BATCH.CLOSED, batchRow(BATCH.CLOSED, { created_at: '2026-11-09T00:00:00Z', status: 'closed', closed_at: '2026-11-09T12:00:00Z' }));
  S.batches.set(BATCH.OPEN2, batchRow(BATCH.OPEN2, { created_at: '2026-11-08T00:00:00Z', assay_id: ASSAY_2, capacity: 96 }));
  S.batches.set(BATCH.EMPTY, batchRow(BATCH.EMPTY, { created_at: '2026-11-07T00:00:00Z', capacity: 96 }));
  S.batches.set(BATCH.OTHER, batchRow(BATCH.OTHER, { tenant_id: T_OTHER, assay_id: ASSAY_OTHER, created_at: '2026-11-10T00:00:00Z' }));
  // a closed batch with one member; an open batch OPEN1 with positions 1 (MOL4) already taken
  const mem = (n: number, batch: string, caseId: string, position: number) => S.members.set(uid(n), base(uid(n), { batch_id: batch, case_id: caseId, position, removed_at: null }));
  mem(901, BATCH.CLOSED, CASE.MOL4, 1);
  mem(902, BATCH.OPEN1, CASE.MOL4, 1);
}
beforeEach(() => {
  for (const m of [S.cases, S.assays, S.targets, S.values, S.results, S.batches, S.members, S.counters]) m.clear();
  S.transitions.length = 0; S.bumps.length = 0; S.openDrafts.clear(); S.writes = 0; S.seq = 0;
  calls.assertRole.length = 0; calls.logs.length = 0;
  seed(); S.writes = 0;
});

const row = (over: Row = {}) => ({ assay_code: 'SYN_PCR_A', target_code: 'T1', result_code: 'detected', ...over });
const put = (results: Row[], caseId = CASE.MOL, rev = 3, ctx = mkCtx()) => call('saveAnatomicMolecularResults', { params: { case_id: caseId }, headers: ifm(rev), body: { results } }, ctx);

describe('Q1 saveAnatomicMolecularResults — validation against the assay definition (AC-11.1, 11.2, 11.3)', () => {
  it('AC-11.1: T1 = detected with method text, kit name, kit lot and kit expiry is stored on the case; molecular_rev 3 → 4; response lists the result with display + abnormal flag', async () => {
    const r = await put([row({ method_text: 'Synthetic real-time PCR', kit_name: 'SynKit', kit_lot: 'LOT-77', kit_expiry_on: '2026-12-31', comment_text: NO_PHI_MARKER })]);
    expect(r.status).toBe(200);
    expect(r.body.molecular_rev).toBe(4);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0]).toMatchObject({ assay_code: 'SYN_PCR_A', assay_display: 'Synthetic PCR A', target_code: 'T1', target_display: 'Target 1', result_code: 'detected', result_display: 'Detected', is_abnormal: true,
      method_text: 'Synthetic real-time PCR', kit_name: 'SynKit', kit_lot: 'LOT-77', comment_text: NO_PHI_MARKER });
    expect(String(r.body.results[0].kit_expiry_on).slice(0, 10)).toBe('2026-12-31');
    expect(typeof r.body.results[0].id).toBe('string');
    const rows = activeResults(CASE.MOL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: T, centre_id: C_A1, case_id: CASE.MOL, assay_id: ASSAY_1, assay_code: 'SYN_PCR_A', target_id: TG.T1, target_code: 'T1', result_value_id: uid(421), result_code: 'detected', created_by: ACTOR });
    expect(S.cases.get(CASE.MOL)!['molecular_rev']).toBe(4);
    expect(keysDeep(r.body).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
    expect(hasNoNulls(r.body)).toBe(true);
  });
  it('If-Match "0" is valid for a case that never had results (molecular_rev starts at 0) and bumps it to 1', async () => {
    const r = await put([row({ result_code: 'not_detected' })], CASE.NOMOL, 0);
    expect(r.body.molecular_rev).toBe(1);
    expect(S.cases.get(CASE.NOMOL)!['molecular_rev']).toBe(1);
  });
  it('AC-11.2: a result code that is not in the target result set → 400 common.validation_failed at /results/0/result_code, nothing stored, rev unchanged', async () => {
    const e = await rejects(put([row({ result_code: 'maybe' })]));
    validationFailed(e, '/results/0/result_code');
    expect(activeResults(CASE.MOL)).toEqual([]); expect(S.cases.get(CASE.MOL)!['molecular_rev']).toBe(3);
  });
  it('a deactivated result value is not accepted (result set = active values only)', async () => {
    validationFailed(await rejects(put([row({ result_code: 'gone' })])), '/results/0/result_code');
  });
  it('unknown assay / unknown target / deactivated target / wrong-assay target are all rejected at their own path', async () => {
    validationFailed(await rejects(put([row({ assay_code: 'SYN_NOPE' })])), '/results/0/assay_code');
    validationFailed(await rejects(put([row({ target_code: 'T9' })])), '/results/0/target_code');
    validationFailed(await rejects(put([row({ target_code: 'T3_OFF', result_code: 'detected' })])), '/results/0/target_code');
    validationFailed(await rejects(put([row({ target_code: 'B1' })])), '/results/0/target_code'); // B1 belongs to SYN_PCR_B
    validationFailed(await rejects(put([row({ assay_code: 'SYN_PCR_OFF' })])), '/results/0/assay_code');
    validationFailed(await rejects(put([row({ assay_code: 'SYN_PCR_X' })])), '/results/0/assay_code'); // another tenant's assay is invisible
    expect(S.writes).toBe(0);
  });
  it('AC-11.3: a quantitative target stores value "1250" with unit copies_per_ml as text decimal', async () => {
    const r = await put([row({ target_code: 'T2', value_decimal: '1250', unit_code: 'copies_per_ml' })]);
    expect(r.body.results[0]).toMatchObject({ target_code: 'T2', value_decimal: '1250', unit_code: 'copies_per_ml' });
    expect(activeResults(CASE.MOL)[0]).toMatchObject({ value_decimal: '1250', unit_code: 'copies_per_ml' });
    expect(typeof activeResults(CASE.MOL)[0]!['value_decimal']).toBe('string');
  });
  it('AC-11.3: a non-decimal value, a value with too many fraction digits (decimals = 2), a numeric JSON number and a wrong unit are rejected', async () => {
    for (const bad of ['12a', '1e5', '', ' 1250', '1250.', '1.234', '-', '1250000000000000']) {
      validationFailed(await rejects(put([row({ target_code: 'T2', value_decimal: bad, unit_code: 'copies_per_ml' })])), '/results/0/value_decimal');
    }
    validationFailed(await rejects(put([row({ target_code: 'T2', value_decimal: 1250 as unknown as string, unit_code: 'copies_per_ml' })])), '/results/0/value_decimal');
    validationFailed(await rejects(put([row({ target_code: 'T2', value_decimal: '1250', unit_code: 'mg_per_dl' })])), '/results/0/unit_code');
    expect(S.writes).toBe(0);
  });
  it('a quantitative value on a target with allows_quantitative = false is rejected', async () => {
    validationFailed(await rejects(put([row({ value_decimal: '5' })])), '/results/0/value_decimal');
  });
  it('all rows are checked and every error is reported (two bad rows → errors for both paths)', async () => {
    const e = await rejects(put([row({ result_code: 'maybe' }), row({ target_code: 'T2', result_code: 'detected' }), row({ target_code: 'T2', result_code: 'zzz' })]));
    validationFailed(e, '/results/0/result_code'); validationFailed(e, '/results/2/result_code');
  });
  it('the same target twice in one request → 400 at the second row (one active result per case and target)', async () => {
    validationFailed(await rejects(put([row(), row({ result_code: 'not_detected' })])), '/results/1/target_code');
    expect(S.writes).toBe(0);
  });
  it('request shape: unknown field (AB-5), missing required field, text over its limit, bad ISO date, > 50 results, results not an array → 400, nothing stored', async () => {
    validationFailed(await rejects(put([{ ...row(), flag: 'x' } as any])));
    validationFailed(await rejects(put([{ assay_code: 'SYN_PCR_A', target_code: 'T1' } as any])), '/results/0/result_code');
    validationFailed(await rejects(put([row({ method_text: 'm'.repeat(201) })])), '/results/0/method_text');
    validationFailed(await rejects(put([row({ kit_name: 'k'.repeat(121) })])), '/results/0/kit_name');
    validationFailed(await rejects(put([row({ kit_lot: 'l'.repeat(65) })])), '/results/0/kit_lot');
    validationFailed(await rejects(put([row({ comment_text: 'c'.repeat(1001) })])), '/results/0/comment_text');
    validationFailed(await rejects(put([row({ kit_expiry_on: '31/12/2026' })])), '/results/0/kit_expiry_on');
    validationFailed(await rejects(put(Array.from({ length: 51 }, () => row()))));
    validationFailed(await rejects(call('saveAnatomicMolecularResults', { params: { case_id: CASE.MOL }, headers: ifm(3), body: { results: 'nope' } })));
    validationFailed(await rejects(call('saveAnatomicMolecularResults', { params: { case_id: CASE.MOL }, headers: ifm(3), body: { results: [row()], extra: 1 } })));
    expect(S.writes).toBe(0);
  });
  it('batch_id must be an open-or-closed batch of this tenant: another tenant\'s batch id → 400 at /results/0/batch_id; own batch → stored and batch_no returned', async () => {
    validationFailed(await rejects(put([row({ batch_id: BATCH.OTHER })])), '/results/0/batch_id');
    const r = await put([row({ batch_id: BATCH.OPEN1 })]);
    expect(r.body.results[0]).toMatchObject({ batch_id: BATCH.OPEN1, batch_no: S.batches.get(BATCH.OPEN1)!['batch_no'] });
  });
});

describe('Q1 — full replace, versions, state, permissions, tenancy', () => {
  it('full replace: a second save without T2 deactivates the old T2 result, replaces T1, and only the new set is active', async () => {
    const first = await put([row(), row({ target_code: 'T2', result_code: 'detected', value_decimal: '10.5', unit_code: 'copies_per_ml' })]);
    expect(first.body.molecular_rev).toBe(4);
    const second = await put([row({ result_code: 'not_detected' })], CASE.MOL, 4);
    expect(second.body.molecular_rev).toBe(5);
    expect(second.body.results.map((x: Row) => [x['target_code'], x['result_code']])).toEqual([['T1', 'not_detected']]);
    expect(activeResults(CASE.MOL).map((x) => x['target_code'])).toEqual(['T1']);
    expect([...S.results.values()].some((x) => x['target_code'] === 'T2' && !x['is_active'])).toBe(true); // history kept, never deleted
    const third = await put([row({ result_code: 'invalid' }), row({ target_code: 'T2', result_code: 'not_detected' })], CASE.MOL, 5);
    expect(third.body.results.map((x: Row) => x['target_code'])).toEqual(['T1', 'T2']); // ordered by target
    expect(third.body.molecular_rev).toBe(6);
  });
  it('If-Match: absent → 428 common.precondition_required; stale or wrong rev → common.version_conflict; neither writes anything', async () => {
    const before = stored();
    const none = await rejects(call('saveAnatomicMolecularResults', { params: { case_id: CASE.MOL }, headers: {}, body: { results: [row()] } }));
    expect(isLimsError(none, 'common.precondition_required')).toBe(true);
    for (const rev of [2, 4, 99]) expect(isLimsError(await rejects(put([row()], CASE.MOL, rev)), 'common.version_conflict'), `rev ${rev}`).toBe(true);
    expect(stored()).toBe(before);
  });
  it('two parallel saves with the same If-Match: exactly one wins, the other gets common.version_conflict and leaves no rows behind', async () => {
    const rs = await Promise.allSettled([put([row()]), put([row({ result_code: 'not_detected' })])]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = rs.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(isLimsError(lost.reason, 'common.version_conflict')).toBe(true);
    expect(activeResults(CASE.MOL)).toHaveLength(1);
    expect(S.cases.get(CASE.MOL)!['molecular_rev']).toBe(4);
  });
  it('a case that is not molecular → 409 anatomic.case_invalid_transition (CR)', async () => {
    conflict(await rejects(put([row()], CASE.HISTO)), 'anatomic.case_invalid_transition');
    expect(S.writes).toBe(0);
  });
  it('signed_out: without an open change draft → 409 anatomic.signout_locked; with one → allowed (08 A17 D-66 (b))', async () => {
    conflict(await rejects(put([row()], CASE.SIGNED)), 'anatomic.signout_locked');
    expect(S.writes).toBe(0);
    S.openDrafts.add(CASE.SIGNED);
    expect((await put([row()], CASE.SIGNED)).status).toBe(200);
  });
  it('permission: anatomic.case.work is asserted with the case centre before any write; a denial passes through (403) and nothing is stored', async () => {
    await put([row()]);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.work', centreId: C_A1 });
    const e = await rejects(put([row({ result_code: 'not_detected' })], CASE.MOL, 4, mkCtx({ deny: NO_WORK })));
    expect(isLimsError(e, 'auth.forbidden')).toBe(true);
    expect(activeResults(CASE.MOL)[0]!['result_code']).toBe('detected');
    expect(S.cases.get(CASE.MOL)!['molecular_rev']).toBe(4);
  });
  it('tenant isolation: another tenant\'s case id and an unknown / malformed id → 404 common.not_found, assertRole never reached, no side effect', async () => {
    for (const id of [CASE.OTHER, uid(9998), 'not-a-uuid']) {
      const ctx = mkCtx();
      const e = await rejects(put([row()], id, 3, ctx));
      expect(isLimsError(e, 'common.not_found'), id).toBe(true);
      expect(calls.assertRole).toEqual([]);
    }
    expect(S.writes).toBe(0);
  });
  it('the comment text never reaches the logs (P3 data)', async () => {
    await put([row({ comment_text: NO_PHI_MARKER })]);
    await rejects(put([row({ comment_text: NO_PHI_MARKER, result_code: 'maybe' })], CASE.MOL, 4));
    expect(calls.logs.join('\n')).not.toContain(NO_PHI_MARKER);
  });
});

describe('Q3 createAnatomicBatch', () => {
  const create = (body: Row, ctx = mkCtx()) => call('createAnatomicBatch', { body }, ctx);
  it('creates an open batch numbered MB26xxxx from the "batch" counter (year of ctx.now() in the tenant timezone), default capacity 96, answers 201 with the Batch shape', async () => {
    const r = await create({ assay_code: 'SYN_PCR_A', kit_name: 'SynKit', kit_lot: 'LOT-9', kit_expiry_on: '2027-01-31', instrument_text: 'Synthetic cycler 1', run_at: '2026-11-12T03:00:00Z' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ batch_no: 'MB260001', assay_code: 'SYN_PCR_A', status: 'open', capacity: 96, member_count: 0, version: 1, kit_name: 'SynKit', kit_lot: 'LOT-9', instrument_text: 'Synthetic cycler 1' });
    expect(String(r.body.kit_expiry_on).slice(0, 10)).toBe('2027-01-31'); expect(new Date(r.body.run_at).toISOString()).toBe('2026-11-12T03:00:00.000Z');
    expect(S.bumps).toEqual([{ tenantId: T, seriesKey: 'batch', yearAd: 2026, actorId: ACTOR }]);
    expect(S.batches.get(r.body.id)).toMatchObject({ tenant_id: T, assay_id: ASSAY_1, batch_no: 'MB260001', status: 'open', created_by: ACTOR });
    expect(keysDeep(r.body).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]); expect(hasNoNulls(r.body)).toBe(true);
    expect((await create({ assay_code: 'SYN_PCR_B', capacity: 384 })).body).toMatchObject({ batch_no: 'MB260002', capacity: 384 });
  });
  it('rejects unknown / deactivated / other-tenant assay, capacity 0 and 385, over-long texts, a bad run_at and unknown fields — and does not consume a batch number', async () => {
    validationFailed(await rejects(create({ assay_code: 'SYN_NOPE' })), '/assay_code');
    validationFailed(await rejects(create({ assay_code: 'SYN_PCR_OFF' })), '/assay_code');
    validationFailed(await rejects(create({ assay_code: 'SYN_PCR_X' })), '/assay_code');
    validationFailed(await rejects(create({})), '/assay_code');
    validationFailed(await rejects(create({ assay_code: 'SYN_PCR_A', capacity: 0 })), '/capacity');
    validationFailed(await rejects(create({ assay_code: 'SYN_PCR_A', capacity: 385 })), '/capacity');
    validationFailed(await rejects(create({ assay_code: 'SYN_PCR_A', capacity: 1.5 })), '/capacity');
    validationFailed(await rejects(create({ assay_code: 'SYN_PCR_A', kit_name: 'k'.repeat(121) })), '/kit_name');
    validationFailed(await rejects(create({ assay_code: 'SYN_PCR_A', kit_lot: 'l'.repeat(65) })), '/kit_lot');
    validationFailed(await rejects(create({ assay_code: 'SYN_PCR_A', instrument_text: 'i'.repeat(121) })), '/instrument_text');
    validationFailed(await rejects(create({ assay_code: 'SYN_PCR_A', run_at: 'tomorrow' })), '/run_at');
    validationFailed(await rejects(create({ assay_code: 'SYN_PCR_A', batch_no: 'MB269999' })));
    expect(S.bumps).toEqual([]); expect(S.counters.size).toBe(0);
  });
  it('permission anatomic.case.work is asserted first: a denial → 403, no counter bump, no row', async () => {
    const e = await rejects(create({ assay_code: 'SYN_PCR_A' }, mkCtx({ deny: NO_WORK })));
    expect(isLimsError(e, 'auth.forbidden')).toBe(true);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.work' });
    expect(S.bumps).toEqual([]); expect(S.batches.size).toBe(5);
  });
  it('a failing create rolls the counter back (the number is not burned by a rolled-back request)', async () => {
    const ctx = mkCtx();
    await create({ assay_code: 'SYN_PCR_A' }, ctx);
    for (const u of [...ctx.tx.undo].reverse()) u();
    expect((await create({ assay_code: 'SYN_PCR_A' })).body.batch_no).toBe('MB260001');
  });
});

describe('Q2 listAnatomicBatches / Q4 getAnatomicBatch', () => {
  const list = (query: Row = {}, ctx = mkCtx()) => call('listAnatomicBatches', { query }, ctx);
  it('lists only this tenant\'s batches, newest first, each with member_count; asserts anatomic.case.read', async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body.data.map((b: Row) => b['id'])).toEqual([BATCH.OPEN1, BATCH.CLOSED, BATCH.OPEN2, BATCH.EMPTY]);
    expect(r.body.data[0]).toMatchObject({ batch_no: S.batches.get(BATCH.OPEN1)!['batch_no'], assay_code: 'SYN_PCR_A', status: 'open', capacity: 4, member_count: 1, kit_lot: 'LOT-1', version: 1 });
    expect(r.body.data[1]).toMatchObject({ status: 'closed', member_count: 1 });
    expect(r.body.data.some((b: Row) => b['id'] === BATCH.OTHER)).toBe(false);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.read' });
    expect(keysDeep(r.body).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
  });
  it('filters by status (open / closed / open,closed) and by assay_code; a bad status → 400', async () => {
    expect((await list({ status: 'closed' })).body.data.map((b: Row) => b['id'])).toEqual([BATCH.CLOSED]);
    expect((await list({ status: 'open' })).body.data.map((b: Row) => b['id'])).toEqual([BATCH.OPEN1, BATCH.OPEN2, BATCH.EMPTY]);
    expect((await list({ status: 'open,closed' })).body.data).toHaveLength(4);
    expect((await list({ assay_code: 'SYN_PCR_B' })).body.data.map((b: Row) => b['id'])).toEqual([BATCH.OPEN2]);
    validationFailed(await rejects(list({ status: 'bogus' })));
  });
  it('pages with an opaque cursor: limit 3 → next_cursor, then the last page has no next_cursor; a garbage cursor → common.invalid_cursor', async () => {
    const p1 = await list({ limit: '3' });
    expect(p1.body.data).toHaveLength(3); expect(p1.body.page.limit).toBe(3); expect(typeof p1.body.page.next_cursor).toBe('string');
    const p2 = await list({ limit: '3', cursor: p1.body.page.next_cursor });
    expect(p2.body.data.map((b: Row) => b['id'])).toEqual([BATCH.EMPTY]); expect(p2.body.page.next_cursor).toBeUndefined();
    expect(isLimsError(await rejects(list({ cursor: '%%%garbage%%%' })), 'common.invalid_cursor')).toBe(true);
  });
  it('Q4: BatchDetail = Batch + members { case_id, accession_no, position } in position order, active members only', async () => {
    S.members.set(uid(903), base(uid(903), { batch_id: BATCH.OPEN1, case_id: CASE.MOL2, position: 3, removed_at: null }));
    S.members.set(uid(904), base(uid(904), { batch_id: BATCH.OPEN1, case_id: CASE.MOL3, position: 2, is_active: false, removed_at: '2026-11-11T00:00:00Z' }));
    const r = await call('getAnatomicBatch', { params: { batch_id: BATCH.OPEN1 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: BATCH.OPEN1, status: 'open', member_count: 2 });
    expect(r.body.members).toEqual([{ case_id: CASE.MOL4, accession_no: S.cases.get(CASE.MOL4)!['accession_no'], position: 1 }, { case_id: CASE.MOL2, accession_no: S.cases.get(CASE.MOL2)!['accession_no'], position: 3 }]);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.read' });
  });
  it('Q4 tenant isolation: another tenant\'s batch, an unknown id and a malformed id → 404 common.not_found', async () => {
    for (const id of [BATCH.OTHER, uid(9998), 'not-a-uuid']) expect(isLimsError(await rejects(call('getAnatomicBatch', { params: { batch_id: id } })), 'common.not_found'), id).toBe(true);
  });
});

describe('Q5 addAnatomicBatchMembers (AC-11.4, AC-11.5)', () => {
  const add = (batch: string, members: Row[], ctx = mkCtx()) => call('addAnatomicBatchMembers', { params: { batch_id: batch }, body: { members } }, ctx);
  it('AC-11.4: adding 3 molecular cases with positions 3, 1, 2 to an open batch → members are listed in position order', async () => {
    const r = await add(BATCH.EMPTY, [{ case_id: CASE.MOL, position: 3 }, { case_id: CASE.MOL2, position: 1 }, { case_id: CASE.MOL3, position: 2 }]);
    expect(r.status).toBe(200);
    expect(r.body.members.map((m: Row) => [m['case_id'], m['position']])).toEqual([[CASE.MOL2, 1], [CASE.MOL3, 2], [CASE.MOL, 3]]);
    expect(r.body.members[0].accession_no).toBe(S.cases.get(CASE.MOL2)!['accession_no']);
    expect(r.body.member_count).toBe(3);
    const again = await call('getAnatomicBatch', { params: { batch_id: BATCH.EMPTY } });
    expect(again.body.members.map((m: Row) => m['position'])).toEqual([1, 2, 3]);
    expect(activeMembers(BATCH.EMPTY)).toHaveLength(3);
    expect(calls.assertRole.some((c) => c['permission'] === 'anatomic.case.work')).toBe(true);
    expect(activeMembers(BATCH.EMPTY).every((m) => m['tenant_id'] === T && m['created_by'] === ACTOR)).toBe(true);
  });
  it('AC-11.4: a duplicate position → 409 anatomic.batch_position_taken, and the whole request is atomic (the other members of the same call are not kept)', async () => {
    const e = await rejects(add(BATCH.OPEN1, [{ case_id: CASE.MOL2, position: 2 }, { case_id: CASE.MOL3, position: 1 }])); // position 1 is taken by MOL4
    conflict(e, 'anatomic.batch_position_taken');
    expect(activeMembers(BATCH.OPEN1).map((m) => m['case_id'])).toEqual([CASE.MOL4]);
  });
  it('two members for the same position inside one request → 409 anatomic.batch_position_taken, nothing kept', async () => {
    conflict(await rejects(add(BATCH.EMPTY, [{ case_id: CASE.MOL, position: 5 }, { case_id: CASE.MOL2, position: 5 }])), 'anatomic.batch_position_taken');
    expect(activeMembers(BATCH.EMPTY)).toEqual([]);
  });
  it('two parallel adds for the same free position: exactly one wins, the other gets batch_position_taken', async () => {
    const rs = await Promise.allSettled([add(BATCH.EMPTY, [{ case_id: CASE.MOL, position: 9 }]), add(BATCH.EMPTY, [{ case_id: CASE.MOL2, position: 9 }])]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    conflict((rs.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'anatomic.batch_position_taken');
    expect(activeMembers(BATCH.EMPTY)).toHaveLength(1);
  });
  it('AC-11.5: adding a member to a closed batch → 409 anatomic.batch_closed, nothing written (checked before the position)', async () => {
    const before = stored();
    conflict(await rejects(add(BATCH.CLOSED, [{ case_id: CASE.MOL2, position: 2 }])), 'anatomic.batch_closed');
    conflict(await rejects(add(BATCH.CLOSED, [{ case_id: CASE.MOL3, position: 1 }])), 'anatomic.batch_closed'); // position 1 is also taken: closed wins
    expect(stored()).toBe(before);
  });
  it('position must be 1..capacity of THIS batch (capacity 4 on OPEN1): 0, 5 and 1.5 → 400 at /members/0/position', async () => {
    for (const p of [0, 5, 1.5, -1]) validationFailed(await rejects(add(BATCH.OPEN1, [{ case_id: CASE.MOL2, position: p }])), '/members/0/position');
    expect((await add(BATCH.OPEN1, [{ case_id: CASE.MOL2, position: 4 }])).body.members.map((m: Row) => m['position'])).toEqual([1, 4]);
  });
  it('request shape: empty list, 97 members, missing case_id, non-uuid case_id, unknown field, the same case twice → 400 and nothing written', async () => {
    validationFailed(await rejects(add(BATCH.EMPTY, [])));
    validationFailed(await rejects(add(BATCH.EMPTY, Array.from({ length: 97 }, (_, i) => ({ case_id: CASE.MOL, position: i + 1 })))));
    validationFailed(await rejects(add(BATCH.EMPTY, [{ position: 1 } as any])), '/members/0/case_id');
    validationFailed(await rejects(add(BATCH.EMPTY, [{ case_id: 'nope', position: 1 }])), '/members/0/case_id');
    validationFailed(await rejects(add(BATCH.EMPTY, [{ case_id: CASE.MOL, position: 1, extra: true } as any])));
    validationFailed(await rejects(add(BATCH.EMPTY, [{ case_id: CASE.MOL, position: 1 }, { case_id: CASE.MOL, position: 2 }])), '/members/1/case_id');
    expect(S.writes).toBe(0);
  });
  it('bulk ids: another tenant\'s or an unknown case id mixed in → 404 common.not_found for the call and no member is kept (07-SECURITY §5)', async () => {
    for (const bad of [CASE.OTHER, uid(9998)]) {
      expect(isLimsError(await rejects(add(BATCH.EMPTY, [{ case_id: CASE.MOL, position: 1 }, { case_id: bad, position: 2 }])), 'common.not_found'), bad).toBe(true);
      expect(activeMembers(BATCH.EMPTY)).toEqual([]);
    }
  });
  it('centre scoping: assertRole runs for every member case with that case\'s centre; a centre the user cannot see → 404 and nothing is kept', async () => {
    const ok = await add(BATCH.EMPTY, [{ case_id: CASE.MOL, position: 1 }, { case_id: CASE.A2, position: 2 }]);
    expect(ok.status).toBe(200);
    expect(calls.assertRole.filter((c) => c['permission'] === 'anatomic.case.work').map((c) => c['centreId'])).toEqual(expect.arrayContaining([C_A1, C_A2]));
    S.members.clear(); calls.assertRole.length = 0;
    const e = await rejects(add(BATCH.EMPTY, [{ case_id: CASE.MOL, position: 1 }, { case_id: CASE.A2, position: 2 }], mkCtx({ denyCentre: C_A2 })));
    expect(isLimsError(e, 'common.not_found')).toBe(true);
    expect(activeMembers(BATCH.EMPTY)).toEqual([]);
  });
  it('a denied permission → 403 and nothing written; another tenant\'s batch id → 404', async () => {
    expect(isLimsError(await rejects(add(BATCH.EMPTY, [{ case_id: CASE.MOL, position: 1 }], mkCtx({ deny: NO_WORK }))), 'auth.forbidden')).toBe(true);
    expect(isLimsError(await rejects(add(BATCH.OTHER, [{ case_id: CASE.MOL, position: 1 }])), 'common.not_found')).toBe(true);
    expect(S.writes).toBe(0);
  });
});

describe('Q6 removeAnatomicBatchMembers / Q7 closeAnatomicBatch', () => {
  const remove = (batch: string, caseIds: string[], version?: number, ctx = mkCtx()) =>
    call('removeAnatomicBatchMembers', { params: { batch_id: batch }, headers: version === undefined ? {} : ifm(version), body: { case_ids: caseIds } }, ctx);
  const close = (batch: string, version?: number, ctx = mkCtx()) => call('closeAnatomicBatch', { params: { batch_id: batch }, headers: version === undefined ? {} : ifm(version), body: {} }, ctx);
  const fill = async () => { const r = await call('addAnatomicBatchMembers', { params: { batch_id: BATCH.EMPTY }, body: { members: [{ case_id: CASE.MOL, position: 1 }, { case_id: CASE.MOL2, position: 2 }, { case_id: CASE.MOL3, position: 3 }] } }); return r.body.version as number; };

  it('Q6: removing a member answers BatchDetail without it, frees its position and the removal is a soft delete (is_active false + removed_at)', async () => {
    const v = await fill();
    const r = await remove(BATCH.EMPTY, [CASE.MOL2], v);
    expect(r.status).toBe(200);
    expect(r.body.members.map((m: Row) => m['position'])).toEqual([1, 3]); expect(r.body.member_count).toBe(2);
    const gone = [...S.members.values()].find((m) => m['case_id'] === CASE.MOL2)!;
    expect(gone).toMatchObject({ is_active: false }); expect(gone['removed_at']).toBeTruthy();
    expect((await call('addAnatomicBatchMembers', { params: { batch_id: BATCH.EMPTY }, body: { members: [{ case_id: CASE.MOL4, position: 2 }] } })).body.members.map((m: Row) => m['position'])).toEqual([1, 2, 3]);
    expect(calls.assertRole.some((c) => c['permission'] === 'anatomic.case.work')).toBe(true);
  });
  it('Q6: If-Match is required (428) and must equal the batch version (common.version_conflict); a closed batch → 409 anatomic.batch_closed; nothing changes on failure', async () => {
    const v = await fill(); const before = stored();
    expect(isLimsError(await rejects(remove(BATCH.EMPTY, [CASE.MOL])), 'common.precondition_required')).toBe(true);
    expect(isLimsError(await rejects(remove(BATCH.EMPTY, [CASE.MOL], v + 5)), 'common.version_conflict')).toBe(true);
    conflict(await rejects(remove(BATCH.CLOSED, [CASE.MOL4], 1)), 'anatomic.batch_closed');
    expect(stored()).toBe(before);
  });
  it('Q6: a case that is not an active member, another tenant\'s case, > 96 ids, empty list, non-uuid → per-id 404 / 400 and nothing removed', async () => {
    const v = await fill(); const before = stored();
    expect(isLimsError(await rejects(remove(BATCH.EMPTY, [CASE.MOL, CASE.MOL4], v)), 'common.not_found')).toBe(true);
    expect(isLimsError(await rejects(remove(BATCH.EMPTY, [CASE.OTHER], v)), 'common.not_found')).toBe(true);
    validationFailed(await rejects(remove(BATCH.EMPTY, [], v)));
    validationFailed(await rejects(remove(BATCH.EMPTY, Array.from({ length: 97 }, (_, i) => uid(5000 + i)), v)));
    validationFailed(await rejects(remove(BATCH.EMPTY, ['nope'], v)));
    expect(stored()).toBe(before);
  });
  it('Q6/Q7 tenant isolation and permission: other tenant\'s batch → 404, denied → 403, no side effect', async () => {
    expect(isLimsError(await rejects(remove(BATCH.OTHER, [CASE.MOL], 1)), 'common.not_found')).toBe(true);
    expect(isLimsError(await rejects(close(BATCH.OTHER, 1)), 'common.not_found')).toBe(true);
    expect(isLimsError(await rejects(close(BATCH.EMPTY, 1, mkCtx({ deny: NO_WORK }))), 'auth.forbidden')).toBe(true);
    expect(isLimsError(await rejects(remove(BATCH.EMPTY, [CASE.MOL], 1, mkCtx({ deny: NO_WORK }))), 'auth.forbidden')).toBe(true);
    expect(S.writes).toBe(0);
  });
  it('Q7: closing an open batch sets status closed + closed_at, keeps the members, bumps the version, and afterwards adding a member → batch_closed', async () => {
    const v = await fill();
    const r = await close(BATCH.EMPTY, v);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: BATCH.EMPTY, status: 'closed', member_count: 3, version: v + 1 });
    expect(r.body.members).toHaveLength(3);
    expect(S.batches.get(BATCH.EMPTY)!['closed_at']).toBeTruthy();
    conflict(await rejects(call('addAnatomicBatchMembers', { params: { batch_id: BATCH.EMPTY }, body: { members: [{ case_id: CASE.MOL4, position: 9 }] } })), 'anatomic.batch_closed');
    expect(calls.assertRole.some((c) => c['permission'] === 'anatomic.case.work')).toBe(true);
  });
  it('Q7: If-Match required and checked; closing a closed batch → 409 anatomic.batch_closed; two parallel closes → one wins', async () => {
    expect(isLimsError(await rejects(close(BATCH.EMPTY)), 'common.precondition_required')).toBe(true);
    expect(isLimsError(await rejects(close(BATCH.EMPTY, 42)), 'common.version_conflict')).toBe(true);
    conflict(await rejects(close(BATCH.CLOSED, 1)), 'anatomic.batch_closed');
    const rs = await Promise.allSettled([close(BATCH.OPEN2, 1), close(BATCH.OPEN2, 1)]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(S.batches.get(BATCH.OPEN2)!['status']).toBe('closed');
  });
});

describe('AC-11.6 markAnatomicCaseReady for a molecular case (02-TRD §7 C4)', () => {
  const ready = (caseId: string, version = 7, ctx = mkCtx()) => call('markAnatomicCaseReady', { params: { case_id: caseId }, headers: ifm(version) }, ctx);
  const result = (caseId: string, over: Row = {}) => {
    const id = uid(7700 + ++S.seq);
    S.results.set(id, base(id, { case_id: caseId, centre_id: C_A1, assay_id: ASSAY_1, assay_code: 'SYN_PCR_A', target_id: TG.T1, target_code: 'T1', result_value_id: uid(421), result_code: 'detected', ...over }));
  };
  it('without any molecular result → 409 anatomic.case_invalid_transition, status unchanged, no transition row', async () => {
    conflict(await rejects(ready(CASE.READY_OK)), 'anatomic.case_invalid_transition');
    expect(S.cases.get(CASE.READY_OK)).toMatchObject({ status: 'in_processing', version: 7 }); expect(S.transitions).toEqual([]);
  });
  it('a deactivated (replaced) result does not count', async () => {
    result(CASE.READY_OK, { is_active: false });
    conflict(await rejects(ready(CASE.READY_OK)), 'anatomic.case_invalid_transition');
    expect(S.transitions).toEqual([]);
  });
  it('with one active result → 200, status ready_for_reporting, one case_transitions row in_processing → ready_for_reporting; permission anatomic.case.work with the case centre', async () => {
    result(CASE.READY_OK);
    const r = await ready(CASE.READY_OK);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: CASE.READY_OK, status: 'ready_for_reporting' });
    expect(S.cases.get(CASE.READY_OK)!['status']).toBe('ready_for_reporting');
    expect(S.transitions).toHaveLength(1);
    expect(S.transitions[0]).toMatchObject({ tenant_id: T, case_id: CASE.READY_OK, from_status: 'in_processing', to_status: 'ready_for_reporting' });
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.work', centreId: C_A1 });
  });
  it('a result of another case does not count; a saved Q1 result does (end to end through Q1)', async () => {
    result(CASE.MOL2);
    conflict(await rejects(ready(CASE.READY_OK)), 'anatomic.case_invalid_transition');
    await put([row()], CASE.READY_OK, 3);
    expect((await ready(CASE.READY_OK, S.cases.get(CASE.READY_OK)!['version'])).body.status).toBe('ready_for_reporting'); // case.version may have moved with molecular_rev
  });
});
