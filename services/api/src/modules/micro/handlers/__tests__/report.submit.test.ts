// C10 T-15 — M14 submitCultureReport WITHOUT a database: snapshot + submission transaction (02-TRD §4.6, §4.7, §5 M14, §13; 03-APP-FLOW §2.1 C4–C6, §4.6; 05-SCHEMA §8 report_versions, §6 schemas;
// PRD AC-09.1–09.7, AC-10.1–10.7, AC-15.2, AC-16.1; 07-SECURITY T-A5, T-A6, S-05, S-06, S-07; 08 R1 + A17 D-61/D-62; 06-IMPLEMENTATION-PLAN row T-15).
// DB behaviour (real constraints, grants AC-09.5, final lock trigger AC-10.7, RLS, two submissions on one row lock, view v_pub_report_content) is in report.submit.integration.test.ts (live DB, gated with LIMS_T15_REQUIRE_DB=1).
// LabPort = the shared fake packages/fakes/src/LabPort.fake.ts (real submitModuleResult semantics incl. amendment guards, idempotent replay) with failNext for every passed-through code. The fake is not transactional,
//   so "nothing persisted" (AC-09.2) is asserted as: NO INSERT/UPDATE statement was issued before the port answered, and the world is unchanged afterwards.
// SEAMS: handler submitCultureReport in handlers/index.ts REAL map (service/report.service.ts, repository/reports.repo.ts, domain/snapshot.ts per plan; the SNAPSHOT builder has its own unit test).
//   Order: culture row loaded FIRST (SELECT ... FOR UPDATE on micro.cultures; RLS + tenant filter; not visible = 404) -> IdentityPort.assertRole(ctx, { permission: 'micro.culture.work', centreId: culture.centre_id })
//   -> strict body validation (400) -> state guard (409 micro.culture_invalid_transition) -> completeness (422 micro.report_incomplete / micro.ast_standard_required) -> LabPort.getOrderResults({ orderId, scope: 'all_visible' })
//   -> snapshot (+ size guard) -> LabPort.submitModuleResult -> INSERT micro.report_versions -> UPDATE micro.cultures (+ INSERT micro.culture_transitions when the status changes). No If-Match (TRD §5 intro: the culture is locked FOR UPDATE).
//   Every write binds the tenant; the fake ignores `<>`/IS NULL/`= true` predicates, so the service must filter snapshot rows in code or bind values (helpers/reportWrites.ts header).
// ASSUMED (spec silent; flagged so a ruling can overrule): 201 body = ReportVersionDto answered as { status: 201, body }; final without outcome_code = 422 micro.report_incomplete errors[] path /outcome_code; an unknown / inactive
//   outcome_code = 400 common.validation_failed path /outcome_code (M14 declares no *_unknown code; same convention as T-05/T-08/T-09); early-final reason missing = 422 micro.report_incomplete path /early_final_reason, applies to the
//   outcome code `no_growth` (global seed) before final_due_at; completeness errors[] paths start with /isolates, /ast (a row path contains the row's antibiotic_code or id); a final AST row with standard 'unknown' = 422 micro.ast_standard_required,
//   a row without raw_value or category = 422 micro.report_incomplete; a preliminary silently leaves incomplete AST rows out of the snapshot; the request's `outcome_code` on a preliminary is not asserted.
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { createFakeLabPort } from '../../../../../../../packages/fakes/src/LabPort.fake';
import { TENANT_A, TENANT_B } from '../../../../../../../packages/fakes/src/base';
import { LAB_AMEND, LAB_READ, mkCtx, READ, run, schemaErrors, specOps, WORK, type Row } from './helpers/cultureReads.js';
import { asJson, NOW, reportTx, writesOf, type World } from './helpers/reportWrites.js';

const A = TENANT_A, B = TENANT_B;
const u = (n: number) => `0190c608-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE_A1 = u(0xa1), CENTRE_B1 = u(0xb1);
const ACTOR_USER = '01a1b34e-1000-7eee-9d29-d7ca59a10001', ACTOR_M = '01a1a98a-ac40-7000-8000-00000000a500';
const ORDER = u(0x801), TEST1 = u(0x701);
const NOW_ISO = NOW.toISOString();
const PLANTED = '2026-11-04T05:00:00.000Z';
const ECOLI = 'syn_ecoli', STAPH = 'syn_staph';
const N = { prelim: 1, empty: 2, obsOnly: 3, awaiting: 4, final: 5, amend: 6, cancelled: 7, b: 8, apprPrelim: 9, resulted: 10, noGrowth: 11, noIso: 12, badAst: 13, big21: 14, big601: 15 } as const;
const C = Object.fromEntries(Object.entries(N).map(([k, n]) => [k, u(0x1000 + n)])) as Record<keyof typeof N, string>;
const ITEM = (c: string) => u(0x2000 + (parseInt(c.slice(-4), 16) - 0x1000));
const RESULT = (c: string) => u(0x3000 + (parseInt(c.slice(-4), 16) - 0x1000));
const SPEC = (c: string) => u(0x900 + (parseInt(c.slice(-4), 16) - 0x1000));
const PL = (c: string) => u(0x4000 + (parseInt(c.slice(-4), 16) - 0x1000));

// ------------------------------------------------------------------ world
const culture = (id: string, status: string, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE_A1, order_id: ORDER, order_item_id: ITEM(id), specimen_id: SPEC(id), patient_id: u(0xa00), test_id: TEST1, specimen_type_code: 'urine', specimen_site_code: null, barcode_snapshot: null,
  plating_protocol_id: null, status, outcome_code: null, received_at: new Date('2026-11-04T04:00:00.000Z'), planted_at: new Date(PLANTED), next_read_due_at: null, final_due_at: new Date('2026-11-06T05:00:00.000Z'),
  last_specimen_seq: 1, current_report_version_no: 0, last_report_phase: null, chain_cancelled: false, amendment_reason_code: null, amendment_reason_text: null, cancel_reason_code: null, cancel_comment: null, cancelled_at: null,
  version: 5, is_active: true, created_at: new Date('2026-11-04T04:00:00.000Z'), created_by: ACTOR_USER, updated_at: new Date('2026-11-04T04:00:00.000Z'), updated_by: ACTOR_USER, ...over,
});
const plate = (c: string): Row => ({ id: PL(c), tenant_id: A, centre_id: CENTRE_A1, culture_id: c, plate_no: 1, media_code: 'syn_blood', status: 'active', version: 1, is_active: true, planted_at: new Date(PLANTED) });
const isolate = (c: string, seq: number, over: Row = {}): Row => ({ id: u(0x5000 + parseInt(c.slice(-4), 16) * 0x40 + seq), tenant_id: A, centre_id: CENTRE_A1, culture_id: c, specimen_id: SPEC(c), isolate_seq: seq, plate_id: PL(c),
  status: 'identified', organism_code: ECOLI, organism_source: 'manual', identified_at: new Date('2026-11-04T09:00:00.000Z'), identified_by_membership_id: ACTOR_M, colony_description: 'Synthetic colony', quantity_text: null,
  is_reportable: true, withdraw_reason_code: null, withdraw_comment: null, ast_panel_id: null, ast_method: null, version: 3, is_active: true, ...over });
let astSeq = 0x70000;
const ast = (iso: Row, abx: string, over: Row = {}): Row => ({ id: u(++astSeq), tenant_id: A, centre_id: CENTRE_A1, culture_id: iso['culture_id'], isolate_id: iso['id'],
  antibiotic_code: abx, method: 'mic', raw_value: '2', category_code: 'S', standard: 'CLSI', standard_version: 'M100-2026', source: 'manual', off_panel: false, is_reportable: true, report_visibility: 'shown', panel_sort_order: 1,
  suggestion_overridden: false, version: 1, is_active: true, ...over });
const read = (c: string, n: number, code: string, hours: number): Row => ({ id: u(0x6000 + parseInt(c.slice(-4), 16) * 0x10 + n), tenant_id: A, centre_id: CENTRE_A1, culture_id: c, plate_id: PL(c), kind: 'plate_read', growth_code: code,
  quantity_text: null, finding_text: null, observed_at: new Date(`2026-11-04T${String(5 + hours).padStart(2, '0')}:00:00.000Z`), hours_since_planting: hours, recorded_by_membership_id: ACTOR_M, corrects_observation_id: null });
const stain = (c: string): Row => ({ id: u(0x6f00 + parseInt(c.slice(-4), 16)), tenant_id: A, centre_id: CENTRE_A1, culture_id: c, plate_id: null, kind: 'gram_stain', growth_code: null, quantity_text: null,
  finding_text: 'Synthetic gram-negative rods', observed_at: new Date('2026-11-04T06:00:00.000Z'), hours_since_planting: 1, recorded_by_membership_id: ACTOR_M, corrects_observation_id: null });
const version = (c: string, no: number, phase: 'preliminary' | 'final', over: Row = {}): Row => ({ id: u(0x8000 + parseInt(c.slice(-4), 16) * 0x10 + no), tenant_id: A, centre_id: CENTRE_A1, culture_id: c, order_item_id: ITEM(c), version_no: no,
  report_phase: phase, version_kind: no === 1 ? 'initial' : 'update', submission_kind: 'organism', outcome_code: phase === 'final' ? 'growth_reported' : null, early_final_reason: null, amendment_reason_code: null, amendment_reason_text: null,
  culture_summary_text: 'Synthetic earlier summary', isolates: [{ seq: 1, organism_code: ECOLI, organism_display: 'Synthetic E. coli', growth_text: '' }], ast: [], comments_text: null, is_critical: false, flag: 'A',
  signed_by_membership_id: ACTOR_M, signed_at: new Date('2026-11-04T10:00:00.000Z'), lab_result_id: RESULT(c), lab_result_version_no: 1, lab_status_at_submit: 'resulted', lab_replayed: false, created_by: ACTOR_USER, ...over });

function mkWorld(): World {
  const cultures = [
    culture(C.prelim, 'incubating'), culture(C.empty, 'incubating'), culture(C.obsOnly, 'incubating'), culture(C.awaiting, 'awaiting_setup', { planted_at: null, final_due_at: null }),
    culture(C.final, 'final_submitted', { outcome_code: 'growth_reported', current_report_version_no: 1, last_report_phase: 'final' }),
    culture(C.amend, 'amending', { outcome_code: 'growth_reported', current_report_version_no: 1, last_report_phase: 'final', amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix' }),
    culture(C.cancelled, 'cancelled', { cancel_reason_code: 'syn_reason', cancelled_at: new Date(PLANTED) }), culture(C.b, 'incubating', { tenant_id: B, centre_id: CENTRE_B1 }),
    culture(C.apprPrelim, 'incubating', { current_report_version_no: 1, last_report_phase: 'preliminary' }), culture(C.resulted, 'incubating', { current_report_version_no: 1, last_report_phase: 'preliminary' }),
    culture(C.noGrowth, 'incubating', { planted_at: new Date('2026-11-04T05:00:00.000Z'), final_due_at: new Date('2026-11-06T05:00:00.000Z') }), culture(C.noIso, 'incubating'), culture(C.badAst, 'incubating'),
    culture(C.big21, 'incubating'), culture(C.big601, 'incubating'),
  ];
  const withIso = [C.prelim, C.apprPrelim, C.resulted, C.final, C.amend, C.badAst];
  const isolates: Row[] = [];
  for (const c of withIso) isolates.push(isolate(c, 1));
  isolates.push(isolate(C.prelim, 2, { status: 'pending_id', organism_code: null, organism_source: null, identified_at: null }), isolate(C.prelim, 3, { status: 'withdrawn', withdraw_reason_code: 'duplicate' }), isolate(C.prelim, 4, { is_reportable: false, organism_code: STAPH }));
  for (let s = 1; s <= 21; s++) isolates.push(isolate(C.big21, s));
  for (let s = 1; s <= 20; s++) isolates.push(isolate(C.big601, s));
  const i1 = (c: string) => isolates.find((i) => i['culture_id'] === c && i['isolate_seq'] === 1)!;
  const asts: Row[] = [];
  for (const c of [C.prelim, C.apprPrelim, C.resulted, C.final, C.amend]) asts.push(ast(i1(c), 'syn_amp', { panel_sort_order: 1 }), ast(i1(c), 'syn_cip', { panel_sort_order: 2, category_code: 'R' }));
  asts.push(ast(i1(C.prelim), 'syn_gen', { report_visibility: 'suppressed_by_rule' }), ast(i1(C.prelim), 'syn_tet', { is_reportable: false }));
  asts.push(ast(i1(C.badAst), 'syn_amp'), ast(i1(C.badAst), 'syn_cip', { standard: 'unknown', standard_version: null }), ast(i1(C.badAst), 'syn_gen', { category_code: null, standard: null, standard_version: null }));
  for (let k = 0; k < 601; k++) asts.push(ast(isolates.find((i) => i['culture_id'] === C.big601 && i['isolate_seq'] === 1 + (k % 20))!, `syn_abx_${k}`, { k }));
  return {
    cultures, culture_plates: [C.prelim, C.obsOnly, C.noGrowth, C.noIso, C.apprPrelim, C.badAst, C.big21, C.big601].map(plate), isolates, ast_results: asts,
    culture_observations: [read(C.prelim, 1, 'syn_growth', 8), stain(C.prelim), read(C.obsOnly, 1, 'no_growth', 24), read(C.noGrowth, 1, 'no_growth', 24), read(C.noIso, 1, 'syn_growth', 8)],
    report_versions: [version(C.final, 1, 'final'), version(C.amend, 1, 'final'), version(C.apprPrelim, 1, 'preliminary'), version(C.resulted, 1, 'preliminary')],
    culture_transitions: [], specimen_isolate_counters: [], instrument_records: [],
    settings: [{ id: u(0x60), tenant_id: A, early_final_requires_reason: true, default_final_no_growth_hours: 48, version: 1, is_active: true }],
    v_organisms: [{ code: ECOLI, display: 'Synthetic E. coli', is_active: true, is_alert: false }, { code: STAPH, display: 'Synthetic S. aureus', is_active: true, is_alert: true }],
    v_antibiotics: ['syn_amp', 'syn_cip', 'syn_gen', 'syn_tet'].map((code) => ({ code, display: `Synthetic ${code.slice(4)}`, is_active: true })).concat(Array.from({ length: 601 }, (_, k) => ({ code: `syn_abx_${k}`, display: `Synthetic abx ${k}`, is_active: true }))),
    v_growth_codes: [{ code: 'syn_growth', display: 'Synthetic growth', is_active: true, indicates_growth: true }, { code: 'no_growth', display: 'No growth', is_active: true, indicates_growth: false }],
    v_culture_outcomes: [{ code: 'no_growth', display: 'No growth', is_active: true, result_flag: 'N', requires_isolate: false }, { code: 'growth_reported', display: 'Growth - see isolates', is_active: true, result_flag: 'A', requires_isolate: true },
      { code: 'normal_flora', display: 'Normal flora only', is_active: true, result_flag: 'N', requires_isolate: false }, { code: 'syn_retired', display: 'Retired', is_active: false, result_flag: 'N', requires_isolate: false }],
    v_isolate_withdraw_reasons: [], v_media: [], v_specimen_sites: [],
  };
}
const row = (w: World, table: string, id: string): Row => w[table]!.find((r) => r['id'] === id)!;
const versionsOf = (w: World, c: string) => w['report_versions']!.filter((r) => r['culture_id'] === c).sort((a, b) => a['version_no'] - b['version_no']);

// LabPort fake state per culture: pending (default) / resulted / approved (+ last submitted phase and the approved payload version)
interface LabState { status?: 'pending' | 'resulted' | 'approved'; lastPhase?: 'preliminary' | 'final'; moduleVersion?: number }
const LAB: Partial<Record<keyof typeof N, LabState>> = {
  apprPrelim: { status: 'approved', lastPhase: 'preliminary', moduleVersion: 1 }, resulted: { status: 'resulted', lastPhase: 'preliminary', moduleVersion: 1 },
  final: { status: 'approved', lastPhase: 'final', moduleVersion: 1 }, amend: { status: 'approved', lastPhase: 'final', moduleVersion: 1 },
};
function labFixtures(w: World, grants: readonly string[]) {
  return {
    grants: { [ACTOR_USER]: [...grants] },
    orders: [{ id: ORDER, tenantId: A, patientId: u(0xa00), centreId: CENTRE_A1, priority: 'routine', patient: { sex: 'female', ageDays: 12000 } }],
    items: w['cultures']!.filter((c) => c['tenant_id'] === A).map((c) => ({ id: c['order_item_id'], tenantId: A, orderId: ORDER, testId: TEST1, departmentId: u(0x90), workflowType: 'microbiology' })),
    results: w['cultures']!.filter((c) => c['tenant_id'] === A).map((c) => {
      const key = (Object.keys(C) as (keyof typeof N)[]).find((k) => C[k] === c['id'])!; const st = LAB[key] ?? {};
      return { id: RESULT(c['id']), tenantId: A, orderItemId: c['order_item_id'], testId: TEST1, analyteId: u(0x60), versionNo: 1, status: st.status ?? 'pending', origin: 'module', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false,
        ...(st.moduleVersion ? { moduleRef: { module: 'micro', entityId: c['id'], versionNo: st.moduleVersion }, lastPhase: st.lastPhase, lastPayloadVersion: st.moduleVersion } : {}) };
    }),
  };
}

function setup(w: World, o: { grants?: readonly string[]; amend?: boolean } = {}) {
  const { tx, log } = reportTx(w);
  const { ctx, calls } = mkCtx({ tenantId: A, tx, grants: o.grants ?? [WORK], actor: { type: 'user', id: ACTOR_USER, membershipId: ACTOR_M }, members: { [ACTOR_M]: 'Synthetic Actor Tech' }, users: { [ACTOR_USER]: 'Synthetic Actor User' },
    tests: { [TEST1]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } } });
  const lab: any = createFakeLabPort({ seed: 1, fixtures: labFixtures(w, [LAB_READ, ...(o.amend ? [LAB_AMEND] : [])]) as any });
  ctx.ports.LabPort = {
    getOrderResults: (c: unknown, i: unknown) => lab.getOrderResults(c, i),
    submitModuleResult: async (c: unknown, i: unknown) => { log.push({ sql: 'PORT submitModuleResult', params: [], op: 'OTHER', table: 'lab' }); return lab.submitModuleResult(c, i); },
  };
  const logs: unknown[] = []; const sink = (...a: unknown[]) => { logs.push(a); };
  ctx.log = { info: sink, warn: sink, error: sink, debug: sink, child() { return this; } };
  return { ctx, calls, log, lab, w, logs, tx };
}
const KEY = { 'idempotency-key': 'syn-key-1' };
const M14 = (cultureId: string, body: Row = { report_phase: 'preliminary', is_critical: false }, headers: Row = {}) => ({ params: { culture_id: cultureId }, headers: { ...KEY, ...headers }, body });
const PRELIM = { report_phase: 'preliminary', is_critical: false };
const FINAL = (over: Row = {}) => ({ report_phase: 'final', outcome_code: 'growth_reported', is_critical: false, ...over });
const submits = (s: { lab: any }) => s.lab.calls('submitModuleResult') as { input: Row }[];
const expectCode = (e: any, code: string, status?: number) => { expect(isLimsError(e, code) || e?.code === code, `${e?.code ?? e}`).toBe(true); if (status !== undefined && e.statusCode !== undefined) expect(e.statusCode).toBe(status); };
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };
const untouched = async (s: ReturnType<typeof setup>, before: World, p: Promise<unknown>) => {   // rejected, nothing written, port never asked to submit
  const e = await failure(p);
  expect(writesOf(s.log), JSON.stringify(writesOf(s.log).map((l) => l.sql.slice(0, 60)))).toEqual([]);
  expect(s.w).toEqual(before); expect(submits(s)).toHaveLength(0);
  return e;
};
const snapshotOf = (w: World): World => structuredClone(w);

// ------------------------------------------------------------------ contract pins
describe('C10-T15 contract pins (micro.yaml M14)', () => {
  const op = () => specOps()['submitCultureReport'];
  it('x-permission micro.culture.work only, idempotency required, NO If-Match (the culture row is locked FOR UPDATE), declared errors incl. every passed-through C5 code', () => {
    const o = op();
    expect(o['x-permission']).toBe(WORK); expect(o['x-idempotency']).toBe('required');
    expect(o.parameters.some((p: any) => String(p.$ref ?? '').endsWith('/IfMatch'))).toBe(false);
    for (const c of ['common.validation_failed', 'common.not_found', 'auth.forbidden', 'micro.report_incomplete', 'micro.ast_standard_required', 'micro.culture_invalid_transition', 'micro.amendment_reason_required',
      'lab.result_locked', 'lab.result_invalid_transition', 'lab.module_result_invalid', 'lab.module_result_stale', 'lab.amendment_reason_required', 'auth.mfa_required']) expect(o['x-error-codes'], c).toContain(c);
  });
  it('body: report_phase + is_critical required; report_phase, outcome_code, culture_summary_text 1..4000, comments_text 1..4000, early_final_reason 1..500 only; no amendment / isolates / ast / flag / version fields (S-05)', () => {
    const b = op().requestBody.content['application/json'].schema;
    expect(b.additionalProperties).toBe(false); expect([...b.required].sort()).toEqual(['is_critical', 'report_phase']);
    expect(Object.keys(b.properties).sort()).toEqual(['comments_text', 'culture_summary_text', 'early_final_reason', 'is_critical', 'outcome_code', 'report_phase']);
    expect(b.properties.report_phase.enum).toEqual(['preliminary', 'final']);
    expect([b.properties.culture_summary_text.minLength, b.properties.culture_summary_text.maxLength, b.properties.comments_text.maxLength, b.properties.early_final_reason.maxLength]).toEqual([1, 4000, 4000, 500]);
  });
  it('201 answers ReportVersionDto', () => { expect(op().responses['201'].content['application/json'].schema.$ref).toMatch(/ReportVersionDto$/); });
});

// ------------------------------------------------------------------ permission + object first
describe('C10-T15 permissions and object scope (T-A5, T-A6, S-01, S-02, S-06)', () => {
  it('without micro.culture.work (read-only / config-only) -> 403 auth.forbidden, asked with the culture\'s centre AFTER the culture was read; no write, no port submit', async () => {
    for (const grants of [[READ], ['micro.config.manage'], []]) {
      const w = mkWorld(); const before = snapshotOf(w); const s = setup(w, { grants });
      const e = await untouched(s, before, run('submitCultureReport', M14(C.prelim, PRELIM), s.ctx));
      expectCode(e, 'auth.forbidden', 403);
      expect(s.calls.assertRole[0]).toEqual({ permission: WORK, centreId: CENTRE_A1 });
      const firstRead = s.log.findIndex((l) => l.table === 'cultures'); expect(firstRead).toBeGreaterThanOrEqual(0);
    }
  });
  it('a culture of another tenant (and an unknown id) is 404 common.not_found, identical; nothing written; no port call', async () => {
    for (const id of [C.b, u(0x10ff)]) {
      const w = mkWorld(); const before = snapshotOf(w); const s = setup(w);
      const e = await untouched(s, before, run('submitCultureReport', M14(id, PRELIM), s.ctx));
      expectCode(e, 'common.not_found', 404); expect(s.lab.calls('getOrderResults')).toHaveLength(0);
    }
  });
  it('the order item sent to C5 is the culture row\'s, never a client value (T-A5); forged body fields are refused', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('submitCultureReport', M14(C.prelim, PRELIM), s.ctx);
    expect(submits(s)[0]!.input['orderItemId']).toBe(ITEM(C.prelim));
    for (const f of ['order_item_id', 'orderItemId', 'culture_id', 'version_no', 'version_kind', 'flag', 'isolates', 'ast', 'submission_kind', 'lab_status_at_submit', 'amendment_reason_code', 'amendment_reason_text', 'amendment', 'signed_by_membership_id', 'tenant_id', 'centre_id']) {
      const w2 = mkWorld(); const before = snapshotOf(w2); const s2 = setup(w2);
      const e = await untouched(s2, before, run('submitCultureReport', M14(C.prelim, { ...PRELIM, [f]: f === 'isolates' || f === 'ast' ? [] : 'x' }), s2.ctx));
      expectCode(e, 'common.validation_failed', 400); expect(e.errors?.map((x: any) => x.path), f).toContain(`/${f}`);
    }
  });
});

describe('C10-T15 body validation (S-05) - 400, nothing written, port never asked to submit', () => {
  const cases: [string, Row | unknown, string][] = [
    ['no report_phase', { is_critical: false }, '/report_phase'], ['report_phase other', { report_phase: 'amended', is_critical: false }, '/report_phase'], ['no is_critical', { report_phase: 'preliminary' }, '/is_critical'],
    ['is_critical not boolean', { report_phase: 'preliminary', is_critical: 'yes' }, '/is_critical'], ['empty summary', { ...PRELIM, culture_summary_text: '' }, '/culture_summary_text'],
    ['summary 4001', { ...PRELIM, culture_summary_text: 'x'.repeat(4001) }, '/culture_summary_text'], ['empty comments', { ...PRELIM, comments_text: '' }, '/comments_text'], ['comments 4001', { ...PRELIM, comments_text: 'x'.repeat(4001) }, '/comments_text'],
    ['early_final_reason 501', FINAL({ outcome_code: 'no_growth', early_final_reason: 'x'.repeat(501) }), '/early_final_reason'], ['early_final_reason empty', FINAL({ early_final_reason: '' }), '/early_final_reason'],
    ['outcome_code bad pattern', FINAL({ outcome_code: 'No Growth!' }), '/outcome_code'], ['outcome_code unknown', FINAL({ outcome_code: 'syn_unknown' }), '/outcome_code'], ['outcome_code inactive', FINAL({ outcome_code: 'syn_retired' }), '/outcome_code'],
    ['body is an array', [], '/'],
  ];
  it.each(cases)('%s', async (_n, body, path) => {
    const w = mkWorld(); const before = snapshotOf(w); const s = setup(w);
    const e = await untouched(s, before, run('submitCultureReport', M14(C.prelim, body as Row), s.ctx));
    expectCode(e, 'common.validation_failed', 400); expect(e.errors?.map((x: any) => x.path), JSON.stringify(e.errors)).toContain(path);
  });
});

// ------------------------------------------------------------------ AC-09.1 preliminary
describe('C10-T15 AC-09.1 preliminary report: one transaction, snapshot, port call', () => {
  it('201 ReportVersionDto; version_no = previous + 1; report_versions row = server-built snapshot; the culture status stays', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('submitCultureReport', M14(C.prelim, { ...PRELIM, comments_text: 'Synthetic comment', culture_summary_text: 'Synthetic summary' }), s.ctx);
    expect(res.status).toBe(201);
    expect(schemaErrors('ReportVersionDto', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ version_no: 1, report_phase: 'preliminary', version_kind: 'initial', flag: 'A', is_critical: false, signed_by_display: 'Synthetic Actor Tech', signed_at: NOW_ISO, lab_status_at_submit: 'resulted',
      lab_result_id: RESULT(C.prelim), lab_result_version_no: 1, culture_summary_text: 'Synthetic summary', comments_text: 'Synthetic comment' });
    expect(res.body.amendment_reason_code).toBeUndefined();
    const rows = versionsOf(w, C.prelim); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: A, centre_id: CENTRE_A1, culture_id: C.prelim, order_item_id: ITEM(C.prelim), version_no: 1, report_phase: 'preliminary', version_kind: 'initial', submission_kind: 'ast_panel', flag: 'A', is_critical: false,
      culture_summary_text: 'Synthetic summary', comments_text: 'Synthetic comment', signed_by_membership_id: ACTOR_M, lab_result_id: RESULT(C.prelim), lab_result_version_no: 1, lab_status_at_submit: 'resulted', lab_replayed: false, created_by: ACTOR_USER });
    expect(rows[0]!['outcome_code'] ?? null).toBeNull(); expect(rows[0]!['amendment_reason_code'] ?? null).toBeNull();
    expect(new Date(rows[0]!['signed_at']).toISOString()).toBe(NOW_ISO);
    expect(asJson(rows[0]!['isolates'])).toEqual([{ seq: 1, organism_code: ECOLI, organism_display: 'Synthetic E. coli', growth_text: 'Synthetic growth' }]);
    expect(asJson(rows[0]!['ast']).map((a: Row) => a['antibiotic_code'])).toEqual(['syn_amp', 'syn_cip']);
    expect(row(w, 'cultures', C.prelim)).toMatchObject({ status: 'incubating', current_report_version_no: 1, last_report_phase: 'preliminary', version: 6, updated_by: ACTOR_USER });
    expect(w['culture_transitions']).toHaveLength(0);
  });
  it('LabPort.submitModuleResult input: payloadRef { module micro, entityId, versionNo }, reportPhase, summaryText = snapshot summary, flag, isCritical, idempotencyKey micro:<culture_id>:<version_no>, submittedAt = now; no amendment', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('submitCultureReport', M14(C.prelim, { ...PRELIM, is_critical: true, culture_summary_text: 'Synthetic summary' }), s.ctx);
    expect(submits(s)).toHaveLength(1);
    expect(submits(s)[0]!.input).toEqual({ orderItemId: ITEM(C.prelim), kind: 'ast_panel', reportPhase: 'preliminary', payloadRef: { module: 'micro', entityId: C.prelim, versionNo: 1 }, summaryText: 'Synthetic summary', flag: 'A',
      isCritical: true, submittedAt: NOW_ISO, idempotencyKey: `micro:${C.prelim}:1` });
    expect(versionsOf(w, C.prelim)[0]!['is_critical']).toBe(true);
  });
  it('generated summary: the same text is sent to C5, stored and answered', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('submitCultureReport', M14(C.prelim, PRELIM), s.ctx);
    const sent = submits(s)[0]!.input['summaryText'];
    expect(sent).toMatch(/^Preliminary report\n/); expect(sent).toContain('Isolate 1: Synthetic E. coli'); expect(sent).not.toContain('Synthetic S. aureus');
    expect(res.body.culture_summary_text).toBe(sent); expect(versionsOf(w, C.prelim)[0]!['culture_summary_text']).toBe(sent);
  });
  it('a culture with only an observation (no isolate) can be submitted: kind structured, flag N for a no_growth read (AC-09.1 "≥1 observation or isolate")', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('submitCultureReport', M14(C.obsOnly, PRELIM), s.ctx);
    expect(res.status).toBe(201); expect(submits(s)[0]!.input).toMatchObject({ kind: 'structured', flag: 'N', reportPhase: 'preliminary' });
    expect(submits(s)[0]!.input['summaryText']).toBe('Preliminary report\nNo growth after 24 h');
    expect(versionsOf(w, C.obsOnly)[0]).toMatchObject({ submission_kind: 'structured', flag: 'N' });
  });
  it('single transaction order: the culture is read FOR UPDATE first, no write precedes the port call, report_versions is inserted after it, the culture is updated last; every statement binds the tenant', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('submitCultureReport', M14(C.prelim, PRELIM), s.ctx);
    const lock = s.log.findIndex((l) => l.table === 'cultures' && /FOR\s+UPDATE/i.test(l.sql));
    const port = s.log.findIndex((l) => l.sql === 'PORT submitModuleResult');
    const ins = s.log.findIndex((l) => l.table === 'report_versions' && l.op === 'INSERT');
    const upd = s.log.findIndex((l) => l.table === 'cultures' && l.op === 'UPDATE');
    expect(lock).toBe(s.log.findIndex((l) => l.table === 'cultures'));          // the first thing touched is the culture lock
    expect([lock >= 0, lock < port, port < ins, ins < upd]).toEqual([true, true, true, true]);
    expect(s.log.slice(0, port).filter((l) => l.op === 'INSERT' || l.op === 'UPDATE')).toEqual([]);
    for (const l of s.log.filter((x) => x.table !== 'lab' && x.table !== '')) expect(l.params, l.sql).toContain(A);
  });
  it('the port replaying the same idempotency key (a retried attempt) stores lab_replayed = true and still exactly one version', async () => {
    const w = mkWorld(); const s = setup(w);
    await s.lab.submitModuleResult(s.ctx, { orderItemId: ITEM(C.prelim), kind: 'ast_panel', reportPhase: 'preliminary', payloadRef: { module: 'micro', entityId: C.prelim, versionNo: 1 }, submittedAt: NOW_ISO, idempotencyKey: `micro:${C.prelim}:1` });
    const res = await run('submitCultureReport', M14(C.prelim, PRELIM), s.ctx);
    expect(res.status).toBe(201); expect(versionsOf(w, C.prelim)).toHaveLength(1); expect(versionsOf(w, C.prelim)[0]!['lab_replayed']).toBe(true);
  });
  it('a second preliminary (C5 line resulted, not approved) is version 2, version_kind update, key micro:<id>:2, no amendment sent', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('submitCultureReport', M14(C.resulted, PRELIM), s.ctx);
    expect(res.body).toMatchObject({ version_no: 2, version_kind: 'update' });
    expect(submits(s)[0]!.input['idempotencyKey']).toBe(`micro:${C.resulted}:2`); expect('amendment' in submits(s)[0]!.input && submits(s)[0]!.input['amendment'] !== undefined).toBe(false);
    expect(versionsOf(w, C.resulted).map((v) => v['version_no'])).toEqual([1, 2]);
    expect(row(w, 'cultures', C.resulted)).toMatchObject({ current_report_version_no: 2, last_report_phase: 'preliminary' });
  });
  it('two submissions in a row get consecutive versions 1 and 2 (no unique-key collision)', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('submitCultureReport', M14(C.prelim, PRELIM, { 'idempotency-key': 'k1' }), s.ctx); await run('submitCultureReport', M14(C.prelim, PRELIM, { 'idempotency-key': 'k2' }), s.ctx);
    expect(versionsOf(w, C.prelim).map((v) => [v['version_no'], v['version_kind']])).toEqual([[1, 'initial'], [2, 'update']]);
    expect(submits(s).map((x) => x.input['idempotencyKey'])).toEqual([`micro:${C.prelim}:1`, `micro:${C.prelim}:2`]);
  });
});

// ------------------------------------------------------------------ AC-09.2 / port errors
describe('C10-T15 AC-09.2 passed-through C5 codes: the original error, nothing persisted (failNext on each)', () => {
  const CODES: [string, number][] = [['lab.result_locked', 409], ['lab.result_invalid_transition', 409], ['lab.module_result_invalid', 422], ['lab.module_result_stale', 409], ['lab.amendment_reason_required', 422], ['auth.mfa_required', 403]];
  it.each(CODES)('%s (%i) surfaces unchanged for a preliminary and a final; no statement writes; the world is unchanged; the culture keeps its version', async (code) => {
    for (const body of [PRELIM, FINAL()]) {
      const w = mkWorld(); const before = snapshotOf(w); const s = setup(w);
      s.lab.failNext('submitModuleResult', code);
      const e = await failure(run('submitCultureReport', M14(C.prelim, body), s.ctx));
      expect(e.code, `${e?.code ?? e}`).toBe(code); expect(e.code).not.toBe('common.internal');
      expect(writesOf(s.log)).toEqual([]); expect(s.w).toEqual(before);
      expect(row(w, 'cultures', C.prelim)).toMatchObject({ current_report_version_no: 0, version: 5, status: 'incubating' });
      expect(s.log.some((l) => l.sql === 'PORT submitModuleResult')).toBe(true);        // the port WAS asked
    }
  });
  it('a failure of the chain read (getOrderResults) also writes nothing and surfaces unchanged', async () => {
    const w = mkWorld(); const before = snapshotOf(w); const s = setup(w);
    s.lab.failNext('getOrderResults', 'common.not_found');
    const e = await failure(run('submitCultureReport', M14(C.prelim, PRELIM), s.ctx));
    expect(e.code).toBe('common.not_found'); expect(writesOf(s.log)).toEqual([]); expect(s.w).toEqual(before);
  });
  it('the error is the port\'s own error object: its message is the code only, no snapshot content (REQ-SEC logging)', async () => {
    const w = mkWorld(); const s = setup(w);
    s.lab.failNext('submitModuleResult', 'lab.result_invalid_transition');
    const e = await failure(run('submitCultureReport', M14(C.prelim, { ...PRELIM, comments_text: 'SYNTHETIC-COMMENT-CONTENT' }), s.ctx));
    expect(e.message).toBe('lab.result_invalid_transition');
    expect(JSON.stringify(s.logs)).not.toContain('SYNTHETIC-COMMENT-CONTENT'); expect(JSON.stringify(s.logs)).not.toContain('Synthetic E. coli');
  });
});

// ------------------------------------------------------------------ guards
describe('C10-T15 guards: state (C4–C7) and completeness (AC-09.4, AC-10.1–10.3, AC-09.7)', () => {
  it('AC-09.4 nothing recorded -> 422 micro.report_incomplete (nothing written, no port submit)', async () => {
    for (const body of [PRELIM, FINAL({ outcome_code: 'no_growth' })]) {
      const w = mkWorld(); const before = snapshotOf(w); const s = setup(w);
      const e = await untouched(s, before, run('submitCultureReport', M14(C.empty, body), s.ctx));
      expectCode(e, 'micro.report_incomplete', 422);
    }
  });
  it('cancelled (preliminary and final), final_submitted (preliminary and final), awaiting_setup final, amending preliminary (C7 stays forbidden) -> 409 micro.culture_invalid_transition, nothing written', async () => {
    const cases: [string, string, Row][] = [['cancelled', C.cancelled, PRELIM], ['cancelled', C.cancelled, FINAL()], ['final_submitted', C.final, PRELIM], ['final_submitted', C.final, FINAL()],
      ['awaiting_setup', C.awaiting, FINAL({ outcome_code: 'no_growth' })], ['amending', C.amend, PRELIM]];
    for (const [name, c, body] of cases) {
      const w = mkWorld(); const before = snapshotOf(w); const s = setup(w, { amend: true });
      const e = await untouched(s, before, run('submitCultureReport', M14(c, body), s.ctx));
      expect(e.code, `${name} ${body['report_phase']}`).toBe('micro.culture_invalid_transition'); expect(e.statusCode).toBe(409);
    }
  });
  it('AC-10.1 final without outcome_code -> 422 micro.report_incomplete with errors[] /outcome_code', async () => {
    const w = mkWorld(); const before = snapshotOf(w); const s = setup(w);
    const e = await untouched(s, before, run('submitCultureReport', M14(C.prelim, { report_phase: 'final', is_critical: false }), s.ctx));
    expectCode(e, 'micro.report_incomplete', 422); expect(e.errors.map((x: any) => x.path)).toContain('/outcome_code');
  });
  it('AC-10.2 outcome with requires_isolate = true and no reportable identified isolate -> 422 micro.report_incomplete (/isolates)', async () => {
    const w = mkWorld(); const before = snapshotOf(w); const s = setup(w);
    const e = await untouched(s, before, run('submitCultureReport', M14(C.noIso, FINAL()), s.ctx));
    expectCode(e, 'micro.report_incomplete', 422); expect(e.errors.map((x: any) => x.path)).toContain('/isolates');
  });
  it('AC-10.2 a reportable AST row with a category but standard unknown -> 422 micro.ast_standard_required; one without raw/category -> micro.report_incomplete; errors[] name the offending row only', async () => {
    const w = mkWorld(); const before = snapshotOf(w); const s = setup(w);
    const e = await untouched(s, before, run('submitCultureReport', M14(C.badAst, FINAL()), s.ctx));
    expect(['micro.ast_standard_required', 'micro.report_incomplete'], e.code).toContain(e.code); expect(e.statusCode).toBe(422);
    const flat = JSON.stringify(e.errors); const rowOf = (abx: string) => w['ast_results']!.find((a) => a['culture_id'] === C.badAst && a['antibiotic_code'] === abx)!;
    expect(e.errors.every((x: any) => String(x.path).startsWith('/ast') || String(x.path).startsWith('/isolates'))).toBe(true);
    expect([rowOf('syn_cip')['antibiotic_code'], rowOf('syn_cip')['id'], rowOf('syn_gen')['antibiotic_code'], rowOf('syn_gen')['id']].some((k) => flat.includes(k))).toBe(true);
    expect(flat.includes(rowOf('syn_amp')['antibiotic_code']) || flat.includes(rowOf('syn_amp')['id'])).toBe(false);
  });
  it('AC-10.2 a row with standard unknown alone is micro.ast_standard_required (TRD §4.4 step 1)', async () => {
    const w = mkWorld(); w['ast_results'] = w['ast_results']!.filter((a) => !(a['culture_id'] === C.badAst && a['antibiotic_code'] === 'syn_gen')); const before = snapshotOf(w); const s = setup(w);
    const e = await untouched(s, before, run('submitCultureReport', M14(C.badAst, FINAL()), s.ctx));
    expectCode(e, 'micro.ast_standard_required', 422);
    const cip = w['ast_results']!.find((a) => a['culture_id'] === C.badAst && a['antibiotic_code'] === 'syn_cip')!;
    expect(JSON.stringify(e.errors).includes('syn_cip') || JSON.stringify(e.errors).includes(cip['id'])).toBe(true);
  });
  it('a preliminary leaves incomplete AST rows out of the snapshot instead of failing', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('submitCultureReport', M14(C.badAst, PRELIM), s.ctx);
    expect(res.status).toBe(201); expect(res.body.ast.map((a: Row) => a['antibiotic_code'])).toEqual(['syn_amp']);
  });
  it('AC-09.7 more than 20 isolates / 600 AST rows -> 422 micro.report_incomplete with errors[] (/isolates, /ast; code too_many_items), nothing submitted', async () => {
    for (const [c, path] of [[C.big21, '/isolates'], [C.big601, '/ast']] as const) {
      const w = mkWorld(); const before = snapshotOf(w); const s = setup(w);
      const e = await untouched(s, before, run('submitCultureReport', M14(c, PRELIM), s.ctx));
      expectCode(e, 'micro.report_incomplete', 422); expect(e.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path, code: 'too_many_items' })]));
    }
  });
  it('AC-10.3 no-growth final before final_due_at needs early_final_reason (setting early_final_requires_reason = true)', async () => {
    const w = mkWorld(); const before = snapshotOf(w); const s = setup(w);
    const e = await untouched(s, before, run('submitCultureReport', M14(C.noGrowth, FINAL({ outcome_code: 'no_growth' })), s.ctx));
    expectCode(e, 'micro.report_incomplete', 422); expect(e.errors.map((x: any) => x.path)).toContain('/early_final_reason');
  });
  it('AC-10.3 with the reason it succeeds and stores early_final_reason; without the requirement (setting false, or at/after final_due_at) no reason is needed', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('submitCultureReport', M14(C.noGrowth, FINAL({ outcome_code: 'no_growth', early_final_reason: 'Synthetic early reason' })), s.ctx);
    expect(res.status).toBe(201); expect(res.body.early_final_reason).toBe('Synthetic early reason'); expect(versionsOf(w, C.noGrowth)[0]!['early_final_reason']).toBe('Synthetic early reason');
    const w2 = mkWorld(); w2['settings']![0]!['early_final_requires_reason'] = false; const s2 = setup(w2);
    expect((await run('submitCultureReport', M14(C.noGrowth, FINAL({ outcome_code: 'no_growth' })), s2.ctx)).status).toBe(201);
    const w3 = mkWorld(); row(w3, 'cultures', C.noGrowth)['final_due_at'] = new Date('2026-11-05T04:00:00.000Z'); const s3 = setup(w3);
    expect((await run('submitCultureReport', M14(C.noGrowth, FINAL({ outcome_code: 'no_growth' })), s3.ctx)).status).toBe(201);
  });
  it('a tenant without a settings row behaves as the default (early reason required)', async () => {
    const w = mkWorld(); w['settings'] = []; const before = snapshotOf(w); const s = setup(w);
    const e = await untouched(s, before, run('submitCultureReport', M14(C.noGrowth, FINAL({ outcome_code: 'no_growth' })), s.ctx));
    expectCode(e, 'micro.report_incomplete', 422);
  });
});

// ------------------------------------------------------------------ final
describe('C10-T15 AC-10.4–10.5 final report', () => {
  it('success: culture final_submitted, outcome_code stored, transition row, version + 1; report row has outcome_code and flag from the outcome; port gets reportPhase final', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('submitCultureReport', M14(C.prelim, FINAL({ comments_text: 'Synthetic final comment' })), s.ctx);
    expect(res.status).toBe(201); expect(res.body).toMatchObject({ version_no: 1, report_phase: 'final', version_kind: 'initial', outcome_code: 'growth_reported', flag: 'A' });
    expect(row(w, 'cultures', C.prelim)).toMatchObject({ status: 'final_submitted', outcome_code: 'growth_reported', current_report_version_no: 1, last_report_phase: 'final', version: 6, updated_by: ACTOR_USER });
    expect(w['culture_transitions']).toHaveLength(1);
    expect(w['culture_transitions']![0]).toMatchObject({ tenant_id: A, centre_id: CENTRE_A1, culture_id: C.prelim, from_status: 'incubating', to_status: 'final_submitted', created_by: ACTOR_USER });
    expect(new Date(w['culture_transitions']![0]!['occurred_at']).toISOString()).toBe(NOW_ISO);
    expect(submits(s)[0]!.input).toMatchObject({ reportPhase: 'final', kind: 'ast_panel', flag: 'A', payloadRef: { module: 'micro', entityId: C.prelim, versionNo: 1 } });
    expect(versionsOf(w, C.prelim)[0]).toMatchObject({ report_phase: 'final', outcome_code: 'growth_reported', version_kind: 'initial' });
  });
  it('final no_growth (N) needs no isolate: kind structured, flag N from culture_outcomes.result_flag', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('submitCultureReport', M14(C.obsOnly, FINAL({ outcome_code: 'no_growth', early_final_reason: 'Synthetic early reason' })), s.ctx);
    expect(res.body).toMatchObject({ report_phase: 'final', outcome_code: 'no_growth', flag: 'N' }); expect(submits(s)[0]!.input).toMatchObject({ kind: 'structured', flag: 'N', reportPhase: 'final' });
    expect(res.body.isolates).toEqual([]); expect(res.body.ast).toEqual([]);
  });
  it('AC-10.5 / AC-16.1: isolates = identified, reportable, non-withdrawn only; ast = reportable, shown, with a category; the suppressed_by_rule and non-reportable rows stay stored', async () => {
    const w = mkWorld(); const astBefore = structuredClone(w['ast_results']); const isoBefore = structuredClone(w['isolates']); const s = setup(w);
    const res = await run('submitCultureReport', M14(C.prelim, FINAL()), s.ctx);
    expect(res.body.isolates.map((i: Row) => i['seq'])).toEqual([1]);
    expect(res.body.ast.map((a: Row) => a['antibiotic_code'])).toEqual(['syn_amp', 'syn_cip']);
    expect(w['ast_results']).toEqual(astBefore); expect(w['isolates']).toEqual(isoBefore);
    expect(w['ast_results']!.find((a) => a['antibiotic_code'] === 'syn_gen')!['report_visibility']).toBe('suppressed_by_rule');
  });
  it('AC-15.2: stored isolates / ast carry exactly the 05-SCHEMA §6 keys (antibiotic_display and organism_display snapshotted at submit time)', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('submitCultureReport', M14(C.prelim, FINAL()), s.ctx);
    const v = versionsOf(w, C.prelim)[0]!;
    expect(Object.keys(asJson(v['isolates'])[0]).sort()).toEqual(['growth_text', 'organism_code', 'organism_display', 'seq']);
    expect(Object.keys(asJson(v['ast'])[0]).sort()).toEqual(['antibiotic_code', 'antibiotic_display', 'category_code', 'isolate_seq', 'method', 'raw_value', 'standard', 'standard_version']);
    expect(asJson(v['ast'])[0]).toMatchObject({ isolate_seq: 1, antibiotic_code: 'syn_amp', antibiotic_display: 'Synthetic amp', raw_value: '2', category_code: 'S', standard: 'CLSI', standard_version: 'M100-2026' });
  });
  it('AC-10.4: after the final, a write to isolates / plates / observations through the service is 409 micro.report_final_locked', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('submitCultureReport', M14(C.prelim, FINAL()), s.ctx);
    const e = await failure(run('createIsolate', { params: { culture_id: C.prelim }, headers: KEY, body: {} }, s.ctx));
    expectCode(e, 'micro.report_final_locked', 409);
    expect(row(w, 'cultures', C.prelim)['status']).toBe('final_submitted');
  });
});

// ------------------------------------------------------------------ amendments
describe('C10-T15 amendments: AC-09.6 (D-61), AC-10.6, reopen reason (D-62), C6 guards, T-A6', () => {
  it('AC-10.6 final after an approved preliminary: amendment { reasonCode: module_phase_progression } (no text) is sent; version_kind amendment and the reason are stored; the culture becomes final_submitted', async () => {
    const w = mkWorld(); const s = setup(w, { amend: true });
    const res = await run('submitCultureReport', M14(C.apprPrelim, FINAL()), s.ctx);
    expect(res.status).toBe(201);
    expect(submits(s)[0]!.input['amendment']).toEqual({ reasonCode: 'module_phase_progression' });
    expect(res.body).toMatchObject({ version_no: 2, report_phase: 'final', version_kind: 'amendment', amendment_reason_code: 'module_phase_progression', lab_status_at_submit: 'approved', lab_result_version_no: 2 });
    expect(res.body.amendment_reason_text).toBeUndefined();
    expect(versionsOf(w, C.apprPrelim)[1]).toMatchObject({ version_no: 2, version_kind: 'amendment', amendment_reason_code: 'module_phase_progression' }); expect(versionsOf(w, C.apprPrelim)[1]!['amendment_reason_text'] ?? null).toBeNull();
    expect(row(w, 'cultures', C.apprPrelim)).toMatchObject({ status: 'final_submitted', current_report_version_no: 2, last_report_phase: 'final' });
  });
  it('AC-09.6 preliminary over an approved preliminary: amendment { reasonCode: module_preliminary_update } is sent automatically (D-61); version_kind amendment; the culture stays open; C5 holds the amendment reason', async () => {
    const w = mkWorld(); const s = setup(w, { amend: true });
    const res = await run('submitCultureReport', M14(C.apprPrelim, PRELIM), s.ctx);
    expect(submits(s)[0]!.input['amendment']).toEqual({ reasonCode: 'module_preliminary_update' });
    expect(res.body).toMatchObject({ version_no: 2, report_phase: 'preliminary', version_kind: 'amendment', amendment_reason_code: 'module_preliminary_update', lab_result_version_no: 2 });
    expect(versionsOf(w, C.apprPrelim)[1]).toMatchObject({ version_kind: 'amendment', amendment_reason_code: 'module_preliminary_update' });
    expect(row(w, 'cultures', C.apprPrelim)).toMatchObject({ status: 'incubating', last_report_phase: 'preliminary', current_report_version_no: 2 });
    const line = (await s.lab.getOrderResults(s.ctx, { orderId: ORDER, scope: 'all_visible' })).items.find((i: Row) => i.orderItemId === ITEM(C.apprPrelim)).results[0];
    expect(line.amendment).toMatchObject({ previousVersionNo: 1, reasonCode: 'module_preliminary_update' });
  });
  it('the "last approved phase" is read from report_versions.report_phase of the row = the approved moduleRef.versionNo (not from the culture\'s last_report_phase)', async () => {
    const w = mkWorld(); const s = setup(w, { amend: true });
    row(w, 'cultures', C.apprPrelim)['last_report_phase'] = 'final';                                       // misleading culture column
    const res = await run('submitCultureReport', M14(C.apprPrelim, PRELIM), s.ctx);
    expect(submits(s)[0]!.input['amendment']).toEqual({ reasonCode: 'module_preliminary_update' }); expect(res.status).toBe(201);
  });
  it('without lab.result.amend the C5 line is locked: lab.result_locked (409) is passed through, nothing written (AC-09.6 / T-A6 - C10 cannot approve or bypass)', async () => {
    for (const body of [PRELIM, FINAL()]) {
      const w = mkWorld(); const before = snapshotOf(w); const s = setup(w, { amend: false });
      const e = await failure(run('submitCultureReport', M14(C.apprPrelim, body), s.ctx));
      expect(e.code).toBe('lab.result_locked'); expect(writesOf(s.log)).toEqual([]); expect(s.w).toEqual(before);
    }
  });
  it('amending culture: the culture\'s amendment_reason_code / _text are sent as { reasonCode, reasonText } (final); version_kind amendment; stored; the culture becomes final_submitted (C6)', async () => {
    const w = mkWorld(); const s = setup(w, { amend: true });
    const res = await run('submitCultureReport', M14(C.amend, FINAL({ comments_text: 'Synthetic corrected' })), s.ctx);
    expect(submits(s)[0]!.input['amendment']).toEqual({ reasonCode: 'correction', reasonText: 'Synthetic fix' });
    expect(res.body).toMatchObject({ version_no: 2, version_kind: 'amendment', amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix', report_phase: 'final' });
    expect(versionsOf(w, C.amend)[1]).toMatchObject({ amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix', version_kind: 'amendment' });
    expect(row(w, 'cultures', C.amend)).toMatchObject({ status: 'final_submitted', current_report_version_no: 2 });
    expect(w['culture_transitions']![0]).toMatchObject({ from_status: 'amending', to_status: 'final_submitted' });
  });
  it('amending culture whose C5 line is not approved still sends the culture\'s reason (08 R1: ignored by C5 then) and stores version_kind amendment', async () => {
    const w = mkWorld(); const s = setup(w, { amend: true });
    await s.lab.__seed({ results: [{ id: RESULT(C.amend), tenantId: A, orderItemId: ITEM(C.amend), testId: TEST1, analyteId: u(0x60), versionNo: 1, status: 'resulted', origin: 'module', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false }] });
    const res = await run('submitCultureReport', M14(C.amend, FINAL()), s.ctx);
    expect(res.status).toBe(201); expect(submits(s)[0]!.input['amendment']).toEqual({ reasonCode: 'correction', reasonText: 'Synthetic fix' }); expect(res.body.version_kind).toBe('amendment');
  });
  it('an amendment reason C5 does not accept (D-62) surfaces unchanged as 422 lab.module_result_invalid and the culture stays amending', async () => {
    const w = mkWorld(); row(w, 'cultures', C.amend)['amendment_reason_code'] = 'module_preliminary_update';   // a system code on a final: C5 guard refuses
    const before = snapshotOf(w); const s = setup(w, { amend: true });
    const e = await failure(run('submitCultureReport', M14(C.amend, FINAL()), s.ctx));
    expect(e.code).toBe('lab.module_result_invalid'); expect(writesOf(s.log)).toEqual([]); expect(s.w).toEqual(before); expect(row(w, 'cultures', C.amend)['status']).toBe('amending');
  });
  it('the client cannot choose the amendment: no amendment field is accepted, and the version kind is never client-controlled (S-05)', async () => {
    const w = mkWorld(); const before = snapshotOf(w); const s = setup(w, { amend: true });
    const e = await untouched(s, before, run('submitCultureReport', M14(C.apprPrelim, { ...PRELIM, amendment_reason_code: 'correction' }), s.ctx));
    expectCode(e, 'common.validation_failed', 400);
  });
});
