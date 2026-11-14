// HC-T16 FORCE-RLS contract tests T1-T5 of app.homecollection_anonymise_retired_visits(p_before timestamptz) (05-SCHEMA §4.2, 08 A12.7 / A19 P-41, 07-SECURITY §4a + AB17) and the P-18(c) delete policy on visit_locations.
// C0-0B transcribes, C17 HC-T16 owns the cases. Live PG17 (tests/homecollection/HC-T16.pg.sh applies §4.2 + the C0 visits__transition_guard stand-in from tests/homecollection/HC-T16.fixture.sql when the migration is absent).
// Roles: the job runs as lims_worker (EXECUTE), a request as lims_api (a lims_app session, NO execute). Missing env = HARD FAILURE.
// No implementation file is imported: these cases fail only if the DB contract (migration / stand-in) is wrong.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { TENANT_A, TENANT_B, apiTx, closePools, workerTx } from './hc16.helpers.js';
import { collectedVisit, handOver, hc, ownerRows, seed, superTx, visitOf } from './hc16.fixtures.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
afterAll(async () => { await closePools(); });

const FN = 'app.homecollection_anonymise_retired_visits';
const MAINT = 'homecollection_anonymise_retired_visits';
const PII = { address_text: 'Synthetic Lane 5, Ward 2', landmark: 'Near the synthetic bridge', latitude: 27.69, longitude: 85.31, note_for_phlebotomist: 'synthetic note', status_reason_text: 'synthetic reason' };
const call = (tx: any, before: string) => tx.query(`SELECT * FROM ${FN}($1::timestamptz)`, [before]);
const nulls = (v: any) => [v.address_text, v.landmark, v.latitude, v.longitude, v.note_for_phlebotomist, v.status_reason_text].every((x) => x === null);
const same = (v: any) => v.address_text === PII.address_text && v.landmark === PII.landmark && v.status_reason_text === PII.status_reason_text;
const barcode = async (id: string) => (await ownerRows('homecollection.handover_items', 'id = $1', [id]))[0].barcode;
async function closedVisit(s: 'a' | 'b', at: string, st: 'completed' | 'cancelled' | 'unassigned' = 'completed') {
  const t = st === 'completed' ? { status: st, outcome: 'collected', completed_at: at } : st === 'cancelled' ? { status: st, outcome: null, completed_at: null, cancelled_at: at }
    : { status: st, outcome: null, completed_at: null, assigned_membership_id: null, assigned_at: null };
  const c = await collectedVisit(s, at, { visit: { ...PII, ...t } });
  const { item } = await handOver(s, c);
  return { ...c, item };
}
const rejects = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e: any) { return String(e?.message ?? e); } };
/** run `fn` inside a savepoint so an expected error does not abort the surrounding transaction */
async function guarded(tx: any, sql: string, values: unknown[] = []) {
  await tx.query('SAVEPOINT g');
  try { const r = await tx.query(sql, values); await tx.query('RELEASE SAVEPOINT g'); return { ok: true, rowCount: r.rowCount as number, msg: '' }; }
  catch (e: any) { await tx.query('ROLLBACK TO SAVEPOINT g'); return { ok: false, rowCount: -1, msg: String(e?.message ?? e) }; }
}

describe('catalogue: the one DEFINER and its FORCE-RLS owner policies (05-SCHEMA §4.2 inventory row)', () => {
  it('SECURITY DEFINER owned by lims_owner, search_path pinned empty, EXECUTE only for lims_worker (not PUBLIC, not lims_api)', async () => {
    const r = await superTx(async (tx: any) => (await tx.query(
      `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig, has_function_privilege('lims_worker', p.oid, 'EXECUTE') AS worker, has_function_privilege('lims_api', p.oid, 'EXECUTE') AS api,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub FROM pg_proc p WHERE p.oid = to_regprocedure('${FN}(timestamptz)')`)).rows);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ prosecdef: true, owner: 'lims_owner', worker: true, api: false, pub: false });
    expect(r[0].proconfig).toEqual(['search_path=""']);
  });
  it('visits and handover_items have FORCE ROW LEVEL SECURITY and the four owner policies are TO lims_owner only', async () => {
    const t = await superTx(async (tx: any) => (await tx.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('homecollection.visits'::regclass, 'homecollection.handover_items'::regclass) ORDER BY relname`)).rows);
    expect(t.map((x: any) => [x.relname, x.relrowsecurity, x.relforcerowsecurity])).toEqual([['handover_items', true, true], ['visits', true, true]]);
    const p = await superTx(async (tx: any) => (await tx.query(`SELECT tablename, policyname, roles::text AS roles, cmd FROM pg_policies WHERE schemaname = 'homecollection' AND policyname LIKE '%__owner_only' AND tablename IN ('visits', 'handover_items') ORDER BY policyname`)).rows);
    expect(p.map((x: any) => [x.policyname, x.cmd, x.roles])).toEqual([
      ['handover_items__select__owner_only', 'SELECT', '{lims_owner}'], ['handover_items__update__owner_only', 'UPDATE', '{lims_owner}'],
      ['visits__select__owner_only', 'SELECT', '{lims_owner}'], ['visits__update__owner_only', 'UPDATE', '{lims_owner}']]);
  });
});

describe('T1 tenant-A system claims: closed visit past p_before and its handover item are anonymised; everything else is unchanged; counts returned', () => {
  it('only the old closed tenant-A visit + item change (open visit, closed-but-newer visit, tenant-B rows untouched); the function returns (1, 1)', async () => {
    const old = await closedVisit('a', '1990-06-01T00:00:00Z'); const newer = await closedVisit('a', '1999-06-01T00:00:00Z');
    const open = await closedVisit('a', '1990-06-01T00:00:00Z', 'unassigned'); const b = await closedVisit('b', '1990-06-01T00:00:00Z');
    const before = await visitOf(old.visit.id);
    const out = await workerTx(TENANT_A, async (tx: any) => (await call(tx, '1995-01-01T00:00:00Z')).rows);
    expect(out).toEqual([{ visits_anonymised: 1, handover_items_anonymised: 1 }]);
    const v = await visitOf(old.visit.id);
    expect(nulls(v)).toBe(true);
    expect(v).toMatchObject({ status: 'completed', tenant_id: TENANT_A, order_id: old.visit.order_id });
    expect(Number(v.version)).toBe(Number(before.version) + 1);
    expect(await barcode(old.item.id)).toBe('ANONYMISED');
    for (const x of [newer, open, b]) { expect(same(await visitOf(x.visit.id))).toBe(true); expect(await barcode(x.item.id)).toBe(x.item.barcode); }
  });
  it('a cancelled visit is closed too; a second call is a no-op returning (0, 0) for rows already anonymised', async () => {
    const c = await closedVisit('a', '1991-03-01T00:00:00Z', 'cancelled');
    const first = await workerTx(TENANT_A, async (tx: any) => (await call(tx, '1992-01-01T00:00:00Z')).rows[0]);
    expect(first).toEqual({ visits_anonymised: 1, handover_items_anonymised: 1 });
    expect(nulls(await visitOf(c.visit.id))).toBe(true);
    const snap = JSON.stringify(await visitOf(c.visit.id));
    const again = await workerTx(TENANT_A, async (tx: any) => (await call(tx, '1992-01-01T00:00:00Z')).rows[0]);
    expect(again).toEqual({ visits_anonymised: 0, handover_items_anonymised: 0 });
    expect(JSON.stringify(await visitOf(c.visit.id))).toBe(snap);
  });
});

describe('T2 a lims_app session that sets app.maintenance itself gets nothing from the owner policies', () => {
  it('reads no extra rows; UPDATE of handover_items.barcode or visits.address_text on a closed visit still fails with immutable_row; rows unchanged', async () => {
    const c = await closedVisit('a', '1993-01-01T00:00:00Z');
    const r = await apiTx(TENANT_A, async (tx: any) => {
      const count = async () => [Number((await tx.query('SELECT count(*) AS n FROM homecollection.visits')).rows[0].n), Number((await tx.query('SELECT count(*) AS n FROM homecollection.handover_items')).rows[0].n)];
      const before = await count();
      await tx.query("SELECT set_config('app.maintenance', $1, true)", [MAINT]);
      const after = await count();
      const foreign = Number((await tx.query('SELECT count(*) AS n FROM homecollection.visits WHERE tenant_id <> $1', [TENANT_A])).rows[0].n);
      const bc = await guarded(tx, "UPDATE homecollection.handover_items SET barcode = 'ANONYMISED' WHERE id = $1", [c.item.id]);
      const ad = await guarded(tx, 'UPDATE homecollection.visits SET address_text = NULL WHERE id = $1', [c.visit.id]);
      const direct = await guarded(tx, `SELECT * FROM ${FN}('1995-01-01T00:00:00Z')`);
      return { before, after, foreign, bc, ad, direct };
    }, 'system');
    expect(r.after).toEqual(r.before);
    expect(r.foreign).toBe(0);
    expect(r.bc.ok, 'barcode update must fail').toBe(false); expect(r.bc.msg).toContain('immutable_row');
    expect(r.ad.ok, 'address update must fail').toBe(false); expect(r.ad.msg).toContain('immutable_row');
    expect(r.direct.ok, 'lims_api has no EXECUTE').toBe(false); expect(r.direct.msg).toMatch(/permission denied/i);
    expect(same(await visitOf(c.visit.id))).toBe(true);
    expect(await barcode(c.item.id)).toBe(c.item.barcode);
  });
});

describe('T3 the maintenance flag is cleared when the function returns', () => {
  it("current_setting('app.maintenance', true) is '' after the call (same transaction)", async () => {
    await closedVisit('a', '1994-01-01T00:00:00Z');
    const v = await workerTx(TENANT_A, async (tx: any) => { await call(tx, '1994-06-01T00:00:00Z'); return (await tx.query("SELECT current_setting('app.maintenance', true) AS m")).rows[0].m; });
    expect(v).toBe('');
  });
});

describe('T4 invalid input raises homecollection_anonymise_invalid_input and changes nothing', () => {
  it('no tenant claims, a user actor, p_before in the future, NULL p_before, no actor id: all rejected', async () => {
    const c = await closedVisit('a', '1990-02-01T00:00:00Z');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const bad: Array<[string, () => Promise<unknown>]> = [
      ['no tenant claims', () => workerTx(null, (tx: any) => call(tx, '1995-01-01T00:00:00Z'))],
      ['user actor', () => workerTx(TENANT_A, (tx: any) => call(tx, '1995-01-01T00:00:00Z'), 'user')],
      ['p_before in the future', () => workerTx(TENANT_A, (tx: any) => call(tx, future))],
      ['NULL p_before', () => workerTx(TENANT_A, (tx: any) => tx.query(`SELECT * FROM ${FN}(NULL::timestamptz)`))],
      ['no actor id', () => workerTx(TENANT_A, (tx: any) => call(tx, '1995-01-01T00:00:00Z'), 'system', '')],
    ];
    for (const [name, p] of bad) expect(await rejects(p()), name).toContain('homecollection_anonymise_invalid_input');
    expect(same(await visitOf(c.visit.id))).toBe(true);
    expect(await barcode(c.item.id)).toBe(c.item.barcode);
  });
});

describe('T5 visit_locations retention delete (08 A17 P-18(c)): system actor only, expired rows of its own tenant only', () => {
  it("a user actor's DELETE affects 0 rows; the system actor deletes only expired rows of its tenant (live rows and tenant B stay)", async () => {
    const ca = await collectedVisit('a', new Date(Date.now() - 86_400_000).toISOString()); const cb = await collectedVisit('b', new Date(Date.now() - 86_400_000).toISOString());
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const mk = (s: 'a' | 'b', c: typeof ca, expiresDays: number) => hc.location(s, c.visit.id, c.mut.id, { captured_at: ago(expiresDays < 0 ? 100 : 1), expires_at: ago(-expiresDays) });
    const aOld = mk('a', ca, -10); const aLive = mk('a', ca, 10); const bOld = mk('b', cb, -10);
    for (const row of [aOld, aLive, bOld]) await seed('homecollection.visit_locations', row);
    const ids = [aOld.id, aLive.id, bOld.id];
    const del = (tx: any) => tx.query('DELETE FROM homecollection.visit_locations WHERE id = ANY($1::uuid[])', [ids]);
    const asUser = await apiTx(TENANT_A, async (tx: any) => (await del(tx)).rowCount, 'user');
    expect(asUser).toBe(0);
    expect((await ownerRows('homecollection.visit_locations', 'id = ANY($1::uuid[])', [ids])).length).toBe(3);
    const asSystem = await workerTx(TENANT_A, async (tx: any) => (await del(tx)).rowCount);
    expect(asSystem).toBe(1);
    expect((await ownerRows('homecollection.visit_locations', 'id = ANY($1::uuid[])', [ids])).map((x: any) => x.id).sort()).toEqual([aLive.id, bOld.id].sort());
  });
  it('lims_app has DELETE on no other homecollection table (CI rule of 05-SCHEMA §4.1)', async () => {
    const t = await superTx(async (tx: any) => (await tx.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'homecollection' AND c.relkind = 'r' AND has_table_privilege('lims_app', c.oid, 'DELETE') ORDER BY 1`)).rows);
    expect(t.map((x: any) => x.relname)).toEqual(['visit_locations']);
  });
});
