// C10 T-09 — isolates: M7 createIsolate, M8 identifyIsolate, M9 describeIsolate, M10 withdrawIsolate WITHOUT a database
// (06-IMPLEMENTATION-PLAN row T-09 + 08 A17 P-22 counter; 02-TRD §5 M7–M10, §5.6 IsolateDto, §12 SQLSTATE mapping, §13 rules; 03-APP-FLOW §2.1 C3, §2.2 I1–I4;
// 05-SCHEMA §8 isolates + specimen_isolate_counters + isolates__final_lock; PRD AC-05.1–05.5; 07-SECURITY T-A1, T-A3, S-01, S-03, S-05, S-29).
// DB behaviour (real constraints, triggers, RLS centre scope, audit trail, 20 parallel creates on a real row lock) is in isolate.writes.integration.test.ts
// (live DB, gated like T-05/T-07/T-08 with LIMS_T09_REQUIRE_DB=1).
// SEAMS: handlers createIsolate / identifyIsolate / describeIsolate / withdrawIsolate in handlers/index.ts REAL map (any file layout; service/isolate.service.ts, repository/isolates.repo.ts per plan).
//   Permission: culture (M7) / isolate (M8–M10) loaded FIRST (RLS + explicit tenant filter), THEN ctx.ports.IdentityPort.assertRole(ctx, { permission: 'micro.culture.work', centreId: <its centre_id> }) (02-CV §10.1).
//   M7 takes the culture row FOR UPDATE and no If-Match (02-TRD §5 intro); M8/M9/M10 take If-Match `"<isolate version>"` (missing = 428 common.precondition_required, stale = 409 common.version_conflict).
//   Numbering: the ONLY statement allowed on micro.specimen_isolate_counters is the upsert of the plan row
//   `INSERT INTO micro.specimen_isolate_counters (tenant_id, specimen_id, ...) VALUES (...) ON CONFLICT (tenant_id, specimen_id) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq`; the fake
//   (helpers/isolateWrites.ts) applies it atomically and throws on any other statement, so SELECT max(isolate_seq) + 1 cannot pass. The counter is keyed by the culture's specimen_id (shared by every culture of that specimen).
//   Coded values: organisms through micro.v_organisms (tenant-over-global view), withdraw reasons through micro.v_isolate_withdraw_reasons. Unknown / inactive organism = 422 micro.organism_code_unknown (AC-05.2);
//   unknown / inactive withdraw reason = 400 common.validation_failed path /reason_code (M10 declares no organism error; same convention as T-05/T-08).
// ASSUMED (spec silent; flagged so a ruling can overrule): every response carries ETag "<isolate version>" (as T-08); M8 on an instrument-sourced isolate re-identifies as organism_source 'manual';
//   a counter at 99 (isolates__seq__ck / specimen_isolate_counters__seq__ck) is a clean 4xx refusal with nothing written; M9/M8/M10 on an isolate of a cancelled culture = 409 micro.culture_invalid_transition (03-APP-FLOW "Forbidden");
//   M7 on an awaiting_setup culture = 409 micro.culture_invalid_transition (I1); the culture row is read FOR UPDATE by M7.
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { failure, mkCtx, READ, responseErrors, run, schemaErrors, specOps, WORK, type Row } from './helpers/cultureReads.js';
import { iso, isolateTx, NOW, writesOf, type World } from './helpers/isolateWrites.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const u = (n: number) => `0190c608-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE_A1 = u(0xa1), CENTRE_B1 = u(0xb1);
const ACTOR_USER = '01a1b34e-1000-7eee-9d29-d7ca59a10001', ACTOR_M = '01a1a98a-ac40-7000-8000-00000000a500';
const ORDER = u(0x801), ITEM = u(0x802), TEST1 = u(0x701);
const S = { one: u(0x901), growth: u(0x902), awaiting: u(0x903), final: u(0x904), cancelled: u(0x905), amend: u(0x906), b: u(0x907), conc: u(0x908), full: u(0x909), fresh: u(0x90a) };
const C = { inc: u(0x1001), inc2: u(0x1002), growth: u(0x1003), awaiting: u(0x1004), final: u(0x1005), cancelled: u(0x1006), amend: u(0x1007), b: u(0x1008), conc: u(0x1009), full: u(0x100a), fresh: u(0x100b), missing: u(0x10ff) };
const PL = { inc: u(0x2001), inc2: u(0x2002), b: u(0x2003), growth: u(0x2004), amend: u(0x2005) };
const I = { a1: u(0x3001), a2: u(0x3002), growth: u(0x3003), final: u(0x3004), wd: u(0x3005), amend: u(0x3006), canc: u(0x3007), b: u(0x3008), inst: u(0x3009), conc: u(0x300a) };
const AST = { a1: u(0x4001), a1b: u(0x4002) };
const PLANTED = '2026-11-04T05:00:00.000Z';
const NOW_ISO = NOW.toISOString();
const ECOLI = 'syn_ecoli', STAPH = 'syn_staph', OLD_ORG = 'syn_org_old', UNKNOWN_ORG = 'syn_org_nope';

// ------------------------------------------------------------------ world
const culture = (id: string, status: string, specimen: string, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE_A1, order_id: ORDER, order_item_id: ITEM, specimen_id: specimen, patient_id: u(0xa00), test_id: TEST1, specimen_type_code: 'urine',
  specimen_site_code: null, barcode_snapshot: null, plating_protocol_id: null, status, outcome_code: null, received_at: new Date('2026-11-04T04:00:00.000Z'),
  planted_at: status === 'awaiting_setup' ? null : new Date(PLANTED), next_read_due_at: null, final_due_at: null, last_specimen_seq: 1, current_report_version_no: 0, last_report_phase: null, chain_cancelled: false,
  amendment_reason_code: null, amendment_reason_text: null, cancel_reason_code: null, cancel_comment: null, cancelled_at: null,
  version: 5, is_active: true, created_at: new Date('2026-11-04T04:00:00.000Z'), created_by: ACTOR_USER, updated_at: new Date('2026-11-04T04:00:00.000Z'), updated_by: ACTOR_USER, ...over,
});
const plate = (id: string, cultureId: string, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE_A1, culture_id: cultureId, plate_no: 1, media_code: 'syn_blood', incubation_text: null, parent_plate_id: null, source_isolate_id: null,
  planted_at: new Date(PLANTED), planted_by_membership_id: ACTOR_M, status: 'active', discarded_at: null, version: 2, is_active: true, created_at: new Date(PLANTED), created_by: ACTOR_USER, updated_at: new Date(PLANTED), updated_by: ACTOR_USER, ...over,
});
const isolate = (id: string, cultureId: string, specimen: string, seq: number, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE_A1, culture_id: cultureId, specimen_id: specimen, isolate_seq: seq, plate_id: null, status: 'pending_id',
  organism_code: null, organism_source: null, identified_at: null, identified_by_membership_id: null, colony_description: 'Synthetic colony', quantity_text: 'Synthetic few',
  is_reportable: true, withdraw_reason_code: null, withdraw_comment: null, ast_panel_id: null, ast_method: null, version: 2, is_active: true,
  created_at: new Date(PLANTED), created_by: ACTOR_USER, updated_at: new Date(PLANTED), updated_by: ACTOR_USER, ...over,
});
const identified = (id: string, cultureId: string, specimen: string, seq: number, over: Row = {}): Row =>
  isolate(id, cultureId, specimen, seq, { status: 'identified', organism_code: ECOLI, organism_source: 'manual', identified_at: new Date('2026-11-04T09:00:00.000Z'), identified_by_membership_id: ACTOR_M, version: 3, ...over });
const counter = (specimen: string, last: number, tenant = A): Row => ({ tenant_id: tenant, specimen_id: specimen, last_seq: last, created_by: ACTOR_USER, updated_by: ACTOR_USER });
const ast = (id: string, isolateId: string): Row => ({ id, tenant_id: A, centre_id: CENTRE_A1, culture_id: C.inc, isolate_id: isolateId, antibiotic_code: 'syn_amp', method: 'mic', raw_value: '2', category_code: 'S', standard: 'CLSI', standard_version: '2026', suggestion_overridden: false, source: 'manual', off_panel: false, version: 1, is_reportable: true, report_visibility: 'shown' });

function mkWorld(): World {
  return {
    cultures: [culture(C.inc, 'incubating', S.one), culture(C.inc2, 'incubating', S.one), culture(C.growth, 'growth_detected', S.growth), culture(C.awaiting, 'awaiting_setup', S.awaiting),
      culture(C.final, 'final_submitted', S.final, { outcome_code: 'syn_positive', current_report_version_no: 1 }), culture(C.cancelled, 'cancelled', S.cancelled, { cancel_reason_code: 'syn_reason', cancelled_at: new Date(PLANTED) }),
      culture(C.amend, 'amending', S.amend, { outcome_code: 'syn_positive', amendment_reason_code: 'syn_fix' }), culture(C.b, 'incubating', S.b, { tenant_id: B, centre_id: CENTRE_B1 }),
      culture(C.conc, 'incubating', S.conc), culture(C.full, 'incubating', S.full), culture(C.fresh, 'incubating', S.fresh)],
    culture_plates: [plate(PL.inc, C.inc), plate(PL.inc2, C.inc2), plate(PL.b, C.b, { tenant_id: B, centre_id: CENTRE_B1 }), plate(PL.growth, C.growth), plate(PL.amend, C.amend)],
    isolates: [
      identified(I.a1, C.inc, S.one, 1), isolate(I.a2, C.inc2, S.one, 2), isolate(I.growth, C.growth, S.growth, 1, { version: 1 }), identified(I.final, C.final, S.final, 1, { version: 4 }),
      isolate(I.wd, C.amend, S.amend, 1, { status: 'withdrawn', withdraw_reason_code: 'duplicate', version: 4 }), identified(I.amend, C.amend, S.amend, 2, { organism_code: STAPH }),
      isolate(I.canc, C.cancelled, S.cancelled, 1), isolate(I.b, C.b, S.b, 1, { tenant_id: B, centre_id: CENTRE_B1 }),
      identified(I.inst, C.growth, S.growth, 2, { organism_source: 'instrument', organism_code: STAPH }),
    ],
    specimen_isolate_counters: [counter(S.one, 2), counter(S.growth, 2), counter(S.final, 1), counter(S.cancelled, 1), counter(S.amend, 2), counter(S.b, 1, B), counter(S.full, 99)],   // S.conc / S.fresh / S.awaiting: no row (lazy)
    ast_results: [ast(AST.a1, I.a1), ast(AST.a1b, I.a1)],
    culture_transitions: [], culture_observations: [], instrument_records: [], report_versions: [], settings: [],
    v_organisms: [{ code: ECOLI, display: 'Synthetic E. coli', group_code: 'syn_gnr', is_active: true }, { code: STAPH, display: 'Synthetic S. aureus', group_code: 'syn_gpc', is_active: true }, { code: OLD_ORG, display: 'Retired', group_code: null, is_active: false }],
    v_isolate_withdraw_reasons: [{ code: 'contaminant', display: 'Contaminant', is_active: true }, { code: 'duplicate', display: 'Duplicate', is_active: true }, { code: 'syn_reason_old', display: 'Retired', is_active: false }],
    v_media: [], v_growth_codes: [], v_specimen_sites: [], v_antibiotics: [],
  };
}
const row = (w: World, table: string, id: string): Row => w[table]!.find((r) => r['id'] === id)!;
const isolatesOf = (w: World, cultureId: string) => w['isolates']!.filter((r) => r['culture_id'] === cultureId).sort((a, b) => a['isolate_seq'] - b['isolate_seq']);
const countOf = (w: World, specimen: string, tenant = A) => w['specimen_isolate_counters']!.find((r) => r['specimen_id'] === specimen && r['tenant_id'] === tenant)?.['last_seq'];
const transitionsOf = (w: World, cultureId: string) => w['culture_transitions']!.filter((t) => t['culture_id'] === cultureId);

function setup(w: World, grants: readonly string[] = [WORK]) {
  const { tx, log } = isolateTx(w);
  const { ctx, calls } = mkCtx({ tenantId: A, tx, grants, members: { [ACTOR_M]: 'Synthetic Actor Tech' }, users: { [ACTOR_USER]: 'Synthetic Actor User' }, tests: { [TEST1]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } } });
  const published: unknown[] = []; const logs: unknown[] = [];
  ctx.events = { publish: async (...a: unknown[]) => { published.push(a); return { eventId: 'e', duplicate: false }; } };
  const sink = (...a: unknown[]) => { logs.push(a); };
  ctx.log = { info: sink, warn: sink, error: sink, debug: sink, child() { return this; } };
  return { ctx, calls, log, published, logs, w };
}
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const KEY = { 'idempotency-key': 'syn-key-1' };
const M7 = (cultureId: string, body: Row = {}, headers: Row = {}) => ({ params: { culture_id: cultureId }, headers: { ...KEY, ...headers }, body });
const M8 = (isolateId: string, body: Row, headers: Row) => ({ params: { isolate_id: isolateId }, headers, body });
const M9 = (isolateId: string, body: Row, headers: Row) => ({ params: { isolate_id: isolateId }, headers, body });
const M10 = (isolateId: string, body: Row, headers: Row) => ({ params: { isolate_id: isolateId }, headers, body });
const identify = (id: string, v: number, body: Row = { organism_code: STAPH }) => M8(id, body, ifm(v));
const describe_ = (id: string, v: number, body: Row = { is_reportable: true }) => M9(id, body, ifm(v));
const withdraw = (id: string, v: number, body: Row = { reason_code: 'contaminant' }) => M10(id, body, ifm(v));

const expectCode = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(status); };
const expectInvalid = (e: any, path?: string) => { expectCode(e, 'common.validation_failed', 400); if (path !== undefined) expect(e.errors?.map((x: any) => x.path), JSON.stringify(e.errors)).toContain(path); };

// ------------------------------------------------------------------ contract pins
describe('C10-T09 contract pins (micro.yaml)', () => {
  const OPS = {
    createIsolate: { idem: 'required', ifMatch: false, errors: ['micro.organism_code_unknown', 'micro.report_final_locked', 'micro.culture_invalid_transition'] },
    identifyIsolate: { idem: 'optional', ifMatch: true, errors: ['micro.organism_code_unknown', 'micro.isolate_invalid_transition', 'micro.report_final_locked', 'common.version_conflict', 'common.precondition_required'] },
    describeIsolate: { idem: 'optional', ifMatch: true, errors: ['micro.isolate_invalid_transition', 'micro.report_final_locked', 'common.version_conflict', 'common.precondition_required'] },
    withdrawIsolate: { idem: 'optional', ifMatch: true, errors: ['micro.isolate_invalid_transition', 'micro.report_final_locked', 'common.version_conflict', 'common.precondition_required'] },
  } as const;
  it.each(Object.entries(OPS))('%s: x-permission micro.culture.work only, idempotency %s, If-Match as TRD §5 says, declared errors, strict body, IsolateDto answer', (id, o) => {
    const op = specOps()[id];
    expect(op['x-permission']).toBe(WORK);
    expect(Object.keys(op).filter((k) => k === 'x-permissions')).toEqual([]);
    expect(op['x-idempotency']).toBe(o.idem);
    expect(op.parameters.some((p: any) => String(p.$ref ?? '').endsWith('/IfMatch'))).toBe(o.ifMatch);
    for (const c of ['common.not_found', 'common.validation_failed', ...o.errors]) expect(op['x-error-codes'], c).toContain(c);
    expect(op.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
    expect(op.responses['200'].content['application/json'].schema.$ref).toMatch(/IsolateDto$/);
  });
  it('M7 body = plate_id, colony_description 1..500, quantity_text 1..80, organism_code only (no isolate_seq / status / organism_source: S-05); M8 organism_code required; M9 is_reportable required; M10 reason_code required + comment <= 500', () => {
    const ops = specOps(); const body = (id: string) => ops[id].requestBody.content['application/json'].schema;
    const b7 = body('createIsolate');
    expect(Object.keys(b7.properties).sort()).toEqual(['colony_description', 'organism_code', 'plate_id', 'quantity_text']);
    expect(b7.required ?? []).toEqual([]);
    expect([b7.properties.colony_description.minLength, b7.properties.colony_description.maxLength, b7.properties.quantity_text.minLength, b7.properties.quantity_text.maxLength]).toEqual([1, 500, 1, 80]);
    expect(body('identifyIsolate').required).toEqual(['organism_code']);
    expect(body('describeIsolate').required).toEqual(['is_reportable']);
    expect(Object.keys(body('describeIsolate').properties).sort()).toEqual(['colony_description', 'is_reportable', 'plate_id', 'quantity_text']);
    expect(body('withdrawIsolate').required).toEqual(['reason_code']);
    expect(body('withdrawIsolate').properties.comment.maxLength).toBe(500);
  });
});

// ------------------------------------------------------------------ permission: object first, then micro.culture.work with the object's centre
const WRITES: [string, (w: World) => Row][] = [
  ['createIsolate', () => M7(C.inc, {})],
  ['identifyIsolate', () => identify(I.a2, 2)],
  ['describeIsolate', () => describe_(I.a2, 2)],
  ['withdrawIsolate', () => withdraw(I.a2, 2)],
];
describe('C10-T09 permissions (D-64): micro.culture.work is the only grant that writes; object loaded first (02-CV §10.1)', () => {
  it.each(WRITES)('%s without the grant (read-only / config-only user) -> 403 auth.forbidden, asked for micro.culture.work with the object\'s centre_id AFTER the object was read; no write, no counter bump', async (op, req) => {
    for (const grants of [[READ], ['micro.config.manage'], []]) {
      const w = mkWorld(); const before = structuredClone(w);
      const s = setup(w, grants);
      const e = await failure(run(op, req(w), s.ctx));
      expectCode(e, 'auth.forbidden', 403);
      expect(s.calls.assertRole.at(-1), JSON.stringify(grants)).toEqual({ permission: WORK, centreId: CENTRE_A1 });
      expect(s.log.length).toBeGreaterThan(0);
      expect(writesOf(s.log)).toEqual([]);
      expect(w).toEqual(before);
      expect(s.calls.access).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------ BOLA / id mismatch (T-A1, T-A3, S-01, S-03)
describe('C10-T09 BOLA: another tenant\'s culture / isolate = 404 identical to a missing one; no write, no counter bump (S-01)', () => {
  const swap = (op: string, r: Row, id: string): Row => (op === 'createIsolate' ? { ...r, params: { culture_id: id } } : { ...r, params: { isolate_id: id } });
  it.each(WRITES)('%s on an object of tenant B and on a random id: same 404 common.not_found; nothing written', async (op, req) => {
    const w1 = mkWorld(); const w2 = mkWorld(); const before = structuredClone(w1);
    const foreign = setup(w1); const missing = setup(w2);
    const e1 = await failure(run(op, swap(op, req(w1), op === 'createIsolate' ? C.b : I.b), foreign.ctx));
    const e2 = await failure(run(op, swap(op, req(w2), op === 'createIsolate' ? C.missing : u(0x30ff)), missing.ctx));
    for (const e of [e1, e2]) expectCode(e, 'common.not_found', 404);
    expect({ code: e1.code, message: e1.message }).toEqual({ code: e2.code, message: e2.message });
    expect(writesOf(foreign.log)).toEqual([]);
    expect(w1).toEqual(before);
    expect(foreign.calls.assertRole).toEqual([]);                           // nothing to decide on: no existence oracle through 403
  });

  it.each([
    ['M7 plate_id', () => M7(C.inc, { plate_id: PL.b })],
    ['M9 plate_id', () => describe_(I.a1, 3, { is_reportable: true, plate_id: PL.b })],
  ] as [string, () => Row][])('a tenant-B plate in %s -> 404 common.not_found, nothing written in either tenant (S-01)', async (_n, req) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    const op = _n.startsWith('M7') ? 'createIsolate' : 'describeIsolate';
    expectCode(await failure(run(op, req(), s.ctx)), 'common.not_found', 404);
    expect(writesOf(s.log)).toEqual([]);
    expect(w).toEqual(before);
  });

  it.each([
    ['M7 plate_id', 'createIsolate', () => M7(C.inc, { plate_id: PL.inc2 })],
    ['M9 plate_id', 'describeIsolate', () => describe_(I.a1, 3, { is_reportable: true, plate_id: PL.inc2 })],
  ] as [string, string, () => Row][])('a same-tenant plate of ANOTHER culture in %s -> 400 common.id_mismatch, nothing written, counter unchanged (S-03, TRD §13)', async (_n, op, req) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run(op, req(), s.ctx)), 'common.id_mismatch', 400);
    expect(writesOf(s.log)).toEqual([]);
    expect(w).toEqual(before);
  });
});

// ------------------------------------------------------------------ M7 createIsolate
describe('C10-T09 M7 createIsolate: AC-05.1 per-specimen numbering and C3 growth_detected', () => {
  it('culture of specimen S whose isolates 1 and 2 exist (one on ANOTHER culture of S) -> new isolate_seq = 3, counter row 3, pending_id, culture incubating -> growth_detected with one transition row; IsolateDto + ETag', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('createIsolate', M7(C.inc, { colony_description: 'Synthetic colony text', quantity_text: 'Synthetic moderate', plate_id: PL.inc }), s.ctx);
    expect(res.status).toBe(200);
    const made = isolatesOf(w, C.inc).find((r) => r['isolate_seq'] === 3)!;
    expect(made).toMatchObject({ tenant_id: A, centre_id: CENTRE_A1, culture_id: C.inc, specimen_id: S.one, isolate_seq: 3, plate_id: PL.inc, status: 'pending_id', colony_description: 'Synthetic colony text', quantity_text: 'Synthetic moderate',
      is_reportable: true, version: 1, created_by: ACTOR_USER, updated_by: ACTOR_USER });
    expect(made['organism_code'] ?? null).toBeNull();
    expect(made['organism_source'] ?? null).toBeNull();
    expect(countOf(w, S.one)).toBe(3);
    expect(row(w, 'cultures', C.inc)).toMatchObject({ status: 'growth_detected', updated_by: ACTOR_USER });
    expect(transitionsOf(w, C.inc)).toHaveLength(1);
    expect(transitionsOf(w, C.inc)[0]).toMatchObject({ from_status: 'incubating', to_status: 'growth_detected', centre_id: CENTRE_A1, tenant_id: A, created_by: ACTOR_USER });
    expect(res.body).toMatchObject({ id: made['id'], isolate_seq: 3, status: 'pending_id', version: 1, is_reportable: true, colony_description: 'Synthetic colony text', quantity_text: 'Synthetic moderate', ast: [] });
    expect(res.body['organism_code']).toBeUndefined();
    expect(responseErrors('createIsolate', res.body)).toEqual([]);
    expect(res.headers?.['etag']).toBe('"1"');
    expect(s.calls.assertRole.at(-1)).toEqual({ permission: WORK, centreId: CENTRE_A1 });
    expect(s.calls.access).toEqual([]);                                     // TRD §13: only M2 writes an access_log row; isolates are audited by the DB trigger
    expect(s.published).toEqual([]);
  });

  it('numbering is ONE counter upsert per create on micro.specimen_isolate_counters (never SELECT max + 1) and the culture row is read FOR UPDATE first (TRD §5, 08 A17 P-22)', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('createIsolate', M7(C.inc, {}), s.ctx);
    const counterOps = s.log.filter((l) => l.table === 'specimen_isolate_counters');
    expect(counterOps).toHaveLength(1);
    expect(counterOps[0]!.op).toBe('INSERT');
    expect(counterOps[0]!.sql).toMatch(/ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*specimen_id\s*\)\s*DO\s+UPDATE/i);
    expect(s.log.some((l) => l.table === 'isolates' && /max\s*\(/i.test(l.sql))).toBe(false);
    const lock = s.log.findIndex((l) => l.table === 'cultures' && /FOR\s+UPDATE/i.test(l.sql));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(s.log.indexOf(counterOps[0]!));
  });

  it('counter row is created lazily: a specimen without one gets isolate 1 and a counter row (tenant, specimen, last_seq 1); the culture is S.fresh\'s only culture', async () => {
    const w = mkWorld(); const s = setup(w);
    expect(countOf(w, S.fresh)).toBeUndefined();
    const res = await run('createIsolate', M7(C.fresh, {}), s.ctx);
    expect(res.body.isolate_seq).toBe(1);
    expect(countOf(w, S.fresh)).toBe(1);
    expect(w['specimen_isolate_counters']!.filter((r) => r['specimen_id'] === S.fresh)).toHaveLength(1);
    expect(w['specimen_isolate_counters']!.find((r) => r['specimen_id'] === S.fresh)).toMatchObject({ tenant_id: A, created_by: ACTOR_USER, updated_by: ACTOR_USER });
  });

  it('with an active organism_code the isolate is created identified (source manual, identified_at = now, identified_by = caller) and organism_display is answered; AC-05.5 the same organism twice gives two isolates', async () => {
    const w = mkWorld(); const s = setup(w);
    const r1 = await run('createIsolate', M7(C.growth, { organism_code: ECOLI }), s.ctx);
    const r2 = await run('createIsolate', M7(C.growth, { organism_code: ECOLI }), s.ctx);
    expect([r1.body.isolate_seq, r2.body.isolate_seq]).toEqual([3, 4]);                      // S.growth counter = 2
    for (const r of [r1, r2]) {
      expect(r.body).toMatchObject({ status: 'identified', organism_code: ECOLI, organism_display: 'Synthetic E. coli', organism_source: 'manual', is_reportable: true });
      expect(responseErrors('createIsolate', r.body)).toEqual([]);
      const stored = row(w, 'isolates', r.body.id);
      expect(stored).toMatchObject({ status: 'identified', organism_code: ECOLI, organism_source: 'manual', identified_by_membership_id: ACTOR_M });
      expect(iso(stored['identified_at'])).toBe(NOW_ISO);
    }
    expect(isolatesOf(w, C.growth).filter((r) => r['organism_code'] === ECOLI && r['id'] !== I.inst)).toHaveLength(2);
    expect(row(w, 'cultures', C.growth)['status']).toBe('growth_detected');
    expect(transitionsOf(w, C.growth)).toEqual([]);                                          // already growth_detected: no new transition row
  });

  it('an amending culture accepts an isolate (I1) and stays amending', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('createIsolate', M7(C.amend, {}), s.ctx);
    expect(res.body.isolate_seq).toBe(3);                                                    // S.amend counter = 2
    expect(row(w, 'cultures', C.amend)['status']).toBe('amending');
    expect(transitionsOf(w, C.amend)).toEqual([]);
  });

  it('numbers are never reused: withdrawing isolate 2 and creating again gives 3, never 2 (the counter only grows)', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('withdrawIsolate', withdraw(I.a2, 2), s.ctx);
    const res = await run('createIsolate', M7(C.inc, {}), s.ctx);
    expect(res.body.isolate_seq).toBe(3);
    expect(countOf(w, S.one)).toBe(3);
  });

  it('given an unknown or inactive organism_code -> 422 micro.organism_code_unknown; no isolate, no counter bump, culture untouched (AC-05.2)', async () => {
    for (const code of [UNKNOWN_ORG, OLD_ORG]) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectCode(await failure(run('createIsolate', M7(C.inc, { organism_code: code }), s.ctx)), 'micro.organism_code_unknown', 422);
      expect(w, code).toEqual(before);
    }
  });

  it.each([
    ['awaiting_setup (no plates yet, I1)', C.awaiting, 'micro.culture_invalid_transition', 409],
    ['cancelled', C.cancelled, 'micro.culture_invalid_transition', 409],
    ['final_submitted (isolates__final_lock)', C.final, 'micro.report_final_locked', 409],
  ] as [string, string, string, number][])('culture %s -> %s %i; nothing written, counter unchanged', async (_s, id, code, status) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('createIsolate', M7(id, {}), s.ctx)), code, status);
    expect(w).toEqual(before);
  });

  it('S-05 strict schema: isolate_seq, status, organism_source, tenant_id, centre_id, version in the body -> 400 common.validation_failed; nothing written', async () => {
    for (const extra of [{ isolate_seq: 9 }, { status: 'identified' }, { organism_source: 'instrument' }, { tenant_id: B }, { centre_id: CENTRE_B1 }, { version: 7 }, { specimen_id: S.b }, { is_reportable: false }]) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectInvalid(await failure(run('createIsolate', M7(C.inc, extra), s.ctx)));
      expect(w, JSON.stringify(extra)).toEqual(before);
    }
  });

  it('text limits and empties: colony_description 500 passes / 501 fails (400 /colony_description), quantity_text 80 passes / 81 fails (400 /quantity_text), empty string fails; a bad organism_code shape is 400', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('createIsolate', M7(C.inc, { colony_description: 'x'.repeat(500), quantity_text: 'y'.repeat(80) }), s.ctx);
    for (const [body, path] of [[{ colony_description: 'x'.repeat(501) }, '/colony_description'], [{ quantity_text: 'y'.repeat(81) }, '/quantity_text'], [{ colony_description: '' }, '/colony_description'],
      [{ quantity_text: '' }, '/quantity_text'], [{ organism_code: 'Bad Code' }, '/organism_code'], [{ plate_id: 'not-a-uuid' }, '/plate_id']] as [Row, string][]) {
      const w2 = mkWorld(); const before = structuredClone(w2); const s2 = setup(w2);
      expectInvalid(await failure(run('createIsolate', M7(C.inc, body), s2.ctx)), path);
      expect(w2).toEqual(before);
    }
  });

  it('a specimen whose counter is at 99 cannot take another isolate: clean 4xx refusal (ASSUMED code), nothing written', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    const e = await failure(run('createIsolate', M7(C.full, {}), s.ctx));
    expect(e?.statusCode, `${e?.code ?? e}`).toBeGreaterThanOrEqual(400);
    expect(e?.statusCode).toBeLessThan(500);
    expect(w).toEqual(before);
  });
});

describe('C10-T09 M7 concurrency (done_when): 20 parallel creates -> 1..20 unique (08 A17 P-22)', () => {
  it('20 parallel createIsolate on a culture whose specimen has no counter row -> isolate_seq 1..20 each exactly once, counter 20, 20 isolate rows, every response valid', async () => {
    const w = mkWorld();
    const results = await Promise.all(Array.from({ length: 20 }, () => { const s = setup(w); return run('createIsolate', M7(C.conc, { colony_description: 'Synthetic parallel' }), s.ctx); }));
    expect(results.map((r) => r.body.isolate_seq).sort((a: number, b: number) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(isolatesOf(w, C.conc).map((r) => r['isolate_seq'])).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(20);
    expect(countOf(w, S.conc)).toBe(20);
    for (const r of results) expect(responseErrors('createIsolate', r.body)).toEqual([]);
    expect(row(w, 'cultures', C.conc)['status']).toBe('growth_detected');
  });

  it('parallel creates on TWO cultures of the same specimen share the counter: 10 + 10 on counter 2 -> 3..22, no duplicate, no gap', async () => {
    const w = mkWorld();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => { const s = setup(w); return run('createIsolate', M7(i % 2 ? C.inc : C.inc2, {}), s.ctx); }));
    expect(results.map((r) => r.body.isolate_seq).sort((a: number, b: number) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 3));
    expect(countOf(w, S.one)).toBe(22);
    expect(w['isolates']!.filter((r) => r['specimen_id'] === S.one).map((r) => r['isolate_seq']).sort((a, b) => a - b)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
  });

  it('a failing create (unknown organism) in the middle of a parallel batch leaves no gap that later creates must skip: the successful ones are still unique', async () => {
    const w = mkWorld();
    const reqs = Array.from({ length: 10 }, (_, i) => (i === 4 ? M7(C.conc, { organism_code: UNKNOWN_ORG }) : M7(C.conc, {})));
    const out = await Promise.allSettled(reqs.map((r) => run('createIsolate', r, setup(w).ctx)));
    expect(out.filter((o) => o.status === 'rejected')).toHaveLength(1);
    const seqs = out.filter((o): o is PromiseFulfilledResult<any> => o.status === 'fulfilled').map((o) => o.value.body.isolate_seq);
    expect(new Set(seqs).size).toBe(9);
    expect(isolatesOf(w, C.conc)).toHaveLength(9);
  });
});

// ------------------------------------------------------------------ M8 identifyIsolate
describe('C10-T09 M8 identifyIsolate: AC-05.2 identify, AC-05.3 re-identify (I2, I3)', () => {
  it('pending_id + active organism_code -> identified, organism_source manual, identified_at = now, identified_by = caller, version + 1; IsolateDto with organism_display + ETag; AST rows untouched', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('identifyIsolate', identify(I.a2, 2, { organism_code: STAPH }), s.ctx);
    expect(res.status).toBe(200);
    const r = row(w, 'isolates', I.a2);
    expect(r).toMatchObject({ status: 'identified', organism_code: STAPH, organism_source: 'manual', identified_by_membership_id: ACTOR_M, version: 3, updated_by: ACTOR_USER, isolate_seq: 2, culture_id: C.inc2, centre_id: CENTRE_A1 });
    expect(iso(r['identified_at'])).toBe(NOW_ISO);
    expect(res.body).toMatchObject({ id: I.a2, status: 'identified', organism_code: STAPH, organism_display: 'Synthetic S. aureus', organism_source: 'manual', version: 3, isolate_seq: 2 });
    expect(responseErrors('identifyIsolate', res.body)).toEqual([]);
    expect(res.headers?.['etag']).toBe('"3"');
    expect(s.calls.assertRole.at(-1)).toEqual({ permission: WORK, centreId: CENTRE_A1 });
    expect(writesOf(s.log).filter((l) => l.table !== 'isolates')).toEqual([]);              // only the isolate row changes: no culture, no counter, no AST write
    expect(countOf(w, S.one)).toBe(2);
  });

  it('unknown or inactive organism_code -> 422 micro.organism_code_unknown; the isolate stays pending_id and unchanged (AC-05.2)', async () => {
    for (const code of [UNKNOWN_ORG, OLD_ORG]) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectCode(await failure(run('identifyIsolate', identify(I.a2, 2, { organism_code: code }), s.ctx)), 'micro.organism_code_unknown', 422);
      expect(w, code).toEqual(before);
    }
  });

  it('AC-05.3 re-identify an identified isolate before final -> the organism changes, status stays identified, version + 1, the isolate_seq / culture / AST rows are unchanged (the audit old/new is the DB trigger: live file)', async () => {
    const w = mkWorld(); const s = setup(w);
    expect(row(w, 'isolates', I.a1)['organism_code']).toBe(ECOLI);
    const res = await run('identifyIsolate', identify(I.a1, 3, { organism_code: STAPH }), s.ctx);
    expect(row(w, 'isolates', I.a1)).toMatchObject({ status: 'identified', organism_code: STAPH, organism_source: 'manual', version: 4, isolate_seq: 1 });
    expect(res.body).toMatchObject({ organism_code: STAPH, organism_display: 'Synthetic S. aureus', status: 'identified' });
    expect(row(w, 'ast_results', AST.a1)).toMatchObject({ raw_value: '2', category_code: 'S', version: 1 });
    expect(row(w, 'ast_results', AST.a1b)).toMatchObject({ version: 1 });
    expect(writesOf(s.log).map((l) => l.table)).toEqual(['isolates']);
  });

  it('an instrument-sourced identification re-identified by hand becomes organism_source manual (ASSUMED)', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('identifyIsolate', identify(I.inst, 3, { organism_code: ECOLI }), s.ctx);
    expect(row(w, 'isolates', I.inst)).toMatchObject({ organism_code: ECOLI, organism_source: 'manual' });
  });

  it('an amending culture lets the isolate be re-identified (I3 "culture editable")', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('identifyIsolate', identify(I.amend, 3, { organism_code: ECOLI }), s.ctx);
    expect(row(w, 'isolates', I.amend)['organism_code']).toBe(ECOLI);
  });

  it.each([
    ['withdrawn isolate (terminal)', I.wd, 4, 'micro.isolate_invalid_transition'],
    ['isolate of a final_submitted culture', I.final, 4, 'micro.report_final_locked'],
    ['isolate of a cancelled culture', I.canc, 2, 'micro.culture_invalid_transition'],
  ])('%s -> 409 (own error code), nothing written', async (_n, id, v, code) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('identifyIsolate', identify(id, v), s.ctx)), code, 409);
    expect(w).toEqual(before);
  });

  it('stale If-Match -> 409 common.version_conflict, nothing changes; missing If-Match -> 428 common.precondition_required; a second identify with the old version after a success is refused', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('identifyIsolate', identify(I.a2, 1), s.ctx)), 'common.version_conflict', 409);
    expectCode(await failure(run('identifyIsolate', M8(I.a2, { organism_code: STAPH }, {}), s.ctx)), 'common.precondition_required', 428);
    expect(w).toEqual(before);
    await run('identifyIsolate', identify(I.a2, 2), s.ctx);
    expectCode(await failure(run('identifyIsolate', identify(I.a2, 2, { organism_code: ECOLI }), s.ctx)), 'common.version_conflict', 409);
    expect(row(w, 'isolates', I.a2)['organism_code']).toBe(STAPH);
  });

  it('strict body: missing organism_code -> 400 /organism_code; unknown fields (status, organism_source, isolate_seq, tenant_id) and a malformed code -> 400; nothing written', async () => {
    for (const [body, path] of [[{}, '/organism_code'], [{ organism_code: 'Bad Code' }, '/organism_code'], [{ organism_code: STAPH, status: 'identified' }, undefined], [{ organism_code: STAPH, organism_source: 'instrument' }, undefined],
      [{ organism_code: STAPH, isolate_seq: 5 }, undefined], [{ organism_code: STAPH, tenant_id: B }, undefined]] as [Row, string | undefined][]) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectInvalid(await failure(run('identifyIsolate', identify(I.a2, 2, body), s.ctx)), path);
      expect(w, JSON.stringify(body)).toEqual(before);
    }
  });
});

// ------------------------------------------------------------------ M9 describeIsolate
describe('C10-T09 M9 describeIsolate: full replace of colony_description / quantity_text / is_reportable / plate_id', () => {
  it('replaces the fields; an omitted optional field is CLEARED; status, organism and seq are untouched; version + 1; ETag', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('describeIsolate', describe_(I.a1, 3, { colony_description: 'Synthetic new colony', is_reportable: false, plate_id: PL.inc }), s.ctx);
    expect(row(w, 'isolates', I.a1)).toMatchObject({ colony_description: 'Synthetic new colony', is_reportable: false, plate_id: PL.inc, version: 4, status: 'identified', organism_code: ECOLI, isolate_seq: 1, updated_by: ACTOR_USER });
    expect(row(w, 'isolates', I.a1)['quantity_text'] ?? null).toBeNull();                      // quantity_text was 'Synthetic few', omitted -> cleared
    expect(res.body).toMatchObject({ id: I.a1, version: 4, is_reportable: false, colony_description: 'Synthetic new colony' });
    expect(res.body['quantity_text']).toBeUndefined();
    expect(responseErrors('describeIsolate', res.body)).toEqual([]);
    expect(res.headers?.['etag']).toBe('"4"');
    const res2 = await run('describeIsolate', describe_(I.a1, 4, { is_reportable: true }), s.ctx);
    expect(row(w, 'isolates', I.a1)).toMatchObject({ is_reportable: true, version: 5 });
    expect(row(w, 'isolates', I.a1)['colony_description'] ?? null).toBeNull();
    expect(row(w, 'isolates', I.a1)['plate_id'] ?? null).toBeNull();
    expect(res2.body['colony_description']).toBeUndefined();
    expect(writesOf(s.log).filter((l) => l.table !== 'isolates')).toEqual([]);
  });

  it('works on a pending_id isolate too (status stays pending_id)', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('describeIsolate', describe_(I.a2, 2, { is_reportable: false, quantity_text: 'Synthetic many' }), s.ctx);
    expect(row(w, 'isolates', I.a2)).toMatchObject({ status: 'pending_id', is_reportable: false, quantity_text: 'Synthetic many', version: 3 });
  });

  it.each([
    ['withdrawn isolate', I.wd, 4, 'micro.isolate_invalid_transition'],
    ['isolate of a final_submitted culture', I.final, 4, 'micro.report_final_locked'],
    ['isolate of a cancelled culture', I.canc, 2, 'micro.culture_invalid_transition'],
  ])('%s -> 409 (own error code), nothing written', async (_n, id, v, code) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('describeIsolate', describe_(id, v), s.ctx)), code, 409);
    expect(w).toEqual(before);
  });

  it('stale -> 409 common.version_conflict; missing If-Match -> 428; is_reportable missing / not boolean, 501-char colony_description, unknown field -> 400; nothing written', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('describeIsolate', describe_(I.a1, 1), s.ctx)), 'common.version_conflict', 409);
    expectCode(await failure(run('describeIsolate', M9(I.a1, { is_reportable: true }, {}), s.ctx)), 'common.precondition_required', 428);
    for (const [body, path] of [[{}, '/is_reportable'], [{ is_reportable: 'yes' }, '/is_reportable'], [{ is_reportable: true, colony_description: 'x'.repeat(501) }, '/colony_description'],
      [{ is_reportable: true, organism_code: ECOLI }, undefined], [{ is_reportable: true, status: 'withdrawn' }, undefined]] as [Row, string | undefined][])
      expectInvalid(await failure(run('describeIsolate', describe_(I.a1, 3, body), s.ctx)), path);
    expect(w).toEqual(before);
  });
});

// ------------------------------------------------------------------ lock order (T-09 review item 1)
describe('C10-T09 M8-M10 lock order: culture FOR UPDATE precedes isolate FOR UPDATE (avoids deadlock with M4 source_isolate_id, FK key-share on the isolate)', () => {
  it.each([
    ['identifyIsolate', () => identify(I.a2, 2)],
    ['describeIsolate', () => describe_(I.a2, 2, { is_reportable: false })],
    ['withdrawIsolate', () => withdraw(I.a2, 2, { reason_code: 'duplicate' })],
  ])('%s', async (op, req) => {
    const w = mkWorld(); const s = setup(w);
    await run(op, req(), s.ctx);
    const forUpdate = (table: string) => s.log.findIndex((l) => l.table === table && /FOR\s+UPDATE/i.test(l.sql));
    expect(forUpdate('cultures')).toBeGreaterThanOrEqual(0);
    expect(forUpdate('isolates')).toBeGreaterThanOrEqual(0);
    expect(forUpdate('cultures')).toBeLessThan(forUpdate('isolates'));
  });
});

// ------------------------------------------------------------------ M10 withdrawIsolate
describe('C10-T09 M10 withdrawIsolate: AC-05.4 (I4)', () => {
  it.each([['pending_id', I.a2, 2, C.inc2], ['identified', I.a1, 3, C.inc]])('%s isolate + active reason_code (+ comment) -> withdrawn, reason and comment stored, version + 1; organism / seq kept; culture and AST rows untouched; IsolateDto + ETag', async (_s, id, v, cultureId) => {
    const w = mkWorld(); const s = setup(w); const cBefore = structuredClone(row(w, 'cultures', cultureId));
    const res = await run('withdrawIsolate', withdraw(id, v, { reason_code: 'contaminant', comment: 'Synthetic note' }), s.ctx);
    const r = row(w, 'isolates', id);
    expect(r).toMatchObject({ status: 'withdrawn', withdraw_reason_code: 'contaminant', withdraw_comment: 'Synthetic note', version: v + 1, updated_by: ACTOR_USER });
    expect(r['isolate_seq']).toBe(id === I.a1 ? 1 : 2);
    expect(res.body).toMatchObject({ id, status: 'withdrawn', withdraw_reason_code: 'contaminant', version: v + 1 });
    expect(responseErrors('withdrawIsolate', res.body)).toEqual([]);
    expect(res.headers?.['etag']).toBe(`"${v + 1}"`);
    expect(row(w, 'cultures', cultureId)).toEqual(cBefore);
    expect(writesOf(s.log).map((l) => l.table)).toEqual(['isolates']);                       // the AST rows are excluded from snapshots by status, not rewritten
    expect(row(w, 'ast_results', AST.a1)).toMatchObject({ version: 1, raw_value: '2' });
    expect(schemaErrors('IsolateDto', res.body)).toEqual([]);
  });

  it('a comment is optional; a reason of the tenant-over-global view that is unknown or inactive -> 400 common.validation_failed /reason_code, nothing written', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('withdrawIsolate', withdraw(I.a2, 2, { reason_code: 'duplicate' }), s.ctx);
    expect(row(w, 'isolates', I.a2)).toMatchObject({ status: 'withdrawn', withdraw_reason_code: 'duplicate' });
    expect(row(w, 'isolates', I.a2)['withdraw_comment'] ?? null).toBeNull();
    for (const code of ['syn_reason_nope', 'syn_reason_old']) {
      const w2 = mkWorld(); const before = structuredClone(w2); const s2 = setup(w2);
      expectInvalid(await failure(run('withdrawIsolate', withdraw(I.a1, 3, { reason_code: code }), s2.ctx)), '/reason_code');
      expect(w2, code).toEqual(before);
    }
  });

  it.each([
    ['already withdrawn (terminal, I4)', I.wd, 4, 'micro.isolate_invalid_transition'],
    ['isolate of a final_submitted culture', I.final, 4, 'micro.report_final_locked'],
    ['isolate of a cancelled culture', I.canc, 2, 'micro.culture_invalid_transition'],
  ])('%s -> 409 (own error code), nothing written', async (_n, id, v, code) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('withdrawIsolate', withdraw(id, v), s.ctx)), code, 409);
    expect(w).toEqual(before);
  });

  it('withdrawing twice: the second call (new version) is 409 micro.isolate_invalid_transition and the first reason stays', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('withdrawIsolate', withdraw(I.a2, 2, { reason_code: 'duplicate' }), s.ctx);
    expectCode(await failure(run('withdrawIsolate', withdraw(I.a2, 3, { reason_code: 'contaminant' }), s.ctx)), 'micro.isolate_invalid_transition', 409);
    expect(row(w, 'isolates', I.a2)['withdraw_reason_code']).toBe('duplicate');
  });

  it('a withdrawn isolate cannot be identified or described afterwards (no way back out of withdrawn)', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('withdrawIsolate', withdraw(I.a1, 3), s.ctx);
    expectCode(await failure(run('identifyIsolate', identify(I.a1, 4), s.ctx)), 'micro.isolate_invalid_transition', 409);
    expectCode(await failure(run('describeIsolate', describe_(I.a1, 4), s.ctx)), 'micro.isolate_invalid_transition', 409);
    expect(row(w, 'isolates', I.a1)['status']).toBe('withdrawn');
  });

  it('stale -> 409 common.version_conflict; missing If-Match -> 428; missing reason_code, 501-char comment, unknown fields (status, withdraw_reason_code) -> 400; nothing written', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('withdrawIsolate', withdraw(I.a1, 1), s.ctx)), 'common.version_conflict', 409);
    expectCode(await failure(run('withdrawIsolate', M10(I.a1, { reason_code: 'contaminant' }, {}), s.ctx)), 'common.precondition_required', 428);
    for (const [body, path] of [[{}, '/reason_code'], [{ reason_code: 'contaminant', comment: 'x'.repeat(501) }, '/comment'], [{ reason_code: 'contaminant', status: 'withdrawn' }, undefined],
      [{ reason_code: 'contaminant', withdraw_reason_code: 'duplicate' }, undefined], [{ reason_code: 'Bad Code' }, '/reason_code']] as [Row, string | undefined][])
      expectInvalid(await failure(run('withdrawIsolate', withdraw(I.a1, 3, body), s.ctx)), path);
    expect(w).toEqual(before);
  });
});

// ------------------------------------------------------------------ cross-cutting probes
describe('C10-T09 probes: no value leaks into logs; the final lock maps from SQLSTATE; one request = one isolate', () => {
  it('free-text and codes from the request never reach a log call, success or failure (REQ-SEC-024)', async () => {
    const SENTINEL = 'SYN-SENTINEL-DO-NOT-LOG';
    const w = mkWorld(); const s = setup(w);
    await run('createIsolate', M7(C.inc, { colony_description: SENTINEL, quantity_text: SENTINEL }), s.ctx);
    await run('withdrawIsolate', withdraw(I.a2, 2, { reason_code: 'contaminant', comment: SENTINEL }), s.ctx);
    await failure(run('createIsolate', M7(C.inc, { organism_code: UNKNOWN_ORG, colony_description: SENTINEL }), s.ctx));
    await failure(run('withdrawIsolate', withdraw(I.a1, 3, { reason_code: 'syn_reason_nope', comment: SENTINEL }), s.ctx));
    expect(JSON.stringify(s.logs)).not.toContain(SENTINEL);
  });

  it('S-29 / TRD §12: a P0001 immutable_row thrown by the database on the isolate INSERT or UPDATE surfaces as 409 micro.report_final_locked (the culture row said incubating; the lock fired first)', async () => {
    for (const [op, req] of [['createIsolate', () => M7(C.inc, {})], ['identifyIsolate', () => identify(I.a2, 2)], ['describeIsolate', () => describe_(I.a2, 2)], ['withdrawIsolate', () => withdraw(I.a2, 2)]] as [string, () => Row][]) {
      const w = mkWorld(); const s = setup(w);
      const q = s.ctx.tx.query.bind(s.ctx.tx);
      s.ctx.tx.query = async (sql: string, p: unknown[]) => { if (/^\s*(INSERT\s+INTO|UPDATE)\s+(micro\.)?isolates\b/i.test(sql)) throw Object.assign(new Error('immutable_row'), { code: 'P0001' }); return q(sql, p); };
      expectCode(await failure(run(op, req(), s.ctx)), 'micro.report_final_locked', 409);
    }
  });

  it('a request that fails after the counter was bumped does not leave a half isolate: every created isolate row has a number <= its specimen counter (invariant over a mixed run)', async () => {
    const w = mkWorld();
    await Promise.allSettled([M7(C.inc, {}), M7(C.inc, { organism_code: UNKNOWN_ORG }), M7(C.inc2, { plate_id: PL.inc }), M7(C.awaiting, {}), M7(C.inc, {})].map((r) => run('createIsolate', r, setup(w).ctx)));
    for (const r of w['isolates']!) expect(r['isolate_seq']).toBeLessThanOrEqual(countOf(w, r['specimen_id'], r['tenant_id']) as number);
    expect(new Set(w['isolates']!.filter((r) => r['specimen_id'] === S.one).map((r) => r['isolate_seq'])).size).toBe(w['isolates']!.filter((r) => r['specimen_id'] === S.one).length);
  });
});
