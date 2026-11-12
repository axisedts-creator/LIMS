// C11.T-11 LIVE integration (gated exactly like T-04/T-06: skipped unless LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL point at a migrated DB incl. the anatomic DDL).
// Proves what the in-memory ../config.handlers.test.ts cannot: lazy defaults on the real tables under RLS with ON CONFLICT DO NOTHING (05-SCHEMA §2.3, 08 A17 P-22) incl. 5 parallel first reads,
// tenant isolation (tenant B never sees tenant A's configuration), the AC-14.2 default-stain guard and AC-14.3 coded values against real unique indexes. Real handlers, real repositories, real requestTx.
// assertRole is a no-op here (permission logic is covered in the unit file); the lazily created rows have generated ids, so this file removes them itself (rows with code HE / the settings rows of tenants A and B).
// Not run here: no PG in this environment (see T-04 notes).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { CLAIMS, LIVE, openHarness, TENANT_A, TENANT_B, type Harness } from './setup.js';

const ctxFor = (tx: unknown, tenantId: string, actorId: string) => ({
  operationId: 'config.live', clientIp: '203.0.113.7', log: { info() {}, warn() {}, error() {} }, tenantId, actor: { type: 'user', id: actorId }, tx, now: () => new Date('2026-11-12T01:30:00Z'),
  ports: { IdentityPort: { async assertRole() {} }, CatalogPort: { async getTest() { throw new Error('unused'); } } },
}) as any;
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);

describe.skipIf(!LIVE)('C11-T11 configuration over a real DB', () => {
  let h: Harness;
  const op = (claims: Record<string, unknown>, tenant: string, name: string, req: Record<string, unknown>) =>
    h.asApp(claims, (tx) => (manifest.handlers as any)[name]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctxFor(tx, tenant, String(claims['sub']))));
  const asA = (name: string, req: Record<string, unknown> = {}) => op(CLAIMS.allA, TENANT_A, name, req);
  const asB = (name: string, req: Record<string, unknown> = {}) => op(CLAIMS.sysB, TENANT_B, name, req);
  const wipe = () => h.asSuperuser(async (tx) => {
    await tx.query(`DELETE FROM anatomic.cs_diagnoses WHERE code LIKE 'T11-%'`);
    await tx.query(`DELETE FROM anatomic.stains WHERE tenant_id IN ($1, $2) AND id::text NOT LIKE '0190c411-%'`, [TENANT_A, TENANT_B]);
    await tx.query(`DELETE FROM anatomic.settings WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  });
  beforeAll(async () => { h = await openHarness(); await h.cleanup(); await wipe(); });
  afterAll(async () => { if (h) { await wipe().catch(() => undefined); await h.cleanup().catch(() => undefined); await h.close(); } });

  it('lazy defaults: first K1 of a tenant creates the settings row (§10.2 defaults) and stain HE; 5 parallel first reads → all 200, exactly one row of each', async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => asA('getAnatomicSettings')));
    for (const r of rs) expect(r.body).toEqual({ auto_accession_on_receipt: false, require_gross_complete_for_processing: true, default_routine_stain_code: 'HE', max_images_per_case: 50, max_report_images: 12, version: 1 });
    const n = await h.asSuperuser(async (tx) => ({
      s: (await tx.query(`SELECT count(*)::int AS n FROM anatomic.settings WHERE tenant_id = $1`, [TENANT_A])).rows[0].n,
      he: (await tx.query(`SELECT count(*)::int AS n FROM anatomic.stains WHERE tenant_id = $1 AND code = 'HE' AND kind = 'routine'`, [TENANT_A])).rows[0].n,
    }));
    expect(n).toEqual({ s: 1, he: 1 });
  });
  it('tenant isolation: tenant B gets its own lazily created HE and cannot see or touch tenant A\'s stain', async () => {
    const a = (await asA('listAnatomicStains')).body.data.find((s: any) => s.code === 'HE');
    const b = (await asB('listAnatomicStains')).body.data;
    expect(b.filter((s: any) => s.code === 'HE')).toHaveLength(1); expect(b.some((s: any) => s.id === a.id)).toBe(false);
    const e = await rejects(op(CLAIMS.sysB, TENANT_B, 'updateAnatomicStain', { params: { stain_id: a.id }, headers: ifm(1), body: { display: 'hijack', kind: 'routine', sort_order: 0, is_active: true } }));
    expect(isLimsError(e, 'common.not_found')).toBe(true);
  });
  it('AC-14.2 on the real tables: deactivating the default routine stain → 400; making another routine stain the default first lets it through', async () => {
    const he = (await asA('listAnatomicStains')).body.data.find((s: any) => s.code === 'HE');
    const e = await rejects(asA('updateAnatomicStain', { params: { stain_id: he.id }, headers: ifm(he.version), body: { display: he.display, kind: 'routine', sort_order: 0, is_active: false } }));
    expect(isLimsError(e, 'common.validation_failed')).toBe(true);
    const pap = (await asA('createAnatomicStain', { body: { code: 'T11_PAP', display: 'Papanicolaou (synthetic)', kind: 'routine', sort_order: 5 } })).body;
    const dup = await rejects(asA('createAnatomicStain', { body: { code: 'T11_PAP', display: 'again', kind: 'routine', sort_order: 5 } }));
    expect(isLimsError(dup, 'common.validation_failed') && dup.errors?.some((f: any) => f.path === '/code')).toBe(true);
    await asA('updateAnatomicSettings', { headers: ifm(1), body: { auto_accession_on_receipt: false, require_gross_complete_for_processing: true, default_routine_stain_code: pap.code, max_images_per_case: 50, max_report_images: 12 } });
    expect((await asA('updateAnatomicStain', { params: { stain_id: he.id }, headers: ifm(he.version), body: { display: he.display, kind: 'routine', sort_order: 0, is_active: false } })).body.is_active).toBe(false);
  });
  it('AC-14.3 on the real tables: add diagnosis T11-0001 (system defaults to local), list it, duplicate create races to one row, tenant B does not see it', async () => {
    const mk = { display: 'Synthetic diagnosis (T-11)', sort_order: 1, is_active: true };
    const r = await asA('upsertAnatomicCodedValue', { params: { set_name: 'diagnoses', code: 'T11-0001' }, headers: ifm(0), body: mk });
    expect(r.body).toMatchObject({ code: 'T11-0001', system: 'local', version: 1 });
    const rs = await Promise.allSettled([1, 2].map(() => asA('upsertAnatomicCodedValue', { params: { set_name: 'diagnoses', code: 'T11-0002' }, headers: ifm(0), body: mk })));
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await asA('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { q: 'T-11' } })).body.data.map((v: any) => v.code).sort()).toEqual(['T11-0001', 'T11-0002']);
    expect((await asB('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { q: 'T-11' } })).body.data).toEqual([]);
  });
  it('create with is_active:false is stored inactive (the real INSERT lists have no is_active column): K12 coded value and K7 test profile read back inactive', async () => {
    const r = await asA('upsertAnatomicCodedValue', { params: { set_name: 'diagnoses', code: 'T11-0003' }, headers: ifm(0), body: { display: 'Synthetic inactive (T-11)', sort_order: 3, is_active: false } });
    expect(r.body).toMatchObject({ code: 'T11-0003', is_active: false });
    const rows = (await asA('listAnatomicCodedValues', { params: { set_name: 'diagnoses' }, query: { q: 'inactive (T-11)' } })).body.data;
    expect(rows.find((v: any) => v.code === 'T11-0003')?.is_active).toBe(false);
    const TEST_ID = '0190c411-0000-7000-8000-000000007099';
    const ctx = ctxFor(null, TENANT_A, String(CLAIMS.allA['sub']));
    const p = await h.asApp(CLAIMS.allA, (tx) => (manifest.handlers as any)['upsertAnatomicTestProfile'](
      { params: { test_id: TEST_ID }, query: {}, headers: ifm(0), body: { case_kind: 'molecular', is_addon: false, requires_gross: false, is_active: false } },
      { ...ctx, tx, ports: { ...ctx.ports, CatalogPort: { async getTest() { return { id: TEST_ID, code: 'SYN-PCR-T11', name: 'Synthetic PCR', workflowType: 'molecular', isActive: true }; } } } }));
    expect(p.body).toMatchObject({ test_id: TEST_ID, is_active: false });
    const stored = await h.asSuperuser(async (tx) => (await tx.query(`SELECT is_active FROM anatomic.test_profiles WHERE tenant_id = $1 AND test_id = $2`, [TENANT_A, TEST_ID])).rows);
    expect(stored).toEqual([{ is_active: false }]);
    await h.asSuperuser((tx) => tx.query(`DELETE FROM anatomic.test_profiles WHERE tenant_id = $1 AND test_id = $2`, [TENANT_A, TEST_ID]));
  });
});
