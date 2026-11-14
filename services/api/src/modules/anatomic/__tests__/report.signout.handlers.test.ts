// C11.T-14 — R3 signOutAnatomicCase (02-TRD §4.4 steps 1–10, §4.5.3 completeness, §4.7 snapshot, §5.3 R3, §12 access log; 01-PRD AC-09.1 … AC-09.10; 07-SECURITY AB-4, AB-9 (core hook), AB-12 (lab.result_locked
// on sign-out), REQ-SEC-062/067 (privileged, aal2), REQ-SEC-096/097 (access log `anatomic_report.sign_out`), REQ-SEC-098 (no PHI in logs/problems); 05-SCHEMA report_versions / item_submissions CHECKs and
// uniques; 08 A13 D-7 (LabPort versioning), 08 R1 (`amendment` ignored for unapproved targets), 08 A17 P-23 (port errors rethrown unchanged)).
// Drives the REAL handler (manifest.handlers.signOutAnatomicCase) with the REAL @lims/fakes LabPort (`failNext`, D-7 versioning, per-key replay) and FrontdeskPort fakes, on IN-MEMORY repositories
// (vi.mock with the T-04 signatures). The mocks emulate the tables: NOT NULLs, the CHECKs listed above, the unique indexes (23505), If-Match versions, FK report_version_id -> report_versions, the case row lock
// of getCase({ forUpdate: true }) (held until the request transaction ends) and an undo journal (a throwing handler rolls back every write made through ctx.tx). Real PG + RLS: integration/report.signout.live.test.ts (GATED).
//
// SEAMS (spec fixes behaviour; names chosen here — the writer follows or disputes):
//   * R3: params { case_id }; headers 'if-match' = '"<draft.version>"' (+ 'idempotency-key', handled by the core hook, ignored by the handler); body closed { attest: true } (false / missing / non-boolean -> 400 at '/attest',
//     unknown key -> 400 common.unknown_field). Success = 200 { case: CaseDetail (id, status 'signed_out', current_version_no, signed_out_at), report_version: ReportVersionSummary (02-TRD §5.5 shapes), no nulls on the wire }.
//   * Order: load case (404; getCase forUpdate:true) -> IdentityPort.assertRole({ permission: 'anatomic.case.signout', centreId: case.centre_id }) (its auth.forbidden / auth.mfa_required passes through, BEFORE anything else
//     happens) -> actor type must be 'user' (system -> auth.forbidden, 02-TRD §3.2 DECISION) -> body -> open draft (none -> 409 anatomic.case_invalid_transition) -> If-Match (409 common.version_conflict)
//     -> state guard (initial draft needs ready_for_reporting; revision/amendment draft needs signed_out; else 409 anatomic.case_invalid_transition) -> completeness (422 anatomic.report_incomplete, errors[] together)
//     -> FrontdeskPort.getOrderSummary(order_id).items[orderItemId].status must be 'active' (409 anatomic.order_item_inactive, `detail` contains the order item id) -> LabPort calls -> report_versions -> item_submissions
//     -> case + draft update. No lab call, no write happens before the last guard has passed.
//   * Targets = case_items with role 'primary' and is_active, ordered by case_item id. Item version v = 1 + max(item_version_no) of that case_item's rows in submissions.repo.listItemSubmissions({ tenantId, caseId })
//     (existing repo function — no new SQL). LabPort input: { orderItemId, kind ('structured' for molecular else 'narrative'), reportPhase 'final', payloadRef { module 'anatomic', entityId case_item id, versionNo v },
//     summaryText = summarise(impression_text), flag (draft flag), isCritical: true ONLY when the draft is critical (key absent otherwise), submittedAt = ctx.now(), idempotencyKey 'anatomic:<case_item_id>:<v>',
//     amendment { reasonCode, reasonText? } ONLY for revision/amendment drafts (key absent for an initial draft) }.
//   * Snapshot: report_versions row = domain/report-content.ts buildContent(...) columns + version_no = case.current_version_no + 1, version_kind (original for an initial draft; else 'amendment' when ANY LabPort result
//     came back 'approved', else the draft kind), scope 'full', change_reason_* from the draft, signed_by_membership_id = ctx.actor.membershipId, signed_at = ctx.now(). item_submissions row per target:
//     { case_item_id, item_version_no v, report_version_id, idempotency_key, lab_result_id, lab_version_no, lab_status, replayed, submitted_at, created_by }.
//   * Case: status 'signed_out', current_version_no n, signed_out_at set the FIRST time only, version + 1. Draft: status 'consumed', consumed_version_no n, consumed_at.
//   * Access log: exactly one ctx.audit.access({ action: 'anatomic_report.sign_out', entityType: 'anatomic_case', entityId: case id, detail: { version_no: n } }) on success; none on any failure.
//   * Display names via ctx.core.user (string, never null). Content lookups via the existing repos (parts, images, templates, stainOrders, codedValues listCodedDiagnoses, config listAssays/listAssayTargets/
//     listAssayTargetValues, molecular listMolecularResults({activeOnly})). Anything else the handler asks the DB raw throws "unexpected SQL" here.
// Fails now: R3 is a `common.internal` stub; domain/report-content.ts and the sign-out service do not exist.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError, isLimsError } from '../../../core/errors.js';
import { createFakeFrontdeskPort } from '../../../../../../packages/fakes/src/FrontdeskPort.fake.js';
import { createFakeLabPort } from '../../../../../../packages/fakes/src/LabPort.fake.js';
import { TENANT_A, TENANT_B } from '../../../../../../packages/fakes/src/base.js';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  cases: new Map<string, Row>(), items: new Map<string, Row>(), drafts: new Map<string, Row>(), versions: new Map<string, Row>(), subs: new Map<string, Row>(), parts: new Map<string, Row>(),
  images: new Map<string, Row>(), templates: new Map<string, Row>(), diagnoses: new Map<string, Row>(), stainOrders: new Map<string, Row>(), assays: new Map<string, Row>(),
  targets: new Map<string, Row>(), values: new Map<string, Row>(), molecular: new Map<string, Row>(), transitions: [] as Row[],
  log: [] as string[], writes: 0, seq: 0, portCalls: 0, portFailAt: 0, dbFail: undefined as undefined | { name: string; at: number }, dbCalls: {} as Record<string, number>,
  locks: new Map<string, { tx: unknown; waiters: (() => void)[] }>(),
}));
const pgErr = (code: string, constraint: string) => Object.assign(new Error('constraint violation'), { code, constraint });
const touch = () => { S.writes++; };
const undo = (tx: unknown, f: () => void) => { (tx as { undo?: (() => void)[] } | undefined)?.undo?.push(f); };
const mine = (m: Map<string, Row>, i: Row) => [...m.values()].filter((r) => r['tenant_id'] === i['tenantId']);
const maybeFail = (name: string) => { S.dbCalls[name] = (S.dbCalls[name] ?? 0) + 1; if (S.dbFail && S.dbFail.name === name && S.dbFail.at === S.dbCalls[name]) throw new Error('simulated db failure'); };
const releaseLocks = (tx: unknown) => { for (const [k, l] of [...S.locks]) if (l.tx === tx) { S.locks.delete(k); l.waiters.forEach((w) => w()); } };
async function lock(tx: unknown, key: string) {
  for (;;) {
    const l = S.locks.get(key);
    if (!l || l.tx === tx) { S.locks.set(key, { tx, waiters: l?.waiters ?? [] }); return; }
    await new Promise<void>((res) => l.waiters.push(res));
  }
}

const CASES_UPDATABLE = ['branch_id', 'status', 'priority', 'accession_no', 'accession_series', 'accession_year', 'clinical_history_text', 'assigned_pathologist_membership_id', 'profile_missing', 'current_version_no', 'molecular_rev',
  'accessioned_at', 'accessioned_by', 'signed_out_at', 'cancelled_at', 'cancel_reason_code', 'cancel_reason_text'];
const DRAFT_COLS = ['status', 'change_reason_code', 'change_reason_text', 'gross_text', 'microscopy_text', 'impression_text', 'comment_text', 'flag', 'is_critical', 'synoptic', 'ancillary', 'image_ids', 'diagnosis_codes',
  'consumed_version_no', 'consumed_at', 'discarded_at'];

vi.mock('../repository/cases.repo.js', () => ({
  async getCase(tx: unknown, i: Row) {
    if (i['forUpdate']) await lock(tx, i['caseId']);
    const r = S.cases.get(i['caseId']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined;
  },
  async updateCase(tx: unknown, i: Row) {
    touch(); maybeFail('updateCase');
    for (const k of Object.keys(i['patch'])) if (i['patch'][k] !== undefined && !CASES_UPDATABLE.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
    const r = S.cases.get(i['id']);
    if (!r || r['tenant_id'] !== i['tenantId'] || r['version'] !== i['expectedVersion']) return undefined;
    const next = { ...r, ...Object.fromEntries(Object.entries(i['patch']).filter(([, v]) => v !== undefined)), version: r['version'] + 1, updated_by: i['actorId'] };
    if (next['status'] === 'signed_out' && !(next['current_version_no'] >= 1 && next['signed_out_at'])) throw pgErr('23514', 'cases__signed_out__ck');
    S.cases.set(i['id'], next); undo(tx, () => S.cases.set(i['id'], r)); return { ...next };
  },
  async insertCaseTransition(tx: unknown, row: Row) { touch(); const r = { ...row }; S.transitions.push(r); undo(tx, () => { S.transitions.splice(S.transitions.indexOf(r), 1); }); return r; },
  async listCaseTransitions(_tx: unknown, i: Row) { return S.transitions.filter((t) => t['tenant_id'] === i['tenantId'] && t['case_id'] === i['caseId']); },
  async getCaseTransition() { return undefined; }, async listCases() { return []; }, async listCasesByOrder() { return []; }, async insertCase() { touch(); }, async insertCaseItem() { touch(); },
  async getCaseItem(_tx: unknown, i: Row) { const r = S.items.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async listCaseItems(_tx: unknown, i: Row) {
    return mine(S.items, i).filter((r) => r['case_id'] === i['caseId'] && (!i['activeOnly'] || r['is_active'])).sort((a, b) => (a['id'] < b['id'] ? -1 : 1)).map((r) => ({ ...r }));
  },
  async updateCaseItem() { touch(); return undefined; },
}));
vi.mock('../repository/drafts.repo.js', () => ({
  async insertReportDraft() { touch(); throw new Error('sign-out never inserts a draft'); },
  async getReportDraft(_tx: unknown, i: Row) { const r = S.drafts.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async listReportDrafts(_tx: unknown, i: Row) { return mine(S.drafts, i).filter((d) => d['case_id'] === i['caseId']).map((d) => ({ ...d })); },
  async getOpenDraft(_tx: unknown, i: Row) { const r = mine(S.drafts, i).find((d) => d['case_id'] === i['caseId'] && d['status'] === 'open'); return r ? { ...r } : undefined; },
  async updateReportDraft(tx: unknown, i: Row) {
    touch(); maybeFail('updateReportDraft');
    for (const k of Object.keys(i['patch'])) if (i['patch'][k] !== undefined && !DRAFT_COLS.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
    const r = S.drafts.get(i['id']);
    if (!r || r['tenant_id'] !== i['tenantId'] || r['version'] !== i['expectedVersion']) return undefined;
    if (r['status'] !== 'open') throw Object.assign(new Error('immutable_row'), { code: 'P0001' });
    const next = { ...r, ...Object.fromEntries(Object.entries(i['patch']).filter(([, v]) => v !== undefined)), version: r['version'] + 1, updated_by: i['actorId'] };
    if (next['status'] === 'consumed' && !(next['consumed_version_no'] >= 1 && next['consumed_at'])) throw pgErr('23514', 'report_drafts__consumed__ck');
    S.drafts.set(i['id'], next); undo(tx, () => S.drafts.set(i['id'], r)); return { ...next };
  },
}));
vi.mock('../repository/versions.repo.js', () => ({
  async insertReportVersion(tx: unknown, row: Row) {
    touch(); S.log.push('insertVersion'); maybeFail('insertReportVersion');
    for (const k of ['id', 'tenant_id', 'centre_id', 'case_id', 'version_no', 'version_kind', 'signed_by_membership_id', 'signed_at', 'created_by']) if (!row[k]) throw pgErr('23502', `report_versions__${k}__notnull`);
    const arr = (v: unknown) => (v === undefined || v === null ? [] : v);
    const r: Row = {
      scope: 'full', addon_case_item_id: null, addendum_id: null, change_reason_code: null, change_reason_text: null, clinical_history_text: '', gross_text: '', microscopy_text: '', impression_text: '', comment_text: '',
      flag: null, is_critical: false, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null)),
      synoptic: arr(row['synoptic']), images: arr(row['images']), specimen_parts: arr(row['specimen_parts']), slides: arr(row['slides']), ancillary: arr(row['ancillary']), molecular: arr(row['molecular']),
      addenda: arr(row['addenda']), diagnosis_codes: arr(row['diagnosis_codes']),
    };
    if (!['original', 'revision', 'amendment', 'addendum'].includes(r['version_kind'])) throw pgErr('23514', 'report_versions__kind__ck');
    if ((r['version_kind'] === 'original') !== (r['version_no'] === 1)) throw pgErr('23514', 'report_versions__original__ck');
    if (!['full', 'addendum_only'].includes(r['scope']) || (r['scope'] === 'addendum_only') !== (r['addon_case_item_id'] != null) || (r['scope'] !== 'full' && r['version_kind'] !== 'addendum')) throw pgErr('23514', 'report_versions__scope__ck');
    if (!['original', 'addendum'].includes(r['version_kind']) && !r['change_reason_code']) throw pgErr('23514', 'report_versions__reason__ck');
    if ((r['change_reason_code'] && !/^[a-z0-9_]{1,64}$/.test(r['change_reason_code'])) || String(r['change_reason_text'] ?? '').length > 500) throw pgErr('23514', 'report_versions__reason_fmt__ck');
    if (r['flag'] != null && !['N', 'A'].includes(r['flag'])) throw pgErr('23514', 'report_versions__flag__ck');
    for (const c of ['synoptic', 'images', 'specimen_parts', 'slides', 'ancillary', 'molecular', 'addenda', 'diagnosis_codes']) if (!Array.isArray(r[c])) throw pgErr('23514', 'report_versions__json__ck');
    if (r['images'].length > 24 || r['synoptic'].length > 5) throw pgErr('23514', 'report_versions__json__ck');
    if ([...S.versions.values()].some((v) => v['tenant_id'] === r['tenant_id'] && v['case_id'] === r['case_id'] && v['version_no'] === r['version_no'])) throw pgErr('23505', 'report_versions__tenant_id_case_version__uq');
    S.versions.set(r['id'], r); undo(tx, () => S.versions.delete(r['id'])); return structuredClone(r);
  },
  async getReportVersion(_tx: unknown, i: Row) { const r = S.versions.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? structuredClone(r) : undefined; },
  async listReportVersions(_tx: unknown, i: Row) { return mine(S.versions, i).filter((v) => v['case_id'] === i['caseId']).sort((a, b) => b['version_no'] - a['version_no']).map((v) => structuredClone(v)); },
  async getLatestReportVersion(_tx: unknown, i: Row) { return mine(S.versions, i).filter((v) => v['case_id'] === i['caseId']).sort((a, b) => b['version_no'] - a['version_no']).map((v) => structuredClone(v))[0]; },
}));
vi.mock('../repository/submissions.repo.js', () => ({
  async insertItemSubmission(tx: unknown, row: Row) {
    touch(); S.log.push('insertSubmission'); maybeFail('insertItemSubmission');
    for (const k of ['id', 'tenant_id', 'centre_id', 'case_id', 'case_item_id', 'item_version_no', 'report_version_id', 'idempotency_key', 'lab_result_id', 'lab_version_no', 'lab_status', 'replayed', 'submitted_at', 'created_by']) {
      if (row[k] === undefined || row[k] === null) throw pgErr('23502', `item_submissions__${k}__notnull`);
    }
    if (row['item_version_no'] < 1 || row['lab_version_no'] < 1) throw pgErr('23514', 'item_submissions__no__ck');
    if (!['pending', 'resulted', 'verified', 'approved', 'cancelled'].includes(row['lab_status'])) throw pgErr('23514', 'item_submissions__status__ck');
    if (row['idempotency_key'] !== `anatomic:${row['case_item_id']}:${row['item_version_no']}`) throw pgErr('23514', 'item_submissions__key__ck');
    const v = S.versions.get(row['report_version_id']);
    if (!v || v['case_id'] !== row['case_id'] || v['tenant_id'] !== row['tenant_id']) throw pgErr('23503', 'item_submissions__version__fk');
    const all = [...S.subs.values()].filter((s) => s['tenant_id'] === row['tenant_id']);
    if (all.some((s) => s['case_item_id'] === row['case_item_id'] && s['item_version_no'] === row['item_version_no'])) throw pgErr('23505', 'item_submissions__tenant_id_item_version__uq');
    if (all.some((s) => s['idempotency_key'] === row['idempotency_key'])) throw pgErr('23505', 'item_submissions__tenant_id_key__uq');
    const r = { ...row }; S.subs.set(r['id'], r); undo(tx, () => S.subs.delete(r['id'])); return { ...r };
  },
  async getItemSubmission(_tx: unknown, i: Row) { const r = S.subs.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async listItemSubmissions(_tx: unknown, i: Row) { return mine(S.subs, i).filter((s) => s['case_id'] === i['caseId']).map((s) => ({ ...s })); },
  async getItemSubmissionByKey(_tx: unknown, i: Row) { const r = mine(S.subs, i).find((s) => s['idempotency_key'] === i['idempotencyKey']); return r ? { ...r } : undefined; },
}));
vi.mock('../repository/parts.repo.js', () => ({
  async listParts(_tx: unknown, i: Row) { return mine(S.parts, i).filter((p) => p['case_id'] === i['caseId']).map((p) => ({ ...p })); },
  async getPart(_tx: unknown, i: Row) { const r = S.parts.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async insertPart() { touch(); }, async updatePart() { touch(); return undefined; },
}));
vi.mock('../repository/images.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return {
    ...m,
    async getImage(_tx: unknown, i: Row) { const r = S.images.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
    async listImages(_tx: unknown, i: Row) { return mine(S.images, i).filter((r) => r['case_id'] === i['caseId'] && (!i['activeOnly'] || r['is_active'])).map((r) => ({ ...r })); },
  };
});
vi.mock('../repository/templates.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return {
    ...m,
    async getSynopticTemplate(_tx: unknown, i: Row) { const r = S.templates.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? structuredClone(r) : undefined; },
    async listSynopticTemplates(_tx: unknown, i: Row) { return mine(S.templates, i).map((r) => structuredClone(r)); },
  };
});
vi.mock('../repository/stainOrders.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return {
    ...m,
    async getStainOrder(_tx: unknown, i: Row) { const r = S.stainOrders.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
    async listStainOrders(_tx: unknown, i: Row) { return mine(S.stainOrders, i).filter((r) => r['case_id'] === i['caseId']).map((r) => ({ ...r })); },
  };
});
vi.mock('../repository/codedValues.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return {
    ...m,
    async getCodedDiagnosis(_tx: unknown, i: Row) { const r = S.diagnoses.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
    async listCodedDiagnoses(_tx: unknown, i: Row) {
      const off = Math.max(Math.trunc(Number(i['offset'] ?? 0)) || 0, 0), lim = Math.min(Math.max(Math.trunc(Number(i['limit'] ?? 200)) || 200, 1), 500);
      return mine(S.diagnoses, i).filter((r) => !i['activeOnly'] || r['is_active']).sort((a, b) => (a['code'] < b['code'] ? -1 : 1)).slice(off, off + lim).map((r) => ({ ...r }));
    },
  };
});
vi.mock('../repository/config.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  const active = (rows: Row[], i: Row) => rows.filter((r) => !i['activeOnly'] || r['is_active']).map((r) => ({ ...r }));
  return {
    ...m,
    async getSettings() { return undefined; },
    async listAssays(_tx: unknown, i: Row) { return active(mine(S.assays, i), i).slice(Number(i['offset'] ?? 0), Number(i['offset'] ?? 0) + Number(i['limit'] ?? 500)); },
    async getAssay(_tx: unknown, i: Row) { const r = S.assays.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
    async listAssayTargets(_tx: unknown, i: Row) { return active(mine(S.targets, i).filter((t) => t['assay_id'] === i['assayId']), i); },
    async listAssayTargetValues(_tx: unknown, i: Row) { return active(mine(S.values, i).filter((v) => v['target_id'] === i['targetId']), i); },
  };
});
vi.mock('../repository/molecular.repo.js', () => ({
  async listMolecularResults(_tx: unknown, i: Row) { return mine(S.molecular, i).filter((r) => r['case_id'] === i['caseId'] && (!i['activeOnly'] || r['is_active'])).map((r) => ({ ...r })); },
  async getMolecularResult(_tx: unknown, i: Row) { const r = S.molecular.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async insertMolecularResult() { touch(); }, async updateMolecularResult() { touch(); return undefined; },
}));
const emptyRepo = vi.hoisted(() => async (orig: () => Promise<unknown>) => {
  const m = (await orig()) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(m).map((k) => [k, async () => (k.startsWith('list') ? [] : undefined)]));
});
vi.mock('../repository/slides.repo.js', emptyRepo); vi.mock('../repository/blocks.repo.js', emptyRepo); vi.mock('../repository/gross.repo.js', emptyRepo); vi.mock('../repository/addenda.repo.js', emptyRepo);
vi.mock('../repository/movements.repo.js', emptyRepo); vi.mock('../repository/specimenLinks.repo.js', emptyRepo); vi.mock('../repository/batches.repo.js', emptyRepo); vi.mock('../repository/counters.repo.js', emptyRepo);

const { manifest } = await import('../index.js');

// ------------------------------------------------------------------------------------------------ ids + fixtures
const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = TENANT_A, T_OTHER = TENANT_B, ACTOR = '01a1a98a-ac40-7000-8000-00000000a300', MEMBERSHIP = uid(5000);
const C_A1 = '01a1a98a-ac40-7000-8000-00000000a201';
const NOW = '2026-11-13T04:00:00.000Z', FIRST_SIGNED = '2026-11-10T05:00:00.000Z';
const MARKER = 'SYNTHETIC-SIGNOUT-PHI-MARKER';
const SHA = (c: string) => c.repeat(64);
const GOOD = { gross_text: 'A. Antrum: two fragments.', microscopy_text: 'Mucosa with mild gastritis.', impression_text: 'Chronic gastritis.', comment_text: 'Correlate clinically.', flag: 'N', is_critical: false,
  synoptic: [], ancillary: [], image_ids: [], diagnosis_codes: [] };
const DEF = {
  schema_version: 1, title: 'Synthetic checklist', applies_to_case_kinds: ['histology'],
  sections: [{ key: 'tumour', heading: 'Tumour', fields: [
    { key: 'site', label: 'Site', type: 'text', required: true, max_length: 20 },
    { key: 'grade', label: 'Grade', type: 'single_select', required: true, options: [{ code: 'g1', display: 'Grade 1' }, { code: 'g2', display: 'Grade 2' }] },
  ] }],
};

interface Opts {
  n?: number; kind?: string; status?: string; draftKind?: 'initial' | 'revision' | 'amendment'; draft?: Row | null; prior?: boolean; primaries?: number; approved?: number[]; fdStatus?: Record<number, string>;
  missingFromOrder?: number[]; canAmend?: boolean; labPreSeed?: boolean; case?: Row;
}
interface W { caseId: string; centre: string; items: { id: string; orderItemId: string }[]; addon: { id: string; orderItemId: string }; draftId: string; draftVersion: number; lab: any; fd: any; port: any }
function world(o: Opts = {}): W {
  const n = o.n ?? 1, base = n * 1000;
  const caseId = uid(base + 1), order = uid(base + 2), draftId = uid(base + 9);
  const prior = o.prior ?? false, draftKind = o.draftKind ?? 'initial';
  const status = o.status ?? (draftKind === 'initial' ? 'ready_for_reporting' : 'signed_out');
  S.cases.set(caseId, { id: caseId, tenant_id: T, centre_id: C_A1, order_id: order, case_kind: o.kind ?? 'histology', status, version: 5, accession_no: `SYN-H-${n}`, current_version_no: prior ? 1 : 0,
    signed_out_at: prior ? FIRST_SIGNED : null, ...o.case });
  for (const [letter, site] of [['B', 'Body'], ['A', 'Antrum']] as const) S.parts.set(uid(base + (letter === 'A' ? 31 : 32)), { id: uid(base + (letter === 'A' ? 31 : 32)), tenant_id: T, case_id: caseId, letter, letter_seq: letter === 'A' ? 1 : 2, site_text: site, version: 1 });
  const primaries = o.primaries ?? 2;
  const items = Array.from({ length: primaries }, (_, k) => ({ id: uid(base + 10 + k), orderItemId: uid(base + 20 + k) }));
  const addon = { id: uid(base + 15), orderItemId: uid(base + 25) }, dead = { id: uid(base + 16), orderItemId: uid(base + 26) };
  for (const [it, role, active] of [...items.map((x) => [x, 'primary', true]), [addon, 'addon', true], [dead, 'primary', false]] as [typeof addon, string, boolean][]) {
    S.items.set(it.id, { id: it.id, tenant_id: T, centre_id: C_A1, case_id: caseId, order_item_id: it.orderItemId, test_id: uid(base + 40), role, is_active: active, version: 1 });
  }
  if (o.draft !== null) {
    S.drafts.set(draftId, { id: draftId, tenant_id: T, centre_id: C_A1, case_id: caseId, kind: draftKind, status: 'open', change_reason_code: draftKind === 'initial' ? null : 'correction',
      change_reason_text: draftKind === 'initial' ? null : 'Typo in diagnosis', ...GOOD, base_version_no: prior ? 1 : 0, consumed_version_no: null, consumed_at: null, discarded_at: null, version: 3,
      created_by: ACTOR, updated_by: ACTOR, ...o.draft });
  }
  if (prior) {
    const vid = uid(base + 50);
    S.versions.set(vid, { id: vid, tenant_id: T, centre_id: C_A1, case_id: caseId, version_no: 1, version_kind: 'original', scope: 'full', impression_text: 'Earlier impression.', signed_at: FIRST_SIGNED, signed_by_membership_id: MEMBERSHIP,
      synoptic: [], images: [], specimen_parts: [], slides: [], ancillary: [], molecular: [], addenda: [], diagnosis_codes: [] });
    items.forEach((it, k) => S.subs.set(uid(base + 60 + k), { id: uid(base + 60 + k), tenant_id: T, centre_id: C_A1, case_id: caseId, case_item_id: it.id, item_version_no: 1, report_version_id: vid,
      idempotency_key: `anatomic:${it.id}:1`, lab_result_id: uid(base + 70 + k), lab_version_no: 1, lab_status: 'resulted', replayed: false, submitted_at: FIRST_SIGNED, created_by: ACTOR }));
  }
  const approved = new Set(o.approved ?? []);
  const results = items.map((it, k) => ({ id: uid(base + 70 + k), tenantId: T, orderItemId: it.orderItemId, testId: uid(base + 40), analyteId: uid(base + 41), versionNo: 1,
    status: approved.has(k) ? 'approved' : prior ? 'resulted' : 'pending', origin: approved.has(k) || prior ? 'module' : 'manual', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false,
    ...(prior ? { lastPayloadVersion: 1, lastPhase: 'final' } : {}), ...(approved.has(k) ? { approvedAt: '2026-11-11T04:00:00.000Z' } : {}) }));
  const labItems = [...items, addon, dead].map((it) => ({ id: it.orderItemId, tenantId: T, orderId: order, testId: uid(base + 40), departmentId: uid(base + 42), workflowType: 'anatomic' }));
  const lab = createFakeLabPort({ seed: 7, fixtures: {
    grants: o.canAmend === false ? {} : { [ACTOR]: ['lab.result.amend'] },
    orders: [{ id: order, tenantId: T, patientId: uid(base + 43), centreId: C_A1, priority: 'routine', patient: { sex: 'female', ageDays: 12000 } }], items: labItems, results,
  } as any });
  const fdItems = [...items, addon, dead].map((it, k) => ({ orderItemId: it.orderItemId, orderableId: uid(base + 44), orderableKind: 'test', testIds: [uid(base + 40)], priority: 'routine',
    status: o.fdStatus?.[k] ?? 'active', outsourced: false }));
  const fd = createFakeFrontdeskPort({ seed: 9, fixtures: { orders: [{ orderId: order, tenantId: T, registrationNo: '0001SY000009', patientId: uid(base + 43), branchId: uid(base + 45), centreId: C_A1,
    visitType: 'opd', billingMode: 'cash', priority: 'routine', status: 'registered', source: 'front_desk', items: fdItems.filter((_, k) => !(o.missingFromOrder ?? []).includes(k)), registeredAt: NOW, version: 1 }] } as any });
  const port = { ...lab, async submitModuleResult(c: unknown, i: unknown) {
    S.log.push('port'); S.portCalls++;
    if (S.portFailAt && S.portCalls === S.portFailAt) throw new LimsError('lab.module_result_invalid');
    return lab.submitModuleResult(c as never, i as never);
  } };
  return { caseId, centre: C_A1, items, addon, draftId, draftVersion: 3, lab, fd, port };
}

interface CtxOpts { deny?: Record<string, string>; tenant?: string; actorType?: string; denyCentre?: string }
const calls = { assertRole: [] as Row[], logs: [] as string[], access: [] as Row[] };
const mkCtx = (w: W, o: CtxOpts = {}) => ({
  operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999),
  log: { info: (x: object) => calls.logs.push(JSON.stringify(x)), warn: (x: object) => calls.logs.push(JSON.stringify(x)), error: (x: object) => calls.logs.push(JSON.stringify(x)), debug: (x: object) => calls.logs.push(JSON.stringify(x)) },
  tenantId: o.tenant ?? T, actor: { type: o.actorType ?? 'user', id: ACTOR, membershipId: MEMBERSHIP },
  tx: { undo: [] as (() => void)[], async query(sql: string) { throw new Error(`unexpected SQL in a unit test: ${String(sql).slice(0, 80)}`); } },
  now: () => new Date(NOW),
  audit: { async access(x: Row) { calls.access.push(structuredClone(x)); } },
  core: { async branch() { return { branchCode: 'KTM' }; }, memberships: { async list() { return []; } }, async user() { return { displayName: 'Dr Synthetic One' }; } },
  ports: {
    IdentityPort: {
      async assertRole(_c: unknown, i: Row) {
        calls.assertRole.push(structuredClone(i)); S.log.push(`assert:${i['permission']}`);
        const d = o.deny?.[i['permission']]; if (d) throw new LimsError(d);
        if (o.denyCentre && i['centreId'] === o.denyCentre) throw new LimsError('common.not_found');
      },
      async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; },
    },
    LabPort: w.port, FrontdeskPort: w.fd, CatalogPort: { async getTest() { return { name: 'Synthetic test', workflowType: 'anatomic' }; } },
  },
}) as any;

/** emulates requestTx: a throwing handler rolls back every write made through ctx.tx; the case row lock lives until the transaction ends */
async function call(op: string, req: Row, ctx: any): Promise<any> {
  try { return await (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx); } catch (e) {
    for (const u of [...ctx.tx.undo].reverse()) u();
    throw e;
  } finally { releaseLocks(ctx.tx); }
}
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const signReq = (w: W, rev?: number, extra: Row = {}) => ({ params: { case_id: w.caseId }, headers: { 'if-match': `"${rev ?? w.draftVersion}"`, 'idempotency-key': 'key-0001' }, body: { attest: true }, ...extra });
const sign = (w: W, o: { rev?: number; ctx?: any; extra?: Row } = {}) => call('signOutAnatomicCase', signReq(w, o.rev, o.extra), o.ctx ?? mkCtx(w));
const stored = () => JSON.stringify({ c: [...S.cases], d: [...S.drafts], v: [...S.versions], s: [...S.subs], t: S.transitions });
const versions = (caseId: string) => [...S.versions.values()].filter((v) => v['case_id'] === caseId).sort((a, b) => a['version_no'] - b['version_no']);
const subs = (caseId: string) => [...S.subs.values()].filter((s) => s['case_id'] === caseId);
const portInputs = (w: W) => (w.lab.calls('submitModuleResult') as { input: Row }[]).map((c) => c.input);
const is = (e: any, code: string, status?: number) => { expect(isLimsError(e, code), `expected ${code}, got ${e?.code}`).toBe(true); if (status) expect((e as LimsError).statusCode).toBe(status); };
const keysDeep = (x: unknown): string[] => Array.isArray(x) ? x.flatMap(keysDeep) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...keysDeep(v)]) : [];
const hasNoNulls = (x: unknown): boolean => x === null ? false : Array.isArray(x) ? x.every(hasNoNulls) : x && typeof x === 'object' ? Object.values(x).every(hasNoNulls) : true;
const nothingHappened = (w: W, before: string) => {
  expect(stored()).toBe(before); expect(w.lab.calls('submitModuleResult')).toHaveLength(0); expect(calls.access).toHaveLength(0);
};

/** 03-IC §6.8 / 05-SCHEMA §8: the published view row of one submission = its report_versions row joined by report_version_id (the SQL view is checked live + by T-17) */
const viewRow = (s: Row) => {
  const v = S.versions.get(s['report_version_id'])!, ci = S.items.get(s['case_item_id'])!, c = S.cases.get(s['case_id'])!;
  return { tenant_id: s['tenant_id'], entity_id: s['case_item_id'], version_no: s['item_version_no'], order_item_id: ci['order_item_id'], accession_no: c['accession_no'], case_kind: c['case_kind'],
    gross_text: v['gross_text'], microscopy_text: v['microscopy_text'], impression_text: v['impression_text'], synoptic: v['synoptic'], images: v['images'], signed_by_membership_id: v['signed_by_membership_id'],
    signed_at: v['signed_at'], version_kind: v['version_kind'], scope: v['scope'], change_reason_code: v['change_reason_code'], clinical_history_text: v['clinical_history_text'], comment_text: v['comment_text'],
    specimen_parts: v['specimen_parts'], slides: v['slides'], ancillary: v['ancillary'], molecular: v['molecular'], addenda: v['addenda'], diagnosis_codes: v['diagnosis_codes'] };
};

beforeEach(() => {
  for (const m of [S.cases, S.items, S.drafts, S.versions, S.subs, S.parts, S.images, S.templates, S.diagnoses, S.stainOrders, S.assays, S.targets, S.values, S.molecular, S.locks]) (m as Map<unknown, unknown>).clear();
  S.transitions.length = 0; S.log.length = 0; S.writes = 0; S.portCalls = 0; S.portFailAt = 0; S.dbFail = undefined; S.dbCalls = {};
  calls.assertRole.length = 0; calls.logs.length = 0; calls.access.length = 0;
});
afterEach(() => { S.locks.clear(); });

// ================================================================================================ AC-09.1
describe('R3 signOutAnatomicCase — initial sign-out of a histology case (AC-09.1, 02-TRD §4.4)', () => {
  it('AC-09.1: 200 { case, report_version }: case signed_out at version 1, report version 1 kind original scope full, one submission per active primary item at lab status resulted; no nulls on the wire', async () => {
    const w = world();
    const r = await sign(w);
    expect(r.status).toBe(200);
    expect(r.body.case).toMatchObject({ id: w.caseId, status: 'signed_out', current_version_no: 1, signed_out_at: NOW });
    expect(r.body.report_version).toMatchObject({ version_no: 1, version_kind: 'original', scope: 'full', signed_at: NOW });
    expect(typeof r.body.report_version.signed_by_display_name).toBe('string');
    expect(r.body.report_version.signed_by_display_name.length).toBeGreaterThan(0);
    expect('change_reason_code' in r.body.report_version).toBe(false);
    expect(r.body.report_version.submissions).toEqual(w.items.map((it) => ({ case_item_id: it.id, order_item_id: it.orderItemId, item_version_no: 1, lab_status_at_submit: 'resulted' })));
    expect(hasNoNulls(r.body)).toBe(true);
    for (const k of ['tenant_id', 'centre_id', 'created_by', 'signed_by_membership_id']) expect(keysDeep(r.body.report_version), k).not.toContain(k);
  });
  it('AC-09.1: LabPort.submitModuleResult is called ONCE per active primary case item (not the add-on, not the inactive one), in case_item id order, with the A1 payload; no isCritical and no amendment for an initial draft', async () => {
    const w = world({ n: 2 });
    await sign(w);
    const ins = portInputs(w);
    expect(ins).toHaveLength(2);
    expect(ins.map((i) => i['orderItemId'])).toEqual(w.items.map((it) => it.orderItemId));
    ins.forEach((i, k) => {
      expect(i).toMatchObject({ orderItemId: w.items[k]!.orderItemId, kind: 'narrative', reportPhase: 'final', summaryText: GOOD.impression_text, flag: 'N',
        payloadRef: { module: 'anatomic', entityId: w.items[k]!.id, versionNo: 1 }, idempotencyKey: `anatomic:${w.items[k]!.id}:1` });
      expect(new Date(i['submittedAt']).toISOString()).toBe(NOW);
      expect('isCritical' in i).toBe(false);
      expect('amendment' in i).toBe(false);
    });
  });
  it('AC-09.1: the stored report version is the immutable snapshot of the draft: tenant/centre/case, version_no 1, original/full, content columns, signer membership and time, no change reason', async () => {
    const w = world({ n: 3, case: { clinical_history_text: 'Epigastric pain.' } });
    await sign(w);
    const [v, ...more] = versions(w.caseId);
    expect(more).toEqual([]);
    expect(v).toMatchObject({ tenant_id: T, centre_id: C_A1, case_id: w.caseId, version_no: 1, version_kind: 'original', scope: 'full', clinical_history_text: 'Epigastric pain.',
      gross_text: GOOD.gross_text, microscopy_text: GOOD.microscopy_text, impression_text: GOOD.impression_text, comment_text: GOOD.comment_text, flag: 'N', is_critical: false,
      signed_by_membership_id: MEMBERSHIP, created_by: ACTOR, addenda: [], molecular: [], images: [], synoptic: [] });
    expect(new Date(v!['signed_at']).toISOString()).toBe(NOW);
    expect(v!['change_reason_code'] ?? null).toBeNull();
    expect(v!['specimen_parts']).toEqual([{ letter: 'A', site_text: 'Antrum' }, { letter: 'B', site_text: 'Body' }]);
  });
  it('AC-09.1: one item_submissions row per target: key anatomic:<case_item>:1, the lab result id/version/status, replayed false, linked to the version', async () => {
    const w = world({ n: 4 });
    await sign(w);
    const v = versions(w.caseId)[0]!;
    const rows = subs(w.caseId).sort((a, b) => (a['case_item_id'] < b['case_item_id'] ? -1 : 1));
    expect(rows).toHaveLength(2);
    rows.forEach((s, k) => {
      expect(s).toMatchObject({ tenant_id: T, centre_id: C_A1, case_id: w.caseId, case_item_id: w.items[k]!.id, item_version_no: 1, report_version_id: v['id'], idempotency_key: `anatomic:${w.items[k]!.id}:1`,
        lab_result_id: uid(4070 + k), lab_version_no: 1, lab_status: 'resulted', replayed: false, created_by: ACTOR });
      expect(new Date(s['submitted_at']).toISOString()).toBe(NOW);
    });
  });
  it('AC-09.1: the case moves to signed_out (current_version_no 1, signed_out_at, version + 1) and the draft is consumed with the version number; no open draft remains', async () => {
    const w = world({ n: 5 });
    await sign(w);
    expect(S.cases.get(w.caseId)).toMatchObject({ status: 'signed_out', current_version_no: 1, version: 6 });
    expect(new Date(S.cases.get(w.caseId)!['signed_out_at']).toISOString()).toBe(NOW);
    expect(S.drafts.get(w.draftId)).toMatchObject({ status: 'consumed', consumed_version_no: 1 });
    expect(new Date(S.drafts.get(w.draftId)!['consumed_at']).toISOString()).toBe(NOW);
    expect([...S.drafts.values()].filter((d) => d['status'] === 'open')).toEqual([]);
  });
  it('done_when order: the privilege check first, ALL port calls, then report_versions, then item_submissions — never a write before a port call', async () => {
    const w = world({ n: 6 });
    await sign(w);
    const seen = S.log.filter((x) => x === 'port' || x === 'insertVersion' || x === 'insertSubmission' || x.startsWith('assert:'));
    expect(seen).toEqual(['assert:anatomic.case.signout', 'port', 'port', 'insertVersion', 'insertSubmission', 'insertSubmission']);
  });
  it('REQ-SEC-096/097: exactly one access-log row anatomic_report.sign_out on anatomic_case / case id with detail.version_no; assertRole carried the case centre', async () => {
    const w = world({ n: 7 });
    await sign(w);
    expect(calls.access).toHaveLength(1);
    expect(calls.access[0]).toMatchObject({ action: 'anatomic_report.sign_out', entityType: 'anatomic_case', entityId: w.caseId, detail: { version_no: 1 } });
    expect(calls.assertRole.find((a) => a['permission'] === 'anatomic.case.signout')).toMatchObject({ permission: 'anatomic.case.signout', centreId: C_A1 });
  });
  it('AC-09.8: the published-view row of every submission equals the signed snapshot (entity_id = case item, version_no = item version, order item, accession, columns of the version)', async () => {
    const w = world({ n: 8 });
    await sign(w);
    const rows = subs(w.caseId).map(viewRow);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => `${r.entity_id}:${r.version_no}`)).size).toBe(2); // exactly one row per (entity_id, version_no)
    const v = versions(w.caseId)[0]!;
    for (const r of rows) {
      expect(r).toMatchObject({ tenant_id: T, version_no: 1, accession_no: 'SYN-H-8', case_kind: 'histology', gross_text: GOOD.gross_text, microscopy_text: GOOD.microscopy_text, impression_text: GOOD.impression_text,
        comment_text: GOOD.comment_text, version_kind: 'original', scope: 'full', signed_by_membership_id: MEMBERSHIP, synoptic: v['synoptic'], images: v['images'], specimen_parts: v['specimen_parts'] });
    }
    expect(rows.map((r) => r.order_item_id)).toEqual(w.items.map((it) => it.orderItemId));
  });
  it('AC-09.1/09.8: a full draft (synoptic, two images in print order, diagnosis codes, molecular-free) is stored as display snapshots with exactly the 05-SCHEMA §5 keys', async () => {
    const w = world({ n: 9, draft: { synoptic: [{ template_id: uid(9701), template_key: 'synth_a', template_version: 2, title: 'Synthetic checklist', values: { site: 'Left lobe', grade: 'g2' } }],
      image_ids: [uid(9602), uid(9601)], diagnosis_codes: ['LOC-0001', 'LOC-0002'] } });
    S.templates.set(uid(9701), { id: uid(9701), tenant_id: T, template_key: 'synth_a', version_no: 2, status: 'published', title: 'Synthetic checklist', applies_to_case_kinds: ['histology'], definition: DEF });
    for (const [n, cap] of [[1, 'Antral mucosa'], [2, null]] as const) {
      S.images.set(uid(9600 + n), { id: uid(9600 + n), tenant_id: T, case_id: w.caseId, centre_id: C_A1, kind: 'microscopy', state: 'ready', scan_state: 'clean', is_active: true, bucket: 'anatomic-images',
        object_path: `${T}/2026/11/${uid(9600 + n)}.png`, sha256: SHA(String(n)), caption: cap, mime_type: 'image/png', version: 1 });
    }
    S.diagnoses.set(uid(9801), { id: uid(9801), tenant_id: T, code: 'LOC-0001', display: 'Chronic gastritis', system: 'local', system_version: null, sort_order: 0, is_active: true });
    S.diagnoses.set(uid(9802), { id: uid(9802), tenant_id: T, code: 'LOC-0002', display: 'Intestinal metaplasia', system: 'local', system_version: '1', sort_order: 0, is_active: true });
    await sign(w);
    const v = versions(w.caseId)[0]!;
    expect(v['synoptic']).toEqual([{ template_key: 'synth_a', template_version: 2, title: 'Synthetic checklist', sections: [{ heading: 'Tumour', items: [{ label: 'Site', value: 'Left lobe' }, { label: 'Grade', value: 'Grade 2' }] }] }]);
    expect(v['images']).toEqual([
      { bucket: 'anatomic-images', object_path: `${T}/2026/11/${uid(9602)}.png`, sha256: SHA('2') },
      { bucket: 'anatomic-images', object_path: `${T}/2026/11/${uid(9601)}.png`, sha256: SHA('1'), caption: 'Antral mucosa' },
    ]);
    expect(v['diagnosis_codes']).toEqual([{ code: 'LOC-0001', display: 'Chronic gastritis', system: 'local' }, { code: 'LOC-0002', display: 'Intestinal metaplasia', system: 'local', system_version: '1' }]);
  });
  it('REQ-SEC-098: nothing of the report text is logged or echoed (impression marker absent from every log line and from the response keys)', async () => {
    const w = world({ n: 10, draft: { impression_text: `${MARKER} impression` } });
    await sign(w);
    expect(calls.logs.join('\n')).not.toContain(MARKER);
  });
  it('a cytology case needs no gross text (§4.5.3: gross is required for histology only)', async () => {
    const w = world({ n: 11, kind: 'cytology', draft: { gross_text: '' } });
    expect((await sign(w)).status).toBe(200);
  });
});

// ================================================================================================ AC-09.10
describe('AC-09.10 summaryText truncation through the whole flow', () => {
  it('an impression of 4,001+ characters: summaryText = first 3,990 chars + " […]" (≤ 4,000) at the port, the FULL text is stored in the version (and so in the view)', async () => {
    const long = Array.from({ length: 4300 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const w = world({ n: 12, draft: { impression_text: long } });
    await sign(w);
    for (const i of portInputs(w)) { expect(i['summaryText']).toBe(`${long.slice(0, 3990)} […]`); expect(i['summaryText'].length).toBeLessThanOrEqual(4000); }
    expect(versions(w.caseId)[0]!['impression_text']).toBe(long);
    expect(viewRow(subs(w.caseId)[0]!).impression_text).toBe(long);
  });
  it('an impression of exactly 4,000 characters is submitted unchanged', async () => {
    const t = 'z'.repeat(4000);
    const w = world({ n: 13, draft: { impression_text: t } });
    await sign(w);
    expect(portInputs(w)[0]!['summaryText']).toBe(t);
  });
});

// ================================================================================================ AC-09.2 / 09.3 / AB-4
describe('privilege (AC-09.2, AC-09.3, AB-4, REQ-SEC-062/067)', () => {
  it('AC-09.2: a pathologist at aal1 → 403 auth.mfa_required (propagated unchanged) and NOTHING changes (no lab call, no write, no access log)', async () => {
    const w = world({ n: 14 }); const before = stored(); S.writes = 0;
    const e = await rejects(sign(w, { ctx: mkCtx(w, { deny: { 'anatomic.case.signout': 'auth.mfa_required' } }) }));
    is(e, 'auth.mfa_required', 403);
    nothingHappened(w, before); expect(S.writes).toBe(0);
  });
  it('AC-09.3: a technologist without anatomic.case.signout → 403 auth.forbidden, nothing changes', async () => {
    const w = world({ n: 15 }); const before = stored();
    const e = await rejects(sign(w, { ctx: mkCtx(w, { deny: { 'anatomic.case.signout': 'auth.forbidden' } }) }));
    is(e, 'auth.forbidden', 403);
    nothingHappened(w, before);
  });
  it('holding only anatomic.case.work is not enough: the permission asserted is exactly anatomic.case.signout', async () => {
    const w = world({ n: 16 }); const before = stored();
    const ctx = mkCtx(w, { deny: { 'anatomic.case.signout': 'auth.forbidden' } }); // the work permission is granted by this fake, the signout one is not
    is(await rejects(sign(w, { ctx })), 'auth.forbidden');
    expect(calls.assertRole.map((a) => a['permission'])).toContain('anatomic.case.signout');
    nothingHappened(w, before);
  });
  it('a system actor (worker) can never sign out, even when the permission check passes (02-TRD §3.2 DECISION) → 403 auth.forbidden', async () => {
    const w = world({ n: 17 }); const before = stored();
    is(await rejects(sign(w, { ctx: mkCtx(w, { actorType: 'system' }) })), 'auth.forbidden', 403);
    nothingHappened(w, before);
  });
  it('a case of another tenant → 404 common.not_found, no lab call (looks like an unknown id); a malformed id → 404', async () => {
    const w = world({ n: 18 }); const before = stored();
    is(await rejects(sign(w, { ctx: mkCtx(w, { tenant: T_OTHER }) })), 'common.not_found', 404);
    is(await rejects(call('signOutAnatomicCase', { ...signReq(w), params: { case_id: 'not-a-uuid' } }, mkCtx(w))), 'common.not_found', 404);
    nothingHappened(w, before);
  });
  it('a centre the actor cannot see: the assertRole refusal (not_found) ends the request before any lab call', async () => {
    const w = world({ n: 19 }); const before = stored();
    is(await rejects(sign(w, { ctx: mkCtx(w, { denyCentre: C_A1 }) })), 'common.not_found');
    nothingHappened(w, before);
  });
});

// ================================================================================================ request + state guards
describe('request, draft and state guards (02-TRD §4.4 steps 2–3)', () => {
  it('body is a closed { attest: true }: missing, false, "true", unknown key → 400 common.validation_failed, nothing changes', async () => {
    const w = world({ n: 20 }); const before = stored();
    for (const body of [{}, { attest: false }, { attest: 'true' }, { attest: true, force: true }, undefined]) {
      const e = await rejects(sign(w, { extra: { body } }));
      is(e, 'common.validation_failed', 400);
    }
    const e = await rejects(sign(w, { extra: { body: { attest: false } } }));
    expect((e as LimsError).errors?.some((f) => f.path === '/attest'), JSON.stringify((e as LimsError).errors)).toBe(true);
    nothingHappened(w, before);
  });
  it('If-Match absent → 428 common.precondition_required; malformed → 400; stale or future draft version → 409 common.version_conflict; nothing changes', async () => {
    const w = world({ n: 21 }); const before = stored();
    is(await rejects(call('signOutAnatomicCase', { ...signReq(w), headers: {} }, mkCtx(w))), 'common.precondition_required', 428);
    is(await rejects(call('signOutAnatomicCase', { ...signReq(w), headers: { 'if-match': 'abc' } }, mkCtx(w))), 'common.validation_failed', 400);
    for (const rev of [1, 2, 4, 99]) is(await rejects(sign(w, { rev })), 'common.version_conflict', 409);
    nothingHappened(w, before);
  });
  it('no open draft (never saved, or already consumed/discarded) → 409 anatomic.case_invalid_transition', async () => {
    const w = world({ n: 22, draft: null });
    is(await rejects(sign(w)), 'anatomic.case_invalid_transition', 409);
    const w2 = world({ n: 23, draft: { status: 'discarded', discarded_at: NOW } });
    is(await rejects(sign(w2)), 'anatomic.case_invalid_transition', 409);
    for (const x of [w, w2]) { expect(versions(x.caseId)).toEqual([]); expect(x.lab.calls('submitModuleResult')).toHaveLength(0); expect(S.cases.get(x.caseId)).toMatchObject({ status: 'ready_for_reporting', version: 5 }); }
  });
  it.each(['received', 'accessioned', 'in_processing', 'cancelled'])('an initial draft on a %s case → 409 anatomic.case_invalid_transition (only ready_for_reporting may be signed out), nothing changes', async (status) => {
    const w = world({ n: 24, status }); const before = stored();
    is(await rejects(sign(w)), 'anatomic.case_invalid_transition', 409);
    nothingHappened(w, before);
  });
  it.each(['ready_for_reporting', 'in_processing'])('a revision draft on a %s case → 409 (change drafts need signed_out)', async (status) => {
    const w = world({ n: 25, status, draftKind: 'revision', prior: true }); const before = stored();
    is(await rejects(sign(w)), 'anatomic.case_invalid_transition', 409);
    nothingHappened(w, before);
  });
});

// ================================================================================================ completeness
describe('completeness at sign-out → 422 anatomic.report_incomplete with errors[] (02-TRD §4.5.3)', () => {
  const incomplete = async (w: W) => {
    const before = stored();
    const e = await rejects(sign(w));
    is(e, 'anatomic.report_incomplete', 422);
    nothingHappened(w, before);
    return ((e as LimsError).errors ?? []).map((f) => f.path);
  };
  it('histology without gross text → /gross_text; any kind without impression → /impression_text; both are reported together', async () => {
    expect(await incomplete(world({ n: 30, draft: { gross_text: '' } }))).toEqual(['/gross_text']);
    expect(await incomplete(world({ n: 31, draft: { impression_text: '' } }))).toEqual(['/impression_text']);
    expect((await incomplete(world({ n: 32, draft: { gross_text: '', impression_text: '' } }))).sort()).toEqual(['/gross_text', '/impression_text']);
  });
  it('every visible required synoptic field must be present: /synoptic/<i>/values/<key> (hidden fields are not required)', async () => {
    const w = world({ n: 33, draft: { synoptic: [{ template_id: uid(9701), template_key: 'synth_a', template_version: 2, title: 'Synthetic checklist', values: { site: 'Left lobe' } }] } });
    S.templates.set(uid(9701), { id: uid(9701), tenant_id: T, template_key: 'synth_a', version_no: 2, status: 'published', title: 'Synthetic checklist', applies_to_case_kinds: ['histology'], definition: DEF });
    expect(await incomplete(w)).toEqual(['/synoptic/0/values/grade']);
  });
  it('an included image must be ready and active and of this case: not ready, deactivated, other case → /image_ids/<i>', async () => {
    const w = world({ n: 34, draft: { image_ids: [uid(9611), uid(9612), uid(9613), uid(9614)] } });
    const img = (n: number, over: Row) => S.images.set(uid(9610 + n), { id: uid(9610 + n), tenant_id: T, case_id: w.caseId, centre_id: C_A1, kind: 'gross', state: 'ready', scan_state: 'clean', is_active: true, bucket: 'anatomic-images',
      object_path: `${T}/2026/11/x${n}.png`, sha256: SHA('c'), ...over });
    img(1, {}); img(2, { state: 'processing', scan_state: 'pending' }); img(3, { is_active: false }); img(4, { case_id: uid(777) });
    expect((await incomplete(w)).sort()).toEqual(['/image_ids/1', '/image_ids/2', '/image_ids/3']);
  });
  it('every ancillary result must reference a COMPLETED stain order of this case → /ancillary/<i>/stain_order_id', async () => {
    const w = world({ n: 35, draft: { ancillary: [{ stain_order_id: uid(9801), result_text: 'Positive' }, { stain_order_id: uid(9802), result_text: 'Negative' }, { stain_order_id: uid(9803), result_text: 'x' }] } });
    const so = (n: number, over: Row) => S.stainOrders.set(uid(9800 + n), { id: uid(9800 + n), tenant_id: T, case_id: w.caseId, centre_id: C_A1, stain_code: 'IHC_CK7', stain_kind: 'ihc', status: 'completed', version: 3, ...over });
    so(1, {}); so(2, { status: 'in_progress' }); so(3, { case_id: uid(778) });
    expect((await incomplete(w)).sort()).toEqual(['/ancillary/1/stain_order_id', '/ancillary/2/stain_order_id']);
  });
  it('molecular: no active result → /molecular…; a result invalid against its assay (inactive target) → /molecular/<i>/…', async () => {
    const none = await incomplete(world({ n: 36, kind: 'molecular', draft: { gross_text: '' } }));
    expect(none.length).toBeGreaterThan(0); expect(none.every((p) => p.startsWith('/molecular'))).toBe(true);
    const w = world({ n: 37, kind: 'molecular', draft: { gross_text: '' } });
    seedMolecular(w, { targetActive: false });
    const bad = await incomplete(w);
    expect(bad.length).toBeGreaterThan(0); expect(bad.every((p) => p.startsWith('/molecular/0'))).toBe(true);
  });
  it('completeness is checked BEFORE the order items and the lab: an incomplete draft on a case with a cancelled item reports report_incomplete, no lab call', async () => {
    const w = world({ n: 38, draft: { impression_text: '' }, fdStatus: { 0: 'cancelled' } });
    await incomplete(w);
  });
});

// ================================================================================================ AC-09.9
describe('AC-09.9 order item no longer active at the front desk → 409 anatomic.order_item_inactive', () => {
  it.each(['cancelled', 'removed'])('item status %s → 409, the problem names the order item id, no lab call, nothing changes', async (st) => {
    const w = world({ n: 40, fdStatus: { 1: st } }); const before = stored();
    const e = await rejects(sign(w));
    is(e, 'anatomic.order_item_inactive', 409);
    expect(String((e as LimsError).detail ?? '')).toContain(w.items[1]!.orderItemId);
    nothingHappened(w, before);
  });
  it('an item missing from the order summary is inactive too; a cancelled ADD-ON item (not a target) does not block the sign-out', async () => {
    const w = world({ n: 41, missingFromOrder: [0] });
    is(await rejects(sign(w)), 'anatomic.order_item_inactive', 409);
    const w2 = world({ n: 42, fdStatus: { 2: 'cancelled', 3: 'cancelled' } }); // indexes 2 = add-on, 3 = inactive case item: neither is a target
    expect((await sign(w2)).status).toBe(200);
  });
});

// ================================================================================================ AC-09.4
describe('AC-09.4 port failure → the whole transaction rolls back and the error is returned unchanged (02-TRD §4.4, 08 A17 P-23)', () => {
  it.each(['lab.module_result_invalid', 'lab.result_locked', 'lab.result_invalid_transition', 'lab.module_result_stale', 'lab.amendment_reason_required'])('%s from the port → same code and status, no version, case and draft unchanged', async (code) => {
    const w = world({ n: 50 }); const before = stored();
    w.lab.failNext('submitModuleResult', code as never);
    const e = await rejects(sign(w));
    is(e, code, new LimsError(code).statusCode);
    expect(e).toBeInstanceOf(LimsError);
    expect(e.detail).toBeUndefined(); expect(e.errors).toBeUndefined();
    expect(stored()).toBe(before);
    expect(versions(w.caseId)).toEqual([]); expect(subs(w.caseId)).toEqual([]);
    expect(S.cases.get(w.caseId)).toMatchObject({ status: 'ready_for_reporting', current_version_no: 0, version: 5 });
    expect(S.drafts.get(w.draftId)).toMatchObject({ status: 'open', version: 3 });
    expect(calls.access).toEqual([]);
  });
  it('the SECOND target fails after the first was accepted: still no version, no submission, case unchanged', async () => {
    const w = world({ n: 51 }); const before = stored(); S.portFailAt = 2;
    is(await rejects(sign(w)), 'lab.module_result_invalid', new LimsError('lab.module_result_invalid').statusCode);
    expect(S.portCalls).toBe(2);
    expect(stored()).toBe(before);
  });
  it('a database failure AFTER the port calls (inserting the 2nd submission / updating the case) rolls back version and submissions too and surfaces as an error', async () => {
    for (const [name, at] of [['insertItemSubmission', 2], ['updateCase', 1], ['updateReportDraft', 1]] as const) {
      const w = world({ n: 52 }); const before = stored(); S.dbFail = { name, at }; S.dbCalls = {};
      const e = await rejects(sign(w));
      expect(e, name).toBeInstanceOf(Error); expect(e.message).toBe('simulated db failure');
      expect(stored(), name).toBe(before);
      for (const m of [S.cases, S.items, S.drafts, S.versions, S.subs, S.parts]) m.clear();
    }
  });
  it('a retry after a failed attempt succeeds as version 1 with item version 1 (the failed attempt left no item version behind)', async () => {
    const w = world({ n: 53 });
    w.lab.failNext('submitModuleResult', 'lab.module_result_invalid');
    await rejects(sign(w));
    const r = await sign(w);
    expect(r.body.report_version.version_no).toBe(1);
    expect(subs(w.caseId).every((s) => s['item_version_no'] === 1)).toBe(true);
  });
});

// ================================================================================================ AC-09.5
describe('AC-09.5 idempotency (Idempotency-Key is replayed by the core hook; the handler itself must also be safe)', () => {
  it('the same request repeated after success (draft already consumed) → 409 anatomic.case_invalid_transition and NO second version, submission or lab call', async () => {
    const w = world({ n: 60 });
    await sign(w);
    const snapshot = stored(), labCalls = portInputs(w).length;
    is(await rejects(sign(w)), 'anatomic.case_invalid_transition', 409);
    expect(stored()).toBe(snapshot); expect(portInputs(w)).toHaveLength(labCalls); expect(versions(w.caseId)).toHaveLength(1); expect(calls.access).toHaveLength(1);
  });
  it('a retry whose earlier attempt reached C5 but never committed: the fake replays by key anatomic:<item>:1 → replayed: true is recorded, still ONE version and ONE row per item', async () => {
    const w = world({ n: 61 });
    const pre = await w.lab.submitModuleResult(mkCtx(w), { orderItemId: w.items[0]!.orderItemId, kind: 'narrative', reportPhase: 'final', payloadRef: { module: 'anatomic', entityId: w.items[0]!.id, versionNo: 1 },
      summaryText: 'earlier attempt', submittedAt: NOW, idempotencyKey: `anatomic:${w.items[0]!.id}:1` });
    const r = await sign(w);
    const rows = subs(w.caseId).sort((a, b) => (a['case_item_id'] < b['case_item_id'] ? -1 : 1));
    expect(rows.map((s) => s['replayed'])).toEqual([true, false]);
    expect(rows[0]).toMatchObject({ lab_result_id: pre.resultId, lab_version_no: pre.versionNo });
    expect(versions(w.caseId)).toHaveLength(1); expect(r.body.report_version.version_no).toBe(1);
  });
  it('two sign-outs of the same draft at the same time (double click): exactly one wins; the other is a clean 409, never a raw unique violation; one version, one submission per item', async () => {
    const w = world({ n: 62 });
    const rs = await Promise.allSettled([sign(w), sign(w)]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = (rs.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason;
    expect(lost).toBeInstanceOf(LimsError); expect((lost as LimsError).statusCode).toBe(409);
    expect(['common.version_conflict', 'anatomic.case_invalid_transition']).toContain((lost as LimsError).code);
    expect(versions(w.caseId)).toHaveLength(1); expect(subs(w.caseId)).toHaveLength(2); expect(calls.access).toHaveLength(1);
  });
  // AB-9 (same Idempotency-Key, modified body → 422 common.idempotency_key_reused; missing key → common.idempotency_key_required) is enforced by the C0 core hook from `x-idempotency: required`
  // of operation R3 in contracts/openapi/anatomic.yaml; it is covered by the core contract tests and the boot test (every POST is R). Not re-implemented here.
});

// ================================================================================================ AC-09.6 + AC-09.7
function seedMolecular(w: W, o: { targetActive?: boolean } = {}) {
  const t = T;
  S.assays.set(uid(9901), { id: uid(9901), tenant_id: t, code: 'EGFR_PANEL', display: 'EGFR panel', is_active: true });
  S.targets.set(uid(9902), { id: uid(9902), tenant_id: t, assay_id: uid(9901), code: 'L858R', display: 'L858R mutation', allows_quantitative: false, is_active: o.targetActive ?? true });
  S.values.set(uid(9903), { id: uid(9903), tenant_id: t, target_id: uid(9902), code: 'DETECTED', display: 'Detected', is_abnormal: true, is_active: true });
  S.molecular.set(uid(9904), { id: uid(9904), tenant_id: t, centre_id: C_A1, case_id: w.caseId, assay_id: uid(9901), assay_code: 'EGFR_PANEL', target_id: uid(9902), target_code: 'L858R', result_value_id: uid(9903),
    result_code: 'DETECTED', value_decimal: null, unit_code: null, method_text: 'PCR', kit_name: 'KitX', kit_lot: null, kit_expiry_on: '2027-01-31', batch_id: null, comment_text: null, version: 1, is_active: true });
}
describe('AC-09.6 molecular case → kind structured, non-empty molecular array', () => {
  it('port kind is "structured" and the version/view row carries the molecular result with display names and only the 05-SCHEMA §5 keys', async () => {
    const w = world({ n: 70, kind: 'molecular', draft: { gross_text: '' } });
    seedMolecular(w);
    await sign(w);
    expect(portInputs(w).every((i) => i['kind'] === 'structured')).toBe(true);
    const m = versions(w.caseId)[0]!['molecular'];
    expect(m).toEqual([{ assay_code: 'EGFR_PANEL', assay_display: 'EGFR panel', target_code: 'L858R', target_display: 'L858R mutation', result_code: 'DETECTED', result_display: 'Detected', is_abnormal: true,
      method_text: 'PCR', kit_name: 'KitX', kit_expiry_on: '2027-01-31' }]);
    expect(viewRow(subs(w.caseId)[0]!).molecular).toEqual(m);
    expect(viewRow(subs(w.caseId)[0]!).case_kind).toBe('molecular');
  });
  it('a histology case is "narrative" (never structured)', async () => {
    const w = world({ n: 71 }); await sign(w);
    expect(portInputs(w).every((i) => i['kind'] === 'narrative')).toBe(true);
  });
});
describe('AC-09.7 critical finding', () => {
  it('"Critical finding" ticked → isCritical: true on every submission and is_critical true in the version', async () => {
    const w = world({ n: 72, draft: { is_critical: true } });
    await sign(w);
    expect(portInputs(w).map((i) => i['isCritical'])).toEqual([true, true]);
    expect(versions(w.caseId)[0]!['is_critical']).toBe(true);
  });
  it('not ticked → the isCritical key is absent (C5 raises no critical event); an abnormal flag A is passed as flag', async () => {
    const w = world({ n: 73, draft: { is_critical: false, flag: 'A' } });
    await sign(w);
    for (const i of portInputs(w)) { expect('isCritical' in i).toBe(false); expect(i['flag']).toBe('A'); }
  });
});

// ================================================================================================ revision / amendment (version_kind decided after the port calls)
describe('change drafts: the stored version_kind is decided from the port results (02-TRD §4.4 step 8, 08 R1, D-7)', () => {
  it('revision draft, targets not approved: item version 2, report version 2 kind revision with the reason; amendment { reasonCode, reasonText } sent but ignored by C5 (lab version stays 1); signed_out_at keeps the FIRST time', async () => {
    const w = world({ n: 80, draftKind: 'revision', prior: true });
    const r = await sign(w);
    expect(r.body.report_version).toMatchObject({ version_no: 2, version_kind: 'revision', change_reason_code: 'correction' });
    for (const [k, i] of portInputs(w).entries()) {
      expect(i).toMatchObject({ payloadRef: { module: 'anatomic', entityId: w.items[k]!.id, versionNo: 2 }, idempotencyKey: `anatomic:${w.items[k]!.id}:2`, amendment: { reasonCode: 'correction', reasonText: 'Typo in diagnosis' } });
    }
    expect(versions(w.caseId).map((v) => [v['version_no'], v['version_kind']])).toEqual([[1, 'original'], [2, 'revision']]);
    expect(versions(w.caseId)[1]).toMatchObject({ change_reason_code: 'correction', change_reason_text: 'Typo in diagnosis', scope: 'full' });
    expect(subs(w.caseId).filter((s) => s['item_version_no'] === 2).every((s) => s['lab_version_no'] === 1 && s['lab_status'] === 'resulted')).toBe(true);
    expect(S.cases.get(w.caseId)).toMatchObject({ status: 'signed_out', current_version_no: 2 });
    expect(new Date(S.cases.get(w.caseId)!['signed_out_at']).toISOString()).toBe(FIRST_SIGNED);
  });
  it('E10 race: a REVISION draft whose target C5 approved meanwhile signs as an AMENDMENT (lab version 2, status approved), no lab.amendment_reason_required', async () => {
    const w = world({ n: 81, draftKind: 'revision', prior: true, approved: [0, 1] });
    const r = await sign(w);
    expect(r.body.report_version).toMatchObject({ version_no: 2, version_kind: 'amendment', change_reason_code: 'correction' });
    expect(subs(w.caseId).filter((s) => s['item_version_no'] === 2).map((s) => [s['lab_version_no'], s['lab_status']])).toEqual([[2, 'approved'], [2, 'approved']]);
    expect(versions(w.caseId)[1]!['version_kind']).toBe('amendment');
  });
  it('two targets, only one approved → the version is stored as amendment', async () => {
    const w = world({ n: 82, draftKind: 'amendment', prior: true, approved: [1] });
    const r = await sign(w);
    expect(r.body.report_version.version_kind).toBe('amendment');
    expect(subs(w.caseId).filter((s) => s['item_version_no'] === 2).map((s) => s['lab_status']).sort()).toEqual(['approved', 'resulted']);
  });
  it('AB-12: approved target and the pathologist lacks lab.result.amend → lab.result_locked from C5 passes through and the whole sign-out rolls back', async () => {
    const w = world({ n: 83, draftKind: 'amendment', prior: true, approved: [0], canAmend: false }); const before = stored();
    const e = await rejects(sign(w));
    is(e, 'lab.result_locked', new LimsError('lab.result_locked').statusCode);
    expect(stored()).toBe(before); expect(calls.access).toEqual([]);
  });
  it('an initial draft never carries an amendment even when the lab already knows the item; the report row for a revision has no addendum scope (scope full)', async () => {
    const w = world({ n: 84 });
    await sign(w);
    for (const i of portInputs(w)) expect('amendment' in i).toBe(false);
    expect(versions(w.caseId)[0]!['scope']).toBe('full');
  });
});
