// C11.T-11 — configuration: K1 settings, K2 update, K3–K5 stains, K6–K7 test profiles (CatalogPort check), K8–K10 assays, K11–K12 coded values, K20–K22 text templates.
// Spec: 02-TRD §5.6 (K-table, AssayInput, Errors for K-ops), §5.7 (Settings/Stain/TestProfile/Assay/CodedValue/TextTemplate shapes), §10.2 (settings defaults + ranges);
//       05-SCHEMA §2.3 + 08 A17 P-22 (lazy tenant defaults: settings row + stain HE), 08 A17 D-62 (no change reasons: set_name enum diagnoses|cytology_adequacy|cancel_reasons);
//       01-PRD AC-14.1…14.4; 07-SECURITY (privileged ops: no permission → 403, aal1 → auth.mfa_required, AB-5 unknown fields, tenant isolation → 404, no payload in logs).
// Drives the REAL handlers (manifest.handlers) on IN-MEMORY repositories (vi.mock of config/codedValues/templates/cases repo with the T-04 signatures). What a mock cannot prove
// (real RLS, real ON CONFLICT DO NOTHING) is in integration/config.live.test.ts (GATED like T-04/T-06).
//
// SEAMS (spec fixes behaviour; names chosen here, writer follows or disputes):
//   handlers K1–K12, K20–K22 in the manifest, backed by service/config.service.ts. Every handler: assertRole FIRST (ctx.ports.IdentityPort.assertRole(ctx,{permission})):
//   reads → 'anatomic.case.read', writes → 'anatomic.config.manage'. The privileged aal2 check lives behind assertRole (it throws auth.forbidden / auth.mfa_required; the handler lets it through unchanged).
//   Repos used (existing T-04 names): config.repo getSettings/insertSettings/updateSettings, getStain/listStains/insertStain/updateStain, listTestProfiles/getTestProfile/insertTestProfile/updateTestProfile,
//   getAssay/listAssays/insertAssay/updateAssay, listAssayTargets/insertAssayTarget/updateAssayTarget, listAssayTargetValues/insertAssayTargetValue/updateAssayTargetValue;
//   codedValues.repo insertCoded{Diagnosis,CytologyAdequacy,CancelReason}/getCoded…(by id)/listCoded…/updateCoded… + listGlobalCancelReasons; templates.repo insertTextTemplate/getTextTemplate/listTextTemplates/updateTextTemplate.
//   Code-keyed lookups (stain by code, profile by test_id, coded value by code, assay by code) are done by the service through the list functions (limit ≤ 500); the mock honours repo semantics:
//   limit default 200 / max 500, setClause column whitelist (an update patch with `code`, `test_id`… throws), unique violation = pg 23505 on insert, update with a stale version → undefined.
//   insertSettings returns undefined when the tenant already has a row (ON CONFLICT DO NOTHING, 05-SCHEMA §2.3) — the service must re-read.
//   ctx: { tenantId, actor:{type:'user',id}, tx, now, log, ports:{ IdentityPort:{assertRole}, CatalogPort:{getTest(ctx,{testId})} } }; request { params, query, headers:{'if-match':'"<v>"'}, body };
//   list → { status:200, body:{ data } } (K11: + page:{ next_cursor, limit }); create → 201 body; update → 200 body (versions in body.version).
// Fails now: K1–K12 and K20–K22 are 501 / common.internal stubs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError, isLimsError } from '../../../core/errors.js';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  settings: new Map<string, Row>(), stains: new Map<string, Row>(), profiles: new Map<string, Row>(), assays: new Map<string, Row>(), targets: new Map<string, Row>(), values: new Map<string, Row>(),
  coded: { diagnoses: new Map<string, Row>(), cytology_adequacy: new Map<string, Row>(), cancel_reasons: new Map<string, Row>() } as Record<string, Map<string, Row>>,
  templates: new Map<string, Row>(), globalCancel: [] as Row[], cases: new Map<string, Row>(), writes: 0, caseWrites: 0, order: [] as string[], seq: 0, yieldOnInsertSettings: false,
}));
const pgErr = (constraint: string) => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint });
const SETCOLS: Record<string, string[]> = {
  settings: ['auto_accession_on_receipt', 'require_gross_complete_for_processing', 'default_routine_stain_code', 'max_images_per_case', 'max_report_images'],
  profiles: ['case_kind', 'is_addon', 'requires_gross', 'default_stain_code', 'default_synoptic_template_keys', 'is_active'],
  stains: ['display', 'kind', 'addon_test_id', 'sort_order', 'is_active'], assays: ['display', 'method_text_default', 'is_active'],
  targets: ['display', 'allows_quantitative', 'unit_code', 'decimals', 'sort_order', 'is_active'], values: ['display', 'is_abnormal', 'sort_order', 'is_active'],
  coded: ['display', 'system', 'system_version', 'sort_order', 'is_active'], templates: ['title', 'body', 'is_active'],
};
const touch = (what: string, write = false) => { S.order.push(what); if (write) S.writes++; };
const lim = (i: Row) => { const l = Math.trunc(Number(i['limit'] ?? 200)); return Number.isFinite(l) && l >= 1 ? Math.min(l, 500) : 200; };
const off = (i: Row) => { const o = Math.trunc(Number(i['offset'] ?? 0)); return Number.isFinite(o) && o >= 0 ? o : 0; };
const mine = (m: Map<string, Row>, i: Row) => [...m.values()].filter((r) => r['tenant_id'] === i['tenantId']);
const win = (rows: Row[], i: Row) => rows.slice(off(i), off(i) + lim(i)).map((r) => ({ ...r }));
const cmp = (a: Row, b: Row, keys: string[]) => { for (const k of keys) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; };
const undo = (tx: unknown, f: () => void) => { (tx as { undo?: (() => void)[] } | undefined)?.undo?.push(f); };
// INSCOLS = exactly the columns of the real INSERT lists (repository/*.repo.ts); like the SQL, anything else (notably is_active) is dropped and the column default applies.
const INSCOLS: Record<string, string[]> = {
  profiles: ['test_id', 'case_kind', 'is_addon', 'requires_gross', 'default_stain_code', 'default_synoptic_template_keys'], stains: ['code', 'display', 'kind', 'addon_test_id', 'sort_order'],
  assays: ['code', 'display', 'method_text_default'], targets: ['assay_id', 'code', 'display', 'allows_quantitative', 'unit_code', 'decimals', 'sort_order'],
  values: ['target_id', 'code', 'display', 'is_abnormal', 'sort_order'], coded: ['code', 'display', 'system', 'system_version', 'sort_order'], templates: ['short_code', 'section', 'title', 'body'],
};
function mkInsert(m: Map<string, Row>, uniq: string[], cols: string[], defaults: Row = {}) {
  const keep = ['id', 'tenant_id', 'created_by', 'updated_by', ...cols];
  return async (tx: unknown, row: Row) => {
    touch('repo', true);
    const dup = [...m.values()].some((r) => r['tenant_id'] === row['tenant_id'] && uniq.every((k) => r[k] === row[k]));
    if (dup) throw pgErr(`dup_${uniq.join('_')}`);
    const r = { is_active: true, sort_order: 0, version: 1, created_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T00:00:00Z', ...defaults, ...Object.fromEntries(Object.entries(row).filter(([k, v]) => v !== undefined && keep.includes(k))) };
    m.set(r['id'], r); undo(tx, () => m.delete(r['id'])); return { ...r };
  };
}
function mkUpdate(m: Map<string, Row>, cols: string[]) {
  return async (tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) => {
    touch('repo', true);
    for (const k of Object.keys(i.patch)) if (i.patch[k] !== undefined && !cols.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
    const r = m.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...Object.fromEntries(Object.entries(i.patch).filter(([, v]) => v !== undefined)), version: r['version'] + 1, updated_by: i.actorId };
    m.set(i.id, next); undo(tx, () => m.set(i.id, r)); return { ...next };
  };
}
const mkGet = (m: Map<string, Row>) => async (_tx: unknown, i: { tenantId: string; id: string }) => { touch('repo'); const r = m.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; };
function mkList(m: Map<string, Row>, order: string[], filter: (r: Row, i: Row) => boolean = () => true) {
  return async (_tx: unknown, i: Row) => { touch('repo'); return win(mine(m, i).filter((r) => (!i['activeOnly'] || r['is_active']) && filter(r, i)).sort((a, b) => cmp(a, b, order)), i); };
}

vi.mock('../repository/config.repo.js', () => ({
  async getSettings(_tx: unknown, i: Row) { touch('repo'); const r = S.settings.get(i['tenantId']); return r ? { ...r } : undefined; },
  async insertSettings(tx: unknown, row: Row) {
    touch('repo', true);
    if (S.yieldOnInsertSettings) await Promise.resolve();
    if (S.settings.has(row['tenant_id'])) return undefined; // ON CONFLICT DO NOTHING
    const r = { auto_accession_on_receipt: false, require_gross_complete_for_processing: true, default_routine_stain_code: 'HE', max_images_per_case: 50, max_report_images: 12, version: 1, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)) };
    S.settings.set(row['tenant_id'], r); undo(tx, () => S.settings.delete(row['tenant_id'])); return { ...r };
  },
  async updateSettings(tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    touch('repo', true);
    for (const k of Object.keys(i.patch)) if (i.patch[k] !== undefined && !SETCOLS['settings']!.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
    const r = S.settings.get(i.tenantId);
    if (!r || r['id'] !== i.id || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId }; S.settings.set(i.tenantId, next); undo(tx, () => S.settings.set(i.tenantId, r)); return { ...next };
  },
  insertTestProfile: mkInsert(S.profiles, ['test_id'], INSCOLS['profiles']!, { is_addon: false, requires_gross: true, default_synoptic_template_keys: [] }), getTestProfile: mkGet(S.profiles), listTestProfiles: mkList(S.profiles, ['created_at', 'id']),
  updateTestProfile: mkUpdate(S.profiles, SETCOLS['profiles']!),
  insertStain: mkInsert(S.stains, ['code'], INSCOLS['stains']!), getStain: mkGet(S.stains), listStains: mkList(S.stains, ['sort_order', 'code', 'id']), updateStain: mkUpdate(S.stains, SETCOLS['stains']!),
  insertAssay: mkInsert(S.assays, ['code'], INSCOLS['assays']!), getAssay: mkGet(S.assays), listAssays: mkList(S.assays, ['code', 'id']), updateAssay: mkUpdate(S.assays, SETCOLS['assays']!),
  insertAssayTarget: mkInsert(S.targets, ['assay_id', 'code'], INSCOLS['targets']!, { allows_quantitative: false }), getAssayTarget: mkGet(S.targets), updateAssayTarget: mkUpdate(S.targets, SETCOLS['targets']!),
  listAssayTargets: async (_tx: unknown, i: Row) => { touch('repo'); return mine(S.targets, i).filter((r) => r['assay_id'] === i['assayId'] && (!i['activeOnly'] || r['is_active'])).sort((a, b) => cmp(a, b, ['sort_order', 'code', 'id'])).map((r) => ({ ...r })); },
  insertAssayTargetValue: mkInsert(S.values, ['target_id', 'code'], INSCOLS['values']!, { is_abnormal: false }), getAssayTargetValue: mkGet(S.values), updateAssayTargetValue: mkUpdate(S.values, SETCOLS['values']!),
  listAssayTargetValues: async (_tx: unknown, i: Row) => { touch('repo'); return mine(S.values, i).filter((r) => r['target_id'] === i['targetId'] && (!i['activeOnly'] || r['is_active'])).sort((a, b) => cmp(a, b, ['sort_order', 'code', 'id'])).map((r) => ({ ...r })); },
}));
const codedList = (set: string) => mkList(S.coded[set]!, ['sort_order', 'code', 'id'], (r, i) => !i['q'] || String(r['display']).toLowerCase().includes(String(i['q']).toLowerCase()));
vi.mock('../repository/codedValues.repo.js', () => ({
  insertCodedDiagnosis: mkInsert(S.coded['diagnoses']!, ['code'], INSCOLS['coded']!, { system: 'local' }), getCodedDiagnosis: mkGet(S.coded['diagnoses']!), listCodedDiagnoses: codedList('diagnoses'), updateCodedDiagnosis: mkUpdate(S.coded['diagnoses']!, SETCOLS['coded']!),
  insertCodedCytologyAdequacy: mkInsert(S.coded['cytology_adequacy']!, ['code'], INSCOLS['coded']!, { system: 'local' }), getCodedCytologyAdequacy: mkGet(S.coded['cytology_adequacy']!),
  listCodedCytologyAdequacies: codedList('cytology_adequacy'), updateCodedCytologyAdequacy: mkUpdate(S.coded['cytology_adequacy']!, SETCOLS['coded']!),
  insertCodedCancelReason: mkInsert(S.coded['cancel_reasons']!, ['code'], INSCOLS['coded']!, { system: 'local' }), getCodedCancelReason: mkGet(S.coded['cancel_reasons']!), listCodedCancelReasons: codedList('cancel_reasons'),
  updateCodedCancelReason: mkUpdate(S.coded['cancel_reasons']!, SETCOLS['coded']!),
  async listGlobalCancelReasons() { touch('repo'); return S.globalCancel.map((r) => ({ ...r })); },
}));
vi.mock('../repository/templates.repo.js', () => ({
  insertTextTemplate: mkInsert(S.templates, ['section', 'short_code'], INSCOLS['templates']!), getTextTemplate: mkGet(S.templates), updateTextTemplate: mkUpdate(S.templates, SETCOLS['templates']!),
  listTextTemplates: mkList(S.templates, ['section', 'short_code', 'id'], (r, i) => !i['section'] || r['section'] === i['section']),
  async insertSynopticTemplate() { S.writes++; }, async getSynopticTemplate() { return undefined; }, async listSynopticTemplates() { return []; }, async updateSynopticTemplate() { S.writes++; return undefined; },
}));
vi.mock('../repository/cases.repo.js', () => ({
  async getCase(_tx: unknown, i: Row) { const r = S.cases.get(i['caseId']); return r ? { ...r } : undefined; }, async listCases() { return [...S.cases.values()]; }, async listCasesByOrder() { return []; },
  async insertCase() { S.caseWrites++; }, async updateCase() { S.caseWrites++; }, async insertCaseItem() { S.caseWrites++; }, async updateCaseItem() { S.caseWrites++; }, async insertCaseTransition() { S.caseWrites++; },
  async listCaseItems() { return []; }, async getCaseItem() { return undefined; }, async listCaseTransitions() { return []; }, async getCaseTransition() { return undefined; },
}));

const { manifest } = await import('../index.js');

const T = '01a1a98a-ac40-7000-8000-00000000a001', T_OTHER = '01a1a98a-ac40-7000-8000-00000000b001', ACTOR = '01a1a98a-ac40-7000-8000-00000000a300';
const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TEST_HISTO = uid(7001), TEST_LAB = uid(7002), TEST_MOL = uid(7003), TEST_GONE = uid(7004), CASE_1 = uid(101);
const ST = { HE: uid(301), SPECIAL: uid(302), PAP: uid(303), IHC: uid(304), OTHER_TENANT: uid(399) };
const ASSAY_1 = uid(401), ASSAY_OTHER = uid(499), TPL_1 = uid(501), TPL_OTHER = uid(599);
const NO_PHI_MARKER = 'SYNTHETIC-CONFIG-BODY-MARKER';
const FORBIDDEN_KEYS = ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'assay_id', 'target_id'];

interface CtxOpts { deny?: Record<string, 'auth.forbidden' | 'auth.mfa_required'>; tenant?: string; catalog?: Record<string, Row | LimsError> }
const calls = { assertRole: [] as Row[], getTest: [] as Row[], logs: [] as string[] };
const catalogDefault: Record<string, Row> = {
  [TEST_HISTO]: { id: TEST_HISTO, code: 'SYN-HISTO-SMALL', name: 'Synthetic histopathology small', workflowType: 'anatomic', isActive: true },
  [TEST_MOL]: { id: TEST_MOL, code: 'SYN-PCR-A', name: 'Synthetic PCR A', workflowType: 'molecular', isActive: true },
  [TEST_LAB]: { id: TEST_LAB, code: 'SYN-CBC', name: 'Synthetic CBC', workflowType: 'standard', isActive: true },
};
const mkCtx = (o: CtxOpts = {}) => ({
  operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999),
  log: { info: (x: object) => calls.logs.push(JSON.stringify(x)), warn: (x: object) => calls.logs.push(JSON.stringify(x)), error: (x: object) => calls.logs.push(JSON.stringify(x)) },
  tenantId: o.tenant ?? T, actor: { type: 'user', id: ACTOR, membershipId: uid(5000) }, tx: { undo: [] as (() => void)[], async query() { touch('tx.query', true); return { rows: [] }; } }, now: () => new Date('2026-11-12T01:30:00Z'),
  ports: {
    IdentityPort: { async assertRole(_c: unknown, i: Row) { touch('assertRole'); calls.assertRole.push(structuredClone(i)); const d = o.deny?.[i['permission']]; if (d) throw new LimsError(d); } },
    CatalogPort: {
      async getTest(_c: unknown, i: Row) {
        calls.getTest.push(structuredClone(i)); const r = (o.catalog ?? catalogDefault)[i['testId']];
        if (!r) throw new LimsError('common.not_found'); if (r instanceof LimsError) throw r; return { ...r };
      },
    },
  },
}) as any;
const TECH = { 'anatomic.config.manage': 'auth.forbidden' } as const; // lab_technologist: case.read yes, config.manage no
const AAL1 = { 'anatomic.config.manage': 'auth.mfa_required' } as const;

const STORES = ['settings', 'stains', 'profiles', 'assays', 'targets', 'values', 'templates'] as const;
/** emulates requestTx: a throwing handler rolls back every write it made through ctx.tx (undo journal kept by the mocks, so concurrent calls do not disturb each other) */
async function call(op: string, req: Row, ctx = mkCtx()): Promise<any> {
  try { return await (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx); } catch (e) {
    for (const u of [...ctx.tx.undo].reverse()) u();
    throw e;
  }
}
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const stored = () => JSON.stringify({ s: [...S.settings], st: [...S.stains], p: [...S.profiles], a: [...S.assays], t: [...S.targets], v: [...S.values], c: Object.values(S.coded).map((m) => [...m]), tp: [...S.templates] });
const validationFailed = (e: any, path?: string) => {
  expect(isLimsError(e, 'common.validation_failed')).toBe(true);
  if (path) expect((e as LimsError).errors?.some((f) => f.path === path), `errors[] has ${path}: ${JSON.stringify((e as LimsError).errors)}`).toBe(true);
};
const hasNoNulls = (x: unknown): boolean => x === null ? false : Array.isArray(x) ? x.every(hasNoNulls) : x && typeof x === 'object' ? Object.values(x).every(hasNoNulls) : true;
const keysDeep = (x: unknown): string[] => Array.isArray(x) ? x.flatMap(keysDeep) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...keysDeep(v)]) : [];

const base = (id: string, over: Row = {}): Row => ({ id, tenant_id: T, version: 1, is_active: true, sort_order: 0, created_by: ACTOR, updated_by: ACTOR, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over });
function seed() {
  S.settings.set(T, base(uid(1), { auto_accession_on_receipt: false, require_gross_complete_for_processing: true, default_routine_stain_code: 'HE', max_images_per_case: 50, max_report_images: 12, version: 3 }));
  S.stains.set(ST.HE, base(ST.HE, { code: 'HE', display: 'Haematoxylin and eosin', kind: 'routine' }));
  S.stains.set(ST.SPECIAL, base(ST.SPECIAL, { code: 'SYN_SPECIAL_1', display: 'Synthetic special 1', kind: 'special', sort_order: 10 }));
  S.stains.set(ST.PAP, base(ST.PAP, { code: 'PAP', display: 'Papanicolaou', kind: 'routine', sort_order: 5 }));
  S.stains.set(ST.IHC, base(ST.IHC, { code: 'IHC_ER', display: 'Synthetic ER', kind: 'ihc', sort_order: 20, is_active: false }));
  S.stains.set(ST.OTHER_TENANT, base(ST.OTHER_TENANT, { tenant_id: T_OTHER, code: 'HE', display: 'Other tenant HE', kind: 'routine' }));
  S.assays.set(ASSAY_1, base(ASSAY_1, { code: 'SYN_PCR_A', display: 'Synthetic PCR A', method_text_default: 'Synthetic method' }));
  S.assays.set(ASSAY_OTHER, base(ASSAY_OTHER, { tenant_id: T_OTHER, code: 'SYN_PCR_X', display: 'Other tenant assay' }));
  S.targets.set(uid(411), base(uid(411), { assay_id: ASSAY_1, code: 'T1', display: 'Target 1', allows_quantitative: false, sort_order: 1 }));
  S.targets.set(uid(412), base(uid(412), { assay_id: ASSAY_1, code: 'T2', display: 'Target 2', allows_quantitative: true, unit_code: 'copies_per_ml', decimals: 2, sort_order: 2 }));
  S.values.set(uid(421), base(uid(421), { target_id: uid(411), code: 'detected', display: 'Detected', is_abnormal: true, sort_order: 1 }));
  S.values.set(uid(422), base(uid(422), { target_id: uid(411), code: 'not_detected', display: 'Not detected', sort_order: 2 }));
  S.values.set(uid(423), base(uid(423), { target_id: uid(412), code: 'invalid', display: 'Invalid', is_abnormal: true, sort_order: 1 }));
  S.coded['diagnoses']!.set(uid(601), base(uid(601), { code: 'LOC-0002', display: 'Synthetic diagnosis 2', system: 'local', sort_order: 2 }));
  S.coded['diagnoses']!.set(uid(602), base(uid(602), { code: 'LOC-0001', display: 'Synthetic diagnosis 1', system: 'local', sort_order: 1 }));
  S.coded['cytology_adequacy']!.set(uid(611), base(uid(611), { code: 'satisfactory', display: 'Satisfactory', system: 'local' }));
  S.coded['cancel_reasons']!.set(uid(621), base(uid(621), { code: 'other', display: 'Other (tenant wording)', system: 'local' }));
  S.globalCancel = [{ id: uid(631), code: 'other', display: 'Other', sort_order: 99, is_active: true }, { id: uid(632), code: 'duplicate_case', display: 'Duplicate case', sort_order: 1, is_active: true }];
  S.templates.set(TPL_1, base(TPL_1, { short_code: 'nm1', section: 'microscopy', title: 'Normal microscopy', body: 'Synthetic normal microscopy text.' }));
  S.templates.set(uid(502), base(uid(502), { short_code: 'gr1', section: 'gross', title: 'Gross template', body: 'Synthetic gross text.', is_active: false }));
  S.templates.set(TPL_OTHER, base(TPL_OTHER, { tenant_id: T_OTHER, short_code: 'zz1', section: 'comment', title: 'Other tenant', body: 'Other.' }));
  S.profiles.set(uid(701), base(uid(701), { test_id: TEST_HISTO, case_kind: 'histology', is_addon: false, requires_gross: true, default_stain_code: 'HE', default_synoptic_template_keys: [] }));
  S.cases.set(CASE_1, { id: CASE_1, tenant_id: T, case_kind: 'histology', status: 'received', version: 1 });
}

beforeEach(() => {
  for (const k of STORES) S[k].clear();
  for (const m of Object.values(S.coded)) m.clear();
  S.globalCancel = []; S.cases.clear(); S.writes = 0; S.caseWrites = 0; S.order.length = 0; S.yieldOnInsertSettings = false;
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k].length = 0;
});

// valid requests for the nine write operations of T-11 (K14, K16–K19 are T-12)
const aBody = (over: Row = {}): Row => ({
  code: 'SYN_PCR_B', display: 'Synthetic PCR B', method_text_default: 'Synthetic', is_active: true,
  targets: [{ code: 'T1', display: 'Target 1', allows_quantitative: false, sort_order: 1, is_active: true,
    result_values: [{ code: 'detected', display: 'Detected', is_abnormal: true, sort_order: 1, is_active: true }, { code: 'not_detected', display: 'Not detected', is_abnormal: false, sort_order: 2, is_active: true }] }], ...over,
});
const WRITES: [string, string, () => Row][] = [
  ['K2', 'updateAnatomicSettings', () => ({ headers: ifm(3), body: { auto_accession_on_receipt: true, require_gross_complete_for_processing: true, default_routine_stain_code: 'HE', max_images_per_case: 60, max_report_images: 10 } })],
  ['K4', 'createAnatomicStain', () => ({ body: { code: 'NEW_STAIN', display: 'New stain', kind: 'special', sort_order: 7 } })],
  ['K5', 'updateAnatomicStain', () => ({ params: { stain_id: ST.SPECIAL }, headers: ifm(1), body: { display: 'Renamed', kind: 'special', sort_order: 11, is_active: true } })],
  ['K7', 'upsertAnatomicTestProfile', () => ({ params: { test_id: TEST_MOL }, headers: ifm(0), body: { case_kind: 'molecular', is_addon: false, requires_gross: false, is_active: true } })],
  ['K9', 'createAnatomicAssay', () => ({ body: aBody() })],
  ['K10', 'updateAnatomicAssay', () => ({ params: { assay_id: ASSAY_1 }, headers: ifm(1), body: aBody({ code: 'SYN_PCR_A' }) })],
  ['K12', 'upsertAnatomicCodedValue', () => ({ params: { set_name: 'diagnoses', code: 'LOC-0009' }, headers: ifm(0), body: { display: 'Synthetic diagnosis 9', sort_order: 9, is_active: true } })],
  ['K21', 'createAnatomicTextTemplate', () => ({ body: { short_code: 'nm2', section: 'microscopy', title: 'Another', body: 'Synthetic text.' } })],
  ['K22', 'updateAnatomicTextTemplate', () => ({ params: { text_template_id: TPL_1 }, headers: ifm(1), body: { title: 'Renamed', body: 'Synthetic changed text.', is_active: true } })],
];
const READS: [string, string, () => Row][] = [
  ['K1', 'getAnatomicSettings', () => ({})], ['K3', 'listAnatomicStains', () => ({})], ['K6', 'listAnatomicTestProfiles', () => ({})], ['K8', 'listAnatomicAssays', () => ({})],
  ['K11', 'listAnatomicCodedValues', () => ({ params: { set_name: 'diagnoses' } })], ['K20', 'listAnatomicTextTemplates', () => ({})],
];

// ========================================================================================================= privileged checks (AC-14.4, 07-SECURITY)
describe('AC-14.4 technologist: configuration writes → 403 auth.forbidden before anything is touched; reads → 200 on anatomic.case.read only', () => {
  it.each(WRITES)('%s %s as lab_technologist → auth.forbidden, assertRole(anatomic.config.manage) is the first thing that happens, nothing read or written', async (_k, op, req) => {
    seed(); const before = stored(); S.order.length = 0;
    const e = await rejects(call(op, req(), mkCtx({ deny: TECH })));
    expect(isLimsError(e, 'auth.forbidden')).toBe(true);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.config.manage' });
    expect(S.order[0]).toBe('assertRole'); expect(S.order.filter((x) => x !== 'assertRole')).toEqual([]); expect(S.writes).toBe(0); expect(stored()).toBe(before);
  });
  it.each(WRITES)('%s %s at aal1 → auth.mfa_required propagated unchanged (the handler never swallows or re-labels the port error), no change', async (_k, op, req) => {
    seed(); const before = stored();
    const e = await rejects(call(op, req(), mkCtx({ deny: AAL1 })));
    expect(isLimsError(e, 'auth.mfa_required')).toBe(true); expect(S.writes).toBe(0); expect(stored()).toBe(before);
  });
  it.each(READS)('%s %s as lab_technologist (no config.manage) → succeeds; assertRole asked for anatomic.case.read and never for config.manage', async (_k, op, req) => {
    seed();
    const r = await call(op, req(), mkCtx({ deny: TECH }));
    expect(r.status).toBe(200);
    expect(calls.assertRole.map((c) => c['permission'])).toEqual(['anatomic.case.read']);
    expect(S.writes).toBe(0); // the tenant already has its settings row: a read writes nothing
  });
  it.each(READS)('%s %s without anatomic.case.read → auth.forbidden, repositories untouched', async (_k, op, req) => {
    seed(); S.order.length = 0;
    const e = await rejects(call(op, req(), mkCtx({ deny: { 'anatomic.case.read': 'auth.forbidden' } })));
    expect(isLimsError(e, 'auth.forbidden')).toBe(true); expect(S.order.filter((x) => x !== 'assertRole')).toEqual([]);
  });
  it('a permitted writer reaches the repositories (guard against a handler that always denies)', async () => {
    seed();
    const r = await call('createAnatomicStain', { body: { code: 'NEW_STAIN', display: 'New stain', kind: 'special', sort_order: 7 } });
    expect(r.status).toBe(201); expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.config.manage' });
  });
});

// ========================================================================================================= lazy defaults (05-SCHEMA §2.3, 08 A17 P-22)
describe('K1 / lazy tenant defaults: first use creates the settings row (TRD §10.2 defaults) and stain HE; no tenant-provisioning step', () => {
  it('K1 on an empty tenant → 200 with the §10.2 defaults, closed key set, no nulls, version 1', async () => {
    const r = await call('getAnatomicSettings', {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ auto_accession_on_receipt: false, require_gross_complete_for_processing: true, default_routine_stain_code: 'HE', max_images_per_case: 50, max_report_images: 12, version: 1 });
    expect(S.settings.get(T)).toMatchObject({ default_routine_stain_code: 'HE', created_by: expect.any(String) });
  });
  it('first use also creates stain HE "Haematoxylin and eosin" kind routine, visible in K3 — and K3 as the very first call of a tenant already shows it ("any settings read, in any path")', async () => {
    const r = await call('listAnatomicStains', {});
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ code: 'HE', display: 'Haematoxylin and eosin', kind: 'routine', is_active: true, sort_order: 0 });
  });
  it('repeating the read changes nothing: one settings row, one HE stain, same version', async () => {
    await call('getAnatomicSettings', {}); const once = stored();
    const r = await call('getAnatomicSettings', {}); await call('listAnatomicStains', {});
    expect(r.body.version).toBe(1); expect(stored()).toBe(once); expect(S.settings.size).toBe(1); expect([...S.stains.values()].filter((s) => s['code'] === 'HE')).toHaveLength(1);
  });
  it('an existing tenant keeps its values: K1 returns the stored row, nothing inserted, stored default stain not reset', async () => {
    seed(); S.settings.set(T, { ...S.settings.get(T)!, max_images_per_case: 77, default_routine_stain_code: 'PAP' }); S.writes = 0;
    const r = await call('getAnatomicSettings', {});
    expect(r.body).toMatchObject({ max_images_per_case: 77, default_routine_stain_code: 'PAP', version: 3 }); expect(S.writes).toBe(0);
  });
  it('5 concurrent first reads (settings insert yields to the others) → all 200 with identical defaults, exactly one settings row', async () => {
    S.yieldOnInsertSettings = true;
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => call('getAnatomicSettings', {})));
    for (const r of rs) expect(r.body).toMatchObject({ default_routine_stain_code: 'HE', version: 1 });
    expect(S.settings.size).toBe(1);
  });
  it('lazy rows are tenant-scoped: tenant B first use does not read or alter tenant A rows', async () => {
    seed(); const a = JSON.stringify(S.settings.get(T));
    const r = await call('getAnatomicSettings', {}, mkCtx({ tenant: T_OTHER }));
    expect(r.body.version).toBe(1); expect(JSON.stringify(S.settings.get(T))).toBe(a); expect(S.settings.get(T_OTHER)).toBeDefined();
  });
  it('K2 as the very first call of a tenant works on the lazily created row (If-Match "1")', async () => {
    const r = await call('updateAnatomicSettings', { headers: ifm(1), body: { auto_accession_on_receipt: true, require_gross_complete_for_processing: true, default_routine_stain_code: 'HE', max_images_per_case: 50, max_report_images: 12 } });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ auto_accession_on_receipt: true, version: 2 });
  });
});

// ========================================================================================================= K2 settings update
describe('K2 updateAnatomicSettings — ranges (§10.2), If-Match, default stain rule', () => {
  const body = (over: Row = {}) => ({ auto_accession_on_receipt: true, require_gross_complete_for_processing: false, default_routine_stain_code: 'PAP', max_images_per_case: 120, max_report_images: 24, ...over });
  it('saves all five fields, version 3 → 4, body = Settings only (closed key set)', async () => {
    seed();
    const r = await call('updateAnatomicSettings', { headers: ifm(3), body: body() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...body(), version: 4 });
    expect(S.settings.get(T)).toMatchObject({ ...body(), version: 4, updated_by: ACTOR });
  });
  it('boundaries are accepted: max_images_per_case 1 and 200, max_report_images 0 and 24', async () => {
    seed(); let v = 3;
    for (const o of [{ max_images_per_case: 1, max_report_images: 0 }, { max_images_per_case: 200, max_report_images: 24 }]) {
      const r = await call('updateAnatomicSettings', { headers: ifm(v), body: body({ default_routine_stain_code: 'HE', ...o }) }); v = r.body.version; expect(r.body).toMatchObject(o);
    }
  });
  it.each([
    ['max_images_per_case 0', { max_images_per_case: 0 }, '/max_images_per_case'], ['max_images_per_case 201', { max_images_per_case: 201 }, '/max_images_per_case'],
    ['max_report_images -1', { max_report_images: -1 }, '/max_report_images'], ['max_report_images 25', { max_report_images: 25 }, '/max_report_images'],
    ['max_images_per_case 1.5', { max_images_per_case: 1.5 }, '/max_images_per_case'], ['string for a number', { max_report_images: '12' }, '/max_report_images'],
    ['string for a boolean', { auto_accession_on_receipt: 'yes' }, '/auto_accession_on_receipt'], ['null value', { max_images_per_case: null }, '/max_images_per_case'],
  ])('out of range / wrong type (%s) → 400 common.validation_failed at the field path, nothing changes', async (_n, over, path) => {
    seed(); const before = stored();
    validationFailed(await rejects(call('updateAnatomicSettings', { headers: ifm(3), body: body(over) })), path); expect(stored()).toBe(before);
  });
  it('unknown / server-owned fields (version, tenant_id, id) → 400 (AB-5: additionalProperties false), nothing changes', async () => {
    seed(); const before = stored();
    for (const extra of [{ version: 99 }, { tenant_id: T_OTHER }, { id: uid(1) }, { evil: 1 }]) validationFailed(await rejects(call('updateAnatomicSettings', { headers: ifm(3), body: body(extra) })));
    expect(stored()).toBe(before);
  });
  it.each([['no stain with that code', 'NOPE'], ['inactive stain', 'IHC_ER'], ['active stain of kind special (must be routine)', 'SYN_SPECIAL_1'], ['stain of another tenant only', 'OTHER_ONLY']])(
    'default_routine_stain_code must be an ACTIVE stain of kind routine (§10.2): %s → 400 at /default_routine_stain_code', async (_n, code) => {
      seed(); S.stains.set(uid(398), base(uid(398), { tenant_id: T_OTHER, code: 'OTHER_ONLY', kind: 'routine', display: 'x' })); const before = stored();
      validationFailed(await rejects(call('updateAnatomicSettings', { headers: ifm(3), body: body({ default_routine_stain_code: code }) })), '/default_routine_stain_code'); expect(stored()).toBe(before);
    });
  it('If-Match: missing → common.precondition_required; stale → common.version_conflict; garbage → rejected; row unchanged', async () => {
    seed(); const before = stored();
    expect(isLimsError(await rejects(call('updateAnatomicSettings', { body: body() })), 'common.precondition_required')).toBe(true);
    expect(isLimsError(await rejects(call('updateAnatomicSettings', { headers: ifm(2), body: body() })), 'common.version_conflict')).toBe(true);
    const g = await rejects(call('updateAnatomicSettings', { headers: { 'if-match': 'abc' }, body: body() })); expect(isLimsError(g)).toBe(true); expect(['common.precondition_required', 'common.validation_failed']).toContain(g.code);
    expect(stored()).toBe(before);
  });
  it('two writers with the same If-Match: exactly one wins, the other gets version_conflict (no lost update)', async () => {
    seed();
    const rs = await Promise.allSettled([call('updateAnatomicSettings', { headers: ifm(3), body: body({ max_images_per_case: 10 }) }), call('updateAnatomicSettings', { headers: ifm(3), body: body({ max_images_per_case: 20 }) })]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult; expect(isLimsError(lost.reason, 'common.version_conflict')).toBe(true); expect(S.settings.get(T)!['version']).toBe(4);
  });
});

// ========================================================================================================= stains K3–K5
describe('K3 listAnatomicStains', () => {
  it('default: active only, ordered sort_order, code; Stain shape (closed keys, no nulls, no tenant/audit columns)', async () => {
    seed();
    const r = await call('listAnatomicStains', {});
    expect(r.body.data.map((s: Row) => s['code'])).toEqual(['HE', 'PAP', 'SYN_SPECIAL_1']);
    for (const s of r.body.data) { expect(Object.keys(s).sort()).toEqual(['code', 'display', 'id', 'is_active', 'kind', 'sort_order', 'version']); expect(hasNoNulls(s)).toBe(true); }
  });
  it.each([[true], ['true']])('include_inactive=%s adds inactive stains', async (v) => {
    seed(); const r = await call('listAnatomicStains', { query: { include_inactive: v } }); expect(r.body.data.map((s: Row) => s['code'])).toEqual(['HE', 'PAP', 'SYN_SPECIAL_1', 'IHC_ER']);
  });
  it('kind filter; invalid kind → 400; other tenant\'s stains never appear', async () => {
    seed();
    expect((await call('listAnatomicStains', { query: { kind: 'routine' } })).body.data.map((s: Row) => s['code'])).toEqual(['HE', 'PAP']);
    validationFailed(await rejects(call('listAnatomicStains', { query: { kind: 'exotic' } })));
    const all = (await call('listAnatomicStains', { query: { include_inactive: true } })).body.data; expect(all.some((s: Row) => s['display'] === 'Other tenant HE')).toBe(false);
  });
});
describe('K4 createAnatomicStain', () => {
  const mk = (over: Row = {}) => ({ code: 'NEW_STAIN', display: 'New stain', kind: 'special', sort_order: 7, ...over });
  it('201 Stain, active, tenant + actor stamped, version 1', async () => {
    seed();
    const r = await call('createAnatomicStain', { body: mk() });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ code: 'NEW_STAIN', display: 'New stain', kind: 'special', sort_order: 7, is_active: true, version: 1 }); expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(S.stains.get(r.body.id)).toMatchObject({ tenant_id: T, created_by: ACTOR, updated_by: ACTOR }); expect(keysDeep(r.body).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
  });
  it('addon_test_id is stored and returned when given', async () => {
    seed(); const r = await call('createAnatomicStain', { body: mk({ code: 'IHC_NEW', kind: 'ihc', addon_test_id: TEST_HISTO }) }); expect(r.body.addon_test_id).toBe(TEST_HISTO);
  });
  it('duplicate code → 400 common.validation_failed with errors[] at /code (not a 409/500); same code of another tenant is fine', async () => {
    seed(); const before = stored();
    validationFailed(await rejects(call('createAnatomicStain', { body: mk({ code: 'HE' }) })), '/code'); expect(stored()).toBe(before);
    S.stains.delete(ST.HE); expect((await call('createAnatomicStain', { body: mk({ code: 'HE', kind: 'routine' }) }, mkCtx({ tenant: T }))).status).toBe(201);
  });
  it.each([
    ['lower-case code', { code: 'he' }, '/code'], ['space in code', { code: 'A B' }, '/code'], ['33-char code', { code: 'A'.repeat(33) }, '/code'], ['empty code', { code: '' }, '/code'],
    ['empty display', { display: '' }, '/display'], ['121-char display', { display: 'x'.repeat(121) }, '/display'], ['bad kind', { kind: 'other' }, '/kind'],
    ['sort_order 10000', { sort_order: 10000 }, '/sort_order'], ['sort_order -1', { sort_order: -1 }, '/sort_order'], ['addon_test_id not a uuid', { addon_test_id: 'nope' }, '/addon_test_id'],
  ])('%s → 400 at the field', async (_n, over, path) => { seed(); validationFailed(await rejects(call('createAnatomicStain', { body: mk(over) })), path); });
  it('missing required fields and unknown fields (is_active, version, tenant_id) → 400', async () => {
    seed(); const before = stored();
    for (const b of [{ display: 'x', kind: 'routine', sort_order: 1 }, { code: 'X', kind: 'routine', sort_order: 1 }, mk({ is_active: false }), mk({ version: 5 }), mk({ tenant_id: T_OTHER })]) validationFailed(await rejects(call('createAnatomicStain', { body: b })));
    expect(stored()).toBe(before);
  });
});
describe('K5 updateAnatomicStain', () => {
  const mk = (over: Row = {}) => ({ display: 'Renamed', kind: 'special', sort_order: 11, is_active: true, ...over });
  it('updates display/kind/sort_order/is_active, version +1, returns Stain; code unchanged', async () => {
    seed();
    const r = await call('updateAnatomicStain', { params: { stain_id: ST.SPECIAL }, headers: ifm(1), body: mk({ is_active: false }) });
    expect(r.body).toMatchObject({ id: ST.SPECIAL, code: 'SYN_SPECIAL_1', display: 'Renamed', sort_order: 11, is_active: false, version: 2 });
  });
  it('code is immutable: a `code` in the body → 400 (additionalProperties false); stored code unchanged', async () => {
    seed(); validationFailed(await rejects(call('updateAnatomicStain', { params: { stain_id: ST.SPECIAL }, headers: ifm(1), body: { ...mk(), code: 'CHANGED' } }))); expect(S.stains.get(ST.SPECIAL)!['code']).toBe('SYN_SPECIAL_1');
  });
  it('AC-14.2: deactivating HE while it is the default routine stain → 400 common.validation_failed "Choose another default routine stain first"; nothing saved', async () => {
    seed(); const before = stored();
    const e = await rejects(call('updateAnatomicStain', { params: { stain_id: ST.HE }, headers: ifm(1), body: mk({ kind: 'routine', is_active: false }) }));
    validationFailed(e); expect(`${e.detail ?? ''} ${JSON.stringify(e.errors ?? [])}`).toContain('Choose another default routine stain first'); expect(stored()).toBe(before);
  });
  it('AC-14.2 (same rule): changing the default stain\'s kind away from routine is refused too', async () => {
    seed(); validationFailed(await rejects(call('updateAnatomicStain', { params: { stain_id: ST.HE }, headers: ifm(1), body: mk({ kind: 'special', is_active: true }) }))); expect(S.stains.get(ST.HE)!['kind']).toBe('routine');
  });
  it('AC-14.2: after another routine stain becomes the default (K2) HE can be deactivated; a non-default stain can be deactivated any time', async () => {
    seed();
    await call('updateAnatomicSettings', { headers: ifm(3), body: { auto_accession_on_receipt: false, require_gross_complete_for_processing: true, default_routine_stain_code: 'PAP', max_images_per_case: 50, max_report_images: 12 } });
    expect((await call('updateAnatomicStain', { params: { stain_id: ST.HE }, headers: ifm(1), body: mk({ kind: 'routine', is_active: false, display: 'Haematoxylin and eosin' }) })).body.is_active).toBe(false);
    expect((await call('updateAnatomicStain', { params: { stain_id: ST.SPECIAL }, headers: ifm(1), body: mk({ is_active: false }) })).body.is_active).toBe(false);
  });
  it('deactivating a default stain on a tenant whose settings row does not exist yet still applies the default HE rule (lazy defaults)', async () => {
    S.settings.clear(); await call('listAnatomicStains', {}); const he = [...S.stains.values()].find((s) => s['code'] === 'HE')!; S.settings.clear();
    validationFailed(await rejects(call('updateAnatomicStain', { params: { stain_id: he['id'] }, headers: ifm(1), body: mk({ kind: 'routine', is_active: false, display: 'x' }) })));
  });
  it('If-Match missing → precondition_required; stale → version_conflict; unknown id / other tenant\'s id → common.not_found (not 403)', async () => {
    seed();
    expect(isLimsError(await rejects(call('updateAnatomicStain', { params: { stain_id: ST.SPECIAL }, body: mk() })), 'common.precondition_required')).toBe(true);
    expect(isLimsError(await rejects(call('updateAnatomicStain', { params: { stain_id: ST.SPECIAL }, headers: ifm(9), body: mk() })), 'common.version_conflict')).toBe(true);
    expect(isLimsError(await rejects(call('updateAnatomicStain', { params: { stain_id: uid(9) }, headers: ifm(1), body: mk() })), 'common.not_found')).toBe(true);
    expect(isLimsError(await rejects(call('updateAnatomicStain', { params: { stain_id: ST.OTHER_TENANT }, headers: ifm(1), body: mk() })), 'common.not_found')).toBe(true); expect(S.stains.get(ST.OTHER_TENANT)!['display']).toBe('Other tenant HE');
  });
});

// ========================================================================================================= test profiles K6–K7
describe('K7 upsertAnatomicTestProfile — CatalogPort check (workflowType ∈ {anatomic, molecular}), AC-14.1', () => {
  const mk = (over: Row = {}) => ({ case_kind: 'histology', is_addon: false, requires_gross: true, default_stain_code: 'HE', default_synoptic_template_keys: [], is_active: true, ...over });
  it('If-Match "0" creates: 200/201 TestProfile with test_name from the catalog, version 1; CatalogPort.getTest asked for exactly this test', async () => {
    seed();
    const r = await call('upsertAnatomicTestProfile', { params: { test_id: TEST_MOL }, headers: ifm(0), body: mk({ case_kind: 'molecular', requires_gross: false, default_stain_code: undefined }) });
    expect([200, 201]).toContain(r.status);
    expect(r.body).toMatchObject({ test_id: TEST_MOL, test_name: 'Synthetic PCR A', case_kind: 'molecular', is_addon: false, requires_gross: false, default_synoptic_template_keys: [], is_active: true, version: 1 });
    expect(hasNoNulls(r.body)).toBe(true); expect(calls.getTest[0]).toMatchObject({ testId: TEST_MOL });
    expect([...S.profiles.values()].find((p) => p['test_id'] === TEST_MOL)).toMatchObject({ tenant_id: T, created_by: ACTOR });
  });
  it('create with is_active:false → stored and returned inactive (the real INSERT has no is_active column, so the service must follow up with an update)', async () => {
    seed();
    const r = await call('upsertAnatomicTestProfile', { params: { test_id: TEST_MOL }, headers: ifm(0), body: mk({ case_kind: 'molecular', requires_gross: false, default_stain_code: undefined, is_active: false }) });
    expect(r.body).toMatchObject({ test_id: TEST_MOL, is_active: false }); expect([...S.profiles.values()].find((p) => p['test_id'] === TEST_MOL)?.['is_active']).toBe(false);
  });
  it('AC-14.1: set test X to case_kind cytology with default stain PAP → stored; existing cases are unchanged (no case row touched)', async () => {
    seed(); const caseBefore = JSON.stringify(S.cases.get(CASE_1));
    const r = await call('upsertAnatomicTestProfile', { params: { test_id: TEST_HISTO }, headers: ifm(1), body: mk({ case_kind: 'cytology', default_stain_code: 'PAP' }) });
    expect(r.body).toMatchObject({ test_id: TEST_HISTO, case_kind: 'cytology', default_stain_code: 'PAP', version: 2 });
    expect(S.profiles.get(uid(701))).toMatchObject({ case_kind: 'cytology', default_stain_code: 'PAP' });
    expect(S.caseWrites).toBe(0); expect(JSON.stringify(S.cases.get(CASE_1))).toBe(caseBefore);
    const k6 = await call('listAnatomicTestProfiles', {}); expect(k6.body.data.find((p: Row) => p['test_id'] === TEST_HISTO)).toMatchObject({ case_kind: 'cytology', default_stain_code: 'PAP' });
  });
  it('workflowType standard (not anatomic/molecular) → 400 common.validation_failed, no profile created', async () => {
    seed(); const before = stored();
    validationFailed(await rejects(call('upsertAnatomicTestProfile', { params: { test_id: TEST_LAB }, headers: ifm(0), body: mk() }))); expect(stored()).toBe(before);
  });
  it.each(['standard', 'narrative', 'microbiology', 'attachment', 'outsourced'])('workflowType %s is refused; anatomic and molecular are accepted', async (wf) => {
    seed(); const catalog = { [TEST_LAB]: { ...catalogDefault[TEST_LAB], workflowType: wf }, [TEST_GONE]: { ...catalogDefault[TEST_HISTO], id: TEST_GONE, workflowType: 'anatomic' } };
    validationFailed(await rejects(call('upsertAnatomicTestProfile', { params: { test_id: TEST_LAB }, headers: ifm(0), body: mk() }, mkCtx({ catalog }))));
    expect((await call('upsertAnatomicTestProfile', { params: { test_id: TEST_GONE }, headers: ifm(0), body: mk() }, mkCtx({ catalog }))).body.test_id).toBe(TEST_GONE);
  });
  it('a CatalogPort error propagates unchanged (08 P-23: rethrown, never re-constructed): unknown test → the port\'s own LimsError code; nothing created', async () => {
    seed(); const before = stored();
    const e = await rejects(call('upsertAnatomicTestProfile', { params: { test_id: TEST_GONE }, headers: ifm(0), body: mk() }));
    expect(isLimsError(e, 'common.not_found')).toBe(true); expect(stored()).toBe(before);
    const e2 = await rejects(call('upsertAnatomicTestProfile', { params: { test_id: TEST_HISTO }, headers: ifm(1), body: mk() }, mkCtx({ catalog: { [TEST_HISTO]: new LimsError('common.internal') } }))); expect(isLimsError(e2, 'common.internal')).toBe(true);
  });
  it('If-Match: "0" on an existing profile → version_conflict; stale version → version_conflict; missing header → precondition_required', async () => {
    seed(); const before = stored();
    expect(isLimsError(await rejects(call('upsertAnatomicTestProfile', { params: { test_id: TEST_HISTO }, headers: ifm(0), body: mk() })), 'common.version_conflict')).toBe(true);
    expect(isLimsError(await rejects(call('upsertAnatomicTestProfile', { params: { test_id: TEST_HISTO }, headers: ifm(7), body: mk() })), 'common.version_conflict')).toBe(true);
    expect(isLimsError(await rejects(call('upsertAnatomicTestProfile', { params: { test_id: TEST_HISTO }, body: mk() })), 'common.precondition_required')).toBe(true); expect(stored()).toBe(before);
  });
  it.each([
    ['bad case_kind', { case_kind: 'autopsy' }, '/case_kind'], ['6 synoptic keys (max 5)', { default_synoptic_template_keys: ['a', 'b', 'c', 'd', 'e', 'f'] }, '/default_synoptic_template_keys'],
    ['non-array synoptic keys', { default_synoptic_template_keys: 'abc' }, '/default_synoptic_template_keys'], ['non-boolean is_addon', { is_addon: 'no' }, '/is_addon'],
  ])('%s → 400 at the field', async (_n, over, path) => { seed(); validationFailed(await rejects(call('upsertAnatomicTestProfile', { params: { test_id: TEST_HISTO }, headers: ifm(1), body: mk(over) })), path); });
  it('test_id that is not a uuid → 400 before the catalog is asked; unknown body fields → 400', async () => {
    seed();
    validationFailed(await rejects(call('upsertAnatomicTestProfile', { params: { test_id: 'not-a-uuid' }, headers: ifm(0), body: mk() }))); expect(calls.getTest).toHaveLength(0);
    validationFailed(await rejects(call('upsertAnatomicTestProfile', { params: { test_id: TEST_MOL }, headers: ifm(0), body: mk({ tenant_id: T_OTHER }) })));
  });
  it('the profile of another tenant for the same test is never updated (tenant isolation)', async () => {
    seed(); S.profiles.set(uid(799), base(uid(799), { tenant_id: T_OTHER, test_id: TEST_MOL, case_kind: 'histology' }));
    await call('upsertAnatomicTestProfile', { params: { test_id: TEST_MOL }, headers: ifm(0), body: mk({ case_kind: 'molecular' }) }); expect(S.profiles.get(uid(799))!['case_kind']).toBe('histology');
  });
});
describe('K6 listAnatomicTestProfiles', () => {
  it('lists the tenant\'s profiles as TestProfile (test_name from CatalogPort), other tenants excluded', async () => {
    seed(); S.profiles.set(uid(799), base(uid(799), { tenant_id: T_OTHER, test_id: TEST_MOL, case_kind: 'molecular' }));
    const r = await call('listAnatomicTestProfiles', {});
    expect(r.status).toBe(200); expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toEqual({ test_id: TEST_HISTO, test_name: 'Synthetic histopathology small', case_kind: 'histology', is_addon: false, requires_gross: true, default_stain_code: 'HE', default_synoptic_template_keys: [], is_active: true, version: 1 });
  });
});

// ========================================================================================================= assays K8–K10
describe('K9 createAnatomicAssay', () => {
  it('201 Assay with nested targets and result_values persisted through the assay/target/value repositories, ids assigned, tenant + actor stamped, version 1', async () => {
    seed();
    const r = await call('createAnatomicAssay', { body: aBody() });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: 'SYN_PCR_B', display: 'Synthetic PCR B', method_text_default: 'Synthetic', is_active: true, version: 1 });
    expect(r.body.targets).toHaveLength(1); expect(r.body.targets[0]).toMatchObject({ code: 'T1', allows_quantitative: false, sort_order: 1, is_active: true });
    expect(r.body.targets[0].id).toMatch(/^[0-9a-f-]{36}$/); expect(r.body.targets[0].result_values.map((v: Row) => v['code'])).toEqual(['detected', 'not_detected']);
    expect(r.body.targets[0].result_values[0]).toMatchObject({ is_abnormal: true, display: 'Detected' });
    expect([...S.targets.values()].filter((t) => t['assay_id'] === r.body.id)).toHaveLength(1); expect([...S.values.values()].filter((v) => v['target_id'] === r.body.targets[0].id)).toHaveLength(2);
    expect(S.assays.get(r.body.id)).toMatchObject({ tenant_id: T, created_by: ACTOR }); expect(hasNoNulls(r.body)).toBe(true); expect(keysDeep(r.body).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
  });
  it('quantitative target with unit_code and decimals is stored (decimals 0 and 6 are the bounds)', async () => {
    seed(); const t = (d: number, code: string) => ({ code, display: code, allows_quantitative: true, unit_code: 'copies_per_ml', decimals: d, sort_order: 1, is_active: true, result_values: [{ code: 'ok', display: 'OK', is_abnormal: false, sort_order: 1, is_active: true }] });
    const r = await call('createAnatomicAssay', { body: aBody({ targets: [t(0, 'Q0'), t(6, 'Q6')] }) }); expect(r.body.targets.map((x: Row) => x['decimals'])).toEqual([0, 6]);
  });
  it('duplicate assay code → 400 validation_failed at /code, nothing stored', async () => {
    seed(); const before = stored(); validationFailed(await rejects(call('createAnatomicAssay', { body: aBody({ code: 'SYN_PCR_A' }) })), '/code'); expect(stored()).toBe(before);
  });
  it('a failure halfway (duplicate target code inside the input) leaves NO partial assay, target or value rows (one transaction)', async () => {
    seed(); const before = stored(); const t = aBody().targets[0];
    validationFailed(await rejects(call('createAnatomicAssay', { body: aBody({ targets: [t, { ...t }] }) }))); expect(stored()).toBe(before);
  });
  it('duplicate result_value code inside one target → 400', async () => {
    seed(); const t = aBody().targets[0]; t.result_values.push({ ...t.result_values[0] }); validationFailed(await rejects(call('createAnatomicAssay', { body: aBody({ targets: [t] }) })));
  });
  const withT = (f: (t: Row) => void) => { const b = aBody(); f(b.targets[0]); return b; };
  it.each([
    ['lower-case assay code', () => aBody({ code: 'syn' }), '/code'], ['33-char assay code', () => aBody({ code: 'A'.repeat(33) }), '/code'], ['empty display', () => aBody({ display: '' }), '/display'],
    ['method_text_default 201 chars', () => aBody({ method_text_default: 'x'.repeat(201) }), '/method_text_default'], ['no targets', () => aBody({ targets: [] }), '/targets'],
    ['51 targets', () => aBody({ targets: Array.from({ length: 51 }, (_, i) => ({ ...aBody().targets[0], code: `T${i}` })) }), '/targets'],
    ['target code lower-case', () => withT((t) => { t['code'] = 't1'; }), '/targets/0/code'], ['decimals 7', () => withT((t) => { t['decimals'] = 7; }), '/targets/0/decimals'],
    ['unit_code 33 chars', () => withT((t) => { t['unit_code'] = 'u'.repeat(33); }), '/targets/0/unit_code'], ['no result_values', () => withT((t) => { t['result_values'] = []; }), '/targets/0/result_values'],
    ['21 result_values', () => withT((t) => { t['result_values'] = Array.from({ length: 21 }, (_, i) => ({ code: `v${i}`, display: 'x', is_abnormal: false, sort_order: 1, is_active: true })); }), '/targets/0/result_values'],
    ['result value code upper-case', () => withT((t) => { t['result_values'][0].code = 'DETECTED'; }), '/targets/0/result_values/0/code'], ['is_abnormal not boolean', () => withT((t) => { t['result_values'][0].is_abnormal = 'yes'; }), '/targets/0/result_values/0/is_abnormal'],
    ['unknown key on a target', () => withT((t) => { t['evil'] = 1; }), ''], ['unknown key on the assay', () => aBody({ tenant_id: T_OTHER }), ''],
  ])('%s → 400', async (_n, mkBody, path) => { seed(); const before = stored(); validationFailed(await rejects(call('createAnatomicAssay', { body: mkBody() })), path || undefined); expect(stored()).toBe(before); });
});
describe('K8 listAnatomicAssays', () => {
  it('lists active assays of the tenant with nested active targets and values (ordered by sort_order); include_inactive adds inactive ones; no other tenant', async () => {
    seed(); S.assays.set(uid(402), base(uid(402), { code: 'OLD_ASSAY', display: 'Old', is_active: false }));
    const r = await call('listAnatomicAssays', {});
    expect(r.body.data.map((a: Row) => a['code'])).toEqual(['SYN_PCR_A']);
    const a = r.body.data[0]; expect(a.targets.map((t: Row) => t['code'])).toEqual(['T1', 'T2']); expect(a.targets[0].result_values.map((v: Row) => v['code'])).toEqual(['detected', 'not_detected']);
    expect(a.targets[1]).toMatchObject({ allows_quantitative: true, unit_code: 'copies_per_ml', decimals: 2 }); expect(hasNoNulls(r.body)).toBe(true);
    expect((await call('listAnatomicAssays', { query: { include_inactive: true } })).body.data.map((x: Row) => x['code'])).toEqual(['OLD_ASSAY', 'SYN_PCR_A']);
  });
});
describe('K10 updateAnatomicAssay — code immutable; targets/values may be added or deactivated, never removed', () => {
  const full = (over: Row = {}): Row => ({
    code: 'SYN_PCR_A', display: 'Synthetic PCR A', method_text_default: 'Synthetic method', is_active: true,
    targets: [
      { code: 'T1', display: 'Target 1', allows_quantitative: false, sort_order: 1, is_active: true, result_values: [{ code: 'detected', display: 'Detected', is_abnormal: true, sort_order: 1, is_active: true }, { code: 'not_detected', display: 'Not detected', is_abnormal: false, sort_order: 2, is_active: true }] },
      { code: 'T2', display: 'Target 2', allows_quantitative: true, unit_code: 'copies_per_ml', decimals: 2, sort_order: 2, is_active: true, result_values: [{ code: 'invalid', display: 'Invalid', is_abnormal: true, sort_order: 1, is_active: true }] },
    ], ...over,
  });
  const put = (body: Row, v = 1, id = ASSAY_1, ctx?: any) => call('updateAnatomicAssay', { params: { assay_id: id }, headers: ifm(v), body }, ctx);
  it('rename / change method text: version +1, existing target and value rows keep their ids', async () => {
    seed();
    const r = await put(full({ display: 'Renamed PCR', method_text_default: 'New method' }));
    expect(r.body).toMatchObject({ id: ASSAY_1, code: 'SYN_PCR_A', display: 'Renamed PCR', method_text_default: 'New method', version: 2 });
    expect(r.body.targets.map((t: Row) => t['id'])).toEqual([uid(411), uid(412)]); expect(S.values.size).toBe(3); expect(S.targets.size).toBe(2);
  });
  it('add a new target (with values) and a new value to an existing target → inserted, existing rows unchanged', async () => {
    seed(); const b = full(); b.targets[0].result_values.push({ code: 'inconclusive', display: 'Inconclusive', is_abnormal: false, sort_order: 3, is_active: true });
    b.targets.push({ code: 'T3', display: 'Target 3', allows_quantitative: false, sort_order: 3, is_active: true, result_values: [{ code: 'detected', display: 'Detected', is_abnormal: true, sort_order: 1, is_active: true }] });
    const r = await put(b); expect(r.body.targets.map((t: Row) => t['code'])).toEqual(['T1', 'T2', 'T3']); expect(r.body.targets[0].result_values.map((v: Row) => v['code'])).toEqual(['detected', 'not_detected', 'inconclusive']);
    expect(S.targets.size).toBe(3); expect(S.values.size).toBe(5);
  });
  it('deactivate an assay, a target and a value: rows stay (is_active false), nothing deleted', async () => {
    seed(); const b = full({ is_active: false }); b.targets[0].is_active = false; b.targets[0].result_values[1].is_active = false;
    const r = await put(b); expect(r.body.is_active).toBe(false); expect(S.targets.get(uid(411))!['is_active']).toBe(false); expect(S.values.get(uid(422))!['is_active']).toBe(false); expect(S.targets.size).toBe(2); expect(S.values.size).toBe(3);
  });
  it('omitting an existing target → 400 (never removed); omitting an existing value → 400; nothing changes', async () => {
    seed(); const before = stored();
    const noT2 = full(); noT2.targets.pop(); validationFailed(await rejects(put(noT2)));
    const noV = full(); noV.targets[0].result_values.pop(); validationFailed(await rejects(put(noV))); expect(stored()).toBe(before);
  });
  it('changing the code → 400 at /code (immutable); a code that belongs to another assay is not a way around it', async () => {
    seed(); const before = stored(); validationFailed(await rejects(put(full({ code: 'SYN_PCR_Z' }))), '/code'); expect(stored()).toBe(before);
  });
  it('stale If-Match → version_conflict; missing → precondition_required; unknown / other tenant\'s assay → not_found; failed update is atomic (no half-applied children)', async () => {
    seed(); const before = stored();
    expect(isLimsError(await rejects(put(full(), 9)), 'common.version_conflict')).toBe(true);
    expect(isLimsError(await rejects(call('updateAnatomicAssay', { params: { assay_id: ASSAY_1 }, body: full() })), 'common.precondition_required')).toBe(true);
    expect(isLimsError(await rejects(put(full(), 1, uid(9))), 'common.not_found')).toBe(true);
    expect(isLimsError(await rejects(put(full({ code: 'SYN_PCR_X' }), 1, ASSAY_OTHER)), 'common.not_found')).toBe(true);
    const bad = full({ display: 'Changed' }); bad.targets.push({ ...bad.targets[0], code: 'T9' }, { ...bad.targets[0], code: 'T9' }); validationFailed(await rejects(put(bad)));
    expect(stored()).toBe(before);
  });
});

// ========================================================================================================= coded values K11–K12
describe('K11 listAnatomicCodedValues (set_name enum: diagnoses, cytology_adequacy, cancel_reasons — no change reasons, 08 A17 D-62)', () => {
  const codes = (r: Row) => r['body'].data.map((v: Row) => v['code']);
  it('diagnoses: active only, ordered sort_order then code; CodedValue shape (code, display, system, sort_order, is_active, version; no id of the row required, no nulls, no tenant columns)', async () => {
    seed();
    const r = await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' } });
    expect(r.status).toBe(200); expect(codes(r)).toEqual(['LOC-0001', 'LOC-0002']);
    expect(r.body.data[0]).toMatchObject({ code: 'LOC-0001', display: 'Synthetic diagnosis 1', system: 'local', sort_order: 1, is_active: true, version: 1 });
    expect(hasNoNulls(r.body)).toBe(true); expect(keysDeep(r.body.data).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]); expect(r.body.page).not.toHaveProperty('next_cursor'); expect(r.body.page.limit).toBe(50);
  });
  it('each set reads its own table', async () => {
    seed();
    expect(codes(await call('listAnatomicCodedValues', { params: { set_name: 'cytology_adequacy' } }))).toEqual(['satisfactory']);
    expect(codes(await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' } }))).not.toContain('satisfactory');
  });
  it('cancel_reasons: platform seed codes are listed and a tenant row with the same code shadows the global one (05-SCHEMA §1)', async () => {
    seed();
    const r = await call('listAnatomicCodedValues', { params: { set_name: 'cancel_reasons' } });
    expect(codes(r).sort()).toEqual(['duplicate_case', 'other']); expect(r.body.data.find((v: Row) => v['code'] === 'other')!['display']).toBe('Other (tenant wording)');
  });
  it('set_name outside the enum (incl. change_reasons, amendment_reasons — D-62) → 400, no repository access', async () => {
    seed(); S.order.length = 0;
    for (const s of ['change_reasons', 'amendment_reasons', 'g_cs_cancel_reasons', '', 'DIAGNOSES']) validationFailed(await rejects(call('listAnatomicCodedValues', { params: { set_name: s } })));
    expect(S.order.filter((x) => x === 'repo')).toEqual([]);
  });
  it('include_inactive adds deactivated codes (they stay displayable)', async () => {
    seed(); S.coded['diagnoses']!.set(uid(603), base(uid(603), { code: 'LOC-0003', display: 'Synthetic diagnosis 3', sort_order: 3, is_active: false }));
    expect(codes(await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' } }))).toEqual(['LOC-0001', 'LOC-0002']);
    expect(codes(await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { include_inactive: true } }))).toEqual(['LOC-0001', 'LOC-0002', 'LOC-0003']);
  });
  it('q searches the display (case-insensitive); q longer than 60 → 400', async () => {
    seed();
    expect(codes(await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { q: 'DIAGNOSIS 2' } }))).toEqual(['LOC-0002']);
    expect(codes(await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { q: 'no such text' } }))).toEqual([]);
    validationFailed(await rejects(call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { q: 'x'.repeat(61) } })));
  });
  it('paging: limit 2 over 5 rows → 2 + next_cursor, cursor → next 2, last page → 1 row and next_cursor null; no row repeated or skipped', async () => {
    seed(); for (let i = 3; i <= 5; i++) S.coded['diagnoses']!.set(uid(600 + i), base(uid(600 + i), { code: `LOC-000${i}`, display: `Synthetic diagnosis ${i}`, sort_order: i }));
    const p1 = await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { limit: 2 } });
    expect(codes(p1)).toEqual(['LOC-0001', 'LOC-0002']); expect(p1.body.page.limit).toBe(2); expect(typeof p1.body.page.next_cursor).toBe('string');
    const p2 = await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { limit: 2, cursor: p1.body.page.next_cursor } }); expect(codes(p2)).toEqual(['LOC-0003', 'LOC-0004']);
    const p3 = await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { limit: 2, cursor: p2.body.page.next_cursor } }); expect(codes(p3)).toEqual(['LOC-0005']); expect(p3.body.page).not.toHaveProperty('next_cursor');
  });
  it.each([['garbage', 'not-a-cursor'], ['letters only', 'AAAA'], ['json of the wrong shape', Buffer.from('{"x":1}').toString('base64url')]])('malformed cursor (%s) → 400 common.invalid_cursor', async (_n, cursor) => {
    seed(); expect(isLimsError(await rejects(call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { cursor } })), 'common.invalid_cursor')).toBe(true);
  });
  it.each([[0], [-1], [201], ['abc']])('limit %s (OpenAPI: integer 1–200, default 50) → 400', async (limit) => { seed(); validationFailed(await rejects(call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { limit } }))); });
});
describe('K12 upsertAnatomicCodedValue', () => {
  const put = (set: string, code: string, v: number, body: Row, ctx?: any) => call('upsertAnatomicCodedValue', { params: { set_name: set, code }, headers: ifm(v), body }, ctx);
  const mk = (over: Row = {}) => ({ display: 'Synthetic diagnosis 9', sort_order: 9, is_active: true, ...over });
  it('AC-14.3: add diagnosis LOC-0001-style code with system defaulting to local → CodedValue, version 1; K11 then lists it so a report draft can select it', async () => {
    seed(); S.coded['diagnoses']!.clear();
    const r = await put('diagnoses', 'LOC-0001', 0, mk({ display: 'Synthetic diagnosis 1', sort_order: 1 }));
    expect([200, 201]).toContain(r.status); expect(r.body).toEqual({ code: 'LOC-0001', display: 'Synthetic diagnosis 1', system: 'local', sort_order: 1, is_active: true, version: 1 });
    expect(S.coded['diagnoses']!.size).toBe(1); expect([...S.coded['diagnoses']!.values()][0]).toMatchObject({ tenant_id: T, created_by: ACTOR });
    expect((await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' } })).body.data.map((v: Row) => v['code'])).toEqual(['LOC-0001']);
  });
  it('system and system_version are stored when given', async () => {
    seed(); const r = await put('diagnoses', 'D123', 0, mk({ system: 'icd-o', system_version: '3.2' })); expect(r.body).toMatchObject({ system: 'icd-o', system_version: '3.2' });
  });
  it('create with is_active:false → stored and returned inactive (the real INSERT has no is_active column, so the service must follow up with an update)', async () => {
    seed(); const r = await put('diagnoses', 'D-OFF', 0, mk({ is_active: false }));
    expect(r.body).toMatchObject({ code: 'D-OFF', is_active: false }); expect([...S.coded['diagnoses']!.values()].find((v) => v['code'] === 'D-OFF')?.['is_active']).toBe(false);
  });
  it('routes by set_name: cytology_adequacy and cancel_reasons write their own tables only', async () => {
    seed();
    await put('cytology_adequacy', 'limited', 0, mk({ display: 'Limited' })); await put('cancel_reasons', 'patient_left', 0, mk({ display: 'Patient left' }));
    expect([...S.coded['cytology_adequacy']!.values()].map((v) => v['code']).sort()).toEqual(['limited', 'satisfactory']); expect([...S.coded['cancel_reasons']!.values()].map((v) => v['code']).sort()).toEqual(['other', 'patient_left']);
    expect(S.coded['diagnoses']!.size).toBe(2);
  });
  it('update with the current version: changes display/sort_order, deactivation keeps the row (is_active false) and the code', async () => {
    seed();
    const r = await put('diagnoses', 'LOC-0001', 1, mk({ display: 'Renamed', sort_order: 4, is_active: false })); expect(r.body).toMatchObject({ code: 'LOC-0001', display: 'Renamed', sort_order: 4, is_active: false, version: 2 });
    expect(S.coded['diagnoses']!.size).toBe(2);
    expect((await call('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { include_inactive: true } })).body.data.map((v: Row) => v['code'])).toContain('LOC-0001');
  });
  it('a cancel reason that shadows a global code can be created ("other"-style override) without touching the global table', async () => {
    seed(); S.coded['cancel_reasons']!.clear(); const g = JSON.stringify(S.globalCancel);
    expect((await put('cancel_reasons', 'duplicate_case', 0, mk({ display: 'Duplicate (our wording)' }))).body.display).toBe('Duplicate (our wording)'); expect(JSON.stringify(S.globalCancel)).toBe(g);
  });
  it('If-Match "0" on an existing code → version_conflict; stale → version_conflict; missing → precondition_required; non-"0" on an unknown code → not_found or version_conflict, never created', async () => {
    seed(); const before = stored();
    expect(isLimsError(await rejects(put('diagnoses', 'LOC-0001', 0, mk())), 'common.version_conflict')).toBe(true);
    expect(isLimsError(await rejects(put('diagnoses', 'LOC-0001', 8, mk())), 'common.version_conflict')).toBe(true);
    expect(isLimsError(await rejects(call('upsertAnatomicCodedValue', { params: { set_name: 'diagnoses', code: 'LOC-0001' }, body: mk() })), 'common.precondition_required')).toBe(true);
    const e = await rejects(put('diagnoses', 'NEW-1', 3, mk())); expect(['common.not_found', 'common.version_conflict']).toContain(e.code); expect(stored()).toBe(before);
  });
  it('two creators racing on the same new code with If-Match "0": one 2xx, the other a conflict/validation error; exactly one row', async () => {
    seed(); const rs = await Promise.allSettled([put('diagnoses', 'RACE-1', 0, mk()), put('diagnoses', 'RACE-1', 0, mk({ display: 'Other' }))]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1); expect([...S.coded['diagnoses']!.values()].filter((v) => v['code'] === 'RACE-1')).toHaveLength(1);
    const lost = (rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason; expect(['common.version_conflict', 'common.validation_failed']).toContain(lost.code);
  });
  it.each([
    ['display empty', { display: '' }, '/display'], ['display 301 chars', { display: 'x'.repeat(301) }, '/display'], ['system 33 chars', { system: 's'.repeat(33) }, '/system'], ['system_version 33 chars', { system_version: 'v'.repeat(33) }, '/system_version'],
    ['sort_order 10000', { sort_order: 10000 }, '/sort_order'], ['sort_order -1', { sort_order: -1 }, '/sort_order'], ['is_active string', { is_active: 'true' }, '/is_active'],
  ])('%s → 400 at the field', async (_n, over, path) => { seed(); validationFailed(await rejects(put('diagnoses', 'OK-1', 0, mk(over))), path); });
  it.each([['space', 'A B'], ['slash', 'A/B'], ['65 chars', 'A'.repeat(65)], ['percent', 'A%20B'], ['semicolon', 'a;drop']])('code in the path that breaks ^[A-Za-z0-9_.:-]{1,64}$ (%s) → 400, nothing stored', async (_n, code) => {
    seed(); const before = stored(); validationFailed(await rejects(put('diagnoses', code, 0, mk()))); expect(stored()).toBe(before);
  });
  it('64-char code and every allowed punctuation (._:-) are accepted', async () => { seed(); for (const c of ['A'.repeat(64), 'a.b_c:d-e']) expect([200, 201]).toContain((await put('diagnoses', c, 0, mk())).status); });
  it('set_name outside the enum (change_reasons: D-62) → 400, nothing stored; unknown fields (code, version) in the body → 400', async () => {
    seed(); const before = stored();
    validationFailed(await rejects(put('change_reasons', 'X1', 0, mk()))); validationFailed(await rejects(put('amendment_reasons', 'X1', 0, mk())));
    validationFailed(await rejects(put('diagnoses', 'X1', 0, mk({ code: 'Y' })))); validationFailed(await rejects(put('diagnoses', 'X1', 0, mk({ version: 4 })))); expect(stored()).toBe(before);
  });
  it('tenant isolation: the same code in another tenant is not touched and does not count as a duplicate', async () => {
    seed(); S.coded['diagnoses']!.set(uid(699), base(uid(699), { tenant_id: T_OTHER, code: 'SHARED-1', display: 'Other tenant' }));
    expect((await put('diagnoses', 'SHARED-1', 0, mk())).body.version).toBe(1); expect(S.coded['diagnoses']!.get(uid(699))!['display']).toBe('Other tenant');
  });
});

// ========================================================================================================= text templates K20–K22
describe('K20 listAnatomicTextTemplates', () => {
  it('active only, ordered section then short_code; TextTemplate shape; other tenant excluded', async () => {
    seed(); S.templates.set(uid(503), base(uid(503), { short_code: 'im1', section: 'impression', title: 'Impression', body: 'Synthetic impression.' }));
    const r = await call('listAnatomicTextTemplates', {});
    expect(r.body.data.map((t: Row) => t['short_code'])).toEqual(['im1', 'nm1']);
    expect(r.body.data[1]).toEqual({ id: TPL_1, short_code: 'nm1', section: 'microscopy', title: 'Normal microscopy', body: 'Synthetic normal microscopy text.', is_active: true, version: 1 });
  });
  it('section filter, include_inactive, invalid section → 400', async () => {
    seed();
    expect((await call('listAnatomicTextTemplates', { query: { section: 'gross' } })).body.data).toEqual([]);
    expect((await call('listAnatomicTextTemplates', { query: { section: 'gross', include_inactive: true } })).body.data.map((t: Row) => t['short_code'])).toEqual(['gr1']);
    validationFailed(await rejects(call('listAnatomicTextTemplates', { query: { section: 'conclusion' } })));
  });
});
describe('K21 createAnatomicTextTemplate', () => {
  const mk = (over: Row = {}) => ({ short_code: 'nm2', section: 'microscopy', title: 'Another', body: 'Synthetic text.', ...over });
  it('201 TextTemplate, active, version 1, tenant + actor stamped', async () => {
    seed(); const r = await call('createAnatomicTextTemplate', { body: mk() });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ short_code: 'nm2', section: 'microscopy', title: 'Another', body: 'Synthetic text.', is_active: true, version: 1 });
    expect(S.templates.get(r.body.id)).toMatchObject({ tenant_id: T, created_by: ACTOR }); expect(keysDeep(r.body).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
  });
  it('every section is accepted; the 8000-char body and 16-char short_code are the upper bounds', async () => {
    seed(); let n = 0;
    for (const s of ['gross', 'microscopy', 'impression', 'comment', 'addendum']) expect((await call('createAnatomicTextTemplate', { body: mk({ section: s, short_code: `s${n++}` }) })).status).toBe(201);
    expect((await call('createAnatomicTextTemplate', { body: mk({ short_code: 'a'.repeat(16), body: 'b'.repeat(8000) }) })).status).toBe(201);
  });
  it('duplicate short_code (same section) → 400 validation_failed at /short_code; nothing stored', async () => {
    seed(); const before = stored(); validationFailed(await rejects(call('createAnatomicTextTemplate', { body: mk({ short_code: 'nm1' }) })), '/short_code'); expect(stored()).toBe(before);
  });
  it.each([
    ['upper-case short_code', { short_code: 'NM1' }, '/short_code'], ['17-char short_code', { short_code: 'a'.repeat(17) }, '/short_code'], ['dash in short_code', { short_code: 'a-b' }, '/short_code'], ['empty short_code', { short_code: '' }, '/short_code'],
    ['bad section', { section: 'conclusion' }, '/section'], ['empty title', { title: '' }, '/title'], ['121-char title', { title: 't'.repeat(121) }, '/title'], ['empty body', { body: '' }, '/body'], ['8001-char body', { body: 'b'.repeat(8001) }, '/body'],
  ])('%s → 400 at the field', async (_n, over, path) => { seed(); validationFailed(await rejects(call('createAnatomicTextTemplate', { body: mk(over) })), path); });
  it('unknown fields (is_active, version, tenant_id) → 400', async () => { seed(); for (const x of [{ is_active: false }, { version: 3 }, { tenant_id: T_OTHER }]) validationFailed(await rejects(call('createAnatomicTextTemplate', { body: mk(x) }))); });
  it('stored body is kept verbatim (no HTML/markup rewriting), and the request body never reaches the logs', async () => {
    seed(); const raw = `${NO_PHI_MARKER} <b>bold</b> & "quotes"`; const r = await call('createAnatomicTextTemplate', { body: mk({ short_code: 'raw1', body: raw }) });
    expect(r.body.body).toBe(raw); expect(calls.logs.join('\n')).not.toContain(NO_PHI_MARKER);
  });
});
describe('K22 updateAnatomicTextTemplate', () => {
  const mk = (over: Row = {}) => ({ title: 'Renamed', body: 'Synthetic changed text.', is_active: true, ...over });
  const put = (id: string, v: number, body: Row) => call('updateAnatomicTextTemplate', { params: { text_template_id: id }, headers: ifm(v), body });
  it('updates title/body/is_active, version +1; short_code and section stay', async () => {
    seed(); const r = await put(TPL_1, 1, mk({ is_active: false })); expect(r.body).toMatchObject({ id: TPL_1, short_code: 'nm1', section: 'microscopy', title: 'Renamed', body: 'Synthetic changed text.', is_active: false, version: 2 });
  });
  it('short_code / section are immutable: present in the body → 400; bounds on title/body → 400', async () => {
    seed(); const before = stored();
    validationFailed(await rejects(put(TPL_1, 1, { ...mk(), short_code: 'zz' }))); validationFailed(await rejects(put(TPL_1, 1, { ...mk(), section: 'gross' })));
    validationFailed(await rejects(put(TPL_1, 1, mk({ title: '' })))); validationFailed(await rejects(put(TPL_1, 1, mk({ body: 'b'.repeat(8001) })))); validationFailed(await rejects(put(TPL_1, 1, { title: 'x', body: 'y' }))); expect(stored()).toBe(before);
  });
  it('If-Match missing → precondition_required; stale → version_conflict; unknown / other tenant\'s id → not_found', async () => {
    seed();
    expect(isLimsError(await rejects(call('updateAnatomicTextTemplate', { params: { text_template_id: TPL_1 }, body: mk() })), 'common.precondition_required')).toBe(true);
    expect(isLimsError(await rejects(put(TPL_1, 5, mk())), 'common.version_conflict')).toBe(true);
    expect(isLimsError(await rejects(put(uid(9), 1, mk())), 'common.not_found')).toBe(true);
    expect(isLimsError(await rejects(put(TPL_OTHER, 1, mk())), 'common.not_found')).toBe(true); expect(S.templates.get(TPL_OTHER)!['title']).toBe('Other tenant');
  });
});

// ========================================================================================================= cross-cutting
describe('cross-cutting (07-SECURITY): no payload in logs, no side effects on case data, every handler implemented', () => {
  it('none of the twelve handlers is a stub any more (a stub answers 501 / common.internal)', async () => {
    seed();
    for (const [, op, req] of [...READS, ...WRITES]) {
      const r = await call(op, req(), mkCtx()).then((x) => x, (e) => e);
      expect(r instanceof Error ? (r as LimsError).code : r.status, op).not.toBe(r instanceof Error ? 'common.internal' : 501);
    }
  });
  it('writing configuration never touches case rows (existing cases unchanged, AC-14.1)', async () => {
    seed(); const before = JSON.stringify([...S.cases]);
    expect((await call('createAnatomicStain', { body: { code: 'NEW_STAIN', display: 'New stain', kind: 'special', sort_order: 7 } })).status).toBe(201); // a handler that always fails would pass this test vacuously
    for (const [, op, req] of WRITES) await call(op, req(), mkCtx()).catch(() => undefined);
    expect(S.caseWrites).toBe(0); expect(JSON.stringify([...S.cases])).toBe(before);
  });
  it('rejected requests (validation, conflict, forbidden) log no request body and no free text', async () => {
    seed();
    expect((await call('createAnatomicTextTemplate', { body: { short_code: 'ok1', section: 'gross', title: NO_PHI_MARKER, body: NO_PHI_MARKER } })).status).toBe(201); // success path logs no body either
    validationFailed(await rejects(call('createAnatomicTextTemplate', { body: { short_code: 'NM1', section: 'microscopy', title: NO_PHI_MARKER, body: NO_PHI_MARKER } })));
    expect(isLimsError(await rejects(call('updateAnatomicTextTemplate', { params: { text_template_id: TPL_1 }, headers: ifm(9), body: { title: NO_PHI_MARKER, body: NO_PHI_MARKER, is_active: true } })), 'common.version_conflict')).toBe(true);
    await call('createAnatomicTextTemplate', { body: { short_code: 'nm9', section: 'gross', title: NO_PHI_MARKER, body: NO_PHI_MARKER } }, mkCtx({ deny: TECH })).catch(() => undefined);
    expect(calls.logs.join('\n')).not.toContain(NO_PHI_MARKER);
  });
  it('error problems for field errors carry paths/codes only, never the submitted values', async () => {
    seed(); const e = await rejects(call('createAnatomicStain', { body: { code: 'HE', display: NO_PHI_MARKER, kind: 'routine', sort_order: 1 } }));
    validationFailed(e, '/code'); expect(JSON.stringify({ detail: e.detail, errors: e.errors, message: e.message })).not.toContain(NO_PHI_MARKER);
  });
});
