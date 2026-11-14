// C10 T-10 — M11 assignAstPanel, M12 recordAstResults, M29–M32 AST panels against the migrated database (06 row T-10; 02-TRD §4.2–4.4, §5, §10 p95, §12; 05-SCHEMA §4 RLS, §8 constraints;
// PRD AC-06.1–06.6, AC-06.3a, AC-16.1; 07-SECURITY T-A3, T-A4, T-A8, T-E1, S-01, S-05, S-09, S-23).
// Needs the micro DDL + RLS of 05-SCHEMA applied (C0 prerequisite): LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser; the global coded sets
// (g_cs_ast_interpretations, g_ast_category_restrictions incl. CLSI colistin I/R, g_cs_antibiotics `colistin`) come from the migrations' starter data.
// Without the URLs the DB tests skip, except under LIMS_T10_REQUIRE_DB=1 where "database is provided" fails. (Same harness status as T-05/T-07/T-08/T-09.)
// SEAMS: as ast.writes.test.ts; ctx.tx = the request tx under RLS with claims { tenant_id, sub, actor_type: 'user', membership_id }; ports / core.* are hand fakes (helpers/cultureReads.ts).
// PERF (done_when "p95 <= 300 ms for 60 entries on 10x seed"): the working set is seeded to SEED_ISOLATES x 20 AST rows (10x of TRD §10: 500 cultures/day x 30 % growth x 1.2 isolates ~ 180 isolates/day
//   per lab; 10x seed ~ 3,000 isolates in the working set [ASSUMPTION, no spec number]); then 20 timed 60-entry requests, each on its own isolate whose 60 pending rows come from a 60-antibiotic panel.
// Isolation: every test creates its own cultures / specimens / organisms (append-only tables; nothing is deleted); codes are unique per run.
// Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { MANAGE, mkCtx, READ, responseErrors, run, schemaErrors, WORK, type Row } from './helpers/cultureReads.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T10_REQUIRE_DB'] === '1';
const SEED_ISOLATES = Number(process.env['LIMS_T10_SEED_ISOLATES'] ?? 3000);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const RUN = Date.now();
let seqN = 0;
const uid = () => `0190c60f-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
const NOW = new Date('2026-11-05T05:00:00.000Z');
const PLANTED = '2026-11-04T05:00:00.000Z';
const code = (p: string) => `syn_t10_${p}_${RUN}`;
const GROUP = code('grp'), SITE = code('site');
const ABX = Array.from({ length: 60 }, (_, i) => code(`abx${i}`));

let api: pg.Pool;
let admin: pg.Pool;
const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;

async function seedRow(table: string, given: Record<string, unknown>, onConflict = ''): Promise<void> {
  const [schema, name] = table.split('.') as [string, string];
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    const cols = (await c.query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
      AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows as { column_name: string; udt_name: string }[];
    const row: Record<string, unknown> = { ...given };
    for (const { column_name, udt_name } of cols) {
      if (column_name in row) continue;
      row[column_name] = udt_name === 'uuid' ? uid() : /^(int|numeric|float)/.test(udt_name) ? 1 : udt_name === 'bool' ? false : udt_name === 'timestamptz' || udt_name === 'timestamp' ? NOW
        : udt_name === 'date' ? '2026-11-01' : udt_name === 'jsonb' || udt_name === 'json' ? '[]' : `syn-${seqN}`;
    }
    const keys = Object.keys(row);
    await c.query(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ${onConflict}`, keys.map((k) => row[k]));
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

const W = { order: uid(), centreA1: uid(), centreA2: uid(), centreB1: uid(), patient: uid(), memHub: uid(), memA1: uid(), memB: uid(), userTech: uid(), test: uid() };
const TECH = 'Synthetic Tech AST';

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 8 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await seedRow('core.tenants', { id: t }, 'ON CONFLICT DO NOTHING');
  for (const [t, id] of [[A, W.centreA1], [A, W.centreA2], [B, W.centreB1]] as const) await seedRow('core.collection_centres', { tenant_id: t, id });
  await seedRow('core.users', { tenant_id: A, id: W.userTech, display_name: TECH });
  for (const [t, id, all] of [[A, W.memHub, true], [A, W.memA1, false], [B, W.memB, true]] as const)
    await seedRow('core.memberships', { tenant_id: t, id, user_id: W.userTech, actor_type: 'user', status: 'active', is_active: true, all_centres: all });
  await seedRow('core.membership_centres', { tenant_id: A, membership_id: W.memA1, centre_id: W.centreA1 });
  await seedRow('frontdesk.patients', { tenant_id: A, id: W.patient });
  await seedRow('catalog.tests', { tenant_id: A, id: W.test });
  await seedRow('micro.cs_organism_groups', { tenant_id: A, code: GROUP, display: 'Synthetic group', is_active: true, created_by: SYS, updated_by: SYS });
  await seedRow('micro.cs_specimen_sites', { tenant_id: A, code: SITE, display: 'Synthetic site', is_active: true, created_by: SYS, updated_by: SYS });
  for (const c of ABX) await seedRow('micro.cs_antibiotics', { tenant_id: A, code: c, display: `Synthetic ${c}`, is_active: true, created_by: SYS, updated_by: SYS });
});
afterAll(async () => { await api?.end(); await admin?.end(); });

let orgN = 0;
/** A fresh organism (optionally in the run's group) so precedence tests never see each other's panels. */
async function newOrganism(group: string | null = null): Promise<string> {
  const c = code(`org${++orgN}`);
  await seedRow('micro.cs_organisms', { tenant_id: A, code: c, display: `Synthetic ${c}`, is_active: true, organism_group_code: group, created_by: SYS, updated_by: SYS });
  return c;
}
async function newIsolate(o: { organism: string; site?: string | null; status?: string; cultureStatus?: string; centre?: string; tenant?: string }): Promise<{ culture: string; isolate: string }> {
  const tenant = o.tenant ?? A; const centre = o.centre ?? W.centreA1; const culture = uid(); const specimen = uid(); const isolate = uid();
  await seedRow('lab.specimens', { tenant_id: tenant, id: specimen });
  await seedRow('micro.cultures', { id: culture, tenant_id: tenant, centre_id: centre, order_id: W.order, order_item_id: uid(), specimen_id: specimen, patient_id: W.patient, test_id: W.test, specimen_type_code: 'urine',
    specimen_site_code: o.site ?? null, status: o.cultureStatus ?? 'growth_detected', received_at: '2026-11-04T04:00:00.000Z', planted_at: PLANTED, last_specimen_seq: 1, created_by: SYS, updated_by: SYS, version: 1 });
  await seedRow('micro.isolates', { id: isolate, tenant_id: tenant, centre_id: centre, culture_id: culture, specimen_id: specimen, isolate_seq: 1, status: o.status ?? 'identified', organism_code: o.organism, organism_source: 'manual',
    identified_at: PLANTED, is_reportable: true, created_by: SYS, updated_by: SYS, version: 3 });
  return { culture, isolate };
}
const astRows = (isolate: string) => q('SELECT * FROM micro.ast_results WHERE isolate_id = $1 ORDER BY panel_sort_order NULLS LAST, antibiotic_code', [isolate]);
const isoRow = async (id: string) => (await q('SELECT * FROM micro.isolates WHERE id = $1', [id]))[0]!;
const panelRows = (c: string) => q('SELECT * FROM micro.ast_panels WHERE tenant_id = $1 AND code = $2 ORDER BY version_no', [A, c]);

interface Who { tenant: string; membership: string; centres?: string[]; all?: boolean }
const HUB: Who = { get tenant() { return A; }, get membership() { return W.memHub; }, all: true };
const A1: Who = { get tenant() { return A; }, get membership() { return W.memA1; }, get centres() { return [W.centreA1]; }, all: false };
const asB: Who = { get tenant() { return B; }, get membership() { return W.memB; }, all: true };

async function call(who: Who, op: string, req: Row, grants: string[] = [WORK, MANAGE, READ]): Promise<{ res?: any; err?: any; ms: number }> {
  const client = await api.connect();
  const t0 = performance.now();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: who.tenant, sub: SYS, actor_type: 'user', membership_id: who.membership })]);
    const { ctx } = mkCtx({ tenantId: who.tenant, tx: client, grants, actor: { type: 'user', id: SYS, membershipId: who.membership }, centreScope: { all: who.all === true, centreIds: who.centres ?? [] },
      tests: { [W.test]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } }, members: { [W.memHub]: TECH, [W.memA1]: TECH }, users: { [W.userTech]: TECH } });
    try { const res = await run(op, req, ctx); await client.query('COMMIT'); return { res, ms: performance.now() - t0 }; } catch (err) { await client.query('ROLLBACK'); return { err, ms: performance.now() - t0 }; }
  } finally { client.release(); }
}
const ok = async (p: Promise<{ res?: any; err?: any }>) => { const r = await p; if (r.err) throw r.err; return r.res; };
const bad = async (p: Promise<{ res?: any; err?: any }>, c: string) => { const r = await p; expect(r.err, `expected ${c}`).toBeDefined(); expect(isLimsError(r.err, c), `${r.err?.code ?? r.err}`).toBe(true); return r.err; };
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const key = () => ({ 'idempotency-key': `k-${uid()}` });
const create = (body: Row) => ({ params: {}, headers: key(), body });
const mkPanel = async (body: Row) => ok(call(HUB, 'createAstPanel', create(body)));
const pbody = (c: string, over: Row = {}): Row => ({ code: c, display: `Synthetic ${c}`, default_method: 'mic', antibiotics: [{ antibiotic_code: ABX[0], is_reported_default: true }, { antibiotic_code: ABX[1], method: 'zone_diameter', is_reported_default: false }], ...over });
const assign = (isolate: string, v: number, body: Row = {}) => ({ params: { isolate_id: isolate }, headers: { ...key(), ...ifm(v) }, body });
const record = (isolate: string, entries: Row[]) => ({ params: { isolate_id: isolate }, headers: key(), body: { entries } });
const e = (abx: string, method = 'mic', over: Row = {}): Row => ({ antibiotic_code: abx, method, ...over });

describe.skipIf(!live && !REQUIRE)('T-10 AST panels + AST entry (live DB)', () => {
  it('database is provided', () => { expect(live).toBe(true); });

  describe('M30 / M31 / M32 / M29 panel configuration on the real constraints', () => {
    it('M30 creates v1 (201, schema-valid, antibiotic rows in order); a duplicate current code -> 409 micro.code_duplicate with nothing left behind; M31 supersedes then inserts v2 and v1 stays untouched; M32 deactivates', async () => {
      const c = code('cfg'); const org = await newOrganism();
      const r = await call(HUB, 'createAstPanel', create(pbody(c, { organism_code: org })));
      expect(r.res.status).toBe(201);
      expect(schemaErrors('AstPanelDto', r.res.body)).toEqual([]);
      expect(r.res.body.antibiotics.map((a: Row) => [a['antibiotic_code'], a['sort_order']])).toEqual([[ABX[0], 0], [ABX[1], 1]]);
      await bad(call(HUB, 'createAstPanel', create(pbody(c))), 'micro.code_duplicate');
      expect(await panelRows(c)).toHaveLength(1);
      const { code: _c, ...rest } = pbody(c, { organism_code: org, display: 'Version two', antibiotics: [{ antibiotic_code: ABX[2], is_reported_default: true }] });
      const v2 = await ok(call(HUB, 'versionAstPanel', { params: { panel_id: r.res.body.id }, headers: { ...key(), ...ifm(r.res.body.version) }, body: rest }));
      expect(v2.body).toMatchObject({ code: c, version_no: 2, display: 'Version two' });
      const rows = await panelRows(c);
      expect(rows.map((x) => x.version_no)).toEqual([1, 2]);
      expect(rows[0].superseded_at).not.toBeNull(); expect(rows[1].superseded_at).toBeNull();
      expect((await q('SELECT antibiotic_code FROM micro.ast_panel_antibiotics WHERE panel_id = $1 ORDER BY sort_order', [rows[0].id])).map((x) => x.antibiotic_code)).toEqual([ABX[0], ABX[1]]);
      await bad(call(HUB, 'versionAstPanel', { params: { panel_id: r.res.body.id }, headers: { ...key(), ...ifm(r.res.body.version) }, body: rest }), 'common.version_conflict');
      const d = await ok(call(HUB, 'deactivateAstPanel', { params: { panel_id: v2.body.id }, headers: { ...key(), ...ifm(v2.body.version) }, body: {} }));
      expect(d.body).toMatchObject({ is_active: false });
      expect((await call(HUB, 'listAstPanels', { params: {}, query: { organism_code: org }, headers: {} })).res.body.data.map((x: Row) => x['version_no'])).toEqual([2]);
    });

    it('S-23: technologist / read-only callers cannot write panels (403); tenant B cannot version or deactivate tenant A\'s panel (404)', async () => {
      const c = code('cfgperm'); const p = (await mkPanel(pbody(c))).body;
      for (const grants of [[WORK], [READ]]) await bad(call(HUB, 'createAstPanel', create(pbody(code('x'))), grants), 'auth.forbidden');
      const { code: _c, ...rest } = pbody(c);
      await bad(call(asB, 'versionAstPanel', { params: { panel_id: p.id }, headers: { ...key(), ...ifm(p.version) }, body: rest }), 'common.not_found');
      await bad(call(asB, 'deactivateAstPanel', { params: { panel_id: p.id }, headers: { ...key(), ...ifm(p.version) }, body: {} }), 'common.not_found');
      expect(await panelRows(c)).toHaveLength(1);
    });
  });

  describe('M11 assignAstPanel (AC-06.1)', () => {
    it('precedence on the real tables: (organism, site) > (organism) > (group, site) > (group) > (site) > (any); then the tie-break takes the lowest code', async () => {
      const org = await newOrganism(GROUP); const site = SITE;
      const mk = async (tag: string, scope: Row) => (await mkPanel(pbody(code(tag + orgN), scope))).body.id;
      const pOrgSite = await mk('os', { organism_code: org, specimen_site_code: site }); const pOrg = await mk('o', { organism_code: org });
      const pGrpSite = await mk('gs', { organism_group_code: GROUP, specimen_site_code: site });
      const t = await newIsolate({ organism: org, site });
      const r1 = await ok(call(HUB, 'assignAstPanel', assign(t.isolate, 3)));
      expect(r1.body.ast_panel.id).toBe(pOrgSite);
      expect(responseErrors('assignAstPanel', r1.body)).toEqual([]);
      const u2 = await newIsolate({ organism: org, site: null });                                                  // no site on the culture: (organism, site) cannot apply
      expect((await ok(call(HUB, 'assignAstPanel', assign(u2.isolate, 3)))).body.ast_panel.id).toBe(pOrg);
      expect(pGrpSite).toBeDefined();
      const org2 = await newOrganism();
      const hi = await mkPanel(pbody(code(`tie_b${orgN}`), { organism_code: org2 })); const lo = await mkPanel(pbody(code(`tie_a${orgN}`), { organism_code: org2 }));
      const u3 = await newIsolate({ organism: org2 });
      expect((await ok(call(HUB, 'assignAstPanel', assign(u3.isolate, 3)))).body.ast_panel.id).toBe(lo.body.id);
      expect(hi.body.id).not.toBe(lo.body.id);
    });

    it('creates one pending row per panel antibiotic with the panel method, never sets report_visibility (all rows "shown" by default), isolate gets panel + method + version 4; no match -> 400 /ast_panel_id', async () => {
      const org = await newOrganism(); const p = (await mkPanel(pbody(code(`eff${orgN}`), { organism_code: org }))).body;
      const t = await newIsolate({ organism: org });
      const r = await ok(call(HUB, 'assignAstPanel', assign(t.isolate, 3)));
      expect(r.body).toMatchObject({ version: 4, ast_method: 'mic', ast_panel: { id: p.id } });
      expect(await isoRow(t.isolate)).toMatchObject({ ast_panel_id: p.id, ast_method: 'mic', version: 4 });
      const rows = await astRows(t.isolate);
      expect(rows.map((x) => [x.antibiotic_code, x.method, x.is_reportable, x.panel_sort_order, x.off_panel, x.report_visibility])).toEqual([[ABX[0], 'mic', true, 0, false, 'shown'], [ABX[1], 'zone_diameter', false, 1, false, 'shown']]);
      const lone = await newOrganism(); const t2 = await newIsolate({ organism: lone });
      const err = await bad(call(HUB, 'assignAstPanel', assign(t2.isolate, 3)), 'common.validation_failed');
      expect(err.errors.map((x: Row) => x['path'])).toContain('/ast_panel_id');
    });

    it('S-01 / RLS: another tenant -> 404; a centre-scoped user of centre A1 on an isolate of centre A2 -> 404; read-only grant -> 403; final culture -> 409 micro.report_final_locked; pending isolate -> 409 micro.isolate_invalid_transition; nothing written', async () => {
      const org = await newOrganism(); await mkPanel(pbody(code(`rls${orgN}`), { organism_code: org }));
      const a2 = await newIsolate({ organism: org, centre: W.centreA2 });
      await bad(call(A1, 'assignAstPanel', assign(a2.isolate, 3)), 'common.not_found');
      await bad(call(asB, 'assignAstPanel', assign(a2.isolate, 3)), 'common.not_found');
      const a1 = await newIsolate({ organism: org });
      await bad(call(HUB, 'assignAstPanel', assign(a1.isolate, 3), [READ, MANAGE]), 'auth.forbidden');
      const fin = await newIsolate({ organism: org, cultureStatus: 'final_submitted' });
      await bad(call(HUB, 'assignAstPanel', assign(fin.isolate, 3)), 'micro.report_final_locked');
      const pend = await newIsolate({ organism: org, status: 'pending_id' });
      await bad(call(HUB, 'assignAstPanel', assign(pend.isolate, 3)), 'micro.isolate_invalid_transition');
      for (const t of [a2, a1, fin, pend]) expect(await astRows(t.isolate)).toEqual([]);
    });
  });

  describe('M12 recordAstResults (AC-06.2–06.6, AC-06.3a, AC-16.1)', () => {
    async function withPanel() {
      const org = await newOrganism(); const p = (await mkPanel(pbody(code(`rec${orgN}`), { organism_code: org, antibiotics: [{ antibiotic_code: ABX[0], is_reported_default: true }, { antibiotic_code: ABX[1], is_reported_default: true }, { antibiotic_code: 'colistin', is_reported_default: true }, { antibiotic_code: ABX[2], method: 'zone_diameter', is_reported_default: true }] }))).body;
      const t = await newIsolate({ organism: org }); await ok(call(HUB, 'assignAstPanel', assign(t.isolate, 3, { ast_panel_id: p.id })));
      return t;
    }
    it('mixed request, partial success committed with SAVEPOINTs against the real constraints: ok rows stored exactly as entered, refused entries leave nothing, CHECK ast_results__category_needs_value__ck never fires', async () => {
      const t = await withPanel();
      const std = { standard: 'CLSI', standard_version: '2026' };
      const r = await ok(call(HUB, 'recordAstResults', record(t.isolate, [e(ABX[0], 'mic', { raw_value: '<=0.25', category_code: 'S', ...std }), e(ABX[1], 'mic', { raw_value: 'abc' }), e(ABX[2], 'zone_diameter', { raw_value: '18' }),
        e('colistin', 'mic', { raw_value: '4', category_code: 'S', ...std }), e(ABX[3], 'mic', { raw_value: '2' }), e(ABX[3], 'mic', { category_code: 'S', ...std, add_to_isolate: true }), e(ABX[4], 'mic', { raw_value: '0.5', add_to_isolate: true })])));
      expect(r.status).toBe(200);
      const out = r.body.results as Row[];
      expect(out.map((x) => x['outcome'])).toEqual(['ok', 'error', 'ok', 'error', 'error', 'error', 'ok']);
      expect(out.map((x) => x['code'])).toEqual([undefined, 'micro.ast_value_invalid', undefined, 'micro.ast_category_not_allowed', 'micro.antibiotic_not_in_panel', 'micro.ast_value_invalid', undefined]);
      expect(responseErrors('recordAstResults', r.body)).toEqual([]);
      const rows = await astRows(t.isolate);
      const by = (a: string, m = 'mic') => rows.find((x) => x.antibiotic_code === a && x.method === m)!;
      expect(by(ABX[0])).toMatchObject({ raw_value: '<=0.25', raw_qualifier: '<=', unit_code: 'ug_ml', category_code: 'S', standard: 'CLSI', standard_version: '2026', standard_source: 'manual', interpretation_source: 'manual', version: 2, report_visibility: 'shown' });
      expect(Number(by(ABX[0]).raw_numeric)).toBe(0.25);
      expect(by(ABX[2], 'zone_diameter')).toMatchObject({ raw_value: '18', unit_code: 'mm', raw_qualifier: '=' });
      expect(by(ABX[1])).toMatchObject({ raw_value: null, category_code: null, version: 1 });
      expect(by('colistin')).toMatchObject({ raw_value: null, category_code: null });
      expect(by(ABX[4])).toMatchObject({ off_panel: true, raw_value: '0.5', version: 1 });
      expect(rows.some((x) => x.antibiotic_code === ABX[3] && x.method === 'mic')).toBe(false);
      expect(rows.filter((x) => x.category_code !== null && x.raw_value === null)).toEqual([]);
    });

    it('AC-16.1 / T-A4: report_visibility / provenance fields in an entry -> 400 whole request; every row this suite wrote is "shown"; a suppressed row keeps its visibility through an update', async () => {
      const t = await withPanel();
      for (const f of ['report_visibility', 'interpretation_source', 'standard_source', 'off_panel']) await bad(call(HUB, 'recordAstResults', record(t.isolate, [{ ...e(ABX[0], 'mic', { raw_value: '1' }), [f]: f === 'off_panel' ? true : 'shown' }])), 'common.validation_failed');
      await q(`UPDATE micro.ast_results SET report_visibility = 'suppressed_by_rule' WHERE isolate_id = $1 AND antibiotic_code = $2`, [t.isolate, ABX[0]]);
      const r = await ok(call(HUB, 'recordAstResults', record(t.isolate, [e(ABX[0], 'mic', { raw_value: '2' })])));
      expect(r.body.results[0].ast_result.report_visibility).toBe('suppressed_by_rule');
      expect((await astRows(t.isolate)).filter((x) => x.antibiotic_code !== ABX[0]).every((x) => x.report_visibility === 'shown')).toBe(true);
      expect(await q(`SELECT 1 FROM micro.ast_results WHERE tenant_id = $1 AND report_visibility <> 'shown' AND isolate_id <> $2 AND antibiotic_code LIKE 'syn_t10_%_${RUN}'`, [A, t.isolate])).toEqual([]);
    });

    it('whole-request refusals write nothing: final culture -> 409 micro.report_final_locked, withdrawn isolate -> 409 micro.isolate_invalid_transition, other tenant / other centre scope -> 404, read-only -> 403', async () => {
      const org = await newOrganism();
      const fin = await newIsolate({ organism: org, cultureStatus: 'final_submitted' }); const wd = await newIsolate({ organism: org, status: 'withdrawn' });
      await bad(call(HUB, 'recordAstResults', record(fin.isolate, [e(ABX[0], 'mic', { raw_value: '1', add_to_isolate: true })])), 'micro.report_final_locked');
      await bad(call(HUB, 'recordAstResults', record(wd.isolate, [e(ABX[0], 'mic', { raw_value: '1', add_to_isolate: true })])), 'micro.isolate_invalid_transition');
      const a2 = await newIsolate({ organism: org, centre: W.centreA2 });
      await bad(call(A1, 'recordAstResults', record(a2.isolate, [e(ABX[0], 'mic', { raw_value: '1', add_to_isolate: true })])), 'common.not_found');
      await bad(call(asB, 'recordAstResults', record(a2.isolate, [e(ABX[0], 'mic', { raw_value: '1', add_to_isolate: true })])), 'common.not_found');
      await bad(call(HUB, 'recordAstResults', record(a2.isolate, [e(ABX[0], 'mic', { raw_value: '1', add_to_isolate: true })]), [READ]), 'auth.forbidden');
      for (const t of [fin, wd, a2]) expect(await astRows(t.isolate)).toEqual([]);
    });

    it('two parallel requests on the same isolate both complete (culture-then-isolate lock order, no deadlock) and every antibiotic is stored once', async () => {
      const t = await withPanel();
      const out = await Promise.all([call(HUB, 'recordAstResults', record(t.isolate, [e(ABX[0], 'mic', { raw_value: '1' }), e(ABX[1], 'mic', { raw_value: '2' })])),
        call(HUB, 'recordAstResults', record(t.isolate, [e(ABX[1], 'mic', { raw_value: '3' }), e(ABX[0], 'mic', { raw_value: '4' })]))]);
      expect(out.filter((o) => o.err).map((o) => o.err?.code ?? String(o.err))).toEqual([]);
      const rows = await astRows(t.isolate);
      expect(new Set(rows.map((x) => `${x.antibiotic_code}/${x.method}`)).size).toBe(rows.length);
    });
  });

  describe('done_when perf: p95 <= 300 ms for 60 entries on the 10x seed', () => {
    it(`seeds ${SEED_ISOLATES} isolates x 20 AST rows, then 20 timed 60-entry requests (single transaction, batched reads) -> p95 <= 300 ms`, async () => {
      const seedOrg = await newOrganism(); const c0 = await newIsolate({ organism: seedOrg });
      const c = await admin.connect();
      try {                                                                                                          // bulk working set: isolates + AST rows of other cultures of the tenant (FKs / triggers off for the seed only)
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query(`INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, source, raw_value, version, created_by, updated_by)
          SELECT gen_random_uuid(), $1, $2, $3, gen_random_uuid(), 'syn_t10_seed_' || (g % 20), 'mic', 'manual', '2', 1, $4, $4 FROM generate_series(1, $5::int) g`, [A, W.centreA1, c0.culture, SYS, SEED_ISOLATES * 20]);
        await c.query('COMMIT');
      } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
      const org = await newOrganism();
      const p = (await mkPanel(pbody(code(`perf${orgN}`), { organism_code: org, antibiotics: ABX.map((a, n) => ({ antibiotic_code: a, ...(n === 1 ? { method: 'zone_diameter' } : {}), is_reported_default: true })) }))).body;
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t = await newIsolate({ organism: org });
        await ok(call(HUB, 'assignAstPanel', assign(t.isolate, 3, { ast_panel_id: p.id })));
        const r = await call(HUB, 'recordAstResults', record(t.isolate, ABX.map((a, n) => e(a, n === 1 ? 'zone_diameter' : 'mic', { raw_value: n === 1 ? '20' : '<=0.5', category_code: n === 1 ? undefined : 'S', standard: n === 1 ? undefined : 'CLSI', standard_version: n === 1 ? undefined : '2026' }))));
        if (r.err) throw r.err;
        expect(r.res.body.results.filter((x: Row) => x['outcome'] === 'error').length).toBeLessThanOrEqual(0);
        times.push(r.ms);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
      console.info(`C10 T-10 recordAstResults 60 entries: p50 ${times[10]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${times.at(-1)!.toFixed(0)} ms (seed ${SEED_ISOLATES} isolates)`);
      expect(p95).toBeLessThanOrEqual(300);
    }, 120_000);
  });
});
