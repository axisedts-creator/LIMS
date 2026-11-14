// C11.T-12 LIVE integration (gated exactly like T-11: skipped unless LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL point at a migrated DB incl. the anatomic DDL).
// Proves what the in-memory ../synoptic.handlers.test.ts cannot: the REAL guard trigger (immutable_row, 05-SCHEMA guard_synoptic_template; 07-SECURITY AB-10), the REAL partial unique index
// "one published version per key", unique (tenant,key,version_no), RLS tenant isolation and real parallelism — through the real handlers, repositories and requestTx.
// assertRole is a no-op here (permission logic is in the unit file). Rows created by handlers have generated ids, so this file removes its own rows (template_key LIKE 't12_%').
// Not run here: no PG in this environment (see T-04 notes).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { CLAIMS, LIVE, openHarness, TENANT_A, TENANT_B, type Harness } from './setup.js';

const ctxFor = (tx: unknown, tenantId: string, actorId: string) => ({
  operationId: 'synoptic.live', clientIp: '203.0.113.7', log: { info() {}, warn() {}, error() {} }, tenantId, actor: { type: 'user', id: actorId }, tx, now: () => new Date('2026-11-13T01:30:00Z'),
  ports: { IdentityPort: { async assertRole() {} }, CatalogPort: { async getTest() { throw new Error('unused'); } } },
}) as any;
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const DEF = (title = 'Synthetic live template') => ({
  schema_version: 1, title, applies_to_case_kinds: ['histology'],
  sections: [
    { key: 'tumour', heading: 'Tumour', fields: [{ key: 'site', label: 'Site', type: 'text', required: true }, { key: 'grade', label: 'Grade', type: 'single_select', required: true, options: [{ code: 'g1', display: 'Grade 1' }, { code: 'g2', display: 'Grade 2' }] }] },
    { key: 'margins', heading: 'Margins', fields: [{ key: 'status', label: 'Status', type: 'single_select', required: true, options: [{ code: 'clear', display: 'Clear' }, { code: 'involved', display: 'Involved' }] }] },
  ],
});

describe.skipIf(!LIVE)('C11-T12 synoptic templates over a real DB', () => {
  let h: Harness;
  const op = (claims: Record<string, unknown>, tenant: string, name: string, req: Record<string, unknown>) =>
    h.asApp(claims, (tx) => (manifest.handlers as any)[name]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctxFor(tx, tenant, String(claims['sub']))));
  const asA = (name: string, req: Record<string, unknown> = {}) => op(CLAIMS.allA, TENANT_A, name, req);
  const asB = (name: string, req: Record<string, unknown> = {}) => op(CLAIMS.sysB, TENANT_B, name, req);
  const wipe = () => h.asSuperuser(async (tx) => { await tx.query(`DELETE FROM anatomic.synoptic_templates WHERE template_key LIKE 't12\\_%' AND tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]); });
  const publishedCount = (key: string) => h.asSuperuser(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM anatomic.synoptic_templates WHERE tenant_id = $1 AND template_key = $2 AND status = 'published'`, [TENANT_A, key])).rows[0].n as number);
  beforeAll(async () => { h = await openHarness(); await h.cleanup(); await wipe(); });
  afterAll(async () => { if (h) { await wipe().catch(() => undefined); await h.cleanup().catch(() => undefined); await h.close(); } });

  it('AC-08.1/08.3: create draft → publish → edit refused (409 common.immutable_record via the real trigger path) → new version v2 draft with the definition copied', async () => {
    const c = (await asA('createAnatomicSynopticTemplate', { body: { template_key: 't12_life', definition: DEF() } })).body;
    expect(c).toMatchObject({ status: 'draft', version_no: 1, version: 1 });
    const p = (await asA('publishAnatomicSynopticTemplate', { params: { template_id: c.id }, headers: ifm(c.version) })).body;
    expect(p.status).toBe('published');
    const e = await rejects(asA('updateAnatomicSynopticTemplate', { params: { template_id: c.id }, headers: ifm(p.version), body: { definition: DEF('changed') } }));
    expect(isLimsError(e, 'common.immutable_record')).toBe(true);
    expect((await asA('getAnatomicSynopticTemplate', { params: { template_id: c.id } })).body.definition).toEqual(DEF());
    const v2 = (await asA('createAnatomicSynopticTemplateVersion', { params: { template_id: c.id } })).body;
    expect(v2).toMatchObject({ template_key: 't12_life', version_no: 2, status: 'draft', definition: DEF() });
  });

  it('one published per key on the real index: publishing v2 retires v1 in the same transaction; AC-08.4 v1 stays readable and unchanged', async () => {
    const c = (await asA('createAnatomicSynopticTemplate', { body: { template_key: 't12_one', definition: DEF() } })).body;
    const p1 = (await asA('publishAnatomicSynopticTemplate', { params: { template_id: c.id }, headers: ifm(c.version) })).body;
    const v2 = (await asA('createAnatomicSynopticTemplateVersion', { params: { template_id: c.id } })).body;
    const v2u = (await asA('updateAnatomicSynopticTemplate', { params: { template_id: v2.id }, headers: ifm(v2.version), body: { definition: DEF('v2 title') } })).body;
    await asA('publishAnatomicSynopticTemplate', { params: { template_id: v2.id }, headers: ifm(v2u.version) });
    expect(await publishedCount('t12_one')).toBe(1);
    const v1 = (await asA('getAnatomicSynopticTemplate', { params: { template_id: c.id } })).body;
    expect(v1).toMatchObject({ status: 'retired', version_no: 1, definition: DEF(), published_at: p1.published_at });
    expect((await asA('getAnatomicSynopticTemplate', { params: { template_id: v2.id } })).body).toMatchObject({ status: 'published', version_no: 2, title: 'v2 title' });
  });

  it('DB guard trigger (AB-10) as lims_app with raw SQL: editing a published row\'s definition/title, re-drafting it, or re-publishing a retired row → P0001 immutable_row; retiring is allowed', async () => {
    const c = (await asA('createAnatomicSynopticTemplate', { body: { template_key: 't12_guard', definition: DEF() } })).body;
    const p = (await asA('publishAnatomicSynopticTemplate', { params: { template_id: c.id }, headers: ifm(c.version) })).body;
    for (const sql of [`UPDATE anatomic.synoptic_templates SET definition = '{}'::jsonb WHERE id = $1`, `UPDATE anatomic.synoptic_templates SET title = 'x' WHERE id = $1`,
      `UPDATE anatomic.synoptic_templates SET status = 'draft', published_at = NULL WHERE id = $1`, `UPDATE anatomic.synoptic_templates SET template_key = 't12_other' WHERE id = $1`]) {
      expect(await h.rawApp(CLAIMS.allA, sql, [c.id]), sql).toMatch(/^EP0001\|immutable_row/);
    }
    expect(await h.rawApp(CLAIMS.allA, `UPDATE anatomic.synoptic_templates SET status = 'retired', retired_at = now() WHERE id = $1`, [c.id])).toBe('n=1');
    const r = (await asA('retireAnatomicSynopticTemplate', { params: { template_id: c.id }, headers: ifm(p.version) })).body;
    expect(r.status).toBe('retired');
    expect(await h.rawApp(CLAIMS.allA, `UPDATE anatomic.synoptic_templates SET status = 'published' WHERE id = $1`, [c.id])).toMatch(/^EP0001\|immutable_row/);
    expect(isLimsError(await rejects(asA('publishAnatomicSynopticTemplate', { params: { template_id: c.id }, headers: ifm(r.version) })), 'common.immutable_record')).toBe(true);
  });

  it('partial unique index: a second published row for the same tenant+key is refused by the database (23505) even when inserted directly', async () => {
    const c = (await asA('createAnatomicSynopticTemplate', { body: { template_key: 't12_idx', definition: DEF() } })).body;
    await asA('publishAnatomicSynopticTemplate', { params: { template_id: c.id }, headers: ifm(c.version) });
    const sql = `INSERT INTO anatomic.synoptic_templates (id, tenant_id, template_key, version_no, status, title, applies_to_case_kinds, definition, published_at, created_by, updated_by)
                 VALUES ('0190c412-0000-7000-8000-0000000000f1', '${TENANT_A}', 't12_idx', 9, 'published', 'dup', ARRAY['histology'], '{}'::jsonb, now(), '${CLAIMS.allA.sub}', '${CLAIMS.allA.sub}')`;
    expect(await h.rawApp(CLAIMS.allA, sql)).toMatch(/^E23505\|/);
  });

  it('two parallel publishes of the same draft: exactly one succeeds, the other is a clean 4xx; the key has exactly one published row', async () => {
    const c = (await asA('createAnatomicSynopticTemplate', { body: { template_key: 't12_race', definition: DEF() } })).body;
    const rs = await Promise.allSettled([1, 2].map(() => asA('publishAnatomicSynopticTemplate', { params: { template_id: c.id }, headers: ifm(c.version) })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = (rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason; expect(isLimsError(lost)).toBe(true); expect(lost.statusCode).toBeLessThan(500);
    expect(await publishedCount('t12_race')).toBe(1);
  });

  it('two parallel new-version calls: one v2 row at most (unique key+version_no); the loser is a clean 4xx', async () => {
    const c = (await asA('createAnatomicSynopticTemplate', { body: { template_key: 't12_nv', definition: DEF() } })).body;
    await asA('publishAnatomicSynopticTemplate', { params: { template_id: c.id }, headers: ifm(c.version) });
    const rs = await Promise.allSettled([1, 2].map(() => asA('createAnatomicSynopticTemplateVersion', { params: { template_id: c.id } })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = (rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason; expect(isLimsError(lost)).toBe(true); expect(lost.statusCode).toBeLessThan(500);
    const n = await h.asSuperuser(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM anatomic.synoptic_templates WHERE tenant_id = $1 AND template_key = 't12_nv' AND version_no = 2`, [TENANT_A])).rows[0].n);
    expect(n).toBe(1);
  });

  it('duplicate template_key on create → 400 common.validation_failed at /template_key (real unique constraint), AC-08.2 invalid definition → 422 anatomic.template_invalid and nothing stored', async () => {
    await asA('createAnatomicSynopticTemplate', { body: { template_key: 't12_dup', definition: DEF() } });
    const d = await rejects(asA('createAnatomicSynopticTemplate', { body: { template_key: 't12_dup', definition: DEF() } }));
    expect(isLimsError(d, 'common.validation_failed') && d.errors?.some((f: any) => f.path === '/template_key')).toBe(true);
    const bad = DEF(); (bad.sections[0]!.fields as any[]).push({ key: 'site', label: 'again', type: 'text', required: false });
    const e = await rejects(asA('createAnatomicSynopticTemplate', { body: { template_key: 't12_bad', definition: bad } }));
    expect(isLimsError(e, 'anatomic.template_invalid')).toBe(true); expect(e.errors.some((f: any) => f.path === '/definition/sections/0/fields/2/key')).toBe(true);
    const n = await h.asSuperuser(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM anatomic.synoptic_templates WHERE template_key = 't12_bad'`)).rows[0].n);
    expect(n).toBe(0);
  });

  it('tenant isolation under RLS: tenant B can neither list nor read nor change nor publish nor version tenant A\'s template (404), and may use the same key itself', async () => {
    const a = (await asA('createAnatomicSynopticTemplate', { body: { template_key: 't12_iso', definition: DEF() } })).body;
    expect((await asB('listAnatomicSynopticTemplates', { query: { status: 'draft,published,retired' } })).body.data.some((t: any) => t.id === a.id)).toBe(false);
    for (const [name, req] of [['getAnatomicSynopticTemplate', {}], ['updateAnatomicSynopticTemplate', { headers: ifm(1), body: { definition: DEF('hijack') } }], ['publishAnatomicSynopticTemplate', { headers: ifm(1) }],
      ['retireAnatomicSynopticTemplate', { headers: ifm(1) }], ['createAnatomicSynopticTemplateVersion', {}]] as const) {
      expect(isLimsError(await rejects(asB(name, { params: { template_id: a.id }, ...req })), 'common.not_found'), name).toBe(true);
    }
    expect((await asB('createAnatomicSynopticTemplate', { body: { template_key: 't12_iso', definition: DEF('B own') } })).status).toBe(201);
    expect((await asA('getAnatomicSynopticTemplate', { params: { template_id: a.id } })).body).toMatchObject({ status: 'draft', title: 'Synthetic live template', version: 1 });
  });
});
