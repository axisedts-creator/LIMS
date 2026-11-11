// C5 T-25 — QC handlers #43-#46 against the migrated database: listQcResults, captureQcResult, listQcHolds, releaseQcHold (06 row T-25; 02-TRD §5.7 rows 43-46 + "#44 server-set columns";
// 05-SCHEMA lab.qc_results / lab.qc_holds; PRD AC-19.2, AC-19.3, AC-19.4; 07-SECURITY REQ-SEC-017, REQ-SEC-062/067, S-16, P-01, P-03; 03-IC §11 lab.qc_hold.release privileged).
// Needs the migrated+seeded database that tests/db/c5-t03/run.sh starts (see .orchestra/notes/C5.T-25-verify.cmd): LIMS_TEST_DATABASE_URL = role lims_api (RLS on),
// LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1 where "database is provided" fails.
//
// SEAMS (spec fixes behaviour, not names) — the writer adds handlers/<operationId>.ts (or one handlers/qc.handlers.ts spread into REAL, like config.handlers.ts) + service/qc.service.ts additions
//   (the file already exports holdResultsSince / isOnQcHold); same ctx / req / return shape as the T-29 handlers (req {params, query, headers, body}; ctx.tx = the request tx under RLS).
//   Permission = ctx.ports.IdentityPort.assertRole(ctx, { permission }) of the operation's x-permission; `auth.mfa_required` thrown by assertRole passes through unchanged (REQ-SEC-062/067).
//   Centre scope of #44 = IdentityPort.getActor().centreScope (as T-07/T-08); the stub's assertRole ALSO refuses a `centreId` outside that scope, so either implementation route is accepted.
// ASSUMED (spec silent; each one is listed in .orchestra/notes/C5.T-25-tests.md):
//   - #44 returns 201 with a closed QcResultDto; a centre outside the actor's scope -> 403 auth.forbidden (no row); a centre that does not exist in the tenant (other tenant's id) -> a 4xx, never a 500, no row;
//     analyte_id / instrument_id are format-checked only (no CatalogPort / C7 read exists, 02-TRD §5.7).
//   - #43 orders by instrument_result_time DESC, id DESC; RLS (centre_id) does the scoping: under a single-centre claim only that centre's rows come back.
//   - #45 `status` filters; the DTO has ONE analyte_id although qc_holds carries analyte_ids[]: the test only requires analyte_id ∈ analyte_ids (SPEC GAP, CR candidate); held_at = any valid IsoUtc.
//   - #46: status released, released_at = ctx.now(), released_by_membership_id = actor, release_comment, version + 1; every result of the hold (hold_id) gets on_hold = false (qc_review_required stays: display only);
//     a second release is a 409 and keeps the first comment; an unknown / other-tenant hold is 404; concurrent releases -> exactly one 200.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError, LimsError } from '../../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { holdResultsSince, isOnQcHold } from '../../service/qc.service.js';
import { handlers } from '../index.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEM = '01a1a98a-ac40-7000-8000-00000000a500';
const BRANCH = { [A]: '01a1a98a-ac40-7000-8000-00000000a101', [B]: '01a1a98a-ac40-7000-8000-00000000b101' } as Record<string, string>;
const CEN = '01a1a98a-ac40-7000-8000-00000000a201';          // db/seeds/010: tenant A centres a201 / a202, tenant B centre b201
const CEN2 = '01a1a98a-ac40-7000-8000-00000000a202';
const CENB = '01a1a98a-ac40-7000-8000-00000000b201';
const u = (n: number) => `0190c60d-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PATIENT = { [A]: u(0xa9), [B]: u(0xb9) } as Record<string, string>;
const NOW = new Date('2026-11-05T04:15:30.000Z');
const DAY = 86_400_000;
const iso = (d: unknown) => new Date(d as string | Date).toISOString();
const RUN = Date.now().toString(36);
const P = { capture: 'lab.qc.capture', read: 'lab.result.read', release: 'lab.qc_hold.release' } as const;
const ALL = [P.capture, P.read, P.release];

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
const claims = (tenantId: string, extra: object = {}) => JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system', ...extra });
const sql = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;
const colsCache = new Map<string, Set<string>>();
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
async function ins(c: pg.PoolClient, table: string, row: Record<string, unknown>) {
  if (!colsCache.has(table)) {
    const [s, t] = table.split('.');
    colsCache.set(table, new Set((await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [s, t])).rows.map((r) => r.column_name)));
  }
  const cols = colsCache.get(table)!;
  const r: Record<string, unknown> = { ...row };
  for (const a of ['created_by', 'updated_by']) if (cols.has(a) && !(a in r)) r[a] = SYS;
  const keys = Object.keys(r);
  await c.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => r[k]));
}

// ------------------------------------------------------------------ id generators + fixtures
let nextN = 0x100000 + (Date.now() % 0x100000) * 16;
const nid = () => u(nextN++);
const qcRow = (o: Record<string, unknown>) => sql('SELECT * FROM lab.qc_results WHERE id = $1', [o['id']]);
const manualRows = (control: string) => sql(`SELECT * FROM lab.qc_results WHERE tenant_id = $1 AND control_id_raw = $2 ORDER BY created_at`, [A, control]);
const holdRow = async (id: string) => (await sql('SELECT * FROM lab.qc_holds WHERE id = $1', [id]))[0];
const resultRow = async (id: string) => (await sql('SELECT * FROM lab.results WHERE id = $1', [id]))[0];

async function seedQc(tenant: string, row: Record<string, unknown>): Promise<string> {
  const id = nid();
  await asAdmin(tenant, (c) => ins(c, 'lab.qc_results', { id, tenant_id: tenant, centre_id: CEN, instrument_id: nid(), analyte_id: nid(), control_id_raw: `SEED-${RUN}`, value_raw: '5.0', value_numeric: '5.0',
    received_at: NOW.toISOString(), source: 'instrument', idempotency_key: `t25-h-${RUN}-${id}`, instrument_flags: [], ...row }));
  return id;
}
async function seedHold(tenant: string, o: Record<string, unknown> = {}): Promise<string> {
  const id = nid();
  await asAdmin(tenant, (c) => ins(c, 'lab.qc_holds', { id, tenant_id: tenant, qc_run_id: nid(), instrument_id: nid(), analyte_ids: [nid()], since: '2026-11-01T00:00:00.000Z', reason_code: 'qc_run_rejected', ...o }));
  return id;
}
/** order -> specimen -> N `resulted` results of one instrument + analyte (own item / order test each), seeded as admin under the tenant's claims. */
async function seedResults(tenant: string, n: number, instrumentId: string, analyteId: string): Promise<string[]> {
  const orderId = nid(); const spId = nid(); const centre = tenant === A ? CEN : CENB; const branch = BRANCH[tenant]!; const ids: string[] = [];
  await asAdmin(tenant, async (c) => {
    await ins(c, 'frontdesk.orders', { id: orderId, tenant_id: tenant, branch_id: branch, centre_id: centre, patient_id: PATIENT[tenant], registration_no: `RT25${orderId.slice(-8).toUpperCase()}`,
      status: 'registered', visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk', is_first_order_of_patient: false, catalog_revision: 1,
      registered_at: '2026-11-04T00:00:00.000Z' });
    await ins(c, 'lab.orders', { id: orderId, tenant_id: tenant, centre_id: centre, branch_id: branch, patient_id: PATIENT[tenant], registration_no: `RT25${orderId.slice(-8).toUpperCase()}`,
      visit_type: 'opd', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk', registered_at: '2026-11-04T00:00:00.000Z', patient_sex: 'female', patient_age_days: 10950,
      lab_status: 'active', last_order_seq: 1, items_version: 1 });
    await ins(c, 'lab.specimens', { id: spId, tenant_id: tenant, centre_id: centre, order_id: orderId, patient_id: PATIENT[tenant], barcode: `T25${String(nextN).padStart(9, '0')}`, creation_key: `${orderId}:WB:EDTA:0`,
      specimen_type_code: 'WB', container_code: 'EDTA', priority: 'routine', patient_sex: 'female', patient_age_days: 10950, status: 'in_process', ordered_at: '2026-11-04T00:00:00.000Z',
      collected_at: '2026-11-04T00:10:00.000Z', collected_by_membership_id: MEM, in_transit_at: '2026-11-04T00:20:00.000Z', received_at: '2026-11-04T00:30:00.000Z', received_by_membership_id: MEM,
      processing_centre_id: centre, processing_branch_id: branch });
    for (let i = 0; i < n; i++) {
      const itemId = nid(); const otId = nid(); const testId = nid(); const resultId = nid();
      await ins(c, 'frontdesk.order_items', { id: itemId, tenant_id: tenant, order_id: orderId, centre_id: centre, orderable_id: nid(), orderable_kind: 'test', code: `T25${i}`, name: `T25${i} (SYNTHETIC)`,
        test_ids: [testId], priority: 'routine', unit_price_paisa: 1000, price_list_id: u(0x98), price_list_version: 1, price_source: 'tenant_default', vat_treatment: 'exempt', added_in_items_version: 1 });
      await ins(c, 'lab.order_tests', { id: otId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, test_id: testId, test_code: `T25${i}`, test_revision: 1, catalog_revision: 1,
        department_id: u(0x901), workflow_type: 'standard', priority: 'routine', specimen_id: spId, status: 'resulted', ordered_at: '2026-11-04T00:00:00.000Z', received_at: '2026-11-04T00:30:00.000Z',
        processing_centre_id: centre, processing_branch_id: branch });
      await ins(c, 'lab.results', { id: resultId, tenant_id: tenant, centre_id: centre, processing_centre_id: centre, processing_branch_id: branch, order_id: orderId, order_item_id: itemId, order_test_id: otId,
        specimen_id: spId, patient_id: PATIENT[tenant], test_id: testId, analyte_id: analyteId, analyte_code: `T25A${i}`, department_id: u(0x901), is_reportable: true, result_type: 'numeric', status: 'resulted',
        origin: 'instrument', value_numeric: '5.0', unit_code: 'g/dL', instrument_id: instrumentId, resulted_at: '2026-11-04T01:00:00.000Z', first_resulted_at: '2026-11-04T01:00:00.000Z' });
      ids.push(resultId);
    }
  });
  return ids;
}
/** The real holdResultsSince (qc.service) in one tx as system: the way the qc_run.rejected consumer creates a hold with held results. */
async function holdWithResults(instrumentId: string, analyteId: string): Promise<{ holdId: string; runId: string }> {
  const runId = nid(); const c = await api.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]);
    await holdResultsSince({ tx: c, tenantId: A, actorId: SYS } as never, { instrumentId, analyteIds: [analyteId], since: '2026-11-01T00:00:00.000Z', qcRunId: runId, reasonCode: 'qc_run_rejected' });
    await c.query('COMMIT');
  } finally { c.release(); }
  return { holdId: (await sql('SELECT id FROM lab.qc_holds WHERE tenant_id = $1 AND qc_run_id = $2', [A, runId]))[0].id, runId };
}

// ------------------------------------------------------------------ driving a handler
interface Probe { roleCalls: any[]; audit: any[] }
interface Opts { grants?: readonly string[]; tenant?: string; scope?: { all?: boolean; centreIds?: readonly string[] }; mfa?: boolean; now?: Date; claimsExtra?: object }
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined as unknown, ...o });
let reqN = 0;
const idem = () => ({ 'idempotency-key': `t25-${RUN}-${reqN}` });

/** One request = one committed tx under RLS (claims of the ctx tenant); a throw rolls back, like the core request wrapper. */
async function call(operationId: string, r: ReturnType<typeof req>, o: Opts = {}): Promise<{ status: number; body: any; probe: Probe }> {
  const tenant = o.tenant ?? A;
  const probe: Probe = { roleCalls: [], audit: [] };
  const grants = o.grants ?? ALL;
  const scope = o.scope ?? { all: true, centreIds: [] };
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant, o.claimsExtra)]);
    const inScope = (centreId: string) => scope.all === true || (scope.centreIds ?? []).includes(centreId);
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: tenant, tx: client, requestId: u(0x9000 + reqN++), now: () => o.now ?? NOW,
      actor: { type: 'user', id: SYS, membershipId: MEM },
      ports: { IdentityPort: {
        async assertRole(_c: unknown, x: { permission: string; centreId?: string }) {
          probe.roleCalls.push(x);
          if (!grants.includes(x?.permission)) throw new LimsError('auth.forbidden');
          if (x?.centreId !== undefined && !inScope(x.centreId)) throw new LimsError('auth.forbidden');
          if (o.mfa && x.permission === P.release) throw new LimsError('auth.mfa_required');   // privileged permission, session at aal1 (REQ-SEC-062/067)
        },
        async getActor() { return { actor: { type: 'user', id: SYS }, permissions: [...grants], centreScope: scope, branchIds: [BRANCH[tenant]], isLocked: false }; },
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
const badRequest = (e: any) => { expect(isLimsError(e, 'common.validation_failed' as never), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(400); };
const clientError = (e: any) => { expect(e, 'a LimsError, never a raw pg error').toBeInstanceOf(LimsError); expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500); };

const INSTR = nid(), ANALYTE = nid();
const body44 = (control: string, over: Record<string, unknown> = {}) => ({ centre_id: CEN, instrument_id: INSTR, analyte_id: ANALYTE, control_id_raw: control, control_lot_raw: 'LOT-2611', control_level: 'L2',
  value_numeric: '5.40', unit_code: 'mmol_l', instrument_result_time: '2026-11-05T04:00:00.000Z', ...over });
const capture = (b: unknown, o: Opts = {}) => call('captureQcResult', req({ headers: idem(), body: b }), o);
const list = (query: object = {}, o: Opts = {}) => call('listQcResults', req({ query }), o);
const listHolds = (query: object = {}, o: Opts = {}) => call('listQcHolds', req({ query }), o);
const release = (holdId: string, body: unknown, o: Opts = {}) =>
  call('releaseQcHold', req({ params: { hold_id: holdId }, headers: idem(), body }), o);

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 12 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await asAdmin(t, async (c) => {
    if (!(await c.query('SELECT 1 FROM frontdesk.patients WHERE id = $1', [PATIENT[t]])).rowCount) {
      await ins(c, 'frontdesk.patients', { id: PATIENT[t], tenant_id: t, patient_code: 'P-T25', full_name: 'Test Patient T25', name_search: 'test patient t25', sex: 'female', registered_centre_id: t === A ? CEN : CENB });
    }
  });
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-25 handlers harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

// ================================================================== #44 captureQcResult (AC-19.2)
describe.skipIf(!live)('T-25 #44 captureQcResult (AC-19.2; 02-TRD §5.7 server-set columns)', () => {
  it('stores source manual with the server-set columns: centre from the body (in actor scope), entered_by = actor, value_raw = the DecimalString as received, received_at = ctx.now(), idempotency_key = manual:<id>', async () => {
    const control = `CTRL-${RUN}-1`;
    const r = await capture(body44(control), { scope: { all: false, centreIds: [CEN] } });
    expect(r.status).toBe(201);
    expect(schemaErrors('QcResultDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ centre_id: CEN, instrument_id: INSTR, analyte_id: ANALYTE, control_id_raw: control, control_lot_raw: 'LOT-2611', control_level: 'L2', value_numeric: '5.40', unit_code: 'mmol_l',
      instrument_result_time: '2026-11-05T04:00:00.000Z', source: 'manual', received_at: NOW.toISOString() });
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(P.capture);
    const rows = await manualRows(control);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.body.id, tenant_id: A, centre_id: CEN, instrument_id: INSTR, analyte_id: ANALYTE, source: 'manual', entered_by_membership_id: MEM, value_raw: '5.40', unit_code: 'mmol_l',
      idempotency_key: `manual:${r.body.id}`, mapping_status: null, instrument_message_id: null, control_lot_raw: 'LOT-2611', control_level: 'L2', created_by: SYS });
    expect(Number(rows[0].value_numeric)).toBe(5.4);
    expect(iso(rows[0].received_at)).toBe(NOW.toISOString());
    expect(iso(rows[0].instrument_result_time)).toBe('2026-11-05T04:00:00.000Z');
    const v = await sql('SELECT * FROM lab.v_pub_qc_result WHERE qc_result_id = $1', [r.body.id]);     // exposed to C9 (AC-19.1 wording, same view)
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ source: 'manual', control_id_raw: control });
  });

  it.each(['5.40', '0.0050', '-1.5', '100', '0'])('value_raw is the canonical text of the DecimalString as received (%s)', async (v) => {
    const control = `CTRL-${RUN}-v${v}`;
    const r = await capture(body44(control, { value_numeric: v }));
    expect(r.status).toBe(201);
    const rows = await manualRows(control);
    expect(rows[0]!.value_raw).toBe(v);
    expect(Number(rows[0]!.value_numeric)).toBe(Number(v));
  });

  it('optional fields (lot, level, unit) may be absent; the row is stored with NULLs', async () => {
    const control = `CTRL-${RUN}-min`;
    const b: Record<string, unknown> = body44(control);
    for (const k of ['control_lot_raw', 'control_level', 'unit_code']) delete b[k];
    const r = await capture(b);
    expect(r.status).toBe(201);
    expect(schemaErrors('QcResultDto', r.body)).toEqual([]);
    expect((await manualRows(control))[0]).toMatchObject({ control_lot_raw: null, control_level: null, unit_code: null });
  });

  it('every POST is a new row with its own manual:<id> key (no content dedupe; replay protection is the core Idempotency-Key)', async () => {
    const control = `CTRL-${RUN}-twice`;
    const a = await capture(body44(control)); const b = await capture(body44(control));
    expect(a.body.id).not.toBe(b.body.id);
    const rows = await manualRows(control);
    expect(rows.map((x) => x.idempotency_key).sort()).toEqual([`manual:${a.body.id}`, `manual:${b.body.id}`].sort());
  });

  it('permission: without lab.qc.capture -> 403 auth.forbidden and no row', async () => {
    const control = `CTRL-${RUN}-noperm`;
    expectCode(await failure(capture(body44(control), { grants: [P.read, P.release] })), 'auth.forbidden', 403);
    expect(await manualRows(control)).toHaveLength(0);
  });

  it('REQ-SEC-017: a centre outside the actor\'s scope -> 403 auth.forbidden, no row; with all-centres scope the same centre is accepted', async () => {
    const control = `CTRL-${RUN}-scope`;
    expectCode(await failure(capture(body44(control, { centre_id: CEN2 }), { scope: { all: false, centreIds: [CEN] } })), 'auth.forbidden', 403);
    expect(await manualRows(control)).toHaveLength(0);
    expect((await capture(body44(control, { centre_id: CEN2 }), { scope: { all: true } })).status).toBe(201);
    expect((await manualRows(control))[0]).toMatchObject({ centre_id: CEN2 });
  });

  it('P-01: another tenant\'s centre id (even with all-centres scope) is a 4xx and writes no row in either tenant', async () => {
    const control = `CTRL-${RUN}-xtenant`;
    clientError(await failure(capture(body44(control, { centre_id: CENB }), { scope: { all: true } })));
    expect(await sql('SELECT 1 FROM lab.qc_results WHERE control_id_raw = $1', [control])).toHaveLength(0);
  });

  it('the tenant comes from the context only: a tenant-B actor stores the row under tenant B', async () => {
    const control = `CTRL-${RUN}-tb`;
    const r = await capture(body44(control, { centre_id: CENB }), { tenant: B });
    expect(r.status).toBe(201);
    const rows = await sql('SELECT tenant_id FROM lab.qc_results WHERE control_id_raw = $1', [control]);
    expect(rows).toEqual([{ tenant_id: B }]);
  });

  const BAD: Array<[string, Record<string, unknown>]> = [
    ['unknown key (tenant_id)', { tenant_id: B }], ['unknown key (source)', { source: 'instrument' }], ['unknown key (idempotency_key)', { idempotency_key: 'x' }],
    ['value_numeric "abc"', { value_numeric: 'abc' }], ['value_numeric ""', { value_numeric: '' }], ['value_numeric as a JSON number', { value_numeric: 5.4 }], ['value_numeric "NaN"', { value_numeric: 'NaN' }],
    ['control_id_raw "" (min 1)', { control_id_raw: '' }], ['control_id_raw 65 chars', { control_id_raw: 'C'.repeat(65) }], ['control_lot_raw 65 chars', { control_lot_raw: 'L'.repeat(65) }],
    ['control_level 17 chars', { control_level: 'L'.repeat(17) }], ['instrument_result_time "yesterday"', { instrument_result_time: 'yesterday' }],
    ['instrument_result_time without Z', { instrument_result_time: '2026-11-05T04:00:00' }], ['centre_id not a uuid', { centre_id: 'c1' }], ['instrument_id not a uuid', { instrument_id: 'i1' }],
    ['analyte_id not a uuid', { analyte_id: 'a1' }], ['unit_code with spaces', { unit_code: 'mmol / L' }],
  ];
  it.each(BAD)('400 common.validation_failed for %s, nothing stored', async (_name, over) => {
    const control = `CTRL-${RUN}-bad-${reqN}`;
    badRequest(await failure(capture(body44(control, over))));
    expect(await manualRows(control)).toHaveLength(0);
  });
  it.each(['centre_id', 'instrument_id', 'analyte_id', 'control_id_raw', 'value_numeric', 'instrument_result_time'])('400 for a missing required field %s, nothing stored', async (field) => {
    const control = `CTRL-${RUN}-miss-${field}`;
    const b: Record<string, unknown> = body44(control);
    delete b[field];
    badRequest(await failure(capture(b)));
    expect(await manualRows(control)).toHaveLength(0);
  });
  it('a missing / non-object body is a 400 (never a 500)', async () => {
    badRequest(await failure(capture(undefined)));
    badRequest(await failure(capture(null)));
    badRequest(await failure(capture('x')));
  });

  it('control text is data, not markup or SQL: quotes, angle brackets and SQL are stored verbatim and nothing else changes', async () => {
    const control = `X'); DROP TABLE lab.qc_results;-- <b>${RUN}</b>`.slice(0, 64);
    const r = await capture(body44(control));
    expect(r.status).toBe(201);
    expect((await manualRows(control))[0]!.control_id_raw).toBe(control);
  });
});

// ================================================================== qc_results centre RLS (REQ-SEC-017; plan row "qc_results centre RLS")
describe.skipIf(!live)('T-25 qc_results centre RLS under a single-centre claim', () => {
  const device = (centre: string) => claims(A, { actor_type: 'device', centre_id: centre });
  it('a device-scope claim for centre X sees only X\'s rows and cannot INSERT for centre Y (RLS, class A: no UPDATE / DELETE either)', async () => {
    const instr = nid();
    const x = await seedQc(A, { centre_id: CEN, instrument_id: instr }); const y = await seedQc(A, { centre_id: CEN2, instrument_id: instr });
    const c = await api.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [device(CEN)]);
      const seen = (await c.query('SELECT id FROM lab.qc_results WHERE instrument_id = $1', [instr])).rows.map((r) => r.id);
      expect(seen).toEqual([x]);
      expect(seen).not.toContain(y);
      await c.query('SAVEPOINT s');
      const err = await c.query(`INSERT INTO lab.qc_results (id, tenant_id, centre_id, instrument_id, control_id_raw, value_raw, received_at, source, idempotency_key, created_by)
        VALUES ($1, $2, $3, $4, 'C', '1', now(), 'instrument', $5, $6)`, [nid(), A, CEN2, instr, `t25-rls-${RUN}`, SYS]).then(() => undefined, (e) => e);
      expect(err?.code, 'insert for a centre outside the claim must violate the RLS policy').toBe('42501');
      await c.query('ROLLBACK TO s');
      const upd = await c.query('UPDATE lab.qc_results SET value_raw = $2 WHERE id = $1', [x, 'tampered']).then((r) => ({ n: r.rowCount }), (e) => ({ code: e.code }));
      expect(upd, 'class A rows are immutable for the app role').toSatisfy((v: any) => v.code === '42501' || v.n === 0);
      await c.query('ROLLBACK');
    } finally { c.release(); }
    expect((await qcRow({ id: x }))[0].value_raw).toBe('5.0');
  });
});

// ================================================================== #43 listQcResults
describe.skipIf(!live)('T-25 #43 listQcResults (02-TRD §5.7; AC-19.2, AC-19.3)', () => {
  const instr = nid(), an1 = nid(), an2 = nid();
  const t = (d: number) => new Date(Date.parse('2026-10-01T06:00:00.000Z') + d * DAY).toISOString();
  const ids: string[] = [];          // d1 .. d5, newest = d5
  beforeAll(async () => {
    if (!live) return;
    for (let d = 1; d <= 5; d++) {
      ids.push(await seedQc(A, { instrument_id: instr, analyte_id: d % 2 ? an1 : an2, centre_id: d % 2 ? CEN : CEN2, instrument_result_time: t(d), control_id_raw: `LIST-${d}`, control_lot_raw: `LOT-${d}`, control_level: 'L1',
        value_raw: `${d}.5`, value_numeric: `${d}.5`, unit_code: 'mmol_l', source: d === 3 ? 'manual' : 'instrument', ...(d === 3 ? { entered_by_membership_id: MEM } : {}) }));
    }
    await seedQc(B, { instrument_id: instr, analyte_id: an1, centre_id: CENB, instrument_result_time: t(6), control_id_raw: 'LIST-B' });   // other tenant, same instrument id
  }, 60_000);

  it('by instrument: the tenant\'s rows newest-first as a closed QcResultPage; no pass/fail / status fields; the other tenant\'s row is absent; needs lab.qc.capture', async () => {
    const r = await list({ instrument_id: instr });
    expect(r.status).toBe(200);
    expect(schemaErrors('QcResultPage', r.body)).toEqual([]);
    expect(r.body.data.map((x: any) => x.id)).toEqual([...ids].reverse());
    expect(r.body.data[2]).toMatchObject({ source: 'manual', control_id_raw: 'LIST-3', control_lot_raw: 'LOT-3', control_level: 'L1', value_numeric: '3.5', unit_code: 'mmol_l', instrument_result_time: t(3) });
    for (const row of r.body.data) expect(Object.keys(row).filter((k) => /pass|fail|accept|reject|status|flag|rule|violation|in_control/i.test(k)), 'AC-19.3: no QC judgement fields').toEqual([]);
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(P.capture);
    expectCode(await failure(list({ instrument_id: instr }, { grants: [P.read, P.release] })), 'auth.forbidden', 403);
  });

  it('filters: analyte_id; instrument_result_time_from / _to', async () => {
    expect((await list({ instrument_id: instr, analyte_id: an1 })).body.data.map((x: any) => x.id)).toEqual([ids[4], ids[2], ids[0]]);
    const win = await list({ instrument_id: instr, instrument_result_time_from: t(2) , instrument_result_time_to: t(4) });
    const got = win.body.data.map((x: any) => x.id);
    expect(got).toContain(ids[2]);                                    // d3 strictly inside the window
    expect(got).not.toContain(ids[0]); expect(got).not.toContain(ids[4]);   // d1, d5 outside
  });

  it('cursor paging: limit 2 walks all five rows once, in order, ending without next_cursor; the page object carries the limit', async () => {
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await list({ instrument_id: instr, limit: 2, ...(cursor ? { cursor } : {}) });
      expect(schemaErrors('QcResultPage', r.body)).toEqual([]);
      expect(r.body.page.limit).toBe(2);
      seen.push(...r.body.data.map((x: any) => x.id));
      cursor = r.body.page.next_cursor; pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual([...ids].reverse());
    expect(pages).toBe(3);
  });

  it('a malformed cursor -> 400 common.invalid_cursor; bad query values -> 400 common.validation_failed', async () => {
    expectCode(await failure(list({ instrument_id: instr, cursor: 'not-a-cursor' })), 'common.invalid_cursor', 400);
    badRequest(await failure(list({ instrument_id: 'x' })));
    badRequest(await failure(list({ analyte_id: 'x' })));
    badRequest(await failure(list({ instrument_result_time_from: 'yesterday' })));
  });

  it('REQ-SEC-017: under a single-centre claim only that centre\'s rows come back (RLS on centre_id)', async () => {
    const r = await list({ instrument_id: instr }, { claimsExtra: { actor_type: 'device', centre_id: CEN2 } });
    expect(r.body.data.map((x: any) => x.id)).toEqual([ids[3], ids[1]]);    // d4, d2 are centre CEN2
    expect(r.body.data.every((x: any) => x.centre_id === CEN2)).toBe(true);
  });

  it('P-01: tenant B\'s row never appears in tenant A\'s list, and A\'s never in B\'s', async () => {
    const b = await list({ instrument_id: instr }, { tenant: B });
    expect(b.body.data).toHaveLength(1);
    expect(b.body.data[0]).toMatchObject({ control_id_raw: 'LIST-B', centre_id: CENB });
  });
});

// ================================================================== #45 listQcHolds
describe.skipIf(!live)('T-25 #45 listQcHolds (02-TRD §5.7)', () => {
  let active = '', released = '', other = '';
  const an = [nid(), nid()];
  beforeAll(async () => {
    if (!live) return;
    active = await seedHold(A, { analyte_ids: an });
    released = await seedHold(A, { analyte_ids: [an[0]], status: 'released', released_at: '2026-11-04T05:00:00.000Z', released_by_membership_id: MEM, release_comment: 'Synthetic release comment' });
    other = await seedHold(B, { analyte_ids: [an[0]] });
  }, 60_000);
  const find = (r: { body: any }, id: string) => r.body.data.find((h: any) => h.id === id);

  it('status=active lists the active hold only; status=released the released one with released_at + comment; DTO is closed; needs lab.result.read', async () => {
    const a = await listHolds({ status: 'active' });
    expect(a.status).toBe(200);
    expect(schemaErrors('QcHoldList', a.body)).toEqual([]);
    expect(find(a, active)).toMatchObject({ status: 'active', instrument_id: expect.any(String) });
    expect(an).toContain(find(a, active).analyte_id);
    expect(find(a, released)).toBeUndefined();
    const r = await listHolds({ status: 'released' });
    expect(schemaErrors('QcHoldList', r.body)).toEqual([]);
    expect(find(r, active)).toBeUndefined();
    expect(find(r, released)).toMatchObject({ status: 'released', release_comment: 'Synthetic release comment' });
    expect(iso(find(r, released).released_at)).toBe('2026-11-04T05:00:00.000Z');
    expect(a.probe.roleCalls.map((c) => c.permission)).toContain(P.read);
    expectCode(await failure(listHolds({ status: 'active' }, { grants: [P.capture, P.release] })), 'auth.forbidden', 403);
  });

  it('P-01: another tenant\'s hold is never listed; an unknown status value is a 400', async () => {
    for (const status of ['active', 'released']) expect(find(await listHolds({ status }), other)).toBeUndefined();
    expect(find(await listHolds({ status: 'active' }, { tenant: B }), other)).toMatchObject({ status: 'active' });
    badRequest(await failure(listHolds({ status: 'expired' })));
  });
});

// ================================================================== #46 releaseQcHold (S-16; CR-C5-004)
describe.skipIf(!live)('T-25 #46 releaseQcHold (02-TRD §5.7; 07-SECURITY S-16, REQ-SEC-062/067)', () => {
  const COMMENT = 'Re-run in control, reviewed by the lab manager (synthetic)';

  it('releases: status released, released_at = ctx.now(), released_by = actor, comment stored, version + 1; held results are freed (on_hold false, qc_review_required untouched); new results are no longer held', async () => {
    const instr = nid(), an = nid();
    const rs = await seedResults(A, 2, instr, an);
    const { holdId } = await holdWithResults(instr, an);
    const before = await holdRow(holdId);
    expect([...before.held_result_ids].sort()).toEqual([...rs].sort());
    for (const id of rs) expect(await resultRow(id)).toMatchObject({ on_hold: true, hold_id: holdId });
    expect(await withTx((c) => isOnQcHold({ tx: c, tenantId: A, actorId: SYS } as never, { instrumentId: instr, analyteId: an, at: '2026-11-05T00:00:00.000Z' }))).toBe(true);

    const r = await release(holdId, { comment: COMMENT });
    expect(r.status).toBe(200);
    expect(schemaErrors('QcHoldDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: holdId, status: 'released', release_comment: COMMENT, instrument_id: instr });
    expect(iso(r.body.released_at)).toBe(NOW.toISOString());
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(P.release);
    const after = await holdRow(holdId);
    expect(after).toMatchObject({ status: 'released', release_comment: COMMENT, released_by_membership_id: MEM, version: before.version + 1 });
    expect(iso(after.released_at)).toBe(NOW.toISOString());
    expect([...after.held_result_ids].sort()).toEqual([...rs].sort());          // the record of what was held is kept
    for (const id of rs) expect(await resultRow(id), id).toMatchObject({ on_hold: false });
    expect(await withTx((c) => isOnQcHold({ tx: c, tenantId: A, actorId: SYS } as never, { instrumentId: instr, analyteId: an, at: '2026-11-05T00:00:00.000Z' }))).toBe(false);
    expect(find(await listHolds({ status: 'released' }), holdId)).toMatchObject({ status: 'released' });
    expect(find(await listHolds({ status: 'active' }), holdId)).toBeUndefined();
  });

  it('S-16: without lab.qc_hold.release -> 403 auth.forbidden; the hold and its results are unchanged', async () => {
    const instr = nid(), an = nid();
    const rs = await seedResults(A, 1, instr, an);
    const { holdId } = await holdWithResults(instr, an);
    const before = await holdRow(holdId);
    expectCode(await failure(release(holdId, { comment: COMMENT }, { grants: [P.capture, P.read] })), 'auth.forbidden', 403);
    expect(await holdRow(holdId)).toEqual(before);
    expect(await resultRow(rs[0]!)).toMatchObject({ on_hold: true, hold_id: holdId });
  });

  it('review T-25 #2: lab.qc_holds is tenant-wide, so a centre-scoped actor holding lab.qc_hold.release -> 403 auth.forbidden; the hold stays active and its results stay on_hold', async () => {
    const instr = nid(), an = nid();
    const rs = await seedResults(A, 2, instr, an);
    const { holdId } = await holdWithResults(instr, an);
    const before = await holdRow(holdId);
    expectCode(await failure(release(holdId, { comment: COMMENT }, { scope: { all: false, centreIds: [CEN] } })), 'auth.forbidden', 403);
    expect(await holdRow(holdId)).toEqual(before);
    for (const id of rs) expect(await resultRow(id), id).toMatchObject({ on_hold: true, hold_id: holdId });
  });

  it('REQ-SEC-062/067: a privileged session below aal2 gets auth.mfa_required (from IdentityPort) unchanged, and nothing is released', async () => {
    const id = await seedHold(A);
    const e = await failure(release(id, { comment: COMMENT }, { mfa: true }));
    expect(isLimsError(e, 'auth.mfa_required' as never), `${e?.code ?? e}`).toBe(true);
    expect((await holdRow(id)).status).toBe('active');
  });

  const BAD: Array<[string, unknown]> = [
    ['no comment', {}], ['empty comment', { comment: '' }], ['comment 501 chars', { comment: 'c'.repeat(501) }], ['comment not a string', { comment: 5 }], ['comment null', { comment: null }],
    ['unknown key', { comment: COMMENT, status: 'active' }], ['no body', undefined], ['array body', [COMMENT]],
  ];
  it.each(BAD)('400 common.validation_failed for %s; the hold stays active', async (_n, body) => {
    const id = await seedHold(A);
    badRequest(await failure(release(id, body)));
    expect((await holdRow(id)).status).toBe('active');
  });
  it('a 500-character comment is accepted (the limit is inclusive)', async () => {
    const id = await seedHold(A);
    expect((await release(id, { comment: 'c'.repeat(500) })).status).toBe(200);
    expect((await holdRow(id)).release_comment).toBe('c'.repeat(500));
  });

  it('hold_id that is not a UUID -> 400; unknown hold -> 404 common.not_found', async () => {
    badRequest(await failure(release('not-a-uuid', { comment: COMMENT })));
    expectCode(await failure(release(nid(), { comment: COMMENT })), 'common.not_found', 404);
  });

  it('P-01 / P-03: another tenant\'s hold is 404 for tenant A and stays active; tenant B can release its own', async () => {
    const id = await seedHold(B);
    expectCode(await failure(release(id, { comment: COMMENT })), 'common.not_found', 404);
    expect((await holdRow(id)).status).toBe('active');
    expect((await release(id, { comment: COMMENT }, { tenant: B })).status).toBe(200);
  });

  it('a second release is refused (409) and keeps the first comment and timestamp', async () => {
    const id = await seedHold(A);
    await release(id, { comment: 'first release (synthetic)' });
    const first = await holdRow(id);
    const e = await failure(release(id, { comment: 'second release (synthetic)' }, { now: new Date(NOW.getTime() + 3600_000) }));
    expectCode(e, e?.code, 409);
    const after = await holdRow(id);
    expect(after.release_comment).toBe('first release (synthetic)');
    expect(iso(after.released_at)).toBe(iso(first.released_at));
    expect(after.version).toBe(first.version);
  });

  it('concurrent releases of one hold: exactly one wins (200), the others are 4xx, one comment is stored', async () => {
    const id = await seedHold(A);
    const out = await Promise.allSettled(Array.from({ length: 5 }, (_x, i) => release(id, { comment: `racer ${i}` })));
    const won = out.filter((o) => o.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const o of out) if (o.status === 'rejected') clientError(o.reason);
    const row = await holdRow(id);
    expect(row.status).toBe('released');
    expect(row.release_comment).toMatch(/^racer \d$/);
    expect(row.version).toBe(2);
  });

  const find = (r: { body: any }, id: string) => r.body.data.find((h: any) => h.id === id);
  async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await api.connect();
    try { await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); const out = await fn(c); await c.query('COMMIT'); return out; } finally { c.release(); }
  }
});
