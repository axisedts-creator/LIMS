// HC-T14 worker task homecollection.flag_handover_discrepancy {tenant_id, handover_id} (02-TRD §10 task row: "system actor: for each handover_items row with outcome = 'missing', insert flag handover_discrepancy
// (related_id = handover id) on its visit, ON CONFLICT DO NOTHING (open-flag unique index); route version++"), 03-APP-FLOW §1.3 + §5.7, 01-PRD US-12-2, 07-SECURITY REQ-SEC-017, 08 A19 D-125.
// Live PG17 (tests/homecollection/HC-T14.pg.sh exports LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL; missing env = HARD FAILURE, never a skip). Same harness as HC-T06: hand-built JobContext, ctx.tx = pg client in a
// transaction as lims_api under RLS with the SYSTEM actor's claims (the only actor that may write visit_flags for every centre, D-125); fixtures written as superuser; assertions read as superuser.
// ASSUMED (spec silent; the implementer disputes if wrong):
//  - file tasks/flag_handover_discrepancy.ts exports `flagHandoverDiscrepancy` (TaskHandler = (payload {tenant_id, handover_id}, ctx)); payload.tenant_id must equal ctx.tenantId, else a no-op (as refresh_visit_specimens).
//  - a payload that is not {uuid, uuid}, an unknown handover id, a handover of another tenant (hidden by RLS), a handover with no `missing` item: the task RESOLVES and writes nothing (no retry storm).
//  - flag columns: kind handover_discrepancy, status open, related_id = handover id, centre_id = the VISIT's centre_id, created_by = ctx.actor.id; detail_code is not pinned.
//  - route version: every route whose visit got a NEW flag is bumped at least once; a re-run that inserts nothing bumps nothing. Visits (the table) are not modified.
//  - the task calls no port (ctx.ports is a trap here).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HC_CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, appTx, closePools, hc, ownerRows, seed, uid } from '../../../../../api/src/modules/homecollection/repository/__tests__/helpers.js';
import { flagsOfVisit, handoverWorld, routeVersion, visitVersion, type HoWorld } from '../../../../../api/src/modules/homecollection/__tests__/handovers/world.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const KIND = 'handover_discrepancy';
let flagHandoverDiscrepancy: (payload: any, ctx: any) => Promise<void>;

let spN = 0;
function makeCtx(tx: any, tenant: string, logs: string[]) {
  const sink = (x: unknown, m?: unknown) => logs.push(JSON.stringify([x, m]));
  const log: any = { info: sink, warn: sink, error: sink, debug: sink, child: () => log };
  const ctx: any = {
    tenantId: tenant, tx, actor: { type: 'system', id: SYS_ACTOR }, requestId: uid(), attempt: 1, maxAttempts: 10, jobId: '1',
    now: () => new Date().toISOString(), events: {}, core: {}, audit: { access: async () => undefined }, storage: {}, files: {}, log, metrics: { inc() {}, set() {}, observe() {} },
    ports: new Proxy({}, { get(_t, p) { throw new Error(`the task must not use ports.${String(p)}`); } }),
  };
  ctx.db = {
    tx: async (fn: (c: any) => Promise<any>) => {
      const sp = `hc_t14_sp_${++spN}`;
      await tx.query(`SAVEPOINT ${sp}`);
      try { const r = await fn(ctx); await tx.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
    },
  };
  return ctx;
}
/** one delivery = one transaction (as the queue does); returns the thrown error instead of throwing */
async function run(payload: unknown, tenant: string = TENANT_A) {
  const logs: string[] = []; let threw: any;
  try { await appTx(tenant, async (tx) => { await flagHandoverDiscrepancy(payload, makeCtx(tx, tenant, logs)); }); } catch (e) { threw = e; }
  return { logs, threw };
}
const go = (w: HoWorld, o: { tenant?: string; payloadTenant?: string } = {}) => run({ tenant_id: o.payloadTenant ?? w.tenant, handover_id: w.handover.id }, o.tenant ?? w.tenant);
const flags = async (w: HoWorld, i: number) => flagsOfVisit(w.items[i]!.visitId, KIND);
const allFlags = async (w: HoWorld) => (await Promise.all(w.items.map((_, i) => flags(w, i)))).flat();

beforeAll(async () => {
  await superTxRegistry();
  flagHandoverDiscrepancy = (await import('../tasks/flag_handover_discrepancy.js')).flagHandoverDiscrepancy;
});
afterAll(async () => { await closePools(); });
async function superTxRegistry() {
  const { ensureDiscrepancyTask } = await import('../../../../../api/src/modules/homecollection/__tests__/handovers/world.js');
  await ensureDiscrepancyTask();
}

describe('US-12-2 / D-125: the worker (system actor) opens flag handover_discrepancy for each missing tube', () => {
  it('2 of 4 tubes missing: one OPEN flag per missing tube\'s visit (kind, related_id = handover id, the visit\'s centre, system actor); none on the visits of received tubes', async () => {
    const w = await handoverWorld({ n: 4, status: 'discrepancy', outcomes: ['received', 'missing', 'missing', 'received'] });
    const r = await go(w);
    expect(r.threw).toBeUndefined();
    for (const i of [1, 2]) {
      const f = await flags(w, i);
      expect(f, `visit of item ${i}`).toHaveLength(1);
      expect(f[0]).toMatchObject({ kind: KIND, status: 'open', related_id: w.handover.id, visit_id: w.items[i]!.visitId, centre_id: HC_CENTRE.a, tenant_id: w.tenant, created_by: SYS_ACTOR });
      expect(f[0].resolved_at).toBeNull();
    }
    for (const i of [0, 3]) expect(await flags(w, i), `visit of item ${i}`).toEqual([]);
    // the task only inserts flags (+ route version): the handover and its items are not touched
    const h = (await ownerRows('homecollection.handovers', 'id = $1', [w.handover.id]))[0];
    expect([h.status, Number(h.version)]).toEqual(['discrepancy', 1]);
    expect((await ownerRows('homecollection.handover_items', 'handover_id = $1 ORDER BY created_at, id', [w.handover.id])).map((x: any) => Number(x.version))).toEqual([1, 1, 1, 1]);
    for (const it of w.items) expect(await visitVersion(it.visitId)).toBe(1);
  });
  it('idempotent: the same job run again (retry / duplicate delivery) adds nothing and leaves the open flags as they were (ON CONFLICT DO NOTHING on the open-flag unique index)', async () => {
    const w = await handoverWorld({ n: 3, status: 'discrepancy', outcomes: ['missing', 'received', 'missing'] });
    expect((await go(w)).threw).toBeUndefined();
    const before = await allFlags(w);
    const rv = await routeVersion(w.route.id);
    expect((await go(w)).threw).toBeUndefined();
    expect((await go(w)).threw).toBeUndefined();
    const after = await allFlags(w);
    expect(after.map((f: any) => [f.id, Number(f.version), f.status])).toEqual(before.map((f: any) => [f.id, Number(f.version), f.status]));
    expect(after).toHaveLength(2);
    expect(await routeVersion(w.route.id)).toBe(rv);                              // nothing new -> no bump
  });
  it('an open flag that already exists for (visit, kind, handover) is kept: no duplicate row, no error, no second route bump', async () => {
    const w = await handoverWorld({ n: 2, status: 'discrepancy', outcomes: ['missing', 'received'] });
    const pre = hc.flag('a', w.items[0]!.visitId, { kind: KIND, related_id: w.handover.id }); await seed('homecollection.visit_flags', pre);
    const r = await go(w);
    expect(r.threw).toBeUndefined();
    const f = await flags(w, 0);
    expect(f.map((x: any) => x.id)).toEqual([pre.id]);
    expect(Number(f[0].version)).toBe(1);
  });
  it('a RESOLVED earlier flag of the same handover does not block a new open one (the unique index covers open flags only)', async () => {
    const w = await handoverWorld({ n: 1, status: 'discrepancy', outcomes: ['missing'] });
    const old = hc.flag('a', w.items[0]!.visitId, { kind: KIND, related_id: w.handover.id, status: 'resolved', resolved_at: '2026-11-12T00:00:00Z', resolved_by: SYS_ACTOR, resolution_code: 'other' });
    await seed('homecollection.visit_flags', old);
    expect((await go(w)).threw).toBeUndefined();
    const f = await flags(w, 0);
    expect(f.map((x: any) => x.status).sort()).toEqual(['open', 'resolved']);
  });
  it('route version++: a visit on a route gets its route bumped (the phone sees the new flag on its next pull); several visits of one route bump it at least once', async () => {
    const w = await handoverWorld({ n: 3, status: 'discrepancy', outcomes: ['missing', 'missing', 'received'] });
    const before = await routeVersion(w.route.id);
    expect((await go(w)).threw).toBeUndefined();
    expect(await routeVersion(w.route.id)).toBeGreaterThanOrEqual(before + 1);
  });
  it('collected visits that are already completed (no route) get the flag too: the receiver\'s discrepancy must not depend on the visit state', async () => {
    const w = await handoverWorld({ n: 2, visitStatus: 'completed', status: 'discrepancy', outcomes: ['received', 'missing'] });
    expect((await go(w)).threw).toBeUndefined();
    expect(await flags(w, 1)).toHaveLength(1);
    expect(await flags(w, 0)).toEqual([]);
  });
  it('a handover where every tube was received (or none is decided yet) opens nothing', async () => {
    const ok = await handoverWorld({ n: 2, status: 'confirmed' });
    expect((await go(ok)).threw).toBeUndefined();
    expect(await allFlags(ok)).toEqual([]);
    const pending = await handoverWorld({ n: 2 });
    expect((await go(pending)).threw).toBeUndefined();
    expect(await allFlags(pending)).toEqual([]);
  });
});

describe('guards: tenant, payload, unknown ids, no port, no PHI in logs', () => {
  it('payload.tenant_id different from ctx.tenantId -> no-op (nothing written), whichever side the handover belongs to', async () => {
    const w = await handoverWorld({ n: 2, status: 'discrepancy', outcomes: ['missing', 'missing'] });
    expect((await go(w, { payloadTenant: TENANT_B })).threw).toBeUndefined();
    expect(await allFlags(w)).toEqual([]);
    const b = await handoverWorld({ s: 'b', n: 1, status: 'discrepancy', outcomes: ['missing'] });
    expect((await run({ tenant_id: TENANT_B, handover_id: b.handover.id }, TENANT_A)).threw).toBeUndefined();
    expect(await allFlags(b)).toEqual([]);
  });
  it('tenant isolation: a job of tenant A naming a handover of tenant B (payload tenant = ctx tenant = A) writes nothing in B', async () => {
    const b = await handoverWorld({ s: 'b', n: 2, status: 'discrepancy', outcomes: ['missing', 'missing'] });
    const r = await run({ tenant_id: TENANT_A, handover_id: b.handover.id }, TENANT_A);
    expect(r.threw).toBeUndefined();
    expect(await allFlags(b)).toEqual([]);
    expect(await routeVersion(b.route.id)).toBe(1);
  });
  it('a malformed payload, an unknown handover id, an empty object -> resolves, writes nothing', async () => {
    const w = await handoverWorld({ n: 1, status: 'discrepancy', outcomes: ['missing'] });
    for (const p of [{}, { tenant_id: w.tenant }, { tenant_id: w.tenant, handover_id: 'not-a-uuid' }, { tenant_id: w.tenant, handover_id: uid() }, { tenant_id: w.tenant, handover_id: w.handover.id.toUpperCase().slice(0, 30) }, null, 'x'])
      expect((await run(p)).threw, JSON.stringify(p)).toBeUndefined();
    expect(await allFlags(w)).toEqual([]);
  });
  it('the task uses no port (ports is a trap in this harness) and logs no barcode', async () => {
    const w = await handoverWorld({ n: 2, status: 'discrepancy', outcomes: ['missing', 'missing'] });
    const r = await go(w);
    expect(r.threw).toBeUndefined();
    for (const it of w.items) expect(r.logs.join('\n')).not.toContain(it.barcode);
    expect(await allFlags(w)).toHaveLength(2);
  });
  it('RLS holds for the system actor too: with tenant A claims a flag cannot be written for a tenant-B visit (WITH CHECK), and the run leaves tenant B untouched', async () => {
    const b = await handoverWorld({ s: 'b', n: 1, status: 'discrepancy', outcomes: ['missing'] });
    const r = await run({ tenant_id: TENANT_A, handover_id: b.handover.id }, TENANT_A);
    expect(r.threw).toBeUndefined();
    expect(await flagsOfVisit(b.items[0]!.visitId)).toEqual([]);
  });
});
