// C9 T-25 — S-01 live half (07-SECURITY §5; REQ-SEC-002/040/041): tenant A's credentials name an object id that really exists in tenant B (seeded as the owner) on EVERY operation of quality.yaml
// with an id in the path -> 404 common.not_found under real RLS, and the owner-side snapshot of ALL 24 tenant tables of B is byte-identical afterwards ("no side effect in B").
// The DB-less half is crossTenant.probes.test.ts. Needs LIMS_TEST_DATABASE_URL (lims_api) + LIMS_TEST_ADMIN_DATABASE_URL (superuser); skips without them (LIMS_T25_REQUIRE_DB=1 is enforced in tables.live).
// The handlers are the REAL manifest handlers, the IdentityPort is the real one (kit makeHarness); only ctx.tx is swapped for a client of the lims_api pool with tenant A's claims, so RLS decides.
// Commit mode: the probe tx COMMITS, so a write that slipped through would persist and show in the snapshot. A write of B's row is refused by RLS, a write in A is caught by the "no write SQL" tx spy.
// Fails now (with a database): the quality DDL is not applied (C0 prerequisite) -> the seed insert names the missing table.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OPS, TENANT_A, TENANT_B, TENANT_TABLES, claimsOf, closePools, fire, live, loadManifest, makeHarness, requestFor, seedRow, seen, snapshot, uid, withClaims, api, T, type OpInfo } from './kit.js';

const ALL = ['quality.autoverify.manage', 'quality.autoverify.read', 'quality.config.manage', 'quality.qc.manage', 'quality.qc_run.read', 'quality.qc_run.review', 'quality.tat_alert.ack', 'quality.tat_alert.read'];
/** path parameter -> the tenant table whose row it names (05-SCHEMA §1). set_name / code are coded-set keys, not row ids. */
const TABLE_OF: Record<string, string> = { material_id: 'quality.control_materials', level_id: 'quality.control_levels', lot_id: 'quality.control_lots', map_id: 'quality.control_id_maps', plan_id: 'quality.qc_plans',
  target_id: 'quality.qc_targets', observation_id: 'quality.qc_observations', qc_run_id: 'quality.qc_runs', version_id: 'quality.autoverify_versions', decision_id: 'quality.autoverify_decisions',
  tat_item_id: 'quality.tat_items' };
const idParams = (o: OpInfo) => o.pathParams.filter((p) => p !== 'set_name' && p !== 'code');
const BY_ID = OPS.filter((o) => idParams(o).length > 0);
const WRITE_SQL = /^\s*(insert|update|delete|merge|truncate)\b/i;
/** createQcPlanVersion / excludeQcObservation resolve body refs before the path object (400 allowed, same as the DB-less half). */
const BODY_REFS_FIRST = new Set(['createQcPlanVersion', 'excludeQcObservation']);

afterAll(async () => { await closePools(); });
describe('S-01 registry (live)', () => {
  it('every id path parameter of quality.yaml maps to a tenant table (a new parameter must be added to TABLE_OF)', () => {
    for (const p of new Set(BY_ID.flatMap(idParams))) expect(TABLE_OF[p], `no table for {${p}}`).toBeTruthy();
  });
});

describe.skipIf(!live)('S-01 live: B\'s real object ids under A\'s claims -> 404, and tenant B is byte-identical afterwards', () => {
  const B_ID: Record<string, string> = {};   // path param -> id of a row that exists in tenant B
  let handlers: Record<string, (...a: any[]) => Promise<any>>;
  beforeAll(async () => {
    vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');
    handlers = (await loadManifest()).handlers;
    for (const [param, table] of Object.entries(TABLE_OF)) { B_ID[param] = uid(); await seedRow(table, { id: B_ID[param], tenant_id: TENANT_B }); }
  }, T);

  it.each(BY_ID.map((o) => [o.id, o] as const))('%s', { timeout: T }, async (_id, op) => {
    const before = new Map<string, unknown>();
    for (const t of TENANT_TABLES) before.set(t, await snapshot(t, TENANT_B));
    for (const p of idParams(op)) expect((await snapshot(TABLE_OF[p]!, TENANT_B)).n, `B has a ${TABLE_OF[p]} row`).toBeGreaterThan(0);

    const h = makeHarness({ permissions: ALL, aal: 'aal2' }, op.id);
    const ids = Object.fromEntries(idParams(op).map((p) => [p, B_ID[p]!]));
    const req = requestFor(op, { ids });
    const out = await withClaims(api(), claimsOf(TENANT_A), async (c) => {
      const spied: string[] = [];
      h.ctx.tx = { async query(text: string, values?: unknown[]) { spied.push(text); return c.query(text, values as unknown[]); } };
      const fired = await fire(handlers[op.id]!, req, h.ctx);
      return { fired, spied };
    });
    expect(out.fired.reply, `answered ${out.fired.reply?.status}: B's object must be invisible to A`).toBeUndefined();
    if (BODY_REFS_FIRST.has(op.id)) expect(['common.not_found', 'common.validation_failed'], String(out.fired.error?.code)).toContain(out.fired.error?.code);
    else { expect(out.fired.error?.code, String(out.fired.error?.message)).toBe('common.not_found'); expect(out.fired.error?.statusCode).toBe(404); }
    for (const id of Object.values(ids)) expect(seen(out.fired.error), 'the id is not echoed').not.toContain(id);
    expect(out.spied.filter((q) => WRITE_SQL.test(q)), 'no write before the object was loaded').toEqual([]);
    expect(h.audits, 'no access-log row for an object the caller cannot see').toEqual([]);
    for (const t of TENANT_TABLES) expect(await snapshot(t, TENANT_B), `${t} of tenant B unchanged`).toEqual(before.get(t));
  });
});
