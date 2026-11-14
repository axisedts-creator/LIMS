// C13 T23 — Observability. Part 3/4: lims_partners_pickups_total{transition} on the pickup operations K1, K4, SP2, SP3, SP4 (T15 world: pickup.world.ts, partnerContext mocked as in pickups.test.ts).
// Spec: 02-TRD §13 (`lims_partners_pickups_total` label `transition`), 03-APP-FLOW §2.3 pickup states, 07-SECURITY (no ids / PHI in labels).
// SEAM (same as report.service.ts): ctx.metrics.inc(name, labels?, by?). SEAM vocabulary: transition = the pickup state reached (requested | scheduled | picked_up | cancelled | rejected), one emission per
// successful operation (a reschedule scheduled -> scheduled counts as `scheduled`), none for a refused one. LD-140 does not apply (backend).
import { describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { manifest } from '../index.js';
import { DAY, HOUR, iso, makeCtx, makeWorld, MF, NOW_MS, PK, type Who, type World } from './pickup.world.js';

vi.mock('../service/partner-context.service.js', () => ({
  partnerContext: { require: (c: any) => c.__require(c), load: (c: any) => c.__require(c) },
}));

const PICKUPS = 'lims_partners_pickups_total';
type Rec = { name: string; labels: Record<string, unknown>; by: number };
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
async function call(w: World, op: string, who: Who, r: { params?: object; headers?: object; body?: unknown }) {
  const { ctx, finish } = makeCtx(w, who);
  const incs: Rec[] = []; ctx.metrics = { inc: (name: string, labels: Record<string, unknown> = {}, by = 1) => { incs.push({ name, labels, by }); }, set() {}, observe() {} };
  try {
    const res = (await manifest.handlers[op]!({ params: {}, query: {}, headers: {}, body: undefined, ...r } as any, ctx)) as { status: number; body: any };
    finish(true); return { res, incs };
  } catch (e) { finish(false); return { err: e as LimsError, incs }; }
}
const transitions = (incs: Rec[]) => incs.filter((x) => x.name === PICKUPS).map((x) => x.labels);
const pk = (pid: string, o: { headers?: object; body?: unknown } = {}) => ({ params: { pickup_request_id: pid }, ...o });
const SCHED = { scheduled_start: iso(NOW_MS + DAY), scheduled_end: iso(NOW_MS + DAY + 2 * HOUR), assignee_text: 'Synthetic Rider Two' };

describe('T23 pickups_total{transition}', () => {
  it('K1 createPickupRequest -> requested', async () => {
    const w = makeWorld();
    const { res, incs } = await call(w, 'createPickupRequest', 'adminX', { body: { manifest_ids: [MF.m1], window_start: iso(NOW_MS + HOUR), window_end: iso(NOW_MS + 5 * HOUR), packages_count: 2 } });
    expect(res?.status).toBe(201);
    expect(transitions(incs)).toEqual([{ transition: 'requested' }]);
  });

  it('SP2 schedulePickup -> scheduled; a reschedule (scheduled -> scheduled) is one more `scheduled`', async () => {
    const w = makeWorld();
    const a = await call(w, 'schedulePickup', 'staff', pk(PK.req, { headers: ifm(1), body: SCHED })); expect(a.res?.status).toBe(200);
    expect(transitions(a.incs)).toEqual([{ transition: 'scheduled' }]);
    const b = await call(w, 'schedulePickup', 'staff', pk(PK.sch, { headers: ifm(2), body: SCHED })); expect(b.res?.status).toBe(200);
    expect(transitions(b.incs)).toEqual([{ transition: 'scheduled' }]);
  });

  it('SP3 markPickupCollected -> picked_up', async () => {
    const w = makeWorld();
    const { res, incs } = await call(w, 'markPickupCollected', 'staff', pk(PK.sch, { headers: ifm(2) })); expect(res?.status).toBe(200);
    expect(transitions(incs)).toEqual([{ transition: 'picked_up' }]);
  });

  it('SP4 rejectPickup -> rejected', async () => {
    const w = makeWorld();
    const { res, incs } = await call(w, 'rejectPickup', 'staff', pk(PK.req, { headers: ifm(1), body: { reason_code: 'no_rider_available' } })); expect(res?.status).toBe(200);
    expect(transitions(incs)).toEqual([{ transition: 'rejected' }]);
  });

  it('K4 cancelPickupRequest -> cancelled', async () => {
    const w = makeWorld();
    const { res, incs } = await call(w, 'cancelPickupRequest', 'adminX', pk(PK.req, { headers: ifm(1), body: { reason_code: 'no_longer_needed' } })); expect(res?.status).toBe(200);
    expect(transitions(incs)).toEqual([{ transition: 'cancelled' }]);
  });

  it('refused operations emit nothing: stale If-Match (409), already-closed pickup (409), another partner\'s pickup (404), forbidden role (403)', async () => {
    const w = makeWorld();
    const stale = await call(w, 'cancelPickupRequest', 'adminX', pk(PK.req, { headers: ifm(9), body: { reason_code: 'no_longer_needed' } })); expect(stale.err?.code).toBe('common.version_conflict');
    const other = await call(w, 'cancelPickupRequest', 'adminY', pk(PK.req, { headers: ifm(1), body: { reason_code: 'no_longer_needed' } })); expect(other.err?.code).toBe('common.not_found');
    const forbidden = await call(w, 'schedulePickup', 'staffNoManage', pk(PK.req, { headers: ifm(1), body: SCHED })); expect(forbidden.err?.code).toBe('auth.forbidden');
    const done = await call(w, 'cancelPickupRequest', 'adminX', pk(PK.req, { headers: ifm(1), body: { reason_code: 'no_longer_needed' } })); expect(done.res?.status).toBe(200);
    const again = await call(w, 'cancelPickupRequest', 'adminX', pk(PK.req, { headers: ifm(2), body: { reason_code: 'no_longer_needed' } })); expect(again.err).toBeInstanceOf(LimsError);
    for (const r of [stale, other, forbidden, again]) expect(transitions(r.incs)).toEqual([]);
  });

  it('labels: only `transition`, only a pickup state, no ids / names / contact data', async () => {
    const w = makeWorld();
    const { incs } = await call(w, 'createPickupRequest', 'adminX', { body: { manifest_ids: [MF.m1], window_start: iso(NOW_MS + HOUR), window_end: iso(NOW_MS + 5 * HOUR), packages_count: 2, contact_name: 'Synthetic Contact', contact_phone_e164: '+15555550123', notes: 'Gate 3' } });
    expect(transitions(incs).length).toBeGreaterThan(0);
    for (const l of transitions(incs)) { expect(Object.keys(l)).toEqual(['transition']); expect(['requested', 'scheduled', 'picked_up', 'cancelled', 'rejected']).toContain(l['transition']); }
    expect(JSON.stringify(incs)).not.toMatch(/Synthetic|\+1555|Gate 3|01940e00/);
  });
});
