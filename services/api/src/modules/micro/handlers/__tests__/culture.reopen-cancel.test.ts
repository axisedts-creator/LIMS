// C10 T-16 — M17 reopenCulture + M18 cancelCulture WITHOUT a database, plus the reopen -> submit amendment chain through M14 (06-IMPLEMENTATION-PLAN row T-16; 02-TRD §4.7, §5 M17/M18, §12, §13;
// 03-APP-FLOW §2.1 C6, C8, C9; PRD AC-11.1–11.6, AC-01.6; 07-SECURITY T-A1, S-01, S-05, S-30; 08 R1 / CR-C10-001 + A17 D-61/D-62; LD-140 not relevant: backend only).
// DB behaviour (real constraints cultures__amend__ck / __cancel__ck, RLS, parallel reopen, M15 listing, consumer rejection closing instrument records) is in culture.reopen-cancel.integration.test.ts
// (live DB, gated with LIMS_T16_REQUIRE_DB=1). Fake tx = helpers/reopenCancelWrites.ts (cultureWrites dialect + report_versions rules + cultures__amend/__cancel/__texts checks).
// LabPort = packages/fakes LabPort.fake (real submitModuleResult semantics incl. amendment guards); fixtures per culture below.
// SEAMS: handlers reopenCulture / cancelCulture in handlers/index.ts REAL map (service/report.service.ts for the amendment logic, culture.service.ts or report.service.ts for the two transitions, per plan).
//   Order: culture loaded FIRST FOR UPDATE (RLS + tenant; absent = 404 identical to another tenant's) -> IdentityPort.assertRole(ctx, { permission: 'micro.culture.work', centreId: culture.centre_id })
//   -> body validation -> If-Match (428 / 409 common.version_conflict) -> state (409 micro.culture_invalid_transition) -> writes. If-Match header `"<version>"`; every 200 carries ETag "<new version>".
// ASSUMED (spec silent; flagged so a ruling can overrule):
//   * M17 with the reason code ABSENT or "" = 422 micro.amendment_reason_required (AC-11.4 beats the schema's `required` -> 400); a code that fails the FORMAT (pattern / length / type) = 400 common.validation_failed /amendment_reason_code.
//   * M17 writes culture.amendment_reason_code/_text + one culture_transitions row (from final_submitted, to amending, reason_code = the amendment code, comment = the text).
//   * M18 reason_code is checked against v_culture_cancel_reasons (active) and refuses the two system codes `specimen_rejected`, `order_item_cancelled`: 400 common.validation_failed /reason_code (same convention as T-05/T-08/T-09).
//   * M18 on a culture WITH a submitted version asks LabPort.getOrderResults(all_visible); only a C5 line `cancelled` lets it through (TRD M18 "unless C5 status is cancelled"), otherwise 409 micro.culture_invalid_transition.
//   * M18 sets match_status = pending_match, match_reason = culture_cancelled on the culture's OPEN instrument records (pending_match, needs_mapping, conflict); applied / ignored records and other cultures' records are untouched.
//   * AC-11.3 (amending, C5 line not approved): the T-15 pin (report.submit.test.ts "still sends the culture's reason") is NOT contradicted; only the observable outcome is asserted here.
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { createFakeLabPort } from '../../../../../../../packages/fakes/src/LabPort.fake';
import { TENANT_A, TENANT_B } from '../../../../../../../packages/fakes/src/base';
import { LAB_AMEND, LAB_READ, mkCtx, READ, responseErrors, run, schemaErrors, specOps, WORK, type Row } from './helpers/cultureReads.js';
import { reopenCancelTx } from './helpers/reopenCancelWrites.js';
import { iso, NOW, writesOf, type World } from './helpers/reportWrites.js';

const A = TENANT_A, B = TENANT_B;
const u = (n: number) => `0190c618-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE_A1 = u(0xa1), CENTRE_B1 = u(0xb1);
const ACTOR_USER = '01a1b34e-1000-7eee-9d29-d7ca59a10001', ACTOR_M = '01a1a98a-ac40-7000-8000-00000000a500';
const ORDER = u(0x801), TEST1 = u(0x701);
const PLANTED = '2026-11-04T05:00:00.000Z';
const ECOLI = 'syn_ecoli';
const N = { final: 1, finalResulted: 2, inc: 3, growth: 4, awaiting: 5, amend: 6, cancelled: 7, b: 8, prelimAppr: 9, prelimResulted: 10, prelimChainCancelled: 11, finalBad: 12 } as const;
const C = Object.fromEntries(Object.entries(N).map(([k, n]) => [k, u(0x1000 + n)])) as Record<keyof typeof N, string>;
const off = (c: string) => parseInt(c.slice(-4), 16) - 0x1000;
const ITEM = (c: string) => u(0x2000 + off(c)), RESULT = (c: string) => u(0x3000 + off(c)), SPEC = (c: string) => u(0x900 + off(c)), PL = (c: string) => u(0x4000 + off(c));
const VERSION = 7;                                    // cultures.version of every fixture row
const SECRET_TEXT = 'SynLeakProbe-7731 reopen text', SECRET_COMMENT = 'SynLeakProbe-9142 cancel comment';

// ------------------------------------------------------------------ world
const culture = (id: string, status: string, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE_A1, order_id: ORDER, order_item_id: ITEM(id), specimen_id: SPEC(id), patient_id: u(0xa00), test_id: TEST1, specimen_type_code: 'urine', specimen_site_code: null, barcode_snapshot: null,
  plating_protocol_id: null, status, outcome_code: null, received_at: new Date('2026-11-04T04:00:00.000Z'), planted_at: new Date(PLANTED), next_read_due_at: null, final_due_at: new Date('2026-11-06T05:00:00.000Z'),
  last_specimen_seq: 1, current_report_version_no: 0, last_report_phase: null, chain_cancelled: false, amendment_reason_code: null, amendment_reason_text: null, cancel_reason_code: null, cancel_comment: null, cancelled_at: null,
  version: VERSION, is_active: true, created_at: new Date('2026-11-04T04:00:00.000Z'), created_by: ACTOR_USER, updated_at: new Date('2026-11-04T04:00:00.000Z'), updated_by: ACTOR_USER, ...over,
});
const finalCulture = (id: string, over: Row = {}) => culture(id, 'final_submitted', { outcome_code: 'growth_reported', current_report_version_no: 1, last_report_phase: 'final', planted_at: new Date(PLANTED), ...over });
const plate = (c: string): Row => ({ id: PL(c), tenant_id: A, centre_id: CENTRE_A1, culture_id: c, plate_no: 1, media_code: 'syn_blood', status: 'active', version: 1, is_active: true, planted_at: new Date(PLANTED) });
const isolate = (c: string, seq: number): Row => ({ id: u(0x5000 + off(c) * 0x40 + seq), tenant_id: A, centre_id: CENTRE_A1, culture_id: c, specimen_id: SPEC(c), isolate_seq: seq, plate_id: PL(c),
  status: 'identified', organism_code: ECOLI, organism_source: 'manual', identified_at: new Date('2026-11-04T09:00:00.000Z'), identified_by_membership_id: ACTOR_M, colony_description: 'Synthetic colony', quantity_text: null,
  is_reportable: true, withdraw_reason_code: null, withdraw_comment: null, ast_panel_id: null, ast_method: null, version: 3, is_active: true });
let astSeq = 0x70000;
const ast = (iso_: Row, abx: string, over: Row = {}): Row => ({ id: u(++astSeq), tenant_id: A, centre_id: CENTRE_A1, culture_id: iso_['culture_id'], isolate_id: iso_['id'], antibiotic_code: abx, method: 'mic', raw_value: '2',
  category_code: 'S', standard: 'CLSI', standard_version: 'M100-2026', source: 'manual', off_panel: false, is_reportable: true, report_visibility: 'shown', panel_sort_order: 1, suggestion_overridden: false, version: 1, is_active: true, ...over });
const version = (c: string, no: number, phase: 'preliminary' | 'final'): Row => ({ id: u(0x8000 + off(c) * 0x10 + no), tenant_id: A, centre_id: CENTRE_A1, culture_id: c, order_item_id: ITEM(c), version_no: no, report_phase: phase,
  version_kind: no === 1 ? 'initial' : 'update', submission_kind: 'organism', outcome_code: phase === 'final' ? 'growth_reported' : null, early_final_reason: null, amendment_reason_code: null, amendment_reason_text: null,
  culture_summary_text: 'Synthetic earlier summary', isolates: [{ seq: 1, organism_code: ECOLI, organism_display: 'Synthetic E. coli', growth_text: '' }], ast: [], comments_text: null, is_critical: false, flag: 'A',
  signed_by_membership_id: ACTOR_M, signed_at: new Date('2026-11-04T10:00:00.000Z'), lab_result_id: RESULT(c), lab_result_version_no: 1, lab_status_at_submit: 'resulted', lab_replayed: false, created_by: ACTOR_USER });
const record = (n: number, status: string, over: Row = {}): Row => ({ id: u(0x9000 + n), tenant_id: A, centre_id: CENTRE_A1, culture_id: C.awaiting, specimen_id: SPEC(C.awaiting), record_kind: 'organism_id', match_status: status,
  match_reason: status === 'pending_match' ? 'no_culture' : null, ignore_reason_code: status === 'ignored' ? 'duplicate' : null, expires_at: status === 'applied' || status === 'ignored' ? new Date('2026-12-01T00:00:00.000Z') : null,
  version: 2, is_active: true, sample_barcode: 'SYN001', received_at: new Date(PLANTED), ...over });
const R = { pending: u(0x9001), needs: u(0x9002), conflict: u(0x9003), applied: u(0x9004), ignored: u(0x9005), other: u(0x9006), tenantB: u(0x9007) };

function mkWorld(): World {
  const cultures = [
    finalCulture(C.final), finalCulture(C.finalResulted), culture(C.inc, 'incubating'), culture(C.growth, 'growth_detected'), culture(C.awaiting, 'awaiting_setup', { planted_at: null, final_due_at: null }),
    finalCulture(C.amend, { status: 'amending', amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix' }), culture(C.cancelled, 'cancelled', { cancel_reason_code: 'entered_in_error', cancelled_at: new Date(PLANTED) }),
    finalCulture(C.b, { tenant_id: B, centre_id: CENTRE_B1 }),
    culture(C.prelimAppr, 'incubating', { current_report_version_no: 1, last_report_phase: 'preliminary' }), culture(C.prelimResulted, 'incubating', { current_report_version_no: 1, last_report_phase: 'preliminary' }),
    culture(C.prelimChainCancelled, 'incubating', { current_report_version_no: 1, last_report_phase: 'preliminary' }), finalCulture(C.finalBad),
  ];
  const withIso = [C.final, C.finalResulted, C.finalBad];
  const isolates = withIso.map((c) => isolate(c, 1));
  const asts = isolates.flatMap((i) => [ast(i, 'syn_amp', { panel_sort_order: 1 }), ast(i, 'syn_cip', { panel_sort_order: 2, category_code: 'R' })]);
  return {
    cultures, culture_plates: [...withIso, C.inc, C.growth, C.amend].map(plate), isolates, ast_results: asts, culture_observations: [], culture_transitions: [], specimen_isolate_counters: [],
    report_versions: [version(C.final, 1, 'final'), version(C.finalResulted, 1, 'final'), version(C.finalBad, 1, 'final'), version(C.amend, 1, 'final'),
      version(C.prelimAppr, 1, 'preliminary'), version(C.prelimResulted, 1, 'preliminary'), version(C.prelimChainCancelled, 1, 'preliminary')],
    instrument_records: [record(1, 'pending_match', { id: R.pending, match_reason: 'unknown_barcode' }), record(2, 'needs_mapping', { id: R.needs }), record(3, 'conflict', { id: R.conflict }), record(4, 'applied', { id: R.applied }),
      record(5, 'ignored', { id: R.ignored }), record(6, 'pending_match', { id: R.other, culture_id: C.inc, specimen_id: SPEC(C.inc) }), record(7, 'pending_match', { id: R.tenantB, tenant_id: B, centre_id: CENTRE_B1, culture_id: C.b })],
    settings: [], plating_protocols: [], plating_protocol_media: [], plating_protocol_keys: [],
    v_culture_cancel_reasons: [{ code: 'entered_in_error', display: 'Entered in error', is_active: true }, { code: 'not_processed', display: 'Not processed', is_active: true }, { code: 'syn_retired', display: 'Retired', is_active: false },
      { code: 'specimen_rejected', display: 'Specimen rejected', is_active: true }, { code: 'order_item_cancelled', display: 'Order item cancelled', is_active: true }],
    v_organisms: [{ code: ECOLI, display: 'Synthetic E. coli', is_active: true, is_alert: false }], v_antibiotics: ['syn_amp', 'syn_cip'].map((code) => ({ code, display: `Synthetic ${code.slice(4)}`, is_active: true })),
    v_growth_codes: [{ code: 'syn_growth', display: 'Synthetic growth', is_active: true, indicates_growth: true }, { code: 'no_growth', display: 'No growth', is_active: true, indicates_growth: false }],
    v_culture_outcomes: [{ code: 'growth_reported', display: 'Growth - see isolates', is_active: true, result_flag: 'A', requires_isolate: true }, { code: 'no_growth', display: 'No growth', is_active: true, result_flag: 'N', requires_isolate: false }],
    v_media: [{ code: 'syn_blood', display: 'Synthetic blood agar', is_active: true }], v_specimen_sites: [], v_isolate_withdraw_reasons: [],
  };
}
const row = (w: World, table: string, id: string): Row => w[table]!.find((r) => r['id'] === id)!;
const versionsOf = (w: World, c: string) => w['report_versions']!.filter((r) => r['culture_id'] === c).sort((a, b) => a['version_no'] - b['version_no']);
const transitionsOf = (w: World, c: string) => w['culture_transitions']!.filter((t) => t['culture_id'] === c);

// LabPort fixtures: status / last approved phase of each culture's micro result line
interface LabState { status: string; lastPhase?: 'preliminary' | 'final' }
const LAB: Partial<Record<keyof typeof N, LabState>> = {
  final: { status: 'approved', lastPhase: 'final' }, finalResulted: { status: 'resulted', lastPhase: 'final' }, finalBad: { status: 'approved', lastPhase: 'final' },
  amend: { status: 'approved', lastPhase: 'final' }, prelimAppr: { status: 'approved', lastPhase: 'preliminary' }, prelimResulted: { status: 'resulted', lastPhase: 'preliminary' }, prelimChainCancelled: { status: 'cancelled', lastPhase: 'preliminary' },
};
function labFixtures(w: World, grants: readonly string[]) {
  return {
    grants: { [ACTOR_USER]: [...grants] },
    orders: [{ id: ORDER, tenantId: A, patientId: u(0xa00), centreId: CENTRE_A1, priority: 'routine', patient: { sex: 'female', ageDays: 12000 } }],
    items: w['cultures']!.filter((c) => c['tenant_id'] === A).map((c) => ({ id: c['order_item_id'], tenantId: A, orderId: ORDER, testId: TEST1, departmentId: u(0x90), workflowType: 'microbiology' })),
    results: w['cultures']!.filter((c) => c['tenant_id'] === A).map((c) => {
      const key = (Object.keys(C) as (keyof typeof N)[]).find((k) => C[k] === c['id'])!; const st = LAB[key];
      return { id: RESULT(c['id']), tenantId: A, orderItemId: c['order_item_id'], testId: TEST1, analyteId: u(0x60), versionNo: 1, status: st?.status ?? 'pending', origin: 'module', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false,
        ...(st?.lastPhase ? { moduleRef: { module: 'micro', entityId: c['id'], versionNo: 1 }, lastPhase: st.lastPhase, lastPayloadVersion: 1 } : {}) };
    }),
  };
}

function setup(w: World, o: { grants?: readonly string[]; amend?: boolean } = {}) {
  const { tx, log } = reopenCancelTx(w);
  const { ctx, calls } = mkCtx({ tenantId: A, tx, grants: o.grants ?? [WORK], actor: { type: 'user', id: ACTOR_USER, membershipId: ACTOR_M }, members: { [ACTOR_M]: 'Synthetic Actor Tech' }, users: { [ACTOR_USER]: 'Synthetic Actor User' },
    tests: { [TEST1]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } } });
  const lab: any = createFakeLabPort({ seed: 1, fixtures: labFixtures(w, [LAB_READ, ...(o.amend ? [LAB_AMEND] : [])]) as any });
  ctx.ports.LabPort = {
    getOrderResults: (c: unknown, i: unknown) => lab.getOrderResults(c, i),
    submitModuleResult: async (c: unknown, i: unknown) => { log.push({ sql: 'PORT submitModuleResult', params: [], op: 'OTHER', table: 'lab' }); return lab.submitModuleResult(c, i); },
  };
  const logs: unknown[] = []; const sink = (...a: unknown[]) => { logs.push(a); };
  ctx.log = { info: sink, warn: sink, error: sink, debug: sink, child() { return this; } };
  return { ctx, calls, log, lab, w, logs };
}
type S = ReturnType<typeof setup>;
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const KEY = { 'idempotency-key': 'syn-key-1' };
const M17 = (cultureId: string, body: Row = { amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix' }, headers: Row = ifm(VERSION)) => ({ params: { culture_id: cultureId }, headers, body });
const M18 = (cultureId: string, body: Row = { reason_code: 'entered_in_error', comment: 'Synthetic comment' }, headers: Row = ifm(VERSION)) => ({ params: { culture_id: cultureId }, headers, body });
const M14 = (cultureId: string, body: Row) => ({ params: { culture_id: cultureId }, headers: KEY, body });
const FINAL = (over: Row = {}) => ({ report_phase: 'final', outcome_code: 'growth_reported', is_critical: false, ...over });
const submits = (s: S) => s.lab.calls('submitModuleResult') as { input: Row }[];
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };
// port errors (lab.*) come from the fakes package's own LimsError class: compare by code, and by status when the error carries one
const expectCode = (e: any, code: string, status: number) => { expect(isLimsError(e, code) || e?.code === code, `${e?.code ?? e}`).toBe(true); if (e.statusCode !== undefined) expect(e.statusCode).toBe(status); };
const expectInvalid = (e: any, path?: string) => { expectCode(e, 'common.validation_failed', 400); if (path !== undefined) expect(e.errors?.map((x: any) => x.path), JSON.stringify(e.errors)).toContain(path); };
/** the call is refused and the world is exactly as before (no statement wrote anything, the port was never asked to submit) */
const untouched = async (s: S, before: World, p: Promise<unknown>): Promise<any> => {
  const e = await failure(p);
  expect(writesOf(s.log)).toEqual([]); expect(s.w).toEqual(before); expect(submits(s)).toHaveLength(0);
  return e;
};

// ------------------------------------------------------------------ contract pins
describe('C10-T16 contract pins (micro.yaml)', () => {
  it('M17 reopenCulture: micro.culture.work, idempotency optional, If-Match, closed body { amendment_reason_code (pattern, lab.amendment_reasons), amendment_reason_text 1..500 }, 200 CultureDetailDto, declared errors', () => {
    const op = specOps()['reopenCulture'];
    expect(op['x-permission']).toBe(WORK); expect(op['x-idempotency']).toBe('optional');
    expect(op.parameters.some((p: any) => String(p.$ref ?? '').endsWith('/IfMatch'))).toBe(true);
    for (const c of ['micro.amendment_reason_required', 'micro.culture_invalid_transition', 'common.version_conflict', 'common.precondition_required', 'common.not_found', 'auth.forbidden', 'common.validation_failed']) expect(op['x-error-codes'], c).toContain(c);
    const b = op.requestBody.content['application/json'].schema;
    expect(b.additionalProperties).toBe(false); expect(Object.keys(b.properties).sort()).toEqual(['amendment_reason_code', 'amendment_reason_text']);
    expect(b.properties.amendment_reason_code['x-coded-set']).toBe('lab.amendment_reasons');
    expect([b.properties.amendment_reason_text.minLength, b.properties.amendment_reason_text.maxLength]).toEqual([1, 500]);
    expect(op.responses['200'].content['application/json'].schema.$ref).toMatch(/CultureDetailDto$/);
  });
  it('M18 cancelCulture: micro.culture.work, idempotency optional, If-Match, closed body { reason_code (micro.culture_cancel_reasons), comment 1..500 }, 200 CultureSummaryDto, declared errors', () => {
    const op = specOps()['cancelCulture'];
    expect(op['x-permission']).toBe(WORK); expect(op['x-idempotency']).toBe('optional');
    expect(op.parameters.some((p: any) => String(p.$ref ?? '').endsWith('/IfMatch'))).toBe(true);
    for (const c of ['micro.culture_invalid_transition', 'common.version_conflict', 'common.precondition_required', 'common.not_found', 'auth.forbidden', 'common.validation_failed']) expect(op['x-error-codes'], c).toContain(c);
    const b = op.requestBody.content['application/json'].schema;
    expect(b.additionalProperties).toBe(false); expect(b.required).toEqual(['reason_code']); expect(Object.keys(b.properties).sort()).toEqual(['comment', 'reason_code']);
    expect(b.properties.reason_code['x-coded-set']).toBe('micro.culture_cancel_reasons');
    expect(op.responses['200'].content['application/json'].schema.$ref).toMatch(/CultureSummaryDto$/);
  });
});

// ------------------------------------------------------------------ permission + BOLA (both operations)
const WRITES: [string, (id: string) => Row][] = [['reopenCulture', (id) => M17(id)], ['cancelCulture', (id) => M18(id)]];
const TARGET: Record<string, string> = { reopenCulture: C.final, cancelCulture: C.inc };
describe('C10-T16 permissions and tenant isolation: object first, then micro.culture.work with the object\'s centre (02-CV §10.1; S-01)', () => {
  it.each(WRITES)('%s without micro.culture.work (read-only / config-only / none) -> 403 auth.forbidden, asked AFTER the culture was read, with its centre_id; nothing written', async (op, req) => {
    for (const grants of [[READ], ['micro.config.manage'], []]) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w, { grants });
      const e = await untouched(s, before, run(op, req(TARGET[op]!), s.ctx));
      expectCode(e, 'auth.forbidden', 403);
      expect(s.calls.assertRole.at(-1), JSON.stringify(grants)).toEqual({ permission: WORK, centreId: CENTRE_A1 });
      expect(s.log.length).toBeGreaterThan(0);
    }
  });
  it.each(WRITES)('%s on a culture of tenant B and on a random id: the same 404 common.not_found; nothing written, no permission decision', async (op, req) => {
    const w1 = mkWorld(); const w2 = mkWorld(); const before = structuredClone(w1); const s1 = setup(w1); const s2 = setup(w2);
    const e1 = await untouched(s1, before, run(op, req(C.b), s1.ctx));
    const e2 = await failure(run(op, req(u(0x10ff)), s2.ctx));
    for (const e of [e1, e2]) expectCode(e, 'common.not_found', 404);
    expect({ code: e1.code, message: e1.message }).toEqual({ code: e2.code, message: e2.message });
    expect(s1.calls.assertRole).toEqual([]);
    expect(row(w1, 'instrument_records', R.tenantB)['match_status']).toBe('pending_match');
  });
  it.each(WRITES)('%s: a path id that is not a uuid -> 400 common.validation_failed, nothing written', async (op, req) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await untouched(s, before, run(op, req('not-a-uuid'), s.ctx)));
  });
});

// ------------------------------------------------------------------ M17 reopenCulture
describe('C10-T16 M17 reopenCulture: AC-11.1 final_submitted -> amending (C8)', () => {
  it('stores the reason, culture amending, version + 1, one transition row, CultureDetailDto + ETag; no call to C5; report versions untouched', async () => {
    const w = mkWorld(); const s = setup(w); const v1 = structuredClone(versionsOf(w, C.final));
    const res = await run('reopenCulture', M17(C.final), s.ctx);
    expect(res.status).toBe(200);
    expect(row(w, 'cultures', C.final)).toMatchObject({ status: 'amending', amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix', version: VERSION + 1, updated_by: ACTOR_USER, outcome_code: 'growth_reported', current_report_version_no: 1 });
    expect(transitionsOf(w, C.final)).toHaveLength(1);
    expect(transitionsOf(w, C.final)[0]).toMatchObject({ from_status: 'final_submitted', to_status: 'amending', reason_code: 'correction', tenant_id: A, centre_id: CENTRE_A1, created_by: ACTOR_USER });
    expect(iso(transitionsOf(w, C.final)[0]!['occurred_at'])).toBe(NOW.toISOString());
    expect(res.body).toMatchObject({ id: C.final, status: 'amending', version: VERSION + 1, current_report_version_no: 1 });
    expect(res.body.amendment_reason_code).toBe('correction'); expect(res.body.amendment_reason_text).toBe('Synthetic fix');
    expect(responseErrors('reopenCulture', res.body)).toEqual([]); expect(schemaErrors('CultureDetailDto', res.body)).toEqual([]);
    expect(res.headers?.['etag']).toBe(`"${VERSION + 1}"`);
    expect(versionsOf(w, C.final)).toEqual(v1);                                    // AC-11.5: the submitted version is never changed
    expect(w['report_versions']!.length).toBe(7);
    expect(s.log.filter((l) => l.table === 'report_versions' && l.op !== 'SELECT')).toEqual([]);
    expect(submits(s)).toHaveLength(0);                                            // C8 is local: C5 hears nothing until the new version is submitted
    expect(row(w, 'cultures', C.inc)['status']).toBe('incubating');                // other cultures untouched
  });

  it('the reason text is optional: no text -> amendment_reason_text null / absent on the wire', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('reopenCulture', M17(C.final, { amendment_reason_code: 'correction' }), s.ctx);
    expect(row(w, 'cultures', C.final)['amendment_reason_text'] ?? null).toBeNull();
    expect(res.body.amendment_reason_text).toBeUndefined();
    expect(responseErrors('reopenCulture', res.body)).toEqual([]);
  });

  it.each(['module_phase_progression', 'module_preliminary_update', 'supplementary_report', 'syn_unknown_reason'])(
    'S-30 / D-62: C10 checks the FORMAT only - %s is accepted at reopen (C5 judges it at submission)', async (code) => {
      const w = mkWorld(); const s = setup(w);
      const res = await run('reopenCulture', M17(C.final, { amendment_reason_code: code }), s.ctx);
      expect(res.status).toBe(200); expect(row(w, 'cultures', C.final)).toMatchObject({ status: 'amending', amendment_reason_code: code });
      expect(submits(s)).toHaveLength(0);                                          // no C5 round trip at reopen
    });

  it('working rows become editable again (AC-11.1): an observation is refused while final (micro.report_final_locked) and accepted after the reopen', async () => {
    const w = mkWorld(); const s = setup(w);
    const note = { params: { culture_id: C.final }, headers: KEY, body: { kind: 'gram_stain', finding_text: 'Synthetic stain finding' } };
    expectCode(await failure(run('recordCultureObservation', note, s.ctx)), 'micro.report_final_locked', 409);
    await run('reopenCulture', M17(C.final), s.ctx);
    const res = await run('recordCultureObservation', note, s.ctx);
    expect(res.status).toBe(200);
    expect(w['culture_observations']!.filter((o) => o['culture_id'] === C.final)).toHaveLength(1);
  });

  it('AC-11.4: no reason code (missing or empty) -> 422 micro.amendment_reason_required; the culture stays final, nothing written', async () => {
    for (const body of [{}, { amendment_reason_text: 'Synthetic fix' }, { amendment_reason_code: '' }, { amendment_reason_code: '', amendment_reason_text: 'Synthetic fix' }]) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectCode(await untouched(s, before, run('reopenCulture', M17(C.final, body as Row), s.ctx)), 'micro.amendment_reason_required', 422);
      expect(row(w, 'cultures', C.final)['status']).toBe('final_submitted');
    }
  });

  it.each([
    ['code with a space', { amendment_reason_code: 'bad code' }],
    ['code starting with an underscore', { amendment_reason_code: '_correction' }],
    ['code of 101 chars', { amendment_reason_code: 'a'.repeat(101) }],
    ['SQL in the code', { amendment_reason_code: "correction'; DROP TABLE micro.cultures;--" }],
    ['code not a string', { amendment_reason_code: 7 }],
    ['text of 501 chars', { amendment_reason_code: 'correction', amendment_reason_text: 'x'.repeat(501) }],
    ['empty text', { amendment_reason_code: 'correction', amendment_reason_text: '' }],
    ['text not a string', { amendment_reason_code: 'correction', amendment_reason_text: 5 }],
    ['unknown field status (S-05)', { amendment_reason_code: 'correction', status: 'amending' }],
    ['unknown field tenant_id (S-05)', { amendment_reason_code: 'correction', tenant_id: B }],
    ['unknown field version', { amendment_reason_code: 'correction', version: 99 }],
    ['unknown field outcome_code', { amendment_reason_code: 'correction', outcome_code: 'no_growth' }],
    ['unknown field cancel_reason_code', { amendment_reason_code: 'correction', cancel_reason_code: 'entered_in_error' }],
  ])('%s -> 400 common.validation_failed, nothing written', async (_n, body) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await untouched(s, before, run('reopenCulture', M17(C.final, body as Row), s.ctx)));
  });

  it('body that is not an object -> 400 common.validation_failed', async () => {
    for (const body of [null, 'correction', ['correction']]) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectInvalid(await untouched(s, before, run('reopenCulture', M17(C.final, body as any), s.ctx)));
    }
  });

  it.each([['awaiting_setup', C.awaiting], ['incubating', C.inc], ['growth_detected', C.growth], ['amending', C.amend], ['cancelled', C.cancelled]])(
    'culture in %s -> 409 micro.culture_invalid_transition (only final_submitted reopens), nothing written', async (_s, id) => {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectCode(await untouched(s, before, run('reopenCulture', M17(id), s.ctx)), 'micro.culture_invalid_transition', 409);
    });

  it('a second reopen right after the first (same If-Match, then the new one) -> 409; one transition row, the first reason is kept', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('reopenCulture', M17(C.final), s.ctx);
    for (const h of [ifm(VERSION), ifm(VERSION + 1)]) {
      const e = await failure(run('reopenCulture', M17(C.final, { amendment_reason_code: 'syn_other' }, h), s.ctx));
      expect(['common.version_conflict', 'micro.culture_invalid_transition'].some((c) => isLimsError(e, c)), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(409);
    }
    expect(transitionsOf(w, C.final)).toHaveLength(1); expect(row(w, 'cultures', C.final)).toMatchObject({ amendment_reason_code: 'correction', version: VERSION + 1 });
  });

  it('stale If-Match -> 409 common.version_conflict; missing If-Match -> 428 common.precondition_required; nothing written either way', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await untouched(s, before, run('reopenCulture', M17(C.final, undefined, ifm(VERSION - 1)), s.ctx)), 'common.version_conflict', 409);
    expectCode(await untouched(s, before, run('reopenCulture', M17(C.final, undefined, {}), s.ctx)), 'common.precondition_required', 428);
  });

  it('nothing the user typed is logged (TRD §11): reason text and code stay out of every log call', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('reopenCulture', M17(C.final, { amendment_reason_code: 'correction', amendment_reason_text: SECRET_TEXT }), s.ctx);
    const w2 = mkWorld(); const s2 = setup(w2);
    await failure(run('reopenCulture', M17(C.amend, { amendment_reason_code: 'correction', amendment_reason_text: SECRET_TEXT }), s2.ctx));
    for (const x of [s, s2]) expect(JSON.stringify(x.logs)).not.toContain('SynLeakProbe');
  });
});

// ------------------------------------------------------------------ reopen -> submit: the amendment chain (AC-11.2, 11.3, 11.5, 11.6, S-30)
describe('C10-T16 amendment chain: M17 then M14 (CR-C10-001, D-61, D-62)', () => {
  const reopen = async (s: S, id: string, body: Row = { amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix' }) => {
    await run('reopenCulture', M17(id, body), s.ctx); s.log.length = 0;
  };

  it('AC-11.2: amending + C5 approved, user holds lab.result.amend -> amendment { reasonCode, reasonText } goes to C5, version 2 (kind amendment, reason stored), culture final_submitted, C5 holds the amendment', async () => {
    const w = mkWorld(); const s = setup(w, { amend: true }); await reopen(s, C.final);
    const res = await run('submitCultureReport', M14(C.final, FINAL({ comments_text: 'Synthetic corrected' })), s.ctx);
    expect(res.status).toBe(201);
    expect(submits(s)).toHaveLength(1);
    expect(submits(s)[0]!.input['amendment']).toEqual({ reasonCode: 'correction', reasonText: 'Synthetic fix' });
    expect(submits(s)[0]!.input).toMatchObject({ reportPhase: 'final', payloadRef: { module: 'micro', entityId: C.final, versionNo: 2 }, idempotencyKey: `micro:${C.final}:2` });
    expect(res.body).toMatchObject({ version_no: 2, report_phase: 'final', version_kind: 'amendment', amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix', lab_result_version_no: 2 });
    expect(versionsOf(w, C.final)[1]).toMatchObject({ version_no: 2, version_kind: 'amendment', amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix' });
    expect(row(w, 'cultures', C.final)).toMatchObject({ status: 'final_submitted', current_report_version_no: 2, last_report_phase: 'final' });
    expect(transitionsOf(w, C.final).map((t) => [t['from_status'], t['to_status']])).toEqual([['final_submitted', 'amending'], ['amending', 'final_submitted']]);
    const line = (await s.lab.getOrderResults(s.ctx, { orderId: ORDER, scope: 'all_visible' })).items.find((i: Row) => i.orderItemId === ITEM(C.final)).results[0];
    expect(line.amendment).toMatchObject({ previousVersionNo: 1, reasonCode: 'correction', reasonText: 'Synthetic fix' });
  });

  it('AC-11.2 / T-A6: without lab.result.amend C5 refuses -> 409 lab.result_locked passed through; nothing persisted; the culture stays amending with its reason', async () => {
    const w = mkWorld(); const s = setup(w, { amend: false }); await reopen(s, C.final);
    const before = structuredClone(w);
    const e = await failure(run('submitCultureReport', M14(C.final, FINAL()), s.ctx));
    expectCode(e, 'lab.result_locked', 409);
    expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
    expect(row(w, 'cultures', C.final)).toMatchObject({ status: 'amending', amendment_reason_code: 'correction', current_report_version_no: 1 });
  });

  it('AC-11.3: amending but the C5 line is not yet approved (resulted) -> the submission goes through as an ordinary re-submission: 201, culture final_submitted, the C5 line stays resulted (not approved)', async () => {
    const w = mkWorld(); const s = setup(w, { amend: true }); await reopen(s, C.finalResulted);
    const res = await run('submitCultureReport', M14(C.finalResulted, FINAL()), s.ctx);
    expect(res.status).toBe(201); expect(res.body).toMatchObject({ version_no: 2, report_phase: 'final' });
    expect(row(w, 'cultures', C.finalResulted)).toMatchObject({ status: 'final_submitted', current_report_version_no: 2 });
    const line = (await s.lab.getOrderResults(s.ctx, { orderId: ORDER, scope: 'all_visible' })).items.find((i: Row) => i.orderItemId === ITEM(C.finalResulted)).results[0];
    expect(line.status).toBe('resulted');
    expect(row(w, 'cultures', C.finalResulted)['status']).not.toBe('amending');
  });

  it('AC-11.6 (D-62): a reason code C5 rejects -> 422 lab.module_result_invalid passed through unchanged; nothing persisted; the culture stays amending; no new version', async () => {
    const w = mkWorld(); const s = setup(w, { amend: true }); await reopen(s, C.finalBad, { amendment_reason_code: 'syn_unknown_reason' });
    const before = structuredClone(w);
    s.lab.failNext('submitModuleResult', 'lab.module_result_invalid');              // the shared fake answers an unknown reason with validation_failed; real C5 (D-62) = module_result_invalid, so script it
    const e = await failure(run('submitCultureReport', M14(C.finalBad, FINAL()), s.ctx));
    expectCode(e, 'lab.module_result_invalid', 422); expect(e.code).not.toBe('common.internal');
    expect(s.log.some((l) => l.sql === 'PORT submitModuleResult')).toBe(true);      // the port WAS asked
    expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
    expect(row(w, 'cultures', C.finalBad)).toMatchObject({ status: 'amending', amendment_reason_code: 'syn_unknown_reason', current_report_version_no: 1 });
    expect(versionsOf(w, C.finalBad)).toHaveLength(1);
  });

  it.each(['module_phase_progression', 'module_preliminary_update', 'supplementary_report'])(
    'S-30: reopened with the system code %s, the later FINAL submission on the approved C5 line -> 422 lab.module_result_invalid; the culture stays amending', async (code) => {
      const w = mkWorld(); const s = setup(w, { amend: true }); await reopen(s, C.final, { amendment_reason_code: code });
      const before = structuredClone(w);
      expectCode(await failure(run('submitCultureReport', M14(C.final, FINAL()), s.ctx)), 'lab.module_result_invalid', 422);
      expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
      expect(row(w, 'cultures', C.final)).toMatchObject({ status: 'amending', amendment_reason_code: code });
    });

  it('AC-11.5: after reopen + amended submission both versions exist: version 1 byte-for-byte as before, version 2 ascending after it; no statement ever updated or deleted a report_versions row', async () => {
    const w = mkWorld(); const s = setup(w, { amend: true }); const v1 = structuredClone(versionsOf(w, C.final)[0]);
    await run('reopenCulture', M17(C.final), s.ctx);
    await run('submitCultureReport', M14(C.final, FINAL()), s.ctx);
    const vs = versionsOf(w, C.final);
    expect(vs.map((v) => v['version_no'])).toEqual([1, 2]); expect(vs[0]).toEqual(v1);
    expect(s.log.filter((l) => l.table === 'report_versions').map((l) => l.op).filter((op) => op !== 'SELECT' && op !== 'INSERT')).toEqual([]);
  });

  it('C7 stays forbidden: a preliminary on an amending culture -> 409 micro.culture_invalid_transition; and the reopen cannot be used to skip C5 - the submit body never carries an amendment (S-05)', async () => {
    const w = mkWorld(); const s = setup(w, { amend: true }); await reopen(s, C.final);
    const before = structuredClone(w);
    expectCode(await failure(run('submitCultureReport', M14(C.final, { report_phase: 'preliminary', is_critical: false }), s.ctx)), 'micro.culture_invalid_transition', 409);
    expectInvalid(await failure(run('submitCultureReport', M14(C.final, FINAL({ amendment: { reasonCode: 'syn_forged' } })), s.ctx)));
    expect(w).toEqual(before); expect(submits(s)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ M18 cancelCulture
const SINCE_OPEN = [['awaiting_setup', C.awaiting], ['incubating', C.inc], ['growth_detected', C.growth]] as [string, string][];
describe('C10-T16 M18 cancelCulture: C9 awaiting_setup / incubating / growth_detected -> cancelled (AC-01.6 shape)', () => {
  it.each(SINCE_OPEN)('culture in %s without a submitted version -> cancelled with reason, comment, cancelled_at = now; version + 1; one transition row; CultureSummaryDto + ETag; C5 is not asked to submit anything', async (from, id) => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('cancelCulture', M18(id), s.ctx);
    expect(res.status).toBe(200);
    expect(row(w, 'cultures', id)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'entered_in_error', cancel_comment: 'Synthetic comment', version: VERSION + 1, updated_by: ACTOR_USER });
    expect(iso(row(w, 'cultures', id)['cancelled_at'])).toBe(NOW.toISOString());
    expect(transitionsOf(w, id)).toHaveLength(1);
    expect(transitionsOf(w, id)[0]).toMatchObject({ from_status: from, to_status: 'cancelled', reason_code: 'entered_in_error', tenant_id: A, centre_id: CENTRE_A1, created_by: ACTOR_USER });
    expect(res.body).toMatchObject({ id, status: 'cancelled', version: VERSION + 1 });
    expect(responseErrors('cancelCulture', res.body)).toEqual([]); expect(schemaErrors('CultureSummaryDto', res.body)).toEqual([]);
    expect(res.headers?.['etag']).toBe(`"${VERSION + 1}"`);
    expect(submits(s)).toHaveLength(0); expect(w['report_versions']!.some((v) => v['culture_id'] === id)).toBe(false);
  });

  it('the comment is optional; the same cancelled shape as the rejection consumer writes (status, cancel_reason_code, cancelled_at set together: cultures__cancel__ck) - AC-01.6', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('cancelCulture', M18(C.inc, { reason_code: 'not_processed' }), s.ctx);
    const c = row(w, 'cultures', C.inc);
    expect(c).toMatchObject({ status: 'cancelled', cancel_reason_code: 'not_processed' }); expect(c['cancel_comment'] ?? null).toBeNull(); expect(c['cancelled_at']).toBeTruthy();
  });

  it('C9 effect: the culture\'s OPEN instrument records (pending_match, needs_mapping, conflict) become pending_match with match_reason culture_cancelled; applied / ignored records, other cultures\' and other tenants\' records stay as they were', async () => {
    const w = mkWorld(); const s = setup(w); const untouchedIds = [R.applied, R.ignored, R.other, R.tenantB]; const before = structuredClone(untouchedIds.map((id) => row(w, 'instrument_records', id)));
    await run('cancelCulture', M18(C.awaiting), s.ctx);
    for (const id of [R.pending, R.needs, R.conflict]) expect(row(w, 'instrument_records', id), id).toMatchObject({ match_status: 'pending_match', match_reason: 'culture_cancelled', tenant_id: A });
    expect(untouchedIds.map((id) => row(w, 'instrument_records', id))).toEqual(before);
  });

  it.each([['final_submitted', C.final], ['amending', C.amend], ['cancelled', C.cancelled]])('culture in %s -> 409 micro.culture_invalid_transition, nothing written (a second cancel is refused too)', async (_s, id) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await untouched(s, before, run('cancelCulture', M18(id), s.ctx)), 'micro.culture_invalid_transition', 409);
  });

  it('a cancelled culture is read-only afterwards: reopen, a new observation and a submission are all refused; the instrument records keep their culture_cancelled reason', async () => {
    const w = mkWorld(); const s = setup(w); await run('cancelCulture', M18(C.awaiting), s.ctx); s.log.length = 0;
    const after = structuredClone(w);
    expectCode(await failure(run('reopenCulture', M17(C.awaiting, undefined, ifm(VERSION + 1)), s.ctx)), 'micro.culture_invalid_transition', 409);
    expectCode(await failure(run('recordCultureObservation', { params: { culture_id: C.awaiting }, headers: KEY, body: { kind: 'gram_stain', finding_text: 'Synthetic stain finding' } }, s.ctx)), 'micro.culture_invalid_transition', 409);
    expectCode(await failure(run('submitCultureReport', M14(C.awaiting, { report_phase: 'preliminary', is_critical: false }), s.ctx)), 'micro.culture_invalid_transition', 409);
    expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(after);
  });

  describe('a culture WITH a submitted version (preliminary): only a C5 line that is cancelled lets M18 through (TRD M18; 03-APP-FLOW C9)', () => {
    it.each([['C5 approved', C.prelimAppr], ['C5 resulted', C.prelimResulted]])('%s -> 409 micro.culture_invalid_transition, nothing written; C5 was asked via getOrderResults(all_visible)', async (_n, id) => {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectCode(await untouched(s, before, run('cancelCulture', M18(id), s.ctx)), 'micro.culture_invalid_transition', 409);
      expect(s.lab.calls('getOrderResults').length).toBeGreaterThanOrEqual(1);
      expect(s.lab.calls('getOrderResults')[0]!.input).toMatchObject({ orderId: ORDER, scope: 'all_visible' });
    });
    it('C5 line cancelled -> 200, culture cancelled, reason + transition recorded, submitted versions untouched', async () => {
      const w = mkWorld(); const s = setup(w); const v1 = structuredClone(versionsOf(w, C.prelimChainCancelled));
      const res = await run('cancelCulture', M18(C.prelimChainCancelled), s.ctx);
      expect(res.status).toBe(200); expect(row(w, 'cultures', C.prelimChainCancelled)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'entered_in_error', current_report_version_no: 1 });
      expect(transitionsOf(w, C.prelimChainCancelled)[0]).toMatchObject({ from_status: 'incubating', to_status: 'cancelled' });
      expect(versionsOf(w, C.prelimChainCancelled)).toEqual(v1); expect(submits(s)).toHaveLength(0);
    });
    it('the chain read fails (C5 error) -> the same error, nothing written (fail closed: never cancel a reported culture on a guess)', async () => {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w); s.lab.failNext('getOrderResults', 'common.not_found');
      const e = await untouched(s, before, run('cancelCulture', M18(C.prelimChainCancelled), s.ctx));
      expect(e.code).toBe('common.not_found');
    });
  });

  it.each([
    ['system code specimen_rejected', { reason_code: 'specimen_rejected' }],
    ['system code order_item_cancelled', { reason_code: 'order_item_cancelled' }],
    ['unknown code', { reason_code: 'syn_nonexistent' }],
    ['inactive code', { reason_code: 'syn_retired' }],
    ['upper-case code', { reason_code: 'ENTERED_IN_ERROR' }],
    ['one-character code', { reason_code: 'a' }],
    ['code of 65 chars', { reason_code: 'a'.repeat(65) }],
    ['SQL in the code', { reason_code: "entered_in_error'; DROP TABLE micro.cultures;--" }],
    ['code not a string', { reason_code: 12 }],
  ])('%s -> 400 common.validation_failed /reason_code, nothing written', async (_n, body) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await untouched(s, before, run('cancelCulture', M18(C.inc, body as Row), s.ctx)), '/reason_code');
  });

  it.each([
    ['no reason_code', { comment: 'Synthetic comment' }],
    ['empty body', {}],
    ['comment of 501 chars', { reason_code: 'entered_in_error', comment: 'x'.repeat(501) }],
    ['empty comment', { reason_code: 'entered_in_error', comment: '' }],
    ['comment not a string', { reason_code: 'entered_in_error', comment: 4 }],
    ['unknown field status (S-05)', { reason_code: 'entered_in_error', status: 'cancelled' }],
    ['unknown field tenant_id (S-05)', { reason_code: 'entered_in_error', tenant_id: B }],
    ['unknown field version', { reason_code: 'entered_in_error', version: 1 }],
    ['unknown field cancelled_at', { reason_code: 'entered_in_error', cancelled_at: PLANTED }],
    ['unknown field chain_cancelled', { reason_code: 'entered_in_error', chain_cancelled: true }],
  ])('%s -> 400 common.validation_failed, nothing written', async (_n, body) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await untouched(s, before, run('cancelCulture', M18(C.inc, body as Row), s.ctx)));
  });

  it('stale If-Match -> 409 common.version_conflict; missing If-Match -> 428 common.precondition_required; nothing written either way', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await untouched(s, before, run('cancelCulture', M18(C.inc, undefined, ifm(VERSION - 1)), s.ctx)), 'common.version_conflict', 409);
    expectCode(await untouched(s, before, run('cancelCulture', M18(C.inc, undefined, {}), s.ctx)), 'common.precondition_required', 428);
  });

  it('nothing the user typed is logged (TRD §11): the cancel comment stays out of every log call', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('cancelCulture', M18(C.inc, { reason_code: 'entered_in_error', comment: SECRET_COMMENT }), s.ctx);
    const w2 = mkWorld(); const s2 = setup(w2);
    await failure(run('cancelCulture', M18(C.final, { reason_code: 'entered_in_error', comment: SECRET_COMMENT }), s2.ctx));
    for (const x of [s, s2]) expect(JSON.stringify(x.logs)).not.toContain('SynLeakProbe');
  });
});
