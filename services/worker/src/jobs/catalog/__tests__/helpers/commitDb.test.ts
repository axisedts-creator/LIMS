// T-23 fixture self-check: the composite fake is atomic across both fakes, routes by table, and injects crashes where asked.
import { describe, expect, it } from 'vitest';
import { createPricingService } from '../../../../../../api/src/modules/catalog/service/pricing.service.js';
import { COMMITTER, IMPORT_ID, ORD, PRICE_LIST_ID, TENANT_A, TENANT_B, VER3_ID, eventsOf, makeCommitDb, makeCommitRunner, seedCommitting } from './commitDb.js';
import { priceWorkbook, prow } from './workbooks.js';

const touch = async (ctx: any) => {
  await ctx.tx.query("UPDATE catalog.imports SET status = 'committed', version = version + 1 WHERE tenant_id = $1 AND id = $2", [TENANT_A, IMPORT_ID]);
  await ctx.tx.query('UPDATE catalog.price_lists SET name = $3 WHERE tenant_id = $1 AND id = $2', [TENANT_A, PRICE_LIST_ID, 'Renamed (synthetic)']);
};
const sheet = () => priceWorkbook([prow('CBC', 15)]);

describe('commitDb fixture', () => {
  it('world: v3 published with CBC/LFT/TSH, tenant revisions seeded, committing import visible', async () => {
    const db = makeCommitDb();
    await seedCommitting(db, await sheet());
    expect(db.priceMap(VER3_ID)).toEqual({ CBC: 100000, LFT: 200000, TSH: 300000 });
    expect([db.revision(TENANT_A), db.revision(TENANT_B)]).toEqual([10, 20]);
    expect(db.imp()).toMatchObject({ status: 'committing', committed_by: COMMITTER, commit_publish: true, version: 5 });
    expect(ORD.CBC.tenant_id).toBe(TENANT_A);
  });

  it('a resolving handler commits writes to BOTH fakes; a throwing handler rolls back BOTH', async () => {
    const db = makeCommitDb();
    await seedCommitting(db, await sheet());
    const before = db.snapshot();
    await expect(makeCommitRunner(db, async (_p, ctx) => { await touch(ctx); throw new Error('boom'); }).run({})).rejects.toThrow('boom');
    expect(db.snapshot()).toEqual(before);
    await makeCommitRunner(db, async (_p, ctx) => { await touch(ctx); }).run({});
    expect(db.imp().status).toBe('committed');
    expect(db.snapshot().price_lists[0].name).toBe('Renamed (synthetic)');
  });

  it('crashAtWrite(n) throws exactly at the n-th write of the main tx and leaves nothing; crashBeforeCommit leaves nothing', async () => {
    const db = makeCommitDb();
    await seedCommitting(db, await sheet());
    const before = db.snapshot();
    db.crashAtWrite(2);
    await expect(makeCommitRunner(db, async (_p, ctx) => { await touch(ctx); }).run({})).rejects.toThrow('simulated crash');
    expect(db.writes().filter((s) => s.main)).toHaveLength(2);
    expect(db.snapshot()).toEqual(before);
    db.crashBeforeCommit();
    await expect(makeCommitRunner(db, async (_p, ctx) => { await touch(ctx); }).run({})).rejects.toThrow('before COMMIT');
    expect(db.snapshot()).toEqual(before);
    db.noCrash();
    await makeCommitRunner(db, async (_p, ctx) => { await touch(ctx); }).run({});
    expect(db.imp().status).toBe('committed');
  });

  it('reference apply: the REAL API pricing service (draft -> upsert -> remove -> publish) runs on the fake and yields what importCommit.test.ts expects', async () => {
    const db = makeCommitDb();
    await seedCommitting(db, await sheet());
    const rev = db.revision();
    const r = makeCommitRunner(db, async (_p, c) => {
      const ctx: any = { ...c, actor: { type: 'user', id: COMMITTER } };
      const svc = createPricingService({ events: { publish: (...a: unknown[]) => (c.events.publish as any)(...a) }, identity: {} } as never) as any;
      await svc.createPriceListVersionDraft(ctx, { id: PRICE_LIST_ID });
      const vid = (await ctx.tx.query("SELECT id FROM catalog.price_list_versions WHERE tenant_id = $1 AND status = 'draft'", [TENANT_A])).rows[0].id;
      const p = (n: number) => ({ currency: 'NPR', amount_paisa: n });
      await svc.upsertPriceListItems(ctx, { versionId: vid, body: { items: [{ orderable_id: ORD.CBC.id, unit_price: p(150000) }, { orderable_id: ORD.HBA1C.id, unit_price: p(50050) }] } });
      await svc.removePriceListItems(ctx, { versionId: vid, body: { ids: [ORD.TSH.id] } });
      const row = (await ctx.tx.query('SELECT version FROM catalog.price_list_versions WHERE tenant_id = $1 AND id = $2', [TENANT_A, vid])).rows[0];
      await svc.publishPriceListVersion(ctx, { versionId: vid, expectedVersion: row.version, body: { effective_from: '2026-11-10T00:00:00.000Z', change_reason: 'Synthetic tariff revision' } });
    });
    await r.run({});
    expect(db.versions().map((v) => [v.version_no, v.status])).toEqual([[3, 'superseded'], [4, 'published']]);
    expect(db.priceMap(db.versions()[1]!.id)).toEqual({ CBC: 150000, LFT: 200000, HBA1C: 50050 });
    expect(db.versions()[1]).toMatchObject({ created_by: COMMITTER, published_by: COMMITTER, item_count: 3 });
    expect(db.revision()).toBe(rev + 1);
    expect(eventsOf(r.events)).toHaveLength(1);
    expect(eventsOf(r.events)[0]!.payload).toMatchObject({ entity_type: 'price_list', entity_id: PRICE_LIST_ID, change_kind: 'versioned' });
  });

  it('ctx.db.tx reuses ctx.tx (rolls back with it); tenant B cannot see tenant A rows; eventsOf finds the type', async () => {
    const db = makeCommitDb();
    await seedCommitting(db, await sheet());
    const r = makeCommitRunner(db, async (_p, ctx) => {
      await ctx.db.tx((c: any) => c.tx.query("UPDATE catalog.imports SET last_error_code = 'common.internal' WHERE tenant_id = $1 AND id = $2", [TENANT_A, IMPORT_ID]));
      await ctx.events.publish(ctx.tx, 'catalog.changed.v1', { payload: { entity_type: 'price_list' } });
      throw new Error('boom');
    });
    await expect(r.run({})).rejects.toThrow('boom');
    expect(db.imp().last_error_code ?? null).toBeNull();
    expect(eventsOf(r.events)).toHaveLength(1);
    expect(eventsOf(r.events)[0]!.payload.entity_type).toBe('price_list');
    const other = makeCommitRunner(db, async (_p, ctx) => {
      const { rows } = await ctx.tx.query('SELECT id FROM catalog.imports WHERE tenant_id = $1 AND id = $2', [TENANT_A, IMPORT_ID]);
      expect(rows).toHaveLength(0);
    }, { tenantId: TENANT_B });
    await other.run({});
  });
});
