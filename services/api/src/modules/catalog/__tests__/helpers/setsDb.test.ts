// T-05 (C3) — self-check of the fake in setsDb.ts (so a red service test means a red service, not a lying fake). Passes without any implementation.
import { describe, expect, it } from 'vitest';
import { ROOT_A, TENANT_A, TENANT_B, USER } from './catalogDb.js';
import { ID } from './mastersDb.js';
import { av, gSet, gUnit, gVal, makeSetsDb, unit, vset, vval } from './setsDb.js';

const T = 20_000;
const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 5 } } };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'none'; };
const ins = (tenant: string, id: string, c: string, d = 'x') => ['INSERT INTO catalog.cs_units (id, tenant_id, code, display, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) RETURNING *', [id, tenant, c, d, USER]] as const;

describe('setsDb fake', () => {
  it('global tables are visible to every tenant and read-only (INSERT/UPDATE/DELETE -> 42501)', { timeout: T }, async () => {
    const db = makeSetsDb({ rows: { g_units: [gUnit(1)] } });
    for (const tenant of [TENANT_A, TENANT_B]) expect((await db.run((c) => c.tx.query('SELECT * FROM catalog.g_units WHERE code = $1', ['gu_1']), { tenantId: tenant })).rows).toHaveLength(1);
    expect(await code(db.run((c) => c.tx.query('INSERT INTO catalog.g_units (id, code, display) VALUES ($1, $2, $3)', [ID(1), 'x', 'x'])))).toBe('42501');
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.g_units SET display = $1 WHERE code = $2', ['y', 'gu_1'])))).toBe('42501');
    expect(await code(db.run((c) => c.tx.query('DELETE FROM catalog.g_units WHERE code = $1', ['gu_1'])))).toBe('42501');
    expect(db.row('g_units', gUnit(1).id)!.display).toBe('gu 1');
  });

  it('tenant rows: RLS hides other tenants, foreign tenant_id on INSERT -> 42501, UNIQUE(tenant, code) -> 23505, same code in another tenant is fine', { timeout: T }, async () => {
    const db = makeSetsDb({ catalog: seedState, rows: { cs_units: [unit(1, TENANT_B, { code: 'shared' })] } });
    expect((await db.run((c) => c.tx.query('SELECT * FROM catalog.cs_units', []))).rows).toHaveLength(0);
    expect(await code(db.run((c) => c.tx.query(...ins(TENANT_B, ID(2), 'zz'))))).toBe('42501');
    await db.run((c) => c.tx.query(...ins(TENANT_A, ID(3), 'shared')));
    expect(await code(db.run((c) => c.tx.query(...ins(TENANT_A, ID(4), 'shared'))))).toBe('23505');
    expect(db.rows('cs_units')).toHaveLength(2);
  });

  it('CHECK (23514) and NOT NULL (23502); the DB does NOT know the global-code rule (service duty)', { timeout: T }, async () => {
    const db = makeSetsDb({ rows: { g_units: [gUnit(1, { code: 'g_dl' })] } });
    expect(await code(db.run((c) => c.tx.query(...ins(TENANT_A, ID(1), 'bad code'))))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query(...ins(TENANT_A, ID(2), 'ok', 'x'.repeat(33)))))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query('INSERT INTO catalog.cs_units (id, tenant_id, code, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)', [ID(3), TENANT_A, 'ok', USER])))).toBe('23502');
    expect(await code(db.run((c) => c.tx.query(...ins(TENANT_A, ID(4), 'g_dl'))))).toBe('none');
  });

  it('value rows: FK to cs_value_sets (23503), UNIQUE(tenant, set, code), sort_order has no default', { timeout: T }, async () => {
    const s = vset(1, TENANT_A);
    const db = makeSetsDb({ rows: { cs_value_sets: [s], cs_value_set_values: [vval(s.id, 1, TENANT_A)] } });
    const insV = (setId: string, c: string, extra = '$5') => db.run((x) => x.tx.query(`INSERT INTO catalog.cs_value_set_values (id, tenant_id, value_set_id, code, display, sort_order, created_by, updated_by) VALUES ($1, $2, $3, $4, 'd', ${extra}, $6, $6)`, [db.newId(), TENANT_A, setId, c, 10, USER]));
    expect(await code(insV(ID(0xdead), 'A'))).toBe('23503');
    expect(await code(insV(s.id, 'V1'))).toBe('23505');
    expect(await code(insV(s.id, 'V2'))).toBe('none');
    expect(await code(db.run((x) => x.tx.query("INSERT INTO catalog.cs_value_set_values (id, tenant_id, value_set_id, code, display, created_by, updated_by) VALUES ($1, $2, $3, 'V3', 'd', $4, $4)", [db.newId(), TENANT_A, s.id, USER])))).toBe('23502');
  });

  it('analyte_versions is seed-only: SELECT works (tenant-scoped, count(*), IN), writes -> 42501', { timeout: T }, async () => {
    const db = makeSetsDb({ rows: { analyte_versions: [av(1, TENANT_A, 'URINE', 'published'), av(2, TENANT_A, 'URINE', 'draft'), av(3, TENANT_B, 'URINE', 'published')] } });
    const r = await db.run((c) => c.tx.query("SELECT count(*) FROM catalog.analyte_versions WHERE tenant_id = $1 AND value_set_code = $2 AND status IN ('published', 'superseded')", [TENANT_A, 'URINE']));
    expect(r.rows[0].count).toBe('1');
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.analyte_versions SET status = $1 WHERE id = $2', ['draft', av(1, TENANT_A, 'URINE', 'published').id])))).toBe('42501');
  });

  it('writes are private until COMMIT, discarded on rollback; row lock serialises FOR UPDATE and the WHERE is re-evaluated after the lock', { timeout: T }, async () => {
    const u = unit(1, TENANT_A);
    const db = makeSetsDb({ catalog: seedState, rows: { cs_units: [u] } });
    await code(db.run((c) => c.tx.query(...ins(TENANT_A, ID(9), 'gone')), { rollback: true }));
    expect(db.rows('cs_units')).toHaveLength(1);
    const bump = () => db.run(async (c) => {
      const lock = await c.tx.query('SELECT * FROM catalog.cs_units WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [TENANT_A, u.id]);
      const ver = lock.rows[0].version;
      const res = await c.tx.query('UPDATE catalog.cs_units SET version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *', [TENANT_A, u.id, 1]);
      return { ver, n: res.rows.length };
    });
    const out = await Promise.all([bump(), bump()]);
    expect(out.map((o) => o.n).sort()).toEqual([0, 1]);          // the second one sees version 2 after waiting for the lock
    expect(db.row('cs_units', u.id)!.version).toBe(2);
  });

  it('seed factories give distinct ids', () => {
    const ids = [gSet(1).id, gSet(2).id, gUnit(1).id, unit(1, TENANT_A).id, vset(1, TENANT_A).id, gVal('A', 1).id, gVal('A', 1).id, vval(ID(1), 1, TENANT_A).id];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
