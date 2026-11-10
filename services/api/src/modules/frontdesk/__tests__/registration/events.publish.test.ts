// FD-T06 events/publish.ts: typed publisher for frontdesk.order.created.v1 (02-TRD §8.1; 03-IC §3.1; US-FD-03.1 "exactly once"; P1/P3: no names, phones, registration no).
// Docker-free (in-memory event db from core/events/__tests__/helpers). Fails now: ../../events/publish.js does not exist.
// ASSUMED API (same seam as billing/events/publish.ts, BL-T06):
//   export function createFrontdeskEvents(events: { publish(ctx, type, input) })
//     -> { orderCreated(ctx, payload, orderVersion) }   aggregate { order, payload.order_id, seq: orderVersion }, key `<order_id>:created`, payload verbatim (core validates the schema).
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { ctxFor, makeEventDb, rejection } from '../../../../core/events/__tests__/helpers.js';
import { createFrontdeskEvents } from '../../events/publish.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const ORDER = V7('000000050001'), PATIENT = V7('0000000a0001'), BRANCH = V7('000000010001'), CENTRE = V7('000000020002'), PARTY = V7('000000b00001'), REF = V7('000000c00001');
const ITEM = (n: number, o: Record<string, unknown> = {}) => ({ order_item_id: V7(`0000000d000${n}`), orderable_id: V7(`0000000e000${n}`), orderable_kind: 'test', test_ids: [V7(`0000000f000${n}`)], priority: 'routine', ...o });
const payload = (o: Record<string, unknown> = {}) => ({
  order_id: ORDER, patient_id: PATIENT, branch_id: BRANCH, centre_id: CENTRE, visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in',
  source: 'front_desk', registered_at: '2026-11-10T06:00:00.000Z', items: [ITEM(1), ITEM(2, { priority: 'urgent', outsourced: true })], ...o });

function setup() {
  const db = makeEventDb();
  const fd = createFrontdeskEvents(createEvents({ producer: 'frontdesk' }) as never);
  const ctx = ctxFor(db) as never;
  return { db, fd, ctx, run: <T>(fn: () => Promise<T>) => db.transaction(fn), stored: () => db.events.filter((e) => e.eventType === 'frontdesk.order.created.v1') };
}

describe('frontdesk.order.created.v1', () => {
  it('stored once: key <order_id>:created, aggregate order seq = order version, producer frontdesk, payload verbatim', async () => {
    const { fd, ctx, run, stored } = setup();
    const out = await run(() => fd.orderCreated(ctx, payload(), 1));
    expect(out.duplicate).toBe(false);
    const [e] = stored();
    expect(stored()).toHaveLength(1);
    expect(e!.key).toBe(`${ORDER}:created`);
    expect(e!.envelope.producer).toBe('frontdesk');
    expect(e!.envelope.aggregate).toEqual({ type: 'order', id: ORDER, seq: 1 });
    expect(e!.envelope.payload).toEqual(payload());
  });
  it('aggregate seq follows the order version after commit (confirm of a pre-registered order is > 1)', async () => {
    const { fd, ctx, run, stored } = setup();
    await run(() => fd.orderCreated(ctx, payload(), 3));
    expect(stored()[0]!.envelope.aggregate.seq).toBe(3);
  });
  it('same order published twice (service retried inside one tx, or a replay) -> second is a duplicate no-op: exactly one event', async () => {
    const { fd, ctx, run, stored } = setup();
    await run(async () => { await fd.orderCreated(ctx, payload(), 1); expect((await fd.orderCreated(ctx, payload(), 1)).duplicate).toBe(true); });
    expect(stored()).toHaveLength(1);
  });
  it('credit order with credit_party_id and referrer_id is valid; optional fields may be absent', async () => {
    const { fd, ctx, run, stored } = setup();
    await run(() => fd.orderCreated(ctx, payload({ billing_mode: 'credit', credit_party_id: PARTY, referrer_id: REF }), 1));
    expect(stored()[0]!.envelope.payload).toMatchObject({ billing_mode: 'credit', credit_party_id: PARTY, referrer_id: REF });
  });
  it('rollback of the caller tx drops the event', async () => {
    const { fd, ctx, run, stored } = setup();
    await rejection(run(async () => { await fd.orderCreated(ctx, payload(), 1); throw new Error('boom'); }));
    expect(stored()).toHaveLength(0);
  });
});

describe('payload validation fails closed (core validates against contracts/events/*.schema.json; nothing stored, error common.internal)', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['PHI: patient name', { patient_name: 'Asha Test' }],
    ['PHI: phone', { phone_e164: '+9779800000001' }],
    ['PHI: registration_no', { registration_no: 'R000001' }],
    ['item name (P3)', { items: [{ ...ITEM(1), name: 'Complete Blood Count' }] }],
    ['no items', { items: [] }],
    ['item without test_ids', { items: [{ ...ITEM(1), test_ids: [] }] }],
    ['bad visit_type', { visit_type: 'er' }],
    ['bad billing_mode', { billing_mode: 'later' }],
    ['non-uuidv7 order_id', { order_id: '11111111-1111-4111-8111-111111111111' }],
    ['missing registered_at', { registered_at: undefined }],
  ];
  for (const [name, over] of bad) {
    it(name, async () => {
      const { fd, ctx, run, stored } = setup();
      const e = await rejection(run(() => fd.orderCreated(ctx, payload(over), 1)));
      expect(e.code).toBe('common.internal');
      expect(stored()).toHaveLength(0);
    });
  }
  it('invalid order version (0, -1, 1.5) is refused', async () => {
    for (const v of [0, -1, 1.5]) {
      const { fd, ctx, run, stored } = setup();
      await rejection(run(() => fd.orderCreated(ctx, payload(), v)));
      expect(stored()).toHaveLength(0);
    }
  });
});
