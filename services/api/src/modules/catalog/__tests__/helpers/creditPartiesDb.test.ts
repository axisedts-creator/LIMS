// T-16 (C3) — self-check of the fake in creditPartiesDb.ts (so a red service test means a red service, not a lying fake). Passes without any implementation.
import { describe, expect, it } from 'vitest';
import { ROOT_A, TENANT_A, TENANT_B, USER } from './catalogDb.js';
import { actorIdentity, cp, ctr, makeCreditPartiesDb } from './creditPartiesDb.js';
import { ID } from './mastersDb.js';

const T = 20_000;
const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 5 } } };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'none'; };
const ins = (id: string, c: string, o: { tenant?: string; name?: string; kind?: string; pan?: string | null; phone?: string | null; email?: string | null; addr?: string | null } = {}) =>
  ['INSERT INTO catalog.credit_parties (id, tenant_id, party_code, name, kind, pan, contact_phone_e164, contact_email, billing_address, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING *',
    [id, o.tenant ?? TENANT_A, c, o.name ?? 'Synthetic Hospital', o.kind ?? 'hospital', o.pan ?? null, o.phone ?? null, o.email ?? null, o.addr ?? null, USER]] as const;

describe('creditPartiesDb fake', () => {
  it('UNIQUE(tenant, party_code) -> 23505 (per tenant); PK; defaults (version 1, is_active, allows_credit true); CHECKs 23514; NOT NULL 23502', { timeout: T }, async () => {
    const db = makeCreditPartiesDb({ catalog: seedState });
    expect(await code(db.run((c) => c.tx.query(...ins(ID(1), 'CP1'))))).toBe('none');
    expect(db.row(ID(1))).toMatchObject({ version: 1, is_active: true, allows_credit: true, created_by: USER, pan: null });
    expect(await code(db.run((c) => c.tx.query(...ins(ID(2), 'CP1'))))).toBe('23505');
    expect(await code(db.run((c) => c.tx.query(...ins(ID(1), 'CP2'))))).toBe('23505');
    expect(await code(db.run((c) => c.tx.query(...ins(ID(3), 'CP1', { tenant: TENANT_B })), { tenantId: TENANT_B }))).toBe('none');
    for (const [c, o] of [['lower', {}], ['X'.repeat(21), {}], ['A B', {}], ['OK1', { name: '' }], ['OK2', { name: 'x'.repeat(161) }], ['OK3', { kind: 'bank' }], ['OK4', { pan: 'p'.repeat(21) }],
      ['OK5', { phone: '12345678' }], ['OK6', { phone: '+0123456789' }], ['OK7', { email: 'e'.repeat(255) }], ['OK8', { addr: 'a'.repeat(501) }]] as const) {
      expect(await code(db.run((x) => x.tx.query(...ins(ID(9), c, o)))), c).toBe('23514');
    }
    expect(await code(db.run((x) => x.tx.query('INSERT INTO catalog.credit_parties (id, tenant_id, party_code, name, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)', [ID(8), TENANT_A, 'OK9', 'n', USER])))).toBe('23502');
    expect(await code(db.run((x) => x.tx.query(...ins(ID(7), 'OK10', { name: 'n'.repeat(160), pan: 'p'.repeat(20), phone: '+97798000001', addr: 'a'.repeat(500) }))))).toBe('none');
  });

  it('RLS: other tenants invisible, foreign tenant_id on INSERT -> 42501, DELETE -> 42501, price-list tables are not modelled', { timeout: T }, async () => {
    const db = makeCreditPartiesDb({ rows: { credit_parties: [cp(1, TENANT_B)] } });
    expect((await db.run((c) => c.tx.query('SELECT * FROM catalog.credit_parties', []))).rows).toHaveLength(0);
    expect(await code(db.run((c) => c.tx.query(...ins(ID(2), 'CP1', { tenant: TENANT_B }))))).toBe('42501');
    expect(await code(db.run((c) => c.tx.query('DELETE FROM catalog.credit_parties WHERE id = $1', [ID(3)])))).toBe('42501');
    await expect(db.run((c) => c.tx.query('SELECT * FROM catalog.price_lists', []))).rejects.toThrow(/unsupported/);
  });

  it('code_counters: party_code key, ON CONFLICT DO NOTHING then UPDATE … RETURNING; row lock serialises read-then-update; per-tenant rows; CHECKs', { timeout: T }, async () => {
    const db = makeCreditPartiesDb({ catalog: seedState, rows: { code_counters: [ctr(TENANT_A, 1)] } });
    expect(db.counter()).toBe(1);
    const take = () => db.run(async (c) => {
      const cur = (await c.tx.query('SELECT next_value FROM catalog.code_counters WHERE tenant_id = $1 AND counter_key = $2 FOR UPDATE', [TENANT_A, 'party_code'])).rows[0]!.next_value as number;
      await c.tx.query('UPDATE catalog.code_counters SET next_value = $3 WHERE tenant_id = $1 AND counter_key = $2', [TENANT_A, 'party_code', cur + 1]);
      return cur;
    });
    expect((await Promise.all([take(), take(), take()])).sort()).toEqual([1, 2, 3]);
    expect(db.counter()).toBe(4);
    expect(db.counter(TENANT_B)).toBeUndefined();
    const lazy = ['INSERT INTO catalog.code_counters (tenant_id, counter_key, created_by) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, counter_key) DO NOTHING', [TENANT_B, 'party_code', USER]] as const;
    await db.run((c) => c.tx.query(...lazy), { tenantId: TENANT_B });
    await db.run((c) => c.tx.query(...lazy), { tenantId: TENANT_B });
    expect(db.counter(TENANT_B)).toBe(1);
    expect(await code(db.run((c) => c.tx.query('INSERT INTO catalog.code_counters (tenant_id, counter_key, created_by) VALUES ($1, $2, $3)', [TENANT_A, 'other', USER])))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.code_counters SET next_value = 0 WHERE tenant_id = $1', [TENANT_A])))).toBe('23514');
  });

  it('LIKE … ESCAPE is evaluated for real (an unescaped % or _ in a code-prefix search WILL act as a wildcard); optimistic UPDATE re-evaluates WHERE after the lock; `run({at})` fixes now()', { timeout: T }, async () => {
    const db = makeCreditPartiesDb({ catalog: seedState, rows: { credit_parties: [cp(1, TENANT_A, { party_code: 'A_B' }), cp(2, TENANT_A, { party_code: 'AXB' }), cp(3, TENANT_A, { party_code: 'A%B' })] } });
    const q = async (v: string) => (await db.run((c) => c.tx.query("SELECT party_code FROM catalog.credit_parties WHERE tenant_id = $1 AND party_code LIKE $2 ESCAPE '\\'", [TENANT_A, v]))).rows.map((r) => r.party_code).sort();
    expect(await q('A_%')).toEqual(['A%B', 'AXB', 'A_B']);
    expect(await q('A\\_%')).toEqual(['A_B']);
    expect(await q('A\\%%')).toEqual(['A%B']);
    const id = cp(1, TENANT_A).id;
    const bump = () => db.run(async (c) => (await c.tx.query('UPDATE catalog.credit_parties SET version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *', [TENANT_A, id, 1])).rows.length);
    expect((await Promise.all([bump(), bump()])).sort()).toEqual([0, 1]);
    const at = new Date(Date.UTC(2027, 0, 2, 3, 4, 5));
    await db.run((c) => c.tx.query('UPDATE catalog.credit_parties SET updated_at = now() WHERE id = $1', [id]), { at });
    expect(db.row(id)!.updated_at).toEqual(at);
  });

  it('actorIdentity: getActor exposes the permissions, assertRole throws auth.forbidden without one; seed ids are distinct', async () => {
    const id = actorIdentity(['catalog.price_list.read']);
    expect((await id.getActor({})).permissions).toEqual(['catalog.price_list.read']);
    await expect(id.assertRole({}, { permission: 'catalog.price_list.manage' })).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(new Set([cp(1, TENANT_A).id, cp(2, TENANT_A).id, cp(3, TENANT_B).id]).size).toBe(3);
  });
});
