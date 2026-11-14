// C5 T-29 — configuration handlers #47-#54 against the migrated database: getLabSettings, updateLabSettings, listDeltaCheckRules, createDeltaCheckRule, versionDeltaCheckRule,
// deactivateDeltaCheckRule, listLabCodedSet, upsertLabCode (06 row T-29; 02-TRD §5.8 rows 47-54, §9.1; 05-SCHEMA lab_settings / delta_check_rules / cs_* + g_cs_* + shadowing;
//  PRD AC-12.4; 07-SECURITY REQ-SEC-062/067, S-15, P-01, P-03, P-10; 03-IC §11 lab.config.manage privileged).
// Needs the migrated+seeded database that tests/db/c5-t03/run.sh starts (see .orchestra/notes/C5.T-29-verify.cmd): LIMS_TEST_DATABASE_URL = role lims_api (RLS on),
// LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1 where "database is provided" fails.
//
// SEAMS (spec fixes behaviour, not names) — the writer adds handlers/<operationId>.ts (or one handlers/config.handlers.ts spread into REAL, like T-16/T-17) + service/config.service.ts over
//   repository/{labSettings,deltaRules,codedSets}.repo.ts; same ctx / req / return shape as the T-08 handlers (req {params, query, headers, body}; ctx.tx = the request tx under RLS).
//   Permission = ctx.ports.IdentityPort.assertRole(ctx, { permission }) of the operation's x-permission; `auth.mfa_required` thrown by assertRole passes through unchanged (S-15).
//   service/config.service.ts exports getEffectiveDeltaRule(rc: RepoCtx, analyteId: string, at: Date): Promise<DeltaRule | undefined> (DeltaRule = domain/delta.ts: { ruleId, ruleVersion, windowSeconds, absThreshold?, pctThreshold? })
//   — the rule IN FORCE at `at` (AC-12.4); result.service's deltaInputs must use it instead of getActiveDeltaRule (which ignores effective_from).
// ASSUMED (spec silent; every one is listed in .orchestra/notes/C5.T-29-tests.md):
//   - no lab_settings row = column defaults with version 1 (05 "Missing row = defaults"); PUT with If-Match "1" on a missing row creates it; any other If-Match on a missing row -> 409.
//   - the DTO `id` of a rule is its ROW id; the chain's stable `rule_id` column = the id of version 1; {rule_id} in #51/#52 is a row id of the CURRENT version (its If-Match is that row's `version`).
//   - #51 sets previous.effective_to = new.effective_from (default effective_from = ctx.now()); a new effective_from <= previous.effective_from -> 400 /effective_from.
//   - #49 lists every version row of the tenant (history included), filters analyte_id / is_active.
//   - a second ACTIVE rule for an analyte that already has one is refused (4xx, no row written); the analyte id is not validated against the catalog (no CatalogPort method exists for it).
//   - a code that violates the DB CHECK ^[a-z0-9_]{1,64}$ but passes the Code schema is a 400 /code (never a 500); an unknown set_name is a 400 /set_name.
//   - #54 creates the tenant row (no If-Match) also when it only overrides a global code; the global row is never written.
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

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEM = '01a1a98a-ac40-7000-8000-00000000a500';
const u = (n: number) => `0190c607-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = new Date('2026-06-15T05:00:30.000Z');
const DAY = 86_400_000;
const iso = (d: Date | number) => new Date(d).toISOString();
const RUN = Date.now().toString(36);                                    // code suffix: re-runs on the same database never collide
const P = { settingsRead: 'lab.worklist.read', ruleRead: 'lab.result.read', setRead: 'lab.specimen.read', manage: 'lab.config.manage' } as const;
const READERS = [P.settingsRead, P.ruleRead, P.setRead];
const ALL = [...READERS, P.manage];
const OPS = ['getLabSettings', 'updateLabSettings', 'listDeltaCheckRules', 'createDeltaCheckRule', 'versionDeltaCheckRule', 'deactivateDeltaCheckRule', 'listLabCodedSet', 'upsertLabCode'];

const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'lab.yaml'));
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
async function asAdmin<T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
const ruleRows = (tenant: string, analyte: string) => sql('SELECT * FROM lab.delta_check_rules WHERE tenant_id = $1 AND analyte_id = $2 ORDER BY rule_version', [tenant, analyte]);
const settingsRow = async (tenant: string) => (await sql('SELECT * FROM lab.lab_settings WHERE tenant_id = $1', [tenant]))[0];
const tenantCodes = (set: string, tenant: string, code: string) => sql(`SELECT * FROM lab.cs_${set} WHERE tenant_id = $1 AND code = $2`, [tenant, code]);

// ------------------------------------------------------------------ driving a handler
interface Probe { roleCalls: any[]; audit: any[] }
interface Opts { grants?: readonly string[]; tenant?: string; mfa?: boolean; now?: Date }
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined as unknown, ...o });
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
let reqN = 0;
const idem = () => ({ 'idempotency-key': `t29-${RUN}-${reqN}` });

/** One request = one committed tx under RLS (claims of the ctx tenant); a throw rolls back, like the core request wrapper. */
async function call(operationId: string, r: ReturnType<typeof req>, o: Opts = {}): Promise<{ status: number; body: any; probe: Probe }> {
  const tenant = o.tenant ?? A;
  const probe: Probe = { roleCalls: [], audit: [] };
  const grants = o.grants ?? ALL;
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: tenant, tx: client, requestId: u(0x9000 + reqN++), now: () => o.now ?? NOW,
      actor: { type: 'user', id: SYS, membershipId: MEM },
      ports: { IdentityPort: {
        async assertRole(_c: unknown, x: { permission: string }) {
          probe.roleCalls.push(x);
          if (!grants.includes(x?.permission)) throw new LimsError('auth.forbidden');
          if (o.mfa && x.permission === P.manage) throw new LimsError('auth.mfa_required');   // privileged permission, session at aal1 (REQ-SEC-062/067)
        },
        async getActor() { return { actor: { type: 'user', id: SYS }, permissions: [...grants], centreScope: { all: true, centreIds: [] }, isLocked: false }; },
      } },
      events: { publish: async () => ({ eventId: u(0x8000), duplicate: false }) },
      audit: { access: async (e: unknown) => { probe.audit.push(e); } },
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
let analyteN = 0x600000 + (Date.now() % 0x100000) * 16;
const newAnalyte = () => u(analyteN++);
const SETTINGS = { label_width_mm: 60, label_height_mm: 30, label_copies_default: 2, label_renderer: 'html_svg', host_query_requires_received: false, ingest_auto_receive: true,
  critical_notification_blocks_approval: false, recollection_default: false, delta_check_enabled: false, history_days: 365 };
const getSettings = (o: Opts = {}) => call('getLabSettings', req(), o);
const putSettings = (body: unknown, h: object, o: Opts = {}) => call('updateLabSettings', req({ headers: h, body }), o);
const RULE = { window_seconds: 7 * 86400, abs_threshold: '1.0', unit_code: 'mmol_l' };
const create = (analyte: string, over: Record<string, unknown> = {}, o: Opts = {}) =>
  call('createDeltaCheckRule', req({ headers: idem(), body: { analyte_id: analyte, ...RULE, effective_from: iso(NOW.getTime() - 10 * DAY), ...over } }), o);
const version = (ruleId: string, v: number | string, over: Record<string, unknown> = {}, o: Opts = {}) =>
  call('versionDeltaCheckRule', req({ params: { rule_id: ruleId }, headers: { ...ifm(v), ...idem() }, body: { window_seconds: 14 * 86400, pct_threshold: '20', unit_code: 'mmol_l', ...over } }), o);
const deactivate = (ruleId: string, v: number | string, o: Opts = {}) => call('deactivateDeltaCheckRule', req({ params: { rule_id: ruleId }, headers: ifm(v), body: {} }), o);
const listRules = (query: object = {}, o: Opts = {}) => call('listDeltaCheckRules', req({ query }), o);
const listSet = (set: string, o: Opts = {}) => call('listLabCodedSet', req({ params: { set_name: set } }), o);
const upsert = (set: string, code: string, body: unknown, h: object = {}, o: Opts = {}) => call('upsertLabCode', req({ params: { set_name: set, code }, headers: h, body }), o);
const CONFIG_SERVICE = '../../service/config.service.js';
const getEffective = async (analyte: string, at: Date, tenant = A) => {
  const mod: any = await import(/* @vite-ignore */ CONFIG_SERVICE);   // variable path: a missing module fails only the tests that need it, not the whole file at load
  const c = await api.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const out = await mod.getEffectiveDeltaRule({ tx: c, tenantId: tenant, actorId: SYS }, analyte, at);
    await c.query('COMMIT');
    return out;
  } finally { c.release(); }
};

let savedB: Record<string, unknown> | undefined;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 12 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  savedB = await settingsRow(B);                                          // tenant B is this file's settings sandbox (the labels test owns tenant A's row); restored in afterAll
  await asAdmin(B, async (c) => { await c.query('DELETE FROM lab.lab_settings WHERE tenant_id = $1', [B]); });
}, 120_000);
afterAll(async () => {
  if (live) {
    await asAdmin(B, async (c) => { await c.query('DELETE FROM lab.lab_settings WHERE tenant_id = $1', [B]); });
    if (savedB) {
      const keys = Object.keys(savedB);
      await asAdmin(B, (c) => c.query(`INSERT INTO lab.lab_settings (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => savedB![k])));
    }
  }
  await Promise.all([api?.end(), admin?.end()]);
});

describe('T-29 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

// ================================================================== #47 / #48 lab settings
describe.skipIf(!live)('T-29 #47 getLabSettings / #48 updateLabSettings (02-TRD §9.1)', () => {
  const B_OPTS: Opts = { tenant: B };
  it('no row yet: GET returns the §9.1 defaults, version 1, and a closed LabSettingsDto', async () => {
    const r = await getSettings(B_OPTS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ version: 1, label_width_mm: 50, label_height_mm: 25, label_copies_default: 1, label_renderer: 'html_svg', host_query_requires_received: true, ingest_auto_receive: false,
      critical_notification_blocks_approval: true, recollection_default: true, delta_check_enabled: true, history_days: 730 });
    expect(schemaErrors('LabSettingsDto', r.body)).toEqual([]);
    expect(await settingsRow(B)).toBeUndefined();                           // a read never writes
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(P.settingsRead);
  });
  it('PUT without If-Match -> 428 common.precondition_required; a wrong version on a missing row -> 409; nothing written', async () => {
    expectCode(await failure(putSettings(SETTINGS, {}, B_OPTS)), 'common.precondition_required', 428);
    expectCode(await failure(putSettings(SETTINGS, ifm(5), B_OPTS)), 'common.version_conflict', 409);
    expect(await settingsRow(B)).toBeUndefined();
  });
  it.each(['abc', '"0"', '"-1"', '1', '"1.5"', '""'])('400 common.validation_failed for a malformed If-Match %s', async (h) => {
    expectCode(await failure(putSettings(SETTINGS, ifm(h), B_OPTS)), 'common.validation_failed', 400);
    expect(await settingsRow(B)).toBeUndefined();
  });
  it('If-Match "1" creates the row; GET returns exactly what was saved; the change is audited by the row-audit trigger actor columns', async () => {
    const put = await putSettings(SETTINGS, ifm(1), B_OPTS);
    expect(put.status).toBe(200);
    expect(schemaErrors('LabSettingsDto', put.body)).toEqual([]);
    const { version: v, ...rest } = put.body;
    expect(rest).toEqual(SETTINGS);
    const g = await getSettings(B_OPTS);
    expect(g.body).toEqual(put.body);
    const row = await settingsRow(B);
    expect(row).toMatchObject({ ...SETTINGS, version: v, updated_by: SYS });
    expect(put.probe.roleCalls.map((c) => c.permission)).toContain(P.manage);
  });
  it('a later PUT with the current If-Match bumps the version by one; the stale If-Match then fails 409 and changes nothing', async () => {
    const cur = (await getSettings(B_OPTS)).body.version as number;
    const next = await putSettings({ ...SETTINGS, label_copies_default: 3 }, ifm(cur), B_OPTS);
    expect(next.body).toMatchObject({ version: cur + 1, label_copies_default: 3 });
    expectCode(await failure(putSettings({ ...SETTINGS, label_copies_default: 5 }, ifm(cur), B_OPTS)), 'common.version_conflict', 409);
    expect((await settingsRow(B))?.['label_copies_default']).toBe(3);
  });
  it.each([
    ['label_width_mm', 19], ['label_width_mm', 101], ['label_height_mm', 9], ['label_height_mm', 61], ['label_copies_default', 0], ['label_copies_default', 6],
    ['history_days', 29], ['history_days', 3651], ['label_renderer', 'zpl'], ['delta_check_enabled', 'yes'], ['label_width_mm', 20.5],
  ])('400 common.validation_failed /%s for %j (CHECK-constraint range, never a 500); nothing written', async (field, bad) => {
    const cur = (await getSettings(B_OPTS)).body.version as number;
    const before = await settingsRow(B);
    badPath(await failure(putSettings({ ...SETTINGS, [field]: bad }, ifm(cur), B_OPTS)), `/${field}`);
    expect(await settingsRow(B)).toEqual(before);
  });
  it('400 for a missing field, an unknown key and a tenant_id in the body (REQ-SEC-013); non-object bodies -> 400', async () => {
    const cur = (await getSettings(B_OPTS)).body.version as number;
    const before = await settingsRow(B);
    const { history_days: _omit, ...missing } = SETTINGS;
    expectCode(await failure(putSettings(missing, ifm(cur), B_OPTS)), 'common.validation_failed', 400);
    expectCode(await failure(putSettings({ ...SETTINGS, auto_print_labels: true }, ifm(cur), B_OPTS)), 'common.validation_failed', 400);   // removed by 08 A13 D-4
    expectCode(await failure(putSettings({ ...SETTINGS, tenant_id: A }, ifm(cur), B_OPTS)), 'common.validation_failed', 400);
    for (const bad of [null, [], 'x', 5]) expectCode(await failure(putSettings(bad, ifm(cur), B_OPTS)), 'common.validation_failed', 400);
    expect(await settingsRow(B)).toEqual(before);
  });
  it('S-15: a technologist (no lab.config.manage) -> 403; a lab_manager at aal1 -> auth.mfa_required; nothing written; a read-only role can still GET (P-10)', async () => {
    const cur = (await getSettings(B_OPTS)).body.version as number;
    const before = await settingsRow(B);
    expectCode(await failure(putSettings({ ...SETTINGS, history_days: 400 }, ifm(cur), { tenant: B, grants: READERS })), 'auth.forbidden', 403);
    expectCode(await failure(putSettings({ ...SETTINGS, history_days: 400 }, ifm(cur), { tenant: B, mfa: true })), 'auth.mfa_required', 403);
    expect(await settingsRow(B)).toEqual(before);
    expect((await getSettings({ tenant: B, grants: [P.settingsRead] })).status).toBe(200);
    expectCode(await failure(getSettings({ tenant: B, grants: [P.manage] })), 'auth.forbidden', 403);   // the read needs lab.worklist.read itself
  });
  it('P-01: tenants are isolated — A\'s PUT never touches B\'s row, B\'s GET never shows A\'s values', async () => {
    const before = await settingsRow(B);
    const aBefore = await settingsRow(A);
    const a = (await getSettings()).body;                                    // A: its own row or defaults, never B's 60x30
    if (!aBefore) expect(a.label_width_mm).toBe(50);
    else expect(a.version).toBe(aBefore['version']);
    expect(await settingsRow(B)).toEqual(before);
  });
  it('race: 5 concurrent PUTs with the same If-Match -> exactly one 200, the rest 409 version_conflict (version + 1 once)', async () => {
    const cur = (await getSettings(B_OPTS)).body.version as number;
    const out = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => putSettings({ ...SETTINGS, history_days: 100 + n }, ifm(cur), B_OPTS)));
    expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of out) if (x.status === 'rejected') expectCode(x.reason, 'common.version_conflict', 409);
    expect((await settingsRow(B))?.['version']).toBe(cur + 1);
  });
});

// ================================================================== #49-#52 delta-check rules
describe.skipIf(!live)('T-29 #50 createDeltaCheckRule (versioned rules, AC-12.4)', () => {
  it('201: version 1 of a new rule — DTO is closed + valid, active, effective_from as given, no effective_to; the stored row has rule_version 1 and rule_id = its own id', async () => {
    const an = newAnalyte(), from = iso(NOW.getTime() - 10 * DAY);
    const r = await create(an, { effective_from: from });
    expect(r.status).toBe(201);
    expect(schemaErrors('DeltaCheckRuleDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ analyte_id: an, version: 1, rule_version: 1, window_seconds: 7 * 86400, unit_code: 'mmol_l', is_active: true, effective_from: from });
    expect(Number(r.body.abs_threshold)).toBe(1);
    expect(r.body.pct_threshold).toBeUndefined();
    expect(r.body.effective_to).toBeUndefined();
    expect(r.body).not.toHaveProperty('tenant_id');
    const rows = await ruleRows(A, an);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.body.id, rule_id: r.body.id, rule_version: 1, tenant_id: A, effective_to: null, is_active: true, created_by: SYS });
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(P.manage);
  });
  it('effective_from defaults to the request time (ctx.now)', async () => {
    const r = await create(newAnalyte(), { effective_from: undefined });
    expect(r.body.effective_from).toBe(NOW.toISOString());
  });
  it('accepts pct only, abs only and both; pct_threshold 1000 is the inclusive upper bound; window bounds 3600 and 31536000 are accepted', async () => {
    for (const body of [{ abs_threshold: undefined, pct_threshold: '1000' }, { abs_threshold: '0.001', pct_threshold: undefined, window_seconds: 3600 }, { abs_threshold: '2', pct_threshold: '10', window_seconds: 31_536_000 }])
      expect((await create(newAnalyte(), body)).status).toBe(201);
  });
  it.each([
    ['no threshold at all', { abs_threshold: undefined }, '/abs_threshold'],
    ['abs_threshold 0 (exclusive minimum, checked in the handler)', { abs_threshold: '0' }, '/abs_threshold'],
    ['abs_threshold negative', { abs_threshold: '-1' }, '/abs_threshold'],
    ['pct_threshold 0', { abs_threshold: undefined, pct_threshold: '0' }, '/pct_threshold'],
    ['pct_threshold 1000.01', { pct_threshold: '1000.01' }, '/pct_threshold'],
    ['pct_threshold negative', { pct_threshold: '-5' }, '/pct_threshold'],
    ['window_seconds 3599', { window_seconds: 3599 }, '/window_seconds'],
    ['window_seconds 31536001', { window_seconds: 31_536_001 }, '/window_seconds'],
    ['non-integer window', { window_seconds: 3600.5 }, '/window_seconds'],
    ['abs_threshold not a decimal string', { abs_threshold: 'abc' }, '/abs_threshold'],
    ['abs_threshold a number, not a string', { abs_threshold: 1 }, '/abs_threshold'],
    ['analyte_id not a uuid', { analyte_id: 'not-a-uuid' }, '/analyte_id'],
    ['unit_code missing', { unit_code: undefined }, '/unit_code'],
    ['effective_from not an ISO UTC instant', { effective_from: 'tomorrow' }, '/effective_from'],
  ])('400 common.validation_failed with the field path: %s; no row written (finding C5 #27)', async (_t, over, path) => {
    const an = newAnalyte();
    badPath(await failure(create(an, over)), path);
    expect(await ruleRows(A, an)).toHaveLength(0);
  });
  it('400 for unknown keys incl. tenant_id / rule_version / is_active (REQ-SEC-013) and non-object bodies; nothing written', async () => {
    const an = newAnalyte();
    for (const extra of [{ tenant_id: B }, { rule_version: 9 }, { is_active: false }, { rule_id: u(1) }]) expectCode(await failure(create(an, extra)), 'common.validation_failed', 400);
    for (const bad of [null, [], 'x', 5]) expectCode(await failure(call('createDeltaCheckRule', req({ headers: idem(), body: bad }))), 'common.validation_failed', 400);
    expect(await ruleRows(A, an)).toHaveLength(0);
  });
  it('a second active rule for an analyte that already has one is refused (one active rule per analyte, delta_check_rules__tenant_id_analyte__p_uq); exactly one row stays', async () => {
    const an = newAnalyte();
    expect((await create(an)).status).toBe(201);
    const e = await failure(create(an, { abs_threshold: '3' }));
    expect(isLimsError(e, 'common.internal' as never)).toBe(false);          // a constraint hit is a client error, not a 500
    expect([400, 409, 422]).toContain(e.statusCode);
    expect(await ruleRows(A, an)).toHaveLength(1);
  });
  it('S-15: technologist -> 403; lab_manager at aal1 -> auth.mfa_required; nothing written', async () => {
    const an = newAnalyte();
    expectCode(await failure(create(an, {}, { grants: READERS })), 'auth.forbidden', 403);
    expectCode(await failure(create(an, {}, { mfa: true })), 'auth.mfa_required', 403);
    expect(await ruleRows(A, an)).toHaveLength(0);
  });
});

describe.skipIf(!live)('T-29 #51 versionDeltaCheckRule — effective_from, history, "rule in force" (AC-12.4)', () => {
  it('201: version n+1 keeps the analyte + rule_id chain, takes the new thresholds; the previous row gets effective_to = the new effective_from (default now) and stays', async () => {
    const an = newAnalyte(), v1 = (await create(an)).body;
    const r = await version(v1.id, v1.version);
    expect(r.status).toBe(201);
    expect(schemaErrors('DeltaCheckRuleDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ analyte_id: an, rule_version: 2, version: 1, window_seconds: 14 * 86400, is_active: true, effective_from: NOW.toISOString() });
    expect(r.body.id).not.toBe(v1.id);
    expect(Number(r.body.pct_threshold)).toBe(20);
    expect(r.body.abs_threshold).toBeUndefined();                            // thresholds are replaced, not merged
    expect(r.body.effective_to).toBeUndefined();
    const rows = await ruleRows(A, an);
    expect(rows.map((x) => x.rule_version)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ id: v1.id, rule_id: v1.id, effective_to: NOW, is_active: true });
    expect(rows[1]).toMatchObject({ id: r.body.id, rule_id: v1.id, effective_to: null, is_active: true });
    expect(Number(rows[0]!.abs_threshold)).toBe(1);                          // the old version's numbers are never rewritten
    // ruling C5.T-29: schema CHECK effective_to > effective_from forbids v3 at the same fixed instant as v2 -> v3 gets a later instant
    const v3 = await version(r.body.id, r.body.version, { abs_threshold: '4', pct_threshold: undefined, effective_from: iso(NOW.getTime() + DAY) });
    expect(v3.body.rule_version).toBe(3);
    expect((await ruleRows(A, an)).map((x) => x.rule_id)).toEqual([v1.id, v1.id, v1.id]);
  });
  it('AC-12.4: a version with a FUTURE effective_from takes effect only from that instant — before it the previous version is in force, from it the new one; each version reports its own rule id + version', async () => {
    const an = newAnalyte(), v1 = (await create(an, { effective_from: iso(NOW.getTime() - 30 * DAY) })).body;
    const future = new Date(NOW.getTime() + 2 * DAY);
    const v2 = (await version(v1.id, v1.version, { effective_from: future.toISOString() })).body;
    expect((await ruleRows(A, an))[0]!.effective_to).toEqual(future);
    expect(await getEffective(an, new Date(future.getTime() - 1))).toMatchObject({ ruleId: v1.id, ruleVersion: 1, windowSeconds: 7 * 86400, absThreshold: expect.stringMatching(/^1(\.0+)?$/) });
    expect(await getEffective(an, NOW)).toMatchObject({ ruleId: v1.id, ruleVersion: 1 });
    const atFrom = await getEffective(an, future);                           // effective_from is inclusive
    expect(atFrom).toMatchObject({ ruleId: v1.id, ruleVersion: 2, windowSeconds: 14 * 86400 });
    expect(atFrom.absThreshold).toBeUndefined();
    expect(atFrom.pctThreshold).toMatch(/^20(\.0+)?$/);
    expect(await getEffective(an, new Date(future.getTime() + DAY))).toMatchObject({ ruleVersion: 2 });
    expect(v2.rule_version).toBe(2);
  });
  it('no rule in force before the first version\'s effective_from, none for another analyte, none for the same analyte of another tenant (P-01)', async () => {
    const an = newAnalyte(), from = new Date(NOW.getTime() - 5 * DAY);
    await create(an, { effective_from: from.toISOString() });
    expect(await getEffective(an, new Date(from.getTime() - 1))).toBeUndefined();
    expect(await getEffective(an, NOW)).toMatchObject({ ruleVersion: 1 });
    expect(await getEffective(newAnalyte(), NOW)).toBeUndefined();
    expect(await getEffective(an, NOW, B)).toBeUndefined();
  });
  it('effective_from not after the previous version\'s effective_from -> 400 /effective_from; nothing written (no half-versioned chain)', async () => {
    const an = newAnalyte(), v1 = (await create(an, { effective_from: iso(NOW.getTime() - DAY) })).body;
    for (const bad of [iso(NOW.getTime() - DAY), iso(NOW.getTime() - 3 * DAY)]) badPath(await failure(version(v1.id, v1.version, { effective_from: bad })), '/effective_from');
    const rows = await ruleRows(A, an);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effective_to: null, version: 1 });
  });
  it('428 without If-Match, 409 on a stale one (after a concurrent change), 400 for malformed ones; nothing written', async () => {
    const an = newAnalyte(), v1 = (await create(an)).body;
    expectCode(await failure(call('versionDeltaCheckRule', req({ params: { rule_id: v1.id }, headers: idem(), body: { ...RULE } }))), 'common.precondition_required', 428);
    expectCode(await failure(version(v1.id, 7)), 'common.version_conflict', 409);
    for (const h of ['abc', '"0"', '1', '""']) expectCode(await failure(version(v1.id, h)), 'common.validation_failed', 400);
    expect(await ruleRows(A, an)).toHaveLength(1);
    expect((await version(v1.id, v1.version)).status).toBe(201);
    expectCode(await failure(version(v1.id, v1.version)), 'common.version_conflict', 409);            // v1 was superseded: its row version moved on
    expect(await ruleRows(A, an)).toHaveLength(2);
  });
  it('threshold / window validation as #50, no analyte_id accepted in the body; unknown, malformed and foreign rule ids -> 404 / 400 and nothing changes (P-01)', async () => {
    const an = newAnalyte(), v1 = (await create(an)).body;
    badPath(await failure(version(v1.id, v1.version, { abs_threshold: '0' })), '/abs_threshold');
    badPath(await failure(version(v1.id, v1.version, { pct_threshold: '1001' })), '/pct_threshold');
    badPath(await failure(version(v1.id, v1.version, { window_seconds: 60 })), '/window_seconds');
    badPath(await failure(version(v1.id, v1.version, { abs_threshold: undefined, pct_threshold: undefined })), '/abs_threshold');
    expectCode(await failure(version(v1.id, v1.version, { analyte_id: newAnalyte() })), 'common.validation_failed', 400);
    expectCode(await failure(version(u(0xdead00), 1)), 'common.not_found', 404);
    expectCode(await failure(version(v1.id, v1.version, {}, { tenant: B })), 'common.not_found', 404);   // tenant B user, tenant A rule
    expectCode(await failure(version('not-a-uuid', 1)), 'common.validation_failed', 400);
    expect(await ruleRows(A, an)).toHaveLength(1);
    expect((await ruleRows(A, an))[0]).toMatchObject({ version: 1, effective_to: null });
  });
  it('S-15: technologist -> 403; lab_manager at aal1 -> auth.mfa_required; nothing written', async () => {
    const an = newAnalyte(), v1 = (await create(an)).body;
    expectCode(await failure(version(v1.id, v1.version, {}, { grants: READERS })), 'auth.forbidden', 403);
    expectCode(await failure(version(v1.id, v1.version, {}, { mfa: true })), 'auth.mfa_required', 403);
    expect(await ruleRows(A, an)).toHaveLength(1);
  });
  it('race: 4 concurrent versions with the same If-Match -> exactly one 201 and one new row (the partial unique index never sees two open rules)', async () => {
    const an = newAnalyte(), v1 = (await create(an)).body;
    const out = await Promise.allSettled([1, 2, 3, 4].map((n) => version(v1.id, v1.version, { window_seconds: 3600 * (24 + n) })));
    expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of out) if (x.status === 'rejected') expect([409, 400, 422]).toContain(x.reason.statusCode);
    const rows = await ruleRows(A, an);
    expect(rows).toHaveLength(2);
    expect(rows.filter((x) => x.effective_to === null && x.is_active)).toHaveLength(1);
  });
});

describe.skipIf(!live)('T-29 #52 deactivateDeltaCheckRule / #49 listDeltaCheckRules', () => {
  it('200: is_active false, version + 1, the rule is no longer in force (a deactivated rule produces no delta check), history rows stay', async () => {
    const an = newAnalyte(), v1 = (await create(an)).body;
    expect(await getEffective(an, NOW)).toMatchObject({ ruleVersion: 1 });
    const r = await deactivate(v1.id, v1.version);
    expect(r.status).toBe(200);
    expect(schemaErrors('DeltaCheckRuleDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: v1.id, is_active: false, version: v1.version + 1, rule_version: 1, analyte_id: an });
    expect(await getEffective(an, NOW)).toBeUndefined();
    expect(await ruleRows(A, an)).toHaveLength(1);
    expect((await create(an, { abs_threshold: '9' })).status).toBe(201);     // the analyte is free for a new active rule again
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(P.manage);
  });
  it('428 without If-Match, 409 when stale, 400 for a body with keys; S-15 403 / auth.mfa_required; 404 for unknown / foreign ids; nothing changes', async () => {
    const an = newAnalyte(), v1 = (await create(an)).body;
    expectCode(await failure(call('deactivateDeltaCheckRule', req({ params: { rule_id: v1.id }, headers: {}, body: {} }))), 'common.precondition_required', 428);
    expectCode(await failure(deactivate(v1.id, 9)), 'common.version_conflict', 409);
    expectCode(await failure(call('deactivateDeltaCheckRule', req({ params: { rule_id: v1.id }, headers: ifm(v1.version), body: { is_active: true } }))), 'common.validation_failed', 400);
    expectCode(await failure(deactivate(v1.id, v1.version, { grants: READERS })), 'auth.forbidden', 403);
    expectCode(await failure(deactivate(v1.id, v1.version, { mfa: true })), 'auth.mfa_required', 403);
    expectCode(await failure(deactivate(u(0xdead01), 1)), 'common.not_found', 404);
    expectCode(await failure(deactivate(v1.id, v1.version, { tenant: B })), 'common.not_found', 404);
    expect((await ruleRows(A, an))[0]).toMatchObject({ is_active: true, version: v1.version });
  });
  it('list: closed DTOs, filters analyte_id / is_active, every version of a chain is listed, other tenants\' rules never (P-03), malformed filters -> 400', async () => {
    const an = newAnalyte(), other = newAnalyte();
    const v1 = (await create(an)).body, v2 = (await version(v1.id, v1.version)).body;
    const bRule = (await create(other, {}, { tenant: B })).body;
    const all = (await listRules({ analyte_id: an })).body;
    expect(schemaErrors('DeltaCheckRuleList', all)).toEqual([]);
    expect(all.data.map((d: any) => d.id).sort()).toEqual([v1.id, v2.id].sort());
    const act = (await deactivate(v2.id, v2.version)).body;
    expect((await listRules({ analyte_id: an, is_active: 'false' })).body.data.map((d: any) => d.id)).toEqual([act.id]);
    expect((await listRules({ analyte_id: an, is_active: 'true' })).body.data.map((d: any) => d.id)).toEqual([v1.id]);
    expect((await listRules({ analyte_id: other })).body.data).toEqual([]);                             // tenant A cannot see B's rule
    expect((await listRules({ analyte_id: other }, { tenant: B })).body.data.map((d: any) => d.id)).toEqual([bRule.id]);
    expect(JSON.stringify((await listRules()).body)).not.toContain(bRule.id);
    badPath(await failure(listRules({ analyte_id: 'nope' })), '/analyte_id');
    badPath(await failure(listRules({ is_active: 'maybe' })), '/is_active');
  });
  it('list needs lab.result.read: lab.config.manage alone -> 403 (P-10), front_desk-style grants -> 403', async () => {
    expectCode(await failure(listRules({}, { grants: [P.manage] })), 'auth.forbidden', 403);
    expectCode(await failure(listRules({}, { grants: [P.settingsRead, P.setRead] })), 'auth.forbidden', 403);
    expect((await listRules({}, { grants: [P.ruleRead] })).status).toBe(200);
  });
});

// ================================================================== #53 / #54 coded sets
const SETS = ['rejection_reasons', 'return_reasons', 'amendment_reasons', 'exception_discard_reasons'] as const;
describe.skipIf(!live)('T-29 #53 listLabCodedSet / #54 upsertLabCode (tenant rows shadow global rows)', () => {
  const g = (set: string, code: string, display: string, sort: number, active = true) =>
    sql(`INSERT INTO lab.g_cs_${set} (id, code, display, sort_order, is_active) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING`, [u(0x7a0000 + Math.floor(Math.random() * 0xffff)), code, display, sort, active]);
  const code = (n: string) => `t29_${n}_${RUN}`;

  it.each(SETS)('%s: the list is the closed LabCodeList; global rows have source "global", ordered by sort_order then code', async (set) => {
    const c1 = code('ga'), c2 = code('gb');
    await g(set, c2, 'Global B (SYNTHETIC)', 9100); await g(set, c1, 'Global A (SYNTHETIC)', 9100);
    const r = await listSet(set);
    expect(r.status).toBe(200);
    expect(schemaErrors('LabCodeList', r.body)).toEqual([]);
    const mine = r.body.data.filter((d: any) => d.code === c1 || d.code === c2);
    expect(mine).toEqual([{ code: c1, display: 'Global A (SYNTHETIC)', sort_order: 9100, is_active: true, source: 'global' }, { code: c2, display: 'Global B (SYNTHETIC)', sort_order: 9100, is_active: true, source: 'global' }]);
    const order = r.body.data.map((d: any) => [d.sort_order, d.code]);
    expect(order).toEqual([...order].sort((x: any, y: any) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)));
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(P.setRead);
  });
  it('shadowing: a tenant row hides the global row of the same code (one entry, source "tenant"), including an inactive override of an active global code; the global row is untouched', async () => {
    const set = 'rejection_reasons', shadowed = code('sh'), off = code('off');
    await g(set, shadowed, 'Global original (SYNTHETIC)', 9200); await g(set, off, 'Global active (SYNTHETIC)', 9201);
    expect((await upsert(set, shadowed, { display: 'Tenant override (SYNTHETIC)', sort_order: 9200, is_active: true })).status).toBe(200);
    expect((await upsert(set, off, { display: 'Tenant switched off (SYNTHETIC)', sort_order: 9201, is_active: false })).status).toBe(200);
    const data = (await listSet(set)).body.data;
    expect(data.filter((d: any) => d.code === shadowed)).toEqual([{ code: shadowed, display: 'Tenant override (SYNTHETIC)', sort_order: 9200, is_active: true, source: 'tenant' }]);
    expect(data.filter((d: any) => d.code === off)).toEqual([{ code: off, display: 'Tenant switched off (SYNTHETIC)', sort_order: 9201, is_active: false, source: 'tenant' }]);
    expect((await sql(`SELECT display, is_active FROM lab.g_cs_${set} WHERE code = $1`, [shadowed]))[0]).toEqual({ display: 'Global original (SYNTHETIC)', is_active: true });
    expect((await listSet(set, { tenant: B })).body.data.filter((d: any) => d.code === shadowed)).toEqual([{ code: shadowed, display: 'Global original (SYNTHETIC)', sort_order: 9200, is_active: true, source: 'global' }]);   // B is unaffected (P-03)
  });
  it('create: a new tenant code needs no If-Match -> 200 LabCodeDto source "tenant", stored once with version 1 and the actor; no row in another tenant or another set', async () => {
    const c = code('new');
    const r = await upsert('return_reasons', c, { display: 'Tenant only (SYNTHETIC)', sort_order: 5, is_active: true });
    expect(r.status).toBe(200);
    expect(schemaErrors('LabCodeDto', r.body)).toEqual([]);
    expect(r.body).toEqual({ code: c, display: 'Tenant only (SYNTHETIC)', sort_order: 5, is_active: true, source: 'tenant' });
    const rows = await tenantCodes('return_reasons', A, c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, created_by: SYS, system: 'tenant' });
    expect(await tenantCodes('return_reasons', B, c)).toHaveLength(0);
    expect(await tenantCodes('rejection_reasons', A, c)).toHaveLength(0);
    expect((await listSet('return_reasons')).body.data.map((d: any) => d.code)).toContain(c);
    expect((await listSet('return_reasons', { tenant: B })).body.data.map((d: any) => d.code)).not.toContain(c);   // P-03
    expect((await listSet('amendment_reasons')).body.data.map((d: any) => d.code)).not.toContain(c);
  });
  it('update: an existing tenant row needs If-Match — 428 without it, 409 stale, 200 with the current one (version + 1, code never changes)', async () => {
    const c = code('upd'), set = 'amendment_reasons';
    await upsert(set, c, { display: 'First (SYNTHETIC)', sort_order: 1, is_active: true });
    const body = { display: 'Second (SYNTHETIC)', sort_order: 2, is_active: false };
    expectCode(await failure(upsert(set, c, body)), 'common.precondition_required', 428);
    expectCode(await failure(upsert(set, c, body, ifm(4))), 'common.version_conflict', 409);
    for (const h of ['abc', '"0"', '2']) expectCode(await failure(upsert(set, c, body, ifm(h))), 'common.validation_failed', 400);
    expect((await tenantCodes(set, A, c))[0]).toMatchObject({ display: 'First (SYNTHETIC)', version: 1 });
    const r = await upsert(set, c, body, ifm(1));
    expect(r.body).toEqual({ code: c, display: body.display, sort_order: 2, is_active: false, source: 'tenant' });
    expect((await tenantCodes(set, A, c))[0]).toMatchObject({ display: body.display, sort_order: 2, is_active: false, version: 2, code: c });
    expectCode(await failure(upsert(set, c, body, ifm(1))), 'common.version_conflict', 409);
  });
  it.each([
    ['display empty', { display: '' }, '/display'], ['display 121 chars', { display: 'x'.repeat(121) }, '/display'], ['display missing', { display: undefined }, '/display'],
    ['sort_order -1', { sort_order: -1 }, '/sort_order'], ['sort_order 10001', { sort_order: 10_001 }, '/sort_order'], ['sort_order 1.5', { sort_order: 1.5 }, '/sort_order'],
    ['is_active a string', { is_active: 'true' }, '/is_active'], ['is_active missing', { is_active: undefined }, '/is_active'],
  ])('400 common.validation_failed %s; nothing written', async (_t, over, path) => {
    const c = code('val');
    badPath(await failure(upsert('rejection_reasons', c, { display: 'Ok (SYNTHETIC)', sort_order: 1, is_active: true, ...over })), path);
    expect(await tenantCodes('rejection_reasons', A, c)).toHaveLength(0);
  });
  it('400 for unknown keys (tenant_id, system, code, version), non-object bodies; a code outside ^[a-z0-9_]{1,64}$ is a 400 /code (the DB CHECK is never the first line of defence); an unknown set_name is a 400', async () => {
    const ok = { display: 'Ok (SYNTHETIC)', sort_order: 1, is_active: true };
    for (const extra of [{ tenant_id: B }, { system: 'lims' }, { code: 'other' }, { version: 9 }]) expectCode(await failure(upsert('rejection_reasons', code('x'), { ...ok, ...extra })), 'common.validation_failed', 400);
    for (const bad of [null, [], 'x', 5]) expectCode(await failure(upsert('rejection_reasons', code('x'), bad)), 'common.validation_failed', 400);
    for (const c of ['BAD-CODE', 'Has Space', 'UPPER', `x${'a'.repeat(64)}`]) { badPath(await failure(upsert('rejection_reasons', c, ok)), '/code'); expect(await tenantCodes('rejection_reasons', A, c)).toHaveLength(0); }
    for (const s of ['bogus', 'rejection_reasons; DROP TABLE lab.lab_settings', 'v_rejection_reasons', '__proto__', '']) {
      badPath(await failure(upsert(s, code('x'), ok)), '/set_name');
      badPath(await failure(listSet(s)), '/set_name');
    }
    expect((await sql("SELECT to_regclass('lab.lab_settings') AS t"))[0]!.t).not.toBeNull();
  });
  it('S-15 / P-10: a technologist -> 403 on #54 (reads stay allowed with lab.specimen.read); aal1 -> auth.mfa_required; lab.config.manage alone cannot list (403); nothing written', async () => {
    const c = code('sec'), ok = { display: 'Ok (SYNTHETIC)', sort_order: 1, is_active: true };
    expectCode(await failure(upsert('rejection_reasons', c, ok, {}, { grants: READERS })), 'auth.forbidden', 403);
    expectCode(await failure(upsert('rejection_reasons', c, ok, {}, { mfa: true })), 'auth.mfa_required', 403);
    expect(await tenantCodes('rejection_reasons', A, c)).toHaveLength(0);
    expect((await listSet('rejection_reasons', { grants: [P.setRead] })).status).toBe(200);
    expectCode(await failure(listSet('rejection_reasons', { grants: [P.manage, P.settingsRead] })), 'auth.forbidden', 403);
  });
  it('race: 4 concurrent creates of the same new code -> one row (the unique (tenant_id, code) holds), no 500; the losers are 4xx', async () => {
    const c = code('race');
    const out = await Promise.allSettled([1, 2, 3, 4].map((n) => upsert('exception_discard_reasons', c, { display: `Racer ${n} (SYNTHETIC)`, sort_order: n, is_active: true })));
    for (const x of out) if (x.status === 'rejected') expect(x.reason.statusCode, `${x.reason?.code}`).toBeLessThan(500);
    expect(out.some((x) => x.status === 'fulfilled')).toBe(true);
    expect(await tenantCodes('exception_discard_reasons', A, c)).toHaveLength(1);
  });
});

// ================================================================== all eight, defence in depth
describe('T-29 all eight operations', () => {
  it('every operation is a real handler (not the T-01 common.internal stub) and fails closed without a tenant / actor', async () => {
    for (const op of OPS) {
      const e = await failure((handlers as any)[op](req(), { log: { info() {}, warn() {}, error() {} } }));
      expect(isLimsError(e, 'common.internal' as never) && /not implemented/.test(e.detail ?? ''), `${op} is still a stub`).toBe(false);
    }
  });
});
