// HC-T16 task homecollection.flag_overdue_handovers (every 30 min, per_tenant; 02-TRD §10, 01-PRD US-12-4, 05-SCHEMA settings.handover_overdue_hours default 4).
// "applied collections without a handover item older than handover_overdue_hours -> flag handover_overdue (unique open flag per visit)".
// Live PG17 (tests/homecollection/HC-T16.pg.sh). FAKE CLOCK = ctx.now(); collections carry absolute collected_at relative to it. Missing env = HARD FAILURE.
// ASSUMED (spec silent; the implementer disputes if wrong):
//  - file tasks/flag_overdue_handovers.ts exports `flagOverdueHandovers` (TaskHandler, payload {tenant_id}); payload.tenant_id != ctx.tenantId -> resolves, writes nothing.
//  - the tenant's handover_overdue_hours is read from homecollection.settings (this suite leaves the shared settings row at its default 4 and creates it if missing; no row = default 4).
//  - overdue <=> collections.status = 'applied' AND collected_at < now - hours AND no handover_items row for the collection (any handover status). Exactly `hours` old is NOT yet overdue.
//  - flag: kind handover_overdue, status open, centre_id = the visit's centre, created_by = ctx.actor.id; ONE open flag per visit (several tubes still make one). The visit status does not matter.
//  - a re-run adds nothing; a RESOLVED earlier flag does not block a new open one; the visits/collections/handovers tables are not modified.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SYS_ACTOR, TENANT_A, TENANT_B, closePools, runTask, uid } from './hc16.helpers.js';
import { HC_CENTRE, MEMBER, collectedVisit, extraCollection, flagsOf, handOver, hc, ownerRows, seed, visitOf } from './hc16.fixtures.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const NOW = '2026-11-13T12:00:00.000Z';
const ago = (h: number, min = 0) => new Date(Date.parse(NOW) - (h * 60 + min) * 60_000).toISOString();
let flagOverdueHandovers: (payload: any, ctx: any) => Promise<void>;
beforeAll(async () => {
  await seed('homecollection.settings', hc.settings('a')); await seed('homecollection.settings', hc.settings('b'));   // no-op when the row exists (defaults: 4 h)
  flagOverdueHandovers = (await import('../tasks/flag_overdue_handovers.js')).flagOverdueHandovers;
});
afterAll(async () => { await closePools(); });
const run = (tenant: string = TENANT_A, payload: unknown = { tenant_id: tenant }) => runTask(flagOverdueHandovers, payload, tenant, { now: NOW });
const overdue = (id: string) => flagsOf(id, 'handover_overdue');

describe('US-12-4: applied collections not handed over after handover_overdue_hours (default 4) -> flag handover_overdue', () => {
  it('collected 4 h 01 min ago and not handed over: one open flag (kind, visit centre, system actor)', async () => {
    const c = await collectedVisit('a', ago(4, 1));
    const r = await run();
    expect(r.threw).toBeUndefined();
    const f = await overdue(c.visit.id);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'handover_overdue', status: 'open', centre_id: HC_CENTRE.a, tenant_id: TENANT_A, created_by: SYS_ACTOR, visit_id: c.visit.id });
    expect(f[0].resolved_at).toBeNull();
  });
  it('boundary: 3 h 59 min ago and exactly 4 h 00 min ago are NOT overdue yet (strictly older than the limit)', async () => {
    const young = await collectedVisit('a', ago(3, 59)); const edge = await collectedVisit('a', ago(4, 0));
    expect((await run()).threw).toBeUndefined();
    expect(await overdue(young.visit.id)).toEqual([]);
    expect(await overdue(edge.visit.id)).toEqual([]);
  });
  it('a tube that has a handover item is not overdue, whatever the handover status (pending / confirmed / discrepancy)', async () => {
    const cs = [await collectedVisit('a', ago(9)), await collectedVisit('a', ago(9)), await collectedVisit('a', ago(9))];
    for (const [i, st] of (['pending', 'confirmed', 'discrepancy'] as const).entries()) await handOver('a', cs[i]!, st);
    expect((await run()).threw).toBeUndefined();
    for (const c of cs) expect(await overdue(c.visit.id)).toEqual([]);
  });
  it('only APPLIED collections count: held / rejected / superseded-style statuses opened nothing', async () => {
    const held = await collectedVisit('a', ago(9), { status: 'held' });
    expect((await run()).threw).toBeUndefined();
    expect(await overdue(held.visit.id)).toEqual([]);
  });
  it('mixed visit: tube 1 handed over, tube 2 not -> the visit is flagged (one flag per visit even with two overdue tubes)', async () => {
    const c = await collectedVisit('a', ago(10)); const e = await extraCollection('a', c, ago(8));
    await handOver('a', c);
    expect((await run()).threw).toBeUndefined();
    expect(await overdue(c.visit.id)).toHaveLength(1);
    const two = await collectedVisit('a', ago(10)); await extraCollection('a', two, ago(9));
    expect((await run()).threw).toBeUndefined();
    expect(await overdue(two.visit.id)).toHaveLength(1);
    expect(e.col.id).toBeTruthy();
  });
  it('the visit state does not matter: a `failed` (partial) visit with an applied tube is flagged like a completed one', async () => {
    const a = await collectedVisit('a', ago(6), { visit: { status: 'failed', outcome: 'partial', completed_at: null, failed_at: ago(6) } });
    expect((await run()).threw).toBeUndefined();
    expect(await overdue(a.visit.id)).toHaveLength(1);
  });
  it('idempotent (runs every 30 min): re-running adds no flag and does not touch the existing one', async () => {
    const c = await collectedVisit('a', ago(5));
    expect((await run()).threw).toBeUndefined();
    const first = await overdue(c.visit.id);
    for (let i = 0; i < 3; i++) expect((await run()).threw).toBeUndefined();
    const after = await overdue(c.visit.id);
    expect(after.map((f: any) => [f.id, Number(f.version), f.status])).toEqual(first.map((f: any) => [f.id, Number(f.version), f.status]));
  });
  it('a RESOLVED earlier handover_overdue flag does not block a new open one (the unique index covers open flags only)', async () => {
    const c = await collectedVisit('a', ago(5));
    await seed('homecollection.visit_flags', hc.flag('a', c.visit.id, { kind: 'handover_overdue', related_id: null, status: 'resolved', resolved_at: ago(1), resolved_by: MEMBER.a, resolution_code: 'other' }));
    expect((await run()).threw).toBeUndefined();
    expect((await overdue(c.visit.id)).map((f: any) => f.status).sort()).toEqual(['open', 'resolved']);
  });
  it('an OPEN flag of the same kind (e.g. raised earlier by the cron) is kept: no duplicate, no error', async () => {
    const c = await collectedVisit('a', ago(5)); const pre = hc.flag('a', c.visit.id, { kind: 'handover_overdue', related_id: null }); await seed('homecollection.visit_flags', pre);
    const r = await run();
    expect(r.threw).toBeUndefined();
    expect((await overdue(c.visit.id)).map((f: any) => f.id)).toEqual([pre.id]);
  });
  it('the task only inserts flags: the visit, collection and handover rows keep their versions', async () => {
    const c = await collectedVisit('a', ago(5));
    expect((await run()).threw).toBeUndefined();
    expect(Number((await visitOf(c.visit.id)).version)).toBe(1);
    expect(Number((await ownerRows('homecollection.collections', 'id = $1', [c.col.id]))[0].version)).toBe(1);
  });
});

describe('guards: tenant, payload, no port', () => {
  it('tenant isolation: the run for tenant A flags nothing in tenant B (and B\'s own run does)', async () => {
    const b = await collectedVisit('b', ago(7)); const a = await collectedVisit('a', ago(7));
    expect((await run(TENANT_A)).threw).toBeUndefined();
    expect(await overdue(a.visit.id)).toHaveLength(1);
    expect(await overdue(b.visit.id)).toEqual([]);
    expect((await run(TENANT_B)).threw).toBeUndefined();
    expect(await overdue(b.visit.id)).toHaveLength(1);
  });
  it('payload.tenant_id different from ctx.tenantId, a malformed payload, an unknown tenant: resolves, writes nothing', async () => {
    const c = await collectedVisit('a', ago(7));
    for (const p of [{ tenant_id: TENANT_B }, {}, null, 'x', { tenant_id: 'not-a-uuid' }, { tenant_id: uid() }]) expect((await run(TENANT_A, p)).threw, JSON.stringify(p)).toBeUndefined();
    expect(await overdue(c.visit.id)).toEqual([]);
  });
  it('uses no port other than identity.getTenantSettings (every other port is a trap in this harness) and logs no barcode', async () => {
    const c = await collectedVisit('a', ago(7));
    const r = await run();
    expect(r.threw).toBeUndefined();
    expect(r.logs.join('\n')).not.toContain(c.specimen.barcode);
  });
});
