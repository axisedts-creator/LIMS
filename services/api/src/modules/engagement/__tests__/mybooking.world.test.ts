// Self-test of the T-BK1 world (mybooking.world.ts): the properties the E30-E40 tests rely on must hold in the fake itself, otherwise a correct implementation could fail for harness reasons.
// PAT_ACC row filter, WITH CHECK on INSERT (42501), per-request rollback incl. real events, numeric delta undo under concurrency, FK / CHECK / UNIQUE of the touched tables.
import { describe, expect, it } from 'vitest';
import { eventValidators } from '../../../core/events/publish.js';
import { A, C1, ID, NOW, O, SLOT, makeBookingWorld } from './mybooking.world.js';

const X = ID(0x800), Y = ID(0x802);
const run = (w: ReturnType<typeof makeBookingWorld>, who: any, fn: (ctx: any) => Promise<unknown>) => w.call({ probe: async (_r: unknown, ctx: any) => ({ status: 200, body: await fn(ctx) }) } as any, 'probe', who);
const ins = (ctx: any, id: string, account: string | null, over: Record<string, unknown> = {}) => ctx.tx.query(
  'INSERT INTO engagement.addresses (id, tenant_id, account_id, patient_id, label, address_text, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
  [id, A, account, X, over['label'] ?? 'home', over['text'] ?? 'Synthetic Lane 1', ctx.actor.id, ctx.actor.id]);

describe('world: patient row filter (PAT_ACC)', () => {
  it('a patient sees only its own account\'s links / addresses / bookings; staff-entered rows (account_id NULL) are invisible; catalogue tables are tenant-wide', async () => {
    const w = makeBookingWorld(); const a1 = w.seedAccount(), a2 = w.seedAccount(); const l1 = w.seedLink(a1, X), l2 = w.seedLink(a2, Y);
    w.seedAddress(a1, X); w.seedAddress(a2, Y); w.seedAddress(null, X);
    const oc = w.seedOccupancy(SLOT, 1); w.seedBooking(a1, l1, X, { slot_occupancy_id: oc['id'] }); w.seedBooking(a2, l2, Y, { slot_occupancy_id: oc['id'] }); w.seedBooking(null, null, X, { slot_occupancy_id: oc['id'] });
    const r = await run(w, { account: a1 }, async (ctx) => ({
      links: (await ctx.tx.query('SELECT * FROM engagement.account_patient_links WHERE tenant_id = $1', [A])).rows.length, addr: (await ctx.tx.query('SELECT * FROM engagement.addresses WHERE tenant_id = $1', [A])).rows.length,
      bk: (await ctx.tx.query('SELECT * FROM engagement.bookings WHERE tenant_id = $1', [A])).rows.length, items: (await ctx.tx.query('SELECT * FROM engagement.booking_items WHERE tenant_id = $1', [A])).rows.length,
      items2: (await ctx.tx.query('SELECT * FROM engagement.bookable_items WHERE tenant_id = $1', [A])).rows.length, occ: (await ctx.tx.query('SELECT * FROM engagement.slot_occupancy WHERE tenant_id = $1', [A])).rows.length }));
    expect(r.error).toBeUndefined(); expect(r.out.body).toMatchObject({ links: 1, addr: 1, bk: 1, items: 1 }); expect(r.out.body.items2).toBeGreaterThan(3); expect(r.out.body.occ).toBeGreaterThan(3);
    const other = await run(w, { account: a1, tenant: ID(0xdead) }, async (ctx) => (await ctx.tx.query('SELECT * FROM engagement.bookings WHERE tenant_id = $1', [A])).rows.length); expect(other.out.body).toBe(0); // tenant RLS
  });
  it('an INSERT of a row owned by another account (or by nobody) is refused with 42501; its own account is accepted', async () => {
    const w = makeBookingWorld(); const a1 = w.seedAccount(), a2 = w.seedAccount(); w.seedLink(a1, X);
    expect((await run(w, { account: a1 }, (ctx) => ins(ctx, ID(0x7001), a1['id']))).error).toBeUndefined();
    for (const owner of [a2['id'], null]) expect((await run(w, { account: a1 }, (ctx) => ins(ctx, ID(0x7002), owner))).error?.code).toBe('42501');
    expect(w.t['addresses']).toHaveLength(1);
  });
  it('CHECK / UNIQUE / FK of addresses and bookings hold (label, length, phone, unknown account)', async () => {
    const w = makeBookingWorld(); const a1 = w.seedAccount();
    expect((await run(w, { account: a1 }, (ctx) => ins(ctx, ID(0x7003), a1['id'], { label: 'office' }))).error?.code).toBe('23514');
    expect((await run(w, { account: a1 }, (ctx) => ins(ctx, ID(0x7004), a1['id'], { text: 'x'.repeat(301) }))).error?.code).toBe('23514');
    expect((await run(w, { account: a1 }, async (ctx) => { await ins(ctx, ID(0x7005), a1['id']); return ins(ctx, ID(0x7005), a1['id']); })).error?.code).toBe('23505');
    expect(w.t['addresses']).toHaveLength(0); // the failed request rolled its first insert back too
  });
});

describe('world: one transaction per request', () => {
  it('a throw undoes inserts, updates and the REAL event row written in that request; a success keeps them', async () => {
    const w = makeBookingWorld(); const a1 = w.seedAccount(); const l1 = w.seedLink(a1, X); void l1; const oc = w.seedOccupancy(SLOT, 0);
    const work = async (ctx: any, fail: boolean) => {
      await ins(ctx, ID(0x7010), a1['id']);
      await ctx.tx.query('UPDATE engagement.slot_occupancy SET booked = booked + 1 WHERE tenant_id = $1 AND id = $2', [A, oc['id']]);
      await ctx.events.publish(ctx, 'engagement.booking.cancelled.v1', { aggregate: { type: 'booking', id: ID(0x7011), seq: 2 }, idempotencyKey: `${ID(0x7011)}:cancelled`,
        payload: { booking_id: ID(0x7011), patient_id: X, booking_kind: 'centre_visit', reason_code: 'patient_request', cancelled_by_kind: 'patient', slot_start: SLOT, cancelled_at: NOW } });
      if (fail) throw new Error('boom');
    };
    const bad = await run(w, { account: a1 }, (ctx) => work(ctx, true)); expect(bad.error?.message).toBe('boom');
    expect(w.t['addresses']).toHaveLength(0); expect(oc['booked']).toBe(0); expect(w.t['event_log']).toHaveLength(0);
    const good = await run(w, { account: a1 }, (ctx) => work(ctx, false)); expect(good.error).toBeUndefined();
    expect(w.t['addresses']).toHaveLength(1); expect(oc['booked']).toBe(1); expect(w.events('engagement.booking.cancelled.v1')).toHaveLength(1); expect(eventValidators().get('engagement.booking.cancelled.v1')!(w.events()[0])).toBe(true);
    expect(w.events()[0]).toMatchObject({ actor: { type: 'patient', id: a1['user_id'] }, tenant_id: A });
  });
  it('concurrent sessions: a rolled-back increment does not erase another session\'s committed increment (delta undo)', async () => {
    const w = makeBookingWorld(); const a1 = w.seedAccount(), a2 = w.seedAccount(); const oc = w.seedOccupancy(SLOT, 0);
    const inc = (ctx: any) => ctx.tx.query('UPDATE engagement.slot_occupancy SET booked = booked + 1 WHERE tenant_id = $1 AND id = $2 AND booked < capacity', [A, oc['id']]);
    const [bad, good] = await Promise.all([run(w, { account: a1 }, async (ctx) => { await inc(ctx); await inc(ctx); throw new Error('late failure'); }), run(w, { account: a2 }, async (ctx) => { await inc(ctx); })]);
    expect(bad.error?.message).toBe('late failure'); expect(good.error).toBeUndefined(); expect(oc['booked']).toBe(1);
  });
  it('the conditional reserve UPDATE is atomic per statement: 5 sessions racing for 2 places win exactly 2', async () => {
    const w = makeBookingWorld(); const accts = Array.from({ length: 5 }, () => w.seedAccount()); const oc = w.seedOccupancy(SLOT, 1);
    const res = await Promise.all(accts.map((a) => run(w, { account: a }, async (ctx) => (await ctx.tx.query('UPDATE engagement.slot_occupancy SET booked = booked + 1 WHERE tenant_id = $1 AND id = $2 AND booked < capacity RETURNING id', [A, oc['id']])).rowCount)));
    expect(res.map((r) => r.out.body).filter((n) => n === 1)).toHaveLength(2); expect(oc['booked']).toBe(3);
  });
  it('the seeded catalogue is what the tests expect (C1 template capacity 3, a full and a one-left slot, 7 bookable items incl. the female-only package)', () => {
    const w = makeBookingWorld(); expect(w.t['bookable_items']!.map((i) => i['orderable_id'])).toContain(O.WHP); expect(w.t['slot_templates']!.find((t) => t['centre_id'] === C1)).toMatchObject({ capacity: 3, slot_minutes: 15 });
    expect(w.t['slot_occupancy']!.map((o) => o['booked']).sort()).toEqual([1, 2, 3]);
  });
});
