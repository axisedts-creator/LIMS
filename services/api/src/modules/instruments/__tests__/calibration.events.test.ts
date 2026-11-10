// C7 API-T16 — event contract of the calibration publisher (03-IC 3.26, 08 4.10 / CR-C12-006, 02-TRD 6.5). REAL core createEvents + contracts/events/instruments.calibration.received.v1.schema.json; fake tx only.
// SEAM (writer must match or dispute): events/publish.ts additionally exports
//   CALIBRATION_EVENT = 'instruments.calibration.received.v1'
//   calibrationIdempotencyKey(payload, rawSha256): string      `<instrument_id>:cal:<instrument_analyte_code>:<instrument_result_time or rawSha256>`
//   createInstrumentEvents(events).calibrationReceived(ctx, payload, { rawSha256 })   aggregate { type:'instrument_message', id: payload.instrument_message_id, seq: 1 }
import { describe, expect, it } from 'vitest';
import { createEvents, eventValidators } from '../../../core/events/publish.js';
import { eventProducers } from '../../../core/module.js';
import { CALIBRATION_EVENT, calibrationIdempotencyKey, createInstrumentEvents } from '../events/publish.js';
import { calibrationKey } from '../domain/keys.js';
import { ctxFor, makeEventDb } from '../../../core/events/__tests__/helpers.js';
import { AGENT_A1, CENTRE_A1, INS, idN, sha256hex } from './ingest.helpers.js';

const MSG = idN(0xe101), SHA = sha256hex('cal-raw');
const cal = (o: Record<string, unknown> = {}) => ({ instrument_message_id: MSG, instrument_id: INS(1), centre_id: CENTRE_A1, instrument_analyte_code: 'GLU', mapping_status: 'mapped', analyte_id: idN(0xb001), test_id: idN(0xb002),
  calibrator_id_raw: 'CAL-SYN-1', calibrator_lot_raw: 'LOT-SYN-07', instrument_result_time: '2026-11-05T00:45:00.000Z', received_at: '2026-11-05T00:45:04.000Z', ...o });
const setup = () => { const db = makeEventDb(); const pub = createInstrumentEvents(createEvents({ producer: 'instruments' }) as any); const ctx = ctxFor(db, { actor: { type: 'device', id: AGENT_A1 } }); return { db, pub: pub as any, ctx: ctx as any }; };
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };

describe('registration', () => {
  it('constant is the catalogue name; the event is produced by instruments and its schema compiles', () => {
    expect(CALIBRATION_EVENT).toBe('instruments.calibration.received.v1');
    expect(eventProducers()['instruments']).toContain('instruments.calibration.received.v1'); expect(eventValidators().has('instruments.calibration.received.v1')).toBe(true);
  });
});

describe('idempotency key (02-TRD 6.5)', () => {
  it('<instrument_id>:cal:<code>:<result time>; falls back to sha256(raw); agrees with domain/keys calibrationKey', () => {
    expect(calibrationIdempotencyKey(cal() as any, SHA)).toBe(`${INS(1)}:cal:GLU:2026-11-05T00:45:00.000Z`);
    const p: any = cal(); delete p.instrument_result_time;
    expect(calibrationIdempotencyKey(p, SHA)).toBe(`${INS(1)}:cal:GLU:${SHA}`);
    expect(calibrationIdempotencyKey(cal() as any, SHA)).toBe(calibrationKey({ instrumentId: INS(1), instrumentAnalyteCode: 'GLU', instrumentResultTime: '2026-11-05T00:45:00.000Z', rawSha256: SHA }));
    expect(calibrationIdempotencyKey(p, SHA)).toBe(calibrationKey({ instrumentId: INS(1), instrumentAnalyteCode: 'GLU', rawSha256: SHA }));
  });
  it('the key has no barcode / calibrator id / lot in it (only instrument, code, time)', () => {
    expect(calibrationIdempotencyKey(cal() as any, SHA)).not.toMatch(/CAL-SYN|LOT-SYN/);
  });
});

describe('instruments.calibration.received.v1', () => {
  it('publishes the IC example payload verbatim: producer instruments, aggregate instrument_message/<message id>/1, device actor, key', async () => {
    const { db, pub, ctx } = setup(); const p = cal();
    await db.transaction(() => pub.calibrationReceived(ctx, p, { rawSha256: SHA }));
    expect(db.events).toHaveLength(1); const env = db.events[0]!.envelope;
    expect(env).toMatchObject({ event_type: 'instruments.calibration.received.v1', producer: 'instruments', actor: { type: 'device', id: AGENT_A1 }, aggregate: { type: 'instrument_message', id: MSG, seq: 1 },
      idempotency_key: `${INS(1)}:cal:GLU:2026-11-05T00:45:00.000Z` });
    expect(env.payload).toEqual(p);
  });
  it('minimal payload (required fields only: no analyte, no calibrator ids, no result time) is valid; key ends in raw sha256', async () => {
    const { db, pub, ctx } = setup(); const p: any = cal({ mapping_status: 'unmapped' });
    for (const k of ['analyte_id', 'test_id', 'calibrator_id_raw', 'calibrator_lot_raw', 'instrument_result_time']) delete p[k];
    await db.transaction(() => pub.calibrationReceived(ctx, p, { rawSha256: SHA })); expect(db.events[0]!.key).toBe(`${INS(1)}:cal:GLU:${SHA}`);
  });
  it('no barcode rule: a calibrator payload with no sample_barcode is the normal case', async () => {
    const { db, pub, ctx } = setup(); expect(cal()).not.toHaveProperty('sample_barcode');
    await db.transaction(() => pub.calibrationReceived(ctx, cal(), { rawSha256: SHA })); expect(db.events).toHaveLength(1);
  });
  it('the same key twice -> second publish reports duplicate: true and stores nothing new', async () => {
    const { db, pub, ctx } = setup(); await db.transaction(() => pub.calibrationReceived(ctx, cal(), { rawSha256: SHA }));
    const again = await db.transaction(() => pub.calibrationReceived(ctx, cal({ calibrator_lot_raw: 'LOT-SYN-08' }), { rawSha256: SHA })); expect((again as any).duplicate).toBe(true); expect(db.events).toHaveLength(1);
  });
  it('two calibrator codes of one message give two events (code is part of the key)', async () => {
    const { db, pub, ctx } = setup();
    await db.transaction(async () => { await pub.calibrationReceived(ctx, cal(), { rawSha256: SHA }); await pub.calibrationReceived(ctx, cal({ instrument_analyte_code: 'NA' }), { rawSha256: SHA }); });
    expect(new Set(db.events.map((e: any) => e.key)).size).toBe(2);
  });
  it('calibrator_id_raw / calibrator_lot_raw / code of exactly 64 chars pass; 65 fails closed (03-IC 3.26 limits)', async () => {
    const { db, pub, ctx } = setup();
    await db.transaction(() => pub.calibrationReceived(ctx, cal({ calibrator_id_raw: 'c'.repeat(64), calibrator_lot_raw: 'l'.repeat(64), instrument_analyte_code: 'x'.repeat(64) }), { rawSha256: SHA })); expect(db.events).toHaveLength(1);
    for (const bad of [{ calibrator_id_raw: 'c'.repeat(65) }, { calibrator_lot_raw: 'l'.repeat(65) }, { instrument_analyte_code: 'x'.repeat(65) }, { instrument_analyte_code: '' }])
      expect((await rejects(db.transaction(() => pub.calibrationReceived(ctx, cal(bad), { rawSha256: SHA })))).code).toBe('common.internal');
    expect(db.events).toHaveLength(1);
  });
  it.each([
    ['a patient / barcode field (P0 class only)', { sample_barcode: 'E2600000042' }], ['a patient name', { patient_name: 'Zzyzx Testpatient' }], ['a value (value_raw is not part of the event)', { value_raw: '5.0' }],
    ['bad mapping_status', { mapping_status: 'maybe' }], ['non-uuid analyte_id', { analyte_id: 'nope' }], ['non-ISO result time', { instrument_result_time: '2026-11-05 00:45' }],
    ['processing_kind (not in this schema, additionalProperties false)', { processing_kind: 'live' }],
  ])('schema violation (%s) fails closed with common.internal and stores nothing', async (_n, bad) => {
    const { db, pub, ctx } = setup(); const e = await rejects(db.transaction(() => pub.calibrationReceived(ctx, cal(bad), { rawSha256: SHA }))); expect(e.code).toBe('common.internal'); expect(db.events).toEqual([]); expect(db.jobs).toEqual([]);
  });
  it.each(['instrument_message_id', 'instrument_id', 'centre_id', 'instrument_analyte_code', 'mapping_status', 'received_at'])('missing required %s is refused', async (k) => {
    const { db, pub, ctx } = setup(); const p: any = cal(); delete p[k];
    expect((await rejects(db.transaction(() => pub.calibrationReceived(ctx, p, { rawSha256: SHA })))).code).toBe('common.internal'); expect(db.events).toEqual([]);
  });
});
