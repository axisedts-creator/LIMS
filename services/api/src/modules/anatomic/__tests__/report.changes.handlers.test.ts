// C11.T-15 — R4 startAnatomicCaseChange, R5 discardAnatomicCaseChange, R6 listAnatomicReportVersions, R7 getAnatomicReportVersion, R8 createAnatomicAddendum, R9 updateAnatomicAddendum,
// R10 signAnatomicAddendum (02-TRD §4.4 "Change kind decision" + "Addendum signing" + "addenda in every full-scope version", §4.7.1/4.7.2, §5.3 R4–R10, §7 C6, §12 access log; 01-PRD AC-10.1 … AC-10.8,
// AC-03.4, AC-03.5; 07-SECURITY §5.1–5.3 (cross-tenant, privilege, R4 system reason codes), REQ-SEC-096/097/098; 08 A17 D-62 (reason codes: format only), D-66 (edits after sign-out), 08 R1 (`amendment`),
// 08 A17 P-23 (port errors unchanged)). Drives the REAL handlers (manifest.handlers.*) with the REAL @lims/fakes LabPort (D-7 versioning, `amendment` rules, failNext) and FrontdeskPort fakes on IN-MEMORY
// repositories (vi.mock with the T-04 signatures; same emulation as report.signout.handlers.test.ts: NOT NULLs, CHECKs, uniques -> 23505, If-Match versions, case row lock of getCase({forUpdate:true}) until the
// request transaction ends, undo journal that a throwing handler rolls back). R3/R2/A6/A7 are the existing T-13/T-14/T-06 handlers: they are used here only to prove the change/addendum flows end to end.
//
// SEAMS (the spec fixes behaviour; names/orders below are chosen here — the writer follows or disputes):
//   * R4: params { case_id }; header 'if-match' = '"<case.version>"'; body closed { reason_code ^[a-z0-9_]{1,64}$ (required), reason_text? ≤500 }; the system codes module_phase_progression /
//     module_preliminary_update / supplementary_report -> 400 common.validation_failed at '/reason_code'. Order: load case (404; getCase forUpdate:true) -> IdentityPort.assertRole({ permission:
//     'anatomic.case.signout', centreId: case.centre_id }) (its auth.* passes through BEFORE anything else) -> actor type must be 'user' -> If-Match (428 / 400 / 409 common.version_conflict) -> body (400)
//     -> state guard (case must be signed_out, no open draft of any kind: else 409 anatomic.case_invalid_transition). Kind: LabPort.getOrderResults(ctx, { orderId, scope: 'all_visible' }); a result with
//     origin 'module', status 'approved' whose orderItemId is an ACTIVE PRIMARY item of the case -> 'amendment', else 'revision'. Nothing is sent to C5 (no submitModuleResult). Response 201 ReportDraft
//     (02-TRD §5.5: case_id, kind, change_reason_code, change_reason_text?, the four texts, flag?, is_critical, synoptic[], image_ids[], ancillary[], diagnosis_codes[], updated_at, updated_by_display_name,
//     version 1; no nulls) prefilled from the latest FULL version; stored row: kind, status 'open', change_reason_*, base_version_no = case.current_version_no, created_by/updated_by = actor.
//   * R5: params { case_id }; 'if-match' = '"<draft.version>"'; privileged like R4; 204 with no body; draft -> status 'discarded' + discarded_at; the case row is not touched; no open CHANGE draft (none, or the open
//     one is an initial draft) -> 409 anatomic.case_invalid_transition; stale -> 409 common.version_conflict.
//   * R6: params { case_id }; assertRole 'anatomic.case.read' (case centre); 200 { data: ReportVersionSummary[] } newest first, at most 200, summary keys only (no content columns, no ids of tenant/centre/membership);
//     no access-log row. R7: params { case_id, version_no }; assertRole 'anatomic.case.read'; 200 ReportVersion = summary + content columns; exactly one ctx.audit.access({ action: 'anatomic_report.view',
//     entityType: 'anatomic_case', entityId: case id, detail: { version_no } }) on success, none on any failure; unknown number -> 404 common.not_found; malformed number -> 400 or 404 (never 500).
//   * R8: params { case_id }; assertRole 'anatomic.case.work'; body closed { kind ihc|special_stain|molecular|other, text 1–8000 (plain text, §4.6), stain_order_ids? uuid[] ≤20 of THIS case, addon_case_item_id? an
//     ACTIVE case item of this case with role 'addon' }; failures of the body -> 400 common.validation_failed with the JSON pointer ('/kind', '/text', '/stain_order_ids', '/stain_order_ids/<i>', '/addon_case_item_id');
//     case not signed_out -> 409 anatomic.case_invalid_transition (checked before the body). 201 Addendum { id, kind, text, stain_order_ids, addon_case_item_id?, status 'draft', version 1 } (no nulls); row seq = 1 +
//     max(seq of the case); nothing is sent to C5 and no version is written.
//   * R9: params { addendum_id }; 'if-match' = '"<addendum.version>"'; assertRole 'anatomic.case.work'; a signed addendum -> 409 anatomic.signout_locked (before If-Match); 200 Addendum with version + 1; only text and
//     stain_order_ids change (the bodies below keep kind/addon_case_item_id as created).
//   * R10: params { addendum_id }; 'if-match' = '"<addendum.version>"'; body closed { attest: true }; load addendum (404) -> case (forUpdate) -> assertRole 'anatomic.case.signout' -> actor 'user' -> body ->
//     addendum must be a draft (signed -> 409 anatomic.case_invalid_transition) -> If-Match -> case signed_out -> every referenced stain order must be 'completed' (422 anatomic.report_incomplete at
//     '/stain_order_ids/<i>', errors together) -> targets (add-on item, or active primary items in case_item id order) must be active at the front desk (409 anatomic.order_item_inactive) -> LabPort calls ->
//     report_versions -> item_submissions -> addendum + case update. LabPort input: payloadRef { module 'anatomic', entityId case item, versionNo v }, v = 1 + max item_version_no of THAT case item,
//     idempotencyKey 'anatomic:<case_item>:<v>', reportPhase 'final', amendment EXACTLY { reasonCode: 'supplementary_report' } (both scopes). Stored version: version_no = case.current_version_no + 1,
//     version_kind 'addendum' (whatever C5 answered), scope 'full' (change_reason_* null, addon_case_item_id null) or 'addendum_only' (addon_case_item_id set), addendum_id = the addendum. Full scope = the sections of the
//     latest FULL version (never an addendum_only one) + addenda; addendum_only = §4.7.2. Addendum row: status 'signed', signed_at = ctx.now(), signed_by_membership_id = actor.membershipId, report_version_no = n.
//     Case: current_version_no n, version + 1, status stays signed_out, signed_out_at unchanged. Response 200 SignOutResult. Access log: exactly one 'anatomic_report.sign_out' detail { version_no: n }.
// Fails now: R4–R10 are `common.internal` stubs. Real PG + RLS counterparts: not part of this file (see .orchestra/notes/C11.T-15-tests.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError, isLimsError } from '../../../core/errors.js';
import { createFakeFrontdeskPort } from '../../../../../../packages/fakes/src/FrontdeskPort.fake.js';
import { createFakeLabPort } from '../../../../../../packages/fakes/src/LabPort.fake.js';
import { TENANT_A, TENANT_B } from '../../../../../../packages/fakes/src/base.js';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  cases: new Map<string, Row>(), items: new Map<string, Row>(), drafts: new Map<string, Row>(), versions: new Map<string, Row>(), subs: new Map<string, Row>(), parts: new Map<string, Row>(),
  addenda: new Map<string, Row>(), stainOrders: new Map<string, Row>(), templates: new Map<string, Row>(), transitions: [] as Row[],
  log: [] as string[], writes: 0, portCalls: 0, portFailAt: 0, dbFail: undefined as undefined | { name: string; at: number }, dbCalls: {} as Record<string, number>,
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
const clean = (row: Row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null));

const CASES_UPDATABLE = ['branch_id', 'status', 'priority', 'accession_no', 'accession_series', 'accession_year', 'clinical_history_text', 'assigned_pathologist_membership_id', 'profile_missing', 'current_version_no', 'molecular_rev',
  'accessioned_at', 'accessioned_by', 'signed_out_at', 'cancelled_at', 'cancel_reason_code', 'cancel_reason_text'];
const DRAFT_COLS = ['status', 'change_reason_code', 'change_reason_text', 'gross_text', 'microscopy_text', 'impression_text', 'comment_text', 'flag', 'is_critical', 'synoptic', 'ancillary', 'image_ids', 'diagnosis_codes',
  'consumed_version_no', 'consumed_at', 'discarded_at'];
const ADDENDA_COLS = ['text', 'stain_order_ids', 'status', 'signed_at', 'signed_by_membership_id', 'report_version_no'];

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
  async insertReportDraft(tx: unknown, row: Row) {
    touch(); S.log.push('insertDraft'); maybeFail('insertReportDraft');
    for (const k of ['id', 'tenant_id', 'centre_id', 'case_id', 'kind', 'created_by', 'updated_by']) if (!row[k]) throw pgErr('23502', `report_drafts__${k}__notnull`);
    if (!['initial', 'revision', 'amendment'].includes(row['kind'])) throw pgErr('23514', 'report_drafts__kind__ck');
    if (row['kind'] !== 'initial' && !row['change_reason_code']) throw pgErr('23514', 'report_drafts__reason__ck');
    if ((row['change_reason_code'] && !/^[a-z0-9_]{1,64}$/.test(row['change_reason_code'])) || String(row['change_reason_text'] ?? '').length > 500) throw pgErr('23514', 'report_drafts__reason_fmt__ck');
    if (row['flag'] != null && !['N', 'A'].includes(row['flag'])) throw pgErr('23514', 'report_drafts__flag__ck');
    const r: Row = { status: 'open', gross_text: '', microscopy_text: '', impression_text: '', comment_text: '', is_critical: false, synoptic: [], ancillary: [], image_ids: [], diagnosis_codes: [], base_version_no: 0,
      change_reason_code: null, change_reason_text: null, flag: null, consumed_version_no: null, consumed_at: null, discarded_at: null, version: 1, updated_at: new Date('2026-11-13T04:00:00.000Z'), ...clean(row) };
    if (r['status'] === 'open' && [...S.drafts.values()].some((d) => d['tenant_id'] === r['tenant_id'] && d['case_id'] === r['case_id'] && d['status'] === 'open')) throw pgErr('23505', 'report_drafts__tenant_id_case_open__p_uq');
    S.drafts.set(r['id'], r); undo(tx, () => S.drafts.delete(r['id'])); return structuredClone(r);
  },
  async getReportDraft(_tx: unknown, i: Row) { const r = S.drafts.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? structuredClone(r) : undefined; },
  async listReportDrafts(_tx: unknown, i: Row) { return mine(S.drafts, i).filter((d) => d['case_id'] === i['caseId']).map((d) => structuredClone(d)); },
  async getOpenDraft(_tx: unknown, i: Row) { const r = mine(S.drafts, i).find((d) => d['case_id'] === i['caseId'] && d['status'] === 'open'); return r ? structuredClone(r) : undefined; },
  async updateReportDraft(tx: unknown, i: Row) {
    touch(); maybeFail('updateReportDraft');
    for (const k of Object.keys(i['patch'])) if (i['patch'][k] !== undefined && !DRAFT_COLS.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
    const r = S.drafts.get(i['id']);
    if (!r || r['tenant_id'] !== i['tenantId'] || r['version'] !== i['expectedVersion']) return undefined;
    if (r['status'] !== 'open') throw Object.assign(new Error('immutable_row'), { code: 'P0001' });
    const next = { ...r, ...Object.fromEntries(Object.entries(i['patch']).filter(([, v]) => v !== undefined)), version: r['version'] + 1, updated_by: i['actorId'], updated_at: new Date('2026-11-13T04:00:00.000Z') };
    if (next['status'] === 'consumed' && !(next['consumed_version_no'] >= 1 && next['consumed_at'])) throw pgErr('23514', 'report_drafts__consumed__ck');
    if (next['status'] === 'discarded' && !next['discarded_at']) throw pgErr('23514', 'report_drafts__discarded__ck');
    S.drafts.set(i['id'], next); undo(tx, () => S.drafts.set(i['id'], r)); return structuredClone(next);
  },
}));
vi.mock('../repository/versions.repo.js', () => ({
  async insertReportVersion(tx: unknown, row: Row) {
    touch(); S.log.push('insertVersion'); maybeFail('insertReportVersion');
    for (const k of ['id', 'tenant_id', 'centre_id', 'case_id', 'version_no', 'version_kind', 'signed_by_membership_id', 'signed_at', 'created_by']) if (!row[k]) throw pgErr('23502', `report_versions__${k}__notnull`);
    const arr = (v: unknown) => (v === undefined || v === null ? [] : v);
    const r: Row = {
      scope: 'full', addon_case_item_id: null, addendum_id: null, change_reason_code: null, change_reason_text: null, clinical_history_text: '', gross_text: '', microscopy_text: '', impression_text: '', comment_text: '',
      flag: null, is_critical: false, ...clean(row),
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
    if (r['addendum_id'] && !S.addenda.get(r['addendum_id'])) throw pgErr('23503', 'report_versions__addendum__fk');
    if (r['addon_case_item_id'] && S.items.get(r['addon_case_item_id'])?.['case_id'] !== r['case_id']) throw pgErr('23503', 'report_versions__addon__fk');
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
vi.mock('../repository/addenda.repo.js', () => ({
  async insertAddendum(tx: unknown, row: Row) {
    touch(); S.log.push('insertAddendum'); maybeFail('insertAddendum');
    for (const k of ['id', 'tenant_id', 'centre_id', 'case_id', 'seq', 'kind', 'text', 'created_by', 'updated_by']) if (row[k] === undefined || row[k] === null) throw pgErr('23502', `addenda__${k}__notnull`);
    if (!['ihc', 'special_stain', 'molecular', 'other'].includes(row['kind'])) throw pgErr('23514', 'addenda__kind__ck');
    if (row['text'].length < 1 || row['text'].length > 8000 || (row['stain_order_ids'] ?? []).length > 20) throw pgErr('23514', 'addenda__lens__ck');
    if (row['addon_case_item_id'] && S.items.get(row['addon_case_item_id'])?.['case_id'] !== row['case_id']) throw pgErr('23503', 'addenda__addon__fk');
    if ([...S.addenda.values()].some((a) => a['tenant_id'] === row['tenant_id'] && a['case_id'] === row['case_id'] && a['seq'] === row['seq'])) throw pgErr('23505', 'addenda__tenant_id_case_seq__uq');
    const r: Row = { stain_order_ids: [], addon_case_item_id: null, status: 'draft', signed_at: null, signed_by_membership_id: null, report_version_no: null, version: 1, ...clean(row) };
    S.addenda.set(r['id'], r); undo(tx, () => S.addenda.delete(r['id'])); return structuredClone(r);
  },
  async getAddendum(_tx: unknown, i: Row) { const r = S.addenda.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? structuredClone(r) : undefined; },
  async listAddenda(_tx: unknown, i: Row) { return mine(S.addenda, i).filter((a) => a['case_id'] === i['caseId']).sort((a, b) => a['seq'] - b['seq']).map((a) => structuredClone(a)); },
  async updateAddendum(tx: unknown, i: Row) {
    touch(); maybeFail('updateAddendum');
    for (const k of Object.keys(i['patch'])) if (i['patch'][k] !== undefined && !ADDENDA_COLS.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
    const r = S.addenda.get(i['id']);
    if (!r || r['tenant_id'] !== i['tenantId'] || r['version'] !== i['expectedVersion']) return undefined;
    if (r['status'] === 'signed') throw Object.assign(new Error('immutable_row'), { code: 'P0001' });
    const next = { ...r, ...Object.fromEntries(Object.entries(i['patch']).filter(([, v]) => v !== undefined)), version: r['version'] + 1, updated_by: i['actorId'] };
    if ((next['status'] === 'signed') !== !!(next['signed_at'] && next['signed_by_membership_id'] && next['report_version_no'])) throw pgErr('23514', 'addenda__status__ck');
    S.addenda.set(i['id'], next); undo(tx, () => S.addenda.set(i['id'], r)); return structuredClone(next);
  },
}));
vi.mock('../repository/parts.repo.js', () => ({
  async listParts(_tx: unknown, i: Row) { return mine(S.parts, i).filter((p) => p['case_id'] === i['caseId']).map((p) => ({ ...p })); },
  async getPart(_tx: unknown, i: Row) { const r = S.parts.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async insertPart() { touch(); S.log.push('insertPart'); },
  async updatePart(tx: unknown, i: Row) {
    touch(); const r = S.parts.get(i['id']);
    if (!r || r['tenant_id'] !== i['tenantId'] || r['version'] !== i['expectedVersion']) return undefined;
    const next = { ...r, ...Object.fromEntries(Object.entries(i['patch']).filter(([, v]) => v !== undefined)), version: r['version'] + 1 };
    S.parts.set(i['id'], next); undo(tx, () => S.parts.set(i['id'], r)); return { ...next };
  },
}));
vi.mock('../repository/stainOrders.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return {
    ...m,
    async getStainOrder(_tx: unknown, i: Row) { const r = S.stainOrders.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
    async listStainOrders(_tx: unknown, i: Row) { return mine(S.stainOrders, i).filter((r) => r['case_id'] === i['caseId']).map((r) => ({ ...r })); },
  };
});
vi.mock('../repository/images.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return { ...m, async getImage() { return undefined; }, async listImages() { return []; } };
});
vi.mock('../repository/templates.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return { ...m, async getSynopticTemplate(_tx: unknown, i: Row) { const t = S.templates.get(i['id']); return t && t['tenant_id'] === i['tenantId'] ? { ...t } : undefined; }, async listSynopticTemplates() { return []; } };
});
vi.mock('../repository/codedValues.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return { ...m, async getCodedDiagnosis() { return undefined; }, async listCodedDiagnoses() { return []; } };
});
vi.mock('../repository/config.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return { ...m, async getSettings() { return undefined; }, async listAssays() { return []; }, async getAssay() { return undefined; }, async listStains() { return []; } };
});
const emptyRepo = vi.hoisted(() => async (orig: () => Promise<unknown>) => {
  const m = (await orig()) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(m).map((k) => [k, async () => (k.startsWith('list') ? [] : undefined)]));
});
vi.mock('../repository/molecular.repo.js', emptyRepo); vi.mock('../repository/slides.repo.js', emptyRepo); vi.mock('../repository/blocks.repo.js', emptyRepo); vi.mock('../repository/gross.repo.js', emptyRepo);
vi.mock('../repository/movements.repo.js', emptyRepo); vi.mock('../repository/specimenLinks.repo.js', emptyRepo); vi.mock('../repository/batches.repo.js', emptyRepo); vi.mock('../repository/counters.repo.js', emptyRepo);

const { manifest } = await import('../index.js');

// ------------------------------------------------------------------------------------------------ ids + fixtures
const uid = (n: number) => `0190c415-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = TENANT_A, T_OTHER = TENANT_B, ACTOR = '01a1a98a-ac40-7000-8000-00000000a300', MEMBERSHIP = uid(5000);
const C_A1 = '01a1a98a-ac40-7000-8000-00000000a201';
const NOW = '2026-11-13T04:00:00.000Z', FIRST_SIGNED = '2026-11-10T05:00:00.000Z';
const MARKER = 'SYNTHETIC-CHANGE-PHI-MARKER';
const SHA = (c: string) => c.repeat(64);
const SYSTEM_CODES = ['supplementary_report', 'module_phase_progression', 'module_preliminary_update'];
/** the sections of version 1 (original, full) — every later full version of an addendum must carry them unchanged (AC-10.4) */
const PRIOR = {
  clinical_history_text: 'Epigastric pain.', gross_text: 'A. Antrum: two fragments.', microscopy_text: 'Mucosa with mild gastritis.', impression_text: 'Chronic gastritis.', comment_text: 'Correlate clinically.',
  flag: 'N', is_critical: false,
  synoptic: [{ template_key: 'synth_a', template_version: 2, title: 'Synthetic checklist', sections: [{ heading: 'Tumour', items: [{ label: 'Site', value: 'Left lobe' }] }] }],
  images: [{ bucket: 'anatomic-images', object_path: `${T}/2026/11/orig.png`, sha256: SHA('a'), caption: 'Antral mucosa' }],
  specimen_parts: [{ letter: 'A', site_text: 'Antrum' }, { letter: 'B', site_text: 'Body' }], slides: [{ label: 'S1', stain_display: 'H&E' }], molecular: [],
  diagnosis_codes: [{ code: 'LOC-0001', display: 'Chronic gastritis', system: 'local' }],
};
const DRAFT_CONTENT = { gross_text: PRIOR.gross_text, microscopy_text: PRIOR.microscopy_text, impression_text: PRIOR.impression_text, comment_text: PRIOR.comment_text, flag: 'N', is_critical: false,
  synoptic: [], ancillary: [], image_ids: [], diagnosis_codes: [] };

interface Opts {
  n?: number; kind?: string; status?: string; primaries?: number; approved?: number[]; manualApproved?: number[]; addonApproved?: boolean; canAmend?: boolean; fdStatus?: Record<number, string>;
  draft?: 'initial' | 'revision' | 'amendment'; prior?: boolean; case?: Row;
}
interface W { caseId: string; centre: string; items: { id: string; orderItemId: string }[]; addon: { id: string; orderItemId: string }; draftId: string; lab: any; fd: any; port: any; results: Row[]; orderId: string }
function world(o: Opts = {}): W {
  const n = o.n ?? 1, base = n * 1000;
  const caseId = uid(base + 1), order = uid(base + 2), draftId = uid(base + 9);
  const prior = o.prior ?? true;
  const status = o.status ?? (prior ? 'signed_out' : 'ready_for_reporting');
  S.cases.set(caseId, { id: caseId, tenant_id: T, centre_id: C_A1, order_id: order, case_kind: o.kind ?? 'histology', status, version: 5, accession_no: `SYN-H-${n}`, current_version_no: prior ? 1 : 0,
    signed_out_at: prior ? FIRST_SIGNED : null, clinical_history_text: PRIOR.clinical_history_text, ...o.case });
  for (const [letter, site, k] of [['A', 'Antrum', 31], ['B', 'Body', 32]] as const) S.parts.set(uid(base + k), { id: uid(base + k), tenant_id: T, case_id: caseId, letter, letter_seq: k - 30, site_text: site, version: 1 });
  const primaries = o.primaries ?? 2;
  const items = Array.from({ length: primaries }, (_, k) => ({ id: uid(base + 10 + k), orderItemId: uid(base + 20 + k) }));
  const addon = { id: uid(base + 15), orderItemId: uid(base + 25) }, dead = { id: uid(base + 16), orderItemId: uid(base + 26) };
  for (const [it, role, active] of [...items.map((x) => [x, 'primary', true]), [addon, 'addon', true], [dead, 'primary', false]] as [typeof addon, string, boolean][]) {
    S.items.set(it.id, { id: it.id, tenant_id: T, centre_id: C_A1, case_id: caseId, order_item_id: it.orderItemId, test_id: uid(base + 40), role, is_active: active, version: 1 });
  }
  if (o.draft) {
    S.drafts.set(draftId, { id: draftId, tenant_id: T, centre_id: C_A1, case_id: caseId, kind: o.draft, status: 'open', change_reason_code: o.draft === 'initial' ? null : 'correction',
      change_reason_text: o.draft === 'initial' ? null : 'Typo in diagnosis', ...DRAFT_CONTENT, base_version_no: prior ? 1 : 0, consumed_version_no: null, consumed_at: null, discarded_at: null, version: 3,
      created_by: ACTOR, updated_by: ACTOR, updated_at: new Date(NOW) });
  }
  if (prior) {
    const vid = uid(base + 50);
    S.versions.set(vid, { id: vid, tenant_id: T, centre_id: C_A1, case_id: caseId, version_no: 1, version_kind: 'original', scope: 'full', addon_case_item_id: null, addendum_id: null, change_reason_code: null, change_reason_text: null,
      ...PRIOR, ancillary: [], addenda: [], signed_at: FIRST_SIGNED, signed_by_membership_id: MEMBERSHIP, created_by: ACTOR });
    items.forEach((it, k) => S.subs.set(uid(base + 60 + k), { id: uid(base + 60 + k), tenant_id: T, centre_id: C_A1, case_id: caseId, case_item_id: it.id, item_version_no: 1, report_version_id: vid,
      idempotency_key: `anatomic:${it.id}:1`, lab_result_id: uid(base + 70 + k), lab_version_no: 1, lab_status: 'resulted', replayed: false, submitted_at: FIRST_SIGNED, created_by: ACTOR }));
  }
  const approved = new Set(o.approved ?? []), manual = new Set(o.manualApproved ?? []);
  const results: Row[] = items.map((it, k) => ({ id: uid(base + 70 + k), tenantId: T, orderItemId: it.orderItemId, testId: uid(base + 40), analyteId: uid(base + 41), versionNo: 1,
    status: approved.has(k) || manual.has(k) ? 'approved' : prior ? 'resulted' : 'pending', origin: manual.has(k) ? 'manual' : prior || approved.has(k) ? 'module' : 'manual', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false,
    ...(prior ? { lastPayloadVersion: 1, lastPhase: 'final' } : {}), ...(approved.has(k) || manual.has(k) ? { approvedAt: '2026-11-11T04:00:00.000Z' } : {}) }));
  results.push({ id: uid(base + 75), tenantId: T, orderItemId: addon.orderItemId, testId: uid(base + 40), analyteId: uid(base + 41), versionNo: 1, status: o.addonApproved ? 'approved' : 'pending', origin: o.addonApproved ? 'module' : 'manual',
    commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false, ...(o.addonApproved ? { approvedAt: '2026-11-11T04:00:00.000Z' } : {}) });
  const labItems = [...items, addon, dead].map((it) => ({ id: it.orderItemId, tenantId: T, orderId: order, testId: uid(base + 40), departmentId: uid(base + 42), workflowType: 'anatomic' }));
  const lab = createFakeLabPort({ seed: 7, fixtures: {
    grants: { [ACTOR]: ['lab.result.read', ...(o.canAmend === false ? [] : ['lab.result.amend'])] },
    orders: [{ id: order, tenantId: T, patientId: uid(base + 43), centreId: C_A1, priority: 'routine', patient: { sex: 'female', ageDays: 12000 } }], items: labItems, results,
  } as any });
  const fdItems = [...items, addon, dead].map((it, k) => ({ orderItemId: it.orderItemId, orderableId: uid(base + 44), orderableKind: 'test', testIds: [uid(base + 40)], priority: 'routine',
    status: o.fdStatus?.[k] ?? 'active', outsourced: false }));
  const fd = createFakeFrontdeskPort({ seed: 9, fixtures: { orders: [{ orderId: order, tenantId: T, registrationNo: '0001SY000009', patientId: uid(base + 43), branchId: uid(base + 45), centreId: C_A1,
    visitType: 'opd', billingMode: 'cash', priority: 'routine', status: 'registered', source: 'front_desk', items: fdItems, registeredAt: NOW, version: 1 }] } as any });
  const port = { ...lab, async submitModuleResult(c: unknown, i: unknown) {
    S.log.push('port'); S.portCalls++;
    if (S.portFailAt && S.portCalls === S.portFailAt) throw new LimsError('lab.module_result_invalid');
    return lab.submitModuleResult(c as never, i as never);
  } };
  return { caseId, centre: C_A1, items, addon, draftId, lab, fd, port, results, orderId: order };
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
const is = (e: any, code: string, status?: number) => { expect(isLimsError(e, code), `expected ${code}, got ${e?.code}`).toBe(true); if (status) expect((e as LimsError).statusCode).toBe(status); };
const keysDeep = (x: unknown): string[] => Array.isArray(x) ? x.flatMap(keysDeep) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...keysDeep(v)]) : [];
const hasNoNulls = (x: unknown): boolean => x === null ? false : Array.isArray(x) ? x.every(hasNoNulls) : x && typeof x === 'object' ? Object.values(x).every(hasNoNulls) : true;
const stored = () => JSON.stringify({ c: [...S.cases], d: [...S.drafts], v: [...S.versions], s: [...S.subs], a: [...S.addenda], p: [...S.parts], t: S.transitions });
const versions = (caseId: string) => [...S.versions.values()].filter((v) => v['case_id'] === caseId).sort((a, b) => a['version_no'] - b['version_no']);
const subs = (caseId: string) => [...S.subs.values()].filter((s) => s['case_id'] === caseId);
const portInputs = (w: W) => (w.lab.calls('submitModuleResult') as { input: Row }[]).map((c) => c.input);
const openDraft = (w: W) => [...S.drafts.values()].find((d) => d['case_id'] === w.caseId && d['status'] === 'open');
const iso = (v: unknown) => new Date(v as string).toISOString();
const nothingHappened = (w: W, before: string) => {
  expect(stored()).toBe(before); expect(w.lab.calls('submitModuleResult')).toHaveLength(0); expect(calls.access).toHaveLength(0);
};

// R4 / R5
const startReq = (w: W, body: Row = { reason_code: 'correction', reason_text: 'Typo in diagnosis' }, rev?: number, extra: Row = {}) => ({
  params: { case_id: w.caseId }, headers: { 'if-match': `"${rev ?? S.cases.get(w.caseId)?.['version']}"`, 'idempotency-key': 'key-0001' }, body, ...extra });
const start = (w: W, o: { body?: Row; rev?: number; ctx?: any; extra?: Row } = {}) => call('startAnatomicCaseChange', startReq(w, o.body, o.rev, o.extra), o.ctx ?? mkCtx(w));
const discardReq = (w: W, rev?: number, extra: Row = {}) => ({ params: { case_id: w.caseId }, headers: { 'if-match': `"${rev ?? openDraft(w)?.['version']}"`, 'idempotency-key': 'key-0004' }, body: {}, ...extra });
const discard = (w: W, o: { rev?: number; ctx?: any; extra?: Row } = {}) => call('discardAnatomicCaseChange', discardReq(w, o.rev, o.extra), o.ctx ?? mkCtx(w));
// R2 / R3 (existing handlers, used to finish the flows)
const saveDraft = (w: W, body: Row, ctx?: any) => call('saveAnatomicReportDraft', { params: { case_id: w.caseId }, headers: { 'if-match': `"${openDraft(w)?.['version']}"` }, body }, ctx ?? mkCtx(w));
const signChange = (w: W, ctx?: any) => call('signOutAnatomicCase', { params: { case_id: w.caseId }, headers: { 'if-match': `"${openDraft(w)?.['version']}"`, 'idempotency-key': 'key-0005' }, body: { attest: true } }, ctx ?? mkCtx(w));
// R8 – R10
const addReq = (w: W, body: Row = { kind: 'ihc', text: 'CK7 positive in tumour cells.' }) => ({ params: { case_id: w.caseId }, headers: { 'idempotency-key': 'key-0002' }, body });
const addAdd = (w: W, body?: Row, ctx?: any) => call('createAnatomicAddendum', addReq(w, body), ctx ?? mkCtx(w));
const updAdd = (w: W, id: string, body: Row, o: { rev?: number; ctx?: any; headers?: Row } = {}) =>
  call('updateAnatomicAddendum', { params: { addendum_id: id }, headers: o.headers ?? { 'if-match': `"${o.rev ?? S.addenda.get(id)?.['version']}"` }, body }, o.ctx ?? mkCtx(w));
const signAdd = (w: W, id: string, o: { rev?: number; ctx?: any; extra?: Row } = {}) =>
  call('signAnatomicAddendum', { params: { addendum_id: id }, headers: { 'if-match': `"${o.rev ?? S.addenda.get(id)?.['version']}"`, 'idempotency-key': 'key-0003' }, body: { attest: true }, ...o.extra }, o.ctx ?? mkCtx(w));
const newAddendum = async (w: W, body?: Row): Promise<string> => (await addAdd(w, body)).body.id;
const addendaOf = (caseId: string) => [...S.addenda.values()].filter((a) => a['case_id'] === caseId).sort((a, b) => a['seq'] - b['seq']);
const stainOrder = (w: W, n: number, over: Row = {}) => { const id = uid(8000 + n); S.stainOrders.set(id, { id, tenant_id: T, case_id: w.caseId, centre_id: C_A1, stain_code: 'IHC_CK7', stain_kind: 'ihc', status: 'completed', block_id: null, version: 3, ...over }); return id; };
const addendaView = (v: Row) => (v['addenda'] as Row[]).map((a) => ({ seq: a['seq'], kind: a['kind'], text: a['text'], signed_by_membership_id: a['signed_by_membership_id'], signed_at: iso(a['signed_at']) }));

beforeEach(() => {
  for (const m of [S.cases, S.items, S.drafts, S.versions, S.subs, S.parts, S.addenda, S.stainOrders, S.templates, S.locks]) (m as Map<unknown, unknown>).clear();
  S.transitions.length = 0; S.log.length = 0; S.writes = 0; S.portCalls = 0; S.portFailAt = 0; S.dbFail = undefined; S.dbCalls = {};
  calls.assertRole.length = 0; calls.logs.length = 0; calls.access.length = 0;
});
afterEach(() => { S.locks.clear(); });

// ================================================================================================ R4 — kind decision (AC-10.1, AC-10.2)
describe('R4 startAnatomicCaseChange — kind decision through LabPort (02-TRD §4.4 "Change kind decision", AC-10.1, AC-10.2)', () => {
  it('AC-10.1: C5 result resulted (not approved) → 201 ReportDraft kind "revision" with the reason, prefilled from the latest full version, version 1; stored open draft with base_version_no = current version', async () => {
    const w = world({ n: 1 });
    const r = await start(w, { body: { reason_code: 'transcription_error', reason_text: 'Wrong word' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ case_id: w.caseId, kind: 'revision', change_reason_code: 'transcription_error', change_reason_text: 'Wrong word', gross_text: PRIOR.gross_text, microscopy_text: PRIOR.microscopy_text,
      impression_text: PRIOR.impression_text, comment_text: PRIOR.comment_text, flag: 'N', is_critical: false, version: 1, updated_by_display_name: 'Dr Synthetic One' });
    expect(hasNoNulls(r.body)).toBe(true);
    for (const k of ['tenant_id', 'centre_id', 'created_by', 'id', 'status', 'base_version_no']) expect(keysDeep(r.body), k).not.toContain(k);
    const d = openDraft(w)!;
    expect(d).toMatchObject({ tenant_id: T, centre_id: C_A1, case_id: w.caseId, kind: 'revision', status: 'open', change_reason_code: 'transcription_error', change_reason_text: 'Wrong word', base_version_no: 1, created_by: ACTOR, updated_by: ACTOR });
    expect(w.lab.calls('getOrderResults').map((c: any) => c.input)).toEqual([{ orderId: w.orderId, scope: 'all_visible' }]);
  });
  it('AC-10.2: a target whose C5 result is approved → kind "amendment" (reason code and text kept); nothing is sent to C5 and the case is not touched', async () => {
    const w = world({ n: 2, approved: [0, 1] }); const caseBefore = JSON.stringify(S.cases.get(w.caseId));
    const r = await start(w, { body: { reason_code: 'correction', reason_text: 'Wrong laterality' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'amendment', change_reason_code: 'correction', change_reason_text: 'Wrong laterality' });
    expect(openDraft(w)).toMatchObject({ kind: 'amendment' });
    expect(w.lab.calls('submitModuleResult')).toHaveLength(0);
    expect(JSON.stringify(S.cases.get(w.caseId))).toBe(caseBefore);
    expect(versions(w.caseId)).toHaveLength(1); expect(calls.access).toHaveLength(0);
  });
  it('two targets, only ONE approved → "amendment"', async () => {
    const w = world({ n: 3, approved: [1] });
    expect((await start(w)).body.kind).toBe('amendment');
  });
  it('only targets count: an approved ADD-ON item or an approved result of origin "manual" does not make an amendment → "revision"', async () => {
    const a = world({ n: 4, addonApproved: true });
    expect((await start(a)).body.kind).toBe('revision');
    const b = world({ n: 5, manualApproved: [0] });
    expect((await start(b)).body.kind).toBe('revision');
  });
  it('the reason text is optional (key absent in the stored row and in the answer); reason_code is only FORMAT-checked: a well-formed code unknown to C5 is accepted (C5 validates at submission, D-62)', async () => {
    const w = world({ n: 6 });
    const r = await start(w, { body: { reason_code: 'not_a_c5_code_9' } });
    expect(r.status).toBe(201);
    expect('change_reason_text' in r.body).toBe(false);
    expect(openDraft(w)!['change_reason_text'] ?? null).toBeNull();
  });
  it('AC-10.1 end to end: start, edit (R2), sign (R3) → version 2 kind revision with reason, C5 receives item version 2 (versionNo 2) with amendment { reasonCode, reasonText } (ignored by C5 while not approved: lab version stays 1)', async () => {
    const w = world({ n: 7 });
    await start(w, { body: { reason_code: 'transcription_error', reason_text: 'Wrong word' } });
    await saveDraft(w, { ...DRAFT_CONTENT, impression_text: 'Chronic active gastritis.' });
    const r = await signChange(w);
    expect(r.body.report_version).toMatchObject({ version_no: 2, version_kind: 'revision', scope: 'full', change_reason_code: 'transcription_error' });
    for (const [k, i] of portInputs(w).entries()) {
      expect(i).toMatchObject({ payloadRef: { module: 'anatomic', entityId: w.items[k]!.id, versionNo: 2 }, idempotencyKey: `anatomic:${w.items[k]!.id}:2`, amendment: { reasonCode: 'transcription_error', reasonText: 'Wrong word' } });
    }
    expect(versions(w.caseId)[1]).toMatchObject({ version_no: 2, version_kind: 'revision', impression_text: 'Chronic active gastritis.', change_reason_code: 'transcription_error' });
    expect(subs(w.caseId).filter((s) => s['item_version_no'] === 2).every((s) => s['lab_version_no'] === 1 && s['lab_status'] === 'resulted')).toBe(true);
    expect(openDraft(w)).toBeUndefined(); // consumed by R3
  });
  it('prefill keeps the synoptic instances and ancillary results of the latest full version (02-TRD §5.3 R4): taken from its consumed draft; R3 after R4 signs a version whose synoptic/ancillary equal the original\'s', async () => {
    const w = world({ n: 9 });
    const tpl = uid(8500), so = stainOrder(w, 9);
    S.templates.set(tpl, { id: tpl, tenant_id: T, template_key: 'synth_a', version_no: 2, title: 'Synthetic checklist',
      definition: { title: 'Synthetic checklist', sections: [{ heading: 'Tumour', fields: [{ key: 'site', label: 'Site', type: 'text', required: true }] }] } });
    const synoptic = [{ template_id: tpl, template_key: 'synth_a', template_version: 2, title: 'Synthetic checklist', values: { site: 'Left lobe' } }];
    const ancillary = [{ stain_order_id: so, result_text: 'CK7 positive in tumour cells.' }];
    const did = uid(9009);
    S.drafts.set(did, { id: did, tenant_id: T, centre_id: C_A1, case_id: w.caseId, kind: 'initial', status: 'consumed', change_reason_code: null, change_reason_text: null, ...DRAFT_CONTENT, synoptic, ancillary,
      base_version_no: 0, consumed_version_no: 1, consumed_at: new Date(FIRST_SIGNED), discarded_at: null, version: 4, created_by: ACTOR, updated_by: ACTOR, updated_at: new Date(FIRST_SIGNED) });
    const original = { ...[...S.versions.values()].find((v) => v['case_id'] === w.caseId)!, ancillary: [{ stain_kind: 'ihc', stain_code: 'IHC_CK7', stain_display: 'IHC_CK7', result_text: ancillary[0]!.result_text }] };
    S.versions.set(original['id'], original);
    const r = await start(w);
    expect(r.status).toBe(201);
    expect(r.body.synoptic).toEqual(synoptic);
    expect(r.body.ancillary).toEqual(ancillary);
    await signChange(w); // no edit: what the R4 prefill carried is what gets signed
    const v2 = versions(w.caseId)[1]!;
    expect(v2['synoptic']).toEqual(original['synoptic']);
    expect(v2['ancillary']).toEqual(original['ancillary']);
  });
  it('AC-10.2 end to end: approved → amendment draft; on signing C5 receives version n+1 with amendment { reasonCode, reasonText } and the stored version is "amendment"; lab version 2, status approved', async () => {
    const w = world({ n: 8, approved: [0, 1] });
    await start(w, { body: { reason_code: 'correction', reason_text: 'Wrong laterality' } });
    const r = await signChange(w);
    expect(r.body.report_version).toMatchObject({ version_no: 2, version_kind: 'amendment', change_reason_code: 'correction' });
    for (const i of portInputs(w)) expect(i['amendment']).toEqual({ reasonCode: 'correction', reasonText: 'Wrong laterality' });
    expect(subs(w.caseId).filter((s) => s['item_version_no'] === 2).map((s) => [s['lab_version_no'], s['lab_status']])).toEqual([[2, 'approved'], [2, 'approved']]);
  });
  it('AC-10.8 / E10 race: a REVISION draft whose target C5 approves before the pathologist signs → R3 submits the draft reason as amendment, C5 accepts it (no lab.amendment_reason_required), stored version_kind "amendment"', async () => {
    const w = world({ n: 9 });
    expect((await start(w)).body.kind).toBe('revision');
    w.lab.__seed({ results: w.results.slice(0, 2).map((r) => ({ ...r, status: 'approved', approvedAt: '2026-11-12T04:00:00.000Z' })) }); // C5 approves meanwhile (the fake clones its fixtures)
    const r = await signChange(w);
    expect(r.status).toBe(200);
    expect(r.body.report_version).toMatchObject({ version_no: 2, version_kind: 'amendment', change_reason_code: 'correction' });
    for (const i of portInputs(w)) expect(i['amendment']).toEqual({ reasonCode: 'correction', reasonText: 'Typo in diagnosis' });
    expect(versions(w.caseId)[1]!['version_kind']).toBe('amendment');
    expect(subs(w.caseId).filter((s) => s['item_version_no'] === 2).every((s) => s['lab_status'] === 'approved' && s['lab_version_no'] === 2)).toBe(true);
  });
  it('AC-10.3 / AB-12: an amendment signed by an actor without lab.result.amend → lab.result_locked from C5 passes through; nothing changes: draft still open (same version), no version, case unchanged, no access log', async () => {
    const w = world({ n: 10, approved: [0], canAmend: false });
    await start(w);
    const before = stored(), draftVersion = openDraft(w)!['version'];
    const e = await rejects(signChange(w));
    is(e, 'lab.result_locked', new LimsError('lab.result_locked').statusCode);
    expect(e).toBeInstanceOf(LimsError);
    expect(stored()).toBe(before); expect(openDraft(w)!['version']).toBe(draftVersion);
    expect(versions(w.caseId)).toHaveLength(1); expect(calls.access).toHaveLength(0);
  });
});

// ================================================================================================ R4 — validation, state, privilege
describe('R4 validation, guards and privilege (AC-10.7, 07-SECURITY §5.3)', () => {
  it('reason_code missing / malformed / too long / not a string, reason_text > 500, unknown key → 400 common.validation_failed with the pointer; nothing changes', async () => {
    const w = world({ n: 11 }); const before = stored();
    for (const body of [{}, { reason_code: '' }, { reason_code: 'Bad Code' }, { reason_code: 'UPPER' }, { reason_code: 'a-b' }, { reason_code: 'x'.repeat(65) }, { reason_code: 12 }, { reason_code: null }]) {
      const e = await rejects(start(w, { body }));
      is(e, 'common.validation_failed', 400);
      expect((e as LimsError).errors?.some((f) => f.path === '/reason_code'), JSON.stringify(body)).toBe(true);
    }
    const t = await rejects(start(w, { body: { reason_code: 'correction', reason_text: 'x'.repeat(501) } }));
    is(t, 'common.validation_failed', 400); expect((t as LimsError).errors?.some((f) => f.path === '/reason_text')).toBe(true);
    is(await rejects(start(w, { body: { reason_code: 'correction', force: true } })), 'common.validation_failed', 400);
    is(await rejects(start(w, { extra: { body: undefined } })), 'common.validation_failed', 400);
    nothingHappened(w, before);
  });
  it('07-SECURITY §5.3: the system reason codes supplementary_report, module_phase_progression, module_preliminary_update → 400 common.validation_failed at /reason_code; no draft is written', async () => {
    const w = world({ n: 12 }); const before = stored();
    for (const code of SYSTEM_CODES) {
      const e = await rejects(start(w, { body: { reason_code: code } }));
      is(e, 'common.validation_failed', 400);
      expect((e as LimsError).errors?.some((f) => f.path === '/reason_code'), code).toBe(true);
    }
    nothingHappened(w, before);
  });
  it.each(['ready_for_reporting', 'in_processing', 'accessioned', 'received', 'cancelled'])('a %s case cannot start a change → 409 anatomic.case_invalid_transition, nothing changes', async (status) => {
    const w = world({ n: 13, status, prior: false }); const before = stored();
    is(await rejects(start(w)), 'anatomic.case_invalid_transition', 409);
    nothingHappened(w, before);
  });
  it('AC-10.7: an open change draft exists → another user starting one gets 409 anatomic.case_invalid_transition (one open change draft per case); the first draft is unchanged', async () => {
    const w = world({ n: 14 });
    await start(w);
    const first = JSON.stringify(openDraft(w));
    is(await rejects(start(w, { body: { reason_code: 'other_reason' } })), 'anatomic.case_invalid_transition', 409);
    expect([...S.drafts.values()].filter((d) => d['case_id'] === w.caseId && d['status'] === 'open')).toHaveLength(1);
    expect(JSON.stringify(openDraft(w))).toBe(first);
  });
  it('two users start at the same moment: exactly one draft; the loser gets a clean 409 (never a raw unique violation / 500)', async () => {
    const w = world({ n: 15 });
    const rs = await Promise.allSettled([start(w), start(w, { body: { reason_code: 'other_reason' } })]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = (rs.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason;
    expect(lost).toBeInstanceOf(LimsError); expect((lost as LimsError).statusCode).toBe(409);
    expect(['common.version_conflict', 'anatomic.case_invalid_transition']).toContain((lost as LimsError).code);
    expect([...S.drafts.values()].filter((d) => d['case_id'] === w.caseId)).toHaveLength(1);
  });
  it('If-Match (case version): absent → 428 common.precondition_required; malformed → 400; stale or future → 409 common.version_conflict; nothing changes', async () => {
    const w = world({ n: 16 }); const before = stored();
    is(await rejects(call('startAnatomicCaseChange', { ...startReq(w), headers: {} }, mkCtx(w))), 'common.precondition_required', 428);
    is(await rejects(call('startAnatomicCaseChange', { ...startReq(w), headers: { 'if-match': 'abc' } }, mkCtx(w))), 'common.validation_failed', 400);
    for (const rev of [1, 4, 6, 99]) is(await rejects(start(w, { rev })), 'common.version_conflict', 409);
    nothingHappened(w, before);
  });
  it('privilege: the permission asserted is exactly anatomic.case.signout at the case centre; auth.mfa_required (aal1) and auth.forbidden pass through unchanged BEFORE any lab call or write', async () => {
    for (const [n, code] of [[17, 'auth.mfa_required'], [18, 'auth.forbidden']] as const) {
      const w = world({ n }); const before = stored();
      is(await rejects(start(w, { ctx: mkCtx(w, { deny: { 'anatomic.case.signout': code } }) })), code, 403);
      expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.signout', centreId: C_A1 });
      expect(w.lab.calls('getOrderResults')).toHaveLength(0);
      nothingHappened(w, before);
    }
  });
  it('a system actor (worker) can never start a change → 403 auth.forbidden; another tenant / malformed case id → 404 common.not_found; a centre the actor cannot see → not_found; all with no side effect', async () => {
    const w = world({ n: 19 }); const before = stored();
    is(await rejects(start(w, { ctx: mkCtx(w, { actorType: 'system' }) })), 'auth.forbidden', 403);
    is(await rejects(start(w, { ctx: mkCtx(w, { tenant: T_OTHER }) })), 'common.not_found', 404);
    is(await rejects(call('startAnatomicCaseChange', { ...startReq(w), params: { case_id: 'not-a-uuid' } }, mkCtx(w))), 'common.not_found', 404);
    is(await rejects(start(w, { ctx: mkCtx(w, { denyCentre: C_A1 }) })), 'common.not_found');
    nothingHappened(w, before);
  });
  it('REQ-SEC-098: the reason text is never logged and never echoed in an error', async () => {
    const w = world({ n: 20 });
    await start(w, { body: { reason_code: 'correction', reason_text: `${MARKER} reason` } });
    is(await rejects(start(w, { body: { reason_code: 'correction', reason_text: `${MARKER} again` } })), 'anatomic.case_invalid_transition');
    expect(calls.logs.join('\n')).not.toContain(MARKER);
  });
});

// ================================================================================================ R5
describe('R5 discardAnatomicCaseChange', () => {
  it('204 no body; the draft becomes discarded (discarded_at set), the case and the versions are untouched, nothing goes to C5; afterwards a new change can be started (and is a fresh draft)', async () => {
    const w = world({ n: 21 });
    await start(w);
    const caseBefore = JSON.stringify(S.cases.get(w.caseId)), id = openDraft(w)!['id'];
    const r = await discard(w);
    expect(r.status).toBe(204); expect(r.body ?? undefined).toBeUndefined();
    expect(S.drafts.get(id)).toMatchObject({ status: 'discarded' }); expect(S.drafts.get(id)!['discarded_at']).toBeTruthy();
    expect(openDraft(w)).toBeUndefined();
    expect(JSON.stringify(S.cases.get(w.caseId))).toBe(caseBefore);
    expect(versions(w.caseId)).toHaveLength(1); expect(w.lab.calls('submitModuleResult')).toHaveLength(0);
    const again = await start(w, { body: { reason_code: 'other_reason' } });
    expect(again.status).toBe(201); expect(again.body).toMatchObject({ change_reason_code: 'other_reason', version: 1 });
  });
  it('no open draft → 409 anatomic.case_invalid_transition; an open INITIAL draft cannot be discarded through R5 (stays open) → 409; a second discard → 409', async () => {
    const w = world({ n: 22 }); const before = stored();
    is(await rejects(discard(w, { rev: 3 })), 'anatomic.case_invalid_transition', 409);
    nothingHappened(w, before);
    const i = world({ n: 23, prior: false, draft: 'initial' }); const b2 = stored();
    is(await rejects(discard(i)), 'anatomic.case_invalid_transition', 409);
    expect(stored()).toBe(b2); expect(openDraft(i)).toMatchObject({ kind: 'initial', status: 'open' });
    const x = world({ n: 24, draft: 'revision' });
    await discard(x);
    is(await rejects(discard(x, { rev: 3 })), 'anatomic.case_invalid_transition', 409);
  });
  it('If-Match (draft version): absent → 428; malformed → 400; stale / future → 409 common.version_conflict; draft stays open', async () => {
    const w = world({ n: 25, draft: 'revision' }); const before = stored();
    is(await rejects(call('discardAnatomicCaseChange', { ...discardReq(w), headers: {} }, mkCtx(w))), 'common.precondition_required', 428);
    is(await rejects(call('discardAnatomicCaseChange', { ...discardReq(w), headers: { 'if-match': 'x' } }, mkCtx(w))), 'common.validation_failed', 400);
    for (const rev of [1, 2, 4, 99]) is(await rejects(discard(w, { rev })), 'common.version_conflict', 409);
    expect(stored()).toBe(before);
  });
  it('privilege: anatomic.case.signout (mfa_required / forbidden pass through), system actor → 403, other tenant → 404; no side effect', async () => {
    const w = world({ n: 26, draft: 'revision' }); const before = stored();
    is(await rejects(discard(w, { ctx: mkCtx(w, { deny: { 'anatomic.case.signout': 'auth.mfa_required' } }) })), 'auth.mfa_required', 403);
    is(await rejects(discard(w, { ctx: mkCtx(w, { deny: { 'anatomic.case.signout': 'auth.forbidden' } }) })), 'auth.forbidden', 403);
    expect(calls.assertRole.every((a) => a['permission'] === 'anatomic.case.signout' && a['centreId'] === C_A1)).toBe(true);
    is(await rejects(discard(w, { ctx: mkCtx(w, { actorType: 'system' }) })), 'auth.forbidden', 403);
    is(await rejects(discard(w, { ctx: mkCtx(w, { tenant: T_OTHER }) })), 'common.not_found', 404);
    expect(stored()).toBe(before);
  });
  it('after the discard the signed report is locked again: R2 → 409 anatomic.signout_locked and sign-out → 409 anatomic.case_invalid_transition', async () => {
    const w = world({ n: 27 });
    await start(w); await discard(w);
    is(await rejects(call('saveAnatomicReportDraft', { params: { case_id: w.caseId }, headers: { 'if-match': '"1"' }, body: DRAFT_CONTENT }, mkCtx(w))), 'anatomic.signout_locked', 409);
    is(await rejects(call('signOutAnatomicCase', { params: { case_id: w.caseId }, headers: { 'if-match': '"1"' }, body: { attest: true } }, mkCtx(w))), 'anatomic.case_invalid_transition', 409);
  });
});

// ================================================================================================ AC-03.4 / AC-03.5 through the change draft
describe('AC-03.4 / AC-03.5 — D-66 edit rules while a change draft is open (02-TRD §5 "Edits on a signed_out case")', () => {
  const partA = (w: W) => [...S.parts.values()].find((p) => p['case_id'] === w.caseId && p['letter'] === 'A')!['id'];
  const putPart = (w: W, ctx?: any) => call('updateAnatomicPart', { params: { case_id: w.caseId, part_id: partA(w) }, headers: { 'if-match': '"1"' }, body: { site_text: 'Antrum, revised' } }, ctx ?? mkCtx(w));
  const newPart = (w: W) => call('addAnatomicPart', { params: { case_id: w.caseId }, headers: { 'idempotency-key': 'key-0006' }, body: { site_text: 'New site' } }, mkCtx(w));
  it('AC-03.4: signed_out without an open change draft → draft content (R2) and part edit (A7) are 409 anatomic.signout_locked; nothing changes', async () => {
    const w = world({ n: 28 }); const before = stored();
    is(await rejects(call('saveAnatomicReportDraft', { params: { case_id: w.caseId }, headers: { 'if-match': '"1"' }, body: DRAFT_CONTENT }, mkCtx(w))), 'anatomic.signout_locked', 409);
    is(await rejects(putPart(w)), 'anatomic.signout_locked', 409);
    is(await rejects(newPart(w)), 'anatomic.signout_locked', 409);
    expect(stored()).toBe(before);
  });
  it('AC-03.5: after R4 the draft content (R2) and the part site (A7) are saved; adding a part stays 409 anatomic.signout_locked (D-66 (b),(c))', async () => {
    const w = world({ n: 29 });
    await start(w);
    const saved = await saveDraft(w, { ...DRAFT_CONTENT, comment_text: 'Edited under the change.' });
    expect(saved.status).toBe(200); expect(saved.body).toMatchObject({ comment_text: 'Edited under the change.', kind: 'revision', version: 2 });
    const p = await putPart(w);
    expect(p.status).toBe(200); expect(p.body).toMatchObject({ site_text: 'Antrum, revised', version: 2 });
    const before = stored();
    is(await rejects(newPart(w)), 'anatomic.signout_locked', 409);
    expect(stored()).toBe(before); expect(S.log).not.toContain('insertPart');
  });
});

// ================================================================================================ R6 / R7
const seedVersions = (w: W, count: number) => {
  for (let v = 2; v <= count; v++) {
    const id = uid(7000 + v);
    S.versions.set(id, { id, tenant_id: T, centre_id: C_A1, case_id: w.caseId, version_no: v, version_kind: 'revision', scope: 'full', addon_case_item_id: null, addendum_id: null, change_reason_code: 'correction', change_reason_text: null,
      ...PRIOR, impression_text: `Impression v${v}`, ancillary: [], addenda: [], signed_at: `2026-11-1${v % 10}T05:00:00.000Z`, signed_by_membership_id: MEMBERSHIP, created_by: ACTOR });
  }
  S.cases.get(w.caseId)!['current_version_no'] = count;
};
const listV = (w: W, ctx?: any) => call('listAnatomicReportVersions', { params: { case_id: w.caseId } }, ctx ?? mkCtx(w));
const getV = (w: W, no: unknown, ctx?: any) => call('getAnatomicReportVersion', { params: { case_id: w.caseId, version_no: no } }, ctx ?? mkCtx(w));
describe('R6 listAnatomicReportVersions', () => {
  it('200 { data } newest first with the ReportVersionSummary keys only (no content columns, no tenant/centre/membership ids), submissions per version; no access-log row; permission anatomic.case.read at the case centre', async () => {
    const w = world({ n: 30 }); seedVersions(w, 3);
    const r = await listV(w);
    expect(r.status).toBe(200);
    expect(r.body.data.map((v: Row) => v.version_no)).toEqual([3, 2, 1]);
    expect(r.body.data[2]).toMatchObject({ version_no: 1, version_kind: 'original', scope: 'full', signed_at: FIRST_SIGNED, signed_by_display_name: 'Dr Synthetic One',
      submissions: w.items.map((it) => ({ case_item_id: it.id, order_item_id: it.orderItemId, item_version_no: 1, lab_status_at_submit: 'resulted' })) });
    expect(r.body.data[0]).toMatchObject({ version_kind: 'revision', change_reason_code: 'correction' });
    expect('change_reason_code' in r.body.data[2]).toBe(false);
    expect(hasNoNulls(r.body)).toBe(true);
    for (const k of ['gross_text', 'impression_text', 'synoptic', 'tenant_id', 'centre_id', 'created_by', 'signed_by_membership_id', 'id']) expect(keysDeep(r.body), k).not.toContain(k);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.read', centreId: C_A1 });
    expect(calls.access).toHaveLength(0);
  });
  it('at most 200 versions, newest first', async () => {
    const w = world({ n: 31 }); seedVersions(w, 205);
    const r = await listV(w);
    expect(r.body.data).toHaveLength(200); expect(r.body.data[0].version_no).toBe(205); expect(r.body.data[199].version_no).toBe(6);
  });
  it('another tenant / unknown / malformed case → 404; denied → propagated; a case never signed lists []', async () => {
    const w = world({ n: 32 });
    is(await rejects(listV(w, mkCtx(w, { tenant: T_OTHER }))), 'common.not_found', 404);
    is(await rejects(call('listAnatomicReportVersions', { params: { case_id: 'nope' } }, mkCtx(w))), 'common.not_found', 404);
    is(await rejects(listV(w, mkCtx(w, { deny: { 'anatomic.case.read': 'auth.forbidden' } }))), 'auth.forbidden', 403);
    const n = world({ n: 33, prior: false });
    expect((await listV(n)).body).toEqual({ data: [] });
  });
});
describe('R7 getAnatomicReportVersion — access log anatomic_report.view (REQ-SEC-096/097)', () => {
  it('200 ReportVersion = summary + the stored content columns, no nulls, no internal ids; exactly one access-log row anatomic_report.view on anatomic_case / case id with detail.version_no', async () => {
    const w = world({ n: 34 }); seedVersions(w, 2);
    const r = await getV(w, 1);
    expect(r.status).toBe(200);
    const { flag: _f, is_critical: _c, ...PRIOR_VIEW } = PRIOR; // ReportVersion (contract, additionalProperties: false) lists neither flag nor is_critical
    expect(r.body).toMatchObject({ version_no: 1, version_kind: 'original', scope: 'full', signed_at: FIRST_SIGNED, signed_by_display_name: 'Dr Synthetic One', ...PRIOR_VIEW, ancillary: [], addenda: [],
      submissions: w.items.map((it) => ({ case_item_id: it.id, order_item_id: it.orderItemId, item_version_no: 1, lab_status_at_submit: 'resulted' })) });
    expect(hasNoNulls(r.body)).toBe(true);
    for (const k of ['tenant_id', 'centre_id', 'created_by', 'signed_by_membership_id', 'addon_case_item_id', 'addendum_id', 'flag', 'is_critical']) expect(keysDeep(r.body), k).not.toContain(k);
    expect(calls.access).toEqual([expect.objectContaining({ action: 'anatomic_report.view', entityType: 'anatomic_case', entityId: w.caseId, detail: { version_no: 1 } })]);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.read', centreId: C_A1 });
    expect((await getV(w, 2)).body.version_no).toBe(2);
    expect(calls.access.map((a) => a['detail'])).toEqual([{ version_no: 1 }, { version_no: 2 }]); // every read is logged
  });
  it('an addendum_only version reads back with empty text columns and its scope', async () => {
    const w = world({ n: 35 });
    const id = uid(7900);
    S.versions.set(id, { id, tenant_id: T, centre_id: C_A1, case_id: w.caseId, version_no: 2, version_kind: 'addendum', scope: 'addendum_only', addon_case_item_id: w.addon.id, addendum_id: null, clinical_history_text: PRIOR.clinical_history_text,
      gross_text: '', microscopy_text: '', impression_text: '', comment_text: '', flag: null, is_critical: false, synoptic: [], images: [], specimen_parts: PRIOR.specimen_parts, slides: [], ancillary: [], molecular: [], addenda: [], diagnosis_codes: [],
      signed_at: NOW, signed_by_membership_id: MEMBERSHIP, created_by: ACTOR });
    const r = await getV(w, 2);
    expect(r.body).toMatchObject({ version_no: 2, version_kind: 'addendum', scope: 'addendum_only', gross_text: '', microscopy_text: '', impression_text: '', comment_text: '', synoptic: [], images: [], slides: [], molecular: [] });
    expect(hasNoNulls(r.body)).toBe(true);
  });
  it('unknown version → 404 and NO access-log row; malformed version number → 400 or 404 (never 500); another tenant → 404; denied → propagated, no access-log row', async () => {
    const w = world({ n: 36 });
    is(await rejects(getV(w, 7)), 'common.not_found', 404);
    for (const bad of ['abc', '0', '-1', '1.5', '', undefined, '99999999999']) {
      const e = await rejects(getV(w, bad));
      expect([400, 404], String(bad)).toContain((e as LimsError).statusCode);
    }
    is(await rejects(getV(w, 1, mkCtx(w, { tenant: T_OTHER }))), 'common.not_found', 404);
    is(await rejects(getV(w, 1, mkCtx(w, { deny: { 'anatomic.case.read': 'auth.forbidden' } }))), 'auth.forbidden', 403);
    expect(calls.access).toHaveLength(0);
  });
  it('a version of ANOTHER case is never served through this case id', async () => {
    const a = world({ n: 37 }), b = world({ n: 38 });
    S.versions.get(uid(38 * 1000 + 50))!['impression_text'] = 'OTHER CASE IMPRESSION';
    const r = await getV(a, 1);
    expect(JSON.stringify(r.body)).not.toContain('OTHER CASE IMPRESSION');
    expect(b.caseId).not.toBe(a.caseId);
  });
});

// ================================================================================================ R8
describe('R8 createAnatomicAddendum (AC-10.4 start, AC-10.6)', () => {
  it('201 Addendum { id, kind, text, stain_order_ids, status "draft", version 1 } for a signed_out case; row seq 1 then 2, created_by actor, plain text (CRLF → LF, trailing blanks trimmed); nothing goes to C5, no version, case untouched', async () => {
    const w = world({ n: 40 }); const caseBefore = JSON.stringify(S.cases.get(w.caseId));
    const r = await addAdd(w, { kind: 'ihc', text: 'CK7 positive.\r\nCK20 negative.   ' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'ihc', text: 'CK7 positive.\nCK20 negative.', stain_order_ids: [], status: 'draft', version: 1 });
    expect(typeof r.body.id).toBe('string'); expect(hasNoNulls(r.body)).toBe(true);
    for (const k of ['addon_case_item_id', 'signed_at', 'signed_by_display_name', 'report_version_no']) expect(r.body, k).not.toHaveProperty(k);
    for (const k of ['tenant_id', 'centre_id', 'created_by', 'seq']) expect(keysDeep(r.body), k).not.toContain(k);
    const second = await addAdd(w, { kind: 'special_stain', text: 'PAS positive.' });
    expect(addendaOf(w.caseId).map((a) => [a['seq'], a['kind'], a['status']])).toEqual([[1, 'ihc', 'draft'], [2, 'special_stain', 'draft']]);
    expect(addendaOf(w.caseId)[0]).toMatchObject({ tenant_id: T, centre_id: C_A1, case_id: w.caseId, created_by: ACTOR, version: 1 });
    expect(second.body.id).not.toBe(r.body.id);
    expect(JSON.stringify(S.cases.get(w.caseId))).toBe(caseBefore); expect(versions(w.caseId)).toHaveLength(1); expect(w.lab.calls('submitModuleResult')).toHaveLength(0); expect(calls.access).toHaveLength(0);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.work', centreId: C_A1 });
  });
  it('stain orders of the case are accepted and listed; an add-on item link is accepted and echoed as addon_case_item_id', async () => {
    const w = world({ n: 41 }); const so = stainOrder(w, 1);
    const r = await addAdd(w, { kind: 'ihc', text: 'CK7.', stain_order_ids: [so], addon_case_item_id: w.addon.id });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ stain_order_ids: [so], addon_case_item_id: w.addon.id });
    expect(addendaOf(w.caseId)[0]).toMatchObject({ stain_order_ids: [so], addon_case_item_id: w.addon.id });
  });
  it('AC-10.6: a case that is not signed out → 409 anatomic.case_invalid_transition and no row (even with a bad body: the state is checked first)', async () => {
    for (const status of ['ready_for_reporting', 'in_processing', 'accessioned', 'received', 'cancelled']) {
      const w = world({ n: 42, status, prior: false }); const before = stored();
      is(await rejects(addAdd(w)), 'anatomic.case_invalid_transition', 409);
      is(await rejects(addAdd(w, { nonsense: 1 })), 'anatomic.case_invalid_transition', 409);
      nothingHappened(w, before);
      for (const m of [S.cases, S.items, S.drafts, S.versions, S.subs, S.parts]) m.clear();
    }
  });
  it('body: unknown kind, missing/empty/over-long text, unknown key, > 20 stain orders, malformed stain order id → 400 common.validation_failed with the pointer; nothing changes', async () => {
    const w = world({ n: 43 }); const before = stored();
    const bad: [Row, string][] = [
      [{ kind: 'x', text: 't' }, '/kind'], [{ text: 't' }, '/kind'], [{ kind: 'ihc' }, '/text'], [{ kind: 'ihc', text: '' }, '/text'], [{ kind: 'ihc', text: 'x'.repeat(8001) }, '/text'], [{ kind: 'ihc', text: 5 }, '/text'],
      [{ kind: 'ihc', text: 't', stain_order_ids: Array.from({ length: 21 }, (_, k) => uid(8100 + k)) }, '/stain_order_ids'], [{ kind: 'ihc', text: 't', stain_order_ids: ['not-a-uuid'] }, '/stain_order_ids/0'],
      [{ kind: 'ihc', text: 't', addon_case_item_id: 'not-a-uuid' }, '/addon_case_item_id'],
    ];
    for (const [body, path] of bad) {
      const e = await rejects(addAdd(w, body)); is(e, 'common.validation_failed', 400);
      expect((e as LimsError).errors?.some((f) => f.path === path), `${JSON.stringify(body).slice(0, 60)} -> ${path}: ${JSON.stringify((e as LimsError).errors)}`).toBe(true);
    }
    is(await rejects(addAdd(w, { kind: 'ihc', text: 't', force: true })), 'common.validation_failed', 400);
    nothingHappened(w, before);
  });
  it('07-SECURITY §5.1: body ids that are not THIS case\'s (stain order of another case, stain order / add-on item of another tenant, a PRIMARY item, the inactive item) → 400 at the pointer, never linked', async () => {
    const w = world({ n: 44 });
    const other = world({ n: 45 }); const foreignCase = stainOrder(other, 2);                                  // same tenant, other case
    const foreignTenant = uid(8200); S.stainOrders.set(foreignTenant, { id: foreignTenant, tenant_id: T_OTHER, case_id: w.caseId, centre_id: C_A1, stain_code: 'X', stain_kind: 'ihc', status: 'completed', version: 1 });
    const foreignItem = uid(8201); S.items.set(foreignItem, { id: foreignItem, tenant_id: T_OTHER, case_id: w.caseId, order_item_id: uid(8202), role: 'addon', is_active: true, version: 1 });
    const before = stored();                                                                                    // ruling: snapshot after the fixtures are seeded
    for (const [body, path] of [
      [{ kind: 'ihc', text: 't', stain_order_ids: [foreignCase] }, '/stain_order_ids/0'], [{ kind: 'ihc', text: 't', stain_order_ids: [foreignTenant] }, '/stain_order_ids/0'],
      [{ kind: 'ihc', text: 't', stain_order_ids: [uid(8299)] }, '/stain_order_ids/0'],
      [{ kind: 'ihc', text: 't', addon_case_item_id: foreignItem }, '/addon_case_item_id'], [{ kind: 'ihc', text: 't', addon_case_item_id: w.items[0]!.id }, '/addon_case_item_id'],
      [{ kind: 'ihc', text: 't', addon_case_item_id: other.addon.id }, '/addon_case_item_id'], [{ kind: 'ihc', text: 't', addon_case_item_id: uid(8298) }, '/addon_case_item_id'],
    ] as [Row, string][]) {
      const e = await rejects(addAdd(w, body)); is(e, 'common.validation_failed', 400);
      expect((e as LimsError).errors?.some((f) => f.path === path), `${path}: ${JSON.stringify((e as LimsError).errors)}`).toBe(true);
    }
    expect(addendaOf(w.caseId)).toEqual([]); expect(stored()).toBe(before);
  });
  it('privilege: anatomic.case.work (denied → 403, propagated); other tenant → 404; no side effect', async () => {
    const w = world({ n: 46 }); const before = stored();
    is(await rejects(addAdd(w, undefined, mkCtx(w, { deny: { 'anatomic.case.work': 'auth.forbidden' } }))), 'auth.forbidden', 403);
    is(await rejects(addAdd(w, undefined, mkCtx(w, { tenant: T_OTHER }))), 'common.not_found', 404);
    nothingHappened(w, before);
  });
  it('two addenda created at the same moment get distinct seq (no raw unique violation); the case row lock serialises them', async () => {
    const w = world({ n: 47 });
    const rs = await Promise.allSettled([addAdd(w), addAdd(w, { kind: 'other', text: 'second' })]);
    for (const x of rs) if (x.status === 'rejected') { expect(x.reason).toBeInstanceOf(LimsError); expect((x.reason as LimsError).statusCode).toBe(409); }
    const seqs = addendaOf(w.caseId).map((a) => a['seq']);
    expect(new Set(seqs).size).toBe(seqs.length); expect(seqs.length).toBe(rs.filter((x) => x.status === 'fulfilled').length); expect(seqs.length).toBeGreaterThanOrEqual(1);
  });
  it('REQ-SEC-098: the addendum text is never logged', async () => {
    const w = world({ n: 48 });
    await addAdd(w, { kind: 'other', text: `${MARKER} text` }); await rejects(addAdd(w, { kind: 'x', text: `${MARKER} bad` }));
    expect(calls.logs.join('\n')).not.toContain(MARKER);
  });
});

// ================================================================================================ R9
describe('R9 updateAnatomicAddendum', () => {
  it('a draft addendum: 200, text and stain orders replaced (PUT), version + 1; kind and add-on link as created; another tenant → 404', async () => {
    const w = world({ n: 50 }); const so = stainOrder(w, 3);
    const id = await newAddendum(w, { kind: 'ihc', text: 'first text', addon_case_item_id: w.addon.id });
    const r = await updAdd(w, id, { kind: 'ihc', text: 'second\r\ntext  ', stain_order_ids: [so], addon_case_item_id: w.addon.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, kind: 'ihc', text: 'second\ntext', stain_order_ids: [so], addon_case_item_id: w.addon.id, status: 'draft', version: 2 });
    expect(S.addenda.get(id)).toMatchObject({ text: 'second\ntext', stain_order_ids: [so], version: 2, seq: 1 });
    expect(calls.assertRole.at(-1)).toMatchObject({ permission: 'anatomic.case.work', centreId: C_A1 });
    is(await rejects(updAdd(w, id, { kind: 'ihc', text: 'x' }, { ctx: mkCtx(w, { tenant: T_OTHER }) })), 'common.not_found', 404);
    expect(S.addenda.get(id)!['text']).toBe('second\ntext');
  });
  it('a SIGNED addendum → 409 anatomic.signout_locked, whatever the If-Match; nothing changes', async () => {
    const w = world({ n: 51 });
    const id = await newAddendum(w); await signAdd(w, id);
    const before = stored(), logged = calls.access.length;
    is(await rejects(updAdd(w, id, { kind: 'ihc', text: 'late edit' })), 'anatomic.signout_locked', 409);
    is(await rejects(updAdd(w, id, { kind: 'ihc', text: 'late edit' }, { rev: 1 })), 'anatomic.signout_locked', 409);
    expect(stored()).toBe(before); expect(calls.access).toHaveLength(logged);
  });
  it('If-Match: absent → 428; malformed → 400; stale → 409 common.version_conflict; body errors → 400 with pointer; foreign stain order → 400; nothing changes', async () => {
    const w = world({ n: 52 }); const id = await newAddendum(w); const before = stored();
    is(await rejects(updAdd(w, id, { kind: 'ihc', text: 'x' }, { headers: {} })), 'common.precondition_required', 428);
    is(await rejects(updAdd(w, id, { kind: 'ihc', text: 'x' }, { headers: { 'if-match': 'x' } })), 'common.validation_failed', 400);
    is(await rejects(updAdd(w, id, { kind: 'ihc', text: 'x' }, { rev: 7 })), 'common.version_conflict', 409);
    const e = await rejects(updAdd(w, id, { kind: 'ihc', text: '' })); is(e, 'common.validation_failed', 400); expect((e as LimsError).errors?.some((f) => f.path === '/text')).toBe(true);
    const f = await rejects(updAdd(w, id, { kind: 'ihc', text: 'x', stain_order_ids: [uid(8299)] })); is(f, 'common.validation_failed', 400); expect((f as LimsError).errors?.some((x) => x.path === '/stain_order_ids/0')).toBe(true);
    is(await rejects(updAdd(w, id, { kind: 'ihc', text: 'x', force: 1 })), 'common.validation_failed', 400);
    is(await rejects(call('updateAnatomicAddendum', { params: { addendum_id: 'not-a-uuid' }, headers: { 'if-match': '"1"' }, body: { kind: 'ihc', text: 'x' } }, mkCtx(w))), 'common.not_found', 404);
    expect(stored()).toBe(before);
    is(await rejects(updAdd(w, id, { kind: 'ihc', text: 'x' }, { ctx: mkCtx(w, { deny: { 'anatomic.case.work': 'auth.forbidden' } }) })), 'auth.forbidden', 403);
    expect(stored()).toBe(before);
  });
});

// ================================================================================================ R10 — full scope (AC-10.4)
describe('R10 signAnatomicAddendum — addendum not linked to an add-on item → cumulative FULL version (AC-10.4)', () => {
  it('200 SignOutResult: case signed_out at version 2 (signed_out_at keeps the first time), report_version 2 kind addendum scope full, one submission per active primary item at item version 2; no nulls; no change_reason_code', async () => {
    const w = world({ n: 60 });
    const id = await newAddendum(w, { kind: 'ihc', text: 'CK7 positive in tumour cells.' });
    const r = await signAdd(w, id);
    expect(r.status).toBe(200);
    expect(r.body.case).toMatchObject({ id: w.caseId, status: 'signed_out', current_version_no: 2, signed_out_at: FIRST_SIGNED });
    expect(r.body.report_version).toMatchObject({ version_no: 2, version_kind: 'addendum', scope: 'full', signed_at: NOW, signed_by_display_name: 'Dr Synthetic One' });
    expect('change_reason_code' in r.body.report_version).toBe(false);
    expect(r.body.report_version.submissions).toEqual(w.items.map((it) => ({ case_item_id: it.id, order_item_id: it.orderItemId, item_version_no: 2, lab_status_at_submit: 'resulted' })));
    expect(hasNoNulls(r.body)).toBe(true);
    for (const k of ['tenant_id', 'centre_id', 'created_by', 'signed_by_membership_id']) expect(keysDeep(r.body.report_version), k).not.toContain(k);
    expect(S.cases.get(w.caseId)).toMatchObject({ status: 'signed_out', current_version_no: 2, version: 6 });
    expect(new Date(S.cases.get(w.caseId)!['signed_out_at']).toISOString()).toBe(FIRST_SIGNED);
  });
  it('C5 gets ONE call per active primary item (not the add-on, not the inactive item), in case_item id order: payloadRef versionNo 2, key anatomic:<item>:2, and amendment EXACTLY { reasonCode: "supplementary_report" } (08 R1)', async () => {
    const w = world({ n: 61 });
    await signAdd(w, await newAddendum(w));
    const ins = portInputs(w);
    expect(ins.map((i) => i['orderItemId'])).toEqual(w.items.map((it) => it.orderItemId));
    ins.forEach((i, k) => {
      expect(i).toMatchObject({ reportPhase: 'final', payloadRef: { module: 'anatomic', entityId: w.items[k]!.id, versionNo: 2 }, idempotencyKey: `anatomic:${w.items[k]!.id}:2` });
      expect(i['amendment']).toEqual({ reasonCode: 'supplementary_report' });
      expect(new Date(i['submittedAt']).toISOString()).toBe(NOW);
    });
  });
  it('stored version: version_no 2, kind addendum, scope full, addendum_id set, no add-on link, no change reason; the ORIGINAL sections are unchanged; addenda = the signed addendum (seq, kind, text, signer, time)', async () => {
    const w = world({ n: 62 });
    const id = await newAddendum(w, { kind: 'ihc', text: 'CK7 positive in tumour cells.' });
    await signAdd(w, id);
    const v = versions(w.caseId)[1]!;
    expect(v).toMatchObject({ tenant_id: T, centre_id: C_A1, case_id: w.caseId, version_no: 2, version_kind: 'addendum', scope: 'full', addendum_id: id, signed_by_membership_id: MEMBERSHIP, created_by: ACTOR, ...PRIOR });
    expect(v['addon_case_item_id'] ?? null).toBeNull(); expect(v['change_reason_code'] ?? null).toBeNull(); expect(v['change_reason_text'] ?? null).toBeNull();
    expect(new Date(v['signed_at']).toISOString()).toBe(NOW);
    expect(addendaView(v)).toEqual([{ seq: 1, kind: 'ihc', text: 'CK7 positive in tumour cells.', signed_by_membership_id: MEMBERSHIP, signed_at: NOW }]);
    expect(subs(w.caseId).filter((s) => s['item_version_no'] === 2).map((s) => [s['case_item_id'], s['report_version_id'], s['idempotency_key'], s['replayed']]))
      .toEqual(w.items.map((it) => [it.id, v['id'], `anatomic:${it.id}:2`, false]));
  });
  it('the addendum row becomes signed (signed_at, signer membership, report_version_no 2, version + 1) and is immutable; exactly one access-log row anatomic_report.sign_out { version_no: 2 }; assertRole anatomic.case.signout at the case centre', async () => {
    const w = world({ n: 63 });
    const id = await newAddendum(w);
    await signAdd(w, id);
    expect(S.addenda.get(id)).toMatchObject({ status: 'signed', signed_by_membership_id: MEMBERSHIP, report_version_no: 2, version: 2 });
    expect(new Date(S.addenda.get(id)!['signed_at']).toISOString()).toBe(NOW);
    expect(calls.access).toEqual([expect.objectContaining({ action: 'anatomic_report.sign_out', entityType: 'anatomic_case', entityId: w.caseId, detail: { version_no: 2 } })]);
    expect(calls.assertRole.find((a) => a['permission'] === 'anatomic.case.signout')).toMatchObject({ centreId: C_A1 });
  });
  it('done_when order: the privilege check first, ALL port calls, then report_versions, then item_submissions — never a write before a port call', async () => {
    const w = world({ n: 64 });
    const id = await newAddendum(w); S.log.length = 0;
    await signAdd(w, id);
    const seen = S.log.filter((x) => x === 'port' || x === 'insertVersion' || x === 'insertSubmission' || x === 'assert:anatomic.case.signout');
    expect(seen).toEqual(['assert:anatomic.case.signout', 'port', 'port', 'insertVersion', 'insertSubmission', 'insertSubmission']);
  });
  it('cumulative: every signed addendum NOT linked to an add-on item, oldest first, including the one being signed; unsigned drafts and add-on-linked addenda are left out', async () => {
    const w = world({ n: 65 });
    const a1 = await newAddendum(w, { kind: 'ihc', text: 'first' }); await signAdd(w, a1);
    const draftOnly = await newAddendum(w, { kind: 'other', text: 'still a draft' });
    const addon = await newAddendum(w, { kind: 'ihc', text: 'add-on text', addon_case_item_id: w.addon.id }); await signAdd(w, addon);
    const a2 = await newAddendum(w, { kind: 'special_stain', text: 'second' }); await signAdd(w, a2);
    const vs = versions(w.caseId);
    expect(vs.map((v) => [v['version_no'], v['scope']])).toEqual([[1, 'full'], [2, 'full'], [3, 'addendum_only'], [4, 'full']]);
    expect(addendaView(vs[1]!).map((a) => a.text)).toEqual(['first']);
    expect(addendaView(vs[3]!).map((a) => [a.seq, a.text])).toEqual([[1, 'first'], [4, 'second']]);
    expect(S.addenda.get(draftOnly)!['status']).toBe('draft');
    expect(S.cases.get(w.caseId)!['current_version_no']).toBe(4);
  });
  it('the sections of a full addendum version come from the latest FULL version, never from an addendum_only one (here: version 1 → add-on version 2 → full version 3 carries version 1\'s sections)', async () => {
    const w = world({ n: 66 });
    await signAdd(w, await newAddendum(w, { kind: 'ihc', text: 'add-on', addon_case_item_id: w.addon.id }));
    await signAdd(w, await newAddendum(w, { kind: 'ihc', text: 'case level' }));
    expect(versions(w.caseId)[2]).toMatchObject({ version_no: 3, scope: 'full', version_kind: 'addendum', ...PRIOR });
  });
  it('after a REVISION the next addendum version carries the revision\'s sections (the latest full version), and the revision itself carries the earlier non-add-on addenda (§4.4 "addenda in every full-scope version")', async () => {
    const w = world({ n: 67 });
    await signAdd(w, await newAddendum(w, { kind: 'ihc', text: 'case level one' }));                       // v2 (full, addendum)
    await signAdd(w, await newAddendum(w, { kind: 'ihc', text: 'add-on level', addon_case_item_id: w.addon.id })); // v3 (addendum_only)
    await start(w, { body: { reason_code: 'correction', reason_text: 'Fix' } });
    await saveDraft(w, { ...DRAFT_CONTENT, impression_text: 'Revised impression.' });
    const rev = await signChange(w);                                                                       // v4 (revision, full)
    expect(rev.body.report_version).toMatchObject({ version_no: 4, version_kind: 'revision', scope: 'full' });
    const v4 = versions(w.caseId)[3]!;
    expect(addendaView(v4).map((a) => a.text)).toEqual(['case level one']);                                // add-on addendum is not part of a full version
    await signAdd(w, await newAddendum(w, { kind: 'other', text: 'case level two' }));                     // v5
    const v5 = versions(w.caseId)[4]!;
    expect(v5).toMatchObject({ version_no: 5, version_kind: 'addendum', scope: 'full', impression_text: 'Revised impression.', gross_text: PRIOR.gross_text });
    expect(addendaView(v5).map((a) => a.text)).toEqual(['case level one', 'case level two']);
  });
  it('an approved target: C5 amends it with supplementary_report (lab version 2, approved) and the stored kind stays "addendum" (not "amendment"); lab.result.amend is needed', async () => {
    const w = world({ n: 68, approved: [0] });
    const r = await signAdd(w, await newAddendum(w));
    expect(r.body.report_version.version_kind).toBe('addendum');
    expect(subs(w.caseId).filter((s) => s['item_version_no'] === 2).map((s) => [s['lab_version_no'], s['lab_status']])).toEqual([[2, 'approved'], [1, 'resulted']]);
    expect(versions(w.caseId)[1]!['version_kind']).toBe('addendum');
    const nope = world({ n: 69, approved: [0], canAmend: false }); const id = await newAddendum(nope); const before = stored();
    const e = await rejects(signAdd(nope, id));
    is(e, 'lab.result_locked', new LimsError('lab.result_locked').statusCode);
    expect(stored()).toBe(before); expect(S.addenda.get(id)!['status']).toBe('draft'); expect(calls.access).toHaveLength(1); // only the first (successful) sign-out was logged
  });
  it('the ancillary stain orders of an add-on addendum are in the version (AC-10.5, §4.7.2); a stain order that is not completed → 422 anatomic.report_incomplete at /stain_order_ids/<i>', async () => {
    const w = world({ n: 70 });
    const done = stainOrder(w, 4, { stain_code: 'IHC_CK7' }), open = stainOrder(w, 5, { status: 'in_progress', stain_code: 'IHC_P40' });
    const bad = await newAddendum(w, { kind: 'ihc', text: 'needs the stain', stain_order_ids: [done, open] }); const before = stored();
    const e = await rejects(signAdd(w, bad));
    is(e, 'anatomic.report_incomplete', 422); expect((e as LimsError).errors?.map((f) => f.path)).toEqual(['/stain_order_ids/1']);
    expect(stored()).toBe(before); expect(w.lab.calls('submitModuleResult')).toHaveLength(0);
    const ok = await newAddendum(w, { kind: 'ihc', text: 'CK7', stain_order_ids: [done], addon_case_item_id: w.addon.id });
    await signAdd(w, ok);
    expect(versions(w.caseId).at(-1)!['ancillary']).toEqual([expect.objectContaining({ stain_kind: 'ihc', stain_code: 'IHC_CK7' })]);
  });
});

// ================================================================================================ R10 — add-on scope (AC-10.5)
describe('R10 signAnatomicAddendum — addendum linked to an add-on item → addendum_only version (AC-10.5, 02-TRD §4.7.2)', () => {
  it('only the add-on item is submitted (item version 1, key anatomic:<addon>:1, supplementary_report); primary items get NO new version or submission', async () => {
    const w = world({ n: 71 });
    const id = await newAddendum(w, { kind: 'ihc', text: 'CK7 positive.', addon_case_item_id: w.addon.id });
    const r = await signAdd(w, id);
    expect(r.status).toBe(200);
    expect(r.body.report_version).toMatchObject({ version_no: 2, version_kind: 'addendum', scope: 'addendum_only' });
    expect(r.body.report_version.submissions).toEqual([{ case_item_id: w.addon.id, order_item_id: w.addon.orderItemId, item_version_no: 1, lab_status_at_submit: 'resulted' }]);
    const ins = portInputs(w);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ orderItemId: w.addon.orderItemId, reportPhase: 'final', payloadRef: { module: 'anatomic', entityId: w.addon.id, versionNo: 1 }, idempotencyKey: `anatomic:${w.addon.id}:1` });
    expect(ins[0]!['amendment']).toEqual({ reasonCode: 'supplementary_report' });
    expect(subs(w.caseId).filter((s) => s['report_version_id'] === versions(w.caseId)[1]!['id']).map((s) => s['case_item_id'])).toEqual([w.addon.id]);
    expect(subs(w.caseId).filter((s) => w.items.some((it) => it.id === s['case_item_id']))).toHaveLength(2); // still only version 1 of each primary
    expect(S.cases.get(w.caseId)).toMatchObject({ status: 'signed_out', current_version_no: 2 });
  });
  it('stored version: scope addendum_only with addon_case_item_id; gross/microscopy/impression/comment are empty; synoptic, images, slides, molecular are []; addenda = every signed addendum of THAT item', async () => {
    const w = world({ n: 72 });
    const id = await newAddendum(w, { kind: 'ihc', text: 'CK7 positive.', addon_case_item_id: w.addon.id });
    await signAdd(w, id);
    const v = versions(w.caseId)[1]!;
    expect(v).toMatchObject({ version_no: 2, version_kind: 'addendum', scope: 'addendum_only', addon_case_item_id: w.addon.id, addendum_id: id, gross_text: '', microscopy_text: '', impression_text: '', comment_text: '',
      synoptic: [], images: [], slides: [], molecular: [], signed_by_membership_id: MEMBERSHIP });
    expect(addendaView(v)).toEqual([{ seq: 1, kind: 'ihc', text: 'CK7 positive.', signed_by_membership_id: MEMBERSHIP, signed_at: NOW }]);
    expect(S.addenda.get(id)).toMatchObject({ status: 'signed', report_version_no: 2 });
  });
  it('the published-view row of the add-on submission = its report version (entity_id = add-on case item, version_no = item version, scope addendum_only)', async () => {
    const w = world({ n: 73 });
    await signAdd(w, await newAddendum(w, { kind: 'ihc', text: 'CK7 positive.', addon_case_item_id: w.addon.id }));
    const s = subs(w.caseId).find((x) => x['case_item_id'] === w.addon.id)!;
    const v = S.versions.get(s['report_version_id'])!;
    expect({ entity_id: s['case_item_id'], version_no: s['item_version_no'], scope: v['scope'], version_kind: v['version_kind'], impression_text: v['impression_text'] }).toEqual({ entity_id: w.addon.id, version_no: 1, scope: 'addendum_only', version_kind: 'addendum', impression_text: '' });
  });
  it('a SECOND addendum on the same add-on item keeps the first one\'s text (oldest first); item version 2 / key :2; with an APPROVED add-on result both go through as supplementary_report (no lab.amendment_reason_required)', async () => {
    const w = world({ n: 74, addonApproved: true });
    const a1 = await newAddendum(w, { kind: 'ihc', text: 'first on the add-on' }); await signAdd(w, a1);
    // (a1 above is case level; the two below are linked to the add-on item)
    const b1 = await newAddendum(w, { kind: 'ihc', text: 'add-on one', addon_case_item_id: w.addon.id }); await signAdd(w, b1);
    const b2 = await newAddendum(w, { kind: 'ihc', text: 'add-on two', addon_case_item_id: w.addon.id }); const r = await signAdd(w, b2);
    expect(r.body.report_version).toMatchObject({ version_kind: 'addendum', scope: 'addendum_only', submissions: [{ case_item_id: w.addon.id, item_version_no: 2, lab_status_at_submit: 'approved' }] });
    const v = versions(w.caseId).at(-1)!;
    expect(addendaView(v).map((a) => [a.seq, a.text])).toEqual([[2, 'add-on one'], [3, 'add-on two']]);   // the case-level addendum is NOT in an add-on version
    const ins = portInputs(w).filter((i) => i['orderItemId'] === w.addon.orderItemId);
    expect(ins.map((i) => [i['idempotencyKey'], i['payloadRef'].versionNo, i['amendment']])).toEqual([
      [`anatomic:${w.addon.id}:1`, 1, { reasonCode: 'supplementary_report' }], [`anatomic:${w.addon.id}:2`, 2, { reasonCode: 'supplementary_report' }]]);
    expect(subs(w.caseId).filter((s) => s['case_item_id'] === w.addon.id).map((s) => [s['item_version_no'], s['lab_version_no'], s['lab_status']])).toEqual([[1, 2, 'approved'], [2, 3, 'approved']]);
    expect(versions(w.caseId).map((x) => x['version_kind']).slice(1)).toEqual(['addendum', 'addendum', 'addendum']);
  });
  it('an add-on item cancelled at the front desk → 409 anatomic.order_item_inactive (names the order item), no lab call, nothing changes; primaries being cancelled does not block an add-on addendum', async () => {
    const w = world({ n: 75, fdStatus: { 2: 'cancelled' } });
    const id = await newAddendum(w, { kind: 'ihc', text: 'x', addon_case_item_id: w.addon.id }); const before = stored();
    const e = await rejects(signAdd(w, id));
    is(e, 'anatomic.order_item_inactive', 409); expect(String((e as LimsError).detail ?? '')).toContain(w.addon.orderItemId);
    expect(stored()).toBe(before); expect(w.lab.calls('submitModuleResult')).toHaveLength(0);
    const ok = world({ n: 76, fdStatus: { 0: 'cancelled' } });
    expect((await signAdd(ok, await newAddendum(ok, { kind: 'ihc', text: 'x', addon_case_item_id: ok.addon.id }))).status).toBe(200);
  });
});

// ================================================================================================ R10 — guards, privilege, failure
describe('R10 guards, privilege and failure handling (07-SECURITY §5.3, AC-09.4 pattern)', () => {
  it('body is a closed { attest: true }: missing, false, "true", unknown key → 400 common.validation_failed at /attest; nothing changes', async () => {
    const w = world({ n: 80 }); const id = await newAddendum(w); const before = stored();
    for (const body of [{}, { attest: false }, { attest: 'true' }, { attest: true, force: true }, undefined]) is(await rejects(signAdd(w, id, { extra: { body } })), 'common.validation_failed', 400);
    const e = await rejects(signAdd(w, id, { extra: { body: { attest: false } } }));
    expect((e as LimsError).errors?.some((f) => f.path === '/attest')).toBe(true);
    expect(stored()).toBe(before);
  });
  it('If-Match: absent → 428; malformed → 400; stale → 409 common.version_conflict (after an R9 edit the old version is stale); the C5 is never called', async () => {
    const w = world({ n: 81 }); const id = await newAddendum(w); await updAdd(w, id, { kind: 'ihc', text: 'edited' }); const before = stored();
    is(await rejects(call('signAnatomicAddendum', { params: { addendum_id: id }, headers: {}, body: { attest: true } }, mkCtx(w))), 'common.precondition_required', 428);
    is(await rejects(call('signAnatomicAddendum', { params: { addendum_id: id }, headers: { 'if-match': 'x' }, body: { attest: true } }, mkCtx(w))), 'common.validation_failed', 400);
    is(await rejects(signAdd(w, id, { rev: 1 })), 'common.version_conflict', 409);
    nothingHappened(w, before);
  });
  it('privilege: anatomic.case.signout is asserted (not case.work); auth.mfa_required / auth.forbidden pass through BEFORE any lab call; system actor → 403; other tenant / unknown / malformed id → 404', async () => {
    const w = world({ n: 82 }); const id = await newAddendum(w); calls.assertRole.length = 0; const before = stored();
    is(await rejects(signAdd(w, id, { ctx: mkCtx(w, { deny: { 'anatomic.case.signout': 'auth.mfa_required' } }) })), 'auth.mfa_required', 403);
    is(await rejects(signAdd(w, id, { ctx: mkCtx(w, { deny: { 'anatomic.case.signout': 'auth.forbidden' } }) })), 'auth.forbidden', 403);
    expect(calls.assertRole.map((a) => a['permission'])).toEqual(['anatomic.case.signout', 'anatomic.case.signout']);
    is(await rejects(signAdd(w, id, { ctx: mkCtx(w, { actorType: 'system' }) })), 'auth.forbidden', 403);
    is(await rejects(signAdd(w, id, { ctx: mkCtx(w, { tenant: T_OTHER }) })), 'common.not_found', 404);
    is(await rejects(signAdd(w, uid(8888))), 'common.not_found', 404);
    is(await rejects(call('signAnatomicAddendum', { params: { addendum_id: 'nope' }, headers: { 'if-match': '"1"' }, body: { attest: true } }, mkCtx(w))), 'common.not_found', 404);
    is(await rejects(signAdd(w, id, { ctx: mkCtx(w, { denyCentre: C_A1 }) })), 'common.not_found');
    nothingHappened(w, before);
  });
  it('an already signed addendum (replay after success) → 409 anatomic.case_invalid_transition: NO second version, submission, lab call or access-log row', async () => {
    const w = world({ n: 83 }); const id = await newAddendum(w); await signAdd(w, id);
    const snapshot = stored(), labCalls = portInputs(w).length;
    is(await rejects(signAdd(w, id)), 'anatomic.case_invalid_transition', 409);
    expect(stored()).toBe(snapshot); expect(portInputs(w)).toHaveLength(labCalls); expect(versions(w.caseId)).toHaveLength(2); expect(calls.access).toHaveLength(1);
  });
  it('two sign-outs of the same addendum at the same time: exactly one wins, the other is a clean 409 (never a raw unique violation); one version, one submission per item', async () => {
    const w = world({ n: 84 }); const id = await newAddendum(w);
    const rs = await Promise.allSettled([signAdd(w, id), signAdd(w, id)]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = (rs.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason;
    expect(lost).toBeInstanceOf(LimsError); expect((lost as LimsError).statusCode).toBe(409);
    expect(['common.version_conflict', 'anatomic.case_invalid_transition']).toContain((lost as LimsError).code);
    expect(versions(w.caseId)).toHaveLength(2); expect(subs(w.caseId).filter((s) => s['item_version_no'] === 2)).toHaveLength(2); expect(calls.access).toHaveLength(1);
  });
  it('a primary item cancelled at the front desk → 409 anatomic.order_item_inactive for a case-level addendum, no lab call, nothing changes', async () => {
    const w = world({ n: 85, fdStatus: { 1: 'cancelled' } }); const id = await newAddendum(w); const before = stored();
    const e = await rejects(signAdd(w, id));
    is(e, 'anatomic.order_item_inactive', 409); expect(String((e as LimsError).detail ?? '')).toContain(w.items[1]!.orderItemId);
    nothingHappened(w, before);
  });
  it.each(['lab.module_result_invalid', 'lab.result_locked', 'lab.result_invalid_transition', 'lab.module_result_stale', 'lab.amendment_reason_required'])('%s from the port → same code and status, unchanged; addendum stays a draft, no version, case unchanged', async (code) => {
    const w = world({ n: 86 }); const id = await newAddendum(w); const before = stored();
    w.lab.failNext('submitModuleResult', code as never);
    const e = await rejects(signAdd(w, id));
    is(e, code, new LimsError(code).statusCode);
    expect(e).toBeInstanceOf(LimsError); expect(e.detail).toBeUndefined(); expect(e.errors).toBeUndefined();
    expect(stored()).toBe(before); expect(S.addenda.get(id)).toMatchObject({ status: 'draft', version: 1 }); expect(calls.access).toEqual([]);
  });
  it('the SECOND primary target fails after the first was accepted → still no version, no submission, addendum draft, case unchanged', async () => {
    const w = world({ n: 87 }); const id = await newAddendum(w); const before = stored(); S.portFailAt = 2;
    is(await rejects(signAdd(w, id)), 'lab.module_result_invalid', new LimsError('lab.module_result_invalid').statusCode);
    expect(S.portCalls).toBe(2); expect(stored()).toBe(before);
  });
  it('a database failure AFTER the port calls (2nd submission / addendum update / case update) rolls everything back and surfaces as an error; a retry then succeeds as version 2', async () => {
    for (const [name, at] of [['insertItemSubmission', 2], ['updateAddendum', 1], ['updateCase', 1]] as const) {
      const w = world({ n: 88 }); const id = await newAddendum(w); const before = stored(); S.dbFail = { name, at }; S.dbCalls = {};
      const e = await rejects(signAdd(w, id));
      expect(e, name).toBeInstanceOf(Error); expect(e.message).toBe('simulated db failure');
      expect(stored(), name).toBe(before);
      S.dbFail = undefined; S.log.length = 0;
      expect((await signAdd(w, id)).body.report_version.version_no, name).toBe(2);
      for (const m of [S.cases, S.items, S.drafts, S.versions, S.subs, S.parts, S.addenda]) m.clear();
    }
  });
  it('REQ-SEC-098: nothing of the addendum text is logged or echoed by a failure', async () => {
    const w = world({ n: 89 }); const id = await newAddendum(w, { kind: 'ihc', text: `${MARKER} addendum` });
    await signAdd(w, id);
    const w2 = world({ n: 90 }); const id2 = await newAddendum(w2, { kind: 'ihc', text: `${MARKER} second` }); w2.lab.failNext('submitModuleResult', 'lab.module_result_invalid');
    const e = await rejects(signAdd(w2, id2));
    expect(JSON.stringify({ d: e.detail, e: e.errors })).not.toContain(MARKER);
    expect(calls.logs.join('\n')).not.toContain(MARKER);
  });
});
