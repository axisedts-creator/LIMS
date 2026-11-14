// HC-T16 task homecollection.purge_locations (daily 02:40 Asia/Kathmandu, per_tenant; 02-TRD §10, 05-SCHEMA §4.1 (3) + §6, 08 A17 P-18(c), REQ-SEC-139).
// "system actor: DELETE FROM homecollection.visit_locations WHERE tenant_id = $t AND expires_at < now() under visit_locations__delete__tenant_centre (not a DEFINER). expires_at is set at insert; this is the only purge predicate."
// Live PG17 (tests/homecollection/HC-T16.pg.sh). The job runs as lims_worker under the SYSTEM actor's claims; the delete is therefore decided by the RLS delete policy, not by app code. Missing env = HARD FAILURE.
// ASSUMED (spec silent; the implementer disputes if wrong):
//  - file tasks/purge_locations.ts exports `purgeLocations` (TaskHandler, payload {tenant_id}); payload.tenant_id != ctx.tenantId -> resolves, deletes nothing.
//  - "now()" is the DATABASE clock: a fake ctx.now() far in the future (2099) must NOT make live rows disappear.
//  - the task returns normally with 0 rows to delete (no error), and deletes in every centre of the tenant (the system actor has all-centre scope).
//  - the task logs no coordinates.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TENANT_A, TENANT_B, closePools, runTask, uid, workerTx } from './hc16.helpers.js';
import { HC_CENTRE, collectedVisit, hc, ownerRows, seed } from './hc16.fixtures.js';
import { OTHER_CENTRE } from '../../../../../api/src/modules/homecollection/repository/__tests__/helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let purgeLocations: (payload: any, ctx: any) => Promise<void>;
beforeAll(async () => { purgeLocations = (await import('../tasks/purge_locations.js')).purgeLocations; });
afterAll(async () => { await closePools(); });

const REAL_NOW = () => Date.now();
const iso = (offsetMs: number) => new Date(REAL_NOW() + offsetMs).toISOString();
const DAY = 86_400_000, MIN = 60_000;
const run = (tenant: string = TENANT_A, payload: unknown = { tenant_id: tenant }, now = '2026-11-13T21:10:00.000Z') => runTask(purgeLocations, payload, tenant, { now });
const exists = async (id: string) => (await ownerRows('homecollection.visit_locations', 'id = $1', [id])).length === 1;
async function loc(s: 'a' | 'b', c: Awaited<ReturnType<typeof collectedVisit>>, expiresInMs: number, o: Record<string, unknown> = {}) {
  const row = hc.location(s, c.visit.id, c.mut.id, { captured_at: iso(expiresInMs - 100 * DAY), expires_at: iso(expiresInMs), ...o });
  await seed('homecollection.visit_locations', row);
  return row;
}

describe('US-12/§6 GPS retention: expired points are deleted by the system actor, nothing else', () => {
  it('deletes rows with expires_at < now() of the tenant; keeps rows that expire later (also 2 minutes ahead); the fake clock is ignored', async () => {
    const c = await collectedVisit('a', iso(-DAY));
    const old = await loc('a', c, -10 * DAY); const justPast = await loc('a', c, -2 * MIN, { kind: 'collected' }); const justAhead = await loc('a', c, 2 * MIN, { kind: 'failed' }); const live = await loc('a', c, 30 * DAY);
    const r = await run(TENANT_A, { tenant_id: TENANT_A }, '2099-01-01T00:00:00.000Z');
    expect(r.threw).toBeUndefined();
    expect(await exists(old.id)).toBe(false);
    expect(await exists(justPast.id)).toBe(false);
    expect(await exists(justAhead.id)).toBe(true);
    expect(await exists(live.id)).toBe(true);
  });
  it('every centre of the tenant is purged, not only the home-collection centre (system actor has all-centre scope)', async () => {
    const c = await collectedVisit('a', iso(-DAY));
    const a = await loc('a', c, -5 * DAY); const b = await loc('a', c, -5 * DAY, { centre_id: OTHER_CENTRE.a, kind: 'collected' });
    expect(a.centre_id).toBe(HC_CENTRE.a);
    expect((await run()).threw).toBeUndefined();
    expect(await exists(a.id)).toBe(false);
    expect(await exists(b.id)).toBe(false);
  });
  it('tenant isolation: the run for tenant A never deletes tenant B\'s expired rows (and B\'s own run does)', async () => {
    const ca = await collectedVisit('a', iso(-DAY)); const cb = await collectedVisit('b', iso(-DAY));
    const a = await loc('a', ca, -5 * DAY); const b = await loc('b', cb, -5 * DAY);
    expect((await run(TENANT_A)).threw).toBeUndefined();
    expect(await exists(a.id)).toBe(false);
    expect(await exists(b.id)).toBe(true);
    expect((await run(TENANT_B)).threw).toBeUndefined();
    expect(await exists(b.id)).toBe(false);
  });
  it('idempotent, and nothing to purge is not an error', async () => {
    const c = await collectedVisit('a', iso(-DAY)); const keep = await loc('a', c, 40 * DAY);
    for (let i = 0; i < 3; i++) expect((await run()).threw).toBeUndefined();
    expect(await exists(keep.id)).toBe(true);
  });
  it('only visit_locations rows go: the visit, its mutation, collection and the other tenant\'s tables are untouched', async () => {
    const c = await collectedVisit('a', iso(-DAY)); await loc('a', c, -5 * DAY);
    expect((await run()).threw).toBeUndefined();
    expect((await ownerRows('homecollection.visits', 'id = $1', [c.visit.id])).length).toBe(1);
    expect((await ownerRows('homecollection.mutations', 'id = $1', [c.mut.id])).length).toBe(1);
    expect((await ownerRows('homecollection.collections', 'id = $1', [c.col.id])).length).toBe(1);
  });
  it('the delete is decided by RLS (P-18(c)), not by app code: the same statement from a USER actor of the tenant deletes 0 rows', async () => {
    const c = await collectedVisit('a', iso(-DAY)); const old = await loc('a', c, -5 * DAY);
    const n = await workerTx(TENANT_A, async (tx: any) => (await tx.query('DELETE FROM homecollection.visit_locations WHERE tenant_id = $1 AND expires_at < now()', [TENANT_A])).rowCount, 'user');
    expect(n).toBe(0);
    expect(await exists(old.id)).toBe(true);
    expect((await run()).threw).toBeUndefined();
    expect(await exists(old.id)).toBe(false);
  });
});

describe('guards: tenant, payload, logs', () => {
  it('payload.tenant_id different from ctx.tenantId, malformed payloads: resolves, deletes nothing', async () => {
    const c = await collectedVisit('a', iso(-DAY)); const old = await loc('a', c, -5 * DAY);
    for (const p of [{ tenant_id: TENANT_B }, {}, null, 'x', { tenant_id: 'not-a-uuid' }, { tenant_id: uid() }]) expect((await run(TENANT_A, p)).threw, JSON.stringify(p)).toBeUndefined();
    expect(await exists(old.id)).toBe(true);
  });
  it('logs no coordinates', async () => {
    const c = await collectedVisit('a', iso(-DAY)); await loc('a', c, -5 * DAY, { latitude: 27.123456, longitude: 85.654321 });
    const r = await run();
    expect(r.threw).toBeUndefined();
    expect(r.logs.join('\n')).not.toMatch(/27\.123456|85\.654321/);
  });
});
