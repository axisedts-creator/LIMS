// T-15 (C3) — self-check of the fake in doctorsDb.ts (so a red service test means a red service, not a lying fake). Passes without any implementation.
import { describe, expect, it } from 'vitest';
import { ROOT_A, STARTED_AT, TENANT_A, TENANT_B, USER } from './catalogDb.js';
import { actorIdentity, ctr, doc, makeDoctorsDb, normName } from './doctorsDb.js';
import { ID } from './mastersDb.js';

const T = 20_000;
const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 5 } } };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'none'; };
const insD = (id: string, c: string, o: { tenant?: string; name?: string; merged?: string | null; active?: boolean; phone?: string | null; source?: string } = {}) =>
  ['INSERT INTO catalog.doctors (id, tenant_id, doctor_code, display_name, name_normalised, phone_e164, source, merged_into_id, is_active, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING *',
    [id, o.tenant ?? TENANT_A, c, o.name ?? 'Dr X', normName(o.name ?? 'Dr X'), o.phone ?? null, o.source ?? 'back_office', o.merged ?? null, o.active ?? true, USER]] as const;

describe('doctorsDb fake', () => {
  it('UNIQUE(tenant, doctor_code) -> 23505 (per tenant); PK; defaults (version 1, is_active, is_verified false); CHECKs 23514; NOT NULL 23502', { timeout: T }, async () => {
    const db = makeDoctorsDb({ catalog: seedState });
    expect(await code(db.run((c) => c.tx.query(...insD(ID(1), 'DR1'))))).toBe('none');
    expect(db.row(ID(1))).toMatchObject({ version: 1, is_active: true, is_verified: false, merged_into_id: null, created_by: USER });
    expect(await code(db.run((c) => c.tx.query(...insD(ID(2), 'DR1'))))).toBe('23505');
    expect(await code(db.run((c) => c.tx.query(...insD(ID(1), 'DR2'))))).toBe('23505');
    expect(await code(db.run((c) => c.tx.query(...insD(ID(3), 'DR1', { tenant: TENANT_B }), ), { tenantId: TENANT_B }))).toBe('none');
    for (const [c, o] of [['lower', {}], ['X'.repeat(21), {}], ['A B', {}], ['OK1', { name: '' }], ['OK2', { name: 'x'.repeat(121) }], ['OK3', { phone: '12345678' }], ['OK4', { phone: '+0123456789' }],
      ['OK5', { source: 'web' }]] as const) {
      expect(await code(db.run((x) => x.tx.query(...insD(ID(9), c, o)))), c).toBe('23514');
    }
    expect(await code(db.run((x) => x.tx.query('INSERT INTO catalog.doctors (id, tenant_id, doctor_code, display_name, source, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [ID(8), TENANT_A, 'OK6', 'n', 'quick_add', USER])))).toBe('23502');
    expect(await code(db.run((x) => x.tx.query(...insD(ID(7), 'OK7', { phone: '+97798000001' }))))).toBe('none');
  });

  it('merged_into_id: FK to a doctor of the same tenant (23503), not self, and only on an inactive row; a merge UPDATE works and a re-point UPDATE works', { timeout: T }, async () => {
    const db = makeDoctorsDb({ catalog: seedState, rows: { doctors: [doc(1, TENANT_A), doc(2, TENANT_A), doc(3, TENANT_B)] } });
    const [d1, d2, b3] = [doc(1, TENANT_A).id, doc(2, TENANT_A).id, doc(3, TENANT_B).id];
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.doctors SET merged_into_id = $1, is_active = false WHERE id = $2', [b3, d1])))).toBe('23503');
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.doctors SET merged_into_id = $1, is_active = false WHERE id = $1', [d1])))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.doctors SET merged_into_id = $1 WHERE id = $2', [d2, d1])))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.doctors SET merged_into_id = $1, is_active = false, version = version + 1 WHERE id = $2', [d2, d1])))).toBe('none');
    expect(db.row(d1)).toMatchObject({ merged_into_id: d2, is_active: false, version: 2 });
    await db.run((c) => c.tx.query('UPDATE catalog.doctors SET merged_into_id = $1 WHERE tenant_id = $2 AND merged_into_id = $3', [d2, TENANT_A, d2]));
    expect(db.row(d1)!.merged_into_id).toBe(d2);
  });

  it('RLS: other tenants invisible, foreign tenant_id on INSERT -> 42501, DELETE -> 42501', { timeout: T }, async () => {
    const db = makeDoctorsDb({ rows: { doctors: [doc(1, TENANT_B)] } });
    expect((await db.run((c) => c.tx.query('SELECT * FROM catalog.doctors', []))).rows).toHaveLength(0);
    expect(await code(db.run((c) => c.tx.query(...insD(ID(2), 'DR1', { tenant: TENANT_B }))))).toBe('42501');
    expect(await code(db.run((c) => c.tx.query('DELETE FROM catalog.doctors WHERE id = $1', [ID(3)])))).toBe('42501');
  });

  it('code_counters: ON CONFLICT DO NOTHING then UPDATE … RETURNING; upsert DO UPDATE returns the updated row; CHECKs; per-tenant rows', { timeout: T }, async () => {
    const db = makeDoctorsDb({ catalog: seedState });
    const ins = (tenant = TENANT_A) => ['INSERT INTO catalog.code_counters (tenant_id, counter_key, created_by) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, counter_key) DO NOTHING', [tenant, 'doctor_code', USER]] as const;
    await db.run((c) => c.tx.query(...ins()));
    await db.run((c) => c.tx.query(...ins()));
    expect(db.counter()).toBe(1);
    const bump = () => db.run(async (c) => (await c.tx.query('UPDATE catalog.code_counters SET next_value = next_value + 1, updated_at = now() WHERE tenant_id = $1 AND counter_key = $2 RETURNING next_value', [TENANT_A, 'doctor_code'])).rows[0]!.next_value);
    expect(await bump()).toBe(2);
    const up = await db.run((c) => c.tx.query('INSERT INTO catalog.code_counters (tenant_id, counter_key, created_by) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, counter_key) DO UPDATE SET next_value = code_counters.next_value + 1 RETURNING next_value', [TENANT_A, 'doctor_code', USER]));
    expect(up.rows[0]!.next_value).toBe(3);
    expect(db.counter()).toBe(3);
    expect(db.counter(TENANT_B)).toBeUndefined();
    expect(await code(db.run((c) => c.tx.query('INSERT INTO catalog.code_counters (tenant_id, counter_key, created_by) VALUES ($1, $2, $3)', [TENANT_A, 'other', USER])))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.code_counters SET next_value = 0 WHERE tenant_id = $1', [TENANT_A])))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query('INSERT INTO catalog.code_counters (tenant_id, counter_key, created_by) VALUES ($1, $2, $3)', [TENANT_A, 'doctor_code', USER])))).toBe('23505');
  });

  it('the counter row lock serialises concurrent read-then-update: no duplicate value is handed out', { timeout: T }, async () => {
    const db = makeDoctorsDb({ catalog: seedState, rows: { code_counters: [ctr(TENANT_A, 1)] } });
    const take = () => db.run(async (c) => {
      const cur = (await c.tx.query('SELECT next_value FROM catalog.code_counters WHERE tenant_id = $1 AND counter_key = $2 FOR UPDATE', [TENANT_A, 'doctor_code'])).rows[0]!.next_value as number;
      await c.tx.query('UPDATE catalog.code_counters SET next_value = $3 WHERE tenant_id = $1 AND counter_key = $2', [TENANT_A, 'doctor_code', cur + 1]);
      return cur;
    });
    expect((await Promise.all([take(), take(), take(), take()])).sort()).toEqual([1, 2, 3, 4]);
    expect(db.counter()).toBe(5);
  });

  it('LIKE/ILIKE are evaluated for real: % and _ are wildcards unless escaped (default escape \\ ; ESCAPE honoured); lower(col) LIKE; NOT LIKE; binds and literals', { timeout: T }, async () => {
    const names = ['100% pure', '100x pure', 'a_b', 'axb', 'back\\slash', 'Plain'];
    const db = makeDoctorsDb({ rows: { doctors: names.map((n, i) => doc(i + 1, TENANT_A, { display_name: n, name_normalised: n })) } });
    const q = async (sql: string, v: unknown[]) => (await db.run((c) => c.tx.query(sql, v))).rows.map((r) => r.name_normalised).sort();
    const S = 'SELECT name_normalised FROM catalog.doctors WHERE tenant_id = $1 AND ';
    expect(await q(`${S}name_normalised LIKE $2`, [TENANT_A, '%100%%'])).toEqual(['100% pure', '100x pure']);          // unescaped % is a wildcard
    expect(await q(`${S}name_normalised LIKE $2 ESCAPE '!'`, [TENANT_A, '%100!%%'])).toEqual(['100% pure']);           // escaped %
    expect(await q(`${S}name_normalised LIKE $2`, [TENANT_A, '%\\%%'])).toEqual(['100% pure']);                          // default backslash escape
    expect(await q(`${S}name_normalised LIKE $2`, [TENANT_A, '%a_b%'])).toEqual(['a_b', 'axb']);
    expect(await q(`${S}name_normalised LIKE $2`, [TENANT_A, '%a\\_b%'])).toEqual(['a_b']);
    expect(await q(`${S}name_normalised LIKE $2`, [TENANT_A, '%\\\\%'])).toEqual(['back\\slash']);
    expect(await q(`${S}lower(name_normalised) LIKE 'plain%'`, [TENANT_A])).toEqual(['Plain']);        // lower(col) is what the pattern is matched against
    expect(await q(`${S}name_normalised ILIKE 'PLAIN'`, [TENANT_A])).toEqual(['Plain']);
    expect(await q(`${S}name_normalised NOT LIKE '%x%' AND name_normalised LIKE 'a%'`, [TENANT_A])).toEqual(['a_b']);
  });

  it('ISO-string binds compare as timestamps; `run({at})` fixes ctx.now(), startedAt and SQL now(); writes are private until COMMIT; row lock re-evaluates WHERE', { timeout: T }, async () => {
    const early = new Date(Date.UTC(2026, 0, 1)); const late = new Date(Date.UTC(2026, 6, 1));
    const db = makeDoctorsDb({ catalog: seedState, rows: { doctors: [doc(1, TENANT_A, { created_at: early }), doc(2, TENANT_A, { created_at: late })] } });
    const after = await db.run((c) => c.tx.query('SELECT id FROM catalog.doctors WHERE created_at > $1', [new Date(Date.UTC(2026, 3, 1)).toISOString()]));
    expect(after.rows.map((r) => r.id)).toEqual([doc(2, TENANT_A).id]);
    const at = new Date(Date.UTC(2027, 0, 2, 3, 4, 5));
    await db.run(async (c) => {
      expect(c.now()).toBe(at.toISOString());
      expect((c.tx as any).startedAt).toEqual(at);
      await c.tx.query('UPDATE catalog.doctors SET updated_at = now() WHERE id = $1', [doc(1, TENANT_A).id]);
    }, { at });
    expect(db.row(doc(1, TENANT_A).id)!.updated_at).toEqual(at);
    await code(db.run((c) => c.tx.query('UPDATE catalog.doctors SET notes = $1 WHERE id = $2', ['gone', doc(1, TENANT_A).id]), { rollback: true }));
    expect(db.row(doc(1, TENANT_A).id)!.notes).toBeNull();
    const id = doc(1, TENANT_A).id;
    const bump = () => db.run(async (c) => (await c.tx.query('UPDATE catalog.doctors SET version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *', [TENANT_A, id, 1])).rows.length);
    expect((await Promise.all([bump(), bump()])).sort()).toEqual([0, 1]);
  });

  it('actorIdentity: getActor exposes the permissions, assertRole throws auth.forbidden without one; normName follows the documented rule; seed ids are distinct', async () => {
    const id = actorIdentity(['catalog.referrer.read']);
    expect((await id.getActor({})).permissions).toEqual(['catalog.referrer.read']);
    await expect(id.assertRole({}, { permission: 'catalog.referrer.manage' })).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(normName('  Dr   Café  TEST ')).toBe('dr café test');
    expect(new Set([doc(1, TENANT_A).id, doc(2, TENANT_A).id, doc(1, TENANT_B).id]).size).toBe(2);   // same n + different tenant = same id: use distinct n across tenants
    expect(STARTED_AT).toBeInstanceOf(Date);
  });
});
