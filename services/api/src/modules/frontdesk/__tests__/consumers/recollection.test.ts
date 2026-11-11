// FD-T12 recollection consumers over a real PG17 tx: lab.specimen.rejected.v1 (F22 flag + recollection SMS) and lab.specimen.status_changed.v1 (recollection_ordered only).
// PRD US-FD-13.1-.3; 02-TRD §8.2; 03-APP-FLOW §3.4; 03-IC §3.7/§3.8; 08 A13 D-6 (one flag per specimen: unique index order_flags__tenant_id_kind_specimen__p_uq); 07-SECURITY consumer probes (A19).
// Seams + harness: ./helpers.ts. Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { CENTRE_PHONE, IC_EXAMPLES, LAB_NAME, T, TENANT_A, TENANT_B, consume, consumeQuietly, envelope, flagRows, flagsOfSpecimen, ownerRows, recollectionWorld, rejectedPayload, statusPayload, superTx, uid, type CO } from './helpers.js';

vi.setConfig({ testTimeout: T });
const probeOf = (): NonNullable<CO['probe']> => ({ sms: [], writes: [] });
const world = recollectionWorld;
async function rejectedFor(x: Awaited<ReturnType<typeof world>>, specimenId = uid(), o: Record<string, unknown> = {}) {
  return { specimenId, payload: rejectedPayload({ specimenId, orderId: x.order.id, patientId: x.patient.id, ...o }) };
}

describe('lab.specimen.rejected.v1 (US-FD-13.1)', () => {
  it('recollection_required:true -> one OPEN recollection_required flag for the specimen on the order (centre = the order centre) + one recollection_request SMS with exactly {lab_name, centre_phone}', async () => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x);
    const probe = probeOf();
    await consume('rejected', envelope('rejected', payload, { aggregateId: specimenId }), { w: x.w, probe });
    const flags = await flagRows(x.order.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'recollection_required', status: 'open', specimen_id: specimenId, order_id: x.order.id, tenant_id: TENANT_A, centre_id: x.order.centre_id, is_active: true });
    expect(probe.sms).toHaveLength(1);
    expect(probe.sms[0]).toMatchObject({ recipient: { kind: 'patient', patientId: x.patient.id }, purpose: 'recollection_request', templateCode: 'frontdesk.recollection_request',
      idempotencyKey: `${specimenId}:recollection_sms`, related: { entityType: 'specimen', entityId: specimenId } });
    expect(probe.sms[0].params).toEqual({ lab_name: LAB_NAME, centre_phone: CENTRE_PHONE });             // declared non-PHI set only: no reason, no names, no registration no
  });
  it('recollection_required:false -> no flag and no SMS (03-APP-FLOW §3.4)', async () => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x, uid(), { recollection: false });
    const probe = probeOf();
    await consume('rejected', envelope('rejected', payload, { aggregateId: specimenId }), { w: x.w, probe });
    expect(await flagRows(x.order.id)).toEqual([]);
    expect(probe.sms).toEqual([]);
  });
  it('the flag is the unit of work: SMS consent decides only the SMS (flag exists, handler resolves)', async () => {
    const x = await world({ sms: false });
    const { specimenId, payload } = await rejectedFor(x);
    await expect(consume('rejected', envelope('rejected', payload, { aggregateId: specimenId }), { w: x.w })).resolves.toBeUndefined();
    expect(await flagRows(x.order.id)).toHaveLength(1);
  });
  it('tenant SMS channel disabled -> flag still raised, handler resolves', async () => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x);
    await expect(consume('rejected', envelope('rejected', payload, { aggregateId: specimenId }), { w: x.w, sms: 'off' })).resolves.toBeUndefined();
    expect(await flagRows(x.order.id)).toHaveLength(1);
  });
  it('a failing NotificationPort never rolls the flag back or fails the consumer (TRD §6.4: errors caught, logged with code)', async () => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x);
    await expect(consume('rejected', envelope('rejected', payload, { aggregateId: specimenId }), { w: x.w, smsThrows: true })).resolves.toBeUndefined();
    expect(await flagRows(x.order.id)).toHaveLength(1);
  });
});

describe('duplicate delivery (US-FD-13.2)', () => {
  it('the same event twice, and the same facts under a NEW event_id: one flag, and every SMS attempt carries the one key <specimen_id>:recollection_sms (the port dedupes on it)', async () => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x);
    const first = envelope('rejected', payload, { aggregateId: specimenId });
    const probe = probeOf();
    await consume('rejected', first, { w: x.w, probe });
    await expect(consume('rejected', first, { w: x.w, probe })).resolves.toBeUndefined();
    await expect(consume('rejected', envelope('rejected', payload, { aggregateId: specimenId }), { w: x.w, probe })).resolves.toBeUndefined();
    expect(await flagRows(x.order.id)).toHaveLength(1);
    expect(new Set(probe.sms.map((s) => s.idempotencyKey))).toEqual(new Set([`${specimenId}:recollection_sms`]));
  });
  it('a RESOLVED flag is never reopened or duplicated by a redelivery (the unique index covers resolved rows too)', async () => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x);
    await consume('rejected', envelope('rejected', payload, { aggregateId: specimenId }), { w: x.w });
    const [f] = await flagRows(x.order.id);
    await superTx(async (tx) => { await tx.query("UPDATE frontdesk.order_flags SET status = 'resolved', resolved_at = now(), resolved_by = created_by, resolution_code = 'patient_called' WHERE id = $1", [f.id]); });
    await consume('rejected', envelope('rejected', payload, { aggregateId: specimenId }), { w: x.w });
    const after = await flagRows(x.order.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: f.id, status: 'resolved' });
  });
  it('two different specimens of one order -> two flags, each with its own SMS key', async () => {
    const x = await world();
    const a = await rejectedFor(x), b = await rejectedFor(x);
    const probe = probeOf();
    await consume('rejected', envelope('rejected', a.payload, { aggregateId: a.specimenId }), { w: x.w, probe });
    await consume('rejected', envelope('rejected', b.payload, { aggregateId: b.specimenId }), { w: x.w, probe });
    expect((await flagRows(x.order.id)).map((r: any) => r.specimen_id).sort()).toEqual([a.specimenId, b.specimenId].sort());
    expect(new Set(probe.sms.map((s) => s.idempotencyKey)).size).toBe(2);
  });
});

describe('lab.specimen.status_changed.v1 -> recollection_ordered only (US-FD-13.3, 08 A13 D-6)', () => {
  it('to_status recollection_ordered alone -> exactly one open recollection_required flag for the specimen, and NO SMS from this path', async () => {
    const x = await world();
    const specimenId = uid();
    const probe = probeOf();
    await consume('changed', envelope('changed', statusPayload({ specimenId, orderId: x.order.id, patientId: x.patient.id, to: 'recollection_ordered' }), { aggregateId: specimenId, seq: 4 }), { w: x.w, probe });
    expect(await flagsOfSpecimen(TENANT_A, specimenId)).toHaveLength(1);
    expect((await flagRows(x.order.id))[0]).toMatchObject({ kind: 'recollection_required', status: 'open', specimen_id: specimenId, centre_id: x.order.centre_id });
    expect(probe.sms).toEqual([]);
  });
  it.each(['rejected_then_ordered', 'ordered_then_rejected'] as const)('%s -> exactly ONE flag for the specimen; the SMS is sent once (by the rejected path only)', async (order) => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x);
    const rej = () => consume('rejected', envelope('rejected', payload, { aggregateId: specimenId, seq: 3 }), { w: x.w, probe });
    const chg = () => consume('changed', envelope('changed', statusPayload({ specimenId, orderId: x.order.id, patientId: x.patient.id, to: 'recollection_ordered' }), { aggregateId: specimenId, seq: 4 }), { w: x.w, probe });
    const probe = probeOf();
    if (order === 'rejected_then_ordered') { await rej(); await chg(); } else { await chg(); await rej(); }
    expect(await flagsOfSpecimen(TENANT_A, specimenId)).toHaveLength(1);
    expect(new Set(probe.sms.map((s) => s.idempotencyKey))).toEqual(new Set([`${specimenId}:recollection_sms`]));
  });
  it('redelivered recollection_ordered (same event, new event_id, older seq) -> still one flag', async () => {
    const x = await world();
    const specimenId = uid();
    const p = statusPayload({ specimenId, orderId: x.order.id, patientId: x.patient.id, to: 'recollection_ordered' });
    const e = envelope('changed', p, { aggregateId: specimenId, seq: 5 });
    await consume('changed', e, { w: x.w });
    await consume('changed', e, { w: x.w });
    await consume('changed', envelope('changed', p, { aggregateId: specimenId, seq: 2 }), { w: x.w });          // stale seq: ignored or harmless, never a second row
    expect(await flagsOfSpecimen(TENANT_A, specimenId)).toHaveLength(1);
  });
  it.each(['received', 'rejected', 'in_transit', 'collected', 'resulted', 'verified', 'approved', 'reported', 'some_future_status'])('to_status %s -> inbox only: no flag, no SMS, no write', async (to) => {
    const x = await world();
    const specimenId = uid();
    const probe = probeOf();
    await consume('changed', envelope('changed', statusPayload({ specimenId, orderId: x.order.id, patientId: x.patient.id, to }), { aggregateId: specimenId }), { w: x.w, probe });
    expect(await flagRows(x.order.id)).toEqual([]);
    expect(probe.sms).toEqual([]);
    expect(probe.writes.filter((s) => /order_flags/i.test(s))).toEqual([]);
  });
  it('03-IC §3.7 example (to_status received, ids that exist nowhere) is accepted without writing a flag', async () => {
    const probe = probeOf();
    await expect(consume('changed', envelope('changed', { ...IC_EXAMPLES.statusReceived }), { probe })).resolves.toBeUndefined();
    expect(probe.writes.filter((s) => /order_flags/i.test(s))).toEqual([]);
  });
});

describe('unknown fields, unknown orders, tenant isolation (07-SECURITY consumer probes, A19)', () => {
  it('unknown payload and envelope fields are ignored: never stored (flag has no note), never in SMS params, never change behaviour', async () => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x, uid(), { comment: 'SECRET-CLINICAL-TEXT', future_field: { a: 1 }, recollection_note: 'SECRET-2', status: 'resolved' });
    const probe = probeOf();
    await consume('rejected', envelope('rejected', payload, { aggregateId: specimenId, extra: { trace: 'SECRET-3', tenant_override: TENANT_B } }), { w: x.w, probe });
    const [f] = await flagRows(x.order.id);
    expect(f).toMatchObject({ status: 'open', note: null });
    expect(JSON.stringify(f)).not.toMatch(/SECRET/);
    expect(JSON.stringify(probe.sms)).not.toMatch(/SECRET/);
    expect(Object.keys(probe.sms[0].params).sort()).toEqual(['centre_phone', 'lab_name']);
  });
  it('03-IC §3.8 example (recollection_required:true, order/patient that exist nowhere): no flag, no SMS is produced from nothing', async () => {
    const probe = probeOf();
    await consumeQuietly('rejected', envelope('rejected', { ...IC_EXAMPLES.rejected }, { aggregateId: IC_EXAMPLES.rejected.specimen_id }), { probe });
    expect(await flagsOfSpecimen(TENANT_A, IC_EXAMPLES.rejected.specimen_id)).toEqual([]);
    expect(probe.sms).toEqual([]);
  });
  it('an event naming tenant A\'s order, processed in tenant B\'s context, changes nothing in A and sends nothing', async () => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x);
    const probe = probeOf();
    await consumeQuietly('rejected', envelope('rejected', payload, { aggregateId: specimenId, tenant: TENANT_B }), { w: x.w, tenant: TENANT_B, probe });
    await consumeQuietly('changed', envelope('changed', statusPayload({ specimenId, orderId: x.order.id, patientId: x.patient.id, to: 'recollection_ordered' }), { aggregateId: specimenId, tenant: TENANT_B }), { w: x.w, tenant: TENANT_B, probe });
    expect(await flagRows(x.order.id)).toEqual([]);
    expect(await ownerRows('frontdesk.order_flags', 'specimen_id = $1', [specimenId])).toEqual([]);
    expect(probe.sms).toEqual([]);
  });
  it('an envelope whose tenant_id differs from the job context tenant writes nothing (the envelope may repeat the tenant, never choose it)', async () => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x);
    const probe = probeOf();
    await consumeQuietly('rejected', envelope('rejected', payload, { aggregateId: specimenId, tenant: TENANT_B }), { w: x.w, tenant: TENANT_A, probe });
    expect(await flagRows(x.order.id)).toEqual([]);
    expect(probe.sms).toEqual([]);
  });
  it('the flag takes its centre from the stored order, not from the event (a forged payload centre_id cannot move the flag to another centre)', async () => {
    const x = await world();
    const { specimenId, payload } = await rejectedFor(x, uid(), { centreId: '01a1a98a-ac40-7000-8000-00000000a202' });
    await consume('rejected', envelope('rejected', payload, { aggregateId: specimenId }), { w: x.w });
    expect((await flagRows(x.order.id))[0]).toMatchObject({ centre_id: x.order.centre_id });
  });
});
