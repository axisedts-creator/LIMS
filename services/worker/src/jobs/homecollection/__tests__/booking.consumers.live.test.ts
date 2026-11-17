// HC-T05: engagement.booking.confirmed.v1 / engagement.booking.cancelled.v1 consumers of C17 (02-TRD §8.2 + §8.3, 03-IC §3.22 / §3.24, 01-PRD US-01-1..5 + US-10-1..4, 07-SECURITY §4 consumers + log scan).
// Live PG17 (migrated + seeded + homecollection DDL; tests/homecollection/HC-T05.pg.sh exports LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL; missing env = HARD FAILURE, never a skip).
// Handlers run through a hand-built JobContext (FD-T10 pattern): ctx.tx = a pg client in a transaction as lims_api under RLS with the system actor's claims; ctx.db.tx = a REAL savepoint
// wrapper (08 A19 P-44: a throwing callback rolls back to the savepoint and rethrows); ctx.ports.EngagementPort = a fake. Fixtures are written as superuser; assertions read as superuser (no RLS).
// Synthetic data only (tenant A "Synthetic Lab Alpha" / B, home-collection centre HC-A1, patient "Test Patient 0042").
// ASSUMED (spec silent; the implementer disputes if wrong):
//  - files: services/worker/src/jobs/homecollection/consumers/engagement.booking.confirmed.v1.ts exports `onBookingConfirmed`, ...cancelled.v1.ts exports `onBookingCancelled` (02-TRD §3.2 names + "consumers/<event_type>.ts, dots kept");
//    both are ConsumerHandler = (event: full envelope, ctx) => Promise<void>, event.aggregate.seq = ordering seq, event.tenant_id must equal ctx.tenantId (else a no-op, like the frontdesk consumers).
//  - the inbox row (core wrapper, AC-0D-5.5) and ajv unknown-field stripping are the wrapper's (worker core tests); here "inbox dedupe" = the handler is safe when the SAME event is delivered again.
//  - the port is reached as ctx.ports.EngagementPort.getHomeAddress(ctx, { homeAddressId, purpose: 'home_visit' }) (same shape as ctx.ports.IdentityPort in the analytics tasks).
//  - every status change writes a visit_transitions row (05-SCHEMA §1 "every visit state change"); only to_status / reason_code are asserted.
//  - a concurrent duplicate may either no-op or fail with SQLSTATE 23505 (retried by the queue); the end state must be one visit.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BRANCH, rows as fd } from '../../../../../api/src/modules/frontdesk/__tests__/integration/helpers.js';
import { appTx, closePools, hc, HC_CENTRE, MEMBER, ownerRows, seed, SYS_ACTOR, TENANT, uid, type Side } from '../../../../../api/src/modules/homecollection/repository/__tests__/helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });                                      // live PG: review item 3 (5 s / 10 s defaults timed out)
const CONFIRMED = 'engagement.booking.confirmed.v1';
const CANCELLED = 'engagement.booking.cancelled.v1';
const PHI_ADDR = 'SENTINEL-ADDR-Synthetic-Lane-7';
const PHI_NAME = 'SENTINEL-NAME-Test-Patient-0042';
let onConfirmed: (event: any, ctx: any) => Promise<void>;
let onCancelled: (event: any, ctx: any) => Promise<void>;

// ------------------------------------------------------------------------------------------------ doubles
function makePort(o: { address?: any; error?: Error } = {}) {
  const calls: Array<{ ctx: any; input: any }> = [];
  return {
    calls,
    async getHomeAddress(ctx: any, input: any) {
      calls.push({ ctx, input });
      if (o.error) throw o.error;
      return o.address ?? { addressText: `${PHI_ADDR}, Ward 4`, landmark: 'Near the synthetic temple', latitude: '27.717200', longitude: '85.324000' };
    },
  };
}
type Port = ReturnType<typeof makePort>;

let spN = 0;
function makeCtx(tx: any, tenant: string, port: Port, logs: string[], audits: any[] = []) {
  const sink = (x: unknown, m?: unknown) => logs.push(JSON.stringify([x, m]));
  const log: any = { info: sink, warn: sink, error: sink, debug: sink, child: () => log };
  const ctx: any = {
    tenantId: tenant, tx, actor: { type: 'system', id: SYS_ACTOR }, requestId: uid(), attempt: 1, maxAttempts: 5, jobId: '1',
    now: () => new Date().toISOString(), isNewer: (last: number | undefined, seq: number) => last === undefined || seq > last,
    events: {}, core: {}, audit: { access: async (e: any) => { audits.push(e); } }, storage: {}, files: {}, log, metrics: { inc() {}, set() {}, observe() {} },
    ports: { EngagementPort: port },
  };
  ctx.db = {
    tx: async (fn: (c: any) => Promise<any>) => {
      const sp = `hc_t05_sp_${++spN}`;
      await tx.query(`SAVEPOINT ${sp}`);
      try { const r = await fn(ctx); await tx.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
    },
  };
  return ctx;
}

interface World { s: Side; tenant: string; patient: any; order: any }
const worlds = {} as Record<Side, World>;
async function mkWorld(s: Side): Promise<World> {
  const patient = fd.patient(s); await seed('frontdesk.patients', patient);
  const order = fd.order(s, patient.id, { centre_id: HC_CENTRE[s], collection_mode: 'home' }); await seed('frontdesk.orders', order);
  return { s, tenant: TENANT[s], patient, order };
}

// ------------------------------------------------------------------------------------------------ events
const iso = (d: string) => `${d}.000Z`;
function confirmedEvent(w: World, o: { seq?: number; payload?: Record<string, unknown>; env?: Record<string, unknown>; bookingId?: string } = {}): any {
  const bookingId = o.bookingId ?? uid();
  return {
    event_id: uid(), event_type: CONFIRMED, tenant_id: w.tenant, occurred_at: iso('2026-11-05T09:00:00'),
    actor: { type: 'user', id: uid() }, idempotency_key: `${bookingId}:confirmed`, producer: 'engagement',
    aggregate: { type: 'booking', id: bookingId, seq: o.seq ?? 1 }, request_id: uid(),
    payload: {
      booking_id: bookingId, patient_id: w.patient.id, branch_id: BRANCH[w.s], centre_id: HC_CENTRE[w.s], booking_kind: 'home_collection',
      slot_start: iso('2026-11-06T01:15:00'), slot_end: iso('2026-11-06T01:45:00'), orderable_ids: [uid(), uid()],
      home_address_id: uid(), confirmed_at: iso('2026-11-05T09:00:00'), ...o.payload,
    },
    ...o.env,
  };
}
function cancelledEvent(w: World, bookingId: string, o: { seq?: number; payload?: Record<string, unknown>; env?: Record<string, unknown> } = {}): any {
  return {
    event_id: uid(), event_type: CANCELLED, tenant_id: w.tenant, occurred_at: iso('2026-11-05T10:00:00'),
    actor: { type: 'user', id: uid() }, idempotency_key: `${bookingId}:cancelled`, producer: 'engagement',
    aggregate: { type: 'booking', id: bookingId, seq: o.seq ?? 2 }, request_id: uid(),
    payload: {
      booking_id: bookingId, patient_id: w.patient.id, booking_kind: 'home_collection', reason_code: 'patient_request', cancelled_by_kind: 'patient',
      cancelled_at: iso('2026-11-05T10:00:00'), ...o.payload,
    },
    ...o.env,
  };
}

/** One delivery = one transaction (as the queue does); returns the thrown error instead of throwing. */
async function deliver(handler: (e: any, c: any) => Promise<void>, event: any, o: { port?: Port; ctxTenant?: string } = {}) {
  const port = o.port ?? makePort(); const logs: string[] = []; const audits: any[] = []; let threw: any;
  try { await appTx(o.ctxTenant ?? event.tenant_id, async (tx) => { await handler(event, makeCtx(tx, o.ctxTenant ?? event.tenant_id, port, logs, audits)); }); }
  catch (e) { threw = e; }
  return { port, logs, audits, threw };
}
const confirm = (e: any, o?: { port?: Port; ctxTenant?: string }) => deliver(onConfirmed, e, o);
const cancel = (e: any, o?: { port?: Port; ctxTenant?: string }) => deliver(onCancelled, e, o);

// ------------------------------------------------------------------------------------------------ reads (superuser, no RLS)
const visitsOf = (tenant: string, bookingId: string) => ownerRows('homecollection.visits', 'tenant_id = $1 AND booking_id = $2', [tenant, bookingId]);
const refsOf = (tenant: string, bookingId: string) => ownerRows('homecollection.booking_refs', 'tenant_id = $1 AND booking_id = $2', [tenant, bookingId]);
const flagsOf = (tenant: string, visitId: string, kind?: string) =>
  ownerRows('homecollection.visit_flags', kind ? 'tenant_id = $1 AND visit_id = $2 AND kind = $3' : 'tenant_id = $1 AND visit_id = $2', kind ? [tenant, visitId, kind] : [tenant, visitId]);
const transitionsOf = (tenant: string, visitId: string) => ownerRows('homecollection.visit_transitions', 'tenant_id = $1 AND visit_id = $2', [tenant, visitId]);
const routeOf = async (tenant: string, id: string) => (await ownerRows('homecollection.routes', 'tenant_id = $1 AND id = $2', [tenant, id]))[0];
const everything = async (tenant: string, visitId: string) =>
  JSON.stringify([await ownerRows('homecollection.visits', 'tenant_id = $1 AND id = $2', [tenant, visitId]), await flagsOf(tenant, visitId), await transitionsOf(tenant, visitId)]);

// ------------------------------------------------------------------------------------------------ fixtures: an existing visit in a given state
type Status = 'unassigned' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
async function existingVisit(w: World, status: Status, o: { bookingId?: string; withRef?: boolean; refSeq?: number } = {}) {
  const bookingId = o.bookingId ?? uid();
  const base: Record<string, unknown> = { booking_id: bookingId, status, centre_id: HC_CENTRE[w.s], branch_id: BRANCH[w.s], patient_id: w.patient.id, orderable_ids: [uid()],
    window_start: '2026-11-06T01:15:00Z', window_end: '2026-11-06T01:45:00Z' };
  let route: any;
  if (status !== 'unassigned' && status !== 'cancelled') base['order_id'] = w.order.id;
  if (status === 'assigned' || status === 'in_progress') {
    route = hc.route(w.s); await seed('homecollection.routes', route);
    Object.assign(base, { route_id: route.id, route_date: route.route_date, route_sequence: 1, assigned_membership_id: MEMBER[w.s], assigned_at: '2026-11-05T12:00:00Z' });
  }
  if (status === 'in_progress') base['arrived_at'] = '2026-11-06T01:20:00Z';
  if (status === 'completed') Object.assign(base, { outcome: 'collected', completed_at: '2026-11-06T01:30:00Z' });
  if (status === 'failed') Object.assign(base, { outcome: 'none', failed_at: '2026-11-06T01:30:00Z', status_reason_code: 'patient_not_home' });
  if (status === 'cancelled') Object.assign(base, { cancelled_at: '2026-11-05T11:00:00Z', status_reason_code: 'patient_request' });
  const visit = hc.bookingVisit(w.s, { patient: w.patient }, base);
  await seed('homecollection.visits', visit);
  if (o.withRef !== false) await seed('homecollection.booking_refs', hc.bookingRef(w.s, { booking_id: bookingId, state: 'confirmed', last_seq: o.refSeq ?? 1, visit_id: visit.id }));
  return { visit, route, bookingId };
}

beforeAll(async () => {
  worlds.a = await mkWorld('a'); worlds.b = await mkWorld('b');
  onConfirmed = (await import('../consumers/engagement.booking.confirmed.v1.js')).onBookingConfirmed;
  onCancelled = (await import('../consumers/engagement.booking.cancelled.v1.js')).onBookingCancelled;
});
afterAll(async () => { await closePools(); });

// ================================================================================================ confirmed
describe('HC-T05 engagement.booking.confirmed.v1 -> visit (US-01)', () => {
  it('US-01-1 (03-IC §3.22 example shape): one unassigned booking visit with every field mapped, no order_id; booking_refs confirmed with last_seq = aggregate.seq and the visit id', async () => {
    const w = worlds.a; const ev = confirmedEvent(w, { seq: 7, payload: { referrer_id: uid() } }); const p = ev.payload;
    const r = await confirm(ev);
    expect(r.threw).toBeUndefined();
    const vs = await visitsOf(w.tenant, p.booking_id);
    expect(vs).toHaveLength(1);
    const v = vs[0];
    expect(v).toMatchObject({ status: 'unassigned', kind: 'booking', booking_id: p.booking_id, patient_id: p.patient_id, centre_id: p.centre_id, branch_id: p.branch_id, order_id: null,
      referrer_id: p.referrer_id, home_address_id: p.home_address_id, is_active: true });
    expect([...v.orderable_ids].sort()).toEqual([...p.orderable_ids].sort());
    expect(new Date(v.window_start).toISOString()).toBe(p.slot_start);
    expect(new Date(v.window_end).toISOString()).toBe(p.slot_end);
    expect(v.tenant_id).toBe(w.tenant);
    expect(v.created_by).toBe(SYS_ACTOR);
    const refs = await refsOf(w.tenant, p.booking_id);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ state: 'confirmed', last_seq: 7, visit_id: v.id });
    const tr = await transitionsOf(w.tenant, v.id);                                              // ASSUMED: every state change is recorded
    expect(tr.filter((t) => t.to_status === 'unassigned' && t.from_status === null)).toHaveLength(1);
  });

  it('US-01-4a: home_address_id + port returns an address -> address_text / landmark / coordinates stored, no address_missing flag; port called once as the system actor with purpose home_visit', async () => {
    const w = worlds.a; const ev = confirmedEvent(w); const port = makePort();
    const r = await confirm(ev, { port });
    expect(r.threw).toBeUndefined();
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.input).toEqual({ homeAddressId: ev.payload.home_address_id, purpose: 'home_visit' });
    expect(port.calls[0]!.ctx.actor).toMatchObject({ type: 'system' });
    const v = (await visitsOf(w.tenant, ev.payload.booking_id))[0];
    expect(v.address_text).toBe(`${PHI_ADDR}, Ward 4`);
    expect(v.landmark).toBe('Near the synthetic temple');
    expect(Number(v.latitude)).toBeCloseTo(27.7172, 4);
    expect(Number(v.longitude)).toBeCloseTo(85.324, 4);
    expect(await flagsOf(w.tenant, v.id, 'address_missing')).toHaveLength(0);
    expect(r.audits).toEqual([{ action: 'home_visit.view', entityType: 'home_visit', entityId: v.id, purpose: 'home_address_fetch', outcome: 'allowed' }]);   // 02-TRD §8.2 / §14 access log
  });

  it('US-01-4a: an address without landmark / coordinates is stored as such (both coordinates null, DB both-or-neither CHECK holds)', async () => {
    const w = worlds.a; const ev = confirmedEvent(w);
    const r = await confirm(ev, { port: makePort({ address: { addressText: 'Synthetic Lane 9' } }) });
    expect(r.threw).toBeUndefined();
    const v = (await visitsOf(w.tenant, ev.payload.booking_id))[0];
    expect(v).toMatchObject({ address_text: 'Synthetic Lane 9', landmark: null, latitude: null, longitude: null });
  });

  it('US-01-4b: the port throws -> visit still created WITHOUT address, flag address_missing open, the consumer does not throw, booking_refs confirmed', async () => {
    const w = worlds.a; const ev = confirmedEvent(w);
    const r = await confirm(ev, { port: makePort({ error: Object.assign(new Error(`upstream down for ${PHI_ADDR}`), { code: 'common.unavailable' }) }) });
    expect(r.threw).toBeUndefined();
    const v = (await visitsOf(w.tenant, ev.payload.booking_id))[0];
    expect(v).toMatchObject({ status: 'unassigned', address_text: null, landmark: null, latitude: null, longitude: null });
    const fl = await flagsOf(w.tenant, v.id, 'address_missing');
    expect(fl).toHaveLength(1);
    expect(fl[0]).toMatchObject({ status: 'open', centre_id: HC_CENTRE[w.s] });
    expect((await refsOf(w.tenant, ev.payload.booking_id))[0]).toMatchObject({ state: 'confirmed', visit_id: v.id });
    expect(r.logs.join('\n')).not.toContain(PHI_ADDR);                                           // 07 §6 log scan: no address in logs, not even inside an error message
    expect(r.audits).toEqual([{ action: 'home_visit.view', entityType: 'home_visit', entityId: v.id, purpose: 'home_address_fetch', outcome: 'allowed' }]);   // port was called -> exactly one access row
  });

  it('US-01-4b: the port reports common.not_found (address deleted) -> same degradation (address_missing)', async () => {
    const w = worlds.a; const ev = confirmedEvent(w);
    const r = await confirm(ev, { port: makePort({ error: Object.assign(new Error('not found'), { code: 'common.not_found' }) }) });
    expect(r.threw).toBeUndefined();
    const v = (await visitsOf(w.tenant, ev.payload.booking_id))[0];
    expect(v.address_text).toBeNull();
    expect(await flagsOf(w.tenant, v.id, 'address_missing')).toHaveLength(1);
  });

  it('US-01-4b / APP-FLOW V1: no home_address_id in the event -> the port is NOT called, visit created, flag address_missing open', async () => {
    const w = worlds.a; const ev = confirmedEvent(w); delete ev.payload.home_address_id; const port = makePort();
    const r = await confirm(ev, { port });
    expect(r.threw).toBeUndefined();
    expect(port.calls).toHaveLength(0);
    expect(r.audits).toHaveLength(0);                                                            // port not called -> no access row
    const v = (await visitsOf(w.tenant, ev.payload.booking_id))[0];
    expect(v).toMatchObject({ address_text: null, home_address_id: null });
    expect(await flagsOf(w.tenant, v.id, 'address_missing')).toHaveLength(1);
  });

  it('US-01-2: the same event delivered twice -> still one visit, one booking_refs row, one address_missing flag (no duplicate flag), port not re-called for a visit that already exists', async () => {
    const w = worlds.a; const ev = confirmedEvent(w);
    const down = makePort({ error: new Error('down') });
    expect((await confirm(ev, { port: down })).threw).toBeUndefined();
    const again = makePort();
    const redelivery = await confirm(ev, { port: again });
    expect(redelivery.threw).toBeUndefined();
    expect(redelivery.audits).toHaveLength(0);                                                  // redelivery: port not called -> no access row
    const vs = await visitsOf(w.tenant, ev.payload.booking_id);
    expect(vs).toHaveLength(1);
    expect(await refsOf(w.tenant, ev.payload.booking_id)).toHaveLength(1);
    expect(await flagsOf(w.tenant, vs[0].id, 'address_missing')).toHaveLength(1);
    expect(vs[0].address_text).toBeNull();                                                      // a redelivery must not silently rewrite the visit
    expect(again.calls).toHaveLength(0);
  });

  it('US-01-2: a redelivery with a NEW event_id for the same booking and seq (producer retry) -> still one visit', async () => {
    const w = worlds.a; const first = confirmedEvent(w, { seq: 3 }); await confirm(first);
    const second = confirmedEvent(w, { seq: 3, bookingId: first.payload.booking_id, payload: { ...first.payload } });
    expect((await confirm(second)).threw).toBeUndefined();
    expect(await visitsOf(w.tenant, first.payload.booking_id)).toHaveLength(1);
    expect(await refsOf(w.tenant, first.payload.booking_id)).toHaveLength(1);
  });

  it('US-01-2 (concurrency): 8 parallel deliveries of one event -> exactly one visit and one booking_refs row; a loser may only fail with unique_violation 23505', async () => {
    const w = worlds.a; const ev = confirmedEvent(w);
    const res = await Promise.all(Array.from({ length: 8 }, () => confirm(ev)));
    for (const r of res) if (r.threw) expect(r.threw.code).toBe('23505');
    expect(res.some((r) => !r.threw)).toBe(true);
    expect(await visitsOf(w.tenant, ev.payload.booking_id)).toHaveLength(1);
    expect(await refsOf(w.tenant, ev.payload.booking_id)).toHaveLength(1);
  });

  it('US-01-3: booking_kind = centre_visit -> no visit, no booking_refs row, no port call (C4 owns those)', async () => {
    const w = worlds.a; const ev = confirmedEvent(w, { payload: { booking_kind: 'centre_visit' } }); const port = makePort();
    const r = await confirm(ev, { port });
    expect(r.threw).toBeUndefined();
    expect(await visitsOf(w.tenant, ev.payload.booking_id)).toHaveLength(0);
    expect(await refsOf(w.tenant, ev.payload.booking_id)).toHaveLength(0);
    expect(port.calls).toHaveLength(0);
    expect(r.audits).toHaveLength(0);
  });

  it('US-01-5 / 03-IC §3.24 ordering: cancelled (seq 5) processed first, then confirmed (seq 3) -> NO visit, booking_refs stays cancelled with last_seq 5, no port call', async () => {
    const w = worlds.a; const bookingId = uid();
    expect((await cancel(cancelledEvent(w, bookingId, { seq: 5 }))).threw).toBeUndefined();
    const port = makePort();
    const r = await confirm(confirmedEvent(w, { seq: 3, bookingId }), { port });
    expect(r.threw).toBeUndefined();
    expect(await visitsOf(w.tenant, bookingId)).toHaveLength(0);
    expect(port.calls).toHaveLength(0);
    const refs = await refsOf(w.tenant, bookingId);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ state: 'cancelled', last_seq: 5, visit_id: null });
  });

  it('US-01-5 boundary (TRD §8.2 "last_seq >= aggregate.seq -> ignore"): cancelled seq 4 then confirmed seq 4 -> no visit', async () => {
    const w = worlds.a; const bookingId = uid();
    await cancel(cancelledEvent(w, bookingId, { seq: 4 }));
    await confirm(confirmedEvent(w, { seq: 4, bookingId }));
    expect(await visitsOf(w.tenant, bookingId)).toHaveLength(0);
    expect((await refsOf(w.tenant, bookingId))[0]).toMatchObject({ state: 'cancelled', last_seq: 4 });
  });

  it('TRD §8.2 "else create visit": cancelled seq 2 then a confirmed with the HIGHER seq 3 -> the visit is created and booking_refs is upserted to confirmed / 3 / visit id (one row)', async () => {
    const w = worlds.a; const bookingId = uid();
    await cancel(cancelledEvent(w, bookingId, { seq: 2 }));
    expect((await confirm(confirmedEvent(w, { seq: 3, bookingId }))).threw).toBeUndefined();
    const vs = await visitsOf(w.tenant, bookingId);
    expect(vs).toHaveLength(1);
    const refs = await refsOf(w.tenant, bookingId);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ state: 'confirmed', last_seq: 3, visit_id: vs[0].id });
  });

  it('unknown fields: extra payload and envelope fields (forward-compatible producer) are ignored and never persisted or logged; the visit is still created', async () => {
    const w = worlds.a;
    const ev = confirmedEvent(w, { payload: { patient_name: PHI_NAME, home_address_text: PHI_ADDR, future_field: { a: 1 } }, env: { x_future: PHI_NAME } });
    const r = await confirm(ev, { port: makePort({ address: { addressText: 'Synthetic Lane 3' } }) });
    expect(r.threw).toBeUndefined();
    const v = (await visitsOf(w.tenant, ev.payload.booking_id))[0];
    expect(v).toBeTruthy();
    expect(v.address_text).toBe('Synthetic Lane 3');                                              // the address comes from the port, never from an event field
    const dump = JSON.stringify([await visitsOf(w.tenant, ev.payload.booking_id), await refsOf(w.tenant, ev.payload.booking_id), await flagsOf(w.tenant, v.id)]);
    expect(dump).not.toContain(PHI_NAME);
    expect(dump).not.toContain(PHI_ADDR);
    expect(r.logs.join('\n')).not.toContain(PHI_NAME);
    expect(r.logs.join('\n')).not.toContain(PHI_ADDR);
  });

  it('tenant isolation: an event whose tenant_id differs from ctx.tenantId writes nothing in either tenant', async () => {
    const a = worlds.a, b = worlds.b; const ev = confirmedEvent(b);
    const r = await confirm(ev, { ctxTenant: a.tenant });
    expect(r.threw === undefined || r.threw).toBeTruthy();                                       // no-op or a loud failure are both acceptable; a write is not
    expect(await visitsOf(a.tenant, ev.payload.booking_id)).toHaveLength(0);
    expect(await visitsOf(b.tenant, ev.payload.booking_id)).toHaveLength(0);
    expect(await refsOf(a.tenant, ev.payload.booking_id)).toHaveLength(0);
    expect(await refsOf(b.tenant, ev.payload.booking_id)).toHaveLength(0);
  });

  it('tenant isolation: the same booking_id in tenant A and tenant B creates one visit per tenant (booking uniqueness is per tenant)', async () => {
    const bookingId = uid();
    await confirm(confirmedEvent(worlds.a, { bookingId }));
    await confirm(confirmedEvent(worlds.b, { bookingId }));
    expect(await visitsOf(worlds.a.tenant, bookingId)).toHaveLength(1);
    expect(await visitsOf(worlds.b.tenant, bookingId)).toHaveLength(1);
  });

  it('hostile values: a booking whose patient is unknown to the tenant (other tenant patient) fails loudly (FK) and leaves no visit / booking_refs behind', async () => {
    const w = worlds.a; const ev = confirmedEvent(w, { payload: { patient_id: worlds.b.patient.id } });
    const r = await confirm(ev);
    expect(r.threw).toBeTruthy();
    expect(await visitsOf(w.tenant, ev.payload.booking_id)).toHaveLength(0);
    expect(await refsOf(w.tenant, ev.payload.booking_id)).toHaveLength(0);
  });
});

// ================================================================================================ cancelled
describe('HC-T05 engagement.booking.cancelled.v1 -> visit (US-10)', () => {
  it('US-10-1: unassigned visit -> cancelled, status_reason_code booking_cancelled, the event reason_code kept in status_reason_text, cancelled_at set, no flag; booking_refs cancelled with last_seq', async () => {
    const w = worlds.a; const { visit, bookingId } = await existingVisit(w, 'unassigned');
    const r = await cancel(cancelledEvent(w, bookingId, { seq: 2, payload: { reason_code: 'no_show', home_visit_id: visit.id } }));
    expect(r.threw).toBeUndefined();
    const v = (await visitsOf(w.tenant, bookingId))[0];
    expect(v).toMatchObject({ id: visit.id, status: 'cancelled', status_reason_code: 'booking_cancelled', status_reason_text: 'no_show' });
    expect(v.cancelled_at).not.toBeNull();
    expect(await flagsOf(w.tenant, visit.id)).toHaveLength(0);
    expect((await refsOf(w.tenant, bookingId))[0]).toMatchObject({ state: 'cancelled', last_seq: 2, visit_id: visit.id });
    const tr = await transitionsOf(w.tenant, visit.id);                                          // ASSUMED: every state change is recorded
    expect(tr.some((t) => t.to_status === 'cancelled' && t.from_status === 'unassigned')).toBe(true);
  });

  it('US-10-1 (m#32 / 08 A13 P-4): an engagement reason_code that is NOT a C17 code is stored verbatim as text, never validated against visit_cancel_reasons', async () => {
    const w = worlds.a; const { bookingId } = await existingVisit(w, 'unassigned');
    const r = await cancel(cancelledEvent(w, bookingId, { payload: { reason_code: 'tenant_custom_reason_42' } }));
    expect(r.threw).toBeUndefined();
    expect((await visitsOf(w.tenant, bookingId))[0]).toMatchObject({ status: 'cancelled', status_reason_code: 'booking_cancelled', status_reason_text: 'tenant_custom_reason_42' });
  });

  it('US-10-2: assigned visit with order_id -> cancelled + flag order_cancel_required open (link target is the order); route_id / route_date / route_sequence kept; route version incremented', async () => {
    const w = worlds.a; const { visit, route, bookingId } = await existingVisit(w, 'assigned');
    const before = await routeOf(w.tenant, route.id);
    const r = await cancel(cancelledEvent(w, bookingId, { seq: 2, payload: { reason_code: 'patient_request', order_id: w.order.id } }));
    expect(r.threw).toBeUndefined();
    const v = (await visitsOf(w.tenant, bookingId))[0];
    expect(v).toMatchObject({ status: 'cancelled', status_reason_code: 'booking_cancelled', status_reason_text: 'patient_request', order_id: w.order.id,
      route_id: route.id, route_sequence: 1 });
    // pg parses DATE as local midnight: compare local y-m-d, not toISOString (ruling HC-T05-ruling.md)
    const ymd = (d: unknown) => d instanceof Date
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : String(d).slice(0, 10);
    expect(ymd(v.route_date)).toBe(ymd(visit.route_date));
    const fl = await flagsOf(w.tenant, visit.id, 'order_cancel_required');
    expect(fl).toHaveLength(1);
    expect(fl[0]).toMatchObject({ status: 'open', centre_id: HC_CENTRE[w.s] });
    expect((await routeOf(w.tenant, route.id)).version).toBe(before.version + 1);
    expect((await flagsOf(w.tenant, visit.id, 'cancel_requested_after_start'))).toHaveLength(0);
  });

  it('US-10-2: redelivery of the same cancel -> still one order_cancel_required flag, route version bumped only once', async () => {
    const w = worlds.a; const { visit, route, bookingId } = await existingVisit(w, 'assigned');
    const ev = cancelledEvent(w, bookingId, { seq: 2 });
    await cancel(ev);
    const mid = (await routeOf(w.tenant, route.id)).version;
    expect((await cancel(ev)).threw).toBeUndefined();
    expect(await flagsOf(w.tenant, visit.id, 'order_cancel_required')).toHaveLength(1);
    expect((await routeOf(w.tenant, route.id)).version).toBe(mid);
    expect((await visitsOf(w.tenant, bookingId))[0].status).toBe('cancelled');
  });

  it.each(['in_progress', 'completed'] as const)('US-10-3: %s visit -> NOT changed (status, reason, version, route), flag cancel_requested_after_start open, no order_cancel_required', async (status) => {
    const w = worlds.a; const { visit, bookingId } = await existingVisit(w, status);
    const before = (await visitsOf(w.tenant, bookingId))[0];
    const r = await cancel(cancelledEvent(w, bookingId, { seq: 2 }));
    expect(r.threw).toBeUndefined();
    const after = (await visitsOf(w.tenant, bookingId))[0];
    expect(after.status).toBe(status);
    expect(after).toMatchObject({ version: before.version, status_reason_code: before.status_reason_code, status_reason_text: before.status_reason_text, route_id: before.route_id,
      route_sequence: before.route_sequence, cancelled_at: null });
    const fl = await flagsOf(w.tenant, visit.id, 'cancel_requested_after_start');
    expect(fl).toHaveLength(1);
    expect(fl[0]).toMatchObject({ status: 'open' });
    expect(await flagsOf(w.tenant, visit.id, 'order_cancel_required')).toHaveLength(0);
  });

  it('US-10-3: redelivery after start -> still ONE cancel_requested_after_start flag', async () => {
    const w = worlds.a; const { visit, bookingId } = await existingVisit(w, 'in_progress');
    const ev = cancelledEvent(w, bookingId, { seq: 2 });
    await cancel(ev); await cancel(ev);
    expect(await flagsOf(w.tenant, visit.id, 'cancel_requested_after_start')).toHaveLength(1);
  });

  it.each(['failed', 'cancelled'] as const)('TRD §8.2: %s visit -> nothing (no status change, no flag, no new transition)', async (status) => {
    const w = worlds.a; const { visit, bookingId } = await existingVisit(w, status);
    const before = JSON.stringify(await visitsOf(w.tenant, bookingId));
    const trBefore = (await transitionsOf(w.tenant, visit.id)).length;
    const r = await cancel(cancelledEvent(w, bookingId, { seq: 2, payload: { reason_code: 'duplicate' } }));
    expect(r.threw).toBeUndefined();
    expect(JSON.stringify(await visitsOf(w.tenant, bookingId))).toBe(before);
    expect(await flagsOf(w.tenant, visit.id)).toHaveLength(0);
    expect((await transitionsOf(w.tenant, visit.id)).length).toBe(trBefore);
  });

  it('US-10-4 / US-01-5: no visit yet -> a booking_refs row cancelled with last_seq and no visit_id is stored (no visit created)', async () => {
    const w = worlds.a; const bookingId = uid();
    const r = await cancel(cancelledEvent(w, bookingId, { seq: 6 }));
    expect(r.threw).toBeUndefined();
    expect(await visitsOf(w.tenant, bookingId)).toHaveLength(0);
    const refs = await refsOf(w.tenant, bookingId);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ state: 'cancelled', last_seq: 6, visit_id: null });
  });

  it('US-10-4: redelivery of the cancel with no visit -> still one booking_refs row; an OLDER seq never lowers last_seq', async () => {
    const w = worlds.a; const bookingId = uid(); const ev = cancelledEvent(w, bookingId, { seq: 6 });
    await cancel(ev); await cancel(ev);
    await cancel(cancelledEvent(w, bookingId, { seq: 3 }));
    const refs = await refsOf(w.tenant, bookingId);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ state: 'cancelled', last_seq: 6 });
  });

  it('cancel of a visit that exists but whose booking_refs row is missing -> the visit is found by booking_id and cancelled; booking_refs cancelled is stored', async () => {
    const w = worlds.a; const { visit, bookingId } = await existingVisit(w, 'unassigned', { withRef: false });
    expect((await cancel(cancelledEvent(w, bookingId, { seq: 2 }))).threw).toBeUndefined();
    expect((await visitsOf(w.tenant, bookingId))[0]).toMatchObject({ id: visit.id, status: 'cancelled' });
    expect((await refsOf(w.tenant, bookingId))[0]).toMatchObject({ state: 'cancelled', last_seq: 2 });
  });

  it('TRD §8.2 "visit by home_visit_id or booking_id": home_visit_id of this tenant resolves the visit', async () => {
    const w = worlds.a; const { visit } = await existingVisit(w, 'unassigned');
    const r = await cancel(cancelledEvent(w, uid(), { seq: 2, payload: { home_visit_id: visit.id } }));
    expect(r.threw).toBeUndefined();
    expect((await ownerRows('homecollection.visits', 'tenant_id = $1 AND id = $2', [w.tenant, visit.id]))[0].status).toBe('cancelled');
  });

  it('booking_kind = centre_visit -> ignored: no visit touched, no booking_refs row', async () => {
    const w = worlds.a; const { visit, bookingId } = await existingVisit(w, 'unassigned');
    const other = uid();
    await cancel(cancelledEvent(w, bookingId, { payload: { booking_kind: 'centre_visit', home_visit_id: visit.id } }));
    await cancel(cancelledEvent(w, other, { payload: { booking_kind: 'centre_visit' } }));
    expect((await visitsOf(w.tenant, bookingId))[0].status).toBe('unassigned');
    expect(await refsOf(w.tenant, other)).toHaveLength(0);
  });

  it('tenant isolation: a tenant A cancel carrying tenant B\'s booking_id / home_visit_id never touches B\'s visit, flags or route', async () => {
    const b = worlds.b; const a = worlds.a; const { visit, bookingId } = await existingVisit(b, 'assigned');
    const snap = await everything(b.tenant, visit.id);
    const r = await cancel(cancelledEvent(a, bookingId, { seq: 9, payload: { home_visit_id: visit.id } }));
    expect(r.threw === undefined || r.threw).toBeTruthy();
    expect(await everything(b.tenant, visit.id)).toBe(snap);
    expect((await visitsOf(b.tenant, bookingId))[0].status).toBe('assigned');
    expect(await refsOf(b.tenant, bookingId)).toHaveLength(1);
    expect((await refsOf(b.tenant, bookingId))[0]).toMatchObject({ state: 'confirmed', last_seq: 1 });
  });

  it('tenant isolation: an event whose tenant_id differs from ctx.tenantId changes nothing', async () => {
    const a = worlds.a, b = worlds.b; const { visit, bookingId } = await existingVisit(b, 'unassigned');
    const snap = await everything(b.tenant, visit.id);
    const r = await cancel(cancelledEvent(b, bookingId, { seq: 2 }), { ctxTenant: a.tenant });
    expect(r.threw === undefined || r.threw).toBeTruthy();
    expect(await everything(b.tenant, visit.id)).toBe(snap);
    expect(await refsOf(a.tenant, bookingId)).toHaveLength(0);
  });

  it('unknown fields: extra payload fields are ignored (never stored in status_reason_text or logged)', async () => {
    const w = worlds.a; const { visit, bookingId } = await existingVisit(w, 'unassigned');
    const r = await cancel(cancelledEvent(w, bookingId, { payload: { free_text_reason: PHI_NAME, patient_name: PHI_NAME } }));
    expect(r.threw).toBeUndefined();
    expect(await everything(w.tenant, visit.id)).not.toContain(PHI_NAME);
    expect(r.logs.join('\n')).not.toContain(PHI_NAME);
  });

  it('concurrency: confirmed and cancelled for the same booking racing (cancelled seq 5 > confirmed seq 3) end with NO live visit for the booking, or a cancelled one; booking_refs is a single cancelled row', async () => {
    const w = worlds.a; const bookingId = uid();
    const res = await Promise.all([confirm(confirmedEvent(w, { seq: 3, bookingId })), cancel(cancelledEvent(w, bookingId, { seq: 5 })), confirm(confirmedEvent(w, { seq: 3, bookingId }))]);
    for (const r of res) if (r.threw) expect(['23505', '40001', '40P01']).toContain(r.threw.code);
    const vs = await visitsOf(w.tenant, bookingId);
    expect(vs.length).toBeLessThanOrEqual(1);
    for (const v of vs) expect(v.status).toBe('cancelled');
    // a lost race may leave the cancel to be retried by the queue: replay it, then the end state is fixed
    await cancel(cancelledEvent(w, bookingId, { seq: 5 }));
    const refs = await refsOf(w.tenant, bookingId);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ state: 'cancelled', last_seq: 5 });
    for (const v of await visitsOf(w.tenant, bookingId)) expect(v.status).toBe('cancelled');
  });
});
