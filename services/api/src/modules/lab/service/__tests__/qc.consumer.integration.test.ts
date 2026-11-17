// C5 T-25 — QC consumers against the migrated database: `instruments.qc.received.v1` -> lab.qc_results, `quality.qc_run.rejected.v1` -> holdResultsSince
// (06 row T-25; 02-TRD §7.2 rows 5 and 7, §6.1; 05-SCHEMA lab.qc_results / lab.qc_holds / lab.v_pub_qc_result; PRD AC-19.1, AC-19.4; 07-SECURITY P-11, REQ-SEC-017, REQ-SEC-024).
// Needs the DB that tests/db/c5-t03/run.sh starts (see .orchestra/notes/C5.T-25-verify.cmd): LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser.
// Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1 where "database is provided" fails. Fixtures reuse the T-24 harness (ports/__tests__/harness.ts).
//
// SEAM — the writer adds services/worker/src/jobs/lab/consumers/instruments.qc.received.v1.ts and quality.qc_run.rejected.v1.ts, each exporting `handle(envelope, jobCtx): Promise<void>`
//   (ConsumerHandler, as T-27). jobCtx = worker JobContext (tenantId, actor system, tx = lims_api client in ONE job transaction under the job tenant's claims, now(): ISO string, log).
// BEHAVIOUR:
//   instruments.qc.received.v1 -> ONE lab.qc_results row per envelope idempotency_key: source 'instrument', centre_id / instrument_id / instrument_message_id / analyte_id / instrument_analyte_code /
//     mapping_status / control_* / value_raw / value_numeric / unit_raw / instrument_flags / instrument_result_time / received_at copied from the payload, idempotency_key = envelope.idempotency_key,
//     entered_by_membership_id NULL, created_by = the system actor. ON CONFLICT (tenant_id, idempotency_key) DO NOTHING: a duplicate neither inserts nor throws.
//   quality.qc_run.rejected.v1 -> holdResultsSince({ instrumentId, analyteIds, since: payload.hold_since, qcRunId, reasonCode: 'qc_run_rejected' }) in the job tx; replay with the same qc_run_id changes nothing.
// ASSUMED (spec silent): an event whose centre_id is another tenant's centre is refused (the FK rejects it -> the handler rejects -> dead letter) OR skipped; either way NO row exists afterwards (P-11).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handle as qcReceived } from '../../../../../../worker/src/jobs/lab/consumers/instruments.qc.received.v1.js';
import { handle as qcRejected } from '../../../../../../worker/src/jobs/lab/consumers/quality.qc_run.rejected.v1.js';
import { isLimsError } from '../../../../core/errors.js';
import { api, claimsOf, cleanup, closePools, L, live, NOW, NS, q, requireDb, seedFixtures, SYS, TENANT, type World } from '../../ports/__tests__/harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const A = TENANT.A, B = TENANT.B;
const CEN = L(204), CENB = L(205), DEP = L(209), T_STD = L(210);
const P = L(201), PB = L(203);
const INS = L(0x50), INS2 = L(0x51), INSB = L(0x52);
const AN1 = L(0x40), AN2 = L(0x41), AN3 = L(0x42);
const ORD = L(0x10), ORDB = L(0x11), SPEC = L(0x12), SPECB = L(0x13);
const IT = [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26].map(L), RES = [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36].map(L);
const ITB = L(0x27), RESB = L(0x37);
const u = (n: number) => `0190c60c-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const RUN = Date.now().toString(36);
let seq = 0x100;
const nextId = () => u(seq++);
const iso = (d: unknown) => new Date(d as string | Date).toISOString();

afterAll(async () => { if (live) await cleanup(NS); await closePools(); });

// ------------------------------------------------------------------ fixtures (resulted / verified / approved results for the hold consumer; tenant B twin)
const order = (id: string, patientId = P, tenantId: string = A, centreId = CEN) => ({ id, tenantId, patientId, centreId, priority: 'routine', patient: { sex: 'female', ageDays: 12000 } });
const item = (id: string, orderId: string, tenantId: string = A) => ({ id, tenantId, orderId, testId: T_STD, departmentId: DEP, workflowType: 'standard' });
const result = (id: string, orderItemId: string, analyteId: string, status: string, extra: Record<string, unknown> = {}, tenantId: string = A) =>
  ({ id, tenantId, orderItemId, testId: T_STD, analyteId, versionNo: 1, status, origin: 'manual', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false,
     ...(status === 'approved' ? { approvedAt: '2026-11-01T05:00:00.000Z' } : {}), ...extra });
const SINCE = '2026-11-01T00:00:00.000Z';
const fixtures = () => ({
  orders: [order(ORD), order(ORDB, PB, B, CENB)],
  items: [...IT.map((i) => item(i, ORD)), item(ITB, ORDB, B)],
  specimens: [
    { id: SPEC, tenantId: A, orderId: ORD, barcode: 'SYN-Q0001', specimenTypeCode: 'BLOOD', status: 'received', itemIds: IT, version: 1 },
    { id: SPECB, tenantId: B, orderId: ORDB, barcode: 'SYN-Q0002', specimenTypeCode: 'BLOOD', status: 'received', itemIds: [ITB], version: 1 },
  ],
  results: [
    result(RES[0]!, IT[0]!, AN1, 'resulted', { instrumentId: INS, resultedAt: '2026-11-04T01:00:00.000Z', valueNumeric: '12.0' }),     // held
    result(RES[1]!, IT[1]!, AN2, 'verified', { instrumentId: INS, resultedAt: '2026-11-04T02:00:00.000Z', valueNumeric: '7.0', verifiedAt: '2026-11-04T03:00:00.000Z' }),   // held
    result(RES[2]!, IT[2]!, AN1, 'approved', { instrumentId: INS, resultedAt: '2026-11-04T03:00:00.000Z', approvedAt: '2026-11-04T04:00:00.000Z', valueNumeric: '13.0' }),  // qc_review_required
    result(RES[3]!, IT[3]!, AN1, 'pending'),                                                                                               // untouched: no value
    result(RES[4]!, IT[4]!, AN1, 'resulted', { instrumentId: INS, resultedAt: '2026-10-01T01:00:00.000Z', valueNumeric: '12.0' }),         // untouched: before hold_since
    result(RES[5]!, IT[5]!, AN1, 'resulted', { instrumentId: INS2, resultedAt: '2026-11-04T01:00:00.000Z', valueNumeric: '12.0' }),        // untouched: other instrument
    result(RES[6]!, IT[6]!, AN3, 'resulted', { instrumentId: INS, resultedAt: '2026-11-04T01:00:00.000Z', valueNumeric: '12.0' }),         // untouched: analyte not listed
    result(RESB, ITB, AN1, 'resulted', { instrumentId: INS, resultedAt: '2026-11-04T01:00:00.000Z', valueNumeric: '12.0' }, B),           // other tenant, same instrument id + analyte
  ],
});

beforeAll(async () => {
  if (!live) return;
  await cleanup(NS);
  const w: World = { barcodes: new Map(), mappings: [], criticalLimits: [], grants: {} };
  await seedFixtures(w, fixtures());
}, 120_000);

describe('T-25 consumers harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); });
});

// ------------------------------------------------------------------ driving a consumer
let evN = 0;
const envelope = (type: string, tenant: string, producer: string, aggType: string, aggId: string, key: string, payload: object, eventId = nextId()) =>
  ({ event_id: eventId, event_type: type, tenant_id: tenant, producer, occurred_at: NOW, actor: { type: 'system', id: SYS }, request_id: u(0x9000 + evN++), idempotency_key: key,
     aggregate: { type: aggType, id: aggId, seq: 1 }, payload });
const qcEvent = (key: string, o: Record<string, unknown> = {}, tenant: string = A, eventId?: string) => {
  const msg = nextId();
  return envelope('instruments.qc.received.v1', tenant, 'instruments', 'instrument_message', msg, key,
    { instrument_message_id: msg, instrument_id: INS, centre_id: CEN, control_id_raw: 'CTRL-L1', control_lot_raw: 'LOT-2611', control_level: 'L1', instrument_analyte_code: 'GLU', mapping_status: 'mapped',
      analyte_id: AN1, value_raw: '5.40', value_numeric: '5.4', unit_raw: 'mmol/L', instrument_flags: ['QC'], instrument_result_time: '2026-11-05T04:00:00.000Z', received_at: NOW, ...o }, eventId);
};
const runEvent = (qcRunId: string, o: Record<string, unknown> = {}, tenant: string = A, eventId?: string) =>
  envelope('quality.qc_run.rejected.v1', tenant, 'quality', 'qc_run', qcRunId, `${qcRunId}:rejected`,
    { qc_run_id: qcRunId, instrument_id: INS, analyte_ids: [AN1, AN2], rules_violated: ['1-3s'], rule_mode: 'classic', controls_per_run: 2, run_at: '2026-11-05T03:00:00.000Z',
      hold_since: SINCE, rejected_at: NOW, ...o }, eventId);

/** One delivery = one job tx under RLS (claims of the job tenant); a throw rolls the whole tx back, like the worker wrapper. */
async function deliver(handler: typeof qcReceived, env: object, tenant: string = (env as { tenant_id: string }).tenant_id): Promise<{ error?: any }> {
  const client = await api().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claimsOf(tenant, SYS, 'system')]);
    const ctx: any = {
      tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: u(0xa000 + evN++), tx: client, now: () => NOW, attempt: 1, maxAttempts: 10, jobId: '1',
      log: { info() {}, warn() {}, error() {}, child() { return this; } },
      events: { publish: async () => ({ eventId: u(0x8000), duplicate: false }) },
      ports: { IdentityPort: { async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; } } },
    };
    try { await handler(env as never, ctx); } catch (error) { await client.query('ROLLBACK').catch(() => undefined); return { error }; }
    await client.query('COMMIT');
    return {};
  } finally { client.release(); }
}
const ok = async (p: Promise<{ error?: any }>) => { const r = await p; expect(r.error, String(r.error?.stack ?? r.error)).toBeUndefined(); };
const qcRows = (key: string, tenant: string = A) => q('SELECT * FROM lab.qc_results WHERE tenant_id = $1 AND idempotency_key = $2', [tenant, key]);
const key = (name: string) => `t25-${RUN}-${name}`;

// ================================================================== instruments.qc.received.v1 (AC-19.1)
describe.skipIf(!live)('instruments.qc.received.v1 -> lab.qc_results (AC-19.1; 02-TRD §7.2)', () => {
  it('one row, source instrument, every payload field copied, idempotency_key = envelope key, centre from the payload; visible in lab.v_pub_qc_result', async () => {
    const k = key('basic');
    const env = qcEvent(k);
    await ok(deliver(qcReceived, env));
    const rows = await qcRows(k);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({ tenant_id: A, centre_id: CEN, instrument_id: INS, instrument_message_id: env.payload.instrument_message_id, analyte_id: AN1, instrument_analyte_code: 'GLU', mapping_status: 'mapped',
      control_id_raw: 'CTRL-L1', control_lot_raw: 'LOT-2611', control_level: 'L1', value_raw: '5.40', unit_raw: 'mmol/L', instrument_flags: ['QC'], source: 'instrument', idempotency_key: k,
      entered_by_membership_id: null, created_by: SYS });
    expect(Number(r.value_numeric)).toBe(5.4);
    expect(iso(r.instrument_result_time)).toBe('2026-11-05T04:00:00.000Z');
    expect(iso(r.received_at)).toBe(NOW);
    const c = await api().connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claimsOf(A, SYS, 'system')]);
      const v = (await c.query('SELECT * FROM lab.v_pub_qc_result WHERE qc_result_id = $1', [r.id])).rows;
      await c.query('COMMIT');
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ tenant_id: A, instrument_id: INS, analyte_id: AN1, control_id_raw: 'CTRL-L1', control_lot_raw: 'LOT-2611', control_level: 'L1', value_numeric: '5.4', source: 'instrument' });
    } finally { c.release(); }
  });

  it('duplicates do nothing: the same envelope twice, and the same idempotency key under a new event id and message id -> still one row, no error', async () => {
    const k = key('dup');
    const env = qcEvent(k);
    await ok(deliver(qcReceived, env));
    await ok(deliver(qcReceived, env));
    await ok(deliver(qcReceived, qcEvent(k, { value_raw: '9.99', value_numeric: '9.99' })));   // a re-emit carrying a different value must not overwrite the first
    const rows = await qcRows(k);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value_raw: '5.40' });
  });

  it('a different idempotency key is a different row', async () => {
    await ok(deliver(qcReceived, qcEvent(key('two-a'))));
    await ok(deliver(qcReceived, qcEvent(key('two-b'))));
    expect(await qcRows(key('two-a'))).toHaveLength(1);
    expect(await qcRows(key('two-b'))).toHaveLength(1);
  });

  it('concurrent deliveries of one key (many workers) leave exactly one row and no failure', async () => {
    const k = key('race');
    const env = qcEvent(k);
    const out = await Promise.all(Array.from({ length: 8 }, () => deliver(qcReceived, env)));
    for (const r of out) expect(r.error, String(r.error?.stack ?? r.error)).toBeUndefined();
    expect(await qcRows(k)).toHaveLength(1);
  });

  it('an unmapped code is stored as received: analyte_id NULL, mapping_status unmapped, value_raw kept, no value_numeric', async () => {
    const k = key('unmapped');
    const env = qcEvent(k, { mapping_status: 'unmapped', instrument_analyte_code: 'XYZ-9', value_raw: '>>>' });
    delete (env.payload as Record<string, unknown>)['analyte_id'];
    delete (env.payload as Record<string, unknown>)['value_numeric'];
    await ok(deliver(qcReceived, env));
    const rows = await qcRows(k);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ analyte_id: null, mapping_status: 'unmapped', instrument_analyte_code: 'XYZ-9', value_raw: '>>>', value_numeric: null, source: 'instrument' });
  });

  it('optional fields absent: lot, level, unit, flags, instrument_result_time -> NULL / empty array, row still stored', async () => {
    const k = key('minimal');
    const env = qcEvent(k);
    for (const f of ['control_lot_raw', 'control_level', 'unit_raw', 'instrument_flags', 'instrument_result_time']) delete (env.payload as Record<string, unknown>)[f];
    await ok(deliver(qcReceived, env));
    const rows = await qcRows(k);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ control_lot_raw: null, control_level: null, unit_raw: null, instrument_flags: [], instrument_result_time: null });
  });

  it('REQ-SEC-024 / P-11: an envelope of tenant B on a tenant-A job is refused (common.internal) and writes no row in either tenant', async () => {
    const k = key('xtenant');
    const r = await deliver(qcReceived, qcEvent(k, { centre_id: CENB }, B), A);
    expect(isLimsError(r.error, 'common.internal'), String(r.error?.stack ?? r.error)).toBe(true);
    expect(await qcRows(k, A)).toHaveLength(0);
    expect(await qcRows(k, B)).toHaveLength(0);
  });

  it('P-11: a tenant-A event naming tenant B\'s centre writes no row (refused by the FK / skipped), never a cross-tenant row', async () => {
    const k = key('foreign-centre');
    await deliver(qcReceived, qcEvent(k, { centre_id: CENB }));   // outcome (throw = dead letter, or skip) is the consumer's; the data outcome is not
    expect(await qcRows(k, A)).toHaveLength(0);
    expect(await qcRows(k, B)).toHaveLength(0);
    expect(await q('SELECT 1 FROM lab.qc_results WHERE idempotency_key = $1', [k])).toHaveLength(0);
  });

  it('the same idempotency key in two tenants is two independent rows (the unique key is per tenant)', async () => {
    const k = key('per-tenant');
    await ok(deliver(qcReceived, qcEvent(k)));
    await ok(deliver(qcReceived, qcEvent(k, { centre_id: CENB }, B)));
    expect(await qcRows(k, A)).toHaveLength(1);
    expect(await qcRows(k, B)).toHaveLength(1);
  });

  it('over-long raw fields (beyond the qc_results__lens__ck limits) reject the delivery and write nothing (no truncation, no silent ack)', async () => {
    const k = key('long');
    const r = await deliver(qcReceived, qcEvent(k, { control_id_raw: 'C'.repeat(65) }));
    expect(r.error).toBeInstanceOf(Error);
    expect(await qcRows(k)).toHaveLength(0);
  });
});

// ================================================================== quality.qc_run.rejected.v1 (AC-19.4)
describe.skipIf(!live)('quality.qc_run.rejected.v1 -> holdResultsSince (AC-19.4; 02-TRD §6.1, §7.2)', () => {
  const resultRows = async () => Object.fromEntries((await q('SELECT id, version, on_hold, hold_id, qc_review_required FROM lab.results WHERE id = ANY($1)', [[...RES, RESB]])).map((r) => [r.id, r]));
  const sortedIds = (a: string[]) => [...a].sort();

  it('non-approved matching results go on_hold once, approved ones qc_review_required once; one qc_holds row (reason qc_run_rejected, since = hold_since); replay = same lists, rows untouched', async () => {
    const run = u(0x7001);
    await ok(deliver(qcRejected, runEvent(run)));
    const holds = await q('SELECT * FROM lab.qc_holds WHERE tenant_id = $1 AND qc_run_id = $2', [A, run]);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ status: 'active', instrument_id: INS, reason_code: 'qc_run_rejected' });
    expect(sortedIds(holds[0].analyte_ids)).toEqual(sortedIds([AN1, AN2]));
    expect(iso(holds[0].since)).toBe(SINCE);
    expect(sortedIds(holds[0].held_result_ids)).toEqual(sortedIds([RES[0]!, RES[1]!]));
    expect(holds[0].review_flagged_result_ids).toEqual([RES[2]]);
    const before = await resultRows();
    for (const id of [RES[0]!, RES[1]!]) expect(before[id], id).toMatchObject({ on_hold: true, hold_id: holds[0].id, qc_review_required: false });
    expect(before[RES[2]!]).toMatchObject({ on_hold: false, qc_review_required: true });
    for (const id of [RES[3]!, RES[4]!, RES[5]!, RES[6]!, RESB]) expect(before[id], id).toMatchObject({ on_hold: false, hold_id: null, qc_review_required: false });

    await ok(deliver(qcRejected, runEvent(run)));                                            // the very same envelope again
    await ok(deliver(qcRejected, runEvent(run, {}, A, nextId())));                           // the same qc_run_id under a new event id
    expect(await q('SELECT 1 FROM lab.qc_holds WHERE tenant_id = $1 AND qc_run_id = $2', [A, run])).toHaveLength(1);
    const again = await q('SELECT held_result_ids, review_flagged_result_ids FROM lab.qc_holds WHERE tenant_id = $1 AND qc_run_id = $2', [A, run]);
    expect([sortedIds(again[0].held_result_ids), again[0].review_flagged_result_ids]).toEqual([sortedIds([RES[0]!, RES[1]!]), [RES[2]]]);
    const after = await resultRows();
    for (const id of [...RES, RESB]) expect(after[id]!.version, `redelivery must not rewrite ${id}`).toBe(before[id]!.version);
  });

  it('a second, different qc_run_id on the same instrument is its own hold (unique per run, not per instrument)', async () => {
    const run = u(0x7002);
    await ok(deliver(qcRejected, runEvent(run, { analyte_ids: [AN3] })));
    const holds = await q('SELECT * FROM lab.qc_holds WHERE tenant_id = $1 AND qc_run_id = $2', [A, run]);
    expect(holds).toHaveLength(1);
    expect(holds[0].held_result_ids).toEqual([RES[6]]);
  });

  it('REQ-SEC-024 / P-11: a tenant-B envelope on a tenant-A job is refused (common.internal), no hold and no result changes; tenant B\'s own results are never touched by an A event', async () => {
    const run = u(0x7003);
    const r = await deliver(qcRejected, runEvent(run, {}, B), A);
    expect(isLimsError(r.error, 'common.internal'), String(r.error?.stack ?? r.error)).toBe(true);
    expect(await q('SELECT 1 FROM lab.qc_holds WHERE qc_run_id = $1', [run])).toHaveLength(0);
    const rows = await resultRows();
    expect(rows[RESB]).toMatchObject({ on_hold: false, hold_id: null, qc_review_required: false });
  });

  it('many workers delivering one qc_run_id at once: one hold row, every result written once, no failure', async () => {
    const run = u(0x7004);
    const before = await resultRows();
    const out = await Promise.all(Array.from({ length: 6 }, () => deliver(qcRejected, runEvent(run, { analyte_ids: [AN1, AN2, AN3] }))));
    for (const r of out) expect(r.error, String(r.error?.stack ?? r.error)).toBeUndefined();
    const holds = await q('SELECT * FROM lab.qc_holds WHERE tenant_id = $1 AND qc_run_id = $2', [A, run]);
    expect(holds).toHaveLength(1);
    const after = await resultRows();
    for (const id of [...RES, RESB]) expect(after[id]!.version - before[id]!.version, `${id} written at most once by this run`).toBeLessThanOrEqual(1);
  });
});
