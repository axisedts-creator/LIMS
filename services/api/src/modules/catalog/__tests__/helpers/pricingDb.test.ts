// T-17 (C3) — self-check of the fake in pricingDb.ts (a red service test must mean a red service, not a lying fake). Passes without any implementation.
import { describe, expect, it } from 'vitest';
import { ROOT_A, TENANT_A, TENANT_B, USER } from './catalogDb.js';
import { ID, type Row } from './mastersDb.js';
import { centre, defaultList, doc, makePricingDb, orderable, party, passign, pitem, plist, pver } from './pricingDb.js';

const T = 20_000;
const A = TENANT_A;
const B = TENANT_B;
const seedState = { state: { [A]: { rootId: ROOT_A, revision: 5 } } };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return (e.code ?? e.message) as string; } return 'none'; };
const q = (db: ReturnType<typeof makePricingDb>, text: string, values: unknown[] = [], tenantId = A) => db.run((c) => c.tx.query(text, values), { tenantId });
const L1 = plist(1, A);
const L2 = plist(2, A);
const D1 = defaultList(3, A);
const O1 = orderable(1, A);
const mk = (rows: Record<string, Row[]> = {}) => makePricingDb({ catalog: seedState, rows: { orderables: [O1], collection_centres: [centre(1, A), centre(2, A), centre(9, B)], credit_parties: [party(1, A)], ...rows } as never });
const insList = (id: string, c: string, kind = 'credit_party', tenant = A, extra = '') =>
  [`INSERT INTO catalog.price_lists (id, tenant_id, code, name, owner_kind, created_by, updated_by) VALUES ($1, $2, $3, 'n', $4, $5, $5)${extra}`, [id, tenant, c, kind, USER]] as const;
const insVer = (id: string, listId: string, no: number, status = 'draft') =>
  ['INSERT INTO catalog.price_list_versions (id, tenant_id, price_list_id, version_no, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [id, A, listId, no, status, USER]] as const;

describe('pricingDb fake', () => {
  it('price_lists: UNIQUE code, one default per tenant, default must be active, CHECKs, defaults', { timeout: T }, async () => {
    const db = mk({ price_lists: [L1] });
    expect(await code(q(db, ...insList(ID(1), 'PL1')))).toBe('23505');
    expect(await code(q(db, ...insList(ID(2), 'NEW1')))).toBe('none');
    expect(db.row('price_lists', ID(2))).toMatchObject({ version: 1, is_active: true, falls_through: true });
    expect(await code(q(db, ...insList(ID(3), 'DEF1', 'default')))).toBe('none');
    expect(await code(q(db, ...insList(ID(4), 'DEF2', 'default')))).toBe('23505');                       // price_lists__tenant_id__default__p_uq
    expect(await code(q(db, ...insList(ID(5), 'DEF3', 'credit_party', B)))).toBe('42501');                 // foreign tenant_id from a tenant-A tx (RLS)
    expect(await code(q(db, ...insList(ID(6), 'low')))).toBe('23514');
    expect(await code(q(db, ...insList(ID(7), 'X'.repeat(33))))).toBe('23514');
    expect(await code(q(db, ...insList(ID(8), 'OK8', 'vendor')))).toBe('23514');
    expect(await code(q(db, 'UPDATE catalog.price_lists SET is_active = $3 WHERE tenant_id = $1 AND id = $2', [A, ID(3), false]))).toBe('23514');   // default_active__ck
    expect(await code(q(db, 'DELETE FROM catalog.price_lists WHERE id = $1', [ID(2)]))).toBe('42501');
  });

  it('versions: one draft per list, version_no unique, published needs its fields, FK to list', { timeout: T }, async () => {
    const db = mk({ price_lists: [L1] });
    expect(await code(q(db, ...insVer(ID(11), L1.id as string, 1)))).toBe('none');
    expect(await code(q(db, ...insVer(ID(12), L1.id as string, 2)))).toBe('23505');                         // second draft
    expect(await code(q(db, ...insVer(ID(13), L1.id as string, 1, 'discarded')))).toBe('23505');          // version_no
    expect(await code(q(db, ...insVer(ID(14), L1.id as string, 3, 'published')))).toBe('23514');          // published_fields
    expect(await code(q(db, ...insVer(ID(15), ID(0x999), 1)))).toBe('23503');
  });

  it('TRIGGERS: non-draft version is frozen except status/effective_to/…; transitions; items only while the parent is draft', { timeout: T }, async () => {
    const pub = pver(1, A, L1.id as string, 1, { status: 'published' });
    const dr = pver(2, A, L1.id as string, 2);
    const db = mk({ price_lists: [L1], price_list_versions: [pub, dr], price_list_items: [pitem(1, A, pub.id as string, O1.id as string, 5000)] });
    const upd = (id: string, set: string, v: unknown[]) => q(db, `UPDATE catalog.price_list_versions SET ${set} WHERE tenant_id = $1 AND id = $2`, [A, id, ...v]);
    expect(await code(upd(pub.id as string, 'change_reason = $3', ['tamper']))).toBe('P0001');
    expect(await code(upd(pub.id as string, 'effective_from = $3', ['2026-02-01T00:00:00.000Z']))).toBe('P0001');
    expect(await code(upd(pub.id as string, 'status = $3, effective_to = $4, version = version + 1', ['superseded', '2026-03-01T00:00:00.000Z']))).toBe('none');
    expect(await code(upd(pub.id as string, 'status = $3', ['published']))).toBe('P0001');                    // superseded -> published
    expect(await code(upd(dr.id as string, 'status = $3', ['retired']))).toBe('P0001');
    expect(await code(upd(dr.id as string, 'status = $3', ['superseded']))).toBe('P0001');                    // draft -> superseded
    const item = (v: string) => q(db, 'INSERT INTO catalog.price_list_items (id, tenant_id, price_list_version_id, orderable_id, unit_price_paisa, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [ID(0x50 + Math.floor(Math.random() * 1e6)), A, v, O1.id, 100, USER]);
    expect(await code(item(pub.id as string))).toBe('P0001');
    expect(await code(item(dr.id as string))).toBe('none');
    expect(await code(q(db, 'UPDATE catalog.price_list_items SET unit_price_paisa = $3 WHERE tenant_id = $1 AND price_list_version_id = $2', [A, pub.id, 1]))).toBe('P0001');
    expect(await code(q(db, 'DELETE FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [A, pub.id]))).toBe('P0001');
    expect(await code(q(db, 'DELETE FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [A, dr.id]))).toBe('none');
    expect(db.rows('price_list_items').map((r) => r.price_list_version_id)).toEqual([pub.id]);
  });

  it('items: price 0..999999999, UNIQUE (version, orderable), FK orderable (tenant-B orderable -> 23503)', { timeout: T }, async () => {
    const dr = pver(2, A, L1.id as string, 1);
    const OB = orderable(2, B);
    const db = mk({ price_lists: [L1], price_list_versions: [dr], orderables: [O1, OB] });
    const ins = (id: string, ord: string, p: number) => q(db, 'INSERT INTO catalog.price_list_items (id, tenant_id, price_list_version_id, orderable_id, unit_price_paisa, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [id, A, dr.id, ord, p, USER]);
    expect(await code(ins(ID(0x61), O1.id as string, 999_999_999))).toBe('none');
    expect(await code(ins(ID(0x62), O1.id as string, 1))).toBe('23505');
    expect(await code(ins(ID(0x63), ID(0x7777), 1))).toBe('23503');
    expect(await code(ins(ID(0x64), OB.id as string, 1))).toBe('23503');
    for (const p of [-1, 1_000_000_000]) expect(await code(ins(ID(0x65), O1.id as string, p))).toBe('23514');
  });

  it('assignments: composite FKs (list+owner_kind, doctor, party, centre — tenant-B ids fail 23503), one owner column, one list per owner, DELETE allowed', { timeout: T }, async () => {
    const X = doc(1, A, { doctor_code: 'DRX1' });
    const XB = doc(2, B, { doctor_code: 'DRB1' });
    const db = mk({ price_lists: [L1, L2, plist(4, A, { owner_kind: 'referrer', code: 'PLR' }), plist(5, A, { owner_kind: 'centre', code: 'PLC' })], doctors: [X, XB] });
    const ins = (id: string, list: string, kind: string, col: string, owner: unknown) =>
      q(db, `INSERT INTO catalog.price_list_assignments (id, tenant_id, price_list_id, owner_kind, ${col}, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [id, A, list, kind, owner, USER]);
    const R = ID(0xa04); const C = ID(0xa05);
    expect(await code(ins(ID(0x71), R, 'referrer', 'doctor_id', X.id))).toBe('none');
    expect(await code(ins(ID(0x72), R, 'referrer', 'doctor_id', XB.id))).toBe('23503');                      // tenant-B doctor
    expect(await code(ins(ID(0x73), C, 'centre', 'centre_id', centre(9, B).id))).toBe('23503');             // tenant-B centre
    expect(await code(ins(ID(0x74), C, 'centre', 'centre_id', centre(1, A).id))).toBe('none');
    expect(await code(ins(ID(0x75), L1.id as string, 'credit_party', 'credit_party_id', party(1, A).id))).toBe('none');
    expect(await code(ins(ID(0x76), L2.id as string, 'credit_party', 'credit_party_id', party(1, A).id))).toBe('23505');   // second list for the party
    expect(await code(ins(ID(0x77), R, 'centre', 'centre_id', centre(2, A).id))).toBe('23503');             // owner_kind differs from the list's
    expect(await code(ins(ID(0x78), R, 'referrer', 'centre_id', centre(2, A).id))).toBe('23514');           // one_owner__ck
    expect(await code(q(db, 'DELETE FROM catalog.price_list_assignments WHERE tenant_id = $1 AND doctor_id = $2', [A, X.id]))).toBe('none');
    expect(db.rows('price_list_assignments').some((r) => r.doctor_id === X.id)).toBe(false);
  });

  it('RLS: other tenants invisible; rolled-back writes vanish; doctors table is writable (merge)', { timeout: T }, async () => {
    const db = mk({ price_lists: [plist(1, B)], doctors: [doc(1, A, { doctor_code: 'DRX1' })] });
    expect((await q(db, 'SELECT * FROM catalog.price_lists')).rows).toHaveLength(0);
    await expect(db.run((c) => c.tx.query(...insList(ID(1), 'RB1')), { rollback: true })).rejects.toThrow('forced rollback');
    expect(db.rows('price_lists', A)).toHaveLength(0);
    expect(await code(q(db, 'UPDATE catalog.doctors SET is_active = $3, merged_into_id = $4, version = version + 1 WHERE tenant_id = $1 AND id = $2', [A, doc(1, A).id, false, doc(1, A).id]))).toBe('23514');
  });

  it('write lock per (table, tenant): FOR UPDATE on the list serialises two writers', { timeout: T }, async () => {
    const db = mk({ price_lists: [L1] });
    const order: string[] = [];
    const w = (tag: string) => db.run(async (c) => {
      await c.tx.query('SELECT id FROM catalog.price_lists WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [A, L1.id]);
      order.push(`${tag}+`); await new Promise((r) => setTimeout(r, 10)); order.push(`${tag}-`);
    });
    await Promise.all([w('a'), w('b')]);
    expect(order[0]![0]).toBe(order[1]![0]);
    expect(order.join(',')).toMatch(/^(a\+,a-,b\+,b-|b\+,b-,a\+,a-)$/);
  });
});
