// C11.T-13 — report drafts: R1 getAnatomicReportDraft, R2 saveAnatomicReportDraft (02-TRD §5.3 R1/R2 + ReportDraftInput, §4.5.2 instance values, §4.6 plain text, §5 "Edits on a signed_out case" D-66 (b),
// §7 case states, §10.2 settings.max_report_images; 01-PRD AC-07.1, 07.3, 07.4, 07.5, 07.6 and the draft side of AC-08.5 / AC-08.6; 07-SECURITY AB-5, §5.1 tenant probes (body ids), REQ-SEC-098 no PHI in logs,
// 08 A17 D-66; 05-SCHEMA `anatomic.report_drafts` + CHECKs + the two partial unique indexes (one open draft per case, one initial draft per case)).
// Drives the REAL handlers (manifest.handlers) on IN-MEMORY repositories (vi.mock of drafts/cases/config/codedValues/images/templates/stainOrders repo with the T-04 signatures). The drafts mock emulates
// the table: NOT NULL id, defaults, kind/flag/lens CHECKs, the unique indexes (23505), If-Match version, frozen non-open rows (P0001 immutable_row). Real RLS + real indexes: integration/report.draft.live.test.ts (GATED).
//
// SEAMS (spec fixes behaviour; names chosen here — the writer follows or disputes):
//   * Order in R1/R2: load case through the tenant-bound repo (404 if invisible / malformed id) -> IdentityPort.assertRole({ permission, centreId: case.centre_id }) ('anatomic.case.read' for R1,
//     'anatomic.case.work' for R2) -> state guard -> If-Match -> body validation (all errors before any write) -> write. Same order as A8 saveAnatomicGross.
//   * R2 If-Match = draft.version; "0" creates the INITIAL draft (kind 'initial', version 1, row tenant/centre/case from the case, created_by = actor). "0" while an open draft exists, any other number that
//     does not equal the open draft's version, or any number when no open draft exists -> 409 common.version_conflict (a lost "0" race — DB error 23505 on report_drafts__tenant_id_case_open__p_uq or
//     ..._initial__p_uq — is also common.version_conflict, never a raw unique violation). Absent -> 428 common.precondition_required; malformed -> 400. Success = 200 with the ReportDraft, version +1 on update.
//   * Case state: received / cancelled -> 409 anatomic.case_invalid_transition; signed_out WITHOUT an open draft -> 409 anatomic.signout_locked (also for If-Match "0"); signed_out WITH an open
//     revision/amendment draft -> the save updates THAT draft (kind and change_reason_* unchanged). accessioned / in_processing / ready_for_reporting are editable.
//   * Body = ReportDraftInput, closed object (AB-5 unknown field -> 400 common.validation_failed), PUT = full replace: an omitted field is reset (texts '', is_critical false, flag cleared, lists []).
//     Limits: gross/microscopy 20000, impression/comment 8000 (AC-07.4: 400 at '/impression_text'), flag N|A, synoptic <= 5, image_ids <= 24 (structural 400 at '/image_ids'), ancillary <= 50
//     (result_text 1–2000), diagnosis_codes <= 20. Texts are stored through domain/plaintext.ts normalizePlainText (CRLF -> LF, controls removed, trailing whitespace trimmed).
//   * Images: every id must be an image of THIS case and tenant (other case / other tenant / unknown -> common.validation_failed at '/image_ids/<i>' OR common.not_found: both leak nothing);
//     count > settings.max_report_images (default 12 when the settings row does not exist) -> 422 anatomic.image_limit_reached (AC-07.5), nothing stored. Order of ids = print order, kept.
//   * Diagnosis codes (AC-07.6): each code must be an ACTIVE row of this tenant's diagnoses (listCodedDiagnoses) else 400 common.validation_failed at '/diagnosis_codes/<i>/code'. Stored as the text[] of codes;
//     the response lists { code, display, system, system_version? } in input order.
//   * Synoptic instance input { template_id, values } (closed). The template is loaded through templates.repo.getSynopticTemplate: unknown / other tenant -> 400 at '/synoptic/<i>/template_id' or 404;
//     status draft or retired -> 409 anatomic.template_not_published (AC-08.6) — EXCEPT an instance of that same template_id that is already in the open draft (AC-08.4: the draft keeps the version it
//     started with; re-saving it unchanged must not fail when a newer version got published and the old one retired). values are checked with domain validateSynopticValues(definition, values) (types, options,
//     hidden fields absent, unknown keys) -> 400 at '/synoptic/<i>/values/<key>'; `required` is NOT enforced at draft save (AC-08.5). The stored/returned instance is { template_id, template_key,
//     template_version, title, values } with key/version/title taken from the template row, never from the client.
//   * Ancillary { stain_order_id, result_text }: the stain order must be of this case and tenant (400 at '/ancillary/<i>/stain_order_id' or 404; "completed" is a sign-out check, not a draft check).
//   * ReportDraft (R1/R2 body) = { case_id, kind, change_reason_code?, change_reason_text?, gross_text, microscopy_text, impression_text, comment_text, flag?, is_critical, synoptic, image_ids, ancillary,
//     diagnosis_codes, updated_at, updated_by_display_name (ctx.core.user(...).displayName of updated_by), version } — closed key set, no nulls, no tenant/centre/actor ids.
//   * R1: no OPEN draft (none, or only consumed/discarded) -> 404 common.not_found.
//   * AC-07.3 has no endpoint (the UI button composes text): the rule is a pure function `composeGrossFromParts({ parts: [{ id, letter, site_text }], gross: [{ part_id, gross_text, is_complete }] }): string`
//     exported from service/report.service.ts — one line per part in letter order, "A. <site>: <gross text>". Only parts with a completed gross record are included.
// Fails now: R1 / R2 are 501 / common.internal stubs; composeGrossFromParts does not exist.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError, isLimsError } from '../../../core/errors.js';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  cases: new Map<string, Row>(), drafts: new Map<string, Row>(), images: new Map<string, Row>(), diagnoses: new Map<string, Row>(), templates: new Map<string, Row>(), stainOrders: new Map<string, Row>(),
  settings: new Map<string, Row>(), writes: 0, seq: 0,
}));
const pgErr = (code: string, constraint: string) => Object.assign(new Error('constraint violation'), { code, constraint });
const touch = (write = false) => { if (write) S.writes++; };
const undo = (tx: unknown, f: () => void) => { (tx as { undo?: (() => void)[] } | undefined)?.undo?.push(f); };
const mine = (m: Map<string, Row>, i: Row) => [...m.values()].filter((r) => r['tenant_id'] === i['tenantId']);
const newId = () => `0190c411-ffff-7000-8000-${String(++S.seq).padStart(12, '0')}`;

const DRAFT_COLS = ['status', 'change_reason_code', 'change_reason_text', 'gross_text', 'microscopy_text', 'impression_text', 'comment_text', 'flag', 'is_critical', 'synoptic', 'ancillary', 'image_ids',
  'diagnosis_codes', 'consumed_version_no', 'consumed_at', 'discarded_at'];
function checkDraft(r: Row): void {
  if (!['initial', 'revision', 'amendment'].includes(r['kind'])) throw pgErr('23514', 'report_drafts__kind__ck');
  if (r['kind'] !== 'initial' && !r['change_reason_code']) throw pgErr('23514', 'report_drafts__reason__ck');
  if (r['flag'] != null && !['N', 'A'].includes(r['flag'])) throw pgErr('23514', 'report_drafts__flag__ck');
  const len = (k: string) => String(r[k] ?? '').length;
  if (len('gross_text') > 20000 || len('microscopy_text') > 20000 || len('impression_text') > 8000 || len('comment_text') > 8000 || len('change_reason_text') > 500
    || r['image_ids'].length > 24 || r['diagnosis_codes'].length > 20 || r['synoptic'].length > 5 || r['ancillary'].length > 50) throw pgErr('23514', 'report_drafts__lens__ck');
}
const openOf = (tenant: string, caseId: string) => [...S.drafts.values()].find((d) => d['tenant_id'] === tenant && d['case_id'] === caseId && d['status'] === 'open');

vi.mock('../repository/drafts.repo.js', () => ({
  async insertReportDraft(tx: unknown, row: Row) {
    touch(true);
    for (const k of ['id', 'tenant_id', 'centre_id', 'case_id', 'kind', 'created_by', 'updated_by']) if (!row[k]) throw pgErr('23502', `report_drafts__${k}__notnull`);
    const r: Row = {
      status: 'open', change_reason_code: null, change_reason_text: null, gross_text: '', microscopy_text: '', impression_text: '', comment_text: '', flag: null, is_critical: false, synoptic: [], ancillary: [],
      image_ids: [], diagnosis_codes: [], base_version_no: 0, consumed_version_no: null, consumed_at: null, discarded_at: null, version: 1, created_at: '2026-11-13T04:00:00.000Z', updated_at: '2026-11-13T04:00:00.000Z',
      ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null)),
    };
    checkDraft(r);
    if (r['status'] === 'open' && openOf(r['tenant_id'], r['case_id'])) throw pgErr('23505', 'report_drafts__tenant_id_case_open__p_uq');
    if (r['kind'] === 'initial' && [...S.drafts.values()].some((d) => d['tenant_id'] === r['tenant_id'] && d['case_id'] === r['case_id'] && d['kind'] === 'initial')) throw pgErr('23505', 'report_drafts__tenant_id_case_initial__p_uq');
    S.drafts.set(r['id'], r); undo(tx, () => S.drafts.delete(r['id'])); return { ...r };
  },
  async getReportDraft(_tx: unknown, i: Row) { const r = S.drafts.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async listReportDrafts(_tx: unknown, i: Row) { return mine(S.drafts, i).filter((d) => d['case_id'] === i['caseId']).map((d) => ({ ...d })); },
  async getOpenDraft(_tx: unknown, i: Row) { const r = openOf(i['tenantId'], i['caseId']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async updateReportDraft(tx: unknown, i: Row) {
    touch(true);
    for (const k of Object.keys(i['patch'])) if (i['patch'][k] !== undefined && !DRAFT_COLS.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
    const r = S.drafts.get(i['id']);
    if (!r || r['tenant_id'] !== i['tenantId'] || r['version'] !== i['expectedVersion']) return undefined;
    if (r['status'] !== 'open') throw Object.assign(new Error('immutable_row'), { code: 'P0001' });
    const next = { ...r, ...Object.fromEntries(Object.entries(i['patch']).filter(([, v]) => v !== undefined)), version: r['version'] + 1, updated_by: i['actorId'], updated_at: '2026-11-13T04:05:00.000Z' };
    checkDraft(next);
    S.drafts.set(i['id'], next); undo(tx, () => S.drafts.set(i['id'], r)); return { ...next };
  },
}));
vi.mock('../repository/cases.repo.js', () => ({
  async getCase(_tx: unknown, i: Row) { const r = S.cases.get(i['caseId']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async updateCase() { touch(true); return undefined; }, async insertCaseTransition() { touch(true); }, async listCaseTransitions() { return []; }, async listCases() { return []; }, async listCasesByOrder() { return []; },
  async insertCase() { touch(true); }, async listCaseItems() { return []; }, async getCaseItem() { return undefined; }, async insertCaseItem() { touch(true); }, async updateCaseItem() { touch(true); },
  async getCaseTransition() { return undefined; },
}));
vi.mock('../repository/config.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return { ...m, async getSettings(_tx: unknown, i: Row) { const r = S.settings.get(i['tenantId']); return r ? { ...r } : undefined; } };
});
vi.mock('../repository/codedValues.repo.js', async (orig) => {
  const m = (await orig()) as Row;
  return {
    ...m,
    async getCodedDiagnosis(_tx: unknown, i: Row) { const r = S.diagnoses.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
    async listCodedDiagnoses(_tx: unknown, i: Row) { // same semantics as the real SQL: tenant filter, activeOnly, q on display (case-insensitive), ORDER BY sort_order, code, id, LIMIT (default 200, max 500)
      const q = String(i['q'] ?? '').toLowerCase(); const lim = Math.min(Math.max(Math.trunc(Number(i['limit'] ?? 200)) || 200, 1), 500); const off = Math.max(Math.trunc(Number(i['offset'] ?? 0)) || 0, 0);
      return mine(S.diagnoses, i).filter((r) => (!i['activeOnly'] || r['is_active']) && (!q || String(r['display']).toLowerCase().includes(q)))
        .sort((a, b) => a['sort_order'] - b['sort_order'] || (a['code'] < b['code'] ? -1 : a['code'] > b['code'] ? 1 : 0)).slice(off, off + lim).map((r) => ({ ...r }));
    },
  };
});
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
// repos this task does not own: answer empty so a handler that reads them works without extra seams
const emptyRepo = vi.hoisted(() => async (orig: () => Promise<unknown>) => {
  const m = (await orig()) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(m).map((k) => [k, async () => (k.startsWith('list') ? [] : undefined)]));
});
vi.mock('../repository/parts.repo.js', emptyRepo); vi.mock('../repository/slides.repo.js', emptyRepo); vi.mock('../repository/blocks.repo.js', emptyRepo);
vi.mock('../repository/gross.repo.js', emptyRepo); vi.mock('../repository/addenda.repo.js', emptyRepo); vi.mock('../repository/versions.repo.js', emptyRepo); vi.mock('../repository/movements.repo.js', emptyRepo);
vi.mock('../repository/specimenLinks.repo.js', emptyRepo); vi.mock('../repository/submissions.repo.js', emptyRepo); vi.mock('../repository/molecular.repo.js', emptyRepo);
vi.mock('../repository/batches.repo.js', emptyRepo); vi.mock('../repository/counters.repo.js', emptyRepo);

const { manifest } = await import('../index.js');

const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '01a1a98a-ac40-7000-8000-00000000a001', T_OTHER = '01a1a98a-ac40-7000-8000-00000000b001', ACTOR = '01a1a98a-ac40-7000-8000-00000000a300';
const C_A1 = '01a1a98a-ac40-7000-8000-00000000a201', C_A2 = '01a1a98a-ac40-7000-8000-00000000a202', C_B1 = '01a1a98a-ac40-7000-8000-00000000b201';
const CASE = { HISTO: uid(101), READY: uid(102), RECEIVED: uid(103), CANCELLED: uid(104), SIGNED: uid(105), SIGNED_REV: uid(106), OTHER: uid(107), A2: uid(108), EXIST: uid(109), DISCARDED: uid(110), SIGNED_AMD: uid(111) };
const TPL = { PUB: uid(701), V1_RETIRED: uid(702), RET: uid(703), DRAFT: uid(704), OTHER: uid(799) };
const SO = { OK: uid(801), OTHER_CASE: uid(802), OTHER_TENANT: uid(899) };
const IMG = (n: number) => uid(600 + n), IMG_OTHER_CASE = uid(650), IMG_OTHER_TENANT = uid(651), IMG_UNKNOWN = uid(699);
const MARKER = 'SYNTHETIC-DRAFT-PHI-MARKER';
const FORBIDDEN_KEYS = ['tenant_id', 'centre_id', 'created_by', 'updated_by', 'created_at', 'status', 'base_version_no', 'consumed_at', 'discarded_at', 'consumed_version_no', 'id'];
const DTO_REQUIRED = ['case_id', 'kind', 'gross_text', 'microscopy_text', 'impression_text', 'comment_text', 'is_critical', 'synoptic', 'image_ids', 'ancillary', 'diagnosis_codes', 'updated_at', 'updated_by_display_name', 'version'];
const DTO_ALLOWED = [...DTO_REQUIRED, 'change_reason_code', 'change_reason_text', 'flag'];

interface CtxOpts { deny?: Record<string, string>; tenant?: string; denyCentre?: string }
const calls = { assertRole: [] as Row[], logs: [] as string[] };
const mkCtx = (o: CtxOpts = {}) => ({
  operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999),
  log: { info: (x: object) => calls.logs.push(JSON.stringify(x)), warn: (x: object) => calls.logs.push(JSON.stringify(x)), error: (x: object) => calls.logs.push(JSON.stringify(x)) },
  tenantId: o.tenant ?? T, actor: { type: 'user', id: ACTOR, membershipId: uid(5000) }, tx: { undo: [] as (() => void)[], async query() { touch(true); return { rows: [] }; } }, now: () => new Date('2026-11-13T04:00:00Z'),
  core: {
    async branch() { return { branchCode: 'KTM' }; }, memberships: { async list() { return []; } },
    async user(_c: unknown, i: Row) { return { displayName: i['userId'] === ACTOR ? 'Dr Synthetic One' : 'Dr Synthetic Two' }; },
  },
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
const NO_WORK = { 'anatomic.case.work': 'auth.forbidden' } as const, NO_READ = { 'anatomic.case.read': 'auth.forbidden' } as const;

/** emulates requestTx: a throwing handler rolls back every write made through ctx.tx (undo journal kept by the mocks) */
async function call(op: string, req: Row, ctx = mkCtx()): Promise<any> {
  try { return await (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx); } catch (e) {
    for (const u of [...ctx.tx.undo].reverse()) u();
    throw e;
  }
}
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const stored = () => JSON.stringify({ d: [...S.drafts], c: [...S.cases] });
const validationFailed = (e: any, path?: string) => {
  expect(isLimsError(e, 'common.validation_failed'), `code ${e?.code}`).toBe(true);
  if (path) expect((e as LimsError).errors?.some((f) => f.path === path), `errors[] has ${path}: ${JSON.stringify((e as LimsError).errors)}`).toBe(true);
};
const refused = (e: any) => expect(isLimsError(e, 'common.validation_failed') || isLimsError(e, 'common.not_found'), `code ${e?.code}`).toBe(true); // body id of another case / tenant: 400 or 404 (07-SECURITY §5.1)
const conflict = (e: any, code: string) => { expect(isLimsError(e, code), `expected ${code}, got ${e?.code}`).toBe(true); expect((e as LimsError).statusCode).toBe(409); };
const hasNoNulls = (x: unknown): boolean => x === null ? false : Array.isArray(x) ? x.every(hasNoNulls) : x && typeof x === 'object' ? Object.values(x).every(hasNoNulls) : true;
const keysDeep = (x: unknown): string[] => Array.isArray(x) ? x.flatMap(keysDeep) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...keysDeep(v)]) : [];
const drafts = (caseId: string) => [...S.drafts.values()].filter((d) => d['case_id'] === caseId);

const caseRow = (id: string, over: Row = {}): Row => ({ id, tenant_id: T, centre_id: C_A1, case_kind: 'histology', status: 'in_processing', version: 5, accession_no: `SYN-H-${id.slice(-3)}`, ...over });
const draftRow = (id: string, caseId: string, over: Row = {}): Row => ({
  id, tenant_id: T, centre_id: C_A1, case_id: caseId, kind: 'initial', status: 'open', change_reason_code: null, change_reason_text: null, gross_text: '', microscopy_text: '', impression_text: '', comment_text: '',
  flag: null, is_critical: false, synoptic: [], ancillary: [], image_ids: [], diagnosis_codes: [], base_version_no: 0, consumed_version_no: null, consumed_at: null, discarded_at: null, version: 1,
  created_at: '2026-11-12T00:00:00.000Z', created_by: ACTOR, updated_at: '2026-11-12T00:00:00.000Z', updated_by: ACTOR, ...over,
});
const DEF = {
  schema_version: 1, title: 'Synthetic checklist', applies_to_case_kinds: ['histology'],
  sections: [{ key: 'tumour', heading: 'Tumour', fields: [
    { key: 'site', label: 'Site', type: 'text', required: true, max_length: 20 },
    { key: 'grade', label: 'Grade', type: 'single_select', required: true, options: [{ code: 'g1', display: 'Grade 1' }, { code: 'g2', display: 'Grade 2' }] },
    { key: 'necrosis', label: 'Necrosis', type: 'boolean', required: false },
    { key: 'necrosis_note', label: 'Necrosis note', type: 'text', required: false, show_if: { field_key: 'necrosis', equals: true } },
    { key: 'tags', label: 'Tags', type: 'multi_select', required: false, options: [{ code: 'a', display: 'A' }, { code: 'b', display: 'B' }, { code: 'c', display: 'C' }] },
  ] }],
};
const tpl = (id: string, over: Row = {}): Row => ({ id, tenant_id: T, template_key: 'synth_a', version_no: 2, status: 'published', title: 'Synthetic checklist', applies_to_case_kinds: ['histology'], definition: DEF,
  published_at: '2026-11-01T00:00:00.000Z', version: 2, is_active: true, created_by: ACTOR, updated_by: ACTOR, ...over });
const GOOD_VALUES = { site: 'Left lobe', grade: 'g2', necrosis: false, tags: ['a', 'b'] };

function seed() {
  for (const [id, over] of [
    [CASE.HISTO, {}], [CASE.READY, { status: 'ready_for_reporting' }], [CASE.RECEIVED, { status: 'received' }], [CASE.CANCELLED, { status: 'cancelled' }], [CASE.SIGNED, { status: 'signed_out' }],
    [CASE.SIGNED_REV, { status: 'signed_out' }], [CASE.SIGNED_AMD, { status: 'signed_out' }], [CASE.OTHER, { tenant_id: T_OTHER, centre_id: C_B1 }], [CASE.A2, { centre_id: C_A2 }], [CASE.EXIST, {}], [CASE.DISCARDED, {}],
  ] as [string, Row][]) S.cases.set(id, caseRow(id, over));
  const d = (id: string, c: string, over: Row = {}) => S.drafts.set(id, draftRow(id, c, over));
  d(uid(901), CASE.EXIST, { version: 3, impression_text: 'Existing impression', updated_at: '2026-11-12T08:00:00.000Z' });
  d(uid(902), CASE.SIGNED_REV, { kind: 'revision', change_reason_code: 'correction', change_reason_text: 'Typo in diagnosis', version: 1, impression_text: 'Revised impression', base_version_no: 1 });
  d(uid(903), CASE.DISCARDED, { status: 'discarded', discarded_at: '2026-11-12T09:00:00.000Z', kind: 'revision', change_reason_code: 'correction' });
  d(uid(904), CASE.SIGNED_AMD, { kind: 'amendment', change_reason_code: 'wrong_patient', version: 2, base_version_no: 1 });
  for (let n = 1; n <= 26; n++) S.images.set(IMG(n), { id: IMG(n), tenant_id: T, case_id: CASE.HISTO, centre_id: C_A1, kind: 'microscopy', state: 'ready', scan_state: 'clean', is_active: true, version: 1, object_path: `${T}/2026/11/${IMG(n)}.png` });
  S.images.set(IMG_OTHER_CASE, { id: IMG_OTHER_CASE, tenant_id: T, case_id: CASE.READY, centre_id: C_A1, kind: 'gross', state: 'ready', scan_state: 'clean', is_active: true, version: 1 });
  S.images.set(IMG_OTHER_TENANT, { id: IMG_OTHER_TENANT, tenant_id: T_OTHER, case_id: CASE.OTHER, centre_id: C_B1, kind: 'gross', state: 'ready', scan_state: 'clean', is_active: true, version: 1 });
  const dx = (id: string, tenant: string, code: string, over: Row = {}) => S.diagnoses.set(id, { id, tenant_id: tenant, code, display: `Synthetic diagnosis ${code}`, system: 'local', system_version: null, sort_order: 0, is_active: true, version: 1, ...over });
  dx(uid(501), T, 'LOC-0001'); dx(uid(502), T, 'LOC-0002', { system_version: '1' }); dx(uid(509), T, 'LOC-0009', { is_active: false }); dx(uid(580), T_OTHER, 'LOC-B001');
  for (let n = 10; n <= 30; n++) dx(uid(520 + n), T, `LOC-${String(n).padStart(4, '0')}`);
  S.templates.set(TPL.PUB, tpl(TPL.PUB));
  S.templates.set(TPL.V1_RETIRED, tpl(TPL.V1_RETIRED, { version_no: 1, status: 'retired', retired_at: '2026-11-10T00:00:00.000Z' }));
  S.templates.set(TPL.RET, tpl(TPL.RET, { template_key: 'synth_ret', version_no: 1, status: 'retired' }));
  S.templates.set(TPL.DRAFT, tpl(TPL.DRAFT, { template_key: 'synth_draft', version_no: 1, status: 'draft', published_at: null }));
  S.templates.set(TPL.OTHER, tpl(TPL.OTHER, { tenant_id: T_OTHER, template_key: 'synth_x' }));
  S.stainOrders.set(SO.OK, { id: SO.OK, tenant_id: T, case_id: CASE.HISTO, centre_id: C_A1, stain_code: 'IHC_SYN_1', stain_kind: 'ihc', status: 'completed', version: 3 });
  S.stainOrders.set(SO.OTHER_CASE, { id: SO.OTHER_CASE, tenant_id: T, case_id: CASE.READY, centre_id: C_A1, stain_code: 'IHC_SYN_1', stain_kind: 'ihc', status: 'completed', version: 3 });
  S.stainOrders.set(SO.OTHER_TENANT, { id: SO.OTHER_TENANT, tenant_id: T_OTHER, case_id: CASE.OTHER, centre_id: C_B1, stain_code: 'IHC_SYN_1', stain_kind: 'ihc', status: 'completed', version: 3 });
}
beforeEach(() => {
  for (const m of [S.cases, S.drafts, S.images, S.diagnoses, S.templates, S.stainOrders, S.settings]) m.clear();
  S.writes = 0; S.seq = 0; calls.assertRole.length = 0; calls.logs.length = 0;
  seed(); S.writes = 0;
});

const save = (body: Row, caseId = CASE.HISTO, rev = 0, ctx = mkCtx()) => call('saveAnatomicReportDraft', { params: { case_id: caseId }, headers: ifm(rev), body }, ctx);
const get = (caseId = CASE.HISTO, ctx = mkCtx()) => call('getAnatomicReportDraft', { params: { case_id: caseId } }, ctx);
const FULL = { gross_text: 'Gross: antral biopsy.', microscopy_text: 'Microscopy: mucosa with mild gastritis.', impression_text: 'Chronic gastritis.', comment_text: 'Correlate clinically.' };
const ids = (from: number, n: number) => Array.from({ length: n }, (_, k) => IMG(from + k));

describe('R2 saveAnatomicReportDraft — create / update with If-Match (AC-07.1)', () => {
  it('AC-07.1: If-Match "0" creates the initial draft with microscopy, impression and comment → 200, kind initial, version 1; the row is tenant/centre/case-scoped and created by the actor', async () => {
    const r = await save({ microscopy_text: 'Mucosa with mild gastritis.', impression_text: 'Chronic gastritis.', comment_text: 'Correlate clinically.' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ case_id: CASE.HISTO, kind: 'initial', microscopy_text: 'Mucosa with mild gastritis.', impression_text: 'Chronic gastritis.', comment_text: 'Correlate clinically.', gross_text: '', is_critical: false,
      synoptic: [], image_ids: [], ancillary: [], diagnosis_codes: [], version: 1, updated_by_display_name: 'Dr Synthetic One' });
    expect(typeof r.body.updated_at).toBe('string');
    const rows = drafts(CASE.HISTO);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: T, centre_id: C_A1, case_id: CASE.HISTO, kind: 'initial', status: 'open', created_by: ACTOR, updated_by: ACTOR, version: 1 });
    expect(typeof rows[0]!['id']).toBe('string');
    expect(S.cases.get(CASE.HISTO)!['status']).toBe('in_processing'); // saving a draft is not a case transition
  });
  it('AC-07.1: a second save with the current version increments the draft version (1 → 2 → 3); the full text is kept; kind stays initial', async () => {
    await save({ ...FULL });
    const r2 = await save({ ...FULL, impression_text: 'Chronic active gastritis.' }, CASE.HISTO, 1);
    expect(r2.body).toMatchObject({ version: 2, kind: 'initial', impression_text: 'Chronic active gastritis.', gross_text: FULL.gross_text });
    const r3 = await save({ ...FULL }, CASE.HISTO, 2);
    expect(r3.body.version).toBe(3);
    expect(drafts(CASE.HISTO)).toHaveLength(1);
    expect(drafts(CASE.HISTO)[0]!['version']).toBe(3);
  });
  it('AC-07.1: a stale If-Match → 409 common.version_conflict and nothing changes (stale 1 after the bump, "0" while a draft exists, a future number)', async () => {
    await save({ ...FULL }); await save({ ...FULL, impression_text: 'v2' }, CASE.HISTO, 1);
    const before = stored();
    for (const rev of [1, 0, 3, 99]) conflict(await rejects(save({ ...FULL, impression_text: 'lost' }, CASE.HISTO, rev)), 'common.version_conflict');
    expect(stored()).toBe(before);
  });
  it('a numbered If-Match when the case has no open draft → 409 common.version_conflict (nothing to update), nothing created', async () => {
    conflict(await rejects(save({ ...FULL }, CASE.HISTO, 1)), 'common.version_conflict');
    expect(drafts(CASE.HISTO)).toEqual([]);
    expect(S.writes).toBe(0);
  });
  it('If-Match absent → 428 common.precondition_required; malformed ("abc", unquoted, negative, huge) → 400; none of them writes', async () => {
    expect(isLimsError(await rejects(call('saveAnatomicReportDraft', { params: { case_id: CASE.HISTO }, headers: {}, body: FULL })), 'common.precondition_required')).toBe(true);
    for (const h of ['"abc"', '3', '"-1"', '"99999999999"', '"01"', '']) {
      validationFailed(await rejects(call('saveAnatomicReportDraft', { params: { case_id: CASE.HISTO }, headers: { 'if-match': h }, body: FULL })));
    }
    expect(S.writes).toBe(0);
  });
  it('an existing draft (version 3, seeded) is updated in place by If-Match "3" → version 4; the other fields are reset by the full replace', async () => {
    const r = await save({ impression_text: 'Replaced.' }, CASE.EXIST, 3);
    expect(r.body).toMatchObject({ version: 4, impression_text: 'Replaced.', gross_text: '', microscopy_text: '' });
    expect(drafts(CASE.EXIST)).toHaveLength(1);
    expect(drafts(CASE.EXIST)[0]).toMatchObject({ id: uid(901), version: 4, updated_by: ACTOR });
  });
  it('PUT = full replace: a save that omits fields resets them (texts "", flag cleared, is_critical false, lists empty)', async () => {
    await save({ ...FULL, flag: 'A', is_critical: true, image_ids: ids(1, 2), diagnosis_codes: [{ code: 'LOC-0001' }], ancillary: [{ stain_order_id: SO.OK, result_text: 'Positive' }], synoptic: [{ template_id: TPL.PUB, values: GOOD_VALUES }] });
    const r = await save({ impression_text: 'Only this.' }, CASE.HISTO, 1);
    expect(r.body).toMatchObject({ version: 2, gross_text: '', microscopy_text: '', impression_text: 'Only this.', comment_text: '', is_critical: false, image_ids: [], diagnosis_codes: [], ancillary: [], synoptic: [] });
    expect('flag' in r.body).toBe(false);
    expect(drafts(CASE.HISTO)[0]).toMatchObject({ flag: null, is_critical: false, image_ids: [], diagnosis_codes: [], synoptic: [], ancillary: [] });
  });
  it('an empty body {} is a valid full replace (creates an empty initial draft)', async () => {
    const r = await save({});
    expect(r.body).toMatchObject({ kind: 'initial', version: 1, impression_text: '', synoptic: [] });
  });
  it('two parallel creates with If-Match "0": exactly one wins, the other gets common.version_conflict (never a raw unique violation); one open draft remains', async () => {
    const rs = await Promise.allSettled([save({ ...FULL }), save({ ...FULL, impression_text: 'other' })]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = rs.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(isLimsError(lost.reason, 'common.version_conflict'), `code ${lost.reason?.code}`).toBe(true);
    expect(drafts(CASE.HISTO)).toHaveLength(1);
  });
  it('two parallel updates with the same If-Match: exactly one wins, version moves by exactly 1', async () => {
    await save({ ...FULL });
    const rs = await Promise.allSettled([save({ ...FULL, impression_text: 'A' }, CASE.HISTO, 1), save({ ...FULL, impression_text: 'B' }, CASE.HISTO, 1)]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(isLimsError((rs.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict')).toBe(true);
    expect(drafts(CASE.HISTO)[0]!['version']).toBe(2);
  });
  it('a ready_for_reporting case is editable too; the draft is created with that case\'s centre', async () => {
    const r = await save({ ...FULL }, CASE.READY);
    expect(r.status).toBe(200);
    expect(drafts(CASE.READY)[0]).toMatchObject({ centre_id: C_A1, case_id: CASE.READY });
  });
});

describe('R2 — text limits and plain text (AC-07.4)', () => {
  it('AC-07.4: impression text of 8,001 characters → 400 common.validation_failed at /impression_text, nothing stored; exactly 8,000 is accepted', async () => {
    validationFailed(await rejects(save({ impression_text: 'x'.repeat(8001) })), '/impression_text');
    expect(S.writes).toBe(0); expect(drafts(CASE.HISTO)).toEqual([]);
    expect((await save({ impression_text: 'x'.repeat(8000) })).body.impression_text).toHaveLength(8000);
  });
  it('the other limits: comment 8,001, gross 20,001, microscopy 20,001 → 400 at their own path; 20,000 accepted for gross and microscopy', async () => {
    validationFailed(await rejects(save({ comment_text: 'c'.repeat(8001) })), '/comment_text');
    validationFailed(await rejects(save({ gross_text: 'g'.repeat(20001) })), '/gross_text');
    validationFailed(await rejects(save({ microscopy_text: 'm'.repeat(20001) })), '/microscopy_text');
    expect(S.writes).toBe(0);
    const ok = await save({ gross_text: 'g'.repeat(20000), microscopy_text: 'm'.repeat(20000) });
    expect(ok.body.gross_text).toHaveLength(20000);
  });
  it('all errors of one request are reported together (two bad fields → both paths)', async () => {
    const e = await rejects(save({ impression_text: 'x'.repeat(8001), comment_text: 'y'.repeat(8001), flag: 'Q' }));
    validationFailed(e, '/impression_text'); validationFailed(e, '/comment_text'); validationFailed(e, '/flag');
  });
  it('wrong types → 400 at the field: number for a text, string for is_critical, object for flag, text with a NUL byte', async () => {
    validationFailed(await rejects(save({ impression_text: 5 as unknown as string })), '/impression_text');
    validationFailed(await rejects(save({ is_critical: 'yes' as unknown as boolean })), '/is_critical');
    validationFailed(await rejects(save({ flag: { a: 1 } as unknown as string })), '/flag');
    validationFailed(await rejects(save({ comment_text: 'a\u0000b' })), '/comment_text');
    expect(S.writes).toBe(0);
  });
  it('flag N and A are stored (response flag), any other value → 400 at /flag; is_critical true is stored', async () => {
    const a = await save({ flag: 'A', is_critical: true });
    expect(a.body).toMatchObject({ flag: 'A', is_critical: true });
    expect((await save({ flag: 'N' }, CASE.HISTO, 1)).body.flag).toBe('N');
    for (const bad of ['X', 'a', '', 'AA']) validationFailed(await rejects(save({ flag: bad }, CASE.HISTO, 2)), '/flag');
  });
  it('narrative text is normalised as plain text (02-TRD §4.6): CRLF → LF, control characters removed, trailing whitespace trimmed; HTML is kept as inert text, not interpreted', async () => {
    const r = await save({ gross_text: 'Line1\r\nLine2   \u0007\n\n', impression_text: '<b>bold</b>  ' });
    expect(r.body.gross_text).toBe('Line1\nLine2');
    expect(r.body.impression_text).toBe('<b>bold</b>');
    expect(drafts(CASE.HISTO)[0]!['gross_text']).toBe('Line1\nLine2');
  });
  it('AB-5: unknown fields in the body → 400 common.validation_failed (tenant_id, centre_id, case_id, kind, status, version, created_by, change_reason_code, id) and nothing is stored', async () => {
    for (const k of ['tenant_id', 'centre_id', 'case_id', 'kind', 'status', 'version', 'created_by', 'change_reason_code', 'id', 'consumed_at']) {
      validationFailed(await rejects(save({ ...FULL, [k]: k === 'tenant_id' ? T_OTHER : 'x' })));
    }
    validationFailed(await rejects(save([] as unknown as Row)));
    validationFailed(await rejects(save('text' as unknown as Row)));
    expect(S.writes).toBe(0); expect(drafts(CASE.HISTO)).toEqual([]);
  });
});

describe('R2 — images (AC-07.5)', () => {
  it('AC-07.5: 13 images while max_report_images = 12 (default, no settings row) → 422 anatomic.image_limit_reached, nothing stored', async () => {
    const e = await rejects(save({ ...FULL, image_ids: ids(1, 13) }));
    expect(isLimsError(e, 'anatomic.image_limit_reached'), `code ${e?.code}`).toBe(true);
    expect((e as LimsError).statusCode).toBe(422);
    expect(S.writes).toBe(0); expect(drafts(CASE.HISTO)).toEqual([]);
  });
  it('AC-07.5: exactly 12 images are accepted and the print order is kept (reversed input stays reversed)', async () => {
    const order = ids(1, 12).reverse();
    const r = await save({ ...FULL, image_ids: order });
    expect(r.body.image_ids).toEqual(order);
    expect(drafts(CASE.HISTO)[0]!['image_ids']).toEqual(order);
  });
  it('the limit is the tenant setting: max_report_images = 2 → 3 images 422, 2 images OK; max_report_images = 0 → one image is 422, none is OK; = 24 → 24 images OK', async () => {
    S.settings.set(T, { tenant_id: T, max_report_images: 2, max_images_per_case: 50, version: 2 });
    expect(isLimsError(await rejects(save({ image_ids: ids(1, 3) })), 'anatomic.image_limit_reached')).toBe(true);
    expect((await save({ image_ids: ids(1, 2) })).body.image_ids).toHaveLength(2);
    S.settings.set(T, { tenant_id: T, max_report_images: 0, max_images_per_case: 50, version: 3 });
    expect(isLimsError(await rejects(save({ image_ids: ids(1, 1) }, CASE.HISTO, 1)), 'anatomic.image_limit_reached')).toBe(true);
    expect((await save({}, CASE.HISTO, 1)).body.image_ids).toEqual([]);
    S.settings.set(T, { tenant_id: T, max_report_images: 24, max_images_per_case: 50, version: 4 });
    expect((await save({ image_ids: ids(1, 24) }, CASE.HISTO, 2)).body.image_ids).toHaveLength(24);
  });
  it('more than 24 ids is a structural error → 400 at /image_ids (the hard cap of the schema), even when the tenant limit is higher', async () => {
    S.settings.set(T, { tenant_id: T, max_report_images: 24, max_images_per_case: 50, version: 2 });
    validationFailed(await rejects(save({ image_ids: ids(1, 25) })), '/image_ids');
    expect(S.writes).toBe(0);
  });
  it('image ids must be uuids of THIS case: malformed → 400 at /image_ids/0; another case\'s image, another tenant\'s image and an unknown id are refused (400 or 404), nothing stored, nothing linked', async () => {
    validationFailed(await rejects(save({ image_ids: ['not-a-uuid'] })), '/image_ids/0');
    for (const bad of [IMG_OTHER_CASE, IMG_OTHER_TENANT, IMG_UNKNOWN]) refused(await rejects(save({ image_ids: [IMG(1), bad] })));
    expect(S.writes).toBe(0); expect(drafts(CASE.HISTO)).toEqual([]);
  });
  it('image_ids that is not an array → 400 at /image_ids', async () => {
    validationFailed(await rejects(save({ image_ids: IMG(1) as unknown as string[] })), '/image_ids');
  });
});

describe('R2 — diagnosis codes (AC-07.6)', () => {
  it('AC-07.6: a code that is not in the tenant diagnoses list → 400 common.validation_failed at /diagnosis_codes/0/code, nothing stored', async () => {
    validationFailed(await rejects(save({ diagnosis_codes: [{ code: 'LOC-4040' }] })), '/diagnosis_codes/0/code');
    expect(S.writes).toBe(0); expect(drafts(CASE.HISTO)).toEqual([]);
  });
  it('AC-07.6: an inactive code (LOC-0009) → 400 at /diagnosis_codes/0/code', async () => {
    validationFailed(await rejects(save({ diagnosis_codes: [{ code: 'LOC-0009' }] })), '/diagnosis_codes/0/code');
  });
  it('another tenant\'s code is "not in the list" → 400 at the path (no leak that it exists elsewhere)', async () => {
    const e = await rejects(save({ diagnosis_codes: [{ code: 'LOC-B001' }] }));
    validationFailed(e, '/diagnosis_codes/0/code');
    expect(JSON.stringify((e as LimsError).errors)).not.toContain('Synthetic diagnosis LOC-B001');
  });
  it('active codes are stored as codes and answered as { code, display, system, system_version? } in input order; the bad row is reported at ITS index', async () => {
    const r = await save({ diagnosis_codes: [{ code: 'LOC-0002' }, { code: 'LOC-0001' }] });
    expect(r.body.diagnosis_codes).toEqual([{ code: 'LOC-0002', display: 'Synthetic diagnosis LOC-0002', system: 'local', system_version: '1' }, { code: 'LOC-0001', display: 'Synthetic diagnosis LOC-0001', system: 'local' }]);
    expect(drafts(CASE.HISTO)[0]!['diagnosis_codes']).toEqual(['LOC-0002', 'LOC-0001']);
    validationFailed(await rejects(save({ diagnosis_codes: [{ code: 'LOC-0001' }, { code: 'LOC-0009' }] }, CASE.HISTO, 1)), '/diagnosis_codes/1/code');
    expect(hasNoNulls(r.body)).toBe(true);
  });
  it('a code found after the first page of the list works (the validation is not limited to a short first page)', async () => {
    const r = await save({ diagnosis_codes: [{ code: 'LOC-0030' }] });
    expect(r.body.diagnosis_codes[0]).toMatchObject({ code: 'LOC-0030' });
  });
  it('shape: more than 20 codes → 400 at /diagnosis_codes; a row without code, with a non-string code or with an extra key → 400 at the row', async () => {
    validationFailed(await rejects(save({ diagnosis_codes: Array.from({ length: 21 }, (_, k) => ({ code: `LOC-${String(10 + (k % 20)).padStart(4, '0')}` })) })), '/diagnosis_codes');
    validationFailed(await rejects(save({ diagnosis_codes: [{}] as any })), '/diagnosis_codes/0/code');
    validationFailed(await rejects(save({ diagnosis_codes: [{ code: 5 }] as any })), '/diagnosis_codes/0/code');
    validationFailed(await rejects(save({ diagnosis_codes: [{ code: 'LOC-0001', display: 'forged' }] as any })));
    validationFailed(await rejects(save({ diagnosis_codes: 'LOC-0001' as any })), '/diagnosis_codes');
    expect(S.writes).toBe(0);
  });
  it('20 codes are accepted (the upper bound)', async () => {
    const codes = Array.from({ length: 20 }, (_, k) => ({ code: `LOC-${String(11 + k).padStart(4, '0')}` }));
    expect((await save({ diagnosis_codes: codes })).body.diagnosis_codes).toHaveLength(20);
  });
});

describe('R2 — synoptic instances (AC-08.5 draft side, AC-08.6, 02-TRD §4.5.2)', () => {
  const inst = (over: Row = {}) => ({ template_id: TPL.PUB, values: GOOD_VALUES, ...over });
  it('a valid instance is stored and answered as { template_id, template_key, template_version, title, values }; key, version and title come from the template row', async () => {
    const r = await save({ synoptic: [inst()] });
    expect(r.body.synoptic).toEqual([{ template_id: TPL.PUB, template_key: 'synth_a', template_version: 2, title: 'Synthetic checklist', values: GOOD_VALUES }]);
    expect(drafts(CASE.HISTO)[0]!['synoptic'][0]).toMatchObject({ template_id: TPL.PUB, template_key: 'synth_a', template_version: 2, values: GOOD_VALUES });
  });
  it('AC-08.5: a required field left empty / absent still SAVES (completeness is checked at sign-out only)', async () => {
    const r = await save({ synoptic: [inst({ values: { necrosis: true } })] });
    expect(r.status).toBe(200);
    expect(r.body.synoptic[0].values).toEqual({ necrosis: true });
    expect((await save({ synoptic: [inst({ values: {} })] }, CASE.HISTO, 1)).status).toBe(200);
  });
  it('the client cannot choose key or version: template_key / template_version / title in the instance → 400 (closed object)', async () => {
    validationFailed(await rejects(save({ synoptic: [inst({ template_key: 'other' })] })));
    validationFailed(await rejects(save({ synoptic: [inst({ template_version: 1 })] })));
    validationFailed(await rejects(save({ synoptic: [{ values: GOOD_VALUES }] as any })), '/synoptic/0/template_id');
    expect(S.writes).toBe(0);
  });
  it('values are validated against the template definition: bad option, wrong type, over max_length, unknown key, hidden field present → 400 at /synoptic/0/values/<key>', async () => {
    validationFailed(await rejects(save({ synoptic: [inst({ values: { grade: 'g9' } })] })), '/synoptic/0/values/grade');
    validationFailed(await rejects(save({ synoptic: [inst({ values: { necrosis: 'yes' } })] })), '/synoptic/0/values/necrosis');
    validationFailed(await rejects(save({ synoptic: [inst({ values: { site: 'x'.repeat(21) } })] })), '/synoptic/0/values/site');
    validationFailed(await rejects(save({ synoptic: [inst({ values: { zzz: 'x' } })] })), '/synoptic/0/values/zzz');
    validationFailed(await rejects(save({ synoptic: [inst({ values: { necrosis: false, necrosis_note: 'hidden' } })] })), '/synoptic/0/values/necrosis_note');
    validationFailed(await rejects(save({ synoptic: [inst({ values: { tags: ['a', 'a'] } })] })), '/synoptic/0/values/tags');
    expect(S.writes).toBe(0);
  });
  it('the second instance is reported at ITS index', async () => {
    validationFailed(await rejects(save({ synoptic: [inst(), inst({ values: { grade: 'nope' } })] })), '/synoptic/1/values/grade');
  });
  it('AC-08.6: a RETIRED template cannot be added → 409 anatomic.template_not_published; a DRAFT template likewise; nothing stored', async () => {
    conflict(await rejects(save({ synoptic: [inst({ template_id: TPL.RET })] })), 'anatomic.template_not_published');
    conflict(await rejects(save({ synoptic: [inst({ template_id: TPL.DRAFT })] })), 'anatomic.template_not_published');
    expect(S.writes).toBe(0); expect(drafts(CASE.HISTO)).toEqual([]);
  });
  it('AC-08.4 (draft side): an instance already in the draft keeps its template version after that template was retired — re-saving it unchanged succeeds and keeps version 1', async () => {
    S.drafts.set(uid(910), draftRow(uid(910), CASE.READY, { version: 2, synoptic: [{ template_id: TPL.V1_RETIRED, template_key: 'synth_a', template_version: 1, values: GOOD_VALUES }] }));
    const r = await save({ synoptic: [{ template_id: TPL.V1_RETIRED, values: GOOD_VALUES }] }, CASE.READY, 2);
    expect(r.status).toBe(200);
    expect(r.body.synoptic[0]).toMatchObject({ template_id: TPL.V1_RETIRED, template_key: 'synth_a', template_version: 1 });
    // …but adding a NEW instance from the retired template to a draft that does not have it stays refused
    conflict(await rejects(save({ synoptic: [{ template_id: TPL.V1_RETIRED, values: GOOD_VALUES }] }, CASE.EXIST, 3)), 'anatomic.template_not_published');
  });
  it('unknown template, another tenant\'s template and a malformed id are refused (400 or 404) and never stored', async () => {
    for (const id of [uid(7777), TPL.OTHER, 'not-a-uuid']) refused(await rejects(save({ synoptic: [inst({ template_id: id })] })));
    expect(S.writes).toBe(0);
  });
  it('more than 5 instances → 400 at /synoptic; exactly 5 are accepted', async () => {
    validationFailed(await rejects(save({ synoptic: Array.from({ length: 6 }, () => inst()) })), '/synoptic');
    expect((await save({ synoptic: Array.from({ length: 5 }, () => inst()) })).body.synoptic).toHaveLength(5);
  });
});

describe('R2 — ancillary results', () => {
  it('a result for a stain order of this case is stored and answered; empty text and text over 2,000 → 400 at /ancillary/0/result_text; more than 50 rows → 400', async () => {
    const r = await save({ ancillary: [{ stain_order_id: SO.OK, result_text: 'ER positive, 90 %.' }] });
    expect(r.body.ancillary).toEqual([{ stain_order_id: SO.OK, result_text: 'ER positive, 90 %.' }]);
    validationFailed(await rejects(save({ ancillary: [{ stain_order_id: SO.OK, result_text: '' }] }, CASE.HISTO, 1)), '/ancillary/0/result_text');
    validationFailed(await rejects(save({ ancillary: [{ stain_order_id: SO.OK, result_text: 'r'.repeat(2001) }] }, CASE.HISTO, 1)), '/ancillary/0/result_text');
    expect((await save({ ancillary: [{ stain_order_id: SO.OK, result_text: 'r'.repeat(2000) }] }, CASE.HISTO, 1)).status).toBe(200);
    validationFailed(await rejects(save({ ancillary: Array.from({ length: 51 }, () => ({ stain_order_id: SO.OK, result_text: 'x' })) }, CASE.HISTO, 2)), '/ancillary');
  });
  it('a stain order of another case, of another tenant, an unknown or malformed id is refused (400 or 404) and nothing is stored', async () => {
    for (const bad of [SO.OTHER_CASE, SO.OTHER_TENANT, uid(8888), 'nope']) refused(await rejects(save({ ancillary: [{ stain_order_id: bad, result_text: 'x' }] })));
    expect(S.writes).toBe(0);
  });
});

describe('R2 — case state, sign-out lock (08 A17 D-66 (b)), permissions, tenancy, logs', () => {
  it('received and cancelled cases cannot be drafted → 409 anatomic.case_invalid_transition, nothing written', async () => {
    conflict(await rejects(save({ ...FULL }, CASE.RECEIVED)), 'anatomic.case_invalid_transition');
    conflict(await rejects(save({ ...FULL }, CASE.CANCELLED)), 'anatomic.case_invalid_transition');
    expect(S.writes).toBe(0);
  });
  it('signed_out WITHOUT an open change draft → 409 anatomic.signout_locked, also for If-Match "0" and for a discarded draft; nothing written', async () => {
    conflict(await rejects(save({ ...FULL }, CASE.SIGNED, 0)), 'anatomic.signout_locked');
    conflict(await rejects(save({ ...FULL }, CASE.SIGNED, 1)), 'anatomic.signout_locked');
    S.cases.set(CASE.DISCARDED, caseRow(CASE.DISCARDED, { status: 'signed_out' }));
    conflict(await rejects(save({ ...FULL }, CASE.DISCARDED, 1)), 'anatomic.signout_locked');
    expect(S.writes).toBe(0);
  });
  it('signed_out WITH an open revision draft → the save updates that draft (If-Match = its version); kind and change reason stay; "0" is a version conflict, not a second draft', async () => {
    const r = await save({ impression_text: 'Revised again.' }, CASE.SIGNED_REV, 1);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'revision', change_reason_code: 'correction', change_reason_text: 'Typo in diagnosis', impression_text: 'Revised again.', version: 2 });
    expect(drafts(CASE.SIGNED_REV)).toHaveLength(1);
    expect(drafts(CASE.SIGNED_REV)[0]).toMatchObject({ kind: 'revision', change_reason_code: 'correction', status: 'open' });
    conflict(await rejects(save({ impression_text: 'x' }, CASE.SIGNED_REV, 0)), 'common.version_conflict');
    expect((await save({ impression_text: 'amended' }, CASE.SIGNED_AMD, 2)).body).toMatchObject({ kind: 'amendment', change_reason_code: 'wrong_patient', version: 3 });
  });
  it('permission anatomic.case.work is asserted with the case centre BEFORE any write: a denial passes through (403) and nothing is stored; a centre-scoped denial hides the case (404)', async () => {
    await save({ ...FULL });
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.work', centreId: C_A1 });
    const before = stored();
    const e = await rejects(save({ ...FULL, impression_text: 'denied' }, CASE.HISTO, 1, mkCtx({ deny: NO_WORK })));
    expect(isLimsError(e, 'auth.forbidden')).toBe(true);
    expect(isLimsError(await rejects(save({ ...FULL }, CASE.A2, 0, mkCtx({ denyCentre: C_A2 }))), 'common.not_found')).toBe(true);
    expect(stored()).toBe(before);
    expect(calls.assertRole.some((c) => c['centreId'] === C_A2)).toBe(true);
  });
  it('a user holding only case.read cannot save (case.work denied) and the draft is untouched', async () => {
    const before = stored();
    expect(isLimsError(await rejects(save({ ...FULL }, CASE.HISTO, 0, mkCtx({ deny: NO_WORK }))), 'auth.forbidden')).toBe(true);
    expect(stored()).toBe(before);
  });
  it('tenant isolation: another tenant\'s case id, an unknown id and a malformed id → 404 common.not_found, assertRole never reached, no side effect', async () => {
    for (const id of [CASE.OTHER, uid(9998), 'not-a-uuid', '../etc']) {
      const e = await rejects(save({ ...FULL }, id));
      expect(isLimsError(e, 'common.not_found'), id).toBe(true);
    }
    expect(calls.assertRole).toEqual([]);
    expect(S.writes).toBe(0);
    expect([...S.drafts.values()].some((d) => d['tenant_id'] === T_OTHER)).toBe(false);
  });
  it('REQ-SEC-098: narrative text, diagnosis codes and captions never reach the logs (successful and failing saves)', async () => {
    await save({ ...FULL, gross_text: MARKER, comment_text: MARKER, diagnosis_codes: [{ code: 'LOC-0001' }] });
    await rejects(save({ impression_text: `${MARKER}${'x'.repeat(8001)}`, diagnosis_codes: [{ code: 'LOC-0001' }] }, CASE.HISTO, 1));
    await rejects(save({ diagnosis_codes: [{ code: 'LOC-4040' }] }, CASE.HISTO, 1));
    const logs = calls.logs.join('\n');
    expect(logs).not.toContain(MARKER); expect(logs).not.toContain('LOC-0001'); expect(logs).not.toContain('LOC-4040');
  });
  it('error problems do not echo submitted text or codes', async () => {
    const e = await rejects(save({ impression_text: `${MARKER}${'x'.repeat(8001)}`, diagnosis_codes: [{ code: 'LOC-4040' }] }));
    validationFailed(e, '/impression_text'); validationFailed(e, '/diagnosis_codes/0/code'); // a real validation problem first (a stub error would pass the "no echo" check vacuously)
    const wire = JSON.stringify({ m: (e as Error).message, errors: (e as LimsError).errors });
    expect(wire).not.toContain(MARKER); expect(wire).not.toContain('LOC-4040');
  });
});

describe('R1 getAnatomicReportDraft', () => {
  it('returns the open draft in the ReportDraft shape: closed key set, no nulls, no tenant/centre/actor ids; asserts anatomic.case.read with the case centre', async () => {
    const r = await get(CASE.EXIST);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ case_id: CASE.EXIST, kind: 'initial', impression_text: 'Existing impression', version: 3, is_critical: false, gross_text: '', synoptic: [], image_ids: [], ancillary: [], diagnosis_codes: [],
      updated_by_display_name: 'Dr Synthetic One' });
    const keys = Object.keys(r.body);
    for (const k of DTO_REQUIRED) expect(keys, k).toContain(k);
    expect(keys.filter((k) => !DTO_ALLOWED.includes(k))).toEqual([]);
    expect(keysDeep(r.body).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
    expect(hasNoNulls(r.body)).toBe(true);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.case.read', centreId: C_A1 });
  });
  it('no draft yet → 404 common.not_found; only a discarded draft → 404 as well ("404 if none open")', async () => {
    expect(isLimsError(await rejects(get(CASE.HISTO)), 'common.not_found')).toBe(true);
    expect(isLimsError(await rejects(get(CASE.DISCARDED)), 'common.not_found')).toBe(true);
  });
  it('R1 equals what R2 just answered (same body, same version) — including synoptic, images and diagnosis codes', async () => {
    const put = await save({ ...FULL, flag: 'A', is_critical: true, image_ids: ids(1, 3), diagnosis_codes: [{ code: 'LOC-0001' }], ancillary: [{ stain_order_id: SO.OK, result_text: 'Positive' }], synoptic: [{ template_id: TPL.PUB, values: GOOD_VALUES }] });
    const read = await get(CASE.HISTO);
    expect(read.body).toEqual(put.body);
    expect(read.body).toMatchObject({ flag: 'A', is_critical: true, version: 1 });
  });
  it('a revision draft on a signed_out case is returned with its kind and change reason (read works in every case state)', async () => {
    const r = await get(CASE.SIGNED_REV);
    expect(r.body).toMatchObject({ kind: 'revision', change_reason_code: 'correction', change_reason_text: 'Typo in diagnosis', impression_text: 'Revised impression', version: 1 });
  });
  it('permission: a denial of anatomic.case.read → 403 and no body; reading does not write', async () => {
    expect(isLimsError(await rejects(get(CASE.EXIST, mkCtx({ deny: NO_READ }))), 'auth.forbidden')).toBe(true);
    await get(CASE.EXIST);
    expect(S.writes).toBe(0);
  });
  it('tenant isolation: another tenant\'s case, an unknown id and a malformed id → 404, assertRole never reached', async () => {
    S.drafts.set(uid(990), draftRow(uid(990), CASE.OTHER, { tenant_id: T_OTHER, centre_id: C_B1 }));
    for (const id of [CASE.OTHER, uid(9998), 'not-a-uuid']) expect(isLimsError(await rejects(get(id)), 'common.not_found'), id).toBe(true);
    expect(calls.assertRole).toEqual([]);
  });
  it('another tenant\'s draft for the same case id is never read (the repo call is tenant-bound)', async () => {
    S.drafts.set(uid(991), draftRow(uid(991), CASE.HISTO, { tenant_id: T_OTHER, centre_id: C_B1, impression_text: 'TENANT B SECRET' }));
    expect(isLimsError(await rejects(get(CASE.HISTO)), 'common.not_found')).toBe(true);
  });
});

describe('AC-07.3 composeGrossFromParts (pure rule behind the "Insert gross from parts" button)', () => {
  const load = async () => {
    const path = '../service/report.service.js';
    return (await import(/* @vite-ignore */ path)) as { composeGrossFromParts: (i: { parts: Row[]; gross: Row[] }) => string };
  };
  const P1 = uid(201), P2 = uid(202), P3 = uid(203);
  it('AC-07.3: two parts with completed gross → "A. <part A site>: <gross text>" then "B. …", in letter order whatever the input order', async () => {
    const { composeGrossFromParts } = await load();
    const out = composeGrossFromParts({
      parts: [{ id: P2, letter: 'B', site_text: 'Sigmoid colon' }, { id: P1, letter: 'A', site_text: 'Stomach antrum' }],
      gross: [{ part_id: P2, gross_text: 'Polyp 5 mm, sessile.', is_complete: true }, { part_id: P1, gross_text: 'Two fragments, 2 mm each.', is_complete: true }],
    });
    expect(out.split(/\n+/)).toEqual(['A. Stomach antrum: Two fragments, 2 mm each.', 'B. Sigmoid colon: Polyp 5 mm, sessile.']);
    expect(out.indexOf('A. ')).toBeLessThan(out.indexOf('B. '));
  });
  it('a part whose gross is not complete is left out; a single part gives a single line without trailing separators', async () => {
    const { composeGrossFromParts } = await load();
    const out = composeGrossFromParts({
      parts: [{ id: P1, letter: 'A', site_text: 'Stomach antrum' }, { id: P2, letter: 'B', site_text: 'Sigmoid colon' }, { id: P3, letter: 'C', site_text: 'Liver' }],
      gross: [{ part_id: P1, gross_text: 'Two fragments.', is_complete: true }, { part_id: P2, gross_text: 'Draft text', is_complete: false }],
    });
    expect(out).toBe('A. Stomach antrum: Two fragments.');
    expect(composeGrossFromParts({ parts: [], gross: [] })).toBe('');
  });
  it('the composed text fits the draft limit: it is plain text that R2 accepts as gross_text', async () => {
    const { composeGrossFromParts } = await load();
    const out = composeGrossFromParts({ parts: [{ id: P1, letter: 'A', site_text: 'Stomach antrum' }], gross: [{ part_id: P1, gross_text: 'Two fragments.', is_complete: true }] });
    expect((await save({ gross_text: out })).body.gross_text).toBe('A. Stomach antrum: Two fragments.');
  });
});
