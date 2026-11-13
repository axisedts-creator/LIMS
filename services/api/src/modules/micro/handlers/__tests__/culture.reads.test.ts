// C10 T-07 — culture read endpoints M1 listCultures, M2 getCulture, M15 listCultureReportVersions, M16 getCultureReportVersion WITHOUT a database:
// contract pins on micro.yaml + handler behaviour over a scripted tx (06-IMPLEMENTATION-PLAN row T-07; 02-TRD §5 M1/M2/M15/M16, §5.6 DTO allowlists + *_display (D-47), §13 access_log table + object-first rule;
// PRD AC-02.1, AC-02.3, AC-02.4, AC-17.2; 07-SECURITY T-A1, T-F1, S-01, S-02, S-25, REQ-SEC-081).
// SQL behaviour (filters, sorts, include_total cap, cursor walk, RLS centre scope) is in culture.reads.integration.test.ts (live DB, gated like T-05/T-06).
// SEAMS: handlers listCultures/getCulture/listCultureReportVersions/getCultureReportVersion in handlers/index.ts REAL map (any file layout; mappers/culture.dto.ts, service/chain.service.ts per plan).
//   - M1: ctx.ports.IdentityPort.assertRole(ctx, { permission: 'micro.culture.read' }) FIRST (no SQL on denial).
//   - M2/M15/M16: object first (RLS + explicit tenant filter), THEN assertRole(ctx, { permission: 'micro.culture.read', centreId: <culture.centre_id> }) (02-CV §10.1); denial = 403 auth.forbidden.
//   - test_code/test_name: ctx.ports.CatalogPort.getTest(ctx, { testId }) memoised per request. lab.result.read/.amend of the viewer: ctx.ports.IdentityPort.getActor(ctx).permissions (TRD §7 table).
//   - *_display: ctx.core.memberships.list(ctx, { membershipIds, activeOnly: false }) once per request; ctx.core.user(ctx, { userId }) once per distinct id; not returned/rejecting -> '—'.
//   - access log: ctx.audit.access({ action: 'culture.view', entityType: 'micro_culture', entityId, outcome: 'allowed' }) for M2 only (TRD §13: no other C10 read writes one).
//   - rows come from tx.query(sql, params) with `FROM micro.<table>` (05-SCHEMA names); the scripted tx below answers by table and emulates `<col> = $n` WHERE equalities.
// ASSUMED (spec silent): M15/`report_versions` ascending by version_no; unknown status csv value / sort value -> 400 common.validation_failed; a LabPort line is picked by order item (moduleRef.entityId = culture id).
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { failure, LAB_AMEND, LAB_READ, MANAGE, mkCtx, READ, responseErrors, run, schemaErrors, specOps, WORK, type CtxOpts, type Row } from './helpers/cultureReads.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const u = (n: number) => `0190c607-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE_A1 = u(0xa1), CENTRE_A2 = u(0xa2);
const M1 = u(0x501), M2 = u(0x502), M_GONE = u(0x503);
const U1 = u(0x601), U2 = u(0x602), U_GONE = u(0x603);
const TEST1 = u(0x701), TEST2 = u(0x702);
const ORDER = u(0x801), ITEM = u(0x802), ITEM2 = u(0x803);
const iso = (s: string) => new Date(s);

// ------------------------------------------------------------------ contract pins
describe('C10-T07 contract pins (micro.yaml)', () => {
  const ops = { listCultures: 'GET', getCulture: 'GET', listCultureReportVersions: 'GET', getCultureReportVersion: 'GET' };
  it.each(Object.keys(ops))('%s: x-permission micro.culture.read only, no idempotency, 404 declared (D-64)', (id) => {
    const op = specOps()[id];
    expect(op['x-permission']).toBe(READ);
    expect(op['x-idempotency']).toBe('none');
    expect(op['x-error-codes']).toContain('common.not_found');
    expect(Object.keys(op).filter((k) => k === 'x-permissions')).toEqual([]);
  });
  it('M1: the TRD query set, sort enum, invalid_cursor, page.total <= 10000 (S-25), limit <= 200', () => {
    const op = specOps()['listCultures'];
    const names = op.parameters.map((p: any) => p.name ?? p.$ref.split('/').pop().toLowerCase());
    for (const n of ['status', 'specimen_id', 'order_id', 'centre_id', 'received_at_from', 'received_at_to', 'read_overdue', 'has_open_instrument_records', 'updated_at_from', 'include_total', 'sort']) expect(names).toContain(n);
    expect(op.parameters.find((p: any) => p.name === 'sort').schema.enum).toEqual(['received_at', '-received_at', 'next_read_due_at', '-updated_at']);
    expect(op['x-error-codes']).toContain('common.invalid_cursor');
    expect(op.responses['200'].content['application/json'].schema.properties.page.properties.total.maximum).toBe(10000);
  });
});

// ------------------------------------------------------------------ scripted tx
interface World { micro: Record<string, Row[]> }
/** Answers `FROM micro.<table>` with the rows of that table, dropping rows that contradict a `<col> = $n` equality of the statement; records every statement. */
function scriptedTx(w: World) {
  const log: { sql: string; params: unknown[] }[] = [];
  const tx = {
    async query(sql: string, params: unknown[] = []) {
      log.push({ sql, params });
      const m = /\bFROM\s+(?:micro\.)?([a-z_]+)/i.exec(sql);
      if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql) || !m || !(m[1]! in w.micro)) return { rows: [], rowCount: 0 };
      const eqs = [...sql.matchAll(/(?:\b\w+\.)?\b([a-z_]+)\s*=\s*\$(\d+)/gi)].map((x) => [x[1]!, params[Number(x[2]) - 1]] as const);
      const rows = w.micro[m[1]!]!.filter((r) => eqs.every(([c, v]) => !(c in r) || typeof v === 'object' || String(r[c]) === String(v)));
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    },
  };
  return { tx, log };
}

const culture = (n: number, over: Row = {}): Row => ({
  id: u(0x1000 + n), tenant_id: A, centre_id: CENTRE_A1, order_id: ORDER, order_item_id: ITEM, specimen_id: u(0x900 + n), patient_id: u(0xa00 + n), test_id: TEST1,
  specimen_type_code: 'urine', specimen_site_code: null, barcode_snapshot: null, plating_protocol_id: null, status: 'incubating', outcome_code: null,
  received_at: iso('2026-11-04T04:15:00.000Z'), planted_at: iso('2026-11-04T05:00:00.000Z'), next_read_due_at: iso('2099-01-01T00:00:00.000Z'), final_due_at: null,
  last_specimen_seq: 3, current_report_version_no: 0, last_report_phase: null, chain_cancelled: false, amendment_reason_code: null, amendment_reason_text: null,
  cancel_reason_code: null, cancel_comment: null, cancelled_at: null, open_instrument_record_count: 0,
  version: 4, is_active: true, created_at: iso('2026-11-04T04:15:00.000Z'), created_by: U1, updated_at: iso('2026-11-04T06:00:00.000Z'), updated_by: U1, ...over,
});
const version = (cultureId: string, n: number, over: Row = {}): Row => ({
  id: u(0x3000 + n), tenant_id: A, centre_id: CENTRE_A1, culture_id: cultureId, order_item_id: ITEM, version_no: n, report_phase: n === 1 ? 'preliminary' : 'final', version_kind: n === 1 ? 'initial' : 'update',
  submission_kind: 'structured', outcome_code: n === 1 ? null : 'syn_positive', early_final_reason: null, amendment_reason_code: null, amendment_reason_text: null,
  culture_summary_text: `Synthetic summary ${n}`, isolates: [{ seq: 1, organism_code: 'syn_org', organism_display: 'Synthetic organism', growth_text: 'heavy growth' }],
  ast: [{ isolate_seq: 1, antibiotic_code: 'syn_abx', antibiotic_display: 'Synthetic antibiotic', method: 'mic', raw_value: '<=0.25', category_code: 'S', standard: 'CLSI', standard_version: '2026' }],
  comments_text: null, is_critical: false, flag: 'N', signed_by_membership_id: n === 2 ? M2 : M1, signed_at: iso(`2026-11-0${4 + n}T08:30:00.000Z`),
  lab_result_id: u(0x4000), lab_result_version_no: n, lab_status_at_submit: 'resulted', lab_replayed: false, created_at: iso('2026-11-04T08:30:00.000Z'), created_by: U1, ...over,
});

const FORBIDDEN_KEYS = ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'last_specimen_seq', 'barcode_snapshot', 'plating_protocol_id', 'is_active', 'cancel_comment',
  'submission_kind', 'lab_replayed', 'signed_by_membership_id', 'recorded_by_membership_id', 'planted_by_membership_id', 'culture_id'];
const keysDeep = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) x.forEach((y) => keysDeep(y, out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.add(k); keysDeep(v, out); }
  return out;
};

function setup(w: World, o: Partial<CtxOpts> = {}) {
  const s = scriptedTx(w);
  const { ctx, calls } = mkCtx({ tenantId: A, tx: s.tx, grants: [READ], tests: { [TEST1]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' }, [TEST2]: { code: 'SYN_BLOOD', name: 'Synthetic Blood Culture' } },
    members: { [M1]: 'Synthetic Tech One', [M2]: 'Synthetic Tech Two' }, users: { [U1]: 'Synthetic User One', [U2]: 'Synthetic User Two' }, ...o });
  return { ...s, ctx, calls };
}
const emptyWorld = (): World => ({ micro: { cultures: [], culture_plates: [], culture_observations: [], isolates: [], ast_results: [], culture_transitions: [], report_versions: [], plating_protocols: [], instrument_records: [],
  v_organisms: [{ code: 'syn_org', display: 'Synthetic organism' }], v_antibiotics: [{ code: 'syn_abx', display: 'Synthetic antibiotic' }] } });
const writes = (log: { sql: string }[]) => log.filter((l) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(l.sql));

// ------------------------------------------------------------------ permission first / object first
describe('C10-T07 permissions (S-23-style, D-64): micro.culture.read is the only grant that reads', () => {
  it('M1 without the grant -> 403 auth.forbidden, assertRole asked for exactly micro.culture.read, no SQL, not the T-01 stub', async () => {
    const w = emptyWorld(); w.micro['cultures'] = [culture(1)];
    for (const grants of [[], [WORK], [MANAGE], [LAB_READ]]) {
      const { ctx, calls, log } = setup(w, { grants });
      const e = await failure(run('listCultures', { query: {} }, ctx));
      expect(isLimsError(e, 'auth.forbidden'), `${grants} -> ${e?.code ?? e}`).toBe(true);
      expect(e.statusCode).toBe(403);
      expect(calls.assertRole.map((r) => r['permission'])).toEqual([READ]);
      expect(log).toEqual([]);
      expect(calls.access).toEqual([]);
    }
  });

  it.each([['getCulture', { culture_id: u(0x1001) }], ['listCultureReportVersions', { culture_id: u(0x1001) }], ['getCultureReportVersion', { culture_id: u(0x1001), version_no: 1 }]])(
    '%s on an existing culture without the grant -> 403 auth.forbidden; permission asked with the OBJECT\'s centre_id after the object was loaded; nothing logged, no data',
    async (op, params) => {
      const w = emptyWorld(); w.micro['cultures'] = [culture(1)]; w.micro['report_versions'] = [version(u(0x1001), 1)];
      const { ctx, calls, log } = setup(w, { grants: [WORK, MANAGE] });
      const e = await failure(run(op, { params }, ctx));
      expect(isLimsError(e, 'auth.forbidden'), `${e?.code ?? e}`).toBe(true);
      expect(calls.assertRole.at(-1)).toEqual({ permission: READ, centreId: CENTRE_A1 });
      expect(log.length).toBeGreaterThan(0);                                  // object first
      expect(calls.access).toEqual([]);
      expect(writes(log)).toEqual([]);
    });
});

describe('C10-T07 BOLA: not visible = 404 common.not_found, identical to missing (T-A1, S-01, S-02)', () => {
  it.each([['getCulture', {}], ['listCultureReportVersions', {}], ['getCultureReportVersion', { version_no: 1 }]])(
    '%s: a culture of tenant B (visible to nobody of A) and a random id give the same 404; no access-log row, no LabPort/Catalog call', async (op, extra) => {
      const w = emptyWorld(); w.micro['cultures'] = [culture(1, { tenant_id: B })]; w.micro['report_versions'] = [version(u(0x1001), 1, { tenant_id: B })];
      const foreign = setup(w, { grants: [READ, LAB_READ] });
      const missing = setup(w, { grants: [READ, LAB_READ] });
      const e1 = await failure(run(op, { params: { culture_id: u(0x1001), ...extra } }, foreign.ctx));
      const e2 = await failure(run(op, { params: { culture_id: u(0xdead), ...extra } }, missing.ctx));
      for (const e of [e1, e2]) { expect(isLimsError(e, 'common.not_found'), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(404); }
      expect({ code: e1.code, message: e1.message, status: e1.statusCode }).toEqual({ code: e2.code, message: e2.message, status: e2.statusCode });
      expect(foreign.calls.access).toEqual([]);
      expect(foreign.calls.lab).toEqual([]);
      expect(foreign.calls.assertRole.filter((r) => r['centreId'] !== undefined)).toEqual([]);   // no permission probe on an object that is not visible
    });

  it('M16: a version number that does not exist, and a version of ANOTHER culture of the same tenant -> 404', async () => {
    const w = emptyWorld(); w.micro['cultures'] = [culture(1), culture(2)];
    w.micro['report_versions'] = [version(u(0x1001), 1), version(u(0x1002), 2)];
    for (const [cid, no] of [[u(0x1001), 9], [u(0x1001), 2]] as const) {
      const { ctx } = setup(w);
      const e = await failure(run('getCultureReportVersion', { params: { culture_id: cid, version_no: no } }, ctx));
      expect(isLimsError(e, 'common.not_found'), `${cid}/${no}: ${e?.code ?? e}`).toBe(true);
    }
  });
});

// ------------------------------------------------------------------ M2 getCulture
describe('C10-T07 M2 getCulture — DTO, *_display (D-47), access log, read-only', () => {
  const full = (): World => {
    const w = emptyWorld(); const id = u(0x1001);
    w.micro['cultures'] = [culture(1, { status: 'final_submitted', outcome_code: 'syn_positive', current_report_version_no: 2, last_report_phase: 'final' })];
    w.micro['culture_plates'] = [
      { id: u(0x2002), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, plate_no: 2, media_code: 'syn_mac', incubation_text: null, parent_plate_id: null, source_isolate_id: null, planted_at: iso('2026-11-04T05:00:00.000Z'), planted_by_membership_id: M1, status: 'active', version: 1, is_active: true, created_by: U1, updated_by: U1 },
      { id: u(0x2001), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, plate_no: 1, media_code: 'syn_blood', incubation_text: '35C 24h', parent_plate_id: null, source_isolate_id: null, planted_at: iso('2026-11-04T05:00:00.000Z'), planted_by_membership_id: M1, status: 'active', version: 1, is_active: true, created_by: U1, updated_by: U1 }];
    w.micro['culture_observations'] = [
      { id: u(0x2101), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, plate_id: u(0x2001), kind: 'plate_read', growth_code: 'syn_growth', quantity_text: '>100000', finding_text: null, observed_at: iso('2026-11-05T05:00:00.000Z'), hours_since_planting: '24.00', recorded_by_membership_id: M1, corrects_observation_id: null, created_by: U1 },
      { id: u(0x2102), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, plate_id: u(0x2001), kind: 'plate_read', growth_code: 'syn_growth', quantity_text: '>10000', finding_text: null, observed_at: iso('2026-11-05T05:10:00.000Z'), hours_since_planting: '24.17', recorded_by_membership_id: M_GONE, corrects_observation_id: u(0x2101), created_by: U1 }];
    w.micro['isolates'] = [{ id: u(0x2201), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, specimen_id: u(0x901), isolate_seq: 1, plate_id: u(0x2001), status: 'identified', organism_code: 'syn_org', organism_source: 'manual', identified_at: iso('2026-11-05T06:00:00.000Z'), identified_by_membership_id: M1,
      colony_description: null, quantity_text: null, is_reportable: true, withdraw_reason_code: null, withdraw_comment: null, ast_panel_id: null, ast_method: 'mic', version: 2, is_active: true, created_by: U1, updated_by: U1 }];
    w.micro['ast_results'] = [{ id: u(0x2301), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, isolate_id: u(0x2201), antibiotic_code: 'syn_abx', method: 'mic', raw_value: '<=0.25', raw_qualifier: '<=', raw_numeric: '0.250000', unit_code: 'ug_ml',
      category_code: 'S', standard: 'CLSI', standard_version: '2026', standard_source: 'manual', interpretation_raw: null, interpretation_source: 'manual', breakpoint_set_id: null, breakpoint_band_id: null, suggestion_overridden: false, source: 'manual',
      instrument_record_id: null, instrument_id: null, instrument_result_time: null, is_reportable: true, report_visibility: 'shown', off_panel: false, panel_sort_order: 1, entered_by_membership_id: M1, entered_at: iso('2026-11-05T06:30:00.000Z'), version: 1, is_active: true, created_by: U1, updated_by: U1 }];
    w.micro['culture_transitions'] = [
      { id: u(0x2401), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, from_status: null, to_status: 'awaiting_setup', reason_code: null, comment: null, occurred_at: iso('2026-11-04T04:15:00.000Z'), created_by: U1 },
      { id: u(0x2402), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, from_status: 'awaiting_setup', to_status: 'incubating', reason_code: null, comment: null, occurred_at: iso('2026-11-04T05:00:00.000Z'), created_by: U1 },
      { id: u(0x2403), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, from_status: 'incubating', to_status: 'growth_detected', reason_code: null, comment: null, occurred_at: iso('2026-11-05T05:00:00.000Z'), created_by: U2 },
      { id: u(0x2404), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, from_status: 'growth_detected', to_status: 'final_submitted', reason_code: null, comment: null, occurred_at: iso('2026-11-06T05:00:00.000Z'), created_by: U_GONE }];
    w.micro['report_versions'] = [version(id, 1), version(id, 2)];
    return w;
  };
  const get = (ctx: unknown) => run('getCulture', { params: { culture_id: u(0x1001) } }, ctx);

  it('200: body conforms to CultureDetailDto (closed schema), no storage columns, test_code/test_name from CatalogPort, ISO UTC times, children in order', async () => {
    const { ctx } = setup(full());
    const r = await get(ctx);
    expect(r.status).toBe(200);
    expect(schemaErrors('CultureDetailDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: u(0x1001), version: 4, status: 'final_submitted', test_id: TEST1, test_code: 'SYN_URINE', test_name: 'Synthetic Urine Culture', centre_id: CENTRE_A1, outcome_code: 'syn_positive',
      received_at: '2026-11-04T04:15:00.000Z', current_report_version_no: 2, last_report_phase: 'final', chain_cancelled: false, open_instrument_record_count: 0 });
    for (const k of FORBIDDEN_KEYS) expect([...keysDeep(r.body)], k).not.toContain(k);
    expect(r.body.plates.map((p: Row) => p.plate_no)).toEqual([1, 2]);
    expect(r.body.observations.map((o: Row) => o.id)).toEqual([u(0x2101), u(0x2102)]);
    expect(r.body.observations.map((o: Row) => o.is_corrected)).toEqual([true, false]);
    expect(r.body.observations.map((o: Row) => o.hours_since_planting)).toEqual([24, 24.17]);   // LD-149: JSON number, 2-decimal value, never floored
    for (const o of r.body.observations) expect(schemaErrors('ObservationDto', o)).toEqual([]);
    expect(r.body.isolates).toHaveLength(1);
    expect(r.body.isolates[0].organism_display).toBe('Synthetic organism');            // from micro.v_organisms (TRD §5.6)
    expect(r.body.isolates[0].ast).toHaveLength(1);
    expect(r.body.isolates[0].ast[0].antibiotic_display).toBe('Synthetic antibiotic');   // from micro.v_antibiotics
    expect(r.body.isolates[0].ast[0]).toMatchObject({ antibiotic_code: 'syn_abx', method: 'mic', raw_numeric: '0.250000' });   // DecimalString, not a JS number
    expect(r.body.report_versions.map((v: Row) => v.version_no)).toEqual([1, 2]);
    expect(r.body.transitions.map((t: Row) => t.to_status)).toEqual(['awaiting_setup', 'incubating', 'growth_detected', 'final_submitted']);
  });

  it('D-47 *_display: ONE batched core.memberships.list {membershipIds, activeOnly:false}; core.user once per distinct user id; unknown ids show "—"; core.memberships / core.users never read via tx; getSignatories unused', async () => {
    const { ctx, calls, log } = setup(full());
    const r = await get(ctx);
    expect(calls.members).toHaveLength(1);
    expect(calls.members[0]!['activeOnly']).toBe(false);
    expect([...calls.members[0]!['membershipIds']].sort()).toEqual([M_GONE, M1, M2].sort());
    expect(calls.users.map((x) => x['userId']).sort()).toEqual([U1, U2, U_GONE].sort());       // U1 appears on 2 transitions: asked once
    expect(r.body.observations.map((o: Row) => o.recorded_by_display)).toEqual(['Synthetic Tech One', '—']);
    expect(r.body.report_versions.map((v: Row) => v.signed_by_display)).toEqual(['Synthetic Tech One', 'Synthetic Tech Two']);
    expect(r.body.transitions.map((t: Row) => t.actor_display)).toEqual(['Synthetic User One', 'Synthetic User One', 'Synthetic User Two', '—']);
    expect(log.filter((l) => /\bcore\.(memberships|users)\b/i.test(l.sql))).toEqual([]);
    expect(calls.getSignatories).toBe(0);
  });

  it('access log (TRD §13): exactly one entry { action: culture.view, entityType: micro_culture, entityId, outcome: allowed }; no PHI/barcode in it; the read writes nothing else', async () => {
    const w = full(); w.micro['cultures']![0]!['barcode_snapshot'] = 'SYNBARCODE1';
    const { ctx, calls, log } = setup(w);
    await get(ctx);
    expect(calls.access).toHaveLength(1);
    expect(calls.access[0]).toMatchObject({ action: 'culture.view', entityType: 'micro_culture', entityId: u(0x1001), outcome: 'allowed' });
    expect(JSON.stringify(calls.access[0])).not.toMatch(/SYNBARCODE1|Synthetic Tech|Synthetic Urine/);
    expect(writes(log)).toEqual([]);
  });

  it('barcode only from barcode_snapshot: present when snapshotted, key absent (not null) when not', async () => {
    const w = full(); w.micro['cultures']![0]!['barcode_snapshot'] = 'SYNBARCODE1';
    expect((await get(setup(w).ctx)).body.barcode).toBe('SYNBARCODE1');
    w.micro['cultures']![0]!['barcode_snapshot'] = null;
    const b = (await get(setup(w).ctx)).body;
    expect('barcode' in b).toBe(false);
    expect(b.specimen_site_code === undefined && !('specimen_site_code' in b)).toBe(true);   // nullable columns are omitted, never null (closed schema, no nullable)
  });

  it('every micro statement binds the tenant explicitly (REQ-SEC-024: not only RLS)', async () => {
    const { ctx, log } = setup(full());
    await get(ctx);
    const micro = log.filter((l) => /\bmicro\./i.test(l.sql));
    expect(micro.length).toBeGreaterThan(1);
    for (const l of micro) expect(l.params, l.sql).toContain(A);
  });

  it.each([
    ['incubating, next_read_due_at in the past', { status: 'incubating', next_read_due_at: iso('2020-01-01T00:00:00.000Z') }, true],
    ['incubating, next_read_due_at in the future', { status: 'incubating', next_read_due_at: iso('2099-01-01T00:00:00.000Z') }, false],
    ['awaiting_setup (no schedule yet)', { status: 'awaiting_setup', next_read_due_at: null, planted_at: null }, false],
  ])('AC-02.4 is_read_overdue: %s -> %s', async (_n, over, expected) => {
    const w = emptyWorld(); w.micro['cultures'] = [culture(1, over)];
    const r = await get(setup(w).ctx);
    expect(r.body.is_read_overdue).toBe(expected);
  });

  it('AC-02.4 the overdue flag is data (boolean), the label "Read overdue" is UI text: the API never returns a colour/label string', async () => {
    const w = emptyWorld(); w.micro['cultures'] = [culture(1, { next_read_due_at: iso('2020-01-01T00:00:00.000Z') })];
    const r = await get(setup(w).ctx);
    expect(typeof r.body.is_read_overdue).toBe('boolean');
    expect(JSON.stringify(r.body)).not.toMatch(/overdue"?\s*:\s*"/i);
  });

  // review item 2: suggested_protocol only in awaiting_setup (02-TRD.md:306, §4.2 selection via domain/selection.ts)
  const protoWorld = (status: string): World => {
    const w = emptyWorld();
    w.micro['cultures'] = [culture(1, { status, planted_at: null, next_read_due_at: null })];
    w.micro['plating_protocols'] = [
      { id: u(0x5001), tenant_id: A, code: 'syn_proto_default', version_no: 3, display: 'Synthetic default protocol', is_active: true, superseded_at: null, read_schedule_hours: [24], final_no_growth_hours: 48, requires_gram_stain: false },
      { id: u(0x5002), tenant_id: A, code: 'syn_proto_urine', version_no: 1, display: 'Synthetic urine protocol', is_active: true, superseded_at: null, read_schedule_hours: [24], final_no_growth_hours: 48, requires_gram_stain: false }];
    w.micro['plating_protocol_keys'] = [
      { id: u(0x5101), tenant_id: A, protocol_code: 'syn_proto_default', test_id: null, specimen_type_code: null, is_active: true },
      { id: u(0x5102), tenant_id: A, protocol_code: 'syn_proto_urine', test_id: TEST1, specimen_type_code: 'urine', is_active: true }];
    return w;
  };
  it('awaiting_setup: suggested_protocol = { id, code, version_no, display } of the most specific active protocol; body schema-valid', async () => {
    const r = await get(setup(protoWorld('awaiting_setup')).ctx);
    expect(r.status).toBe(200);
    expect(r.body.suggested_protocol).toEqual({ id: u(0x5002), code: 'syn_proto_urine', version_no: 1, display: 'Synthetic urine protocol' });
    expect(schemaErrors('CultureDetailDto', r.body)).toEqual([]);
  });
  it('awaiting_setup and no protocol matches -> suggested_protocol omitted (never null)', async () => {
    const w = protoWorld('awaiting_setup'); w.micro['plating_protocol_keys'] = [];
    const r = await get(setup(w).ctx);
    expect('suggested_protocol' in r.body).toBe(false);
    expect(schemaErrors('CultureDetailDto', r.body)).toEqual([]);
  });
  it.each(['incubating', 'growth_detected', 'final_submitted'])('%s: suggested_protocol is absent even though protocols exist', async (status) => {
    const r = await get(setup(protoWorld(status)).ctx);
    expect('suggested_protocol' in r.body).toBe(false);
    expect(schemaErrors('CultureDetailDto', r.body)).toEqual([]);
  });
  it('suggested_protocol lookup binds the tenant explicitly', async () => {
    const { ctx, log } = setup(protoWorld('awaiting_setup'));
    await get(ctx);
    const q = log.filter((l) => /\bplating_protocol/i.test(l.sql));
    expect(q.length).toBeGreaterThan(0);
    for (const l of q) expect(l.params, l.sql).toContain(A);
  });

  // review item 3: core.memberships.list takes <= 200 ids per call (02-TRD.md:317); the helper fake rejects more like core does
  it('D-47 chunking: 201 distinct membership ids -> two core.memberships.list calls (<= 200 each, union = all 201), no error, every name resolved', async () => {
    const w = emptyWorld(); const id = u(0x1001);
    w.micro['cultures'] = [culture(1, { status: 'final_submitted', outcome_code: 'syn_positive', current_report_version_no: 0, last_report_phase: 'final' })];
    const mem = (n: number) => `01a1a98a-ac40-7000-8000-${(0xb00000 + n).toString(16).padStart(12, '0')}`;
    const members: Record<string, string> = {};
    w.micro['culture_observations'] = Array.from({ length: 201 }, (_, n) => {
      members[mem(n)] = `Synthetic Tech ${n}`;
      return { id: u(0x6000 + n), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, plate_id: null, kind: 'note', growth_code: null, quantity_text: null, finding_text: 'synthetic', observed_at: iso('2026-11-05T05:00:00.000Z'), hours_since_planting: '24.00', recorded_by_membership_id: mem(n), corrects_observation_id: null, created_by: U1 };
    });
    const { ctx, calls } = setup(w, { members });
    const r = await get(ctx);
    expect(r.status).toBe(200);
    expect(calls.members).toHaveLength(2);
    for (const c of calls.members) { expect(c['membershipIds'].length).toBeLessThanOrEqual(200); expect(c['activeOnly']).toBe(false); }
    expect(new Set(calls.members.flatMap((c) => c['membershipIds'])).size).toBe(201);
    expect(r.body.observations).toHaveLength(201);
    expect(r.body.observations.every((o: Row) => /^Synthetic Tech \d+$/.test(o.recorded_by_display))).toBe(true);
  });
  it('D-47 chunking: exactly 200 distinct ids stay ONE call', async () => {
    const w = emptyWorld(); const id = u(0x1001);
    w.micro['cultures'] = [culture(1)];
    const mem = (n: number) => `01a1a98a-ac40-7000-8000-${(0xb00000 + n).toString(16).padStart(12, '0')}`;
    const members: Record<string, string> = {};
    w.micro['culture_observations'] = Array.from({ length: 200 }, (_, n) => {
      members[mem(n)] = `Synthetic Tech ${n}`;
      return { id: u(0x6000 + n), tenant_id: A, centre_id: CENTRE_A1, culture_id: id, plate_id: null, kind: 'note', growth_code: null, quantity_text: null, finding_text: 'synthetic', observed_at: iso('2026-11-05T05:00:00.000Z'), hours_since_planting: '24.00', recorded_by_membership_id: mem(n), corrects_observation_id: null, created_by: U1 };
    });
    const { ctx, calls } = setup(w, { members });
    expect((await get(ctx)).status).toBe(200);
    expect(calls.members).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ AC-17.2 lab_result
describe('C10-T07 AC-17.2 lab_result only for lab.result.read; permissions_hint (TRD §5.6)', () => {
  const line = (over: Row = {}) => ({ resultId: u(0x4000), orderItemId: ITEM, testId: TEST1, analyteId: u(0x4100), versionNo: 2, status: 'verified', origin: 'module', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false,
    verifiedAt: '2026-11-05T09:00:00.000Z', verifiedByMembershipId: M2, moduleRef: { module: 'micro', entityId: u(0x1001), versionNo: 2 }, ...over });
  const lab = (input: Row) => ({ orderId: input['orderId'], specimens: [], approvedSetHash: 'h', items: [
    { orderItemId: ITEM2, testId: TEST2, departmentId: u(0x4200), results: [line({ resultId: u(0x4999), orderItemId: ITEM2, status: 'approved', versionNo: 7, approvedAt: '2026-11-05T10:00:00.000Z', moduleRef: undefined })] },
    { orderItemId: ITEM, testId: TEST1, departmentId: u(0x4200), results: [line()] }] });
  const one = (): World => { const w = emptyWorld(); w.micro['cultures'] = [culture(1)]; return w; };
  const get = (ctx: unknown) => run('getCulture', { params: { culture_id: u(0x1001) } }, ctx);

  it('viewer holds lab.result.read: LabPort.getOrderResults({orderId, scope: all_visible}) once; lab_result = { result_id, status, version_no, verified_at } of THIS culture\'s order item (not the other item); body conforms', async () => {
    const { ctx, calls } = setup(one(), { grants: [READ, LAB_READ], lab });
    const r = await get(ctx);
    expect(calls.lab).toEqual([{ orderId: ORDER, scope: 'all_visible' }]);
    expect(r.body.lab_result).toEqual({ result_id: u(0x4000), status: 'verified', version_no: 2, verified_at: '2026-11-05T09:00:00.000Z' });   // approved_at absent, not null
    expect(schemaErrors('CultureDetailDto', r.body)).toEqual([]);
  });

  it('viewer lacks lab.result.read: LabPort is never called and lab_result is absent (AC-17.2, REQ-SEC-081)', async () => {
    const { ctx, calls } = setup(one(), { grants: [READ], lab });
    const r = await get(ctx);
    expect(calls.lab).toEqual([]);
    expect('lab_result' in r.body).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain(u(0x4000));
  });

  it('no C5 line for the order item -> still 200, lab_result absent', async () => {
    const { ctx } = setup(one(), { grants: [READ, LAB_READ], lab: (i: Row) => ({ orderId: i['orderId'], specimens: [], items: [], approvedSetHash: 'h' }) });
    const r = await get(ctx);
    expect(r.status).toBe(200);
    expect('lab_result' in r.body).toBe(false);
  });

  it.each([[[READ], false], [[READ, LAB_READ], false], [[READ, LAB_AMEND], true], [[READ, LAB_READ, LAB_AMEND], true]] as [string[], boolean][])(
    'permissions_hint.can_amend_approved for %j = %s (viewer holds lab.result.amend)', async (grants, expected) => {
      const { ctx } = setup(one(), { grants, lab });
      expect((await get(ctx)).body.permissions_hint).toEqual({ can_amend_approved: expected });
    });

  it.each(['listCultures', 'listCultureReportVersions', 'getCultureReportVersion'])('%s never calls the LabPort', async (op) => {
    const w = one(); w.micro['report_versions'] = [version(u(0x1001), 1)];
    const { ctx, calls } = setup(w, { grants: [READ, LAB_READ], lab });
    await run(op, { params: { culture_id: u(0x1001), version_no: 1 }, query: {} }, ctx);
    expect(calls.lab).toEqual([]);
  });
});

// ------------------------------------------------------------------ M1 list
describe('C10-T07 M1 listCultures — paging, DTO, validation (SQL filters/sorts are in the integration file)', () => {
  const many = (n: number): World => {
    const w = emptyWorld();
    w.micro['cultures'] = Array.from({ length: n }, (_x, i) => culture(i + 1, { test_id: i % 2 ? TEST2 : TEST1, received_at: iso(`2026-11-0${1 + i}T04:00:00.000Z`) }));
    return w;
  };
  const list = (ctx: unknown, query: Row = {}) => run('listCultures', { query }, ctx);

  it('200 { data, page }: data items are CultureSummaryDto (closed: no children), page.limit defaults to 50, no next_cursor when everything fits, no page.total unless include_total', async () => {
    const { ctx, calls } = setup(many(3));
    const r = await list(ctx);
    expect(r.status).toBe(200);
    expect(responseErrors('listCultures', r.body)).toEqual([]);
    expect(r.body.data).toHaveLength(3);
    expect(r.body.page).toEqual({ limit: 50 });
    for (const d of r.body.data) for (const k of ['plates', 'observations', 'isolates', 'transitions', 'report_versions', 'lab_result', 'permissions_hint', ...FORBIDDEN_KEYS]) expect(d, k).not.toHaveProperty(k);
    expect(calls.access).toEqual([]);                                  // TRD §13: only M2 writes an access_log row
    expect(calls.lab).toEqual([]);
  });

  it('limit=2 over 3 rows: 2 rows + page.next_cursor (base64url-safe, <= 512); the cursor is a string the handler accepts back', async () => {
    const { ctx } = setup(many(3));
    const r = await list(ctx, { limit: 2 });
    expect(r.body.data).toHaveLength(2);
    expect(r.body.page.limit).toBe(2);
    expect(r.body.page.next_cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    expect(responseErrors('listCultures', r.body)).toEqual([]);
  });

  it('test_code/test_name are memoised per request: 4 rows over 2 distinct tests -> CatalogPort.getTest called twice', async () => {
    const { ctx, calls } = setup(many(4));
    const r = await list(ctx);
    expect(r.body.data.map((d: Row) => d.test_name).sort()).toEqual(['Synthetic Blood Culture', 'Synthetic Blood Culture', 'Synthetic Urine Culture', 'Synthetic Urine Culture']);
    expect(calls.tests.map((t) => t['testId']).sort()).toEqual([TEST1, TEST2]);
  });

  it('T-F1 invalid cursor: a pattern-valid but undecodable cursor -> 400 common.invalid_cursor, nothing leaks', async () => {
    for (const cursor of ['AAAA', 'bm90LWpzb24', 'e30']) {
      const { ctx } = setup(many(3));
      const e = await failure(list(ctx, { cursor }));
      expect(isLimsError(e, 'common.invalid_cursor'), `${cursor}: ${e?.code ?? e}`).toBe(true);
      expect(e.statusCode).toBe(400);
    }
  });

  it('filters are bound as parameters, never concatenated (S-01/S-25 injection probe); csv status is split', async () => {
    const { ctx, log } = setup(many(1));
    const spid = u(0x777);
    await list(ctx, { status: 'awaiting_setup,incubating', specimen_id: spid, order_id: ORDER, centre_id: CENTRE_A1 });
    const q = log.find((l) => /\bFROM\s+micro\.cultures\b/i.test(l.sql))!;
    expect(q).toBeDefined();
    expect(q.sql).not.toMatch(/awaiting_setup|incubating|0190c607/);
    expect(JSON.stringify(q.params)).toContain(spid);
    expect(JSON.stringify(q.params)).toContain('awaiting_setup');
    expect(q.params).toContain(A);
  });

  it.each([['status', 'awaiting_setup,bogus'], ['sort', '-status; DROP TABLE micro.cultures'], ['sort', 'status']])(
    'unknown %s value %j -> 400 common.validation_failed, no culture SQL ran with it', async (k, v) => {
      const { ctx, log } = setup(many(1));
      const e = await failure(list(ctx, { [k]: v }));
      expect(isLimsError(e, 'common.validation_failed'), `${e?.code ?? e}`).toBe(true);
      expect(e.statusCode).toBe(400);
      expect(JSON.stringify(log)).not.toContain('DROP TABLE');
    });
});

// ------------------------------------------------------------------ M15 / M16
describe('C10-T07 M15 listCultureReportVersions / M16 getCultureReportVersion', () => {
  const w3 = (): World => {
    const w = emptyWorld(); w.micro['cultures'] = [culture(1, { current_report_version_no: 3 })];
    w.micro['report_versions'] = [version(u(0x1001), 3), version(u(0x1001), 1), version(u(0x1001), 2), version(u(0x1001), 1, { tenant_id: B, id: u(0x39ff), signed_by_membership_id: M_GONE })];
    return w;
  };

  it('M15: { data: ReportVersionSummaryDto[] } of THIS tenant\'s versions only, ascending version_no, signed_by_display via ONE core.memberships.list, no snapshot bodies, nothing logged', async () => {
    const { ctx, calls } = setup(w3());
    const r = await run('listCultureReportVersions', { params: { culture_id: u(0x1001) } }, ctx);
    expect(r.status).toBe(200);
    expect(responseErrors('listCultureReportVersions', r.body)).toEqual([]);
    expect(r.body.data.map((v: Row) => v.version_no)).toEqual([1, 2, 3]);
    expect(r.body.data.map((v: Row) => v.signed_by_display)).toEqual(['Synthetic Tech One', 'Synthetic Tech Two', 'Synthetic Tech One']);
    expect(calls.members).toHaveLength(1);
    expect(calls.members[0]!['activeOnly']).toBe(false);
    for (const k of ['culture_summary_text', 'isolates', 'ast', 'comments_text', 'lab_result_id', ...FORBIDDEN_KEYS]) expect([...keysDeep(r.body)], k).not.toContain(k);
    expect(calls.access).toEqual([]);
  });

  it('M15: a culture without versions -> 200 { data: [] }', async () => {
    const w = emptyWorld(); w.micro['cultures'] = [culture(1)];
    const r = await run('listCultureReportVersions', { params: { culture_id: u(0x1001) } }, setup(w).ctx);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [] });
  });

  it('M15/M16: a signer who is no longer returned by core.memberships.list shows "—"', async () => {
    const { ctx } = setup(w3(), { members: { [M1]: 'Synthetic Tech One' } });
    const r = await run('listCultureReportVersions', { params: { culture_id: u(0x1001) } }, ctx);
    expect(r.body.data.map((v: Row) => v.signed_by_display)).toEqual(['Synthetic Tech One', '—', 'Synthetic Tech One']);
    const r16 = await run('getCultureReportVersion', { params: { culture_id: u(0x1001), version_no: 2 } }, setup(w3(), { members: {} }).ctx);
    expect(r16.body.signed_by_display).toBe('—');
  });

  it('M16: ReportVersionDto = summary + culture_summary_text, isolates/ast snapshot, lab_result_id/version; closed schema; ISO signed_at; no storage columns; nothing logged', async () => {
    const { ctx, calls } = setup(w3());
    const r = await run('getCultureReportVersion', { params: { culture_id: u(0x1001), version_no: 2 } }, ctx);
    expect(r.status).toBe(200);
    expect(schemaErrors('ReportVersionDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ version_no: 2, report_phase: 'final', version_kind: 'update', outcome_code: 'syn_positive', signed_by_display: 'Synthetic Tech Two', signed_at: '2026-11-06T08:30:00.000Z',
      culture_summary_text: 'Synthetic summary 2', lab_result_id: u(0x4000), lab_result_version_no: 2, lab_status_at_submit: 'resulted' });
    expect(r.body.isolates).toEqual(version(u(0x1001), 2)['isolates']);
    expect(r.body.ast).toEqual(version(u(0x1001), 2)['ast']);
    for (const k of FORBIDDEN_KEYS) expect([...keysDeep(r.body)], k).not.toContain(k);
    expect(calls.access).toEqual([]);
  });

  it('M15/M16 bind tenant and culture in SQL (explicit filter besides RLS)', async () => {
    const { ctx, log } = setup(w3());
    await run('getCultureReportVersion', { params: { culture_id: u(0x1001), version_no: 1 } }, ctx);
    for (const l of log.filter((x) => /\bFROM\s+micro\.report_versions\b/i.test(x.sql))) { expect(l.params).toContain(A); expect(l.params).toContain(u(0x1001)); }
  });
});
