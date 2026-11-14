// C10 T-17 — published view contract `micro.v_pub_report_content` (06-IMPLEMENTATION-PLAN row T-17; 05-SCHEMA §6 view + JSON Schemas, §10 test 7; 03-IC §6.8;
// PRD AC-15.1..AC-15.4; 07-SECURITY REQ-SEC-031, S-27, S-28; 02-TRD §10 "Contract — view").
// Prereq (06 row T-17): the C0 view exists. Part 1 needs no database. Part 2 (live DB) needs the migrated micro DDL + RLS:
//   LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them part 2 skips, except under LIMS_T17_REQUIRE_DB=1 where
//   "database is provided" fails (same harness status as T-05..T-16). NOT RUN against a database in the tester session: seeding follows T-15 / T-07 and may need fixture tweaks, never assertion weakening.
// LEAD DECISION LD-140 (UI work only) does not apply: backend contract tests, no screens.
// CONTRACT FACTS used (all from 05-SCHEMA §6, copied verbatim; the JSON Schemas below are an independent transcription, NOT imported from domain/snapshot.ts, so a drift in either side fails):
//   columns in order: tenant_id uuid, entity_id uuid (= culture_id), version_no int, order_item_id uuid, report_phase text, culture_summary_text text, isolates jsonb, ast jsonb,
//   comments_text text, signed_by_membership_id uuid, signed_at timestamptz. A view reports every column nullable in the catalog, so nullability is proven by data (comments_text null round-trips).
// ASSUMED (spec silent): partner/portal/patient actor claims read 0 rows through the view (S-28 lists "every micro tenant and centre table"; report_versions is tenant+centre); the
//   contracts/views/micro.v_pub_report_content.schema.json file is C0's transcription: when it exists it must hold both schemas, when it does not the file test skips (the repo has no contracts/views yet).
// Synthetic data only.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeLabPort } from '../../../../../../../packages/fakes/src/LabPort.fake';
import { TENANT_A, TENANT_B } from '../../../../../../../packages/fakes/src/base';
import { REPO_ROOT } from '../../../../core/module.js';
import { isLimsError } from '../../../../core/errors.js';
import { validateSnapshot } from '../../domain/snapshot.js';
import { LAB_READ, mkCtx, run, WORK, type Row } from '../../handlers/__tests__/helpers/cultureReads.js';

// ------------------------------------------------------------------ the 05-SCHEMA §6 JSON Schemas, transcribed
const ISOLATES_SCHEMA = {
  $id: 'urn:lims:view:micro.v_pub_report_content.isolates', type: 'array', maxItems: 20,
  items: { type: 'object', additionalProperties: false, required: ['seq', 'organism_code', 'organism_display', 'growth_text'], properties: {
    seq: { type: 'integer', minimum: 1, maximum: 99 }, organism_code: { type: 'string', minLength: 1, maxLength: 64 },
    organism_display: { type: 'string', minLength: 1, maxLength: 200 }, growth_text: { type: 'string', maxLength: 200 } } },
};
const AST_SCHEMA = {
  $id: 'urn:lims:view:micro.v_pub_report_content.ast', type: 'array', maxItems: 600,
  items: { type: 'object', additionalProperties: false,
    required: ['isolate_seq', 'antibiotic_code', 'antibiotic_display', 'method', 'raw_value', 'category_code', 'standard', 'standard_version'], properties: {
      isolate_seq: { type: 'integer', minimum: 1, maximum: 99 }, antibiotic_code: { type: 'string', minLength: 1, maxLength: 64 }, antibiotic_display: { type: 'string', minLength: 1, maxLength: 200 },
      method: { enum: ['mic', 'zone_diameter', 'other'] }, raw_value: { type: 'string', minLength: 1, maxLength: 32 }, category_code: { type: 'string', minLength: 1, maxLength: 8 },
      standard: { enum: ['CLSI', 'EUCAST', 'ECOFF'] }, standard_version: { type: 'string', minLength: 1, maxLength: 32 } } },
};
const COLUMNS: readonly [string, string][] = [
  ['tenant_id', 'uuid'], ['entity_id', 'uuid'], ['version_no', 'int4'], ['order_item_id', 'uuid'], ['report_phase', 'text'], ['culture_summary_text', 'text'],
  ['isolates', 'jsonb'], ['ast', 'jsonb'], ['comments_text', 'text'], ['signed_by_membership_id', 'uuid'], ['signed_at', 'timestamptz'],
];

const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => { compile(s: object): ((x: unknown) => boolean) & { errors?: unknown[] | null } };
const ajv = new Ajv2020({ strict: true, allErrors: true });
const vIsolates = ajv.compile(ISOLATES_SCHEMA); const vAst = ajv.compile(AST_SCHEMA);
const isolateErrors = (x: unknown): string[] => (vIsolates(x) ? [] : (vIsolates.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`));
const astErrors = (x: unknown): string[] => (vAst(x) ? [] : (vAst.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`));

const ISO = { seq: 1, organism_code: 'syn_ecoli', organism_display: 'Synthetic E. coli', growth_text: 'heavy' };
const AST = { isolate_seq: 1, antibiotic_code: 'syn_amp', antibiotic_display: 'Synthetic ampicillin', method: 'mic', raw_value: '<=0.25', category_code: 'S', standard: 'CLSI', standard_version: 'M100-2026' };

// ================================================================== part 1 — contract, no database
describe('T-17 view JSON contract (05-SCHEMA §6), no database', () => {
  it('AC-15.2 the transcribed schemas accept `[]` and a complete element (growth_text may be the empty string)', () => {
    expect(isolateErrors([])).toEqual([]); expect(astErrors([])).toEqual([]);
    expect(isolateErrors([ISO])).toEqual([]); expect(isolateErrors([{ ...ISO, growth_text: '' }])).toEqual([]); expect(astErrors([AST])).toEqual([]);
  });

  it.each([
    ['missing key', { seq: 1, organism_code: 'a', organism_display: 'b' }],
    ['extra key', { ...ISO, colony_description: 'x' }],
    ['seq 0', { ...ISO, seq: 0 }], ['seq 100', { ...ISO, seq: 100 }], ['seq as string', { ...ISO, seq: '1' }],
    ['empty organism_code', { ...ISO, organism_code: '' }], ['organism_code 65 chars', { ...ISO, organism_code: 'x'.repeat(65) }],
    ['empty organism_display', { ...ISO, organism_display: '' }], ['organism_display 201 chars', { ...ISO, organism_display: 'x'.repeat(201) }],
    ['growth_text 201 chars', { ...ISO, growth_text: 'x'.repeat(201) }], ['growth_text null', { ...ISO, growth_text: null }],
  ])('AC-15.2 isolates element rejected: %s', (_n, el) => { expect(isolateErrors([el]).length).toBeGreaterThan(0); });

  it('AC-15.2 isolates: 20 elements pass, 21 fail; not an array fails', () => {
    expect(isolateErrors(Array.from({ length: 20 }, (_, i) => ({ ...ISO, seq: i + 1 })))).toEqual([]);
    expect(isolateErrors(Array.from({ length: 21 }, (_, i) => ({ ...ISO, seq: i + 1 }))).length).toBeGreaterThan(0);
    expect(isolateErrors({ ...ISO }).length).toBeGreaterThan(0);
  });

  it.each([
    ['missing key (standard_version)', (() => { const { standard_version: _s, ...r } = AST; return r; })()],
    ['extra key (is_reportable)', { ...AST, is_reportable: true }],
    ['isolate_seq 0', { ...AST, isolate_seq: 0 }], ['isolate_seq 100', { ...AST, isolate_seq: 100 }],
    ['method not in enum', { ...AST, method: 'disk' }], ['standard not in enum (unknown)', { ...AST, standard: 'unknown' }], ['standard lower-case', { ...AST, standard: 'clsi' }],
    ['empty raw_value', { ...AST, raw_value: '' }], ['raw_value 33 chars', { ...AST, raw_value: '1'.repeat(33) }], ['raw_value as number', { ...AST, raw_value: 2 }],
    ['empty category_code', { ...AST, category_code: '' }], ['category_code 9 chars', { ...AST, category_code: 'S'.repeat(9) }],
    ['antibiotic_code 65 chars', { ...AST, antibiotic_code: 'x'.repeat(65) }], ['antibiotic_display 201 chars', { ...AST, antibiotic_display: 'x'.repeat(201) }],
    ['standard_version 33 chars', { ...AST, standard_version: 'x'.repeat(33) }], ['empty standard_version', { ...AST, standard_version: '' }],
  ])('AC-15.2 ast element rejected: %s', (_n, el) => { expect(astErrors([el]).length).toBeGreaterThan(0); });

  it.each([['mic'], ['zone_diameter'], ['other']])('AC-15.2 ast method %s and every standard (CLSI, EUCAST, ECOFF) are accepted', (method) => {
    for (const standard of ['CLSI', 'EUCAST', 'ECOFF']) expect(astErrors([{ ...AST, method, standard }])).toEqual([]);
  });

  it('AC-15.2 ast: 600 elements pass, 601 fail', () => {
    expect(astErrors(Array.from({ length: 600 }, () => AST))).toEqual([]);
    expect(astErrors(Array.from({ length: 601 }, () => AST)).length).toBeGreaterThan(0);
  });

  it('AC-15.2 the API-side validator (domain/snapshot.ts validateSnapshot) agrees with the contract on every accept/reject case above (no drift between the two copies of the schema)', () => {
    const bad = (isolates: unknown, ast: unknown) => { try { validateSnapshot({ isolates, ast }); return null; } catch (e) { return e; } };
    expect(bad([ISO], [AST])).toBeNull(); expect(bad([], [])).toBeNull();
    for (const el of [{ ...ISO, colony_description: 'x' }, { ...ISO, seq: 100 }, { ...ISO, organism_code: '' }, { seq: 1, organism_code: 'a', organism_display: 'b' }]) {
      expect(isLimsError(bad([el], []), 'common.internal'), JSON.stringify(el)).toBe(true);
    }
    for (const el of [{ ...AST, is_reportable: true }, { ...AST, method: 'disk' }, { ...AST, standard: 'unknown' }, { ...AST, raw_value: '' }, { ...AST, category_code: 'S'.repeat(9) }]) {
      expect(isLimsError(bad([], [el]), 'common.internal'), JSON.stringify(el)).toBe(true);
    }
    expect(isLimsError(bad(Array.from({ length: 21 }, (_, i) => ({ ...ISO, seq: i + 1 })), []), 'common.internal')).toBe(true);
    expect(isLimsError(bad([], Array.from({ length: 601 }, () => AST)), 'common.internal')).toBe(true);
  });

  const FILE = join(REPO_ROOT, 'contracts', 'views', 'micro.v_pub_report_content.schema.json');
  it.skipIf(!existsSync(FILE))('C0 transcription contracts/views/micro.v_pub_report_content.schema.json holds both schemas, equal to 05-SCHEMA §6', () => {
    const text = readFileSync(FILE, 'utf8'); const doc = JSON.parse(text);
    const found: Row[] = []; const walk = (n: any): void => { if (n && typeof n === 'object') { if (typeof n['$id'] === 'string') found.push(n); for (const v of Object.values(n)) walk(v); } }; walk(doc);
    const by = Object.fromEntries(found.map((s) => [s['$id'], s]));
    expect(by[ISOLATES_SCHEMA.$id]).toEqual(ISOLATES_SCHEMA); expect(by[AST_SCHEMA.$id]).toEqual(AST_SCHEMA);
  });
});

// ================================================================== part 2 — the view in the migrated database
const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T17_REQUIRE_DB'] === '1';
const A = TENANT_A, B = TENANT_B;
const RUN = Date.now(); let seqN = 0;
const uid = () => `0190c617-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOWISO = '2026-11-05T05:00:00.000Z';
let api: pg.Pool; let admin: pg.Pool;
const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;

async function seedRow(table: string, given: Record<string, unknown>, onConflict = ''): Promise<void> {
  const [schema, name] = table.split('.') as [string, string];
  const c = await admin.connect();
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
    const cols = (await c.query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
      AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows as { column_name: string; udt_name: string }[];
    const row: Record<string, unknown> = { ...given };
    for (const { column_name, udt_name } of cols) {
      if (column_name in row) continue;
      row[column_name] = udt_name === 'uuid' ? uid() : /^(int|numeric|float)/.test(udt_name) ? 1 : udt_name === 'bool' ? false : udt_name === 'timestamptz' || udt_name === 'timestamp' ? NOWISO
        : udt_name === 'date' ? '2026-11-01' : udt_name === 'jsonb' || udt_name === 'json' ? '[]' : `syn-${seqN}`;
    }
    const keys = Object.keys(row);
    await c.query(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ${onConflict}`,
      keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) && !Array.isArray(row[k]) ? JSON.stringify(row[k]) : row[k])));
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

const W = { order: uid(), centreA1: uid(), centreA2: uid(), centreB: uid(), patient: uid(), test: uid(), user: uid(), memHub: uid(), memA1: uid(), memB: uid() };
const CODE = { ecoli: `syn_t17_ecoli_${RUN}`, amp: `syn_t17_amp_${RUN}`, cip: `syn_t17_cip_${RUN}` };
interface Cul { id: string; specimen: string; item: string; result: string }
interface Who { tenant: string; membership: string; actorType?: string }
const HUB: Who = { tenant: A, membership: W.memHub }; const ONLY_A1: Who = { tenant: A, membership: W.memA1 }; const AS_B: Who = { tenant: B, membership: W.memB };
let lab: any;

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 8 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await seedRow('core.tenants', { id: t }, 'ON CONFLICT DO NOTHING');
  for (const [t, id] of [[A, W.centreA1], [A, W.centreA2], [B, W.centreB]] as const) await seedRow('core.collection_centres', { tenant_id: t, id });
  await seedRow('core.users', { tenant_id: A, id: W.user, display_name: 'Synthetic Tech T17' });
  for (const [t, id, all] of [[A, W.memHub, true], [A, W.memA1, false], [B, W.memB, true]] as const) {
    await seedRow('core.memberships', { tenant_id: t, id, user_id: W.user, actor_type: 'user', status: 'active', is_active: true, all_centres: all });
  }
  await seedRow('core.membership_centres', { tenant_id: A, membership_id: W.memA1, centre_id: W.centreA1 });
  await seedRow('frontdesk.patients', { tenant_id: A, id: W.patient }); await seedRow('catalog.tests', { tenant_id: A, id: W.test });
  await seedRow('micro.cs_organisms', { tenant_id: A, code: CODE.ecoli, display: 'Synthetic E. coli', is_active: true, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
  for (const [c, d] of [[CODE.amp, 'Synthetic ampicillin'], [CODE.cip, 'Synthetic ciprofloxacin']] as const) await seedRow('micro.cs_antibiotics', { tenant_id: A, code: c, display: d, is_active: true, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
}, 60_000);
afterAll(async () => { await api?.end(); await admin?.end(); });

/** Run `sql` as the application role under the given claims, in one rolled-back transaction. */
async function asWho<T = Row>(who: Who, sql: string, values: unknown[] = []): Promise<T[]> {
  const cl = await api.connect();
  try {
    await cl.query('BEGIN');
    await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: who.tenant, sub: SYS, actor_type: who.actorType ?? 'user', membership_id: who.membership })]);
    return (await cl.query(sql, values)).rows as T[];
  } finally { await cl.query('ROLLBACK'); cl.release(); }
}
async function rejected(who: Who, sql: string, values: unknown[] = []): Promise<any> {
  const cl = await api.connect();
  try {
    await cl.query('BEGIN');
    await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: who.tenant, sub: SYS, actor_type: 'user', membership_id: who.membership })]);
    try { await cl.query(sql, values); } catch (e) { return e; }
    return undefined;
  } finally { await cl.query('ROLLBACK'); cl.release(); }
}
const VIEW = 'micro.v_pub_report_content';

async function newCulture(o: { status?: string; tenant?: string; centre?: string } = {}): Promise<Cul> {
  const c: Cul = { id: uid(), specimen: uid(), item: uid(), result: uid() }; const tenant = o.tenant ?? A;
  await seedRow('lab.specimens', { tenant_id: tenant, id: c.specimen });
  await seedRow('frontdesk.order_items', { tenant_id: tenant, id: c.item }); await seedRow('lab.results', { tenant_id: tenant, id: c.result, order_item_id: c.item });
  await seedRow('micro.cultures', { id: c.id, tenant_id: tenant, centre_id: o.centre ?? W.centreA1, order_id: W.order, order_item_id: c.item, specimen_id: c.specimen, patient_id: W.patient, test_id: W.test, specimen_type_code: 'urine',
    status: o.status ?? 'incubating', received_at: '2026-11-04T04:00:00.000Z', planted_at: '2026-11-04T05:00:00.000Z', last_specimen_seq: 1, created_by: SYS, updated_by: SYS, version: 1 });
  return c;
}
async function addIsolate(c: Cul, seq: number): Promise<string> {
  const id = uid();
  await seedRow('micro.isolates', { id, tenant_id: A, centre_id: W.centreA1, culture_id: c.id, specimen_id: c.specimen, isolate_seq: seq, status: 'identified', organism_code: CODE.ecoli, organism_source: 'manual', identified_at: NOWISO, is_reportable: true, created_by: SYS, updated_by: SYS, version: 2 });
  return id;
}
async function addAst(c: Cul, isolate: string, abx: string, over: Row = {}): Promise<string> {
  const id = uid();
  await seedRow('micro.ast_results', { id, tenant_id: A, centre_id: W.centreA1, culture_id: c.id, isolate_id: isolate, antibiotic_code: abx, method: 'mic', raw_value: '2', category_code: 'S', standard: 'CLSI', standard_version: 'M100-2026', standard_source: 'manual', source: 'manual',
    off_panel: true, is_reportable: true, report_visibility: 'shown', suggestion_overridden: false, created_by: SYS, updated_by: SYS, version: 1, ...over });
  return id;
}
/** A stored report_versions row written directly (no service): the table is the record the view exposes. */
async function putVersion(tenant: string, centre: string, c: Cul, n: number, over: Row = {}): Promise<Row> {
  const row: Row = { tenant_id: tenant, centre_id: centre, culture_id: c.id, order_item_id: c.item, version_no: n, report_phase: n === 1 ? 'preliminary' : 'final', version_kind: n === 1 ? 'initial' : 'update', submission_kind: 'ast_panel',
    outcome_code: n === 1 ? null : 'growth_reported', culture_summary_text: `Synthetic summary ${n} for ${c.id.slice(-6)}`, isolates: [ISO], ast: [AST], comments_text: n === 1 ? null : 'Synthetic comment', is_critical: false, flag: 'N',
    signed_by_membership_id: tenant === A ? W.memHub : W.memB, signed_at: `2026-11-0${n}T06:00:00.000Z`, lab_result_id: c.result, lab_result_version_no: n, lab_status_at_submit: 'resulted', lab_replayed: false, created_by: SYS, ...over };
  row['id'] = uid(); await seedRow('micro.report_versions', row); return row;
}
async function setLab(cs: Cul[]): Promise<void> {
  lab = createFakeLabPort({ seed: 1, fixtures: { grants: { [SYS]: [LAB_READ, 'lab.result.amend'] }, orders: [{ id: W.order, tenantId: A, patientId: W.patient, centreId: W.centreA1, priority: 'routine', patient: { sex: 'female', ageDays: 9000 } }],
    items: cs.map((c) => ({ id: c.item, tenantId: A, orderId: W.order, testId: W.test, departmentId: uid(), workflowType: 'microbiology' })),
    results: cs.map((c) => ({ id: c.result, tenantId: A, orderItemId: c.item, testId: W.test, analyteId: uid(), versionNo: 1, status: 'pending', origin: 'module', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false })) } as any });
}
/** A1 submission through the real handler (M14), one transaction under RLS with user claims, like the core wrapper. */
async function submit(c: Cul, body: Row): Promise<{ res?: any; err?: any }> {
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'user', membership_id: W.memHub })]);
    const { ctx } = mkCtx({ tenantId: A, tx: client, grants: [WORK], actor: { type: 'user', id: SYS, membershipId: W.memHub }, members: { [W.memHub]: 'Synthetic Tech T17' }, users: { [W.user]: 'Synthetic Tech T17' },
      tests: { [W.test]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } } });
    ctx.ports.LabPort = lab;
    try { const res = await run('submitCultureReport', { params: { culture_id: c.id }, headers: { 'idempotency-key': `k-${uid()}` }, body }, ctx); await client.query('COMMIT'); return { res }; } catch (err) { await client.query('ROLLBACK'); return { err }; }
  } finally { client.release(); }
}
const viewRows = (c: Cul, who: Who = HUB) => asWho(who, `SELECT * FROM ${VIEW} WHERE entity_id = $1 ORDER BY version_no`, [c.id]);
const stored = (c: Cul) => q('SELECT * FROM micro.report_versions WHERE culture_id = $1 ORDER BY version_no', [c.id]);
const sameInstant = (a: unknown, b: unknown) => new Date(a as any).getTime() === new Date(b as any).getTime();

describe.skipIf(!live && !REQUIRE)('T-17 micro.v_pub_report_content (live DB)', () => {
  it('database is provided', () => { expect(live).toBe(true); });

  describe('AC-15.1 columns and order; security_invoker; grants (05-SCHEMA §6, §10 test 7, REQ-SEC-031)', () => {
    it('the object is a plain view in schema micro with exactly the 03-IC §6.8 columns, in order, with the contract types', async () => {
      const rel = await q("SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'micro' AND c.relname = 'v_pub_report_content'");
      expect(rel, 'view micro.v_pub_report_content exists (C0 prerequisite)').toEqual([{ relkind: 'v' }]);
      const cols = await q(`SELECT a.attname AS name, t.typname AS type FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = 'micro.v_pub_report_content'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
      expect(cols.map((r) => [r['name'], r['type']])).toEqual(COLUMNS.map(([n, t]) => [n, t]));
    });

    it('REQ-SEC-031 security_invoker is on (reloptions); the internal coded-set views v_organisms / v_antibiotics are security_invoker too', async () => {
      const opts = await q(`SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'micro' AND c.relname IN ('v_pub_report_content', 'v_organisms', 'v_antibiotics') ORDER BY c.relname`);
      expect(opts.map((r) => r['relname'])).toEqual(['v_antibiotics', 'v_organisms', 'v_pub_report_content']);
      for (const r of opts) expect((r['reloptions'] as string[] | null) ?? [], `${r['relname']}`.toString()).toEqual(expect.arrayContaining([expect.stringMatching(/^security_invoker=(true|on)$/)]));
    });

    it('the view reads micro.report_versions and nothing else (pg_depend); no column of the view is computed from another table', async () => {
      const deps = await q(`SELECT DISTINCT d.refobjid::regclass::text AS rel FROM pg_rewrite r JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass
        WHERE r.ev_class = 'micro.v_pub_report_content'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> 'micro.v_pub_report_content'::regclass`);
      expect(deps.map((r) => r['rel'])).toEqual(['micro.report_versions']);
    });

    it('grants: lims_app has SELECT and no INSERT/UPDATE/DELETE/TRUNCATE on the view; the connected role can SELECT', async () => {
      const g = (await q(`SELECT has_table_privilege('lims_app', 'micro.v_pub_report_content', 'SELECT') AS s, has_table_privilege('lims_app', 'micro.v_pub_report_content', 'INSERT') AS i,
        has_table_privilege('lims_app', 'micro.v_pub_report_content', 'UPDATE') AS u, has_table_privilege('lims_app', 'micro.v_pub_report_content', 'DELETE') AS d,
        has_table_privilege('lims_app', 'micro.v_pub_report_content', 'TRUNCATE') AS t`))[0];
      expect(g).toEqual({ s: true, i: false, u: false, d: false, t: false });
      expect((await api.query("SELECT has_table_privilege(current_user, 'micro.v_pub_report_content', 'SELECT') AS s")).rows[0]).toEqual({ s: true });
    });

    it('entity_id is the culture id and every column carries the stored value (AC-15.1): v1 preliminary with comments NULL, v2 final with comments', async () => {
      const c = await newCulture(); const v1 = await putVersion(A, W.centreA1, c, 1); const v2 = await putVersion(A, W.centreA1, c, 2);
      const rows = await viewRows(c); expect(rows).toHaveLength(2);
      for (const [row, v] of [[rows[0]!, v1], [rows[1]!, v2]] as const) {
        expect(Object.keys(row)).toEqual(COLUMNS.map(([n]) => n));
        expect(row).toMatchObject({ tenant_id: A, entity_id: c.id, version_no: v['version_no'], order_item_id: c.item, report_phase: v['report_phase'], culture_summary_text: v['culture_summary_text'],
          isolates: v['isolates'], ast: v['ast'], comments_text: v['comments_text'], signed_by_membership_id: v['signed_by_membership_id'] });
        expect(sameInstant(row['signed_at'], v['signed_at'])).toBe(true);
      }
      expect(rows[0]!['comments_text']).toBeNull(); expect(rows[1]!['comments_text']).toBe('Synthetic comment');
      expect(rows.map((r) => r['report_phase'])).toEqual(['preliminary', 'final']);
    });

    it('a lookup by (tenant_id, entity_id, version_no) returns exactly one row (C6/C14 access path); a missing version returns none', async () => {
      const c = await newCulture(); await putVersion(A, W.centreA1, c, 1); await putVersion(A, W.centreA1, c, 2);
      expect(await asWho(HUB, `SELECT version_no FROM ${VIEW} WHERE tenant_id = $1 AND entity_id = $2 AND version_no = 2`, [A, c.id])).toEqual([{ version_no: 2 }]);
      expect(await asWho(HUB, `SELECT version_no FROM ${VIEW} WHERE tenant_id = $1 AND entity_id = $2 AND version_no = 3`, [A, c.id])).toEqual([]);
    });

    it('the columns the view must NOT publish (outcome_code, flag, is_critical, centre_id, lab_*, created_*) are not selectable', async () => {
      for (const col of ['outcome_code', 'flag', 'is_critical', 'centre_id', 'lab_result_id', 'version_kind', 'submission_kind', 'created_by']) {
        const e = await rejected(HUB, `SELECT ${col} FROM ${VIEW} LIMIT 1`); expect(e?.code, col).toBe('42703');
      }
    });
  });

  describe('AC-15.2 JSON content of a version submitted through A1 (M14) validates against the schemas', () => {
    it('preliminary then final: every view row has the exact JSON keys (none missing, none extra), the isolates/ast of the stored snapshot, and passes both schemas; `[]` is allowed', async () => {
      const empty = await newCulture(); await setLab([empty]);
      expect((await submit(empty, { report_phase: 'preliminary', is_critical: false })).err).toBeUndefined();
      const ev = await viewRows(empty); expect(ev).toHaveLength(1); expect(ev[0]).toMatchObject({ isolates: [], ast: [] }); expect(isolateErrors(ev[0]!['isolates'])).toEqual([]); expect(astErrors(ev[0]!['ast'])).toEqual([]);

      const c = await newCulture(); const i1 = await addIsolate(c, 1); const i2 = await addIsolate(c, 2);
      await addAst(c, i1, CODE.amp, { raw_value: '<=0.25' }); await addAst(c, i1, CODE.cip, { category_code: 'R', method: 'zone_diameter', raw_value: '12', standard: 'EUCAST', standard_version: 'v14.0' }); await addAst(c, i2, CODE.amp, { category_code: 'I' });
      await setLab([c]);
      const r1 = await submit(c, { report_phase: 'preliminary', is_critical: false }); expect(r1.err, `${r1.err?.code ?? r1.err}`).toBeUndefined();
      const r2 = await submit(c, { report_phase: 'final', outcome_code: 'growth_reported', is_critical: false }); expect(r2.err, `${r2.err?.code ?? r2.err}`).toBeUndefined();
      const rows = await viewRows(c); expect(rows.map((r) => r['version_no'])).toEqual([1, 2]);
      for (const r of rows) {
        expect(isolateErrors(r['isolates']), `v${r['version_no']} isolates`).toEqual([]); expect(astErrors(r['ast']), `v${r['version_no']} ast`).toEqual([]);
        expect((r['isolates'] as Row[]).map((x) => Object.keys(x).sort())).toEqual([['growth_text', 'organism_code', 'organism_display', 'seq'], ['growth_text', 'organism_code', 'organism_display', 'seq']]);
        for (const a of r['ast'] as Row[]) expect(Object.keys(a).sort()).toEqual(['antibiotic_code', 'antibiotic_display', 'category_code', 'isolate_seq', 'method', 'raw_value', 'standard', 'standard_version']);
        expect(Array.isArray(r['isolates'])).toBe(true); expect(Array.isArray(r['ast'])).toBe(true);
      }
      expect(rows[1]!['isolates'].map((x: Row) => [x['seq'], x['organism_display']])).toEqual([[1, 'Synthetic E. coli'], [2, 'Synthetic E. coli']]);
      // ordering rule (05-SCHEMA §6): isolates by seq; ast by isolate_seq, then panel sort_order, then antibiotic_display
      expect(rows[1]!['ast'].map((a: Row) => [a['isolate_seq'], a['antibiotic_display']])).toEqual([[1, 'Synthetic ampicillin'], [1, 'Synthetic ciprofloxacin'], [2, 'Synthetic ampicillin']]);
      expect(rows[1]!['ast'][0]).toMatchObject({ raw_value: '<=0.25', method: 'mic', standard: 'CLSI', standard_version: 'M100-2026', category_code: 'S' });   // the qualifier is carried as entered
      // the view equals the stored snapshot and the C5-bound summary text (same text as summaryText)
      const st = await stored(c); expect(rows.map((r) => r['culture_summary_text'])).toEqual(st.map((s) => s['culture_summary_text']));
      expect(rows.every((r) => typeof r['culture_summary_text'] === 'string' && r['culture_summary_text'].length >= 1 && r['culture_summary_text'].length <= 4000)).toBe(true);
      expect(lab.calls('submitModuleResult').map((x: any) => x.input.payloadRef)).toMatchObject([{ module: 'micro', entityId: c.id, versionNo: 1 }, { module: 'micro', entityId: c.id, versionNo: 2 }]);
      expect(rows.map((r) => r['entity_id'])).toEqual([c.id, c.id]);
    });

    it('rows that violate the contract cannot be told apart from valid ones by the view (it does not repair): an out-of-contract stored row is returned as stored and fails the schema (the write path, not the view, guards it)', async () => {
      const c = await newCulture(); await putVersion(A, W.centreA1, c, 1, { ast: [{ ...AST, is_reportable: true }] });
      const [row] = await viewRows(c); expect(astErrors(row!['ast']).length).toBeGreaterThan(0);
    });

    it('report_versions__json__ck: the table refuses a non-array isolates/ast and more than 20 isolates / 600 AST rows (the DB half of the contract)', async () => {
      const c = await newCulture();
      for (const over of [{ isolates: {} }, { ast: { not_an_array: true } },{ isolates: Array.from({ length: 21 }, (_, i) => ({ ...ISO, seq: i + 1 })) }, { ast: Array.from({ length: 601 }, () => AST) }]) {
        await expect(putVersion(A, W.centreA1, c, 1, over), JSON.stringify(Object.keys(over))).rejects.toMatchObject({ code: '23514' });
      }
    });
  });

  describe('AC-15.3 / S-27 / S-28 probes: tenant and centre scope through security_invoker', () => {
    it('tenant A claims read zero rows of tenant B — unfiltered, filtered by tenant_id = B, and by the B entity id; B claims read their own', async () => {
      const ca = await newCulture({ centre: W.centreA1 }); const cb = await newCulture({ tenant: B, centre: W.centreB });
      await putVersion(A, W.centreA1, ca, 1); await putVersion(B, W.centreB, cb, 1);
      expect((await asWho(HUB, `SELECT DISTINCT tenant_id FROM ${VIEW}`)).map((r) => r['tenant_id'])).toEqual([A]);
      expect(await asWho(HUB, `SELECT 1 FROM ${VIEW} WHERE tenant_id = $1`, [B])).toEqual([]);
      expect(await asWho(HUB, `SELECT 1 FROM ${VIEW} WHERE entity_id = $1`, [cb.id])).toEqual([]);
      expect(await asWho(HUB, `SELECT 1 FROM ${VIEW} WHERE tenant_id = $1 AND entity_id = $2 AND version_no = 1`, [B, cb.id])).toEqual([]);
      expect((await asWho(AS_B, `SELECT entity_id FROM ${VIEW} WHERE entity_id = $1`, [cb.id]))).toEqual([{ entity_id: cb.id }]);
      expect(await asWho(AS_B, `SELECT 1 FROM ${VIEW} WHERE entity_id = $1`, [ca.id])).toEqual([]);
      expect((await asWho(AS_B, `SELECT DISTINCT tenant_id FROM ${VIEW}`)).map((r) => r['tenant_id'])).toEqual([B]);
    });

    it('a request whose claims name tenant A but a membership of tenant B (mixed claims) reads nothing; no claims at all read nothing', async () => {
      const ca = await newCulture(); await putVersion(A, W.centreA1, ca, 1);
      expect(await asWho({ tenant: A, membership: W.memB }, `SELECT 1 FROM ${VIEW} WHERE entity_id = $1`, [ca.id])).toEqual([]);
      const cl = await api.connect(); let rows: unknown[] = []; let failed: any;
      try { await cl.query('BEGIN'); rows = (await cl.query(`SELECT 1 FROM ${VIEW}`)).rows; } catch (e) { failed = e; } finally { await cl.query('ROLLBACK'); cl.release(); }
      if (failed) expect(String(failed.code ?? failed.message), 'no claims: an error is acceptable, rows are not').toMatch(/./); else expect(rows).toEqual([]);
    });

    it('centre scope (D-63): an A1-only membership sees A1 versions and none of A2; the all_centres hub membership sees both; filtering by the A2 entity gives zero rows, not an error', async () => {
      const c1 = await newCulture({ centre: W.centreA1 }); const c2 = await newCulture({ centre: W.centreA2 });
      await putVersion(A, W.centreA1, c1, 1); await putVersion(A, W.centreA1, c1, 2); await putVersion(A, W.centreA2, c2, 1);
      expect((await viewRows(c1, ONLY_A1)).map((r) => r['version_no'])).toEqual([1, 2]);
      expect(await viewRows(c2, ONLY_A1)).toEqual([]);
      expect(await asWho(ONLY_A1, `SELECT 1 FROM ${VIEW} WHERE tenant_id = $1 AND entity_id = $2 AND version_no = 1`, [A, c2.id])).toEqual([]);
      expect((await asWho(ONLY_A1, `SELECT DISTINCT entity_id FROM ${VIEW} WHERE entity_id = ANY($1::uuid[])`, [[c1.id, c2.id]])).map((r) => r['entity_id'])).toEqual([c1.id]);
      expect((await asWho(HUB, `SELECT DISTINCT entity_id FROM ${VIEW} WHERE entity_id = ANY($1::uuid[]) ORDER BY 1`, [[c1.id, c2.id]])).map((r) => r['entity_id']).sort()).toEqual([c1.id, c2.id].sort());
      expect(await viewRows(c2, HUB)).toHaveLength(1);
    });

    it.each([['partner'], ['portal'], ['patient']])('S-28 actor guard: %s claims of tenant A read zero rows through the view (the rows exist for the user actor)', async (actorType) => {
      const c = await newCulture(); await putVersion(A, W.centreA1, c, 1);
      expect(await viewRows(c, HUB)).toHaveLength(1);
      expect(await asWho({ ...HUB, actorType }, `SELECT 1 FROM ${VIEW} WHERE entity_id = $1`, [c.id])).toEqual([]);
      expect(await asWho({ ...HUB, actorType }, `SELECT count(*)::int AS n FROM ${VIEW}`)).toEqual([{ n: 0 }]);
    });

    it('security_invoker is honoured, not the owner: reading the view as the app role under tenant A claims returns the same rows as reading micro.report_versions directly under the same claims', async () => {
      const c = await newCulture(); await putVersion(A, W.centreA1, c, 1); const c2 = await newCulture({ centre: W.centreA2 }); await putVersion(A, W.centreA2, c2, 1);
      for (const who of [HUB, ONLY_A1]) {
        const viaView = (await asWho(who, `SELECT entity_id, version_no FROM ${VIEW} WHERE entity_id = ANY($1::uuid[]) ORDER BY 1, 2`, [[c.id, c2.id]]));
        const viaTable = (await asWho(who, 'SELECT culture_id AS entity_id, version_no FROM micro.report_versions WHERE culture_id = ANY($1::uuid[]) ORDER BY 1, 2', [[c.id, c2.id]]));
        expect(viaView).toEqual(viaTable);
      }
    });
  });

  describe('AC-15.4 immutability: a submitted (entity_id, version_no) row never changes', () => {
    it('after v1 is submitted, later submissions, edits of the working rows, a coded-set display rename and a re-read leave the v1 view row byte-identical; v2 only appends', async () => {
      const c = await newCulture(); const iso = await addIsolate(c, 1); const ast = await addAst(c, iso, CODE.amp); await setLab([c]);
      expect((await submit(c, { report_phase: 'preliminary', is_critical: false })).err).toBeUndefined();
      const [v1] = await viewRows(c); expect(v1).toBeDefined(); const frozen = JSON.stringify(v1); const storedFrozen = JSON.stringify((await stored(c))[0]);

      // the working rows change after the submission (the culture is still incubating, so the DB allows it) ...
      await q("UPDATE micro.ast_results SET raw_value = '16', category_code = 'R' WHERE id = $1", [ast]); await q("UPDATE micro.isolates SET quantity_text = 'changed later' WHERE id = $1", [iso]);
      await q("UPDATE micro.cs_organisms SET display = 'Renamed organism' WHERE tenant_id = $1 AND code = $2", [A, CODE.ecoli]); await q("UPDATE micro.cs_antibiotics SET display = 'Renamed antibiotic' WHERE tenant_id = $1 AND code = $2", [A, CODE.amp]);
      try { expect(JSON.stringify((await viewRows(c))[0])).toBe(frozen); }
      finally {
        await q("UPDATE micro.cs_organisms SET display = 'Synthetic E. coli' WHERE tenant_id = $1 AND code = $2", [A, CODE.ecoli]); await q("UPDATE micro.cs_antibiotics SET display = 'Synthetic ampicillin' WHERE tenant_id = $1 AND code = $2", [A, CODE.amp]);
      }
      // ... a further submission appends v2 whose content reflects the new state, and v1 still equals the frozen row
      expect((await submit(c, { report_phase: 'final', outcome_code: 'growth_reported', is_critical: false })).err).toBeUndefined();
      const rows = await viewRows(c); expect(rows.map((r) => r['version_no'])).toEqual([1, 2]);
      expect(JSON.stringify(rows[0])).toBe(frozen); expect(JSON.stringify((await stored(c))[0])).toBe(storedFrozen);
      expect(rows[0]!['ast'][0]).toMatchObject({ raw_value: '2', category_code: 'S' }); expect(rows[1]!['ast'][0]).toMatchObject({ raw_value: '16', category_code: 'R' });
      // re-reading is stable
      expect(JSON.stringify((await viewRows(c))[0])).toBe(frozen);
    });

    it('a rejected or rolled-back submission leaves no row and does not change earlier ones (C5 failure rolls the version back)', async () => {
      const c = await newCulture(); const iso = await addIsolate(c, 1); await addAst(c, iso, CODE.amp); await setLab([c]);
      expect((await submit(c, { report_phase: 'preliminary', is_critical: false })).err).toBeUndefined();
      const before = JSON.stringify(await viewRows(c));
      lab.failNext('submitModuleResult', 'lab.module_result_invalid');
      expect((await submit(c, { report_phase: 'preliminary', is_critical: false })).err?.code).toBe('lab.module_result_invalid');
      expect(JSON.stringify(await viewRows(c))).toBe(before);
    });

    it('the application role cannot change a published row, through the view or the table: UPDATE / DELETE / INSERT -> permission denied (42501); the row is unchanged', async () => {
      const c = await newCulture(); await putVersion(A, W.centreA1, c, 1); const frozen = JSON.stringify(await viewRows(c));
      for (const sql of [
        `UPDATE ${VIEW} SET culture_summary_text = 'tampered' WHERE entity_id = $1`, `DELETE FROM ${VIEW} WHERE entity_id = $1`,
        "UPDATE micro.report_versions SET culture_summary_text = 'tampered' WHERE culture_id = $1", 'DELETE FROM micro.report_versions WHERE culture_id = $1',
        "UPDATE micro.report_versions SET ast = '[]'::jsonb WHERE culture_id = $1",
      ]) expect((await rejected(HUB, sql, [c.id]))?.code, sql).toBe('42501');
      const ins = await rejected(HUB, `INSERT INTO ${VIEW} (tenant_id, entity_id, version_no) VALUES ($1, $2, 9)`, [A, c.id]); expect(ins?.code).toBe('42501');
      expect(JSON.stringify(await viewRows(c))).toBe(frozen);
    });

    it('a second row for the same (entity_id, version_no) cannot exist: report_versions__culture_version__uq refuses it (23505), so the view key is unique', async () => {
      const c = await newCulture(); await putVersion(A, W.centreA1, c, 1);
      await expect(putVersion(A, W.centreA1, c, 1)).rejects.toMatchObject({ code: '23505' });
      expect(await viewRows(c)).toHaveLength(1);
    });

    it('version numbers per culture are contiguous 1..n and the preliminary/final phase of each stored row is one of the two contract values', async () => {
      const c = await newCulture(); const iso = await addIsolate(c, 1); await addAst(c, iso, CODE.amp); await setLab([c]);
      for (const b of [{ report_phase: 'preliminary', is_critical: false }, { report_phase: 'preliminary', is_critical: false }, { report_phase: 'final', outcome_code: 'growth_reported', is_critical: false }]) {
        expect((await submit(c, b)).err).toBeUndefined();
      }
      const rows = await viewRows(c); expect(rows.map((r) => r['version_no'])).toEqual([1, 2, 3]); expect(rows.map((r) => r['report_phase'])).toEqual(['preliminary', 'preliminary', 'final']);
    });
  });
});
