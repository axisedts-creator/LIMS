// C7 API-T09 — event contract of the publishers in events/publish.ts (03-IC §3.14/§3.15, 02-TRD §6.5). REAL core createEvents + contracts/events/*.schema.json; fake tx only.
import { describe, expect, it } from 'vitest';
import { createEvents, eventValidators } from '../../../core/events/publish.js';
import { eventProducers } from '../../../core/module.js';
import { createInstrumentEvents, qcIdempotencyKey, resultIdempotencyKey } from '../events/publish.js';
import { manifest } from '../index.js';
import { ctxFor, makeEventDb } from '../../../core/events/__tests__/helpers.js';
import { AGENT_A1, INS, CENTRE_A1, idN, sha256hex } from './ingest.helpers.js';

const MSG = idN(0xe001);
const result = (o: Record<string, unknown> = {}) => ({ instrument_message_id: MSG, instrument_id: INS(1), agent_id: AGENT_A1, centre_id: CENTRE_A1, protocol: 'astm', sample_barcode: 'E2600000042', record_kind: 'quantitative',
  instrument_analyte_code: 'GLU', mapping_status: 'mapped', analyte_id: idN(0xb001), test_id: idN(0xb002), value_raw: '5.4', value_numeric: '5.4', unit_raw: 'mmol/L', instrument_flags: ['N'],
  instrument_result_time: '2026-11-07T04:27:00.000Z', instrument_clock_offset_seconds: 2, received_at: '2026-11-07T12:00:00.000Z', is_rerun: false, captured_at: '2026-11-07T04:26:58.000Z', processing_kind: 'live', ...o });
const qc = (o: Record<string, unknown> = {}) => ({ instrument_message_id: MSG, instrument_id: INS(1), centre_id: CENTRE_A1, control_id_raw: 'QC-L1-0007', instrument_analyte_code: 'GLU', mapping_status: 'mapped', analyte_id: idN(0xb001),
  value_raw: '5.0', value_numeric: '5.0', unit_raw: 'mmol/L', instrument_flags: [], instrument_result_time: '2026-11-07T04:27:00.000Z', received_at: '2026-11-07T12:00:00.000Z', captured_at: '2026-11-07T04:26:58.000Z', processing_kind: 'live', ...o });
const setup = () => { const db = makeEventDb(); const events = createEvents({ producer: 'instruments' }); const pub = createInstrumentEvents(events as any); const ctx = ctxFor(db, { actor: { type: 'device', id: AGENT_A1 } }); return { db, pub, ctx: ctx as any }; };
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };

describe('manifest', () => {
  it('produces = EVENT_PRODUCERS.instruments (all four, schemas exist and compile)', () => {
    expect([...manifest.produces].sort()).toEqual([...eventProducers()['instruments']!].sort()); expect(manifest.produces).toHaveLength(4);
    for (const t of manifest.produces) expect(eventValidators().has(t)).toBe(true);
  });
});

describe('instruments.result.received.v1', () => {
  it('publishes a valid payload verbatim: envelope producer instruments, aggregate instrument_message/<message id>/1, device actor, §6.5 key', async () => {
    const { db, pub, ctx } = setup(); const p = result();
    await db.transaction(() => pub.resultReceived(ctx, p));
    expect(db.events).toHaveLength(1); const env = db.events[0]!.envelope;
    expect(env).toMatchObject({ event_type: 'instruments.result.received.v1', producer: 'instruments', actor: { type: 'device', id: AGENT_A1 }, aggregate: { type: 'instrument_message', id: MSG, seq: 1 },
      idempotency_key: `${INS(1)}:E2600000042:GLU:2026-11-07T04:27:00.000Z` }); expect(env.payload).toEqual(p);
  });
  it('key suffix is "none" when there is no instrument_result_time; pure key function agrees', async () => {
    const { db, pub, ctx } = setup(); const p = result(); delete (p as any).instrument_result_time;
    await db.transaction(() => pub.resultReceived(ctx, p)); expect(db.events[0]!.key).toBe(`${INS(1)}:E2600000042:GLU:none`); expect(resultIdempotencyKey(p as any)).toBe(`${INS(1)}:E2600000042:GLU:none`);
  });
  it('the same key twice -> second publish reports duplicate: true and stores nothing new (core.event_log uniqueness)', async () => {
    const { db, pub, ctx } = setup(); await db.transaction(() => pub.resultReceived(ctx, result()));
    const again = await db.transaction(() => pub.resultReceived(ctx, result({ value_raw: '5.5' }))); expect((again as any).duplicate).toBe(true); expect(db.events).toHaveLength(1);
  });
  it.each([
    ['a non-IC key (patient name)', { patient_name: 'Zzyzx Testpatient' }], ['sample_barcode 41 chars', { sample_barcode: 'x'.repeat(41) }], ['code 65 chars', { instrument_analyte_code: 'x'.repeat(65) }],
    ['value_raw 201 chars', { value_raw: 'x'.repeat(201) }], ['21 flags', { instrument_flags: Array.from({ length: 21 }, () => 'N') }], ['bad mapping_status', { mapping_status: 'maybe' }],
    ['non-uuid analyte_id', { analyte_id: 'nope' }], ['non-DecimalString value_numeric', { value_numeric: 'Negative' }], ['bad protocol', { protocol: 'serial' }],
  ])('schema violation (%s) fails closed with common.internal and stores nothing', async (_n, bad) => {
    const { db, pub, ctx } = setup(); const e = await rejects(db.transaction(() => pub.resultReceived(ctx, result(bad)))); expect(e.code).toBe('common.internal'); expect(db.events).toEqual([]); expect(db.jobs).toEqual([]);
  });
  it('a missing required field (sample_barcode) is refused', async () => {
    const { db, pub, ctx } = setup(); const p = result(); delete (p as any).sample_barcode; expect((await rejects(db.transaction(() => pub.resultReceived(ctx, p)))).code).toBe('common.internal');
  });
});

describe('instruments.qc.received.v1', () => {
  it('publishes: key <instrument>:qc:<control_id_raw>:<code>:<time>, aggregate instrument_message', async () => {
    const { db, pub, ctx } = setup(); await db.transaction(() => pub.qcReceived(ctx, qc(), { rawSha256: sha256hex('raw') }));
    expect(db.events[0]!.envelope).toMatchObject({ event_type: 'instruments.qc.received.v1', producer: 'instruments', aggregate: { type: 'instrument_message', id: MSG, seq: 1 }, idempotency_key: `${INS(1)}:qc:QC-L1-0007:GLU:2026-11-07T04:27:00.000Z` });
  });
  it('without a result time the key ends in raw_sha256', async () => {
    const { db, pub, ctx } = setup(); const p = qc(); delete (p as any).instrument_result_time; const sha = sha256hex('raw');
    await db.transaction(() => pub.qcReceived(ctx, p, { rawSha256: sha })); expect(db.events[0]!.key).toBe(`${INS(1)}:qc:QC-L1-0007:GLU:${sha}`); expect(qcIdempotencyKey(p as any, sha)).toBe(`${INS(1)}:qc:QC-L1-0007:GLU:${sha}`);
  });
  it('control_id_raw / value_raw of exactly 64 chars pass; 65 fails closed (03-IC §3.15 limits)', async () => {
    const { db, pub, ctx } = setup(); const sha = sha256hex('raw');
    await db.transaction(() => pub.qcReceived(ctx, qc({ control_id_raw: 'c'.repeat(64), value_raw: 'v'.repeat(64), value_numeric: undefined }), { rawSha256: sha })); expect(db.events).toHaveLength(1);
    for (const bad of [{ control_id_raw: 'c'.repeat(65) }, { value_raw: 'v'.repeat(65) }]) expect((await rejects(db.transaction(() => pub.qcReceived(ctx, qc(bad), { rawSha256: sha })))).code).toBe('common.internal');
    expect(db.events).toHaveLength(1);
  });
  it('QC events carry no barcode / patient field: sample_barcode is refused (P0 class)', async () => {
    const { db, pub, ctx } = setup(); expect((await rejects(db.transaction(() => pub.qcReceived(ctx, qc({ sample_barcode: 'E2600000042' }), { rawSha256: sha256hex('r') })))).code).toBe('common.internal'); expect(db.events).toEqual([]);
  });
});
