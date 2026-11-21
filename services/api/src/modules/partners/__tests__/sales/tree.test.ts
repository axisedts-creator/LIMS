// T0B-SALES-1 done_when (3): getSalesTree = ONE recursive query with a depth cap (8) and a cycle guard; a representative sees only the own subtree unless the user holds partners.sales.manage.
// Real PG17, RLS on. Fails now: getSalesTree / listSalesRepresentatives / listRepresentativeClients are pending. Synthetic data only.
// PIN: the caller's own representative = sales_representative.user_id = ctx.actor.id (READER_A.userId).
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, ADMIN_B, READER_A, T, TENANT_A, TENANT_B, chain, fire, mkAssignment, mkCreditParty, mkDesignation, mkRep, notFound, ok, rejected, req, superTx, wipe } from './helpers.js';

let D: any;
beforeEach(async () => { await wipe(TENANT_A, TENANT_B); D = await mkDesignation(TENANT_A, 1); }, T);
const tree = (query: object = {}, who = ADMIN_A) => fire('getSalesTree', req({ query }), who);
/** preorder invariant: every node of depth d > 1 has as manager the nearest earlier node of depth d - 1 (manager before reports, subtrees contiguous) */
function assertDfs(nodes: any[]): void {
  const last = new Map<number, string>();
  for (const n of nodes) {
    if (n.depth > 1) expect(n.manager_id, `${n.name} at depth ${n.depth}`).toBe(last.get(n.depth - 1));
    last.set(n.depth, n.id);
    for (const k of [...last.keys()]) if (k > n.depth) last.delete(k);
  }
}

describe('getSalesTree: shape, order, caps', () => {
  it('flat depth-first list, depth from 1 at the root, node shape = contract (no phone / email)', { timeout: T }, async () => {
    const top = await mkRep(TENANT_A, D.id, { name: 'A top' });
    const k1 = await mkRep(TENANT_A, D.id, { name: 'B kid', manager_id: top.id }); const k2 = await mkRep(TENANT_A, D.id, { name: 'C kid', manager_id: top.id, phone: '+9779800000002' });
    await mkRep(TENANT_A, D.id, { name: 'D grandkid', manager_id: k1.id }); await mkRep(TENANT_A, D.id, { name: 'E grandkid', manager_id: k2.id }); await mkRep(TENANT_A, D.id, { name: 'Z other top' });
    const b = ok(await tree());
    expect(b.data).toHaveLength(6); assertDfs(b.data);
    expect(b.data.filter((n: any) => n.depth === 1).map((n: any) => n.name).sort()).toEqual(['A top', 'Z other top']);
    expect(Object.keys(b.data[0]).every((k) => ['id', 'name', 'designation_id', 'designation_level', 'manager_id', 'depth', 'is_active'].includes(k))).toBe(true);
    expect(b.data[0]).toMatchObject({ designation_level: 1, is_active: true });
  });
  it('root_id starts the answer at that representative (depth 1); a foreign / unknown root is not_found', { timeout: T }, async () => {
    const [top, mid] = await chain(TENANT_A, D.id, 4);
    const b = ok(await tree({ root_id: mid!.id }));
    expect(b.data.map((n: any) => [n.name, n.depth])).toEqual([['Chain 2', 1], ['Chain 3', 2], ['Chain 4', 3]]); expect(top).toBeTruthy();
    notFound(await tree({ root_id: mid!.id }, ADMIN_B));
  });
  it('DEPTH CAP: a chain of 10 answers 8 levels by default, max_depth 3 answers 3, max_depth 9 or 0 is refused', { timeout: T }, async () => {
    await chain(TENANT_A, D.id, 10);
    expect(ok(await tree()).data.map((n: any) => n.depth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ok(await tree({ max_depth: 3 })).data).toHaveLength(3);
    expect(ok(await tree({ max_depth: 8 })).data).toHaveLength(8);
    for (const max_depth of [9, 0, -1, 'x']) rejected(await tree({ max_depth }), 'common.validation_failed', '/max_depth');
  });
  it('inactive leaves are hidden unless include_inactive=true', { timeout: T }, async () => {
    const [top] = await chain(TENANT_A, D.id, 1); await mkRep(TENANT_A, D.id, { name: 'Gone', manager_id: top!.id, is_active: false });
    expect(ok(await tree()).data).toHaveLength(1);
    const all = ok(await tree({ include_inactive: true })).data; expect(all).toHaveLength(2); expect(all.find((n: any) => n.name === 'Gone').is_active).toBe(false);
  });
  it('paged: limit 3 over 9 nodes follows the same depth-first order as the unpaged answer, no gap, no repeat; bad cursor -> invalid_cursor', { timeout: T }, async () => {
    const [top] = await chain(TENANT_A, D.id, 3); for (let i = 0; i < 6; i++) await mkRep(TENANT_A, D.id, { name: `Leaf ${i}`, manager_id: top!.id });
    const full = ok(await tree()).data.map((n: any) => n.id); const got: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 9; i++) { const p = ok(await tree({ limit: 3, ...(cursor ? { cursor } : {}) })); expect(p.data.length).toBeLessThanOrEqual(3); got.push(...p.data.map((n: any) => n.id)); cursor = p.page.next_cursor; if (!cursor) break; }
    expect(got).toEqual(full); rejected(await tree({ cursor: 'garbage' }), 'common.invalid_cursor');
  });
  it('tenant isolation: tenant B sees none of tenant A', { timeout: T }, async () => {
    await chain(TENANT_A, D.id, 3); expect(ok(await tree({}, ADMIN_B)).data).toEqual([]);
  });
});

describe('getSalesTree: one recursive query, no per row loops', () => {
  it('statement count does not grow with the tree: 1 WITH RECURSIVE statement, same total for 6 and 60 representatives', { timeout: T }, async () => {
    const [top] = await chain(TENANT_A, D.id, 2); for (let i = 0; i < 4; i++) await mkRep(TENANT_A, D.id, { manager_id: top!.id });
    const small = await tree(); ok(small);
    for (let i = 0; i < 54; i++) await mkRep(TENANT_A, D.id, { manager_id: top!.id });
    const big = await tree({ limit: 200 }); expect(ok(big).data).toHaveLength(60);
    expect(big.probe.sql.filter((s) => /WITH\s+RECURSIVE/i.test(s))).toHaveLength(1);
    expect(big.probe.sql.length).toBe(small.probe.sql.length); expect(big.probe.sql.length).toBeLessThanOrEqual(3);
  });
  it('CYCLE GUARD: corrupt data with a loop (written around the triggers) never hangs or repeats a node', { timeout: T }, async () => {
    const a = await mkRep(TENANT_A, D.id, { name: 'Loop A' }); const b = await mkRep(TENANT_A, D.id, { name: 'Loop B', manager_id: a.id }); const c = await mkRep(TENANT_A, D.id, { name: 'Loop C', manager_id: b.id });
    await superTx(async (tx) => { await tx.query("SET LOCAL session_replication_role = 'replica'", []); await tx.query('UPDATE partners.sales_representative SET manager_id = $2 WHERE id = $1', [a.id, c.id]); });
    const t0 = Date.now(); const b1 = ok(await tree({ root_id: a.id })); expect(Date.now() - t0).toBeLessThan(10_000);
    const ids = b1.data.map((n: any) => n.id); expect(new Set(ids).size).toBe(ids.length); expect(ids).toContain(a.id);
    ok(await tree()); ok(await fire('listSalesRepresentatives', req(), ADMIN_A));
  });
});

describe('a representative sees only the own subtree unless the user has partners.sales.manage', () => {
  async function org() {
    const R = await mkRep(TENANT_A, D.id, { name: 'Me', user_id: READER_A.userId });
    const R1 = await mkRep(TENANT_A, D.id, { name: 'My report', manager_id: R.id }); const R11 = await mkRep(TENANT_A, D.id, { name: 'My grand report', manager_id: R1.id });
    const T1 = await mkRep(TENANT_A, D.id, { name: 'Elsewhere top' }); const T11 = await mkRep(TENANT_A, D.id, { name: 'Elsewhere report', manager_id: T1.id });
    const up = await mkRep(TENANT_A, D.id, { name: 'My boss' }); await superTx(async (tx) => { await tx.query('UPDATE partners.sales_representative SET manager_id = $2 WHERE id = $1', [R.id, up.id]); });
    return { R, R1, R11, T1, T11, up };
  }
  it('getSalesTree without root: only the own subtree, own node at depth 1 (not the boss, not the other tree)', { timeout: T }, async () => {
    const { R, R1, R11 } = await org();
    const b = ok(await tree({}, READER_A)); expect(b.data.map((n: any) => n.id)).toEqual([R.id, R1.id, R11.id]); expect(b.data[0].depth).toBe(1);
  });
  it('root_id outside the own subtree (other tree, or the own manager) -> not_found; inside -> ok', { timeout: T }, async () => {
    const { R1, T1, up } = await org();
    notFound(await tree({ root_id: T1.id }, READER_A)); notFound(await tree({ root_id: up.id }, READER_A));
    expect(ok(await tree({ root_id: R1.id }, READER_A)).data).toHaveLength(2);
  });
  it('listSalesRepresentatives: own subtree only; manage holder sees all', { timeout: T }, async () => {
    const { R, R1, R11 } = await org();
    expect(ok(await fire('listSalesRepresentatives', req(), READER_A)).data.map((x: any) => x.id).sort()).toEqual([R.id, R1.id, R11.id].sort());
    expect(ok(await fire('listSalesRepresentatives', req(), ADMIN_A)).data).toHaveLength(6);
    expect(ok(await tree({}, ADMIN_A)).data.map((n: any) => n.name)).toContain('Elsewhere report');
  });
  it('listRepresentativeClients: own and subtree representatives ok; others not_found (no existence leak); manage holder ok for all', { timeout: T }, async () => {
    const { R1, T1 } = await org(); const p = await mkCreditParty(TENANT_A); await mkAssignment(TENANT_A, { party: p.id, rep: T1.id });
    const clients = (id: string, who: any) => fire('listRepresentativeClients', req({ params: { representative_id: id } }), who);
    ok(await clients(R1.id, READER_A)); notFound(await clients(T1.id, READER_A));
    expect(ok(await clients(T1.id, ADMIN_A)).data).toHaveLength(1);
  });
  it('a reader with no linked representative sees nothing: empty tree and list, clients not_found', { timeout: T }, async () => {
    const r = await mkRep(TENANT_A, D.id, { name: 'Someone else', user_id: '01a1a98a-ac40-7000-8000-00000000dead' });
    expect(ok(await tree({}, READER_A)).data).toEqual([]); expect(ok(await fire('listSalesRepresentatives', req(), READER_A)).data).toEqual([]);
    notFound(await fire('listRepresentativeClients', req({ params: { representative_id: r.id } }), READER_A));
  });
  it('a deactivated own representative record gives no access to the subtree', { timeout: T }, async () => {
    const { R } = await org(); await superTx(async (tx) => { await tx.query('UPDATE partners.sales_representative SET is_active = false WHERE id = $1', [R.id]); });
    expect(ok(await tree({}, READER_A)).data).toEqual([]);
  });
  it('tenant B reader linked to a tenant A representative id sees nothing of tenant A', { timeout: T }, async () => {
    await org(); expect(ok(await tree({}, { ...READER_A, tenant: TENANT_B })).data).toEqual([]);
  });
});
