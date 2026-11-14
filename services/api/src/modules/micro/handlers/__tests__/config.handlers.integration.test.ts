// C10 T-05 — config handlers M23–M28, M39, M40 against the migrated database (06 row T-05; 02-TRD §5.4; 05-SCHEMA settings / plating_protocols / plating_protocol_media /
// plating_protocol_keys / cs_* + g_cs_* + v_*; PRD AC-14.1–14.5; 07-SECURITY S-23, S-24, T-E1, T-E2; 08 A17 D-64, P-22).
// Needs a database with the micro DDL + RLS of 05-SCHEMA §8/§4 applied (C0 prerequisite, 06 §1): LIMS_TEST_DATABASE_URL = role lims_api (RLS on),
// LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under LIMS_T05_REQUIRE_DB=1 where "database is provided" fails.
// SEAMS: as config.handlers.test.ts (req {params, query, headers, body}; ctx.tx = the request tx under RLS; permission via ctx.ports.IdentityPort.assertRole).
// ASSUMED (spec silent; listed in .orchestra/notes/C10.T-05-tests.md):
//   - no settings row = column defaults at version 1; PUT with If-Match "1" on a missing row creates it (lab T-29 precedent); other If-Match on a missing row -> 409.
//   - PUT settings: a value outside the TRD range or manual_ast_standard outside {CLSI,EUCAST} is a 400 common.validation_failed with the field path (never a 500 CHECK violation).
//   - M24: an extra that does not belong to the set (gram_class on media) -> 400 at /<field>; organism_group_code must exist+active in v_organism_groups -> else 400 /organism_group_code.
//   - M24 creating a tenant row needs no If-Match; updating an existing tenant row needs the current `version` (428 without, 409 stale); the global row is never written.
//   - M26/M27: a media_code / default_specimen_site_code must exist + be active in v_media / v_specimen_sites -> else 400 (/media/<i>/media_code, /default_specimen_site_code);
//     read_schedule_hours not strictly ascending -> 400 /read_schedule_hours. A v(n+1) may reuse the applies_to keys of its own predecessor.
//   - M27/M28 `{protocol_id}` = the row id of the CURRENT version; its If-Match = that row's `version`. Another tenant's id -> 404 common.not_found.
//   - M28 deactivate frees the protocol's applies_to keys (partial unique index WHERE is_active).
//   - AC-14.2 second half ("cultures/isolates keep the version they used") has no culture rows yet: covered by T-08/T-09 tests.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError, LimsError } from '../../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { handlers } from '../index.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T05_REQUIRE_DB'] === '1';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEM = '01a1a98a-ac40-7000-8000-00000000a500';
const u = (n: number) => `0190c607-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = new Date('2026-06-15T05:00:30.000Z');
const RUN = Date.now().toString(36);
const READ = 'micro.culture.read';
const MANAGE = 'micro.config.manage';
const ALL = [READ, MANAGE, 'micro.culture.work'] as const;

const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'micro.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`);
};

// ------------------------------------------------------------------ database helpers
let api: pg.Pool;
let admin: pg.Pool;
const claims = (tenantId: string) => JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' });
const sql = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;

interface Probe { roleCalls: { permission: string }[] }
interface Opts { grants?: readonly string[]; tenant?: string }
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined as unknown, ...o });
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
let reqN = 0;
const idem = () => ({ 'idempotency-key': `t05-${RUN}-${reqN++}` });

/** One request = one committed tx under RLS (claims of the ctx tenant); a throw rolls back, like the core request wrapper. */
async function call(operationId: string, r: ReturnType<typeof req>, o: Opts = {}): Promise<{ status: number; body: any; probe: Probe }> {
  const tenant = o.tenant ?? A;
  const probe: Probe = { roleCalls: [] };
  const grants = o.grants ?? ALL;
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: tenant, tx: client, requestId: u(0x9000 + reqN++), now: () => NOW,
      actor: { type: 'user', id: SYS, membershipId: MEM },
      ports: { IdentityPort: {
        async assertRole(_c: unknown, x: { permission: string }) { probe.roleCalls.push(x); if (!grants.includes(x?.permission)) throw new LimsError('auth.forbidden'); },
        async getActor() { return { actor: { type: 'user', id: SYS }, permissions: [...grants], centreScope: { all: true, centreIds: [] }, isLocked: false }; },
      } },
      events: { publish: async () => ({ eventId: u(0x8000), duplicate: false }) },
      audit: { access: async () => undefined },
    };
    const out = await (handlers as unknown as Record<string, (r: unknown, c: unknown) => Promise<{ status: number; body?: any }>>)[operationId]!(r, ctx);
    await client.query('COMMIT');
    return { status: out.status, body: out.body, probe };
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };
const expectCode = (e: any, code: string, status: number) => { expect(isLimsError(e, code as never), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(status); };
const badPath = (e: any, path: string) => { expectCode(e, 'common.validation_failed', 400); expect(e.errors?.[0]?.path, JSON.stringify(e.errors)).toBe(path); };

// ------------------------------------------------------------------ shortcuts
const getSettings = (o: Opts = {}) => call('getMicroSettings', req(), o);
const putSettings = (body: unknown, h: object, o: Opts = {}) => call('updateMicroSettings', req({ headers: h, body }), o);
const SETTINGS = { zone_suggestion_enabled: false, mic_suggestion_enabled: true, default_final_no_growth_hours: 72, early_final_requires_reason: false, recent_window_days: 14 };
const listSet = (set: string, query: object = {}, o: Opts = {}) => call('listMicroCodedSet', req({ params: { set_name: set }, query }), o);
const putCode = (set: string, code: string, body: unknown, h: object = {}, o: Opts = {}) => call('upsertMicroCode', req({ params: { set_name: set, code }, headers: h, body }), o);
const listProtocols = (query: object = {}, o: Opts = {}) => call('listPlatingProtocols', req({ query }), o);
const createProtocol = (body: unknown, o: Opts = {}) => call('createPlatingProtocol', req({ headers: idem(), body }), o);
const versionProtocol = (id: string, body: unknown, h: object, o: Opts = {}) => call('versionPlatingProtocol', req({ params: { protocol_id: id }, headers: { ...idem(), ...h }, body }), o);
const deactivateProtocol = (id: string, h: object, o: Opts = {}) => call('deactivatePlatingProtocol', req({ params: { protocol_id: id }, headers: h, body: {} }), o);

const G_MEDIA = `zt05m_${RUN}`;          // synthetic GLOBAL media code (inserted with the superuser; lims_api has no write grant on G tables)
const G_SITE = `zt05s_${RUN}`;
const G_ORG = `zt05o_${RUN}`;
const G_GROUP = `zt05g_${RUN}`;
let codeN = 0;
const newCode = (p: string) => `zt05${p}_${RUN}_${codeN++}`;
let stN = 0;
const newKey = () => `zt05st_${RUN}_${stN++}`;
const protocolBody = (code: string, over: Record<string, unknown> = {}) => ({
  code, display: `Synthetic ${code}`, read_schedule_hours: [24, 48], final_no_growth_hours: 48, requires_gram_stain: false,
  default_specimen_site_code: G_SITE, media: [{ media_code: G_MEDIA, incubation_text: '35C, O2' }], applies_to: [{ specimen_type_code: newKey() }], ...over,
});
const protoRows = (tenant: string, code: string) => sql('SELECT * FROM micro.plating_protocols WHERE tenant_id = $1 AND code = $2 ORDER BY version_no', [tenant, code]);

describe.skipIf(!live && !REQUIRE)('C10-T05 config handlers (live database)', () => {
  it('database is provided', () => { expect(live, 'LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL').toBe(true); });
  if (!live) return;

  beforeAll(async () => {
    api = new pg.Pool({ connectionString: API_URL, max: 8 });
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 3 });
    await sql('INSERT INTO micro.g_cs_organism_groups (code, display) VALUES ($1, $2) ON CONFLICT DO NOTHING', [G_GROUP, 'Synthetic group']);
    await sql('INSERT INTO micro.g_cs_organisms (code, display, sort_order, organism_group_code) VALUES ($1, $2, 5, $3) ON CONFLICT DO NOTHING', [G_ORG, 'Synthetic global organism', G_GROUP]);
    await sql('INSERT INTO micro.g_cs_media (code, display, sort_order) VALUES ($1, $2, 5) ON CONFLICT DO NOTHING', [G_MEDIA, 'Synthetic global medium']);
    await sql('INSERT INTO micro.g_cs_specimen_sites (code, display, sort_order) VALUES ($1, $2, 5) ON CONFLICT DO NOTHING', [G_SITE, 'Synthetic global site']);
  });
  afterAll(async () => { await api?.end(); await admin?.end(); });

  // ================================================================== M39 / M40 settings
  describe('M39 getMicroSettings / M40 updateMicroSettings (AC-14.5, P-22)', () => {
    it('GET with no row -> defaults (TRD §5.4), schema-valid, version 1, manual_ast_standard absent (never null); asks only micro.culture.read (D-64)', async () => {
      const r = await getSettings({ tenant: B, grants: [READ] });
      expect(r.status).toBe(200);
      expect(schemaErrors('MicroSettingsDto', r.body)).toEqual([]);
      expect(r.body).toMatchObject({ version: 1, zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48, early_final_requires_reason: true, recent_window_days: 7, is_active: true });
      expect('manual_ast_standard' in r.body).toBe(false);
      expect(r.probe.roleCalls.map((x) => x.permission)).toEqual([READ]);
    });

    it('PUT with If-Match "1" on a missing row creates it lazily (ON CONFLICT (tenant_id) DO NOTHING); GET then reflects it; the other tenant keeps the defaults', async () => {
      const t = A;
      await sql('DELETE FROM micro.settings WHERE tenant_id = $1', [t]);
      const r = await putSettings({ ...SETTINGS, manual_ast_standard: 'EUCAST' }, ifm(1));
      expect(r.status).toBe(200);
      expect(schemaErrors('MicroSettingsDto', r.body)).toEqual([]);
      expect(r.body).toMatchObject({ ...SETTINGS, manual_ast_standard: 'EUCAST' });
      expect(await sql('SELECT 1 FROM micro.settings WHERE tenant_id = $1', [t])).toHaveLength(1);
      expect((await getSettings()).body).toMatchObject({ ...SETTINGS, manual_ast_standard: 'EUCAST', version: r.body.version });
      expect((await getSettings({ tenant: B })).body).toMatchObject({ default_final_no_growth_hours: 48, recent_window_days: 7 });
      expect(r.probe.roleCalls.map((x) => x.permission)).toEqual([MANAGE]);
    });

    it('P-22: two parallel first PUTs on a missing row -> exactly one settings row, every outcome is a success or common.version_conflict (never a 500 / unique violation)', async () => {
      await sql('DELETE FROM micro.settings WHERE tenant_id = $1', [A]);
      const out = await Promise.allSettled([putSettings({ ...SETTINGS, recent_window_days: 3 }, ifm(1)), putSettings({ ...SETTINGS, recent_window_days: 4 }, ifm(1))]);
      expect(out.some((o) => o.status === 'fulfilled')).toBe(true);
      for (const o of out) if (o.status === 'rejected') expectCode(o.reason, 'common.version_conflict', 409);
      expect(await sql('SELECT 1 FROM micro.settings WHERE tenant_id = $1', [A])).toHaveLength(1);
    });

    it('If-Match: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; the current version succeeds and bumps the version by 1', async () => {
      const cur = (await getSettings()).body.version as number;
      expectCode(await failure(putSettings(SETTINGS, {})), 'common.precondition_required', 428);
      expectCode(await failure(putSettings(SETTINGS, ifm(cur + 5))), 'common.version_conflict', 409);
      const ok = await putSettings({ ...SETTINGS, recent_window_days: 9 }, ifm(cur));
      expect(ok.body.version).toBe(cur + 1);
      expect(ok.body.recent_window_days).toBe(9);
    });

    it.each([
      ['default_final_no_growth_hours', 0], ['default_final_no_growth_hours', 721], ['recent_window_days', 0], ['recent_window_days', 32], ['manual_ast_standard', 'ECOFF'],
    ])('AC-14.5: %s=%j is refused with 400 at /%s and the stored row is unchanged', async (field, value) => {
      const before = await getSettings();
      badPath(await failure(putSettings({ ...SETTINGS, [field]: value }, ifm(before.body.version))), `/${field}`);
      expect((await getSettings()).body).toEqual(before.body);
    });

    it('boundary values 1 / 720 hours and 1 / 31 days are accepted', async () => {
      let v = (await getSettings()).body.version as number;
      v = (await putSettings({ ...SETTINGS, default_final_no_growth_hours: 1, recent_window_days: 1 }, ifm(v))).body.version;
      const r = await putSettings({ ...SETTINGS, default_final_no_growth_hours: 720, recent_window_days: 31 }, ifm(v));
      expect(r.body).toMatchObject({ default_final_no_growth_hours: 720, recent_window_days: 31 });
    });

    it('unset: ["manual_ast_standard"] clears the standard (field absent afterwards); unset together with a value -> 400', async () => {
      let v = (await getSettings()).body.version as number;
      v = (await putSettings({ ...SETTINGS, manual_ast_standard: 'CLSI' }, ifm(v))).body.version;
      const bad = await failure(putSettings({ ...SETTINGS, manual_ast_standard: 'CLSI', unset: ['manual_ast_standard'] }, ifm(v)));
      expectCode(bad, 'common.validation_failed', 400);
      const r = await putSettings({ ...SETTINGS, unset: ['manual_ast_standard'] }, ifm(v));
      expect('manual_ast_standard' in r.body).toBe(false);
      expect((await sql('SELECT manual_ast_standard FROM micro.settings WHERE tenant_id = $1', [A]))[0].manual_ast_standard).toBeNull();
    });

    it('S-23: writes need micro.config.manage (read-only / work-only callers -> 403, row unchanged)', async () => {
      const before = await getSettings();
      for (const grants of [[READ], [READ, 'micro.culture.work']]) {
        expectCode(await failure(putSettings({ ...SETTINGS, recent_window_days: 2 }, ifm(before.body.version), { grants })), 'auth.forbidden', 403);
      }
      expect((await getSettings()).body).toEqual(before.body);
    });

    it('GET without micro.culture.read -> 403 auth.forbidden', async () => {
      expectCode(await failure(getSettings({ grants: [MANAGE] })), 'auth.forbidden', 403);
    });
  });

  // ================================================================== M23 / M24 coded sets
  describe('M23 listMicroCodedSet / M24 upsertMicroCode (AC-14.1, AC-14.3, S-24)', () => {
    it('M23 lists global rows with source "global", schema-valid, sorted by sort_order; q is a prefix filter; asks only micro.culture.read', async () => {
      const r = await listSet('organisms', {}, { grants: [READ] });
      expect(r.status).toBe(200);
      for (const row of r.body.data) expect(schemaErrors('MicroCodeDto', row), row.code).toEqual([]);
      const mine = r.body.data.find((x: any) => x.code === G_ORG);
      expect(mine).toMatchObject({ display: 'Synthetic global organism', source: 'global', is_active: true, organism_group_code: G_GROUP });
      const so = r.body.data.map((x: any) => x.sort_order);
      expect(so).toEqual([...so].sort((a: number, b: number) => a - b));
      expect(r.probe.roleCalls.map((x) => x.permission)).toEqual([READ]);
      const q = await listSet('organisms', { q: `zt05o_${RUN}`.slice(0, 12) });
      expect(q.body.data.length).toBeGreaterThan(0);
      for (const row of q.body.data) expect(row.code.startsWith(`zt05o_${RUN}`.slice(0, 12))).toBe(true);
    });

    it('M23 on every set_name answers 200 with a data array; ast_interpretations rows carry `standard`', async () => {
      for (const s of ['organisms', 'organism_groups', 'antibiotics', 'media', 'specimen_sites', 'growth_codes', 'culture_outcomes', 'isolate_withdraw_reasons', 'culture_cancel_reasons', 'record_ignore_reasons', 'ast_interpretations']) {
        const r = await listSet(s);
        expect(Array.isArray(r.body.data), s).toBe(true);
        if (s === 'ast_interpretations') for (const row of r.body.data) expect(['CLSI', 'EUCAST', 'ECOFF'], row.code).toContain(row.standard);
      }
    });

    it('AC-14.1: a tenant row shadows the global code by `code` (one entry, source tenant, tenant display); the global row and the other tenant are untouched', async () => {
      const r = await putCode('organisms', G_ORG, { display: 'Tenant display', sort_order: 7, is_active: true });
      expect(r.status).toBe(200);
      expect(schemaErrors('MicroCodeDto', r.body)).toEqual([]);
      expect(r.body).toMatchObject({ code: G_ORG, display: 'Tenant display', sort_order: 7, source: 'tenant' });
      const mine = (await listSet('organisms')).body.data.filter((x: any) => x.code === G_ORG);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ display: 'Tenant display', source: 'tenant' });
      expect((await listSet('organisms', {}, { tenant: B })).body.data.find((x: any) => x.code === G_ORG)).toMatchObject({ display: 'Synthetic global organism', source: 'global' });
      expect((await sql('SELECT display FROM micro.g_cs_organisms WHERE code = $1', [G_ORG]))[0].display).toBe('Synthetic global organism');
      expect(r.probe.roleCalls.map((x) => x.permission)).toEqual([MANAGE]);
    });

    it('AC-14.1: deactivating a global code for a tenant = tenant row is_active=false: hidden by default, listed with include_inactive, still active for the other tenant', async () => {
      const code = `zt05a_${RUN}`;
      await sql('INSERT INTO micro.g_cs_antibiotics (code, display, sort_order) VALUES ($1, $2, 3) ON CONFLICT DO NOTHING', [code, 'Synthetic global antibiotic']);
      const r = await putCode('antibiotics', code, { display: 'Synthetic global antibiotic', sort_order: 3, is_active: false });
      expect(r.body).toMatchObject({ code, is_active: false, source: 'tenant' });
      expect((await listSet('antibiotics')).body.data.some((x: any) => x.code === code)).toBe(false);
      expect((await listSet('antibiotics', { include_inactive: true })).body.data.find((x: any) => x.code === code)).toMatchObject({ is_active: false, source: 'tenant' });
      expect((await listSet('antibiotics', {}, { tenant: B })).body.data.find((x: any) => x.code === code)).toMatchObject({ is_active: true, source: 'global' });
      expect((await sql('SELECT is_active FROM micro.g_cs_antibiotics WHERE code = $1', [code]))[0].is_active).toBe(true);
    });

    it('a tenant-only code is invisible to the other tenant (RLS + explicit tenant filter)', async () => {
      const code = newCode('c');
      await putCode('growth_codes', code, { display: 'Tenant only', sort_order: 1, is_active: true, indicates_growth: true });
      expect((await listSet('growth_codes')).body.data.some((x: any) => x.code === code)).toBe(true);
      expect((await listSet('growth_codes', {}, { tenant: B })).body.data.some((x: any) => x.code === code)).toBe(false);
    });

    it('updating an existing tenant row needs If-Match: missing -> 428, stale -> 409, current -> 200 with version+1; creating needs none', async () => {
      const code = newCode('c');
      const created = await putCode('growth_codes', code, { display: 'First', sort_order: 1, is_active: true, indicates_growth: true });
      expect(created.status).toBe(200);
      const [row] = await sql('SELECT version FROM micro.cs_growth_codes WHERE tenant_id = $1 AND code = $2', [A, code]);
      expectCode(await failure(putCode('growth_codes', code, { display: 'Second', sort_order: 1, is_active: true })), 'common.precondition_required', 428);
      expectCode(await failure(putCode('growth_codes', code, { display: 'Second', sort_order: 1, is_active: true }, ifm(row.version + 3))), 'common.version_conflict', 409);
      // update keeps the COALESCE behaviour: the omitted extra keeps its stored value
      const ok = await putCode('growth_codes', code, { display: 'Second', sort_order: 1, is_active: true }, ifm(row.version));
      expect(ok.body.indicates_growth).toBe(true);
      expect(ok.body.display).toBe('Second');
      expect((await sql('SELECT version FROM micro.cs_growth_codes WHERE tenant_id = $1 AND code = $2', [A, code]))[0].version).toBe(row.version + 1);
    });

    it('S-24 / T-E2: PUT /coded-sets/ast_interpretations/codes/S -> 403 auth.forbidden (even with micro.config.manage); nothing is created, the global categories are unchanged', async () => {
      const before = await sql('SELECT code, standard FROM micro.g_cs_ast_interpretations ORDER BY code, standard');
      expectCode(await failure(putCode('ast_interpretations', 'S', { display: 'Hacked', sort_order: 1, is_active: true })), 'auth.forbidden', 403);
      expect(await sql('SELECT code, standard FROM micro.g_cs_ast_interpretations ORDER BY code, standard')).toEqual(before);
    });

    it('S-23: M24 by a caller without micro.config.manage -> 403 and no row', async () => {
      const code = newCode('c');
      expectCode(await failure(putCode('growth_codes', code, { display: 'x', sort_order: 1, is_active: true }, {}, { grants: [READ, 'micro.culture.work'] })), 'auth.forbidden', 403);
      expect(await sql('SELECT 1 FROM micro.cs_growth_codes WHERE tenant_id = $1 AND code = $2', [A, code])).toHaveLength(0);
    });

    it('AC-14.3: snomed_ct_concept_id is optional (absent -> stored NULL, DTO omits it); ^[0-9]{6,18}$ is enforced (400 /snomed_ct_concept_id); a valid value round-trips', async () => {
      const code = newCode('o');
      const r = await putCode('organisms', code, { display: 'No snomed', sort_order: 1, is_active: true });
      expect('snomed_ct_concept_id' in r.body).toBe(false);
      expect((await sql('SELECT snomed_ct_concept_id FROM micro.cs_organisms WHERE tenant_id = $1 AND code = $2', [A, code]))[0].snomed_ct_concept_id).toBeNull();
      for (const bad of ['12345', 'abc123', '1'.repeat(19), '12 3456']) {
        badPath(await failure(putCode('organisms', newCode('o'), { display: 'x', sort_order: 1, is_active: true, snomed_ct_concept_id: bad })), '/snomed_ct_concept_id');
      }
      const ok = await putCode('organisms', newCode('o'), { display: 'With snomed', sort_order: 1, is_active: true, snomed_ct_concept_id: '1234567' });
      expect(ok.body.snomed_ct_concept_id).toBe('1234567');
    });

    it('AC-14.3: no seeded global organism carries a SNOMED CT id (licensing UNVERIFIED)', async () => {
      expect(await sql('SELECT code FROM micro.g_cs_organisms WHERE snomed_ct_concept_id IS NOT NULL')).toEqual([]);
    });

    it('extras are those of the set: gram_class on media -> 400 /gram_class; an unknown organism_group_code -> 400 /organism_group_code; a known one is accepted', async () => {
      badPath(await failure(putCode('media', newCode('m'), { display: 'x', sort_order: 1, is_active: true, gram_class: 'yeast' })), '/gram_class');
      badPath(await failure(putCode('organisms', newCode('o'), { display: 'x', sort_order: 1, is_active: true, organism_group_code: 'no_such_group_zz' })), '/organism_group_code');
      const ok = await putCode('organisms', newCode('o'), { display: 'x', sort_order: 1, is_active: true, organism_group_code: G_GROUP });
      expect(ok.body.organism_group_code).toBe(G_GROUP);
    });

    it('a code that passes the Code schema but violates the DB CHECK ^[a-z0-9_]{2,64}$ -> 400 /code (never a 500)', async () => {
      badPath(await failure(putCode('growth_codes', 'Bad-Code.1', { display: 'x', sort_order: 1, is_active: true, indicates_growth: true })), '/code');
    });

    // review item 1: MicroCodeDto declares the set extras, so M23 and M24 must return them
    it('M23/M24 return indicates_growth (growth_codes) and result_flag + requires_isolate (culture_outcomes), schema-valid; a stored false/N is returned, not omitted', async () => {
      const g = newCode('c');
      const gp = await putCode('growth_codes', g, { display: 'Grows', sort_order: 1, is_active: true, indicates_growth: true });
      expect(schemaErrors('MicroCodeDto', gp.body)).toEqual([]);
      expect(gp.body.indicates_growth).toBe(true);
      const g0 = newCode('c');
      expect((await putCode('growth_codes', g0, { display: 'No growth', sort_order: 2, is_active: true, indicates_growth: false })).body.indicates_growth).toBe(false);
      const gl = (await listSet('growth_codes')).body.data;
      expect(gl.find((x: any) => x.code === g).indicates_growth).toBe(true);
      expect(gl.find((x: any) => x.code === g0).indicates_growth).toBe(false);
      const o = newCode('c');
      const op = await putCode('culture_outcomes', o, { display: 'Alert outcome', sort_order: 1, is_active: true, result_flag: 'A', requires_isolate: true });
      expect(schemaErrors('MicroCodeDto', op.body)).toEqual([]);
      expect(op.body).toMatchObject({ result_flag: 'A', requires_isolate: true });
      const ol = (await listSet('culture_outcomes')).body.data;
      expect(ol.find((x: any) => x.code === o)).toMatchObject({ result_flag: 'A', requires_isolate: true });
      for (const row of ol) expect(schemaErrors('MicroCodeDto', row), row.code).toEqual([]);
      // seeded globals (05-SCHEMA §8): no_growth = N,false ; growth_reported = A,true
      expect(ol.find((x: any) => x.code === 'growth_reported')).toMatchObject({ result_flag: 'A', requires_isolate: true });
    });

    // review item 2: no invented defaults — 05-SCHEMA §8 declares these NOT NULL with no DEFAULT
    it.each([
      ['growth_codes', { display: 'x', sort_order: 1, is_active: true }, '/indicates_growth'],
      ['culture_outcomes', { display: 'x', sort_order: 1, is_active: true, requires_isolate: false }, '/result_flag'],
      ['culture_outcomes', { display: 'x', sort_order: 1, is_active: true, result_flag: 'N' }, '/requires_isolate'],
    ])('new tenant row in %s without its required extra -> 400 common.validation_failed %s (common.field_required); no row is stored', async (set, body, path) => {
      const code = newCode('c');
      const e = await failure(putCode(set, code, body));
      badPath(e, path);
      expect(e.errors[0].code).toBe('common.field_required');
      expect(await sql(`SELECT 1 FROM micro.cs_${set} WHERE tenant_id = $1 AND code = $2`, [A, code])).toHaveLength(0);
    });

    it('a tenant shadow of a GLOBAL growth code (no tenant row yet) is an insert: it must state indicates_growth too', async () => {
      badPath(await failure(putCode('growth_codes', 'growth', { display: 'Tenant growth', sort_order: 1, is_active: true })), '/indicates_growth');
    });
  });

  // ================================================================== M25–M28 plating protocols
  describe('M25 listPlatingProtocols / M26 create / M27 version / M28 deactivate (AC-14.2, code_duplicate)', () => {
    it('M26 creates version 1: 201, schema-valid, media sort_order 0.., applies_to echoed, rows written; asks only micro.config.manage', async () => {
      const code = newCode('p');
      const body = protocolBody(code, { media: [{ media_code: G_MEDIA, incubation_text: '35C, O2' }, { media_code: G_MEDIA }] });
      const r = await createProtocol(body);
      expect(r.status).toBe(201);
      expect(schemaErrors('PlatingProtocolDto', r.body)).toEqual([]);
      expect(r.body).toMatchObject({ code, version_no: 1, display: body.display, read_schedule_hours: [24, 48], final_no_growth_hours: 48, requires_gram_stain: false, is_active: true, default_specimen_site_code: G_SITE });
      expect('superseded_at' in r.body).toBe(false);
      expect(r.body.media.map((m: any) => m.sort_order)).toEqual([0, 1]);
      expect(r.body.applies_to).toEqual(body.applies_to);
      expect(r.probe.roleCalls.map((x) => x.permission)).toEqual([MANAGE]);
      expect(await protoRows(A, code)).toHaveLength(1);
      expect(await sql('SELECT 1 FROM micro.plating_protocol_media WHERE tenant_id = $1 AND protocol_id = $2', [A, r.body.id])).toHaveLength(2);
    });

    it('M26 validation: read_schedule_hours not strictly ascending -> 400 /read_schedule_hours; unknown media_code -> 400 /media/0/media_code; unknown site -> 400 /default_specimen_site_code; nothing written', async () => {
      const code = newCode('p');
      badPath(await failure(createProtocol(protocolBody(code, { read_schedule_hours: [48, 24] }))), '/read_schedule_hours');
      badPath(await failure(createProtocol(protocolBody(code, { read_schedule_hours: [24, 24] }))), '/read_schedule_hours');
      badPath(await failure(createProtocol(protocolBody(code, { media: [{ media_code: 'no_such_medium_zz' }] }))), '/media/0/media_code');
      badPath(await failure(createProtocol(protocolBody(code, { default_specimen_site_code: 'no_such_site_zz' }))), '/default_specimen_site_code');
      expect(await protoRows(A, code)).toHaveLength(0);
    });

    it('M26: a code already used by an active protocol -> 409 micro.code_duplicate, nothing written for the second call', async () => {
      const code = newCode('p');
      await createProtocol(protocolBody(code));
      expectCode(await failure(createProtocol(protocolBody(code))), 'micro.code_duplicate', 409);
      expect(await protoRows(A, code)).toHaveLength(1);
    });

    it('M26: an applies_to key already used by another ACTIVE protocol -> 409 micro.code_duplicate and the new protocol is not created (atomic)', async () => {
      const key = newKey();
      await createProtocol(protocolBody(newCode('p'), { applies_to: [{ specimen_type_code: key }] }));
      const code = newCode('p');
      expectCode(await failure(createProtocol(protocolBody(code, { applies_to: [{ specimen_type_code: newKey() }, { specimen_type_code: key }] }))), 'micro.code_duplicate', 409);
      expect(await protoRows(A, code)).toHaveLength(0);
      expect(await sql('SELECT 1 FROM micro.plating_protocol_keys WHERE tenant_id = $1 AND protocol_code = $2', [A, code])).toHaveLength(0);
    });

    it('the same applies_to key in the other tenant is not a clash (keys are per tenant)', async () => {
      const key = newKey();
      await createProtocol(protocolBody(newCode('p'), { applies_to: [{ specimen_type_code: key }] }));
      const r = await createProtocol(protocolBody(newCode('p'), { applies_to: [{ specimen_type_code: key }] }), { tenant: B });
      expect(r.status).toBe(201);
    });

    it('S-23: M26/M27/M28 by a caller without micro.config.manage -> 403, no rows', async () => {
      const code = newCode('p');
      const g = [READ, 'micro.culture.work'];
      expectCode(await failure(createProtocol(protocolBody(code), { grants: g })), 'auth.forbidden', 403);
      expect(await protoRows(A, code)).toHaveLength(0);
      const real = (await createProtocol(protocolBody(newCode('p')))).body;
      expectCode(await failure(versionProtocol(real.id, protocolBody('x'), ifm(real.version), { grants: g })), 'auth.forbidden', 403);
      expectCode(await failure(deactivateProtocol(real.id, ifm(real.version), { grants: g })), 'auth.forbidden', 403);
    });

    it('M27 (AC-14.2): a new version supersedes the previous — v2 has the same code and version_no 2, v1 gets superseded_at, v1 content is untouched; v2 may reuse v1\'s applies_to keys', async () => {
      const code = newCode('p');
      const key = newKey();
      const v1 = (await createProtocol(protocolBody(code, { applies_to: [{ specimen_type_code: key }], read_schedule_hours: [24] }))).body;
      const { code: _c, ...rest } = protocolBody(code, { applies_to: [{ specimen_type_code: key }], read_schedule_hours: [12, 36], display: 'Version two' });
      const r = await versionProtocol(v1.id, rest, ifm(v1.version));
      expect(r.status).toBe(200);                                       // TRD M27 "new version" (not declared 201)
      expect(schemaErrors('PlatingProtocolDto', r.body)).toEqual([]);
      expect(r.body).toMatchObject({ code, version_no: 2, display: 'Version two', read_schedule_hours: [12, 36], is_active: true });
      expect(r.body.id).not.toBe(v1.id);
      expect('superseded_at' in r.body).toBe(false);
      const rows = await protoRows(A, code);
      expect(rows.map((x) => x.version_no)).toEqual([1, 2]);
      expect(rows[0].superseded_at).not.toBeNull();
      expect(rows[1].superseded_at).toBeNull();
      expect(rows[0].read_schedule_hours).toEqual([24]);
      expect(rows[0].display).toBe(`Synthetic ${code}`);
      expect(r.probe.roleCalls.map((x) => x.permission)).toEqual([MANAGE]);
    });

    it('M27: If-Match missing -> 428, stale -> 409; an applies_to clash with ANOTHER protocol -> 409 micro.code_duplicate and the previous version is NOT superseded', async () => {
      const clashKey = newKey();
      await createProtocol(protocolBody(newCode('p'), { applies_to: [{ specimen_type_code: clashKey }] }));
      const code = newCode('p');
      const v1 = (await createProtocol(protocolBody(code))).body;
      const { code: _c, ...rest } = protocolBody(code);
      expectCode(await failure(versionProtocol(v1.id, rest, {})), 'common.precondition_required', 428);
      expectCode(await failure(versionProtocol(v1.id, rest, ifm(v1.version + 4))), 'common.version_conflict', 409);
      expectCode(await failure(versionProtocol(v1.id, { ...rest, applies_to: [{ specimen_type_code: clashKey }] }, ifm(v1.version))), 'micro.code_duplicate', 409);
      const rows = await protoRows(A, code);
      expect(rows).toHaveLength(1);
      expect(rows[0].superseded_at).toBeNull();
    });

    it('M27/M28 on another tenant\'s protocol -> 404 common.not_found (no existence leak)', async () => {
      const v1 = (await createProtocol(protocolBody(newCode('p')))).body;
      const { code: _c, ...rest } = protocolBody('x');
      expectCode(await failure(versionProtocol(v1.id, rest, ifm(v1.version), { tenant: B })), 'common.not_found', 404);
      expectCode(await failure(deactivateProtocol(v1.id, ifm(v1.version), { tenant: B })), 'common.not_found', 404);
    });

    it('M28: If-Match required (428) / stale (409); deactivate -> is_active false, schema-valid, and the applies_to keys are freed for another protocol', async () => {
      const key = newKey();
      const p = (await createProtocol(protocolBody(newCode('p'), { applies_to: [{ specimen_type_code: key }] }))).body;
      expectCode(await failure(deactivateProtocol(p.id, {})), 'common.precondition_required', 428);
      expectCode(await failure(deactivateProtocol(p.id, ifm(p.version + 2))), 'common.version_conflict', 409);
      const r = await deactivateProtocol(p.id, ifm(p.version));
      expect(r.status).toBe(200);
      expect(schemaErrors('PlatingProtocolDto', r.body)).toEqual([]);
      expect(r.body).toMatchObject({ id: p.id, is_active: false });
      expect(r.probe.roleCalls.map((x) => x.permission)).toEqual([MANAGE]);
      expect((await createProtocol(protocolBody(newCode('p'), { applies_to: [{ specimen_type_code: key }] }))).status).toBe(201);
    });

    it('M25: default list hides superseded versions, include_superseded=true shows them, is_active filters; schema-valid; asks only micro.culture.read; tenant-isolated', async () => {
      const code = newCode('p');
      const v1 = (await createProtocol(protocolBody(code))).body;
      const { code: _c, ...rest } = protocolBody(code);
      const v2 = (await versionProtocol(v1.id, rest, ifm(v1.version))).body;
      const dflt = await listProtocols({}, { grants: [READ] });
      expect(dflt.status).toBe(200);
      for (const row of dflt.body.data) expect(schemaErrors('PlatingProtocolDto', row), row.code).toEqual([]);
      expect(dflt.probe.roleCalls.map((x) => x.permission)).toEqual([READ]);
      expect(dflt.body.data.filter((x: any) => x.code === code).map((x: any) => x.id)).toEqual([v2.id]);
      const all = await listProtocols({ include_superseded: true });
      expect(all.body.data.filter((x: any) => x.code === code).map((x: any) => x.version_no).sort()).toEqual([1, 2]);
      await deactivateProtocol(v2.id, ifm(v2.version));
      expect((await listProtocols({ is_active: true })).body.data.some((x: any) => x.code === code)).toBe(false);
      expect((await listProtocols({ is_active: false })).body.data.some((x: any) => x.code === code)).toBe(true);
      expect((await listProtocols({ include_superseded: true }, { tenant: B })).body.data.some((x: any) => x.code === code)).toBe(false);
      expectCode(await failure(listProtocols({}, { grants: [MANAGE] })), 'auth.forbidden', 403);
    });
  });
});
