// C5 T-04 — typed publishers for the 7 lab events (06-IMPLEMENTATION-PLAN row T-04; 02-TRD §7.1; 03-IC §3.7–§3.13).
// done_when: "every payload validates against its schema; idempotency keys match 02-TRD s7.1 / 03-IC".
// ACs: AC-01.1 (two specimens -> two status_changed, from_status absent, to ordered),
//      AC-05.1 (rejection + recollection -> status_changed, rejected, status_changed, status_changed),
//      AC-05.5 / AC-16.5 (repeat -> same key -> not re-published). Security: S-12 / REQ-SEC-006 (no value/barcode/comment in events).
// Real core `createEvents({ producer: 'lab' })` (T0D-08) + in-memory tx fake, so the real envelope schemas validate every publish.
// Interface expected from the writer (../publish.ts). Names marked SEAM are not fixed by the spec:
//   export function createLabEvents(events: { publish(ctx, type, input): Promise<{ eventId: string; duplicate: boolean }> })   (SEAM)
//     -> { specimenStatusChanged(ctx, payload, { specimenVersion }),          aggregate { specimen, specimen_id, seq = specimenVersion }
//          specimenRejected(ctx, payload, { specimenVersion }),               aggregate { specimen, specimen_id, seq = specimenVersion }
//          resultVerified(ctx, payload, { resultRowVersion }),                aggregate { result, result_id, seq = resultRowVersion }
//          resultApproved(ctx, payload, { resultRowVersion }),                aggregate { result, result_id, seq = resultRowVersion }
//          resultAmended(ctx, payload, { resultRowVersion }),                 aggregate { result, result_id, seq = resultRowVersion }
//          orderReadyForReport(ctx, payloadWithoutHash, { approvedSet, readinessSeq }),  aggregate { order, order_id, seq = readinessSeq }
//          criticalValueDetected(ctx, payload, { value, resultRowVersion }) } aggregate { result, result_id, seq = resultRowVersion }
//     `payload` = the 03-IC payload exactly (snake_case, ISO-UTC strings); `approvedSet` = [{ result_id, version_no }];
//     `value` = { kind: 'n' | 'o' | 't', value: string }. Each method returns the core publish result ({ eventId, duplicate }).
//     The publisher fills `approved_set_hash` itself (callers do not pass it) and never adds keys outside the IC schema.
//   export function approvedSetHash(set: readonly { result_id: string; version_no: number }[]): string
//        SHA-256 hex of the sorted-ascending `result_id:version_no` strings joined by "\n" (02-TRD §4.7).
//   export function valueSha256Prefix16(value: { kind: 'n' | 'o' | 't'; value: string }): string
//        first 16 hex of SHA-256 over `n:<decimal>` / `o:<code>` / `t:<text>` (02-TRD §7.1 [CONV]).
// Synthetic data only.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { ctxFor, makeEventDb, rejection, TENANT_A, TENANT_B } from '../../../../core/events/__tests__/helpers.js';
import { manifest } from '../../index.js';
import { approvedSetHash, createLabEvents, valueSha256Prefix16 } from '../publish.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const SPEC1 = V7('000000090001');
const SPEC2 = V7('000000090002');
const SPEC_NEW = V7('000000090003');
const ORDER = V7('000000050001');
const PATIENT = V7('000000040001');
const CENTRE = V7('000000020002');
const BRANCH = V7('000000010001');
const ITEM1 = V7('000000060001');
const ITEM2 = V7('000000060002');
const RES1 = V7('0000000a0001');
const RES2 = V7('0000000a0002');
const TEST = V7('000000070001');
const ANALYTE = V7('000000080001');
const DEPT = V7('000000150001');
const MEMBER = V7('000000030002');
const AT = '2026-11-05T03:20:41.300Z';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function setup() {
  const db = makeEventDb();
  const lab = createLabEvents(createEvents({ producer: 'lab' }) as never);
  const ctx = ctxFor(db) as never;
  const run = <T>(fn: () => Promise<T>) => db.transaction(fn);
  const stored = (type: string) => db.events.filter((e) => e.eventType === type);
  return { db, lab, ctx, run, stored };
}

const changed = (over: Record<string, unknown> = {}) => ({
  specimen_id: SPEC1, order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, processing_branch_id: BRANCH,
  specimen_type_code: 'EDTA_WB', to_status: 'ordered', changed_at: AT, order_item_ids: [ITEM1], ...over,
});
const rejectedP = (over: Record<string, unknown> = {}) => ({
  specimen_id: SPEC1, order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, reason_code: 'haemolysed',
  rejected_at: '2026-11-05T03:25:00.000Z', recollection_required: true, order_item_ids: [ITEM1], ...over,
});
const verifiedP = (over: Record<string, unknown> = {}) => ({
  result_id: RES1, result_version_no: 1, order_id: ORDER, order_item_id: ITEM1, specimen_id: SPEC1, test_id: TEST,
  analyte_id: ANALYTE, department_id: DEPT, origin: 'instrument', mode: 'manual', verified_at: '2026-11-05T04:02:10.000Z',
  verified_by_membership_id: MEMBER, ...over,
});
const approvedP = (over: Record<string, unknown> = {}) => ({
  result_id: RES1, result_version_no: 1, order_id: ORDER, order_item_id: ITEM1, test_id: TEST, analyte_id: ANALYTE,
  department_id: DEPT, approved_at: '2026-11-05T04:30:00.000Z', approved_by_membership_id: V7('000000030003'), ...over,
});
const amendedP = (over: Record<string, unknown> = {}) => ({
  result_id: RES1, previous_version_no: 1, new_version_no: 2, order_id: ORDER, order_item_id: ITEM1, test_id: TEST,
  analyte_id: ANALYTE, amendment_reason_code: 'transcription_error', amended_at: '2026-11-06T05:00:00.000Z',
  amended_by_membership_id: V7('000000030003'), ...over,
});
const readyP = (over: Record<string, unknown> = {}) => ({
  order_id: ORDER, completeness: 'complete', order_item_ids: [ITEM1, ITEM2], contains_amendment: false,
  ready_at: '2026-11-05T04:30:01.000Z', ...over,
});
const criticalP = (over: Record<string, unknown> = {}) => ({
  critical_event_id: V7('000000160001'), result_id: RES2, result_version_no: 1, order_id: ORDER, patient_id: PATIENT,
  centre_id: CENTRE, analyte_id: V7('000000080002'), direction: 'high', detected_at: '2026-11-05T03:58:00.000Z', ...over,
});
const SET = [{ result_id: RES1, version_no: 1 }, { result_id: RES2, version_no: 1 }];
const VAL = { kind: 'n' as const, value: '7.5' };

// ---------------------------------------------------------------------------------------------------------------
describe('pure helpers (02-TRD §7.1, §4.7)', () => {
  it('approvedSetHash = sha256 of the ascending-sorted "result_id:version_no" lines joined by \\n', () => {
    const lines = [`${RES1}:1`, `${RES2}:3`].sort();
    expect(approvedSetHash([{ result_id: RES2, version_no: 3 }, { result_id: RES1, version_no: 1 }])).toBe(sha256(lines.join('\n')));
  });
  it('approvedSetHash is order-insensitive, lower-case 64 hex, and changes when one version changes (amendment)', () => {
    const a = approvedSetHash(SET);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(approvedSetHash([...SET].reverse())).toBe(a);
    expect(approvedSetHash([SET[0]!, { result_id: RES2, version_no: 2 }])).not.toBe(a);
    expect(approvedSetHash([SET[0]!])).not.toBe(a);
  });
  it('approvedSetHash sorts as strings (not numerically): 10 sorts before 2', () => {
    const s = [{ result_id: RES1, version_no: 2 }, { result_id: RES1, version_no: 10 }];
    expect(approvedSetHash(s)).toBe(sha256([`${RES1}:10`, `${RES1}:2`].join('\n')));
  });
  it.each([
    [{ kind: 'n', value: '7.5' }, 'n:7.5'],
    [{ kind: 'o', value: 'POS' }, 'o:POS'],
    [{ kind: 't', value: 'no growth' }, 't:no growth'],
  ] as const)('valueSha256Prefix16 %j hashes %s', (v, canonical) => {
    expect(valueSha256Prefix16(v)).toBe(sha256(canonical).slice(0, 16));
  });
  it('valueSha256Prefix16 distinguishes kinds and values', () => {
    const s = new Set([
      valueSha256Prefix16({ kind: 'n', value: '7.5' }), valueSha256Prefix16({ kind: 't', value: '7.5' }),
      valueSha256Prefix16({ kind: 'n', value: '7.50' }), valueSha256Prefix16({ kind: 'o', value: '7.5' }),
    ]);
    expect(s.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('idempotency keys + aggregate (02-TRD §7.1 table, 03-IC §3.7–3.13)', () => {
  it('lab.specimen.status_changed.v1: <specimen_id>:<to_status>:<specimen_version>, aggregate specimen/seq = version', async () => {
    const s = setup();
    await s.run(() => s.lab.specimenStatusChanged(s.ctx, changed({ from_status: 'in_transit', to_status: 'received' }), { specimenVersion: 4 }));
    const e = s.stored('lab.specimen.status_changed.v1')[0]!;
    expect(e.key).toBe(`${SPEC1}:received:4`);
    expect(e.envelope).toMatchObject({ producer: 'lab', aggregate: { type: 'specimen', id: SPEC1, seq: 4 }, tenant_id: TENANT_A });
  });
  it('lab.specimen.rejected.v1: <specimen_id>:rejected, aggregate specimen', async () => {
    const s = setup();
    await s.run(() => s.lab.specimenRejected(s.ctx, rejectedP(), { specimenVersion: 3 }));
    const e = s.stored('lab.specimen.rejected.v1')[0]!;
    expect(e.key).toBe(`${SPEC1}:rejected`);
    expect(e.envelope.aggregate).toMatchObject({ type: 'specimen', id: SPEC1 });
  });
  it('lab.result.verified.v1: <result_id>:verified:<result_version_no>:<result_row_version>, aggregate result/seq = row version', async () => {
    const s = setup();
    await s.run(() => s.lab.resultVerified(s.ctx, verifiedP({ result_version_no: 2 }), { resultRowVersion: 7 }));
    const e = s.stored('lab.result.verified.v1')[0]!;
    expect(e.key).toBe(`${RES1}:verified:2:7`);
    expect(e.envelope.aggregate).toMatchObject({ type: 'result', id: RES1, seq: 7 });
  });
  it('lab.result.approved.v1: <result_id>:approved:1', async () => {
    const s = setup();
    await s.run(() => s.lab.resultApproved(s.ctx, approvedP(), { resultRowVersion: 8 }));
    const e = s.stored('lab.result.approved.v1')[0]!;
    expect(e.key).toBe(`${RES1}:approved:1`);
    expect(e.envelope.aggregate).toMatchObject({ type: 'result', id: RES1, seq: 8 });
  });
  it('lab.result.amended.v1: <result_id>:amended:<new_version_no>', async () => {
    const s = setup();
    await s.run(() => s.lab.resultAmended(s.ctx, amendedP({ previous_version_no: 2, new_version_no: 3 }), { resultRowVersion: 9 }));
    const e = s.stored('lab.result.amended.v1')[0]!;
    expect(e.key).toBe(`${RES1}:amended:3`);
    expect(e.envelope.aggregate).toMatchObject({ type: 'result', id: RES1, seq: 9 });
  });
  it('lab.order.ready_for_report.v1: <order_id>:ready:<approved_set_hash>; payload carries the same computed hash; aggregate order', async () => {
    const s = setup();
    await s.run(() => s.lab.orderReadyForReport(s.ctx, readyP(), { approvedSet: SET, readinessSeq: 2 }));
    const e = s.stored('lab.order.ready_for_report.v1')[0]!;
    const h = approvedSetHash(SET);
    expect(e.key).toBe(`${ORDER}:ready:${h}`);
    expect(e.envelope.payload.approved_set_hash).toBe(h);
    expect(e.envelope.aggregate).toMatchObject({ type: 'order', id: ORDER, seq: 2 });
  });
  it('lab.critical_value.detected.v1: <result_id>:critical:<result_version_no>:<value_sha256_prefix16>; the value itself is not in the event', async () => {
    const s = setup();
    const secret = { kind: 't' as const, value: 'SENTINEL-VALUE-91827' };
    await s.run(() => s.lab.criticalValueDetected(s.ctx, criticalP({ result_version_no: 2 }), { value: secret, resultRowVersion: 5 }));
    const e = s.stored('lab.critical_value.detected.v1')[0]!;
    expect(e.key).toBe(`${RES2}:critical:2:${valueSha256Prefix16(secret)}`);
    expect(e.envelope.aggregate).toMatchObject({ type: 'result', id: RES2, seq: 5 });
    expect(JSON.stringify(e.envelope)).not.toContain('SENTINEL-VALUE-91827');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('idempotency behaviour: same key -> not re-published; different key -> new event', () => {
  it('status_changed: same (specimen, to_status, version) twice -> one stored, second duplicate:true; new version -> new event', async () => {
    const s = setup();
    const a = await s.run(() => s.lab.specimenStatusChanged(s.ctx, changed(), { specimenVersion: 1 }));
    const b = await s.run(() => s.lab.specimenStatusChanged(s.ctx, changed(), { specimenVersion: 1 }));
    expect(a.duplicate).toBe(false);
    expect(b).toMatchObject({ duplicate: true, eventId: a.eventId });
    expect(s.stored('lab.specimen.status_changed.v1')).toHaveLength(1);
    await s.run(() => s.lab.specimenStatusChanged(s.ctx, changed(), { specimenVersion: 2 }));
    expect(s.stored('lab.specimen.status_changed.v1')).toHaveLength(2);
  });
  it('AC-05.5: a second rejected event for the same specimen is a duplicate (key <specimen_id>:rejected)', async () => {
    const s = setup();
    await s.run(() => s.lab.specimenRejected(s.ctx, rejectedP({ recollection_required: false }), { specimenVersion: 2 }));
    const again = await s.run(() => s.lab.specimenRejected(s.ctx, rejectedP({ recollection_required: true }), { specimenVersion: 5 }));
    expect(again.duplicate).toBe(true);
    expect(s.stored('lab.specimen.rejected.v1')).toHaveLength(1);
  });
  it('verified: same result_version_no, different row version -> distinct events', async () => {
    const s = setup();
    await s.run(() => s.lab.resultVerified(s.ctx, verifiedP(), { resultRowVersion: 3 }));
    await s.run(() => s.lab.resultVerified(s.ctx, verifiedP(), { resultRowVersion: 4 }));
    await s.run(() => s.lab.resultVerified(s.ctx, verifiedP(), { resultRowVersion: 4 }));
    expect(s.stored('lab.result.verified.v1').map((e) => e.key)).toEqual([`${RES1}:verified:1:3`, `${RES1}:verified:1:4`]);
  });
  it('AC-16.5: ready_for_report with an unchanged approved set emits once; an amended version re-emits', async () => {
    const s = setup();
    await s.run(() => s.lab.orderReadyForReport(s.ctx, readyP(), { approvedSet: SET, readinessSeq: 1 }));
    const same = await s.run(() => s.lab.orderReadyForReport(s.ctx, readyP(), { approvedSet: [...SET].reverse(), readinessSeq: 2 }));
    expect(same.duplicate).toBe(true);
    await s.run(() => s.lab.orderReadyForReport(s.ctx, readyP({ contains_amendment: true }),
      { approvedSet: [SET[0]!, { result_id: RES2, version_no: 2 }], readinessSeq: 3 }));
    expect(s.stored('lab.order.ready_for_report.v1')).toHaveLength(2);
  });
  it('critical: same result+version+value once; changed value at same version, or same value at a new version -> new event', async () => {
    const s = setup();
    const pub = (p: Record<string, unknown>, v: { kind: 'n'; value: string }) =>
      s.run(() => s.lab.criticalValueDetected(s.ctx, criticalP(p), { value: v, resultRowVersion: 1 }));
    expect((await pub({}, VAL)).duplicate).toBe(false);
    expect((await pub({}, VAL)).duplicate).toBe(true);
    expect((await pub({}, { kind: 'n', value: '8.1' })).duplicate).toBe(false);
    expect((await pub({ result_version_no: 2 }, VAL)).duplicate).toBe(false);
    expect(s.stored('lab.critical_value.detected.v1')).toHaveLength(3);
  });
  it('tenant isolation: the same key under tenant B is a separate event; tenant comes from ctx, never the payload', async () => {
    const s = setup();
    await s.run(() => s.lab.specimenStatusChanged(s.ctx, changed(), { specimenVersion: 1 }));
    const ctxB = ctxFor(s.db, { tenantId: TENANT_B }) as never;
    const b = await s.run(() => s.lab.specimenStatusChanged(ctxB, changed({ tenant_id: TENANT_A }), { specimenVersion: 1 }).catch((e) => e));
    // either rejected (tenant_id is not an IC field) or stored under B — never stored under A twice
    if (!(b instanceof Error)) expect(s.db.events.map((e) => e.tenantId).sort()).toEqual([TENANT_A, TENANT_B].sort());
    expect(s.db.events.filter((e) => e.tenantId === TENANT_A)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('AC-01.1 — order consumer: two specimens -> two status_changed with from_status absent, to_status ordered', () => {
  it('publishes one event per specimen, no from_status key, distinct keys, version 1', async () => {
    const s = setup();
    await s.run(async () => {
      await s.lab.specimenStatusChanged(s.ctx, changed({ specimen_id: SPEC1, specimen_type_code: 'EDTA_WB' }), { specimenVersion: 1 });
      await s.lab.specimenStatusChanged(s.ctx, changed({ specimen_id: SPEC2, specimen_type_code: 'SERUM', order_item_ids: [ITEM2] }), { specimenVersion: 1 });
    });
    const ev = s.stored('lab.specimen.status_changed.v1');
    expect(ev).toHaveLength(2);
    expect(ev.map((e) => e.key)).toEqual([`${SPEC1}:ordered:1`, `${SPEC2}:ordered:1`]);
    for (const e of ev) {
      expect(e.envelope.payload.to_status).toBe('ordered');
      expect(e.envelope.payload).not.toHaveProperty('from_status');
      expect(e.envelope.payload).not.toHaveProperty('barcode'); // IC §3.7 PHI class P1: no barcode
    }
  });
});

describe('AC-05.1 — rejection with recollection: 4 events in one transaction', () => {
  const body = (s: ReturnType<typeof setup>) => async () => {
    await s.lab.specimenStatusChanged(s.ctx, changed({ from_status: 'received', to_status: 'rejected' }), { specimenVersion: 3 });
    await s.lab.specimenRejected(s.ctx, rejectedP(), { specimenVersion: 3 });
    await s.lab.specimenStatusChanged(s.ctx, changed({ from_status: 'rejected', to_status: 'recollection_ordered' }), { specimenVersion: 4 });
    await s.lab.specimenStatusChanged(s.ctx, changed({ specimen_id: SPEC_NEW, replaces_specimen_id: SPEC1, to_status: 'ordered' }), { specimenVersion: 1 });
  };
  it('stores status_changed(->rejected), rejected(recollection_required), status_changed(->recollection_ordered), status_changed(new: absent->ordered)', async () => {
    const s = setup();
    await s.run(body(s));
    expect(s.db.events.map((e) => e.key)).toEqual([
      `${SPEC1}:rejected:3`, `${SPEC1}:rejected`, `${SPEC1}:recollection_ordered:4`, `${SPEC_NEW}:ordered:1`,
    ]);
    expect(s.db.events.map((e) => e.eventType)).toEqual([
      'lab.specimen.status_changed.v1', 'lab.specimen.rejected.v1', 'lab.specimen.status_changed.v1', 'lab.specimen.status_changed.v1',
    ]);
    const rej = s.stored('lab.specimen.rejected.v1')[0]!.envelope.payload;
    expect(rej).toMatchObject({ reason_code: 'haemolysed', recollection_required: true, order_item_ids: [ITEM1] });
    const fresh = s.db.events[3]!.envelope.payload;
    expect(fresh).toMatchObject({ specimen_id: SPEC_NEW, replaces_specimen_id: SPEC1, to_status: 'ordered' });
    expect(fresh).not.toHaveProperty('from_status');
  });
  it('rolls back with the caller transaction: nothing is stored when the transaction fails after publishing', async () => {
    const s = setup();
    await rejection(s.db.transaction(body(s), { rollback: true }));
    expect(s.db.events).toHaveLength(0);
  });
  it('rejected event carries no free-text comment (IC §3.8) and the C4 collected_by/home_visit ids are optional', async () => {
    const s = setup();
    await s.run(() => s.lab.specimenRejected(s.ctx, rejectedP({ collected_by_membership_id: MEMBER, home_visit_id: V7('0000000b0001') }), { specimenVersion: 1 }));
    const p = s.stored('lab.specimen.rejected.v1')[0]!.envelope.payload;
    expect(Object.keys(p).sort()).toEqual([
      'centre_id', 'collected_by_membership_id', 'home_visit_id', 'order_id', 'order_item_ids', 'patient_id', 'reason_code',
      'recollection_required', 'rejected_at', 'specimen_id',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('conditional fields (02-TRD §7.1, 08 A13 P-5 / D-2)', () => {
  it('verified without specimen_id (usesExistingMaterial) validates', async () => {
    const s = setup();
    const { specimen_id: _drop, ...noSpecimen } = verifiedP();
    await s.run(() => s.lab.resultVerified(s.ctx, noSpecimen, { resultRowVersion: 2 }));
    expect(s.stored('lab.result.verified.v1')[0]!.envelope.payload).not.toHaveProperty('specimen_id');
  });
  it('verified mode=auto without verified_by_membership_id validates; with it -> schema violation', async () => {
    const s = setup();
    const { verified_by_membership_id: _drop, ...auto } = verifiedP({ mode: 'auto', origin: 'instrument' });
    await s.run(() => s.lab.resultVerified(s.ctx, auto, { resultRowVersion: 2 }));
    expect(s.stored('lab.result.verified.v1')[0]!.envelope.payload.mode).toBe('auto');
    const e = await rejection(s.run(() => s.lab.resultVerified(s.ctx, verifiedP({ mode: 'auto', result_id: RES2 }), { resultRowVersion: 1 })));
    expect(e.code).toBe('common.internal');
  });
  it('verified mode=manual without verified_by_membership_id -> schema violation, nothing stored', async () => {
    const s = setup();
    const { verified_by_membership_id: _drop, ...bad } = verifiedP();
    const e = await rejection(s.run(() => s.lab.resultVerified(s.ctx, bad, { resultRowVersion: 1 })));
    expect(e.code).toBe('common.internal');
    expect(s.db.events).toHaveLength(0);
  });
  it('processing_branch_id is optional on status_changed and verified', async () => {
    const s = setup();
    const { processing_branch_id: _a, ...p1 } = changed();
    await s.run(() => s.lab.specimenStatusChanged(s.ctx, p1, { specimenVersion: 1 }));
    await s.run(() => s.lab.resultVerified(s.ctx, verifiedP({ processing_branch_id: BRANCH }), { resultRowVersion: 1 }));
    expect(s.db.events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('schema strictness / negative cases: nothing invalid reaches core.event_log (REQ-SEC-080)', () => {
  const cases: Array<[string, (s: ReturnType<typeof setup>) => Promise<unknown>]> = [
    ['status_changed: unknown to_status', (s) => s.lab.specimenStatusChanged(s.ctx, changed({ to_status: 'lost' }), { specimenVersion: 1 })],
    ['status_changed: non-UTC timestamp', (s) => s.lab.specimenStatusChanged(s.ctx, changed({ changed_at: '2026-11-05T03:20:41+05:45' }), { specimenVersion: 1 })],
    ['status_changed: order_item_ids > 200', (s) => s.lab.specimenStatusChanged(s.ctx, changed({ order_item_ids: Array.from({ length: 201 }, () => ITEM1) }), { specimenVersion: 1 })],
    ['status_changed: missing patient_id', (s) => { const { patient_id: _p, ...p } = changed(); return s.lab.specimenStatusChanged(s.ctx, p, { specimenVersion: 1 }); }],
    ['rejected: empty order_item_ids', (s) => s.lab.specimenRejected(s.ctx, rejectedP({ order_item_ids: [] }), { specimenVersion: 1 })],
    ['rejected: reason_code with a space', (s) => s.lab.specimenRejected(s.ctx, rejectedP({ reason_code: 'bad reason' }), { specimenVersion: 1 })],
    ['verified: origin outside enum', (s) => s.lab.resultVerified(s.ctx, verifiedP({ origin: 'fax' }), { resultRowVersion: 1 })],
    ['verified: result_version_no 0', (s) => s.lab.resultVerified(s.ctx, verifiedP({ result_version_no: 0 }), { resultRowVersion: 1 })],
    ['approved: result_version_no 2 (const 1; amendments use amended)', (s) => s.lab.resultApproved(s.ctx, approvedP({ result_version_no: 2 }), { resultRowVersion: 1 })],
    ['amended: new_version_no 1', (s) => s.lab.resultAmended(s.ctx, amendedP({ previous_version_no: 0, new_version_no: 1 }), { resultRowVersion: 1 })],
    ['ready: completeness outside enum', (s) => s.lab.orderReadyForReport(s.ctx, readyP({ completeness: 'half' }), { approvedSet: SET, readinessSeq: 1 })],
    ['ready: empty order_item_ids', (s) => s.lab.orderReadyForReport(s.ctx, readyP({ order_item_ids: [] }), { approvedSet: SET, readinessSeq: 1 })],
    ['critical: direction outside enum', (s) => s.lab.criticalValueDetected(s.ctx, criticalP({ direction: 'sideways' }), { value: VAL, resultRowVersion: 1 })],
    ['critical: missing critical_event_id', (s) => { const { critical_event_id: _c, ...p } = criticalP(); return s.lab.criticalValueDetected(s.ctx, p, { value: VAL, resultRowVersion: 1 }); }],
  ];
  it.each(cases)('%s -> common.internal, no row stored', async (_n, fn) => {
    const s = setup();
    const e = await rejection(s.run(() => fn(s) as Promise<unknown>));
    expect(e.code).toBe('common.internal');
    expect(s.db.events).toHaveLength(0);
  });

  // S-12: lab event payloads contain no keys outside the 03-IC schemas (no barcode, value, comment).
  const smuggle: Array<[string, string, (s: ReturnType<typeof setup>, x: Record<string, unknown>) => Promise<unknown>]> = [
    ['status_changed', 'barcode', (s, x) => s.lab.specimenStatusChanged(s.ctx, changed(x), { specimenVersion: 1 })],
    ['rejected', 'comment', (s, x) => s.lab.specimenRejected(s.ctx, rejectedP(x), { specimenVersion: 1 })],
    ['verified', 'value', (s, x) => s.lab.resultVerified(s.ctx, verifiedP(x), { resultRowVersion: 1 })],
    ['approved', 'value_numeric', (s, x) => s.lab.resultApproved(s.ctx, approvedP(x), { resultRowVersion: 1 })],
    ['amended', 'reason_text', (s, x) => s.lab.resultAmended(s.ctx, amendedP(x), { resultRowVersion: 1 })],
    ['ready', 'patient_name', (s, x) => s.lab.orderReadyForReport(s.ctx, readyP(x), { approvedSet: SET, readinessSeq: 1 })],
    ['critical', 'value', (s, x) => s.lab.criticalValueDetected(s.ctx, criticalP(x), { value: VAL, resultRowVersion: 1 })],
  ];
  it.each(smuggle)('S-12 %s: extra key "%s" never reaches the event log', async (_n, key, fn) => {
    const s = setup();
    await s.run(() => fn(s, { [key]: 'LEAK-SENTINEL-4471' }) as Promise<unknown>).catch(() => undefined);
    expect(JSON.stringify(s.db.events)).not.toContain('LEAK-SENTINEL-4471');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('event contract: every 03-IC example payload publishes through its publisher', () => {
  const IC = readFileSync(join(REPO_ROOT, 'spec', 'program', '03-INTERFACE-CATALOG.md'), 'utf8').replace(/\r\n/g, '\n');
  const example = (num: string): Record<string, unknown> => {
    const start = IC.search(new RegExp(`^### ${num.replace('.', '\\.')} `, 'm'));
    const sec = IC.slice(start + 4, start + 4 + IC.slice(start + 4).search(/^#{2,3} /m));
    const m = /Example payload[^\n`:]*:\s*`(\{[^\n]*\})`/.exec(sec);
    if (!m) throw new Error(`IC §${num}: example payload not found`);
    return JSON.parse(m[1]!);
  };

  it('§3.7 status_changed', async () => {
    const s = setup();
    await s.run(() => s.lab.specimenStatusChanged(s.ctx, example('3.7') as never, { specimenVersion: 2 }));
    expect(s.stored('lab.specimen.status_changed.v1')[0]!.envelope.payload).toEqual(example('3.7'));
  });
  it('§3.8 rejected', async () => {
    const s = setup();
    await s.run(() => s.lab.specimenRejected(s.ctx, example('3.8') as never, { specimenVersion: 2 }));
    expect(s.stored('lab.specimen.rejected.v1')[0]!.envelope.payload).toEqual(example('3.8'));
  });
  it('§3.9 verified', async () => {
    const s = setup();
    await s.run(() => s.lab.resultVerified(s.ctx, example('3.9') as never, { resultRowVersion: 2 }));
    expect(s.stored('lab.result.verified.v1')[0]!.envelope.payload).toEqual(example('3.9'));
  });
  it('§3.10 approved', async () => {
    const s = setup();
    await s.run(() => s.lab.resultApproved(s.ctx, example('3.10') as never, { resultRowVersion: 3 }));
    expect(s.stored('lab.result.approved.v1')[0]!.envelope.payload).toEqual(example('3.10'));
  });
  it('§3.11 amended', async () => {
    const s = setup();
    await s.run(() => s.lab.resultAmended(s.ctx, example('3.11') as never, { resultRowVersion: 4 }));
    expect(s.stored('lab.result.amended.v1')[0]!.envelope.payload).toEqual(example('3.11'));
  });
  it('§3.12 ready_for_report (hash computed by the publisher, everything else verbatim)', async () => {
    const s = setup();
    const { approved_set_hash: _h, ...ex } = example('3.12');
    await s.run(() => s.lab.orderReadyForReport(s.ctx, ex as never, { approvedSet: SET, readinessSeq: 1 }));
    expect(s.stored('lab.order.ready_for_report.v1')[0]!.envelope.payload).toEqual({ ...ex, approved_set_hash: approvedSetHash(SET) });
  });
  it('§3.13 critical_value.detected', async () => {
    const s = setup();
    await s.run(() => s.lab.criticalValueDetected(s.ctx, example('3.13') as never, { value: VAL, resultRowVersion: 1 }));
    expect(s.stored('lab.critical_value.detected.v1')[0]!.envelope.payload).toEqual(example('3.13'));
  });

  it('the publishers emit exactly the event types the lab manifest declares in `produces` (7)', async () => {
    const s = setup();
    await s.run(async () => {
      await s.lab.specimenStatusChanged(s.ctx, changed(), { specimenVersion: 1 });
      await s.lab.specimenRejected(s.ctx, rejectedP(), { specimenVersion: 1 });
      await s.lab.resultVerified(s.ctx, verifiedP(), { resultRowVersion: 1 });
      await s.lab.resultApproved(s.ctx, approvedP(), { resultRowVersion: 1 });
      await s.lab.resultAmended(s.ctx, amendedP(), { resultRowVersion: 1 });
      await s.lab.orderReadyForReport(s.ctx, readyP(), { approvedSet: SET, readinessSeq: 1 });
      await s.lab.criticalValueDetected(s.ctx, criticalP(), { value: VAL, resultRowVersion: 1 });
    });
    const types = [...new Set(s.db.events.map((e) => e.eventType))].sort();
    expect(types).toHaveLength(7);
    expect(types).toEqual([...manifest.produces].sort());
  });
});
