// C10 T-08 — setup, plates, observations: M3 setupCulture, M4 addCulturePlate, M5 discardCulturePlate, M6 recordCultureObservation WITHOUT a database
// (06-IMPLEMENTATION-PLAN row T-08; 02-TRD §4.1 schedule, §4.2 selection, §5 M3–M6, §5.6 PlateDto/ObservationDto/CultureSummaryDto/CultureDetailDto, §11 logging, §12 SQLSTATE mapping, §13 rules;
// 03-APP-FLOW §2.1 C2/C3 + "Forbidden"; 05-SCHEMA §8 cultures_guard, tg_child_final_lock, culture_plates/culture_observations constraints;
// PRD AC-03.1–03.4, AC-04.1–04.5; 07-SECURITY T-A1, T-A3, S-01, S-02 (positive part in the live file), S-03, S-05, REQ-SEC-024, REQ-SEC-081).
// DB behaviour (real triggers, RLS centre scope, FK/grant probes, parallel requests) is in culture.setup.integration.test.ts (live DB, gated like T-05/T-07 with LIMS_T08_REQUIRE_DB=1).
// SEAMS: handlers setupCulture / addCulturePlate / discardCulturePlate / recordCultureObservation in handlers/index.ts REAL map (any file layout; service/culture.service.ts, repository/plates.repo.ts,
//   repository/observations.repo.ts per plan). Permission: culture/plate loaded FIRST (RLS + explicit tenant filter), THEN ctx.ports.IdentityPort.assertRole(ctx, { permission: 'micro.culture.work', centreId: culture.centre_id }) (02-CV §10.1).
//   If-Match header `"<version>"` (02-CV §4.2): M3 = culture version, M5 = plate version; M4/M6 take none (the culture row is locked FOR UPDATE). Idempotency-Key replay is the core pipeline's (not tested here).
//   Rows come from tx.query(sql, params) against the in-memory fake of helpers/cultureWrites.ts (dialect documented there; test-side assumption: it applies INSERT/UPDATE to the world so assertions read the resulting rows).
//   Coded values: micro.v_media / v_growth_codes / v_specimen_sites (tenant-over-global views); settings micro.settings; protocols micro.plating_protocols + plating_protocol_media + plating_protocol_keys.
//   Unknown / inactive coded value or invalid body -> 400 common.validation_failed with errors[0].path (same convention as T-05 config.service `fail(path)`).
// ASSUMED (spec silent; flagged so a ruling can overrule): M4 on an awaiting_setup culture -> 409 micro.culture_invalid_transition (plates enter through setup: the isolate rule of 03-APP-FLOW I1); amending accepts plates and observations;
//   with no protocol the schedule is empty: next_read_due_at stays null; explicit `plates` override the protocol's media but the protocol still supplies the schedule; next_read_due_at after a read uses the LATEST
//   plate_read.observed_at of the culture (02-TRD §4.1), not just the new one; a path plate of another culture (M5) is 400 common.id_mismatch or 404 common.not_found; every response carries ETag "<version>" (M3/M4/M5).
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { failure, mkCtx, READ, responseErrors, run, schemaErrors, specOps, WORK, type Row } from './helpers/cultureReads.js';
import { fakeTx, hoursAfter, iso, NOW, writesOf, type World } from './helpers/cultureWrites.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const u = (n: number) => `0190c608-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE_A1 = u(0xa1), CENTRE_B1 = u(0xb1);
const ACTOR_USER = '01a1b34e-1000-7eee-9d29-d7ca59a10001', ACTOR_M = '01a1a98a-ac40-7000-8000-00000000a500';
const TEST1 = u(0x701), TEST2 = u(0x702);
const ORDER = u(0x801), ITEM = u(0x802);
const C = { setup: u(0x1001), inc: u(0x1002), growth: u(0x1003), final: u(0x1004), cancelled: u(0x1005), amend: u(0x1006), other: u(0x1007), b: u(0x1008), bInc: u(0x1009), missing: u(0x10ff) };
const PL = { inc1: u(0x2001), inc2: u(0x2002), growth: u(0x2003), final: u(0x2004), cancelled: u(0x2005), amend: u(0x2006), other: u(0x2007), b: u(0x2008) };
const OBS = { inc: u(0x3001), other: u(0x3002), b: u(0x3003) };
const ISO = { inc: u(0x4001), other: u(0x4002), b: u(0x4003) };
const PROTO = u(0x5001), PROTO_B = u(0x5002);
const PLANTED = '2026-11-04T05:00:00.000Z';                  // 24 h before NOW
const NOW_ISO = NOW.toISOString();

// ------------------------------------------------------------------ world
const culture = (id: string, status: string, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE_A1, order_id: ORDER, order_item_id: ITEM, specimen_id: u(0x900 + (parseInt(id.slice(-4), 16) & 0xff)), patient_id: u(0xa00), test_id: TEST1, specimen_type_code: 'urine',
  specimen_site_code: null, barcode_snapshot: null, plating_protocol_id: null, status, outcome_code: null, received_at: new Date('2026-11-04T04:00:00.000Z'),
  planted_at: status === 'awaiting_setup' ? null : new Date(PLANTED), next_read_due_at: null, final_due_at: null, last_specimen_seq: 1, current_report_version_no: 0, last_report_phase: null, chain_cancelled: false,
  amendment_reason_code: null, amendment_reason_text: null, cancel_reason_code: null, cancel_comment: null, cancelled_at: null,
  version: id === C.setup ? 3 : 5, is_active: true, created_at: new Date('2026-11-04T04:00:00.000Z'), created_by: ACTOR_USER, updated_at: new Date('2026-11-04T04:00:00.000Z'), updated_by: ACTOR_USER, ...over,
});
const plate = (id: string, cultureId: string, no: number, over: Row = {}): Row => ({
  id, tenant_id: over['tenant_id'] ?? A, centre_id: CENTRE_A1, culture_id: cultureId, plate_no: no, media_code: 'syn_blood', incubation_text: null, parent_plate_id: null, source_isolate_id: null,
  planted_at: new Date(PLANTED), planted_by_membership_id: ACTOR_M, status: 'active', discarded_at: null, version: 2, is_active: true, created_at: new Date(PLANTED), created_by: ACTOR_USER, updated_at: new Date(PLANTED), updated_by: ACTOR_USER, ...over,
});
const obs = (id: string, cultureId: string, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE_A1, culture_id: cultureId, plate_id: null, kind: 'gram_stain', growth_code: null, quantity_text: null, finding_text: 'Synthetic stain finding', observed_at: new Date('2026-11-04T08:00:00.000Z'),
  hours_since_planting: 3, recorded_by_membership_id: ACTOR_M, corrects_observation_id: null, created_at: new Date('2026-11-04T08:00:00.000Z'), created_by: ACTOR_USER, ...over,
});
const protocol = (id: string, code: string, over: Row = {}): Row => ({
  id, tenant_id: A, code, version_no: 1, display: `Synthetic protocol ${code}`, read_schedule_hours: [24, 48, 72], final_no_growth_hours: 96, requires_gram_stain: false, default_specimen_site_code: null,
  superseded_at: null, version: 1, is_active: true, ...over,
});
const media = (protocolId: string, code: string, sort: number, inc: string | null = null): Row => ({ id: u(0x6000 + sort), tenant_id: A, protocol_id: protocolId, media_code: code, sort_order: sort, incubation_text: inc });
const key = (code: string, testId: string | null, type: string | null): Row => ({ id: u(0x7000 + Math.floor(Math.random() * 0xfff)), tenant_id: A, protocol_code: code, test_id: testId, specimen_type_code: type, is_active: true });

function mkWorld(): World {
  return {
    cultures: [culture(C.setup, 'awaiting_setup'), culture(C.inc, 'incubating'), culture(C.growth, 'growth_detected'), culture(C.final, 'final_submitted', { outcome_code: 'syn_positive', current_report_version_no: 1 }),
      culture(C.cancelled, 'cancelled', { cancel_reason_code: 'syn_reason', cancelled_at: new Date(PLANTED) }), culture(C.amend, 'amending', { outcome_code: 'syn_positive', amendment_reason_code: 'syn_fix' }),
      culture(C.other, 'incubating'), culture(C.b, 'awaiting_setup', { tenant_id: B, centre_id: CENTRE_B1 }), culture(C.bInc, 'incubating', { tenant_id: B, centre_id: CENTRE_B1 })],
    culture_plates: [plate(PL.inc1, C.inc, 1), plate(PL.inc2, C.inc, 2, { media_code: 'syn_mac' }), plate(PL.growth, C.growth, 1), plate(PL.final, C.final, 1), plate(PL.cancelled, C.cancelled, 1), plate(PL.amend, C.amend, 1),
      plate(PL.other, C.other, 1), plate(PL.b, C.bInc, 1, { tenant_id: B, centre_id: CENTRE_B1 })],
    culture_observations: [obs(OBS.inc, C.inc), obs(OBS.other, C.other), obs(OBS.b, C.bInc, { tenant_id: B, centre_id: CENTRE_B1 })],
    isolates: [{ id: ISO.inc, tenant_id: A, culture_id: C.inc }, { id: ISO.other, tenant_id: A, culture_id: C.other }, { id: ISO.b, tenant_id: B, culture_id: C.bInc }],
    culture_transitions: [], instrument_records: [], report_versions: [], settings: [],
    plating_protocols: [protocol(PROTO, 'syn_proto'), protocol(PROTO_B, 'syn_proto_b', { tenant_id: B })],
    plating_protocol_media: [media(PROTO, 'syn_blood', 1, 'Synthetic CO2'), media(PROTO, 'syn_mac', 2)],
    plating_protocol_keys: [],
    v_media: [{ code: 'syn_blood', display: 'Synthetic blood agar', is_active: true }, { code: 'syn_mac', display: 'Synthetic MacConkey', is_active: true }, { code: 'syn_old', display: 'Retired', is_active: false }],
    v_growth_codes: [{ code: 'syn_heavy', display: 'Heavy growth', is_active: true, indicates_growth: true }, { code: 'no_growth', display: 'No growth', is_active: true, indicates_growth: false },
      { code: 'syn_retired', display: 'Retired', is_active: false, indicates_growth: true }],
    v_specimen_sites: [{ code: 'syn_site', display: 'Synthetic site', is_active: true }, { code: 'syn_site_old', display: 'Retired', is_active: false }],
    v_organisms: [], v_antibiotics: [],
  };
}
const row = (w: World, table: string, id: string): Row => w[table]!.find((r) => r['id'] === id)!;
const platesOf = (w: World, cultureId: string) => w['culture_plates']!.filter((p) => p['culture_id'] === cultureId).sort((a, b) => a['plate_no'] - b['plate_no']);
const obsOf = (w: World, cultureId: string) => w['culture_observations']!.filter((o) => o['culture_id'] === cultureId);
const transitionsOf = (w: World, cultureId: string) => w['culture_transitions']!.filter((t) => t['culture_id'] === cultureId);

function setup(w: World, grants: readonly string[] = [WORK]) {
  const { tx, log } = fakeTx(w);
  const { ctx, calls } = mkCtx({ tenantId: A, tx, grants, members: { [ACTOR_M]: 'Synthetic Actor Tech' }, users: { [ACTOR_USER]: 'Synthetic Actor User' },
    tests: { [TEST1]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' }, [TEST2]: { code: 'SYN_BLOOD', name: 'Synthetic Blood Culture' } } });
  const published: unknown[] = []; const logs: unknown[] = [];
  ctx.events = { publish: async (...a: unknown[]) => { published.push(a); return { eventId: 'e', duplicate: false }; } };
  const sink = (...a: unknown[]) => { logs.push(a); };
  ctx.log = { info: sink, warn: sink, error: sink, debug: sink, child() { return this; } };
  return { ctx, calls, log, published, logs, w };
}
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const KEY = { 'idempotency-key': 'syn-key-1' };
const M3 = (cultureId: string, body: Row, headers: Row = ifm(3)) => ({ params: { culture_id: cultureId }, headers: { ...KEY, ...headers }, body });
const M4 = (cultureId: string, body: Row, headers: Row = {}) => ({ params: { culture_id: cultureId }, headers: { ...KEY, ...headers }, body });
const M5 = (cultureId: string, plateId: string, headers: Row = ifm(2)) => ({ params: { culture_id: cultureId, plate_id: plateId }, headers, body: {} });
const M6 = (cultureId: string, body: Row, headers: Row = {}) => ({ params: { culture_id: cultureId }, headers: { ...KEY, ...headers }, body });
const PLATES2 = [{ media_code: 'syn_blood', incubation_text: 'Synthetic CO2' }, { media_code: 'syn_mac' }];
const READ_GROWTH = { kind: 'plate_read', plate_id: PL.inc1, growth_code: 'syn_heavy' };
const READ_NONE = { kind: 'plate_read', plate_id: PL.inc1, growth_code: 'no_growth' };

const expectCode = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(status); };
const expectInvalid = (e: any, path?: string) => { expectCode(e, 'common.validation_failed', 400); if (path !== undefined) expect(e.errors?.map((x: any) => x.path), JSON.stringify(e.errors)).toContain(path); };

// ------------------------------------------------------------------ contract pins
describe('C10-T08 contract pins (micro.yaml)', () => {
  const OPS = {
    setupCulture: { idem: 'required', ifMatch: true, errors: ['micro.culture_invalid_transition', 'common.version_conflict', 'common.precondition_required'] },
    addCulturePlate: { idem: 'required', ifMatch: false, errors: ['micro.report_final_locked', 'micro.culture_invalid_transition'] },
    discardCulturePlate: { idem: 'optional', ifMatch: true, errors: ['micro.report_final_locked', 'micro.culture_invalid_transition', 'common.version_conflict', 'common.precondition_required'] },
    recordCultureObservation: { idem: 'required', ifMatch: false, errors: ['micro.report_final_locked', 'micro.culture_invalid_transition'] },
  } as const;
  it.each(Object.entries(OPS))('%s: x-permission micro.culture.work only, idempotency %s, If-Match as the TRD §5 header says, declared errors, strict body', (id, o) => {
    const op = specOps()[id];
    expect(op['x-permission']).toBe(WORK);
    expect(Object.keys(op).filter((k) => k === 'x-permissions')).toEqual([]);
    expect(op['x-idempotency']).toBe(o.idem);
    expect(op.parameters.some((p: any) => String(p.$ref ?? '').endsWith('/IfMatch'))).toBe(o.ifMatch);
    for (const c of ['common.not_found', 'common.validation_failed', ...o.errors]) expect(op['x-error-codes'], c).toContain(c);
    expect(op.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
  });
  it('M3 plates 1..12 with media_code; M6 kind enum and finding_text 1..2000; M4/M5/M6 answer PlateDto / PlateDto / {observation, culture}', () => {
    const ops = specOps();
    const plates = ops['setupCulture'].requestBody.content['application/json'].schema.properties.plates;
    expect([plates.minItems, plates.maxItems, plates.items.required]).toEqual([1, 12, ['media_code']]);
    const b6 = ops['recordCultureObservation'].requestBody.content['application/json'].schema;
    expect(b6.required).toEqual(['kind']);
    expect(b6.properties.kind.enum).toEqual(['plate_read', 'gram_stain', 'microscopy', 'other']);
    expect([b6.properties.finding_text.minLength, b6.properties.finding_text.maxLength]).toEqual([1, 2000]);
    expect(ops['addCulturePlate'].responses['200'].content['application/json'].schema.$ref).toMatch(/PlateDto$/);
    expect(ops['discardCulturePlate'].responses['200'].content['application/json'].schema.$ref).toMatch(/PlateDto$/);
    expect(Object.keys(ops['recordCultureObservation'].responses['200'].content['application/json'].schema.properties)).toEqual(['observation', 'culture']);
  });
});

// ------------------------------------------------------------------ permission: object first, then micro.culture.work with the object's centre
const WRITES: [string, (w: World) => Row][] = [
  ['setupCulture', () => M3(C.setup, { plates: PLATES2 })],
  ['addCulturePlate', () => M4(C.inc, { media_code: 'syn_blood' })],
  ['discardCulturePlate', () => M5(C.inc, PL.inc1)],
  ['recordCultureObservation', () => M6(C.inc, { kind: 'gram_stain', finding_text: 'Synthetic stain finding' })],
];
describe('C10-T08 permissions (D-64): micro.culture.work is the only grant that writes; object loaded first (02-CV §10.1)', () => {
  it.each(WRITES)('%s without the grant (read-only / config-only user) -> 403 auth.forbidden, asked for micro.culture.work with the culture\'s centre_id AFTER the object was read; no write, no access-log row', async (op, req) => {
    for (const grants of [[READ], ['micro.config.manage'], []]) {
      const w = mkWorld(); const before = structuredClone(w);
      const s = setup(w, grants);
      const e = await failure(run(op, req(w), s.ctx));
      expectCode(e, 'auth.forbidden', 403);
      expect(s.calls.assertRole.at(-1), JSON.stringify(grants)).toEqual({ permission: WORK, centreId: CENTRE_A1 });
      expect(s.log.length).toBeGreaterThan(0);                              // the object was read before the decision
      expect(writesOf(s.log)).toEqual([]);
      expect(w).toEqual(before);
      expect(s.calls.access).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------ BOLA / id mismatch (T-A1, T-A3, S-01, S-03)
describe('C10-T08 BOLA: another tenant\'s culture = 404 identical to a missing one; no write, no side effect (S-01)', () => {
  it.each(WRITES)('%s on a culture of tenant B and on a random id: same 404 common.not_found; nothing written', async (op, req) => {
    const w1 = mkWorld(); const w2 = mkWorld(); const before = structuredClone(w1);
    const swap = (r: Row, id: string): Row => ({ ...r, params: { ...r['params'], culture_id: id } });
    const foreign = setup(w1); const missing = setup(w2);
    const e1 = await failure(run(op, swap(req(w1), C.b), foreign.ctx));
    const e2 = await failure(run(op, swap(req(w2), C.missing), missing.ctx));
    for (const e of [e1, e2]) expectCode(e, 'common.not_found', 404);
    expect({ code: e1.code, message: e1.message }).toEqual({ code: e2.code, message: e2.message });
    expect(writesOf(foreign.log)).toEqual([]);
    expect(w1).toEqual(before);
    expect(foreign.calls.assertRole).toEqual([]);                           // nothing to decide on: no existence oracle through 403
  });

  it.each([
    ['M4 parent_plate_id', 'addCulturePlate', () => M4(C.inc, { media_code: 'syn_blood', parent_plate_id: PL.b })],
    ['M4 source_isolate_id', 'addCulturePlate', () => M4(C.inc, { media_code: 'syn_blood', source_isolate_id: ISO.b })],
    ['M6 plate_id', 'recordCultureObservation', () => M6(C.inc, { ...READ_NONE, plate_id: PL.b })],
    ['M6 corrects_observation_id', 'recordCultureObservation', () => M6(C.inc, { kind: 'gram_stain', finding_text: 'Synthetic correction', corrects_observation_id: OBS.b })],
    ['M5 plate_id (path)', 'discardCulturePlate', () => M5(C.inc, PL.b)],
  ] as [string, string, () => Row][])('a tenant-B id in %s -> 404 common.not_found, nothing written in either tenant (S-01)', async (_n, op, req) => {
    const w = mkWorld(); const before = structuredClone(w);
    const s = setup(w);
    expectCode(await failure(run(op, req(), s.ctx)), 'common.not_found', 404);
    expect(writesOf(s.log)).toEqual([]);
    expect(w).toEqual(before);
  });

  it('M3 plating_protocol_id of tenant B -> refused (404 common.not_found or 400 common.validation_failed), the culture is not set up', async () => {
    const w = mkWorld(); const before = structuredClone(w);
    const s = setup(w);
    const e = await failure(run('setupCulture', M3(C.setup, { plating_protocol_id: PROTO_B }), s.ctx));
    expect(['common.not_found', 'common.validation_failed'].some((c) => isLimsError(e, c)), `${e?.code ?? e}`).toBe(true);
    expect(w).toEqual(before);
  });

  it.each([
    ['M4 parent_plate_id', 'addCulturePlate', () => M4(C.inc, { media_code: 'syn_blood', parent_plate_id: PL.other })],
    ['M4 source_isolate_id', 'addCulturePlate', () => M4(C.inc, { media_code: 'syn_blood', source_isolate_id: ISO.other })],
    ['M6 plate_id', 'recordCultureObservation', () => M6(C.inc, { ...READ_NONE, plate_id: PL.other })],
    ['M6 corrects_observation_id', 'recordCultureObservation', () => M6(C.inc, { kind: 'gram_stain', finding_text: 'Synthetic correction', corrects_observation_id: OBS.other })],
  ] as [string, string, () => Row][])('a same-tenant id of ANOTHER culture in %s -> 400 common.id_mismatch, nothing written (S-03, TRD §13)', async (_n, op, req) => {
    const w = mkWorld(); const before = structuredClone(w);
    const s = setup(w);
    expectCode(await failure(run(op, req(), s.ctx)), 'common.id_mismatch', 400);
    expect(writesOf(s.log)).toEqual([]);
    expect(w).toEqual(before);
  });

  it('M5 on a plate that belongs to another culture of the same tenant -> 400 common.id_mismatch or 404 common.not_found; the plate stays active', async () => {
    const w = mkWorld(); const before = structuredClone(w);
    const s = setup(w);
    const e = await failure(run('discardCulturePlate', M5(C.inc, PL.other, ifm(2)), s.ctx));
    expect(['common.id_mismatch', 'common.not_found'].some((c) => isLimsError(e, c)), `${e?.code ?? e}`).toBe(true);
    expect(w).toEqual(before);
  });
});

// ------------------------------------------------------------------ M3 setupCulture
describe('C10-T08 M3 setupCulture: AC-03.1 awaiting_setup -> incubating (C2)', () => {
  it('explicit plates, no protocol anywhere: culture incubating, planted_at = now, plates numbered 1..n under the culture\'s centre, transition row, default final window 48 h, version + 1, DTO + ETag', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('setupCulture', M3(C.setup, { plates: PLATES2 }), s.ctx);
    expect(res.status).toBe(200);
    const c = row(w, 'cultures', C.setup);
    expect(c).toMatchObject({ status: 'incubating', version: 4, updated_by: ACTOR_USER });
    expect(iso(c['planted_at'])).toBe(NOW_ISO);
    expect(iso(c['final_due_at'])).toBe(hoursAfter(NOW, 48));
    expect(c['next_read_due_at'] ?? null).toBeNull();                      // ASSUMED: no protocol, no schedule
    expect(c['plating_protocol_id'] ?? null).toBeNull();
    expect(platesOf(w, C.setup).map((p) => [p['plate_no'], p['media_code'], p['incubation_text'] ?? null, p['status'], p['centre_id'], p['tenant_id']]))
      .toEqual([[1, 'syn_blood', 'Synthetic CO2', 'active', CENTRE_A1, A], [2, 'syn_mac', null, 'active', CENTRE_A1, A]]);
    expect(platesOf(w, C.setup).every((p) => iso(p['planted_at']) === NOW_ISO)).toBe(true);
    expect(transitionsOf(w, C.setup)).toHaveLength(1);
    expect(transitionsOf(w, C.setup)[0]).toMatchObject({ from_status: 'awaiting_setup', to_status: 'incubating', centre_id: CENTRE_A1, tenant_id: A, created_by: ACTOR_USER });
    expect(res.body).toMatchObject({ id: C.setup, status: 'incubating', version: 4 });
    expect(responseErrors('setupCulture', res.body)).toEqual([]);
    expect(res.body.plates.map((p: Row) => p['plate_no'])).toEqual([1, 2]);
    for (const p of res.body.plates) expect(schemaErrors('PlateDto', p)).toEqual([]);
    expect(res.headers?.['etag']).toBe('"4"');
    expect(s.calls.assertRole.at(-1)).toEqual({ permission: WORK, centreId: CENTRE_A1 });
    expect(s.calls.access).toEqual([]);                                     // TRD §13: only M2 writes an access_log row
    expect(s.published).toEqual([]);                                        // C10 produces no event (TRD §8.1)
  });

  it('given planted_at and specimen_site_code they are stored (final_due_at counts from the given planting time)', async () => {
    const w = mkWorld(); const s = setup(w);
    const planted = hoursAfter(NOW, -19);
    await run('setupCulture', M3(C.setup, { plates: PLATES2, planted_at: planted, specimen_site_code: 'syn_site' }), s.ctx);
    const c = row(w, 'cultures', C.setup);
    expect(iso(c['planted_at'])).toBe(planted);
    expect(iso(c['final_due_at'])).toBe(hoursAfter(planted, 48));
    expect(c['specimen_site_code']).toBe('syn_site');
    expect(platesOf(w, C.setup).every((p) => iso(p['planted_at']) === planted)).toBe(true);
  });

  it('planted_at window [now - 72 h, now] (CONV): the boundaries pass, one second outside fails 400 /planted_at and nothing is written', async () => {
    for (const ok of [hoursAfter(NOW, -72), NOW_ISO]) {
      const w = mkWorld(); const s = setup(w);
      await run('setupCulture', M3(C.setup, { plates: PLATES2, planted_at: ok }), s.ctx);
      expect(row(w, 'cultures', C.setup)['status'], ok).toBe('incubating');
    }
    for (const bad of [hoursAfter(NOW, -72 - 1 / 3600), hoursAfter(NOW, 1 / 3600)]) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectInvalid(await failure(run('setupCulture', M3(C.setup, { plates: PLATES2, planted_at: bad }), s.ctx)), '/planted_at');
      expect(w).toEqual(before);
    }
  });

  it('with plating_protocol_id and no plates: plates come from the protocol media in sort order (incl. incubation_text); next_read_due_at = planted + first schedule hour; final_due_at = planted + final_no_growth_hours; protocol snapshot id kept', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('setupCulture', M3(C.setup, { plating_protocol_id: PROTO }), s.ctx);
    const c = row(w, 'cultures', C.setup);
    expect(c['status']).toBe('incubating');
    expect(c['plating_protocol_id']).toBe(PROTO);
    expect(iso(c['next_read_due_at'])).toBe(hoursAfter(NOW, 24));
    expect(iso(c['final_due_at'])).toBe(hoursAfter(NOW, 96));
    expect(platesOf(w, C.setup).map((p) => [p['plate_no'], p['media_code'], p['incubation_text'] ?? null])).toEqual([[1, 'syn_blood', 'Synthetic CO2'], [2, 'syn_mac', null]]);
    expect(res.body.protocol).toMatchObject({ id: PROTO, code: 'syn_proto', version_no: 1, read_schedule_hours: [24, 48, 72], final_no_growth_hours: 96, requires_gram_stain: false });
    expect(responseErrors('setupCulture', res.body)).toEqual([]);
  });

  it('explicit plates override the protocol\'s media, the protocol still supplies the schedule (ASSUMED, 04-UI "user may change protocol or edit plates")', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('setupCulture', M3(C.setup, { plating_protocol_id: PROTO, plates: [{ media_code: 'syn_mac' }] }), s.ctx);
    expect(platesOf(w, C.setup).map((p) => p['media_code'])).toEqual(['syn_mac']);
    expect(iso(row(w, 'cultures', C.setup)['next_read_due_at'])).toBe(hoursAfter(NOW, 24));
  });

  it('plates are numbered 1..n for 12 plates (maximum) and the whole request is one unit: 13 plates -> 400, nothing written', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('setupCulture', M3(C.setup, { plates: Array.from({ length: 12 }, () => ({ media_code: 'syn_blood' })) }), s.ctx);
    expect(platesOf(w, C.setup).map((p) => p['plate_no'])).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const w2 = mkWorld(); const before = structuredClone(w2); const s2 = setup(w2);
    expectInvalid(await failure(run('setupCulture', M3(C.setup, { plates: Array.from({ length: 13 }, () => ({ media_code: 'syn_blood' })) }), s2.ctx)));
    expect(w2).toEqual(before);
  });
});

describe('C10-T08 M3 setupCulture: AC-03.2 protocol resolution and fallbacks', () => {
  const tiers = (): World => {
    const w = mkWorld();
    const ids = { tt: u(0x5101), t: u(0x5102), s: u(0x5103), d: u(0x5104) };
    w['plating_protocols'] = [protocol(ids.tt, 'syn_tt', { final_no_growth_hours: 10 }), protocol(ids.t, 'syn_t', { final_no_growth_hours: 20 }), protocol(ids.s, 'syn_s', { final_no_growth_hours: 30 }), protocol(ids.d, 'syn_d', { final_no_growth_hours: 40 })];
    w['plating_protocol_media'] = Object.values(ids).map((id, i) => media(id, 'syn_blood', 10 + i));
    w['plating_protocol_keys'] = [key('syn_tt', TEST1, 'urine'), key('syn_t', TEST1, null), key('syn_s', null, 'urine'), key('syn_d', null, null)];
    return w;
  };
  it.each([
    ['test + specimen type', TEST1, 'urine', 'syn_tt', 10], ['test only', TEST1, 'swab', 'syn_t', 20], ['specimen type only', TEST2, 'urine', 'syn_s', 30], ['tenant default', TEST2, 'swab', 'syn_d', 40],
  ])('no protocol given, culture of (%s): key precedence (test+type) > (test) > (type) > default selects %s; final_due_at = planted + its final_no_growth_hours', async (_n, testId, type, code, finalHours) => {
    const w = tiers(); Object.assign(row(w, 'cultures', C.setup), { test_id: testId, specimen_type_code: type });
    const s = setup(w);
    await run('setupCulture', M3(C.setup, {}), s.ctx);
    const c = row(w, 'cultures', C.setup);
    expect(w['plating_protocols']!.find((p) => p['id'] === c['plating_protocol_id'])?.['code']).toBe(code);
    expect(iso(c['final_due_at'])).toBe(hoursAfter(NOW, finalHours));
    expect(platesOf(w, C.setup)).toHaveLength(1);
  });

  it('no protocol resolves and no plates -> 400 common.validation_failed on /plates, nothing written, the culture stays awaiting_setup', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await failure(run('setupCulture', M3(C.setup, {}), s.ctx)), '/plates');
    expect(w).toEqual(before);
    expect(writesOf(s.log)).toEqual([]);
  });

  it('no protocol: final_no_growth_hours falls back to micro.settings.default_final_no_growth_hours (tenant row 60 h; no row = 48 h)', async () => {
    const w = mkWorld(); w['settings'] = [{ id: u(0x8001), tenant_id: A, default_final_no_growth_hours: 60, version: 1 }];
    const s = setup(w);
    await run('setupCulture', M3(C.setup, { plates: PLATES2 }), s.ctx);
    expect(iso(row(w, 'cultures', C.setup)['final_due_at'])).toBe(hoursAfter(NOW, 60));
  });

  it('a protocol of the tenant that is superseded or inactive cannot be chosen explicitly -> 400 common.validation_failed, nothing written', async () => {
    for (const over of [{ superseded_at: new Date(PLANTED) }, { is_active: false }]) {
      const w = mkWorld(); Object.assign(row(w, 'plating_protocols', PROTO), over); const before = structuredClone(w); const s = setup(w);
      expectInvalid(await failure(run('setupCulture', M3(C.setup, { plating_protocol_id: PROTO }), s.ctx)));
      expect(w).toEqual(before);
    }
  });

  it.each([
    ['unknown media code', { plates: [{ media_code: 'syn_blood' }, { media_code: 'syn_nope' }] }, '/plates/1/media_code'],
    ['inactive media code', { plates: [{ media_code: 'syn_old' }] }, '/plates/0/media_code'],
    ['unknown specimen_site_code', { plates: PLATES2, specimen_site_code: 'syn_nope' }, '/specimen_site_code'],
    ['inactive specimen_site_code', { plates: PLATES2, specimen_site_code: 'syn_site_old' }, '/specimen_site_code'],
  ])('%s -> 400 common.validation_failed %s, nothing written (media codes must be active)', async (_n, body, path) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await failure(run('setupCulture', M3(C.setup, body), s.ctx)), path);
    expect(w).toEqual(before);
  });
});

describe('C10-T08 M3 setupCulture: AC-03.3 / AC-03.4 and request validation', () => {
  it.each([['incubating', C.inc], ['growth_detected', C.growth], ['final_submitted', C.final], ['amending', C.amend], ['cancelled', C.cancelled]])(
    'AC-03.3 culture in %s -> 409 micro.culture_invalid_transition (current If-Match), no plate, no transition, culture unchanged', async (_s, id) => {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectCode(await failure(run('setupCulture', M3(id, { plates: PLATES2 }, ifm(5)), s.ctx)), 'micro.culture_invalid_transition', 409);
      expect(w).toEqual(before);
    });

  it('AC-03.4 stale If-Match -> 409 common.version_conflict and nothing changes; a second setup with the old version after a success is refused too', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('setupCulture', M3(C.setup, { plates: PLATES2 }, ifm(2)), s.ctx)), 'common.version_conflict', 409);
    expect(w).toEqual(before);
    await run('setupCulture', M3(C.setup, { plates: PLATES2 }, ifm(3)), s.ctx);
    const e = await failure(run('setupCulture', M3(C.setup, { plates: PLATES2 }, ifm(3)), s.ctx));
    expect(['common.version_conflict', 'micro.culture_invalid_transition'].some((c) => isLimsError(e, c)), `${e?.code ?? e}`).toBe(true);
    expect(platesOf(w, C.setup)).toHaveLength(2);
    expect(transitionsOf(w, C.setup)).toHaveLength(1);
  });

  it('missing If-Match -> 428 common.precondition_required, nothing written', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('setupCulture', M3(C.setup, { plates: PLATES2 }, {}), s.ctx)), 'common.precondition_required', 428);
    expect(w).toEqual(before);
  });

  it.each([
    ['unknown field status (S-05)', { plates: PLATES2, status: 'final_submitted' }],
    ['unknown field tenant_id (S-05)', { plates: PLATES2, tenant_id: B }],
    ['unknown field version', { plates: PLATES2, version: 9 }],
    ['unknown field next_read_due_at', { plates: PLATES2, next_read_due_at: PLANTED }],
    ['unknown field in a plate (plate_no)', { plates: [{ media_code: 'syn_blood', plate_no: 7 }] }],
    ['empty plates', { plates: [] }],
    ['plate without media_code', { plates: [{ incubation_text: 'x' }] }],
    ['incubation_text of 121 chars', { plates: [{ media_code: 'syn_blood', incubation_text: 'x'.repeat(121) }] }],
    ['media_code with upper case', { plates: [{ media_code: 'SYN_BLOOD' }] }],
    ['planted_at not a timestamp', { plates: PLATES2, planted_at: 'yesterday' }],
    ['plating_protocol_id not a uuid', { plates: PLATES2, plating_protocol_id: 'p1' }],
    ['SQL in the media code', { plates: [{ media_code: "syn_blood'; DROP TABLE micro.cultures;--" }] }],
  ])('%s -> 400 common.validation_failed, nothing written', async (_n, body) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await failure(run('setupCulture', M3(C.setup, body as Row), s.ctx)));
    expect(w).toEqual(before);
  });
});

// ------------------------------------------------------------------ M4 addCulturePlate
describe('C10-T08 M4 addCulturePlate', () => {
  it('adds the next plate (max + 1) to an incubating culture under the culture\'s centre; no If-Match needed; PlateDto + ETag "1"; the culture state does not change', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('addCulturePlate', M4(C.inc, { media_code: 'syn_blood', incubation_text: 'Synthetic subculture' }), s.ctx);
    expect(res.status).toBe(200);
    const p = platesOf(w, C.inc);
    expect(p.map((x) => x['plate_no'])).toEqual([1, 2, 3]);
    expect(p[2]).toMatchObject({ media_code: 'syn_blood', incubation_text: 'Synthetic subculture', status: 'active', centre_id: CENTRE_A1, tenant_id: A, culture_id: C.inc, created_by: ACTOR_USER, version: 1 });
    expect(iso(p[2]!['planted_at'])).toBe(NOW_ISO);
    expect(res.body).toMatchObject({ id: p[2]!['id'], plate_no: 3, media_code: 'syn_blood', status: 'active', version: 1 });
    expect(schemaErrors('PlateDto', res.body)).toEqual([]);
    expect(res.headers?.['etag']).toBe('"1"');
    expect(row(w, 'cultures', C.inc)).toMatchObject({ status: 'incubating', version: 5 });
    expect(transitionsOf(w, C.inc)).toEqual([]);
    expect(s.calls.assertRole.at(-1)).toEqual({ permission: WORK, centreId: CENTRE_A1 });
  });

  it('parent_plate_id and source_isolate_id of the same culture and a given planted_at are stored', async () => {
    const w = mkWorld(); const s = setup(w);
    const planted = hoursAfter(NOW, -2);
    const res = await run('addCulturePlate', M4(C.inc, { media_code: 'syn_mac', parent_plate_id: PL.inc1, source_isolate_id: ISO.inc, planted_at: planted }), s.ctx);
    expect(res.body).toMatchObject({ parent_plate_id: PL.inc1, source_isolate_id: ISO.inc, planted_at: planted });
    expect(schemaErrors('PlateDto', res.body)).toEqual([]);
  });

  it.each([['growth_detected', C.growth], ['amending', C.amend]])('a culture in %s accepts a plate (subculture)', async (_s, id) => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('addCulturePlate', M4(id, { media_code: 'syn_blood' }), s.ctx);
    expect(res.body['plate_no']).toBe(2);
  });

  it.each([
    ['final_submitted', C.final, 'micro.report_final_locked'],
    ['cancelled', C.cancelled, 'micro.culture_invalid_transition'],
    ['awaiting_setup (ASSUMED: plates enter through setup)', C.setup, 'micro.culture_invalid_transition'],
  ])('culture in %s -> 409 %s, no plate row, culture unchanged (AC-04.5 locks; P0001 immutable_row maps to report_final_locked)', async (_s, id, code) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('addCulturePlate', M4(id, { media_code: 'syn_blood' }), s.ctx)), code, 409);
    expect(w).toEqual(before);
  });

  it.each([
    ['unknown media code', { media_code: 'syn_nope' }, '/media_code'],
    ['inactive media code', { media_code: 'syn_old' }, '/media_code'],
    ['missing media_code', { incubation_text: 'x' }, undefined],
    ['unknown field plate_no (S-05)', { media_code: 'syn_blood', plate_no: 9 }, undefined],
    ['unknown field status', { media_code: 'syn_blood', status: 'discarded' }, undefined],
    ['incubation_text of 121 chars', { media_code: 'syn_blood', incubation_text: 'x'.repeat(121) }, undefined],
    ['parent_plate_id not a uuid', { media_code: 'syn_blood', parent_plate_id: 'p1' }, undefined],
  ] as [string, Row, string | undefined][])('%s -> 400 common.validation_failed, nothing written', async (_n, body, path) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await failure(run('addCulturePlate', M4(C.inc, body), s.ctx)), path);
    expect(w).toEqual(before);
  });

  // Review T-08 #1: culture_plates__no__ck CHECK (plate_no BETWEEN 1 AND 50) must not surface as 500 common.internal.
  it('culture already holding plate_no 50 -> 400 common.validation_failed (path /), no plate inserted, culture unchanged', async () => {
    const w = mkWorld(); w['culture_plates']!.push(plate(u(0x2050), C.inc, 50)); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await failure(run('addCulturePlate', M4(C.inc, { media_code: 'syn_blood' }), s.ctx)), '/');
    expect(w).toEqual(before);
    expect(platesOf(w, C.inc).map((x) => x['plate_no'])).toEqual([1, 2, 50]);
  });

  it('plate_no 49 -> the 50th plate is still accepted', async () => {
    const w = mkWorld(); w['culture_plates']!.push(plate(u(0x2049), C.inc, 49)); const s = setup(w);
    const res = await run('addCulturePlate', M4(C.inc, { media_code: 'syn_blood' }), s.ctx);
    expect(res.body['plate_no']).toBe(50);
  });
});

// ------------------------------------------------------------------ M5 discardCulturePlate
describe('C10-T08 M5 discardCulturePlate (If-Match = plate version)', () => {
  it('discards the plate: status discarded, version + 1, PlateDto + ETag; the culture, its other plates and its observations are untouched', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    const res = await run('discardCulturePlate', M5(C.inc, PL.inc1, ifm(2)), s.ctx);
    expect(res.status).toBe(200);
    expect(row(w, 'culture_plates', PL.inc1)).toMatchObject({ status: 'discarded', version: 3, updated_by: ACTOR_USER });
    expect(res.body).toMatchObject({ id: PL.inc1, status: 'discarded', version: 3, plate_no: 1 });
    expect(schemaErrors('PlateDto', res.body)).toEqual([]);
    expect(res.headers?.['etag']).toBe('"3"');
    expect(row(w, 'culture_plates', PL.inc2)).toEqual(before['culture_plates']!.find((p) => p['id'] === PL.inc2));
    expect(row(w, 'cultures', C.inc)).toEqual(before['cultures']!.find((c) => c['id'] === C.inc));
    expect(w['culture_observations']).toEqual(before['culture_observations']);
    expect(s.calls.assertRole.at(-1)).toEqual({ permission: WORK, centreId: CENTRE_A1 });
  });

  it('stale If-Match -> 409 common.version_conflict; missing -> 428 common.precondition_required; the plate stays active', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('discardCulturePlate', M5(C.inc, PL.inc1, ifm(1)), s.ctx)), 'common.version_conflict', 409);
    expectCode(await failure(run('discardCulturePlate', M5(C.inc, PL.inc1, {}), s.ctx)), 'common.precondition_required', 428);
    expect(w).toEqual(before);
  });

  it.each([
    ['final_submitted', C.final, PL.final, 'micro.report_final_locked'],
    ['cancelled', C.cancelled, PL.cancelled, 'micro.culture_invalid_transition'],
  ])('culture in %s -> 409 %s, the plate is not changed', async (_s, cid, pid, code) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('discardCulturePlate', M5(cid, pid, ifm(2)), s.ctx)), code, 409);
    expect(w).toEqual(before);
  });

  it('a plate that does not exist in the culture -> 404 common.not_found', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('discardCulturePlate', M5(C.inc, u(0x20ff), ifm(1)), s.ctx)), 'common.not_found', 404);
    expect(w).toEqual(before);
  });

  it('a body other than {} -> 400 common.validation_failed (strict)', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await failure(run('discardCulturePlate', { ...M5(C.inc, PL.inc1), body: { status: 'active' } }, s.ctx)));
    expect(w).toEqual(before);
  });
});

// ------------------------------------------------------------------ M6 recordCultureObservation
describe('C10-T08 M6 recordCultureObservation: AC-04.1 growth read -> growth_detected (C3)', () => {
  it('plate_read with an indicates_growth code on an incubating culture: observation stored (hours_since_planting 24.00, recorded_by = caller), culture growth_detected, one transition row, response = {observation, culture}', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('recordCultureObservation', M6(C.inc, { ...READ_GROWTH, quantity_text: 'Synthetic heavy' }), s.ctx);
    expect(res.status).toBe(200);
    const o = obsOf(w, C.inc).find((x) => x['kind'] === 'plate_read')!;
    expect(o).toMatchObject({ plate_id: PL.inc1, growth_code: 'syn_heavy', quantity_text: 'Synthetic heavy', recorded_by_membership_id: ACTOR_M, created_by: ACTOR_USER, centre_id: CENTRE_A1, tenant_id: A, corrects_observation_id: null });
    expect(iso(o['observed_at'])).toBe(NOW_ISO);
    expect(Number(o['hours_since_planting'])).toBe(24);
    expect(row(w, 'cultures', C.inc)).toMatchObject({ status: 'growth_detected', updated_by: ACTOR_USER });
    expect(row(w, 'cultures', C.inc)['version']).toBeGreaterThan(5);
    expect(transitionsOf(w, C.inc)).toHaveLength(1);
    expect(transitionsOf(w, C.inc)[0]).toMatchObject({ from_status: 'incubating', to_status: 'growth_detected', centre_id: CENTRE_A1, tenant_id: A, created_by: ACTOR_USER });
    expect(responseErrors('recordCultureObservation', res.body)).toEqual([]);
    expect(res.body.observation).toMatchObject({ id: o['id'], kind: 'plate_read', plate_id: PL.inc1, growth_code: 'syn_heavy', hours_since_planting: 24, recorded_by_display: 'Synthetic Actor Tech', is_corrected: false, observed_at: NOW_ISO });
    expect(res.body.culture).toMatchObject({ id: C.inc, status: 'growth_detected', version: row(w, 'cultures', C.inc)['version'], test_code: 'SYN_URINE' });
    expect(s.calls.access).toEqual([]);
    expect(s.published).toEqual([]);
  });

  it('hours_since_planting = (observed_at - planted_at) in hours, 2 decimals (5.5 h)', async () => {
    const w = mkWorld(); const s = setup(w);
    const at = '2026-11-04T10:30:00.000Z';
    const res = await run('recordCultureObservation', M6(C.inc, { ...READ_NONE, observed_at: at }), s.ctx);
    expect(res.body.observation).toMatchObject({ observed_at: at, hours_since_planting: 5.5 });
  });

  it('a second growth read on a growth_detected culture stays growth_detected and writes NO new transition row', async () => {
    const w = mkWorld(); const s = setup(w);
    row(w, 'culture_plates', PL.growth); // plate of the growth culture
    const res = await run('recordCultureObservation', M6(C.growth, { kind: 'plate_read', plate_id: PL.growth, growth_code: 'syn_heavy' }), s.ctx);
    expect(row(w, 'cultures', C.growth)['status']).toBe('growth_detected');
    expect(transitionsOf(w, C.growth)).toEqual([]);
    expect(res.body.culture.status).toBe('growth_detected');
  });

  it('an amending culture accepts an observation and stays amending (no C3 outside incubating)', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('recordCultureObservation', M6(C.amend, { kind: 'plate_read', plate_id: PL.amend, growth_code: 'syn_heavy' }), s.ctx);
    expect(row(w, 'cultures', C.amend)['status']).toBe('amending');
    expect(transitionsOf(w, C.amend)).toEqual([]);
    expect(obsOf(w, C.amend)).toHaveLength(1);
  });
});

describe('C10-T08 M6 recordCultureObservation: AC-04.2 no growth keeps incubating and moves next_read_due_at', () => {
  const withProtocol = (planted: string, existing: Row[] = []) => {
    const w = mkWorld();
    Object.assign(row(w, 'cultures', C.inc), { plating_protocol_id: PROTO, planted_at: new Date(planted), next_read_due_at: new Date(hoursAfter(planted, 24)) });
    w['culture_observations']!.push(...existing);
    return w;
  };
  it.each([
    ['read at 24 h exactly -> the next slot strictly later (48 h)', PLANTED, NOW_ISO, hoursAfter(PLANTED, 48)],
    ['read at 5 h -> the first slot after it (24 h)', PLANTED, '2026-11-04T10:00:00.000Z', hoursAfter(PLANTED, 24)],
    ['read at 25 h on an older planting: the next slot after it is 48 h even though it is already past', '2026-11-01T05:00:00.000Z', '2026-11-02T06:00:00.000Z', hoursAfter('2026-11-01T05:00:00.000Z', 48)],
  ])('%s', async (_n, planted, observedAt, expected) => {
    const w = withProtocol(planted); const s = setup(w);
    const res = await run('recordCultureObservation', M6(C.inc, { ...READ_NONE, observed_at: observedAt }), s.ctx);
    const c = row(w, 'cultures', C.inc);
    expect(c['status']).toBe('incubating');
    expect(iso(c['next_read_due_at'])).toBe(expected);
    expect(transitionsOf(w, C.inc)).toEqual([]);
    expect(res.body.culture).toMatchObject({ status: 'incubating', next_read_due_at: expected });
  });

  it('schedule exhausted (read at 96 h, slots 24/48/72) -> next_read_due_at is cleared (omitted from the DTO, never null)', async () => {
    const planted = '2026-11-01T05:00:00.000Z';
    const w = withProtocol(planted); const s = setup(w);
    const res = await run('recordCultureObservation', M6(C.inc, { ...READ_NONE }), s.ctx);   // observed_at = now = 96 h after planting
    expect(row(w, 'cultures', C.inc)['next_read_due_at'] ?? null).toBeNull();
    expect('next_read_due_at' in res.body.culture).toBe(false);
    expect(responseErrors('recordCultureObservation', res.body)).toEqual([]);
  });

  it('a late-entered older read does not pull next_read_due_at back: the LATEST plate_read of the culture counts (TRD §4.1; ASSUMED reading)', async () => {
    const planted = '2026-11-01T05:00:00.000Z';
    const latest = obs(u(0x3010), C.inc, { kind: 'plate_read', plate_id: PL.inc1, growth_code: 'no_growth', finding_text: null, observed_at: new Date('2026-11-03T06:00:00.000Z') });   // 49 h
    const w = withProtocol(planted, [latest]); const s = setup(w);
    await run('recordCultureObservation', M6(C.inc, { ...READ_NONE, observed_at: '2026-11-02T06:00:00.000Z' }), s.ctx);                                                                  // 25 h
    expect(iso(row(w, 'cultures', C.inc)['next_read_due_at'])).toBe(hoursAfter(planted, 72));
  });
});

describe('C10-T08 M6 recordCultureObservation: AC-04.3 gram_stain / microscopy / other need finding_text and never change the state', () => {
  it.each(['gram_stain', 'microscopy', 'other'])('%s with finding_text: stored without plate/growth code, culture status and schedule unchanged, no transition', async (kind) => {
    const w = mkWorld(); const s = setup(w);
    const beforeCulture = structuredClone(row(w, 'cultures', C.inc));
    const res = await run('recordCultureObservation', M6(C.inc, { kind, finding_text: 'Synthetic Gram-negative rods', quantity_text: 'Synthetic few' }), s.ctx);
    const o = obsOf(w, C.inc).find((x) => x['id'] === res.body.observation.id)!;
    expect(o).toMatchObject({ kind, finding_text: 'Synthetic Gram-negative rods', quantity_text: 'Synthetic few', plate_id: null, growth_code: null, recorded_by_membership_id: ACTOR_M, centre_id: CENTRE_A1 });
    expect(row(w, 'cultures', C.inc)).toMatchObject({ status: beforeCulture['status'], next_read_due_at: beforeCulture['next_read_due_at'] });
    expect(transitionsOf(w, C.inc)).toEqual([]);
    expect(res.body.culture.status).toBe('incubating');
    expect(responseErrors('recordCultureObservation', res.body)).toEqual([]);
  });

  it('a Gram stain is allowed while the culture is awaiting_setup (03-APP-FLOW §3: "Record Gram stain/microscopy"); no hours_since_planting without a planting time', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('recordCultureObservation', M6(C.setup, { kind: 'gram_stain', finding_text: 'Synthetic early stain' }), s.ctx);
    expect(row(w, 'cultures', C.setup)['status']).toBe('awaiting_setup');
    expect('hours_since_planting' in res.body.observation).toBe(false);
    expect(responseErrors('recordCultureObservation', res.body)).toEqual([]);
  });

  it.each(['gram_stain', 'microscopy', 'other'])('%s without finding_text, with an empty one, or with 2001 characters -> 400 common.validation_failed /finding_text, nothing written; 2000 characters are fine', async (kind) => {
    for (const body of [{ kind }, { kind, finding_text: '' }, { kind, finding_text: 'x'.repeat(2001) }]) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectInvalid(await failure(run('recordCultureObservation', M6(C.inc, body), s.ctx)), '/finding_text');
      expect(w).toEqual(before);
    }
    const w = mkWorld(); const s = setup(w);
    await run('recordCultureObservation', M6(C.inc, { kind, finding_text: 'x'.repeat(2000) }), s.ctx);
    expect(obsOf(w, C.inc).some((o) => o['finding_text']?.length === 2000)).toBe(true);
  });

  it.each([
    ['plate_read without growth_code', { kind: 'plate_read', plate_id: PL.inc1 }, '/growth_code'],
    ['plate_read without plate_id', { kind: 'plate_read', growth_code: 'no_growth' }, '/plate_id'],
    ['unknown growth_code', { kind: 'plate_read', plate_id: PL.inc1, growth_code: 'syn_nope' }, '/growth_code'],
    ['inactive growth_code', { kind: 'plate_read', plate_id: PL.inc1, growth_code: 'syn_retired' }, '/growth_code'],
    ['kind outside the enum', { kind: 'culture', finding_text: 'x' }, undefined],
    ['missing kind', { finding_text: 'x' }, undefined],
    ['quantity_text of 81 chars', { kind: 'gram_stain', finding_text: 'x', quantity_text: 'q'.repeat(81) }, undefined],
    ['observed_at not a timestamp', { kind: 'gram_stain', finding_text: 'x', observed_at: 'noon' }, undefined],
    ['server-owned recorded_by_membership_id (S-05)', { kind: 'gram_stain', finding_text: 'x', recorded_by_membership_id: u(0x99) }, undefined],
    ['server-owned hours_since_planting', { kind: 'gram_stain', finding_text: 'x', hours_since_planting: 1 }, undefined],
    ['server-owned culture_id / tenant_id', { kind: 'gram_stain', finding_text: 'x', culture_id: C.other, tenant_id: B }, undefined],
    ['SQL in growth_code', { kind: 'plate_read', plate_id: PL.inc1, growth_code: "no_growth' OR '1'='1" }, undefined],
  ] as [string, Row, string | undefined][])('%s -> 400 common.validation_failed, nothing written', async (_n, body, path) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await failure(run('recordCultureObservation', M6(C.inc, body), s.ctx)), path);
    expect(w).toEqual(before);
  });
});

describe('C10-T08 M6 recordCultureObservation: AC-04.4 observations are never updated; a correction is a new observation', () => {
  it('corrects_observation_id of the same culture: a NEW row is inserted, the original row is untouched, no UPDATE/DELETE statement touches culture_observations; DTO carries corrects_observation_id', async () => {
    const w = mkWorld(); const s = setup(w);
    const original = structuredClone(row(w, 'culture_observations', OBS.inc));
    const res = await run('recordCultureObservation', M6(C.inc, { kind: 'gram_stain', finding_text: 'Synthetic corrected stain', corrects_observation_id: OBS.inc }), s.ctx);
    expect(obsOf(w, C.inc)).toHaveLength(2);
    expect(row(w, 'culture_observations', OBS.inc)).toEqual(original);
    expect(s.log.filter((l) => /^\s*(UPDATE|DELETE)\b/i.test(l.sql) && /culture_observations/.test(l.sql))).toEqual([]);
    expect(res.body.observation).toMatchObject({ kind: 'gram_stain', corrects_observation_id: OBS.inc, finding_text: 'Synthetic corrected stain', is_corrected: false });
    expect(res.body.observation.id).not.toBe(OBS.inc);
    expect(schemaErrors('ObservationDto', res.body.observation)).toEqual([]);
    expect(row(w, 'cultures', C.inc)['status']).toBe('incubating');
  });
});

describe('C10-T08 M6 recordCultureObservation: AC-04.5 locks', () => {
  const BODIES: [string, (pl: string) => Row][] = [
    ['plate_read', (pl) => ({ kind: 'plate_read', plate_id: pl, growth_code: 'no_growth' })],
    ['gram_stain', () => ({ kind: 'gram_stain', finding_text: 'Synthetic stain' })],
    ['microscopy', () => ({ kind: 'microscopy', finding_text: 'Synthetic scope' })],
    ['other', () => ({ kind: 'other', finding_text: 'Synthetic note' })],
  ];
  it.each(BODIES)('%s on a final_submitted culture -> 409 micro.report_final_locked; nothing stored, culture unchanged', async (_k, body) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('recordCultureObservation', M6(C.final, body(PL.final)), s.ctx)), 'micro.report_final_locked', 409);
    expect(w).toEqual(before);
  });
  it.each(BODIES)('%s on a cancelled culture -> 409 micro.culture_invalid_transition; nothing stored, culture unchanged', async (_k, body) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('recordCultureObservation', M6(C.cancelled, body(PL.cancelled)), s.ctx)), 'micro.culture_invalid_transition', 409);
    expect(w).toEqual(before);
  });
});

// ------------------------------------------------------------------ probes
describe('C10-T08 probes: tenant binding, logging, error bodies', () => {
  const ALL: [string, Row][] = [
    ['setupCulture', M3(C.setup, { plates: PLATES2 })], ['addCulturePlate', M4(C.inc, { media_code: 'syn_blood' })], ['discardCulturePlate', M5(C.inc, PL.inc1)],
    ['recordCultureObservation', M6(C.inc, { ...READ_GROWTH })],
  ];
  it.each(ALL)('%s: every statement on a micro table binds the caller\'s tenant as a parameter and never tenant B (REQ-SEC-024); no statement is built from input text', async (op, req) => {
    const w = mkWorld(); const s = setup(w);
    await run(op, req, s.ctx);
    const micro = s.log.filter((l) => /\bmicro\./i.test(l.sql));
    expect(micro.length).toBeGreaterThan(0);
    for (const l of micro) {
      expect(l.params, l.sql).toContain(A);
      expect(l.params).not.toContain(B);
      expect(l.sql).not.toMatch(/syn_blood|syn_heavy|no_growth|Synthetic/);       // values are parameters, never interpolated
    }
  });

  it('free text and coded values are never logged (TRD §11 denylist: finding_text, quantity_text, media_code, growth_code, incubation_text)', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('recordCultureObservation', M6(C.inc, { ...READ_GROWTH, quantity_text: 'SYN-QTY-555', finding_text: 'SYN-SECRET-FINDING-777' }), s.ctx);
    await run('addCulturePlate', M4(C.inc, { media_code: 'syn_mac', incubation_text: 'SYN-INCUBATION-888' }), s.ctx);
    const text = JSON.stringify(s.logs);
    for (const secret of ['SYN-QTY-555', 'SYN-SECRET-FINDING-777', 'SYN-INCUBATION-888', 'syn_heavy']) expect(text).not.toContain(secret);
  });

  it('a rejected request does not echo the submitted free text in the problem (message / errors[])', async () => {
    const w = mkWorld(); const s = setup(w);
    const e = await failure(run('recordCultureObservation', M6(C.inc, { kind: 'gram_stain', finding_text: 'SYN-LEAK-'.padEnd(2100, 'Q') }), s.ctx));
    expectInvalid(e);
    expect(`${e.message} ${JSON.stringify(e.errors ?? [])}`).not.toContain('SYN-LEAK-');
  });
});
