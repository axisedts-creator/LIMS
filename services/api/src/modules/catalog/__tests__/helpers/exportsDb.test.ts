// T-24 fixture self-check: the exportsDb fake behaves like the Postgres features the T-24 tests rely on.
import { describe, expect, it } from 'vitest';
import { makeExportsDb, NOW, TENANT_A, TENANT_B, USER, V7 } from './exportsDb.js';

const ins = (id: string, tenant = TENANT_A) => ['INSERT INTO catalog.exports (id, tenant_id, kind, status, created_by, updated_by) VALUES ($1, $2, \'catalog_master\', \'queued\', $3, $3) RETURNING *', [id, tenant, USER]] as const;

describe('exportsDb', () => {
  it('commits on resolve, rolls back (rows and jobs) on reject', async () => {
    const db = makeExportsDb();
    await db.run(async (c) => { await c.tx.query(...ins(V7('000000000001'))); await c.tx.query("SELECT app.enqueue_job('x.y', $1::jsonb, $2)", [JSON.stringify({ a: 1 }), 'k']); });
    await db.run(async (c) => { await c.tx.query(...ins(V7('000000000002'))); throw new Error('boom'); }).catch(() => undefined);
    expect(db.rows('exports').map((r) => r.id)).toEqual([V7('000000000001')]);
    expect(db.jobs).toHaveLength(1);
  });

  it('RLS: SELECT sees only the tenant; INSERT for another tenant -> 42501', async () => {
    const db = makeExportsDb();
    db.seed.export(TENANT_B, {});
    const rows = await db.run((c) => c.tx.query('SELECT * FROM catalog.exports WHERE tenant_id = $1', [TENANT_A]));
    expect(rows.rows).toEqual([]);
    await expect(db.run((c) => c.tx.query(...ins(V7('000000000003'), TENANT_B)))).rejects.toMatchObject({ code: '42501' });
  });

  it('constraints: bad kind -> 23514, missing not-null -> 23502, duplicate id -> 23505; read-only tables refuse writes', async () => {
    const db = makeExportsDb();
    const bad = (q: string, v: unknown[]) => db.run((c) => c.tx.query(q, v)).then(() => undefined, (e) => e.code);
    expect(await bad("INSERT INTO catalog.exports (id, tenant_id, kind, created_by, updated_by) VALUES ($1, $2, 'nope', $3, $3)", [V7('000000000004'), TENANT_A, USER])).toBe('23514');
    expect(await bad('INSERT INTO catalog.exports (id, tenant_id, kind, created_by) VALUES ($1, $2, \'referrers\', $3)', [V7('000000000005'), TENANT_A, USER])).toBe('23502');
    await db.run((c) => c.tx.query(...ins(V7('000000000006'))));
    expect(await bad(...ins(V7('000000000006')))).toBe('23505');
    expect(await bad('UPDATE catalog.orderables SET name = $2 WHERE tenant_id = $1', [TENANT_A, 'x'])).toBe('42501');
    expect(await bad('INSERT INTO catalog.price_lists (id, tenant_id) VALUES ($1, $2)', [V7('000000000007'), TENANT_A])).toBe('42501');
    expect(await bad('DELETE FROM catalog.exports WHERE tenant_id = $1', [TENANT_A])).toBe('42501');
  });

  it('READ COMMITTED sees a concurrent commit; REPEATABLE READ keeps its snapshot', async () => {
    const db = makeExportsDb();
    db.seed.rows('orderables', { id: V7('00000000000a'), tenant_id: TENANT_A, code: 'A1', name: 'old' });
    const read = (c: any) => c.tx.query('SELECT name FROM catalog.orderables WHERE tenant_id = $1', [TENANT_A]).then((r: any) => r.rows[0].name);
    const rc = db.begin(TENANT_A), rr = db.begin(TENANT_A);
    await rr.facade.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(await read({ tx: rc.facade })).toBe('old');
    expect(await read({ tx: rr.facade })).toBe('old');
    db.update('orderables', () => true, { name: 'new' });
    expect(await read({ tx: rc.facade })).toBe('new');
    expect(await read({ tx: rr.facade })).toBe('old');
  });

  it('SET TRANSACTION after a query -> 25001', async () => {
    const db = makeExportsDb();
    const tx = db.begin(TENANT_A);
    await tx.facade.query('SELECT * FROM catalog.orderables WHERE tenant_id = $1', [TENANT_A]);
    await expect(tx.facade.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')).rejects.toMatchObject({ code: '25001' });
  });

  it('onRead counts read-only table SELECTs only; bigint/count come back as strings; timestamps as Date', async () => {
    const db = makeExportsDb();
    const seen: number[] = [];
    db.onRead(({ n }) => seen.push(n));
    db.seed.rows('price_list_items', { id: V7('00000000000b'), tenant_id: TENANT_A, unit_price_paisa: 12345 });
    await db.run(async (c) => {
      await c.tx.query('SELECT * FROM catalog.exports WHERE tenant_id = $1', [TENANT_A]);
      const r = await c.tx.query('SELECT unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1', [TENANT_A]);
      expect(r.rows[0].unit_price_paisa).toBe('12345');
      expect((await c.tx.query('SELECT count(*) AS n FROM catalog.price_list_items WHERE tenant_id = $1', [TENANT_A])).rows[0].n).toBe('1');
    });
    expect(seen).toEqual([1, 2]);
    await db.run((c) => c.tx.query(...ins(V7('00000000000c'))));
    expect(db.rows('exports')[0]!.created_at).toEqual(new Date(NOW));
  });

  it('unsupported SQL (join / OR) fails loudly instead of returning wrong rows', async () => {
    const db = makeExportsDb();
    await expect(db.run((c) => c.tx.query('SELECT * FROM catalog.exports e JOIN catalog.files f ON f.id = e.file_id WHERE e.tenant_id = $1', [TENANT_A]))).rejects.toThrow(/unsupported/);
    await expect(db.run((c) => c.tx.query('SELECT * FROM catalog.exports WHERE tenant_id = $1 OR kind = \'x\'', [TENANT_A]))).rejects.toThrow(/unsupported/);
  });
});
