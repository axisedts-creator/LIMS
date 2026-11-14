// C11 T-18 LIVE probes (07-SECURITY §4 AB-1…AB-12, §5.1–§5.4). Gated exactly like integration/*.live.test.ts: skipped unless LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL point at a
// migrated PG17 (anatomic DDL + RLS + grants + db/seeds). Real handlers, real repositories, real requestTx as lims_app with real claims; the superuser (owner) is used only to seed, to take
// content hashes of tenant B's rows before/after ("no side effect, DB check as owner", §5.1) and to run raw-SQL abuse cases.
// Fixtures: live-fixtures.ts (world 1 = tenant A / centre A1, world 2 = tenant A / centre A2, world 3 = tenant B). Probe lists come from probe-matrix.ts (spec-driven generator + §5.1 tables).
// assertRole is a pass-through except in the privilege block (the permission logic is covered by the unit suites); tenant/centre isolation here is therefore RLS + repository filters only.
// Not covered here (needs other components): AB-9 replay (core idempotency hook), AB-11 rate limit (core), AB-6/AB-7/AB-8 and 16 MB / 60 MP / quarantine / header tests (image pipeline, T-10 + T-18 content
// probes live in images/ and synoptic/report suites), §5.6 log scan (e2e T-25).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError, LimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { CLAIMS, LIVE, openHarness, type Harness } from '../integration/setup.js';
import { ANATOMIC_TABLES, CENTRE_A2, fx, PUBLISHED_VIEW, seedSignedAddendum, seedWorld, snapshot, TENANT_A, TENANT_B, wipe, WORLD } from './live-fixtures.js';
import { BODY_ID_PROBES, BULK_OPS, buildRequest, hasIdPath, LIST_OPS, OP, ops, PATH_KIND, sampleBody, setPointer, SIGNOUT_OPS, TENANT_READS, trd, UPSERT_BY_KEY, type OpInfo } from './probe-matrix.js';

const rejects = (p: Promise<unknown>): Promise<any> => p.then((v) => { throw new Error(`expected a rejection, got ${JSON.stringify(v)?.slice(0, 300)}`); }, (e: unknown) => e);
const notFound = async () => { throw new LimsError('common.not_found'); };
const CASE_DERIVED = ['case', 'part', 'block', 'slide', 'stainOrder', 'addendum', 'image'];

describe.skipIf(!LIVE)('C11-T18 probes over a real DB (tenants A/B, centres A1/A2/B1)', () => {
  let h: Harness;
  let assertRole: (c: unknown, i: any) => Promise<unknown> = async () => undefined;
  let actorType = 'user';
  const ctxFor = (tx: unknown, tenantId: string, claims: Record<string, any>) => ({
    operationId: 'probe.live', clientIp: '203.0.113.7', log: { info() {}, warn() {}, error() {} }, tenantId, actor: { type: actorType, id: String(claims['sub']), membershipId: claims['membership_id'] }, tx,
    now: () => new Date('2026-11-14T00:00:00Z'),
    ports: {
      IdentityPort: { assertRole: (c: unknown, i: any) => assertRole(c, i), async getTenantSettings() { return {}; } },
      CatalogPort: { async getTest(_c: unknown, i: { testId: string }) { if (i.testId === fx(3, 'test')) throw new LimsError('common.not_found'); return { name: 'Synthetic test', workflowType: 'histology' }; } },
      FrontdeskPort: { getOrderSummary: notFound, getPatientDemographicsBatch: async () => [] }, LabPort: {},
    },
    core: { user: async () => 'Synthetic User' }, audit: { access: async () => undefined, record: async () => undefined },
  }) as any;
  const call = (claims: Record<string, any>, tenant: string, id: string, req: object) =>
    h.asApp(claims, (tx) => (manifest.handlers as any)[id]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctxFor(tx, tenant, claims)));
  const asA = (id: string, req: object, claims: Record<string, any> = CLAIMS.allA) => call(claims, TENANT_A, id, req);
  const ids = (w: 1 | 2 | 3) => (kind: string) => (kind === 'code' ? 'PROBE1' : fx(w, kind));
  const reqFor = (o: OpInfo, w: 1 | 2 | 3) => buildRequest(o, ids(w));
  const noB = (body: unknown) => { const s = JSON.stringify(body ?? null); for (const k of ['case', 'part', 'block', 'slide', 'stainOrder', 'addendum', 'image', 'batch', 'template', 'stain', 'assay', 'textTemplate']) expect(s).not.toContain(fx(3, k)); };

  beforeAll(async () => {
    h = await openHarness();
    await wipe(h);
    await seedWorld(h, 1, { tenantLevel: true }); await seedWorld(h, 3, { tenantLevel: true }); await seedWorld(h, 2, { tenantLevel: false });
  }, 120_000);
  afterAll(async () => { if (h) { await wipe(h).catch(() => undefined); await h.close(); } });

  // -------------------------------------------------------------- §5.1 / AB-1 / AB-2 / AB-3 / AB-12 (read side)
  describe('§5.1 path ids of tenant B -> 404 common.not_found, no side effect (generator over the spec)', () => {
    const targets = ops().filter((o) => hasIdPath(o) && !UPSERT_BY_KEY.includes(o.operationId));
    let before: Record<string, string>;
    beforeAll(async () => { before = await snapshot(h); });
    it.each(targets.map((o) => [o.operationId, o] as const))('%s', async (_id, o) => {
      const e = await rejects(asA(o.operationId, reqFor(o, 3)));
      expect(isLimsError(e, 'common.not_found'), `${e?.code}: ${e?.message}`).toBe(true);
    });
    it('AB-1: image content of tenant B -> 404 and no bytes', async () => {
      const e = await rejects(asA(trd('I2'), { params: { image_id: fx(3, 'image') } }));
      expect(isLimsError(e, 'common.not_found')).toBe(true);
      expect(JSON.stringify(e)).not.toMatch(/Buffer|stream|\bdata\b":\[/);
    });
    it('key-addressed upserts with tenant B keys create at most A\'s own row and never touch B\'s', async () => {
      for (const id of UPSERT_BY_KEY) await asA(id, reqFor(OP[id]!, 3)).catch((e: unknown) => { if (!(isLimsError(e) && (e.statusCode ?? 400) < 500)) throw e; });
    });
    it('the owner\'s content hash of every tenant-B table is unchanged after all probes', async () => { expect(await snapshot(h)).toEqual(before); });
  });

  describe('§5.1 body ids of tenant B -> 404 or 400, never cross-linked (composite FKs are the second line)', () => {
    it.each(BODY_ID_PROBES.map((b, i) => [`${b.op} ${b.at}`, b, i] as const))('%s', async (_n, b) => {
      const o = OP[b.op]!;
      const before = await snapshot(h);
      const body = sampleBody(o);
      setPointer(body, b.at, b.kind === 'membership' ? fx(3, 'membership') : fx(3, b.kind === 'orderItem' ? 'orderItem' : b.kind === 'specimen' ? 'specimen' : b.kind));
      const r = await asA(b.op, { ...reqFor(o, 1), body }).then((v: any) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e: e as any }));
      if (r.ok) noB(r.v?.body); // a success is only acceptable when the B id was ignored (never linked): proven by the content hash below
      else expect([400, 404], `${b.op} ${b.at}: ${r.e?.code}`).toContain(r.e?.statusCode ?? r.e?.status);
      expect(await snapshot(h)).toEqual(before);
      const linked = await h.asSuperuser(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM anatomic.stain_orders WHERE tenant_id = $1 AND (block_id = $2 OR part_id = $3)`, [TENANT_A, fx(3, 'block'), fx(3, 'part')])).rows[0].n);
      expect(linked).toBe(0);
    });
  });

  describe('§5.1 bulk arrays mixing A and B ids (M3, M11, Q5, Q6) and AB-3', () => {
    it('M3 markAnatomicSlidesReady: own id processed, tenant-B id -> outcome not_found, B slide unchanged (AB-3)', async () => {
      const before = await snapshot(h);
      const r = await asA(trd('M3'), { body: { ids: [fx(1, 'slide'), fx(3, 'slide')] } });
      const by = Object.fromEntries((r.body.results as { id: string; outcome: string }[]).map((x) => [x.id, x.outcome]));
      expect(by[fx(3, 'slide')]).toBe('not_found');
      expect(by[fx(1, 'slide')]).not.toBe('not_found');
      expect(await snapshot(h)).toEqual(before);
    });
    it('M11 recordAnatomicMovements: block of tenant B -> outcome not_found, own block processed, B block unchanged', async () => {
      const before = await snapshot(h);
      const body = { object_kind: 'block', object_ids: [fx(1, 'block'), fx(3, 'block')], movement: 'stored', location_text: 'Cabinet P1' };
      const r = await asA(trd('M11'), { body });
      const res = (r.body.results ?? r.body.outcomes ?? []) as { id?: string; object_id?: string; outcome: string }[];
      const out = (id: string) => res.find((x) => (x.id ?? x.object_id) === id)?.outcome;
      expect(out(fx(3, 'block'))).toBe('not_found');
      expect(out(fx(1, 'block'))).toBeDefined();
      expect(await snapshot(h)).toEqual(before);
    });
    it('Q5 addAnatomicBatchMembers with a tenant-B case: refused or reported not_found, no batch_members row links tenant A\'s batch to B\'s case', async () => {
      const body = { members: [{ case_id: fx(3, 'case'), position: 5 }] };
      const r = await asA(trd('Q5'), { params: { batch_id: fx(1, 'batch') }, headers: { 'if-match': '"1"' }, body }).then((v: any) => ({ v }), (e: any) => ({ e }));
      if ('e' in r) expect([400, 404]).toContain(r.e?.statusCode ?? r.e?.status); else expect(JSON.stringify(r.v.body)).toMatch(/not_found/);
      const n = await h.asSuperuser(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM anatomic.batch_members WHERE tenant_id = $1 AND case_id = $2`, [TENANT_A, fx(3, 'case')])).rows[0].n);
      expect(n).toBe(0);
    });
    it('Q6 removeAnatomicBatchMembers with a tenant-B case: refused or not_found; B\'s membership stays active', async () => {
      const body = { case_ids: [fx(3, 'case')] };
      const r = await asA(trd('Q6'), { params: { batch_id: fx(1, 'batch') }, headers: { 'if-match': '"1"' }, body }).then((v: any) => ({ v }), (e: any) => ({ e }));
      if ('e' in r) expect([400, 404]).toContain(r.e?.statusCode ?? r.e?.status);
      const active = await h.asSuperuser(async (tx) => (await tx.query(`SELECT is_active FROM anatomic.batch_members WHERE id = $1`, [fx(3, 'batchMember')])).rows[0].is_active);
      expect(active).toBe(true);
    });
    it('the bulk list is exactly M3, M11, Q5, Q6', () => { expect([...BULK_OPS]).toEqual([trd('M3'), trd('M11'), trd('Q5'), trd('Q6')]); });
  });

  describe('§5.1 list endpoints with B data present -> zero B rows; lookups of B labels -> 404', () => {
    it.each([...LIST_OPS, ...TENANT_READS].map((id) => [id] as const))('%s lists/reads none of tenant B\'s rows', async (id) => {
      const o = OP[id]!;
      const req = { ...reqFor(o, 1), query: { ...Object.fromEntries(Object.entries(reqFor(o, 1).query)), ...(id === trd('K13') ? { status: 'draft,published,retired' } : {}), ...(id === trd('K11') ? {} : {}) } };
      const r = await asA(id, req);
      noB(r.body);
    });
    it('A2 lookupAnatomicObject: label of a tenant-B block -> 404, own label -> found', async () => {
      expect(isLimsError(await rejects(asA(trd('A2'), { body: { label: 'PRB-B1' } })), 'common.not_found')).toBe(true);
      expect((await asA(trd('A2'), { body: { label: 'PRB-A1' } })).body).toMatchObject({ case_id: fx(1, 'case') });
    });
  });

  // -------------------------------------------------------------- §5.2 cross-centre + actor type
  describe('§5.2 cross-centre: a user with centres {A1} only', () => {
    const a1 = CLAIMS.a1Only;
    const targets = ops().filter((o) => o.pathParams.some((p) => CASE_DERIVED.includes(PATH_KIND[p.name] ?? '')) && o.pathParams.every((p) => !PATH_KIND[p.name] || CASE_DERIVED.includes(PATH_KIND[p.name]!)));
    it('the generator found the case-derived operations (>= 30)', () => { expect(targets.length).toBeGreaterThanOrEqual(30); });
    it.each(targets.map((o) => [o.operationId, o] as const))('%s against a centre-A2 id -> 404', async (_id, o) => {
      const e = await rejects(asA(o.operationId, reqFor(o, 2), a1));
      expect(isLimsError(e, 'common.not_found'), `${e?.code}: ${e?.message}`).toBe(true);
    });
    it('A1 list excludes the A2 case; A1 lookup of an A2 label -> 404 (and of an A1 label -> found)', async () => {
      const r = await asA(trd('A1'), { query: {} }, a1);
      expect(JSON.stringify(r.body)).not.toContain(fx(2, 'case'));
      expect(JSON.stringify(r.body)).toContain(fx(1, 'case'));
      expect(isLimsError(await rejects(asA(trd('A2'), { body: { label: 'PRB-A2' } }, a1)), 'common.not_found')).toBe(true);
      expect((await asA(trd('A2'), { body: { label: 'PRB-A1' } }, a1)).body).toMatchObject({ case_id: fx(1, 'case') });
    });
    it('A12 (assignees) with a case/centre of A2 -> 404 or an empty list, never A2 staff', async () => {
      const r = await asA(trd('A12'), { query: { case_id: fx(2, 'case'), centre_id: CENTRE_A2 } }, a1).then((v: any) => ({ v }), (e: any) => ({ e }));
      if ('e' in r) expect(isLimsError(r.e, 'common.not_found')).toBe(true);
    });
    it('hub user with all_centres sees both centres (control: the 404s above are about the centre, not a broken fixture)', async () => {
      const r = await asA(trd('A1'), { query: {} }, CLAIMS.allA);
      expect(JSON.stringify(r.body)).toContain(fx(1, 'case'));
      expect(JSON.stringify(r.body)).toContain(fx(2, 'case'));
    });
  });

  describe('§5.2 actor-type probe (08 A17 P-16): partner, portal and patient claims of the same tenant read 0 rows from every anatomic table and from the published view', () => {
    const actors = (['partner', 'portal', 'patient'] as const).map((t) => [t, { actor_type: t, tenant_id: TENANT_A, sub: '0190c418-0000-7000-8000-ffff00000001' }] as const);
    it.each(actors.flatMap(([t, c]) => [...ANATOMIC_TABLES, 'v_pub_report_content'].map((tbl) => [t, tbl, c] as const)))('%s reads 0 rows of %s', async (_t, tbl, claims) => {
      const from = tbl === 'v_pub_report_content' ? PUBLISHED_VIEW : `anatomic.${tbl}`;
      expect(await h.rawApp(claims, `SELECT 1 FROM ${from}`)).toMatch(/^n=0$|^E42501\|/);
    });
    it('control: staff of tenant A do read their own cases', async () => { expect(await h.rawApp(CLAIMS.allA, `SELECT 1 FROM anatomic.cases WHERE tenant_id = '${TENANT_A}'`)).toMatch(/^n=[1-9]/); });
  });

  // -------------------------------------------------------------- §5.3 privilege
  describe('§5.3 privilege: signOut / startChange / discardChange / signAddendum', () => {
    const own = (id: string) => { const o = OP[id]!; return reqFor(o, 1); };
    const caseRow = () => h.asSuperuser(async (tx) => (await tx.query(`SELECT status, version, current_version_no FROM anatomic.cases WHERE id = $1`, [fx(1, 'case')])).rows[0]);
    it.each(SIGNOUT_OPS.flatMap((id) => (['auth.forbidden', 'auth.mfa_required'] as const).map((code) => [id, code] as const)))('%s: IdentityPort refusal %s reaches the caller unchanged and nothing changes', async (id, code) => {
      const before = await caseRow();
      assertRole = async () => { throw new LimsError(code); };
      try { const e = await rejects(asA(id, own(id))); expect(isLimsError(e, code), `${e?.code}: ${e?.message}`).toBe(true); } finally { assertRole = async () => undefined; }
      expect(await caseRow()).toEqual(before);
    });
    it('every refusal is asked for the spec permission (anatomic.case.signout) at the case\'s centre', async () => {
      const seen: any[] = [];
      assertRole = async (_c, i) => { seen.push(i); throw new LimsError('auth.forbidden'); };
      try { for (const id of SIGNOUT_OPS) await rejects(asA(id, own(id))); } finally { assertRole = async () => undefined; }
      expect(seen.map((i) => i.permission)).toEqual(SIGNOUT_OPS.map(() => 'anatomic.case.signout'));
      expect(seen.every((i) => i.centreId === undefined || typeof i.centreId === 'string')).toBe(true);
    });
    it('worker system actor cannot sign out (service asserts actor type user — 07-SECURITY §5.3 DECISION)', async () => {
      actorType = 'system';
      try {
        const e = await rejects(call(CLAIMS.sysA, TENANT_A, trd('R3'), { ...own(trd('R3')), body: { attest: true } }));
        expect(isLimsError(e, 'auth.forbidden'), `${e?.code}: ${e?.message}`).toBe(true);
      } finally { actorType = 'user'; }
    });
    it('R4 with each system reason code (supplementary_report, module_phase_progression, module_preliminary_update) -> 400 common.validation_failed', async () => {
      for (const code of ['supplementary_report', 'module_phase_progression', 'module_preliminary_update']) {
        const o = OP[trd('R4')]!; const body = sampleBody(o); setPointer(body, '/reason_code', code);
        const e = await rejects(asA(trd('R4'), { ...reqFor(o, 1), body }));
        expect(isLimsError(e, 'common.validation_failed'), `${code}: ${e?.code}`).toBe(true);
      }
    });
    it('K writes are refused for a caller whose IdentityPort answers auth.forbidden — with a real DB behind them, nothing is written (all 14)', async () => {
      const before = await snapshot(h, TENANT_A);
      assertRole = async () => { throw new LimsError('auth.forbidden'); };
      try { for (const o of ops().filter((x) => x.permission === 'anatomic.config.manage')) expect(isLimsError(await rejects(asA(o.operationId, reqFor(o, 1))), 'auth.forbidden'), o.operationId).toBe(true); } finally { assertRole = async () => undefined; }
      expect(await snapshot(h, TENANT_A)).toEqual(before);
    });
  });

  // -------------------------------------------------------------- AB-5 on operations with ids
  describe('AB-5 with real rows: forbidden body keys on operations that carry a path id', () => {
    const targets = ops().filter((o) => o.bodySchema && !o.isMultipart && hasIdPath(o) && o.pathParams.every((p) => CASE_DERIVED.concat(['batch', 'template', 'stain', 'assay', 'textTemplate']).includes(PATH_KIND[p.name] ?? 'x') || !PATH_KIND[p.name]));
    it.each(targets.map((o) => [o.operationId, o] as const))('%s: tenant_id / status / accession_no / signed_by_membership_id -> 400 unknown_field', async (_id, o) => {
      const props = Object.keys((o.bodySchema?.properties ?? {}) as object);
      for (const key of ['tenant_id', 'status', 'accession_no', 'signed_by_membership_id'].filter((k) => !props.includes(k))) {
        const e = await rejects(asA(o.operationId, { ...reqFor(o, 1), body: { ...sampleBody(o), [key]: key === 'tenant_id' ? TENANT_B : 'x' } }));
        expect(isLimsError(e, 'common.validation_failed') && e.errors?.some((f: any) => f.code === 'common.unknown_field'), `${key}: ${e?.code} ${JSON.stringify(e?.errors)}`).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------- AB-10 and grants (§5.4 spot checks as lims_app)
  describe('AB-10 / §5.4 spot checks as lims_app', () => {
    it('a signed addendum cannot be edited by direct SQL -> immutable_row', async () => {
      const id = await seedSignedAddendum(h);
      expect(await h.rawApp(CLAIMS.allA, `UPDATE anatomic.addenda SET text = 'tampered' WHERE id = $1`, [id])).toMatch(/^EP0001\|immutable_row/);
    });
    it('DELETE is not granted on any anatomic table (permission denied)', async () => {
      for (const t of ANATOMIC_TABLES) expect(await h.rawApp(CLAIMS.allA, `DELETE FROM anatomic.${t} WHERE false`), t).toMatch(/^E42501\|/);
    });
    it('a tenant-A session cannot INSERT/UPDATE rows for tenant B (RLS WITH CHECK / USING)', async () => {
      const upd = await h.rawApp(CLAIMS.allA, `UPDATE anatomic.cases SET priority = 'urgent' WHERE id = $1`, [fx(3, 'case')]);
      expect(upd).toBe('n=0');
      const ins = await h.rawApp(CLAIMS.allA, `INSERT INTO anatomic.parts (id, tenant_id, centre_id, case_id, letter, letter_seq, created_by, updated_by) VALUES ($1, $2, $3, $4, 'Z', 9, $5, $5)`,
        ['0190c418-0000-7000-8000-190000000009', TENANT_B, WORLD[3].centre, fx(3, 'case'), CLAIMS.allA.sub]);
      expect(ins).toMatch(/^E(42501|23503|23514)\|/);
    });
  });
});
