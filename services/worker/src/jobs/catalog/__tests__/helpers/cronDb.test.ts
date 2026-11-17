// T-26 (C3): self-test of the cronDb fake (so a red task test is never the fake's fault). Synthetic data only.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, ago, ahead, makeCronDb, uid } from './cronRunner.js';

const q = (db: ReturnType<typeof makeCronDb>, tenant: string, sql: string, v: unknown[] = []) => db.run((c) => c.tx.query(sql, v), { tenantId: tenant });

describe('cronDb fake', () => {
  it('DELETE … RETURNING removes only matching rows of the tx tenant, and only on COMMIT', async () => {
    const db = makeCronDb();
    const a = db.seed.file(TENANT_A, { id: uid(1), expires_at: ago(1000) });
    db.seed.file(TENANT_A, { id: uid(2), expires_at: ahead(1000) });
    db.seed.file(TENANT_B, { id: uid(3), expires_at: ago(1000) });
    await expect(db.run(async (c) => { await c.tx.query('DELETE FROM catalog.files WHERE expires_at < now()'); throw new Error('boom'); }, { tenantId: TENANT_A })).rejects.toThrow('boom');
    expect(db.rows('files')).toHaveLength(3);
    const r = await q(db, TENANT_A, 'DELETE FROM catalog.files WHERE expires_at < now() RETURNING id');
    expect(r.rows).toEqual([{ id: a.id }]);
    expect(db.rows('files').map((f) => f.id).sort()).toEqual([uid(2), uid(3)]);
  });

  it('DELETE is refused on tables other than files / import_issues', async () => {
    const db = makeCronDb();
    db.seed.import(TENANT_A, { id: uid(1) });
    await expect(q(db, TENANT_A, 'DELETE FROM catalog.imports WHERE id = $1', [uid(1)])).rejects.toMatchObject({ code: '42501' });
    await expect(q(db, TENANT_A, 'DELETE FROM catalog.catalog_state WHERE tenant_id = $1', [TENANT_A])).rejects.toMatchObject({ code: '42501' });
  });

  it('UPDATE … = ANY($1::uuid[]) sets NULL; IN (…) and < now() filters work; other tenants stay untouched', async () => {
    const db = makeCronDb();
    db.seed.import(TENANT_A, { id: uid(1), status: 'validated', upload_file_id: uid(50), expires_at: ago(5) });
    db.seed.import(TENANT_A, { id: uid(2), status: 'committed', upload_file_id: uid(51), expires_at: ago(5) });
    db.seed.import(TENANT_B, { id: uid(3), status: 'validated', upload_file_id: uid(52), expires_at: ago(5) });
    await q(db, TENANT_A, 'UPDATE catalog.imports SET upload_file_id = NULL WHERE upload_file_id = ANY($1::uuid[])', [[uid(50), uid(52)]]);
    await q(db, TENANT_A, "UPDATE catalog.imports SET status = 'expired' WHERE status IN ('validated', 'invalid') AND expires_at < now()");
    const s = (id: string) => db.rows('imports').find((r) => r.id === id)!;
    expect(s(uid(1))).toMatchObject({ upload_file_id: null, status: 'expired' });
    expect(s(uid(2))).toMatchObject({ upload_file_id: uid(51), status: 'committed' });
    expect(s(uid(3))).toMatchObject({ upload_file_id: uid(52), status: 'validated' });
  });

  it('catalog_state: increment RETURNING (bigint as string), ON CONFLICT DO NOTHING, g_reference_release visible to all tenants', async () => {
    const db = makeCronDb();
    db.seed.release(4);
    db.seed.catalogState(TENANT_A, { catalog_revision: 7 });
    const up = await q(db, TENANT_A, 'UPDATE catalog.catalog_state SET catalog_revision = catalog_revision + 1, updated_at = now() WHERE tenant_id = $1 RETURNING catalog_revision, catalog_root_id', [TENANT_A]);
    expect(up.rows[0]!.catalog_revision).toBe('8');
    await q(db, TENANT_A, 'INSERT INTO catalog.catalog_state (tenant_id, catalog_root_id, created_by) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO NOTHING', [TENANT_A, uid(9), uid(8)]);
    expect(db.rows('catalog_state')).toHaveLength(1);
    await q(db, TENANT_B, 'INSERT INTO catalog.catalog_state (tenant_id, catalog_root_id, created_by) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO NOTHING', [TENANT_B, uid(9), uid(8)]);
    expect(db.rows('catalog_state', TENANT_B)[0]).toMatchObject({ catalog_revision: 0, global_release_seen: 0 });
    for (const t of [TENANT_A, TENANT_B]) expect((await q(db, t, 'SELECT release_no FROM catalog.g_reference_release WHERE id = 1')).rows).toEqual([{ release_no: 4 }]);
    await expect(q(db, TENANT_A, 'UPDATE catalog.g_reference_release SET release_no = 5 WHERE id = 1')).rejects.toMatchObject({ code: '42501' });
  });

  it('import_issues composite key: duplicate (tenant, import, seq) -> 23505', async () => {
    const db = makeCronDb();
    db.seed.issue(TENANT_A, uid(1), 1);
    const ins = (seq: number) => q(db, TENANT_A, "INSERT INTO catalog.import_issues (tenant_id, import_id, seq, severity, sheet, issue_code, message, created_by, expires_at) VALUES ($1, $2, $3, 'error', 'Tests', 'row.code_invalid', 'm', $4, now())", [TENANT_A, uid(1), seq, uid(8)]);
    await expect(ins(1)).rejects.toMatchObject({ code: '23505' });
    await expect(ins(2)).resolves.toBeDefined();
  });
});
