// HC-T12 typed publisher for homecollection.collection.synced.v1 (02-TRD §8.1; 03-IC §3.23; 08 A19 D-120). Same seam as billing/events/publish.ts and payments/events/publish.ts.
// Fails now: ../publish.js does not exist.
// ASSUMED API (writer: object via a dispute if wrong):
//   export function createHomecollectionEvents(events: { publish(ctx, type, input): Promise<{ eventId: string; duplicate: boolean }> })
//     -> { collectionSynced(ctx, payload, o: { visitVersion: number }): Promise<{ eventId; duplicate }> }
//   payload = the 03-IC payload exactly (snake_case; Money {amount_paisa:int, currency:'NPR'}); aggregate { home_visit, payload.visit_id, seq: visitVersion };
//   key `<visit_id>:sync:<64-hex sha256 of the SORTED client_mutation_ids of collections + payments in THIS event>` (the join format is the writer's; tests check shape, order-independence, set-sensitivity).
//   The publisher adds no keys; the REAL core publish validates against contracts/events (additionalProperties:false) and fails closed with common.internal, storing nothing. Splitting of > 50 collections / > 10
//   payments into several events is the sync service's job (integration test effects.test.ts); here a too-large single payload must fail closed.
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { ctxFor, makeEventDb, rejection } from '../../../../core/events/__tests__/helpers.js';
import { createHomecollectionEvents } from '../../events/publish.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const VISIT = V7('000000130001'), ORDER = V7('000000050002'), MEMBERSHIP = V7('000000030009'), BOOKING = V7('000000150001');
const cid = (n: number) => V7(String(0x1a0000 + n).padStart(12, '0'));
const col = (n: number, o: Record<string, unknown> = {}) => ({ client_mutation_id: cid(n), specimen_id: V7(String(0x90000 + n).padStart(12, '0')), barcode_verified: true, collected_at_device: '2026-11-06T01:27:00.000Z', ...o });
const pay = (n: number, o: Record<string, unknown> = {}) => ({ client_mutation_id: cid(100 + n), payment_method_code: 'cash', amount: { amount_paisa: 180000, currency: 'NPR' }, captured_at_device: '2026-11-06T01:30:00.000Z', ...o });
const P = (o: Record<string, unknown> = {}) => ({ visit_id: VISIT, order_id: ORDER, phlebotomist_membership_id: MEMBERSHIP, synced_at: '2026-11-06T02:40:00.000Z', collections: [col(1), col(2)], payments: [pay(1)], ...o });
const TYPE = 'homecollection.collection.synced.v1';

function setup() {
  const db = makeEventDb();
  const hc = createHomecollectionEvents(createEvents({ producer: 'homecollection' }) as never);
  const ctx = ctxFor(db) as never;
  return { db, hc, ctx, run: <T>(fn: () => Promise<T>) => db.transaction(fn), stored: () => db.events.filter((e) => e.eventType === TYPE) };
}

describe('homecollection.collection.synced.v1 publisher', () => {
  it('stored once: producer homecollection, aggregate home_visit / visit_id / seq = visit version, key <visit_id>:sync:<64 hex>, payload verbatim', async () => {
    const { hc, ctx, run, stored } = setup();
    const out = await run(() => hc.collectionSynced(ctx, P(), { visitVersion: 7 }));
    expect(out.duplicate).toBe(false);
    const [e] = stored();
    expect(e!.key).toMatch(new RegExp(`^${VISIT}:sync:[0-9a-f]{64}$`));
    expect(e!.envelope.producer).toBe('homecollection');
    expect(e!.envelope.aggregate).toEqual({ type: 'home_visit', id: VISIT, seq: 7 });
    expect(e!.envelope.payload).toEqual(P());
  });
  it('key = f(SET of mutation ids): same ids in another order -> the same key (duplicate no-op); a different / larger / smaller set -> a different key', async () => {
    const { hc, ctx, run, stored } = setup();
    await run(async () => {
      const a = await hc.collectionSynced(ctx, P({ collections: [col(1), col(2)], payments: [] }), { visitVersion: 2 });
      const b = await hc.collectionSynced(ctx, P({ collections: [col(2), col(1)], payments: [] }), { visitVersion: 3 });
      expect([a.duplicate, b.duplicate, b.eventId]).toEqual([false, true, a.eventId]);
      expect((await hc.collectionSynced(ctx, P({ collections: [col(1), col(2)], payments: [pay(1)] }), { visitVersion: 3 })).duplicate).toBe(false);
      expect((await hc.collectionSynced(ctx, P({ collections: [col(1)], payments: [] }), { visitVersion: 3 })).duplicate).toBe(false);
      expect((await hc.collectionSynced(ctx, P({ collections: [col(3)], payments: [] }), { visitVersion: 3 })).duplicate).toBe(false);
    });
    expect(new Set(stored().map((e) => e.key)).size).toBe(4);
  });
  it('payload with booking_id (visit kind booking, D-120) is valid; without it is valid; booking_id that is not a UUIDv7 fails closed', async () => {
    const { hc, ctx, run, stored } = setup();
    await run(async () => {
      await hc.collectionSynced(ctx, P({ booking_id: BOOKING }), { visitVersion: 1 });
      await hc.collectionSynced(ctx, P({ collections: [col(5)], payments: [] }), { visitVersion: 1 });
    });
    expect(stored().map((e) => 'booking_id' in e.envelope.payload)).toEqual([true, false]);
    const s2 = setup();
    expect((await rejection(s2.run(() => s2.hc.collectionSynced(s2.ctx, P({ booking_id: 'not-a-uuid' }), { visitVersion: 1 })))).code).toBe('common.internal');
  });
  it('collections-only (held collection applied by review, payments []) and payments-only (cancelled visit, D-PAY) are valid', async () => {
    const { hc, ctx, run, stored } = setup();
    await run(async () => {
      await hc.collectionSynced(ctx, P({ payments: [] }), { visitVersion: 4 });
      await hc.collectionSynced(ctx, P({ collections: [], payments: [pay(9)] }), { visitVersion: 5 });
    });
    expect(stored()).toHaveLength(2);
  });
  it('optional payment reference <= 100 chars accepted; 101 fails closed', async () => {
    const { hc, ctx, run, stored } = setup();
    await run(() => hc.collectionSynced(ctx, P({ payments: [pay(1, { reference: 'R'.repeat(100) })] }), { visitVersion: 1 }));
    expect(stored()).toHaveLength(1);
    const s2 = setup();
    expect((await rejection(s2.run(() => s2.hc.collectionSynced(s2.ctx, P({ payments: [pay(1, { reference: 'R'.repeat(101) })] }), { visitVersion: 1 })))).code).toBe('common.internal');
  });
  it('schema failures fail closed with common.internal and store nothing: both arrays empty, 51 collections, 11 payments, PHI keys (barcode, name, gps, address), missing synced_at, float paisa, currency USD, extra key', async () => {
    const many = (n: number, f: (i: number) => object) => Array.from({ length: n }, (_x, i) => f(i + 1));
    const bad: Array<[string, Record<string, unknown>]> = [
      ['both empty', P({ collections: [], payments: [] })],
      ['51 collections', P({ collections: many(51, (i) => col(i)), payments: [] })],
      ['11 payments', P({ collections: [], payments: many(11, (i) => pay(i)) })],
      ['barcode on collection', P({ collections: [col(1, { barcode: 'SN123456' })] })],
      ['scanned_barcode on collection', P({ collections: [col(1, { scanned_barcode: 'SN123456' })] })],
      ['patient name', P({ patient_name: 'Synthetic Patient One' })],
      ['gps', P({ gps: { status: 'ok', latitude: '27.7', longitude: '85.3' } })],
      ['address', P({ address_text: 'Ward 4' })],
      ['missing synced_at', (() => { const p: Record<string, unknown> = P(); delete p.synced_at; return p; })()],
      ['float paisa', P({ payments: [pay(1, { amount: { amount_paisa: 1800.5, currency: 'NPR' } })] })],
      ['currency USD', P({ payments: [pay(1, { amount: { amount_paisa: 1800, currency: 'USD' } })] })],
      ['extra top-level key', P({ extra: 1 })],
    ];
    for (const [name, p] of bad) {
      const { hc, ctx, run, stored } = setup();
      const e = await rejection(run(() => hc.collectionSynced(ctx, p, { visitVersion: 1 })));
      expect(e.code, name).toBe('common.internal');
      expect(stored(), name).toHaveLength(0);
    }
  });
  it('exactly 50 collections and 10 payments is the largest valid event', async () => {
    const { hc, ctx, run, stored } = setup();
    await run(() => hc.collectionSynced(ctx, P({ collections: Array.from({ length: 50 }, (_x, i) => col(i + 1)), payments: Array.from({ length: 10 }, (_x, i) => pay(i + 1)) }), { visitVersion: 1 }));
    expect(stored()).toHaveLength(1);
  });
  it('invalid visitVersion (0, 1.5, NaN) fails closed (aggregate seq must be a positive integer) and stores nothing', async () => {
    for (const v of [0, 1.5, Number.NaN, -1]) {
      const { hc, ctx, run, stored } = setup();
      const e = await rejection(run(() => hc.collectionSynced(ctx, P(), { visitVersion: v })));
      expect(e.code, String(v)).toBe('common.internal');
      expect(stored()).toHaveLength(0);
    }
  });
  it('rollback of the caller tx drops the event (same-transaction guarantee)', async () => {
    const { db, hc, ctx } = setup();
    await rejection(db.transaction(async () => { await hc.collectionSynced(ctx, P(), { visitVersion: 1 }); throw new Error('later step failed'); }));
    expect(db.events).toHaveLength(0);
  });
});
