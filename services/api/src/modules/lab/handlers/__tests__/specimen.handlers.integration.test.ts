// C5 T-07 — specimen action handlers over HTTP-shaped requests against the migrated database (06 row T-07; 02-TRD §3.2, §3.3, §5.1 rows 1-8, 12, 13, §5.9;
// 03-APP-FLOW S2/S3/S4/S13/S14 + E25; PRD AC-03.1, AC-03.3, AC-03.4, AC-04.1, AC-04.2, AC-04.3; 07-SECURITY REQ-SEC-013/017/024/081 + attack 5; 08 A13 D-13, D-15; LD-25).
// Needs the migrated+seeded database that tests/db/c5-t03/run.sh starts (see .orchestra/notes/C5.T-07-verify.cmd): LIMS_TEST_DATABASE_URL = role lims_api (RLS on),
// LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1 where "database is provided" fails.
//
// SEAMS (spec fixes behaviour, not names) — the writer adds handlers/<operationId>.ts (each `export const handler: Handler`) for the 10 operations
//   lookupSpecimenByBarcode listSpecimens getSpecimen collectSpecimen bulkCollectSpecimens bulkDispatchSpecimens receiveSpecimen bulkReceiveSpecimens storeSpecimen discardSpecimen,
//   wired in handlers/index.ts (the tests drive `handlers[operationId](req, ctx)`; req = { params, query, headers, body }, headers lower-cased, `if-match: "<version>"`).
//   ctx (frontdesk convention, handlers run in ONE request tx): { operationId, clientIp, log, tenantId, tx (lims_api client, claims set, RLS on), requestId, now(): Date,
//     actor: { type: 'user', id, membershipId }, ports: { IdentityPort: { assertRole(ctx, { permission, centreId? }) -> throws auth.forbidden, getActor() -> { centreScope: { all, centreIds } },
//     getTenantSettings() }, }, events: { publish(ctx, type, { aggregate, idempotencyKey, payload }) }, audit: { access(entry) }, core: { centres: { list(tx, { kinds? }) } } }.
//   Handlers return { status, body }; errors are thrown LimsError (code + statusCode). Permission = assertRole(ctx, { permission }) from the x-permission of the operation.
// ASSUMED (spec silent): centre scope = IdentityPort.getActor().centreScope; a specimen is visible when centre_id OR processing_centre_id is in scope (REQ-SEC-017) else 404 (03-APP-FLOW E25);
//   bulk = one tx, per-item outcome, an item that errors writes nothing, others commit; bulk body of #6/#8 carries `entry_mode`/`occurred_at`/`downtime_ref` at top level and applies to every item;
//   LD-25 on specimen writes: `entry_mode` ('live' default | 'downtime_backentry') + `occurred_at` + `downtime_ref` in the body of collect/receive/store/discard/bulk-*; back-entry stores occurred_at as the
//   action's own timestamp column (collected_at / in_transit_at / received_at / stored_at / discarded_at) and as specimen_transitions.occurred_at, keeps created_at = server time, and writes
//   ctx.audit.access({ entityType: 'specimen', entityId, detail: { entry_mode, downtime_ref, occurred_at } }); window = 72 h (tenant setting default; C4 FD-T06 precedent uses the same constant).
//   LD-25 "live carries neither" (C4 precedent): occurred_at/downtime_ref without entry_mode=downtime_backentry -> 400.
import { readFileSync } from 'node:fs';
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
const BRANCH = { [A]: '01a1a98a-ac40-7000-8000-00000000a101', [B]: '01a1a98a-ac40-7000-8000-00000000b101' } as Record<string, string>;
const CENTRE = { [A]: '01a1a98a-ac40-7000-8000-00000000a201', [B]: '01a1a98a-ac40-7000-8000-00000000b201' } as Record<string, string>;
const CENTRE_A2 = '01a1a98a-ac40-7000-8000-00000000a202';          // db/seeds/010: second centre of tenant A, in the other branch
const BRANCH_A2 = '01a1a98a-ac40-7000-8000-00000000a102';
const u = (n: number) => `0190c607-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PATIENT = { [A]: u(0xa7), [B]: u(0xb7) } as Record<string, string>;
const NOW = new Date('2026-06-15T05:00:30.000Z');
const HOUR = 3_600_000;
const iso = (d: Date | number) => new Date(d).toISOString();
const P = { read: 'lab.specimen.read', collect: 'lab.specimen.collect', receive: 'lab.specimen.receive', reject: 'lab.specimen.reject' } as const;
const ALL = [P.read, P.collect, P.receive];

// ------------------------------------------------------------------ spec validators (lab.yaml)
const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'lab.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`);
};
const DTO_KEYS = new Set(Object.keys(spec.components.schemas.SpecimenDto.properties));
const STATUS_EVENT_KEYS = new Set(Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'events', 'lab.specimen.status_changed.v1.schema.json'), 'utf8'))['$defs'].Payload.properties));

// ------------------------------------------------------------------ database helpers
let api: pg.Pool;
let admin: pg.Pool;
const claims = (tenantId: string) => JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' });
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

// ------------------------------------------------------------------ scenario seeding
let nextId = 0x2000;
let barcodeN = Date.now() % 90_000_000;
interface SpecIn { status: string; active?: boolean; centre?: string; processing?: string; comment?: string; version?: number }
interface Seeded { id: string; barcode: string; orderTestId: string; resultId: string; version: number }
interface Scen { tenant: string; orderId: string; regNo: string; specimens: Seeded[]; existing?: { orderTestId: string; resultId: string } }
const PRE_RECEIPT = new Set(['ordered', 'collected', 'in_transit']);

/** frontdesk order + items (FK parents) -> lab.orders -> specimens (+1 order test + 1 pending result each) [+ an existing-material order test/result without specimen]. */
async function scenario(tenant: string, specs: SpecIn[], o: { existing?: { processing?: string }; centre?: string } = {}): Promise<Scen> {
  const orderId = u(nextId++);
  const regNo = `RT07${orderId.slice(-6).toUpperCase()}`;
  const centre = o.centre ?? CENTRE[tenant];
  const branch = centre === CENTRE_A2 ? BRANCH_A2 : BRANCH[tenant];
  const out: Scen = { tenant, orderId, regNo, specimens: [] };
  await asAdmin(tenant, async (c) => {
    await ins(c, 'frontdesk.orders', { id: orderId, tenant_id: tenant, branch_id: branch, centre_id: centre, patient_id: PATIENT[tenant], registration_no: regNo, status: 'registered',
      visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk', is_first_order_of_patient: false, catalog_revision: 1, registered_at: '2026-06-15T04:00:00.000Z' });
    await ins(c, 'lab.orders', { id: orderId, tenant_id: tenant, centre_id: centre, branch_id: branch, patient_id: PATIENT[tenant], registration_no: regNo, visit_type: 'opd', priority: 'routine',
      collection_mode: 'walk_in', source: 'front_desk', registered_at: '2026-06-15T04:00:00.000Z', patient_sex: 'female', patient_age_days: 10950, lab_status: 'active', last_order_seq: 1, items_version: 1 });
    const item = async (code: string) => {
      const id = u(nextId++);
      await ins(c, 'frontdesk.order_items', { id, tenant_id: tenant, order_id: orderId, centre_id: centre, orderable_id: u(nextId++), orderable_kind: 'test', code, name: `${code} (SYNTHETIC)`, test_ids: [u(nextId)],
        priority: 'routine', unit_price_paisa: 1000, price_list_id: u(0x98), price_list_version: 1, price_source: 'tenant_default', vat_treatment: 'exempt', added_in_items_version: 1 });
      return id;
    };
    const testRows = async (itemId: string, code: string, specimenId: string | null, status: string, extra: Record<string, unknown>) => {
      const orderTestId = u(nextId++); const resultId = u(nextId++); const testId = u(nextId++);
      await ins(c, 'lab.order_tests', { id: orderTestId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, test_id: testId, test_code: code, test_revision: 1, catalog_revision: 1,
        department_id: u(0x901), workflow_type: 'standard', priority: 'routine', specimen_id: specimenId, status, ordered_at: '2026-06-15T04:00:00.000Z', ...extra });
      await ins(c, 'lab.results', { id: resultId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, order_test_id: orderTestId, specimen_id: specimenId, patient_id: PATIENT[tenant],
        test_id: testId, analyte_id: u(nextId++), analyte_code: `${code}1`, department_id: u(0x901), is_reportable: true, result_type: 'numeric', status: 'pending' });
      return { orderTestId, resultId };
    };
    for (const [i, s] of specs.entries()) {
      const id = u(nextId++);
      const barcode = `T7${String(barcodeN++).padStart(8, '0')}`;
      const st = s.status;
      const received = !PRE_RECEIPT.has(st) && st !== 'rejected' && st !== 'discarded' && st !== 'recollection_ordered';
      const processing = s.processing ?? (received || st === 'stored' ? centre : undefined);
      await ins(c, 'lab.specimens', { id, tenant_id: tenant, centre_id: s.centre ?? centre, order_id: orderId, patient_id: PATIENT[tenant], barcode, creation_key: `${orderId}:WB:EDTA:${i}`,
        specimen_type_code: 'WB', container_code: 'EDTA', priority: 'routine', patient_sex: 'female', patient_age_days: 10950, status: st, ordered_at: '2026-06-15T04:00:00.000Z',
        ...(st !== 'ordered' ? { collected_at: '2026-06-15T04:10:00.000Z', collected_by_membership_id: MEM } : {}),
        ...(st === 'in_transit' ? { in_transit_at: '2026-06-15T04:20:00.000Z' } : {}),
        ...(processing ? { processing_centre_id: processing, processing_branch_id: processing === CENTRE_A2 ? BRANCH_A2 : branch } : {}),
        ...(received ? { received_at: '2026-06-15T04:30:00.000Z', received_by_membership_id: MEM } : {}),
        ...(st === 'rejected' || st === 'recollection_ordered' ? { rejected_at: '2026-06-15T04:40:00.000Z', rejection_reason_code: 'HEMOLYZED', rejection_comment: s.comment ?? 'Synthetic comment' } : {}),
        ...(st === 'stored' ? { stored_at: '2026-06-15T04:50:00.000Z', storage_location: 'Freezer 1 (SYNTHETIC)' } : {}),
        ...(st === 'discarded' ? { discarded_at: '2026-06-15T04:55:00.000Z', discard_reason: 'Synthetic' } : {}),
        is_active: s.active ?? true, ...(s.version ? { version: s.version } : {}) });
      const ot = await testRows(await item(`T7${i}`), `T7${i}`, id, PRE_RECEIPT.has(st) ? (st === 'ordered' ? 'awaiting_collection' : 'awaiting_receipt') : 'in_process',
        received && processing ? { received_at: '2026-06-15T04:30:00.000Z', processing_centre_id: processing, processing_branch_id: branch } : {});
      out.specimens.push({ id, barcode, version: s.version ?? 1, ...ot });
    }
    if (o.existing) {
      const proc = o.existing.processing;
      out.existing = await testRows(await item('T7EX'), 'T7EX', null, 'in_process', { uses_existing_material: true, ...(proc ? { processing_centre_id: proc, processing_branch_id: BRANCH[tenant] } : {}) });
      if (proc) await c.query('UPDATE lab.results SET processing_centre_id = $1, processing_branch_id = $2 WHERE id = $3', [proc, BRANCH[tenant], out.existing.resultId]);
    }
  });
  return out;
}

const specimenRow = async (id: string) => (await sql('SELECT * FROM lab.specimens WHERE id = $1', [id]))[0];
const transitionsOf = (id: string) => sql('SELECT * FROM lab.specimen_transitions WHERE specimen_id = $1 ORDER BY specimen_version', [id]);
const orderTestRow = async (id: string) => (await sql('SELECT * FROM lab.order_tests WHERE id = $1', [id]))[0];
const resultRow = async (id: string) => (await sql('SELECT * FROM lab.results WHERE id = $1', [id]))[0];
const snapshot = async (s: Scen) => JSON.stringify(await Promise.all(s.specimens.map(async (x) => [await specimenRow(x.id), (await transitionsOf(x.id)).length, await orderTestRow(x.orderTestId), await resultRow(x.resultId)])));

// ------------------------------------------------------------------ driving a handler
type Pub = { type: string; input: any };
interface Probe { events: Pub[]; audit: any[]; roleCalls: any[] }
interface Opts { grants?: readonly string[]; tenant?: string; scope?: { all?: boolean; centreIds?: readonly string[] }; now?: Date }
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined as unknown, ...o });
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
let reqN = 0;

/** One request = one committed tx under RLS (claims of the ctx tenant); a throw rolls back, like the core request wrapper. */
async function call(operationId: string, r: ReturnType<typeof req>, o: Opts = {}): Promise<{ status: number; body: any; probe: Probe }> {
  const tenant = o.tenant ?? A;
  const probe: Probe = { events: [], audit: [], roleCalls: [] };
  const grants = o.grants ?? ALL;
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const scope = o.scope ?? { all: false, centreIds: [CENTRE[tenant]] };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: tenant, tx: client, requestId: u(0x9000 + reqN++), now: () => o.now ?? NOW,
      actor: { type: 'user', id: SYS, membershipId: MEM },
      ports: { IdentityPort: {
        async assertRole(_c: unknown, x: { permission: string; centreId?: string }) { probe.roleCalls.push(x); if (!grants.includes(x?.permission)) throw new LimsError('auth.forbidden'); },
        async getActor() { return { actor: { type: 'user', id: SYS }, permissions: [...grants], centreScope: scope, branchIds: [BRANCH[tenant]], isLocked: false }; },
        async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; },
      } },
      events: { publish: async (_c: unknown, type: string, input: unknown) => { probe.events.push({ type, input }); return { eventId: u(0x8000 + probe.events.length), duplicate: false }; } },
      audit: { access: async (e: unknown) => { probe.audit.push(e); } },
      core: { centres: { list: async () => [
        { id: CENTRE[tenant], branchId: BRANCH[tenant], branch_id: BRANCH[tenant] }, { id: CENTRE_A2, branchId: BRANCH_A2, branch_id: BRANCH_A2 }] } },
    };
    const out = await (handlers as unknown as Record<string, (r: unknown, c: unknown) => Promise<{ status: number; body?: any }>>)[operationId]!(r, ctx);
    await client.query('COMMIT');
    return { status: out.status, body: out.body, probe };
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };
const expectCode = (e: any, code: string, status: number) => { expect(isLimsError(e, code as never), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(status); };
const statusEvents = (p: Probe) => p.events.filter((e) => e.type === 'lab.specimen.status_changed.v1');

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 12 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await asAdmin(t, (c) => ins(c, 'frontdesk.patients', { id: PATIENT[t], tenant_id: t, patient_code: 'P-T07', full_name: 'Test Patient T07', name_search: 'test patient t07',
    sex: 'female', registered_centre_id: CENTRE[t] }));
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-07 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

// ================================================================== single-id actions (#4, #7, #12, #13): shared HTTP contract
interface Single { op: string; perm: string; from: string; body: object; to: string; code: string; col: string; occurredBody?: (m: Record<string, unknown>) => object }
const SINGLE: Single[] = [
  { op: 'collectSpecimen', perm: P.collect, from: 'ordered', body: {}, to: 'collected', code: 'S2', col: 'collected_at' },
  { op: 'receiveSpecimen', perm: P.receive, from: 'collected', body: { processing_centre_id: CENTRE[A] }, to: 'received', code: 'S4', col: 'received_at' },
  { op: 'storeSpecimen', perm: P.receive, from: 'received', body: { location: 'Freezer 2, shelf B (SYNTHETIC)' }, to: 'stored', code: 'S13', col: 'stored_at' },
  { op: 'discardSpecimen', perm: P.receive, from: 'stored', body: { discard_reason: 'Retention elapsed (SYNTHETIC)' }, to: 'discarded', code: 'S14', col: 'discarded_at' },
];

/** one skipIf-guarded describe per row (vitest's skipIf chain has no .each). */
const eachLive = <R extends { op: string }>(rows: readonly R[], title: string, fn: (t: R) => void) =>
  describe.skipIf(!live)(title, () => { for (const t of rows) describe(t.op, () => fn(t)); });

eachLive(SINGLE, 'T-07 contract (x-error-codes, If-Match, 07-SECURITY)', (t) => {
  const run = (s: Scen, i: number, o: Opts = {}, over: { body?: unknown; headers?: object; params?: object } = {}) =>
    call(t.op, req({ params: { specimen_id: s.specimens[i]!.id }, headers: ifm(s.specimens[i]!.version), body: over.body ?? t.body, ...(over.headers ? { headers: over.headers } : {}), ...(over.params ? { params: over.params } : {}) }), o);

  it(`200 SpecimenDto: status ${t.from} -> ${t.to}, version +1, ${t.col} = server time, S-transition row ${t.code}, one status_changed event (no extra payload keys)`, async () => {
    const s = await scenario(A, [{ status: t.from }]);
    const x = s.specimens[0]!;
    const r = await run(s, 0);
    expect(r.status).toBe(200);
    expect(schemaErrors('SpecimenDto', r.body)).toEqual([]);
    for (const k of Object.keys(r.body)) expect(DTO_KEYS.has(k), `non-allowlisted key ${k}`).toBe(true);
    expect(r.body).toMatchObject({ id: x.id, status: t.to, version: 2, barcode: x.barcode, registration_no: s.regNo });
    const row = await specimenRow(x.id);
    expect(row).toMatchObject({ status: t.to, version: 2 });
    expect(new Date(row[t.col]).toISOString()).toBe(iso(NOW));
    const tr = await transitionsOf(x.id);
    expect(tr).toHaveLength(1);
    expect(tr[0]).toMatchObject({ transition_code: t.code, from_status: t.from, to_status: t.to, specimen_version: 2, actor_type: 'user', actor_id: SYS, membership_id: MEM });
    expect(new Date(tr[0].occurred_at).toISOString()).toBe(iso(NOW));
    const ev = statusEvents(r.probe);
    expect(ev).toHaveLength(1);
    expect(r.probe.events).toHaveLength(1);
    expect(ev[0]!.input.payload).toMatchObject({ specimen_id: x.id, order_id: s.orderId, patient_id: PATIENT[A], centre_id: CENTRE[A], specimen_type_code: 'WB', from_status: t.from, to_status: t.to, changed_at: iso(NOW) });
    for (const k of Object.keys(ev[0]!.input.payload)) expect(STATUS_EVENT_KEYS.has(k), `payload key ${k} is not in the event schema`).toBe(true);
    expect(ev[0]!.input.aggregate).toMatchObject({ type: 'specimen', id: x.id });
    expect(ev[0]!.input.idempotencyKey).toBe(`${x.id}:${t.to}:2`);
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(t.perm);
  });

  it('428 common.precondition_required without If-Match; nothing written', async () => {
    const s = await scenario(A, [{ status: t.from }]);
    const before = await snapshot(s);
    expectCode(await failure(run(s, 0, {}, { headers: {} })), 'common.precondition_required', 428);
    expect(await snapshot(s)).toBe(before);
  });

  it('409 common.version_conflict on a stale If-Match; nothing written (no event, no transition)', async () => {
    const s = await scenario(A, [{ status: t.from, version: 3 }]);
    const before = await snapshot(s);
    expectCode(await failure(run(s, 0, {}, { headers: ifm(2) })), 'common.version_conflict', 409);
    expect(await snapshot(s)).toBe(before);
  });

  it.each(['abc', '"0"', '"-1"', '2', '"1.5"', '""'])('400 common.validation_failed for a malformed If-Match %s', async (h) => {
    const s = await scenario(A, [{ status: t.from }]);
    expectCode(await failure(run(s, 0, {}, { headers: ifm(h) })), 'common.validation_failed', 400);
    expect((await specimenRow(s.specimens[0]!.id)).version).toBe(1);
  });

  it('403 auth.forbidden without the operation permission; nothing written', async () => {
    const s = await scenario(A, [{ status: t.from }]);
    const before = await snapshot(s);
    expectCode(await failure(run(s, 0, { grants: ALL.filter((g) => g !== t.perm) })), 'auth.forbidden', 403);
    expect(await snapshot(s)).toBe(before);
  });

  it('404 common.not_found for an unknown id and for another tenant\'s specimen (P-11); the other tenant\'s row is untouched', async () => {
    const other = await scenario(B, [{ status: t.from }]);
    const before = await snapshot(other);
    expectCode(await failure(call(t.op, req({ params: { specimen_id: other.specimens[0]!.id }, headers: ifm(1), body: t.body }), { tenant: A })), 'common.not_found', 404);
    expectCode(await failure(call(t.op, req({ params: { specimen_id: u(0xdead00) }, headers: ifm(1), body: t.body }), { tenant: A })), 'common.not_found', 404);
    expect(await snapshot(other)).toBe(before);
  });

  it('404 for a specimen outside the actor\'s centre scope (E25); a scope with all=true reaches it', async () => {
    const s = await scenario(A, [{ status: t.from, centre: CENTRE_A2, processing: t.from === 'ordered' || t.from === 'collected' ? undefined : CENTRE_A2 }], { centre: CENTRE_A2 });
    const before = await snapshot(s);
    expectCode(await failure(run(s, 0, { scope: { all: false, centreIds: [CENTRE[A]] } }, { body: t.op === 'receiveSpecimen' ? { processing_centre_id: CENTRE[A] } : t.body })), 'common.not_found', 404);
    expect(await snapshot(s)).toBe(before);
    expect((await run(s, 0, { scope: { all: true } }, { body: t.op === 'receiveSpecimen' ? { processing_centre_id: CENTRE_A2 } : t.body })).status).toBe(200);
  });

  it.each([['not-a-uuid'], ['0190c607-0000-7000-8000-00000000000'], ['']])('400 common.validation_failed for the path id %j', async (id) => {
    expectCode(await failure(call(t.op, req({ params: { specimen_id: id }, headers: ifm(1), body: t.body }))), 'common.validation_failed', 400);
  });

  it('400 common.validation_failed for unknown body keys incl. a tenant field (REQ-SEC-013, additionalProperties false); nothing written', async () => {
    const s = await scenario(A, [{ status: t.from }]);
    const before = await snapshot(s);
    expectCode(await failure(run(s, 0, {}, { body: { ...t.body, tenant_id: B } })), 'common.validation_failed', 400);
    expectCode(await failure(run(s, 0, {}, { body: { ...t.body, status: 'approved' } })), 'common.validation_failed', 400);
    expect(await snapshot(s)).toBe(before);
  });

  it('LD-25: back-entry stores occurred_at as the action time (not the server time), keeps created_at, audits entry_mode/downtime_ref/occurred_at', async () => {
    const s = await scenario(A, [{ status: t.from }]);
    const occurred = iso(NOW.getTime() - 5 * HOUR);
    const r = await run(s, 0, {}, { body: { ...t.body, entry_mode: 'downtime_backentry', occurred_at: occurred, downtime_ref: 'PAPER-0042' } });
    expect(r.status).toBe(200);
    const row = await specimenRow(s.specimens[0]!.id);
    expect(new Date(row[t.col]).toISOString()).toBe(occurred);
    const tr = (await transitionsOf(s.specimens[0]!.id))[0]!;
    expect(new Date(tr.occurred_at).toISOString()).toBe(occurred);
    expect(new Date(tr.created_at).toISOString()).not.toBe(occurred);          // the server keeps its own time
    const a = r.probe.audit.find((e) => e?.detail?.entry_mode === 'downtime_backentry');
    expect(a, 'no audit entry for the back-entry').toBeDefined();
    expect(a).toMatchObject({ entityType: 'specimen', entityId: s.specimens[0]!.id, detail: { entry_mode: 'downtime_backentry', downtime_ref: 'PAPER-0042', occurred_at: occurred } });
    expect(r.probe.roleCalls.map((c) => c.permission)).toEqual(expect.arrayContaining([t.perm]));   // same permission as the live action
  });

  it('LD-25: an explicit entry_mode "live" behaves like the default; a live write has no downtime audit entry', async () => {
    const s = await scenario(A, [{ status: t.from }]);
    const r = await run(s, 0, {}, { body: { ...t.body, entry_mode: 'live' } });
    expect(r.status).toBe(200);
    expect(r.probe.audit.filter((e) => e?.detail?.entry_mode === 'downtime_backentry')).toEqual([]);
    expect(new Date((await specimenRow(s.specimens[0]!.id))[t.col]).toISOString()).toBe(iso(NOW));
  });
});

// ================================================================== LD-25 limits (one op carries the matrix; all single ops share the parser by contract above)
describe.skipIf(!live)('T-07 LD-25 downtime back-entry limits (collectSpecimen)', () => {
  const body = (o: Record<string, unknown>) => ({ entry_mode: 'downtime_backentry', occurred_at: iso(NOW.getTime() - HOUR), downtime_ref: 'P-1', ...o });
  const attempt = async (b: Record<string, unknown>) => {
    const s = await scenario(A, [{ status: 'ordered' }]);
    const before = await snapshot(s);
    const r = await call('collectSpecimen', req({ params: { specimen_id: s.specimens[0]!.id }, headers: ifm(1), body: b }));
    return { r, s, before };
  };
  const rejects = async (b: Record<string, unknown>) => {
    const s = await scenario(A, [{ status: 'ordered' }]);
    const before = await snapshot(s);
    expectCode(await failure(call('collectSpecimen', req({ params: { specimen_id: s.specimens[0]!.id }, headers: ifm(1), body: b }))), 'common.validation_failed', 400);
    expect(await snapshot(s)).toBe(before);
  };

  it('accepts occurred_at exactly now and exactly now - 72 h; downtime_ref of 1 and of 32 chars', async () => {
    for (const b of [body({ occurred_at: iso(NOW) }), body({ occurred_at: iso(NOW.getTime() - 72 * HOUR) }), body({ downtime_ref: 'x' }), body({ downtime_ref: 'R'.repeat(32) })]) expect((await attempt(b)).r.status).toBe(200);
  });
  it('rejects occurred_at in the future (now + 1 ms) and older than 72 h (now - 72 h - 1 ms), with 400 and nothing written', async () => {
    await rejects(body({ occurred_at: iso(NOW.getTime() + 1) }));
    await rejects(body({ occurred_at: iso(NOW.getTime() - 72 * HOUR - 1) }));
    await rejects(body({ occurred_at: iso(NOW.getTime() - 400 * 24 * HOUR) }));
  });
  it('rejects back-entry without occurred_at, without downtime_ref, with an empty / 33-char / NUL downtime_ref, and with a malformed occurred_at', async () => {
    await rejects({ entry_mode: 'downtime_backentry', downtime_ref: 'P-1' });
    await rejects({ entry_mode: 'downtime_backentry', occurred_at: iso(NOW) });
    await rejects(body({ downtime_ref: '' }));
    await rejects(body({ downtime_ref: 'R'.repeat(33) }));
    await rejects(body({ downtime_ref: 'P\u00001' }));
    await rejects(body({ occurred_at: 'yesterday' }));
    await rejects(body({ occurred_at: 1718427600000 }));
  });
  it('rejects an unknown entry_mode, and occurred_at / downtime_ref on a live write (a live write carries neither)', async () => {
    await rejects(body({ entry_mode: 'offline' }));
    await rejects({ occurred_at: iso(NOW) });
    await rejects({ downtime_ref: 'P-1' });
    await rejects({ entry_mode: 'live', occurred_at: iso(NOW), downtime_ref: 'P-1' });
  });
  it('no back-dating of anything else: a back-entry cannot move a specimen that is not otherwise collectable (409 invalid transition, nothing written)', async () => {
    const s = await scenario(A, [{ status: 'received' }]);
    const before = await snapshot(s);
    expectCode(await failure(call('collectSpecimen', req({ params: { specimen_id: s.specimens[0]!.id }, headers: ifm(1), body: body({}) }))), 'lab.specimen_invalid_transition', 409);
    expect(await snapshot(s)).toBe(before);
  });
});

// ================================================================== #4 collectSpecimen (AC-03.1, AC-03.4)
describe.skipIf(!live)('T-07 collectSpecimen (AC-03.1, AC-03.4; S2)', () => {
  const collect = (s: Scen, body: unknown = {}, o: Opts = {}) => call('collectSpecimen', req({ params: { specimen_id: s.specimens[0]!.id }, headers: ifm(s.specimens[0]!.version), body }), o);

  it('AC-03.1: collected_by_membership_id = actor membership; status_changed ordered -> collected; the specimen\'s order test moves to awaiting_receipt (02-TRD §3.3)', async () => {
    const s = await scenario(A, [{ status: 'ordered' }]);
    const r = await collect(s);
    expect(await specimenRow(s.specimens[0]!.id)).toMatchObject({ status: 'collected', collected_by_membership_id: MEM });
    expect(r.body.collected_at).toBe(iso(NOW));
    expect((await orderTestRow(s.specimens[0]!.orderTestId)).status).toBe('awaiting_receipt');
    expect(statusEvents(r.probe)[0]!.input.payload).toMatchObject({ from_status: 'ordered', to_status: 'collected' });
  });

  it('a supplied collected_at within [now - 72 h, now] is stored; in the future or older than 72 h -> 400, nothing written', async () => {
    const s = await scenario(A, [{ status: 'ordered' }, { status: 'ordered' }, { status: 'ordered' }]);
    const at = iso(NOW.getTime() - 3 * HOUR);
    const r = await call('collectSpecimen', req({ params: { specimen_id: s.specimens[0]!.id }, headers: ifm(1), body: { collected_at: at } }));
    expect(r.body.collected_at).toBe(at);
    for (const [i, bad] of [[1, iso(NOW.getTime() + 60_000)], [2, iso(NOW.getTime() - 72 * HOUR - 1000)]] as const) {
      expectCode(await failure(call('collectSpecimen', req({ params: { specimen_id: s.specimens[i]!.id }, headers: ifm(1), body: { collected_at: bad } }))), 'common.validation_failed', 400);
      expect((await specimenRow(s.specimens[i]!.id)).status).toBe('ordered');
    }
  });

  it.each(['collected', 'in_transit', 'received', 'in_process', 'rejected', 'stored', 'discarded'])('AC-03.4: collect on a %s specimen -> 409 lab.specimen_invalid_transition, nothing changes', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const before = await snapshot(s);
    expectCode(await failure(collect(s)), 'lab.specimen_invalid_transition', 409);
    expect(await snapshot(s)).toBe(before);
  });

  it('an inactive ordered specimen -> 409 lab.specimen_inactive (S2 guard is_active); an inactive received one is an invalid transition first (table, then activity)', async () => {
    const a = await scenario(A, [{ status: 'ordered', active: false }]);
    expectCode(await failure(collect(a)), 'lab.specimen_inactive', 409);
    expect((await specimenRow(a.specimens[0]!.id)).status).toBe('ordered');
    const b = await scenario(A, [{ status: 'received', active: false }]);
    expectCode(await failure(collect(b)), 'lab.specimen_invalid_transition', 409);
  });

  it('race: 5 concurrent collects with the same If-Match -> exactly one 200, four 409 common.version_conflict (or invalid_transition), one transition row, one event', async () => {
    const s = await scenario(A, [{ status: 'ordered' }]);
    const out = await Promise.allSettled(Array.from({ length: 5 }, () => collect(s)));
    const ok = out.filter((x) => x.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof collect>>>[];
    expect(ok).toHaveLength(1);
    for (const x of out) if (x.status === 'rejected') { expect(['common.version_conflict', 'lab.specimen_invalid_transition']).toContain(x.reason.code); expect(x.reason.statusCode).toBe(409); }
    expect(await transitionsOf(s.specimens[0]!.id)).toHaveLength(1);
    expect(ok[0]!.value.probe.events).toHaveLength(1);
    expect((await specimenRow(s.specimens[0]!.id)).version).toBe(2);
  });
});

// ================================================================== #7 receiveSpecimen (AC-04.1, AC-04.3; S4; D-13)
describe.skipIf(!live)('T-07 receiveSpecimen (AC-04.1, AC-04.3; S4; 08 A13 D-13)', () => {
  const receive = (s: Scen, centre: unknown = CENTRE[A], o: Opts = {}, i = 0) =>
    call('receiveSpecimen', req({ params: { specimen_id: s.specimens[i]!.id }, headers: ifm(s.specimens[i]!.version), body: { processing_centre_id: centre } }), o);

  it.each(['collected', 'in_transit'])('AC-04.1: a %s specimen -> received; received_at, received_by, processing_centre_id and the branch of that centre stored; status_changed emitted', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const r = await receive(s, CENTRE_A2, { scope: { all: false, centreIds: [CENTRE[A], CENTRE_A2] } });
    expect(r.body).toMatchObject({ status: 'received', processing_centre_id: CENTRE_A2, received_at: iso(NOW) });
    expect(await specimenRow(s.specimens[0]!.id)).toMatchObject({ status: 'received', processing_centre_id: CENTRE_A2, processing_branch_id: BRANCH_A2, received_by_membership_id: MEM });
    expect(statusEvents(r.probe)[0]!.input.payload).toMatchObject({ from_status: from, to_status: 'received', processing_branch_id: BRANCH_A2 });
  });

  it('S4 copies the processing centre/branch + received_at to the specimen\'s order tests (status -> in_process) and results (03-APP-FLOW S4)', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    await receive(s);
    expect(await orderTestRow(s.specimens[0]!.orderTestId)).toMatchObject({ status: 'in_process', processing_centre_id: CENTRE[A], processing_branch_id: BRANCH[A] });
    expect(new Date((await orderTestRow(s.specimens[0]!.orderTestId)).received_at).toISOString()).toBe(iso(NOW));
    expect(await resultRow(s.specimens[0]!.resultId)).toMatchObject({ processing_centre_id: CENTRE[A], processing_branch_id: BRANCH[A], status: 'pending' });
  });

  it('D-13 / done_when: S4 copies the processing centre/branch to the order\'s existing-material order tests and results that have none yet', async () => {
    const s = await scenario(A, [{ status: 'collected' }], { existing: {} });
    await receive(s, CENTRE_A2, { scope: { all: false, centreIds: [CENTRE[A], CENTRE_A2] } });
    expect(await orderTestRow(s.existing!.orderTestId)).toMatchObject({ processing_centre_id: CENTRE_A2, processing_branch_id: BRANCH_A2, uses_existing_material: true, specimen_id: null });
    expect(await resultRow(s.existing!.resultId)).toMatchObject({ processing_centre_id: CENTRE_A2, processing_branch_id: BRANCH_A2, specimen_id: null });
  });

  it('D-13: existing-material rows that already carry a processing centre keep it (copied only when none yet)', async () => {
    const s = await scenario(A, [{ status: 'collected' }], { existing: { processing: CENTRE[A] } });
    await receive(s, CENTRE_A2, { scope: { all: false, centreIds: [CENTRE[A], CENTRE_A2] } });
    expect(await orderTestRow(s.existing!.orderTestId)).toMatchObject({ processing_centre_id: CENTRE[A] });
    expect(await resultRow(s.existing!.resultId)).toMatchObject({ processing_centre_id: CENTRE[A] });
  });

  it.each(['rejected', 'discarded'])('AC-04.3: receive on a %s specimen -> 409 lab.specimen_not_receivable, nothing changes', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const before = await snapshot(s);
    expectCode(await failure(receive(s)), 'lab.specimen_not_receivable', 409);
    expect(await snapshot(s)).toBe(before);
  });

  it.each(['ordered', 'received', 'in_process', 'stored', 'recollection_ordered'])('S4 only from collected / in_transit: receive on %s -> 409 lab.specimen_invalid_transition (never an ordered specimen)', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const before = await snapshot(s);
    expectCode(await failure(receive(s)), 'lab.specimen_invalid_transition', 409);
    expect(await snapshot(s)).toBe(before);
  });

  it('an inactive collected specimen -> 409 lab.specimen_inactive (S4 guard)', async () => {
    const s = await scenario(A, [{ status: 'collected', active: false }]);
    expectCode(await failure(receive(s)), 'lab.specimen_inactive', 409);
  });

  it('attack 5 (07-SECURITY): a processing_centre_id outside the actor\'s centre scope -> 403 auth.forbidden, nothing written; a centre of another tenant too', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    const before = await snapshot(s);
    expectCode(await failure(receive(s, CENTRE_A2, { scope: { all: false, centreIds: [CENTRE[A]] } })), 'auth.forbidden', 403);
    expectCode(await failure(receive(s, CENTRE[B])), 'auth.forbidden', 403);
    expectCode(await failure(receive(s, u(0xdead01))), 'auth.forbidden', 403);
    expect(await snapshot(s)).toBe(before);
  });

  it.each([[undefined], [null], ['not-a-uuid'], [123]])('400 common.validation_failed for processing_centre_id %j', async (v) => {
    const s = await scenario(A, [{ status: 'collected' }]);
    expectCode(await failure(call('receiveSpecimen', req({ params: { specimen_id: s.specimens[0]!.id }, headers: ifm(1), body: v === undefined ? {} : { processing_centre_id: v } }))), 'common.validation_failed', 400);
    expect((await specimenRow(s.specimens[0]!.id)).status).toBe('collected');
  });
});

// ================================================================== #12 storeSpecimen (S13) and #13 discardSpecimen (S14, D-15)
describe.skipIf(!live)('T-07 storeSpecimen (S13)', () => {
  const store = (s: Scen, body: unknown) => call('storeSpecimen', req({ params: { specimen_id: s.specimens[0]!.id }, headers: ifm(s.specimens[0]!.version), body }));
  it.each(['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported'])('from %s: stored_at + storage_location stored, status_changed to stored', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const r = await store(s, { location: 'Freezer 2, shelf B (SYNTHETIC)' });
    expect(await specimenRow(s.specimens[0]!.id)).toMatchObject({ status: 'stored', storage_location: 'Freezer 2, shelf B (SYNTHETIC)' });
    expect(statusEvents(r.probe)[0]!.input.payload).toMatchObject({ from_status: from, to_status: 'stored' });
  });
  it.each(['ordered', 'collected', 'in_transit', 'rejected', 'recollection_ordered', 'stored', 'discarded'])('from %s -> 409 lab.specimen_invalid_transition', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const before = await snapshot(s);
    expectCode(await failure(store(s, { location: 'Shelf' })), 'lab.specimen_invalid_transition', 409);
    expect(await snapshot(s)).toBe(before);
  });
  it('an inactive specimen can still be stored (03-APP-FLOW §1.1: inactive accepts storage / disposal)', async () => {
    const s = await scenario(A, [{ status: 'received', active: false }]);
    expect((await store(s, { location: 'Shelf' })).status).toBe(200);
  });
  it.each([[{}], [{ location: '' }], [{ location: 'L'.repeat(121) }], [{ location: 7 }], [{ location: null }]])('400 common.validation_failed for the body %j (location required, 1..120)', async (b) => {
    const s = await scenario(A, [{ status: 'received' }]);
    expectCode(await failure(store(s, b)), 'common.validation_failed', 400);
    expect((await specimenRow(s.specimens[0]!.id)).status).toBe('received');
  });
  it('a 120-char location is accepted', async () => {
    const s = await scenario(A, [{ status: 'received' }]);
    expect((await store(s, { location: 'L'.repeat(120) })).status).toBe(200);
  });
});

describe.skipIf(!live)('T-07 discardSpecimen (S14; 08 A13 D-15)', () => {
  const discard = (s: Scen, body: unknown) => call('discardSpecimen', req({ params: { specimen_id: s.specimens[0]!.id }, headers: ifm(s.specimens[0]!.version), body }));
  it.each(['stored', 'reported', 'rejected', 'recollection_ordered'])('D-15: from %s -> discarded; discarded_at + discard_reason stored, status_changed to discarded', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const r = await discard(s, { discard_reason: 'Retention elapsed (SYNTHETIC)' });
    expect(r.body.status).toBe('discarded');
    expect(await specimenRow(s.specimens[0]!.id)).toMatchObject({ status: 'discarded', discard_reason: 'Retention elapsed (SYNTHETIC)' });
    expect(statusEvents(r.probe)[0]!.input.payload).toMatchObject({ from_status: from, to_status: 'discarded' });
    expect((await transitionsOf(s.specimens[0]!.id))[0]).toMatchObject({ transition_code: 'S14', from_status: from, to_status: 'discarded' });
  });
  it.each(['ordered', 'collected', 'in_transit', 'received', 'in_process', 'resulted', 'verified', 'approved', 'discarded'])('from %s -> 409 lab.specimen_invalid_transition', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const before = await snapshot(s);
    expectCode(await failure(discard(s, { discard_reason: 'x' })), 'lab.specimen_invalid_transition', 409);
    expect(await snapshot(s)).toBe(before);
  });
  it('an inactive recollection_ordered / rejected specimen can still be discarded (the rejected tube, D-15)', async () => {
    const s = await scenario(A, [{ status: 'recollection_ordered', active: false }, { status: 'rejected', active: false }]);
    expect((await discard(s, { discard_reason: 'x' })).status).toBe(200);
    const r = await call('discardSpecimen', req({ params: { specimen_id: s.specimens[1]!.id }, headers: ifm(1), body: { discard_reason: 'x' } }));
    expect(r.status).toBe(200);
  });
  it.each([[{}], [{ discard_reason: '' }], [{ discard_reason: 'D'.repeat(201) }], [{ discard_reason: 5 }], [{ discard_reason: null }]])('400 common.validation_failed for the body %j (discard_reason required, 1..200)', async (b) => {
    const s = await scenario(A, [{ status: 'stored' }]);
    expectCode(await failure(discard(s, b)), 'common.validation_failed', 400);
    expect((await specimenRow(s.specimens[0]!.id)).status).toBe('stored');
  });
  it('a 200-char reason is accepted', async () => {
    const s = await scenario(A, [{ status: 'stored' }]);
    expect((await discard(s, { discard_reason: 'D'.repeat(200) })).status).toBe(200);
  });
});

// ================================================================== bulk #5 / #6 / #8 (AC-03.1, AC-03.3, AC-04.1)
interface Bulk { op: string; perm: string; from: string; to: string; extra: object; col: string }
const BULK: Bulk[] = [
  { op: 'bulkCollectSpecimens', perm: P.collect, from: 'ordered', to: 'collected', extra: {}, col: 'collected_at' },
  { op: 'bulkDispatchSpecimens', perm: P.collect, from: 'collected', to: 'in_transit', extra: {}, col: 'in_transit_at' },
  { op: 'bulkReceiveSpecimens', perm: P.receive, from: 'in_transit', to: 'received', extra: { processing_centre_id: CENTRE[A] }, col: 'received_at' },
];
eachLive(BULK, 'T-07 bulk — per-id outcomes', (t) => {
  const items = (s: Scen, ids?: number[]) => (ids ?? s.specimens.map((_, i) => i)).map((i) => ({ id: s.specimens[i]!.id, version: s.specimens[i]!.version }));
  const run = (body: unknown, o: Opts = {}) => call(t.op, req({ headers: { 'idempotency-key': `k-${reqN}` }, body }), o);

  it('AC-03.1 / AC-03.3 / AC-04.1: all ok -> 200 { results } in request order, each SpecimenDto in the new status, one event + transition each', async () => {
    const s = await scenario(A, [{ status: t.from }, { status: t.from }, { status: t.from }]);
    const r = await run({ ...t.extra, items: items(s) });
    expect(r.status).toBe(200);
    expect(schemaErrors('SpecimenBulkResponse', r.body)).toEqual([]);
    expect(r.body.results.map((x: any) => x.id)).toEqual(s.specimens.map((x) => x.id));
    for (const x of r.body.results) expect(x).toMatchObject({ outcome: 'ok', specimen: { status: t.to, version: 2 } });
    for (const x of s.specimens) {
      const row = await specimenRow(x.id);
      expect(row.status).toBe(t.to);
      expect(new Date(row[t.col]).toISOString()).toBe(iso(NOW));
      expect(await transitionsOf(x.id)).toHaveLength(1);
    }
    expect(statusEvents(r.probe)).toHaveLength(3);
  });

  it('mixed batch: a wrong-state id -> error lab.specimen_invalid_transition, a stale version -> common.version_conflict, an unknown / foreign id -> common.not_found; errors write nothing, ok items commit', async () => {
    const other = await scenario(B, [{ status: t.from }]);
    const s = await scenario(A, [{ status: t.from }, { status: 'discarded' }, { status: t.from, version: 4 }, { status: t.from }]);
    const r = await run({ ...t.extra, items: [
      { id: s.specimens[0]!.id, version: 1 }, { id: s.specimens[1]!.id, version: 1 }, { id: s.specimens[2]!.id, version: 3 },
      { id: u(0xdead02), version: 1 }, { id: other.specimens[0]!.id, version: 1 }, { id: s.specimens[3]!.id, version: 1 }] });
    expect(r.status).toBe(200);
    const res = r.body.results;
    expect(res.map((x: any) => x.outcome)).toEqual(['ok', 'error', 'error', 'error', 'error', 'ok']);
    expect(res[1].code).toBe(t.op === 'bulkReceiveSpecimens' ? 'lab.specimen_not_receivable' : 'lab.specimen_invalid_transition');
    expect(res[2].code).toBe('common.version_conflict');
    expect(res[3].code).toBe('common.not_found');
    expect(res[4].code).toBe('common.not_found');
    for (const x of res) if (x.outcome === 'error') expect(x).not.toHaveProperty('specimen');
    expect(schemaErrors('SpecimenBulkResponse', r.body)).toEqual([]);
    expect((await specimenRow(s.specimens[0]!.id)).status).toBe(t.to);
    expect((await specimenRow(s.specimens[3]!.id)).status).toBe(t.to);
    expect((await specimenRow(s.specimens[1]!.id)).status).toBe('discarded');
    expect((await specimenRow(s.specimens[2]!.id)).status).toBe(t.from);
    expect((await specimenRow(other.specimens[0]!.id)).status).toBe(t.from);
    expect(await transitionsOf(other.specimens[0]!.id)).toHaveLength(0);
    expect(statusEvents(r.probe)).toHaveLength(2);
  });

  it('the same id twice: the first is ok, the second is an error (version now stale); the specimen moves once', async () => {
    const s = await scenario(A, [{ status: t.from }]);
    const r = await run({ ...t.extra, items: [...items(s), ...items(s)] });
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(['ok', 'error']);
    expect((await specimenRow(s.specimens[0]!.id)).version).toBe(2);
    expect(await transitionsOf(s.specimens[0]!.id)).toHaveLength(1);
  });

  it('200 items are accepted (limit), 201 -> 400; empty list, missing version, version 0, extra keys, non-uuid ids -> 400; nothing written', async () => {
    const s = await scenario(A, [{ status: t.from }]);
    const before = await snapshot(s);
    const fake = (n: number) => Array.from({ length: n }, (_, i) => ({ id: u(0x500000 + i), version: 1 }));
    expectCode(await failure(run({ ...t.extra, items: fake(201) })), 'common.validation_failed', 400);
    expectCode(await failure(run({ ...t.extra, items: [] })), 'common.validation_failed', 400);
    expectCode(await failure(run({ ...t.extra, items: [{ id: s.specimens[0]!.id }] })), 'common.validation_failed', 400);
    expectCode(await failure(run({ ...t.extra, items: [{ id: s.specimens[0]!.id, version: 0 }] })), 'common.validation_failed', 400);
    expectCode(await failure(run({ ...t.extra, items: [{ id: s.specimens[0]!.id, version: 1, status: 'approved' }] })), 'common.validation_failed', 400);
    expectCode(await failure(run({ ...t.extra, items: [{ id: 'nope', version: 1 }] })), 'common.validation_failed', 400);
    expectCode(await failure(run({ ...t.extra, items: items(s), ids: [s.specimens[0]!.id] })), 'common.validation_failed', 400);
    expectCode(await failure(run({ ...t.extra, items: items(s), tenant_id: B })), 'common.validation_failed', 400);
    expect(await snapshot(s)).toBe(before);
    const big = await run({ ...t.extra, items: fake(200) });
    expect(big.body.results).toHaveLength(200);
    expect(big.body.results.every((x: any) => x.outcome === 'error' && x.code === 'common.not_found')).toBe(true);
  });

  it('403 auth.forbidden without the permission; nothing written', async () => {
    const s = await scenario(A, [{ status: t.from }]);
    const before = await snapshot(s);
    expectCode(await failure(run({ ...t.extra, items: items(s) }, { grants: ALL.filter((g) => g !== t.perm) })), 'auth.forbidden', 403);
    expect(await snapshot(s)).toBe(before);
  });

  it('LD-25: top-level back-entry applies to every item (action time = occurred_at, one audit entry per specimen); the limits of the single ops apply', async () => {
    const s = await scenario(A, [{ status: t.from }, { status: t.from }]);
    const occurred = iso(NOW.getTime() - 4 * HOUR);
    const r = await run({ ...t.extra, items: items(s), entry_mode: 'downtime_backentry', occurred_at: occurred, downtime_ref: 'PAPER-77' });
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(['ok', 'ok']);
    for (const x of s.specimens) expect(new Date((await specimenRow(x.id))[t.col]).toISOString()).toBe(occurred);
    expect(r.probe.audit.filter((e) => e?.detail?.entry_mode === 'downtime_backentry' && e.detail.downtime_ref === 'PAPER-77').map((e) => e.entityId).sort()).toEqual(s.specimens.map((x) => x.id).sort());
    const s2 = await scenario(A, [{ status: t.from }]);
    expectCode(await failure(run({ ...t.extra, items: items(s2), entry_mode: 'downtime_backentry', occurred_at: iso(NOW.getTime() - 73 * HOUR), downtime_ref: 'P' })), 'common.validation_failed', 400);
    expectCode(await failure(run({ ...t.extra, items: items(s2), entry_mode: 'downtime_backentry', downtime_ref: 'P' })), 'common.validation_failed', 400);
    expect((await specimenRow(s2.specimens[0]!.id)).status).toBe(t.from);
  });
});

describe.skipIf(!live)('T-07 bulkReceiveSpecimens — processing centre (AC-04.1, D-13, attack 5)', () => {
  const bulk = (s: Scen, centre: unknown, o: Opts = {}) => call('bulkReceiveSpecimens', req({ headers: { 'idempotency-key': 'k' }, body: { processing_centre_id: centre, items: s.specimens.map((x) => ({ id: x.id, version: x.version })) } }), o);
  it('stores processing_centre_id + its branch on every received specimen and copies them to existing-material rows of the order (D-13)', async () => {
    const s = await scenario(A, [{ status: 'collected' }, { status: 'in_transit' }], { existing: {} });
    await bulk(s, CENTRE_A2, { scope: { all: false, centreIds: [CENTRE[A], CENTRE_A2] } });
    for (const x of s.specimens) expect(await specimenRow(x.id)).toMatchObject({ status: 'received', processing_centre_id: CENTRE_A2, processing_branch_id: BRANCH_A2 });
    expect(await orderTestRow(s.existing!.orderTestId)).toMatchObject({ processing_centre_id: CENTRE_A2, processing_branch_id: BRANCH_A2 });
    expect(await resultRow(s.existing!.resultId)).toMatchObject({ processing_centre_id: CENTRE_A2 });
  });
  it('a processing_centre_id outside the scope -> 403 for the whole request, nothing written (no partial receive)', async () => {
    const s = await scenario(A, [{ status: 'collected' }, { status: 'collected' }]);
    const before = await snapshot(s);
    expectCode(await failure(bulk(s, CENTRE_A2, { scope: { all: false, centreIds: [CENTRE[A]] } })), 'auth.forbidden', 403);
    expect(await snapshot(s)).toBe(before);
  });
  it.each([[undefined], ['x'], [null]])('400 for processing_centre_id %j', async (v) => {
    const s = await scenario(A, [{ status: 'collected' }]);
    expectCode(await failure(call('bulkReceiveSpecimens', req({ headers: { 'idempotency-key': 'k' }, body: { ...(v === undefined ? {} : { processing_centre_id: v }), items: [{ id: s.specimens[0]!.id, version: 1 }] } }))), 'common.validation_failed', 400);
  });
});

// ================================================================== #1 lookupSpecimenByBarcode (AC-04.2)
describe.skipIf(!live)('T-07 lookupSpecimenByBarcode (AC-04.2; 02-TRD §5.1 row 1; REQ-SEC-081)', () => {
  const lookup = (body: unknown, o: Opts = {}) => call('lookupSpecimenByBarcode', req({ body }), o);

  it('barcode body -> 200 SpecimenDto (not wrapped): allowlisted keys only, tests[{test_id,test_code}], registration_no joined from lab.orders', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    const r = await lookup({ barcode: s.specimens[0]!.barcode });
    expect(r.status).toBe(200);
    expect(schemaErrors('SpecimenDto', r.body)).toEqual([]);
    for (const k of Object.keys(r.body)) expect(DTO_KEYS.has(k), `non-allowlisted key ${k}`).toBe(true);
    for (const banned of ['patient_id', 'creation_key', 'patient_sex', 'patient_age_days', 'rejection_comment', 'created_by', 'tenant_id', 'collected_by_membership_id']) expect(r.body).not.toHaveProperty(banned);
    expect(r.body).toMatchObject({ id: s.specimens[0]!.id, barcode: s.specimens[0]!.barcode, status: 'collected', registration_no: s.regNo, order_id: s.orderId, centre_id: CENTRE[A] });
    expect(r.body.tests).toHaveLength(1);
  });

  it('AC-04.2: an unknown barcode -> 404 common.not_found whose text does not echo the barcode; nothing changes', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    const before = await snapshot(s);
    const e = await failure(lookup({ barcode: 'ZZ99999999' }));
    expectCode(e, 'common.not_found', 404);
    expect(JSON.stringify([e.message, e.detail ?? null])).not.toContain('ZZ99999999');
    expect(await snapshot(s)).toBe(before);
  });

  it('another tenant\'s barcode -> 404 (P-11), indistinguishable from unknown', async () => {
    const other = await scenario(B, [{ status: 'collected' }]);
    expectCode(await failure(lookup({ barcode: other.specimens[0]!.barcode }, { tenant: A })), 'common.not_found', 404);
  });

  it('a rejected / discarded specimen is found (so the receive scan can answer lab.specimen_not_receivable, AC-04.3)', async () => {
    const s = await scenario(A, [{ status: 'rejected' }, { status: 'discarded' }]);
    expect((await lookup({ barcode: s.specimens[0]!.barcode })).body.status).toBe('rejected');
    expect((await lookup({ barcode: s.specimens[1]!.barcode })).body.status).toBe('discarded');
  });

  it('registration_no body -> 200 { data: SpecimenDto[] } with all visible specimens of that order; unknown registration no -> 200 { data: [] }', async () => {
    const s = await scenario(A, [{ status: 'ordered' }, { status: 'collected' }, { status: 'received' }]);
    const r = await lookup({ registration_no: s.regNo });
    expect(r.status).toBe(200);
    expect(schemaErrors('SpecimenList', r.body)).toEqual([]);
    expect(r.body.data.map((x: any) => x.id).sort()).toEqual(s.specimens.map((x) => x.id).sort());
    const none = await lookup({ registration_no: 'NOSUCHREG12345' });
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ data: [] });
    const foreign = await scenario(B, [{ status: 'ordered' }]);
    expect((await lookup({ registration_no: foreign.regNo }, { tenant: A })).body).toEqual({ data: [] });
  });

  it('centre scope: a specimen of another centre is 404 by barcode and absent from the registration_no list (REQ-SEC-017, E25)', async () => {
    const s = await scenario(A, [{ status: 'ordered', centre: CENTRE_A2 }], { centre: CENTRE_A2 });
    expectCode(await failure(lookup({ barcode: s.specimens[0]!.barcode }, { scope: { all: false, centreIds: [CENTRE[A]] } })), 'common.not_found', 404);
    expect((await lookup({ registration_no: s.regNo }, { scope: { all: false, centreIds: [CENTRE[A]] } })).body).toEqual({ data: [] });
    expect((await lookup({ barcode: s.specimens[0]!.barcode }, { scope: { all: true } })).status).toBe(200);
  });

  it.each([
    [{}], [{ barcode: 'E1', registration_no: 'R1' }], [{ barcode: 'e2600000101' }], [{ barcode: 'A'.repeat(21) }], [{ barcode: '' }], [{ barcode: 'AB-12' }], [{ barcode: 5 }],
    [{ registration_no: 'r1' }], [{ registration_no: 'R'.repeat(41) }], [{ registration_no: '' }], [{ barcode: 'E2600000101', tenant_id: B }], ['E2600000101'], [null], [[]],
  ])('400 common.validation_failed for the body %j', async (b) => {
    expectCode(await failure(lookup(b)), 'common.validation_failed', 400);
  });

  it('403 without lab.specimen.read; read-only: no specimen write, no event', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    expectCode(await failure(lookup({ barcode: s.specimens[0]!.barcode }, { grants: [P.collect, P.receive] })), 'auth.forbidden', 403);
    const before = await snapshot(s);
    const r = await lookup({ barcode: s.specimens[0]!.barcode });
    expect(r.probe.events).toEqual([]);
    expect(await snapshot(s)).toBe(before);
  });
});

// ================================================================== #2 listSpecimens, #3 getSpecimen
describe.skipIf(!live)('T-07 listSpecimens (02-TRD §5.1 row 2; 02-CV §4.3 cursors)', () => {
  const list = (query: object, o: Opts = {}) => call('listSpecimens', req({ query }), o);
  let s: Scen;
  beforeAll(async () => {
    s = await scenario(A, [{ status: 'ordered' }, { status: 'collected' }, { status: 'received' }, { status: 'stored' }, { status: 'ordered', active: false }]);
  }, 60_000);

  it('200 { data, page }: schema-valid SpecimenDtos of the order only; is_active defaults to true (the inactive one is excluded)', async () => {
    const r = await list({ order_id: s.orderId });
    expect(r.status).toBe(200);
    expect(schemaErrors('SpecimenPage', r.body)).toEqual([]);
    expect(r.body.data).toHaveLength(4);
    expect(r.body.data.every((x: any) => x.order_id === s.orderId && x.is_active === true)).toBe(true);
    expect(r.body.page.limit).toBe(50);
    for (const x of r.body.data) for (const k of Object.keys(x)) expect(DTO_KEYS.has(k)).toBe(true);
  });
  it('is_active=false returns the inactive one; status csv filters', async () => {
    expect((await list({ order_id: s.orderId, is_active: 'false' })).body.data.map((x: any) => x.id)).toEqual([s.specimens[4]!.id]);
    const r = await list({ order_id: s.orderId, status: 'ordered,collected' });
    expect(r.body.data.map((x: any) => x.status).sort()).toEqual(['collected', 'ordered']);
  });
  it('cursor pagination: limit 2 walks all 4 once, no duplicates, last page has no next_cursor', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await list({ order_id: s.orderId, limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.data.map((x: any) => x.id));
      cursor = r.body.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(s.specimens.slice(0, 4).map((x) => x.id).sort());
    expect(new Set(seen).size).toBe(4);
  });
  it('sort=received_at orders by received_at; -created_at (default) puts the newest first', async () => {
    const r = await list({ order_id: s.orderId, status: 'received,stored', sort: 'received_at' });
    const times = r.body.data.map((x: any) => x.received_at).filter(Boolean);
    expect([...times].sort()).toEqual(times);
  });
  it('400 common.invalid_cursor for a malformed / foreign cursor; 400 common.validation_failed for unknown params, bad sort, limit 0 / 201, bad uuid, bad status', async () => {
    expectCode(await failure(list({ order_id: s.orderId, cursor: 'garbage' })), 'common.invalid_cursor', 400);
    for (const q of [{ nope: 1 }, { sort: 'barcode' }, { limit: 0 }, { limit: 201 }, { order_id: 'x' }, { status: 'bogus' }, { centre_id: 'x' }, { is_active: 'maybe' }]) {
      expectCode(await failure(list(q)), 'common.validation_failed', 400);
    }
  });
  it('tenant isolation (P-11): tenant B\'s order is invisible to tenant A, even when named by order_id; centre scope hides other centres', async () => {
    const other = await scenario(B, [{ status: 'ordered' }]);
    expect((await list({ order_id: other.orderId }, { tenant: A })).body.data).toEqual([]);
    expect((await list({ order_id: other.orderId }, { tenant: B, grants: ALL })).body.data).toHaveLength(1);
    const c2 = await scenario(A, [{ status: 'ordered', centre: CENTRE_A2 }], { centre: CENTRE_A2 });
    expect((await list({ order_id: c2.orderId }, { scope: { all: false, centreIds: [CENTRE[A]] } })).body.data).toEqual([]);
    expect((await list({ order_id: c2.orderId }, { scope: { all: true } })).body.data).toHaveLength(1);
  });
  it('403 without lab.specimen.read; read-only (no event)', async () => {
    expectCode(await failure(list({ order_id: s.orderId }, { grants: [P.collect] })), 'auth.forbidden', 403);
    expect((await list({ order_id: s.orderId })).probe.events).toEqual([]);
  });
});

describe.skipIf(!live)('T-07 getSpecimen (02-TRD §5.1 row 3, §5.9)', () => {
  const get = (id: string, o: Opts = {}) => call('getSpecimen', req({ params: { specimen_id: id } }), o);
  it('200 SpecimenDetailDto: schema-valid, transitions in order, results_summary counts, tests', async () => {
    const s = await scenario(A, [{ status: 'ordered' }]);
    await call('collectSpecimen', req({ params: { specimen_id: s.specimens[0]!.id }, headers: ifm(1), body: {} }));
    const r = await get(s.specimens[0]!.id);
    expect(r.status).toBe(200);
    expect(schemaErrors('SpecimenDetailDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: s.specimens[0]!.id, status: 'collected', version: 2, results_summary: { total: 1, resulted: 0, verified: 0, approved: 0 } });
    expect(r.body.transitions.map((x: any) => [x.from_status, x.to_status])).toEqual([['ordered', 'collected']]);
    expect(r.body.tests).toHaveLength(1);
  });
  it('rejection_comment only for holders of lab.specimen.reject (REQ-SEC-081)', async () => {
    const s = await scenario(A, [{ status: 'rejected', comment: 'Clotted, synthetic' }]);
    expect(await get(s.specimens[0]!.id, { grants: [P.read] }).then((r) => r.body)).not.toHaveProperty('rejection_comment');
    expect((await get(s.specimens[0]!.id, { grants: [P.read, P.reject] })).body.rejection_comment).toBe('Clotted, synthetic');
  });
  it('404 for unknown / other tenant / other centre; 400 for a bad id; 403 without read; read-only', async () => {
    const other = await scenario(B, [{ status: 'ordered' }]);
    expectCode(await failure(get(other.specimens[0]!.id, { tenant: A })), 'common.not_found', 404);
    expectCode(await failure(get(u(0xdead03))), 'common.not_found', 404);
    const c2 = await scenario(A, [{ status: 'ordered', centre: CENTRE_A2 }], { centre: CENTRE_A2 });
    expectCode(await failure(get(c2.specimens[0]!.id, { scope: { all: false, centreIds: [CENTRE[A]] } })), 'common.not_found', 404);
    expectCode(await failure(get('nope')), 'common.validation_failed', 400);
    const s = await scenario(A, [{ status: 'ordered' }]);
    expectCode(await failure(get(s.specimens[0]!.id, { grants: [P.collect] })), 'auth.forbidden', 403);
    const before = await snapshot(s);
    expect((await get(s.specimens[0]!.id)).probe.events).toEqual([]);
    expect(await snapshot(s)).toBe(before);
  });
});

// ================================================================== end to end walk (AC-03.1 -> AC-03.3 -> AC-04.1 -> S13 -> S14)
describe.skipIf(!live)('T-07 walk: collect -> dispatch -> receive -> store -> discard keeps one transition row and one event per step', () => {
  it('ordered -> collected -> in_transit -> received -> stored -> discarded (S2, S3, S4, S13, S14), versions 1..6', async () => {
    const s = await scenario(A, [{ status: 'ordered' }]);
    const id = s.specimens[0]!.id;
    await call('collectSpecimen', req({ params: { specimen_id: id }, headers: ifm(1), body: {} }));
    await call('bulkDispatchSpecimens', req({ headers: { 'idempotency-key': 'k' }, body: { items: [{ id, version: 2 }] } }));
    await call('receiveSpecimen', req({ params: { specimen_id: id }, headers: ifm(3), body: { processing_centre_id: CENTRE[A] } }));
    await call('storeSpecimen', req({ params: { specimen_id: id }, headers: ifm(4), body: { location: 'Shelf' } }));
    await call('discardSpecimen', req({ params: { specimen_id: id }, headers: ifm(5), body: { discard_reason: 'Done' } }));
    expect((await transitionsOf(id)).map((t) => [t.transition_code, t.specimen_version])).toEqual([['S2', 2], ['S3', 3], ['S4', 4], ['S13', 5], ['S14', 6]]);
    expect((await specimenRow(id)).status).toBe('discarded');
  });
});
