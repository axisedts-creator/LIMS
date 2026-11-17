// T-13 (C3) — self-check of the fake in commentsDb.ts (so a red service test means a red service, not a lying fake). Passes without any implementation.
import { describe, expect, it } from 'vitest';
import { ROOT_A, STARTED_AT, TENANT_A, TENANT_B, USER } from './catalogDb.js';
import { cc, ccText, dept, makeCommentsDb } from './commentsDb.js';
import { ID } from './mastersDb.js';

const T = 20_000;
const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 5 } } };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'none'; };
const HAEM = dept(1, TENANT_A, { code: 'HAEM' });
const insC = (id: string, c: string, department: string | null, tenant = TENANT_A, text = 'x') => ['INSERT INTO catalog.comment_codes (id, tenant_id, code, department_id, text, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *', [id, tenant, c, department, text, USER]] as const;
const insT = (id: string, codeId: string, v: number, from: Date, tenant = TENANT_A) => ['INSERT INTO catalog.comment_code_texts (id, tenant_id, comment_code_id, text_version, text, effective_from, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)', [id, tenant, codeId, v, `t${v}`, from, USER]] as const;

describe('commentsDb fake', () => {
  it('EXPRESSION unique index: two tenant-wide rows with one code collide (NULL department is coalesced), dept + tenant-wide and two depts do not', { timeout: T }, async () => {
    const BIO = dept(2, TENANT_A, { code: 'BIOCHEM' });
    const db = makeCommentsDb({ catalog: seedState, departments: [HAEM, BIO] });
    await db.run((c) => c.tx.query(...insC(ID(1), 'HYPO', null)));
    expect(await code(db.run((c) => c.tx.query(...insC(ID(2), 'HYPO', null))))).toBe('23505');
    expect(await code(db.run((c) => c.tx.query(...insC(ID(3), 'HYPO', HAEM.id))))).toBe('none');
    expect(await code(db.run((c) => c.tx.query(...insC(ID(4), 'HYPO', BIO.id))))).toBe('none');
    expect(await code(db.run((c) => c.tx.query(...insC(ID(5), 'HYPO', HAEM.id))))).toBe('23505');
    expect(db.rows('comment_codes')).toHaveLength(3);
  });

  it('an UPDATE that moves a row onto an existing (code, department) is a 23505; CHECKs 23514; NOT NULL 23502; FK to departments 23503', { timeout: T }, async () => {
    const db = makeCommentsDb({ departments: [HAEM], rows: { comment_codes: [cc(1, TENANT_A, { code: 'A' }), cc(2, TENANT_A, { code: 'B' })] } });
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.comment_codes SET code = $1 WHERE id = $2', ['A', cc(2, TENANT_A).id])))).toBe('23505');
    expect(await code(db.run((c) => c.tx.query(...insC(ID(7), 'lower', null))))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query(...insC(ID(8), 'X'.repeat(17), null))))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query(...insC(ID(9), 'OK1', null, TENANT_A, ''))))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query(...insC(ID(10), 'OK2', null, TENANT_A, 'x'.repeat(2001)))))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query(...insC(ID(11), 'OK3', null, TENANT_A, 'x'.repeat(2000)))))).toBe('none');
    expect(await code(db.run((c) => c.tx.query('INSERT INTO catalog.comment_codes (id, tenant_id, code, text, updated_by) VALUES ($1, $2, $3, $4, $5)', [ID(12), TENANT_A, 'OK4', 'x', USER])))).toBe('23502');
    expect(await code(db.run((c) => c.tx.query(...insC(ID(13), 'OK5', ID(0xdead)))))).toBe('23503');
  });

  it('RLS: other tenants invisible (the same code is free in another tenant), foreign tenant_id on INSERT -> 42501, DELETE -> 42501', { timeout: T }, async () => {
    const db = makeCommentsDb({ rows: { comment_codes: [cc(1, TENANT_B, { code: 'HYPO' })] } });
    expect((await db.run((c) => c.tx.query('SELECT * FROM catalog.comment_codes', []))).rows).toHaveLength(0);
    expect(await code(db.run((c) => c.tx.query(...insC(ID(2), 'HYPO', null, TENANT_B))))).toBe('42501');
    expect(await code(db.run((c) => c.tx.query(...insC(ID(3), 'HYPO', null))))).toBe('none');
    expect(await code(db.run((c) => c.tx.query('DELETE FROM catalog.comment_codes WHERE id = $1', [ID(3)])))).toBe('42501');
  });

  it('text history: FK to comment_codes (23503), UNIQUE(code id, effective_from) (23505), window CHECK (23514), version CHECK; ISO-string binds become Date', { timeout: T }, async () => {
    const row = cc(1, TENANT_A);
    const db = makeCommentsDb({ rows: { comment_codes: [row] } });
    const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, s));
    expect(await code(db.run((c) => c.tx.query(...insT(ID(1), ID(0xdead), 1, at(0)))))).toBe('23503');
    expect(await code(db.run((c) => c.tx.query(...insT(ID(2), row.id, 1, at(0)))))).toBe('none');
    expect(await code(db.run((c) => c.tx.query(...insT(ID(3), row.id, 2, at(0)))))).toBe('23505');
    expect(await code(db.run((c) => c.tx.query(...insT(ID(4), row.id, 0, at(5)))))).toBe('23514');
    expect(await code(db.run((c) => c.tx.query('INSERT INTO catalog.comment_code_texts (id, tenant_id, comment_code_id, text_version, text, effective_from, effective_to, created_by, updated_by) VALUES ($1, $2, $3, 2, $4, $5, $6, $7, $7)', [ID(5), TENANT_A, row.id, 't', at(9), at(8), USER])))).toBe('23514');
    await db.run((c) => c.tx.query(...insT(ID(6), row.id, 2, at(10).toISOString() as never)));
    expect(db.row('comment_code_texts', ID(6))!.effective_from).toEqual(at(10));
  });

  it('trigger comment_code_texts__mutable_columns: only effective_to/updated_at/updated_by/version may change (P0001), closing a window works', { timeout: T }, async () => {
    const row = cc(1, TENANT_A);
    const db = makeCommentsDb({ rows: { comment_codes: [row], comment_code_texts: [ccText(1, row.id, TENANT_A)] } });
    const t = ccText(1, row.id, TENANT_A);
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.comment_code_texts SET text = $1 WHERE id = $2', ['rewritten', t.id])))).toBe('P0001');
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.comment_code_texts SET effective_from = $1 WHERE id = $2', [new Date(0), t.id])))).toBe('P0001');
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.comment_code_texts SET text_version = 9 WHERE id = $1', [t.id])))).toBe('P0001');
    const end = new Date(STARTED_AT.getTime() + 1000);
    expect(await code(db.run((c) => c.tx.query('UPDATE catalog.comment_code_texts SET effective_to = $1, updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $3 AND tenant_id = $4', [end, USER, t.id, TENANT_A])))).toBe('none');
    expect(db.row('comment_code_texts', t.id)).toMatchObject({ text: t.text, effective_to: end, version: 2 });
  });

  it('`run({at})` fixes SQL now(), ctx.now() and facade.startedAt; writes are private until COMMIT; row lock serialises UPDATEs and re-evaluates WHERE', { timeout: T }, async () => {
    const row = cc(1, TENANT_A);
    const db = makeCommentsDb({ catalog: seedState, rows: { comment_codes: [row] } });
    const at = new Date(Date.UTC(2027, 0, 2, 3, 4, 5));
    await db.run(async (c) => {
      expect(c.now()).toBe(at.toISOString());
      expect((c.tx as any).startedAt).toEqual(at);
      await c.tx.query('UPDATE catalog.comment_codes SET updated_at = now() WHERE id = $1', [row.id]);
    }, { at });
    expect(db.row('comment_codes', row.id)!.updated_at).toEqual(at);
    await code(db.run((c) => c.tx.query('UPDATE catalog.comment_codes SET text = $1 WHERE id = $2', ['gone', row.id]), { rollback: true }));
    expect(db.row('comment_codes', row.id)!.text).toBe(row.text);
    const bump = () => db.run(async (c) => (await c.tx.query('UPDATE catalog.comment_codes SET version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *', [TENANT_A, row.id, 1])).rows.length);
    expect((await Promise.all([bump(), bump()])).sort()).toEqual([0, 1]);
    expect(db.row('comment_codes', row.id)!.version).toBe(2);
  });

  it('seed factories give distinct ids', () => {
    const ids = [cc(1, TENANT_A).id, cc(2, TENANT_A).id, ccText(1, ID(1), TENANT_A).id, ccText(2, ID(1), TENANT_A).id, dept(1, TENANT_A).id];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
