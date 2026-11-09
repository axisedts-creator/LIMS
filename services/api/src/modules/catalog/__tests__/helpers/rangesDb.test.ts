// Self-check of the T-08 additions to helpers/testsDb.ts (range / critical-limit sets + bands): the fake must enforce what 05-SCHEMA enforces, otherwise the
// ranges.service tests would pass or fail for the wrong reason. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, USER } from './catalogDb.js';
import { rejection } from './t6.js';
import { CBC, FAMILIES, HB, ID, M1, draftSet, world8Db, type Row } from './t8db.js';
const setup8 = (s: Parameters<typeof world8Db>[0] = {}) => ({ db: world8Db(s) });

const SET_COLS = '(id, tenant_id, analyte_id, version_no, status, unit_code, method_id, created_by, updated_by)';
const insSet = (f: (typeof FAMILIES)[number], n: number, o: Row = {}) => ({
  text: `INSERT INTO catalog.${f.setTable} ${SET_COLS} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  values: [ID(0xa000 + n), TENANT_A, HB.id, o['version_no'] ?? 1, o['status'] ?? 'draft', 'g_dl', M1.id, USER, USER],
});
const insBand = (f: (typeof FAMILIES)[number], n: number, setId: string, o: Row = {}) => f.bandTable === 'reference_ranges'
  ? { text: 'INSERT INTO catalog.reference_ranges (id, tenant_id, set_id, sex, kind, low, high, sort_order, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      values: [ID(0xb000 + n), TENANT_A, setId, o['sex'] ?? 'any', 'numeric', o['low'] ?? '1.0', o['high'] ?? '2.0', 0, USER] }
  : { text: 'INSERT INTO catalog.critical_limits (id, tenant_id, set_id, sex, low, high, sort_order, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      values: [ID(0xb000 + n), TENANT_A, setId, o['sex'] ?? 'any', o['low'] ?? '1.0', o['high'] ?? '2.0', 0, USER] };

describe.each(FAMILIES)('fake $setTable / $bandTable', (f) => {
  it('a set and its bands insert in one tx, commit, and are visible to the same tenant only (RLS)', async () => {
    const e = setup8();
    await e.db.run(async (ctx) => {
      const s = insSet(f, 1); await ctx.tx.query(s.text, s.values);
      const b = insBand(f, 1, ID(0xa001)); await ctx.tx.query(b.text, b.values);
    });
    expect(e.db.rows(f.setTable)).toHaveLength(1); expect(e.db.rows(f.bandTable)).toHaveLength(1);
    const seenByB = await e.db.run((ctx) => ctx.tx.query(`SELECT id FROM catalog.${f.setTable} WHERE analyte_id = $1`, [HB.id]), { tenantId: TENANT_B });
    expect(seenByB.rows).toHaveLength(0);
  });

  it('an INSERT with another tenant\'s tenant_id raises 42501', async () => {
    const e = setup8(); const s = insSet(f, 1); s.values[1] = TENANT_B;
    expect((await rejection(e.db.run((ctx) => ctx.tx.query(s.text, s.values)))).code).toBe('42501');
  });

  it('UNIQUE (analyte, version_no) and one draft per analyte raise 23505; unknown analyte raises 23503', async () => {
    const e = setup8({ t6: { [f.setTable]: [draftSet(f.mkSet, 2, HB.id)] } as never });
    const dup = insSet(f, 5, { version_no: 2, status: 'discarded' });
    expect((await rejection(e.db.run((ctx) => ctx.tx.query(dup.text, dup.values)))).code).toBe('23505');
    const second = insSet(f, 6, { version_no: 3, status: 'draft' });
    expect((await rejection(e.db.run((ctx) => ctx.tx.query(second.text, second.values)))).code).toBe('23505');
    const orphan = insSet(f, 7, { version_no: 4 }); orphan.values[2] = ID(0xdead);
    expect((await rejection(e.db.run((ctx) => ctx.tx.query(orphan.text, orphan.values)))).code).toBe('23503');
  });

  it('band CHECKs: low > high and a numeric band with neither limit raise 23514; an unknown set raises P0001; another tenant\'s specimen type raises 23503', async () => {
    const e = setup8({ t6: { [f.setTable]: [draftSet(f.mkSet, 2, HB.id)] } as never });
    const setId = draftSet(f.mkSet, 2, HB.id).id as string;
    const run = (b: { text: string; values: unknown[] }) => rejection(e.db.run((ctx) => ctx.tx.query(b.text, b.values)));
    expect((await run(insBand(f, 1, setId, { low: '9', high: '3' }))).code).toBe('23514');
    expect((await run(insBand(f, 2, ID(0xdead)))).code).toBe('P0001');   // BEFORE trigger (parent not a draft) fires ahead of the FK check, as in Postgres
    const withSpecimen = insBand(f, 3, setId);
    expect((await rejection(e.db.run((ctx) => ctx.tx.query(withSpecimen.text.replace('sort_order, created_by)', 'sort_order, created_by, specimen_type_id)').replace(/\)$/, `, $${withSpecimen.values.length + 1})`), [...withSpecimen.values, ID(0x208)])))).code).toBe('23503');
  });

  it('parent-is-draft trigger: bands of a published / retired set cannot be inserted, updated or deleted (P0001); a draft\'s can', async () => {
    const e = setup8({ t6: { [f.setTable]: [f.mkSet(1, TENANT_A, HB.id), draftSet(f.mkSet, 2, HB.id)], [f.bandTable]: [f.mkBand(1, TENANT_A, f.mkSet(1, TENANT_A, HB.id).id as string, { low: '1', high: '2' }), f.mkBand(2, TENANT_A, draftSet(f.mkSet, 2, HB.id).id as string, { low: '1', high: '2' })] } as never });
    const pub = f.mkSet(1, TENANT_A, HB.id).id as string, dr = draftSet(f.mkSet, 2, HB.id).id as string;
    const q = (text: string, values: unknown[]) => e.db.run((ctx) => ctx.tx.query(text, values));
    const ins = insBand(f, 9, pub);
    expect((await rejection(q(ins.text, ins.values))).code).toBe('P0001');
    expect((await rejection(q(`UPDATE catalog.${f.bandTable} SET low = $1 WHERE tenant_id = $2 AND set_id = $3`, ['5', TENANT_A, pub]))).code).toBe('P0001');
    expect((await rejection(q(`DELETE FROM catalog.${f.bandTable} WHERE tenant_id = $1 AND set_id = $2`, [TENANT_A, pub]))).code).toBe('P0001');
    const ok = insBand(f, 10, dr); await q(ok.text, ok.values);
    await q(`DELETE FROM catalog.${f.bandTable} WHERE tenant_id = $1 AND set_id = $2`, [TENANT_A, dr]);
    expect(e.db.rows(f.bandTable).filter((r) => r['set_id'] === dr)).toHaveLength(0);
  });

  it('set triggers: draft -> published and published -> superseded / retired are allowed; published -> draft, retired -> published and column edits on a non-draft raise P0001; sets cannot be DELETEd (42501)', async () => {
    const e = setup8({ t6: { [f.setTable]: [f.mkSet(1, TENANT_A, HB.id), draftSet(f.mkSet, 2, HB.id)] } as never });
    const pub = f.mkSet(1, TENANT_A, HB.id).id as string, dr = draftSet(f.mkSet, 2, HB.id).id as string;
    const q = (text: string, values: unknown[]) => e.db.run((ctx) => ctx.tx.query(text, values));
    const upd = (id: string, set: string, ...v: unknown[]) => q(`UPDATE catalog.${f.setTable} SET ${set} WHERE tenant_id = $1 AND id = $2`, [TENANT_A, id, ...v]);
    expect((await rejection(upd(pub, 'status = $3', 'draft'))).code).toBe('P0001');
    expect((await rejection(upd(pub, 'unit_code = $3', 'mmol_l'))).code).toBe('P0001');
    await upd(pub, 'status = $3, effective_to = $4, version = version + 1', 'retired', new Date(Date.UTC(2026, 5, 1)));
    expect((await rejection(upd(pub, 'status = $3', 'published'))).code).toBe('P0001');
    await upd(dr, 'status = $3, effective_from = $4, published_at = $5, change_reason = $6', 'published', new Date(Date.UTC(2026, 5, 2)), new Date(Date.UTC(2026, 5, 2)), 'ok');
    expect(e.db.row(f.setTable, dr)).toMatchObject({ status: 'published' });
    expect((await rejection(q(`DELETE FROM catalog.${f.setTable} WHERE tenant_id = $1 AND id = $2`, [TENANT_A, dr]))).code).toBe('42501');
  });

  it('published_fields CHECK: publishing without effective_from / published_at / change_reason raises 23514', async () => {
    const e = setup8({ t6: { [f.setTable]: [draftSet(f.mkSet, 2, HB.id)] } as never });
    const x = await rejection(e.db.run((ctx) => ctx.tx.query(`UPDATE catalog.${f.setTable} SET status = $1 WHERE tenant_id = $2 AND id = $3`, ['published', TENANT_A, draftSet(f.mkSet, 2, HB.id).id])));
    expect(x.code).toBe('23514');
  });
});

describe('fixtures', () => {
  it('the world has HB (unit g_dl, method M1) under test CBC and a tenant-B analyte', () => {
    const e = setup8();
    expect(e.db.rows('analytes').map((a) => a['code']).sort()).toEqual(['HB', 'HBB', 'K', 'MENTZER', 'NIT']);
    expect(e.db.row('analytes', HB.id)).toMatchObject({ test_id: CBC.test.id });
  });
});
