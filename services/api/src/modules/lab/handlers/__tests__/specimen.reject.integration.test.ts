// C5 T-08 — rejectSpecimen / requestRecollection / createAliquots over HTTP-shaped requests against the migrated database
// (06 row T-08; 02-TRD §3.3 S5/S11/S12, §5.1 rows 9-11, §7.1 events; 03-APP-FLOW S5/S11/S12 + R1/R8; PRD AC-05.1-05.9, AC-06.1-06.3;
//  07-SECURITY REQ-SEC-013/017/081/087 + P-07; 08 A13 D-5, D-12, D-13, D-15, P-1, P-8; 03-IC §3.8).
// Needs the migrated+seeded database that tests/db/c5-t03/run.sh starts (see .orchestra/notes/C5.T-08-verify.cmd): LIMS_TEST_DATABASE_URL = role lims_api (RLS on),
// LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1 where "database is provided" fails.
//
// SEAMS (spec fixes behaviour, not names) — the writer adds handlers/rejectSpecimen.ts, handlers/requestRecollection.ts, handlers/createAliquots.ts
//   (each `export const handler: Handler`), wired in handlers/index.ts; same ctx / req / return shape as the T-07 handlers (see specimen.handlers.integration.test.ts header).
//   Permission = assertRole(ctx, { permission }) of the operation's x-permission (reject, recollect: lab.specimen.reject; aliquots: lab.specimen.receive).
// ASSUMED (spec silent; every one is listed in .orchestra/notes/C5.T-08-tests.md):
//   - reason codes are checked against the effective tenant set: tenant lab.cs_rejection_reasons rows shadow global lab.g_cs_rejection_reasons rows of the same code (codedSets.repo.ts);
//     an unknown / inactive / shadowed-inactive / other-tenant code -> 400 common.validation_failed errors[0].path '/reason_code' (AC-05.3); an ABSENT reason_code -> 422 lab.rejection_reason_required (AC-05.2).
//   - centre scope as in T-07: a specimen is visible when centre_id OR processing_centre_id is in the actor's scope, else 404.
//   - the transition row written for an aliquot (absent -> received) carries transition_code 'S5' (03-APP-FLOW S5: "one per aliquot (∅ → received)"); S11/S12 rows carry reason_code on S11.
//   - the new rows of a recollection (specimen + results) copy processing_centre_id / processing_branch_id of the rejected specimen (D-13, REQ-SEC-017).
//   - the same test_id in two aliquots of one request, or a test with no non-cancelled non-approved result, is a 400 (S5 guard: "each aliquot lists >=1 test of the parent that is not approved/cancelled").
//   - lab.specimen_inactive is NOT asserted for these three ops (their x-error-codes do not list it).
// NOT here: LabPort.getOrderItemProcessingState (AC-05.8 second half, AC-05.10) belongs to T-24; the Idempotency-Key replay is core's hook.
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
const PATIENT = { [A]: u(0xa8), [B]: u(0xb8) } as Record<string, string>;        // not T-07's patients (parallel test files share the database)
const NOW = new Date('2026-06-15T05:00:30.000Z');
const iso = (d: Date | number) => new Date(d).toISOString();
const P = { read: 'lab.specimen.read', collect: 'lab.specimen.collect', receive: 'lab.specimen.receive', reject: 'lab.specimen.reject' } as const;
const ALL = [P.read, P.collect, P.receive, P.reject];
const REASON = 'haemolysed';
const COMMENT = 'SECRET-COMMENT-0042 free text of the technologist (SYNTHETIC)';

// ------------------------------------------------------------------ spec validators (lab.yaml, event schemas)
const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'lab.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`);
};
const DTO_KEYS = new Set(Object.keys(spec.components.schemas.SpecimenDto.properties));
const eventSchema = (name: string) => JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'events', `${name}.v1.schema.json`), 'utf8'))['$defs'].Payload as { required: string[]; properties: object };
const STATUS_EVENT = eventSchema('lab.specimen.status_changed');
const REJECTED_EVENT = eventSchema('lab.specimen.rejected');
const keysOf = (s: { properties: object }) => new Set(Object.keys(s.properties));

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
/** admin write under tenant A's claims (row-audit triggers read them). */
const write = (text: string, values: unknown[] = []) => asAdmin(A, (c) => c.query(text, values));
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
let nextId = 0x40000;                                  // T-07's file uses 0x2000+; both write to the same database
let barcodeN = Date.now() % 90_000_000;
interface SpecIn {
  status: string; active?: boolean; centre?: string; processing?: string; version?: number;
  tests?: number; analytes?: number;                   // order tests on the specimen (default 1) and analytes (results) per test (default 1)
  approvedFirst?: boolean;                             // the first order test already has approved results (specimen then sits in 'verified' / 'resulted')
  cancelTests?: boolean;                               // 'rejected': order tests + results cancelled 'specimen_rejected' (default true)
}
interface Tst { orderTestId: string; testId: string; itemId: string; code: string; resultIds: string[]; analyteIds: string[] }
interface Seeded { id: string; barcode: string; version: number; tests: Tst[]; orderTestId: string; resultId: string }
interface Scen { tenant: string; orderId: string; regNo: string; specimens: Seeded[]; existing?: { orderTestId: string; resultId: string } }
const PRE_RECEIPT = new Set(['ordered', 'collected', 'in_transit']);
const SPEC_REJECTED = new Set(['rejected', 'recollection_ordered']);

/** frontdesk order + items (FK parents) -> lab.orders -> specimens (each with N order tests x M pending results) [+ an existing-material order test/result without specimen]. */
async function scenario(tenant: string, specs: SpecIn[], o: { existing?: boolean; centre?: string } = {}): Promise<Scen> {
  const orderId = u(nextId++);
  const regNo = `RT08${orderId.slice(-6).toUpperCase()}`;
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
    const testRows = async (code: string, specimenId: string | null, otStatus: string, nAnalytes: number, extra: Record<string, unknown>, resStatus: string, resExtra: Record<string, unknown>): Promise<Tst> => {
      const itemId = await item(code);
      const orderTestId = u(nextId++); const testId = u(nextId++);
      await ins(c, 'lab.order_tests', { id: orderTestId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, test_id: testId, test_code: code, test_revision: 1, catalog_revision: 1,
        department_id: u(0x901), workflow_type: 'standard', priority: 'routine', specimen_id: specimenId, status: otStatus, ordered_at: '2026-06-15T04:00:00.000Z', ...extra });
      const resultIds: string[] = []; const analyteIds: string[] = [];
      for (let k = 0; k < nAnalytes; k++) {
        const resultId = u(nextId++); const analyteId = u(nextId++);
        await ins(c, 'lab.results', { id: resultId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, order_test_id: orderTestId, specimen_id: specimenId, patient_id: PATIENT[tenant],
          test_id: testId, analyte_id: analyteId, analyte_code: `${code}A${k}`, department_id: u(0x901), is_reportable: true, result_type: 'numeric', status: resStatus, ...resExtra });
        resultIds.push(resultId); analyteIds.push(analyteId);
      }
      return { orderTestId, testId, itemId, code, resultIds, analyteIds };
    };
    for (const [i, s] of specs.entries()) {
      const id = u(nextId++);
      const barcode = `T8${String(barcodeN++).padStart(8, '0')}`;
      const st = s.status;
      const rejectedLike = SPEC_REJECTED.has(st);
      const received = !PRE_RECEIPT.has(st) && !rejectedLike && st !== 'discarded';
      const processing = s.processing ?? (received || st === 'stored' ? centre : undefined);
      const pBranch = processing === CENTRE_A2 ? BRANCH_A2 : processing ? branch : undefined;
      await ins(c, 'lab.specimens', { id, tenant_id: tenant, centre_id: s.centre ?? centre, order_id: orderId, patient_id: PATIENT[tenant], barcode, creation_key: `${orderId}:WB:EDTA:${i}`,
        specimen_type_code: 'WB', container_code: 'EDTA', priority: 'routine', patient_sex: 'female', patient_age_days: 10950, status: st, ordered_at: '2026-06-15T04:00:00.000Z',
        ...(st !== 'ordered' ? { collected_at: '2026-06-15T04:10:00.000Z', collected_by_membership_id: MEM } : {}),
        ...(st === 'in_transit' ? { in_transit_at: '2026-06-15T04:20:00.000Z' } : {}),
        ...(processing ? { processing_centre_id: processing, processing_branch_id: pBranch } : {}),
        ...(received || (rejectedLike && processing) ? { received_at: '2026-06-15T04:30:00.000Z', received_by_membership_id: MEM } : {}),
        ...(rejectedLike ? { rejected_at: '2026-06-15T04:40:00.000Z', rejection_reason_code: REASON, rejection_comment: COMMENT, rejected_by_membership_id: MEM } : {}),
        ...(st === 'stored' ? { stored_at: '2026-06-15T04:50:00.000Z', storage_location: 'Freezer 1 (SYNTHETIC)' } : {}),
        ...(st === 'discarded' ? { discarded_at: '2026-06-15T04:55:00.000Z', discard_reason: 'Synthetic' } : {}),
        is_active: s.active ?? true, ...(s.version ? { version: s.version } : {}) });
      const cancelled = st === 'rejected' && (s.cancelTests ?? true);
      const otStatus = cancelled ? 'cancelled' : st === 'ordered' ? 'awaiting_collection' : PRE_RECEIPT.has(st) ? 'awaiting_receipt' : 'in_process';
      const tests: Tst[] = [];
      for (let t = 0; t < (s.tests ?? 1); t++) {
        const approved = s.approvedFirst === true && t === 0;
        tests.push(await testRows(`T8${i}${t}`, id, approved ? 'approved' : otStatus, s.analytes ?? 1,
          approved ? { approved_at: '2026-06-15T04:45:00.000Z', processing_centre_id: processing, processing_branch_id: pBranch, received_at: '2026-06-15T04:30:00.000Z' }
            : cancelled ? { cancelled_at: '2026-06-15T04:40:00.000Z', cancel_reason: 'specimen_rejected' }
              : received && processing ? { received_at: '2026-06-15T04:30:00.000Z', processing_centre_id: processing, processing_branch_id: pBranch } : {},
          approved ? 'approved' : cancelled ? 'cancelled' : 'pending',
          approved ? { origin: 'manual', value_numeric: 5, resulted_at: '2026-06-15T04:41:00.000Z', first_resulted_at: '2026-06-15T04:41:00.000Z', verified_at: '2026-06-15T04:42:00.000Z', verified_by_membership_id: MEM,
            approved_at: '2026-06-15T04:45:00.000Z', approved_by_membership_id: MEM, processing_centre_id: processing, processing_branch_id: pBranch }
            : cancelled ? { cancelled_at: '2026-06-15T04:40:00.000Z', cancel_reason: 'specimen_rejected' }
              : processing ? { processing_centre_id: processing, processing_branch_id: pBranch } : {}));
      }
      out.specimens.push({ id, barcode, version: s.version ?? 1, tests, orderTestId: tests[0]!.orderTestId, resultId: tests[0]!.resultIds[0]! });
    }
    if (o.existing) {
      const t = await testRows('T8EX', null, 'in_process', 1, { uses_existing_material: true }, 'pending', {});
      out.existing = { orderTestId: t.orderTestId, resultId: t.resultIds[0]! };
    }
  });
  return out;
}

const specimenRow = async (id: string) => (await sql('SELECT * FROM lab.specimens WHERE id = $1', [id]))[0];
const transitionsOf = (id: string) => sql('SELECT * FROM lab.specimen_transitions WHERE specimen_id = $1 ORDER BY specimen_version', [id]);
const orderTestRow = async (id: string) => (await sql('SELECT * FROM lab.order_tests WHERE id = $1', [id]))[0];
const resultRow = async (id: string) => (await sql('SELECT * FROM lab.results WHERE id = $1', [id]))[0];
const resultsOfTest = (orderTestId: string) => sql('SELECT * FROM lab.results WHERE order_test_id = $1 ORDER BY created_at, id', [orderTestId]);
const replacementsOf = (id: string) => sql('SELECT * FROM lab.specimens WHERE replaces_specimen_id = $1', [id]);
const childrenOf = (id: string) => sql('SELECT * FROM lab.specimens WHERE parent_specimen_id = $1 ORDER BY id', [id]);
/** everything the order owns: specimens, transitions, order tests, results (ordered by id) — "nothing written" = identical snapshot. */
const orderSnap = async (orderId: string) => JSON.stringify(await Promise.all([
  sql('SELECT * FROM lab.specimens WHERE order_id = $1 ORDER BY id', [orderId]),
  sql('SELECT t.* FROM lab.specimen_transitions t JOIN lab.specimens s ON s.id = t.specimen_id WHERE s.order_id = $1 ORDER BY t.id', [orderId]),
  sql('SELECT * FROM lab.order_tests WHERE order_id = $1 ORDER BY id', [orderId]),
  sql('SELECT * FROM lab.results WHERE order_id = $1 ORDER BY id', [orderId]),
]));

// ------------------------------------------------------------------ driving a handler
type Pub = { type: string; input: any };
interface Probe { events: Pub[]; audit: any[]; roleCalls: any[] }
interface Opts { grants?: readonly string[]; tenant?: string; scope?: { all?: boolean; centreIds?: readonly string[] }; now?: Date; failPublishOf?: string }
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
      events: { publish: async (_c: unknown, type: string, input: unknown) => {
        if (o.failPublishOf === type) throw new Error(`injected publish failure for ${type}`);
        probe.events.push({ type, input }); return { eventId: u(0x8000 + probe.events.length), duplicate: false };
      } },
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
const rejectedEvents = (p: Probe) => p.events.filter((e) => e.type === 'lab.specimen.rejected.v1');

const sp = (s: Scen, i = 0) => s.specimens[i]!;
const reject = (s: Scen, body: object = { reason_code: REASON, recollection_required: true }, o: Opts = {}, i = 0) =>
  call('rejectSpecimen', req({ params: { specimen_id: sp(s, i).id }, headers: { ...ifm(sp(s, i).version), 'idempotency-key': `k-${reqN}` }, body }), o);
const recollect = (s: Scen, o: Opts = {}, i = 0, version?: number) =>
  call('requestRecollection', req({ params: { specimen_id: sp(s, i).id }, headers: { ...ifm(version ?? sp(s, i).version), 'idempotency-key': `k-${reqN}` }, body: {} }), o);
const aliquot = (s: Scen, body: unknown, o: Opts = {}, i = 0, version?: number) =>
  call('createAliquots', req({ params: { specimen_id: sp(s, i).id }, headers: { ...ifm(version ?? sp(s, i).version), 'idempotency-key': `k-${reqN}` }, body }), o);
const lookup = (barcode: string) => call('lookupSpecimenByBarcode', req({ body: { barcode } }));

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 12 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await asAdmin(t, (c) => ins(c, 'frontdesk.patients', { id: PATIENT[t], tenant_id: t, patient_code: 'P-T08', full_name: 'Test Patient T08', name_search: 'test patient t08',
    sex: 'female', registered_centre_id: CENTRE[t] }));
  // rejection reasons (lowercase [a-z0-9_] by CHECK): A: haemolysed (active), rt08_off (inactive), rt08_shadow (inactive override of an ACTIVE global); global: rt08_glob, rt08_shadow; B: rt08_b_only
  const tenantReason = (t: string, n: number, code: string, active: boolean) => asAdmin(t, async (c) => {
    if ((await c.query('SELECT 1 FROM lab.cs_rejection_reasons WHERE tenant_id = $1 AND code = $2', [t, code])).rowCount === 0)
      await ins(c, 'lab.cs_rejection_reasons', { id: u(0x7000 + n), tenant_id: t, code, display: `${code} (SYNTHETIC)`, is_active: active });
  });
  await tenantReason(A, 1, REASON, true); await tenantReason(A, 2, 'rt08_off', false); await tenantReason(A, 3, 'rt08_shadow', false); await tenantReason(B, 4, 'rt08_b_only', true);
  for (const [n, code] of [[11, 'rt08_glob'], [12, 'rt08_shadow']] as const)
    await sql('INSERT INTO lab.g_cs_rejection_reasons (id, code, display) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING', [u(0x7100 + n), code, `${code} (SYNTHETIC)`]);
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-08 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

// ================================================================== shared HTTP contract of the three operations
interface Op { op: string; perm: string; from: string; spec: SpecIn; body: (s: Scen) => object }
const OPS: Op[] = [
  { op: 'rejectSpecimen', perm: P.reject, from: 'received', spec: { status: 'received' }, body: () => ({ reason_code: REASON, recollection_required: true }) },
  { op: 'requestRecollection', perm: P.reject, from: 'rejected', spec: { status: 'rejected' }, body: () => ({}) },
  { op: 'createAliquots', perm: P.receive, from: 'received', spec: { status: 'received', tests: 2 }, body: (s) => ({ aliquots: [{ test_ids: [sp(s).tests[0]!.testId] }] }) },
];
const eachLive = <R extends { op: string }>(rows: readonly R[], title: string, fn: (t: R) => void) =>
  describe.skipIf(!live)(title, () => { for (const t of rows) describe(t.op, () => fn(t)); });

eachLive(OPS, 'T-08 contract (x-error-codes, If-Match, 07-SECURITY)', (t) => {
  // C5.T-08 ruling: `??` would turn an explicit `body: null` into the valid default body; use `in` so null/[]/'x'/5 are sent as given.
  const run = (s: Scen, o: Opts = {}, over: { body?: unknown; headers?: object; params?: object } = {}) =>
    call(t.op, req({
      params: 'params' in over ? over.params : { specimen_id: sp(s).id },
      headers: 'headers' in over ? over.headers : ifm(sp(s).version),
      body: 'body' in over ? over.body : t.body(s),
    }), o);

  it('428 common.precondition_required without If-Match; nothing written', async () => {
    const s = await scenario(A, [t.spec]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(run(s, {}, { headers: {} })), 'common.precondition_required', 428);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('409 common.version_conflict on a stale If-Match; nothing written (no event, no transition, no new row)', async () => {
    const s = await scenario(A, [{ ...t.spec, version: 3 }]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(run(s, {}, { headers: ifm(2) })), 'common.version_conflict', 409);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it.each(['abc', '"0"', '"-1"', '2', '"1.5"', '""'])('400 common.validation_failed for a malformed If-Match %s', async (h) => {
    const s = await scenario(A, [t.spec]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(run(s, {}, { headers: ifm(h) })), 'common.validation_failed', 400);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('403 auth.forbidden without the operation permission (and for a read-only role); nothing written', async () => {
    const s = await scenario(A, [t.spec]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(run(s, { grants: ALL.filter((g) => g !== t.perm) })), 'auth.forbidden', 403);
    expectCode(await failure(run(s, { grants: [P.read] })), 'auth.forbidden', 403);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('404 common.not_found for an unknown id and for another tenant\'s specimen (P-11); the other tenant\'s rows are untouched', async () => {
    const other = await scenario(B, [t.spec]);
    const before = await orderSnap(other.orderId);
    expectCode(await failure(call(t.op, req({ params: { specimen_id: sp(other).id }, headers: ifm(1), body: t.body(other) }), { tenant: A })), 'common.not_found', 404);
    expectCode(await failure(call(t.op, req({ params: { specimen_id: u(0xdead00) }, headers: ifm(1), body: t.body(other) }), { tenant: A })), 'common.not_found', 404);
    expect(await orderSnap(other.orderId)).toBe(before);
  });
  it('404 for a specimen outside the actor\'s centre scope (E25, REQ-SEC-017); a scope with all=true reaches it', async () => {
    const s = await scenario(A, [{ ...t.spec, centre: CENTRE_A2, processing: CENTRE_A2 }], { centre: CENTRE_A2 });
    const before = await orderSnap(s.orderId);
    expectCode(await failure(run(s, { scope: { all: false, centreIds: [CENTRE[A]] } })), 'common.not_found', 404);
    expect(await orderSnap(s.orderId)).toBe(before);
    expect((await run(s, { scope: { all: true } })).status).toBe(200);
  });
  it.each([['not-a-uuid'], ['0190c607-0000-7000-8000-00000000000'], ['']])('400 common.validation_failed for the path id %j', async (id) => {
    const s = await scenario(A, [t.spec]);
    expectCode(await failure(run(s, {}, { params: { specimen_id: id } })), 'common.validation_failed', 400);
  });
  it('400 common.validation_failed for unknown body keys incl. a tenant field (REQ-SEC-013, additionalProperties false); nothing written', async () => {
    const s = await scenario(A, [t.spec]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(run(s, {}, { body: { ...t.body(s), tenant_id: B } })), 'common.validation_failed', 400);
    expectCode(await failure(run(s, {}, { body: { ...t.body(s), status: 'approved' } })), 'common.validation_failed', 400);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('400 common.validation_failed for a non-object body (null, array, string); nothing written', async () => {
    const s = await scenario(A, [t.spec]);
    const before = await orderSnap(s.orderId);
    for (const bad of [null, [], 'x', 5]) expectCode(await failure(run(s, {}, { body: bad })), 'common.validation_failed', 400);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('the operation permission is asserted through IdentityPort.assertRole', async () => {
    const s = await scenario(A, [t.spec]);
    const r = await run(s);
    expect(r.status).toBe(200);
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(t.perm);
  });
});

// ================================================================== #9 rejectSpecimen (AC-05.1 - AC-05.4, AC-05.6; S11 + S12)
describe.skipIf(!live)('T-08 rejectSpecimen with recollection_required = true (AC-05.1; D-12, D-13)', () => {
  const FROM = ['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified'] as const;

  it('AC-05.1: one tx — old -> rejected -> recollection_ordered, new specimen in `ordered` with replaces_specimen_id + new barcode + copied processing centre/branch, response + event sequence (D-12, D-13)', async () => {
    const s = await scenario(A, [{ status: 'received', processing: CENTRE_A2, tests: 2 }]);
    const old = sp(s);
    const r = await reject(s, { reason_code: REASON, comment: COMMENT, recollection_required: true }, { scope: { all: false, centreIds: [CENTRE[A], CENTRE_A2] } });
    expect(r.status).toBe(200);
    expect(schemaErrors('RejectSpecimenResponse', r.body)).toEqual([]);
    for (const d of [r.body.specimen, r.body.recollection_specimen]) for (const k of Object.keys(d)) expect(DTO_KEYS.has(k), `non-allowlisted key ${k}`).toBe(true);
    // old specimen: S11 (v2) then S12 (v3)
    const o = await specimenRow(old.id);
    expect(o).toMatchObject({ status: 'recollection_ordered', version: 3, rejection_reason_code: REASON, rejection_comment: COMMENT, rejected_by_membership_id: MEM, barcode: old.barcode });
    expect(new Date(o.rejected_at).toISOString()).toBe(iso(NOW));
    expect(new Date(o.recollection_ordered_at).toISOString()).toBe(iso(NOW));
    expect(r.body.specimen).toMatchObject({ id: old.id, status: 'recollection_ordered', version: 3, barcode: old.barcode, rejection_reason_code: REASON });
    const tr = await transitionsOf(old.id);
    expect(tr.map((x) => [x.transition_code, x.from_status, x.to_status, x.specimen_version])).toEqual([['S11', 'received', 'rejected', 2], ['S12', 'rejected', 'recollection_ordered', 3]]);
    expect(tr[0]).toMatchObject({ reason_code: REASON, actor_type: 'user', actor_id: SYS, membership_id: MEM });
    // new specimen
    const news = await replacementsOf(old.id);
    expect(news).toHaveLength(1);
    const n = news[0]!;
    expect(n).toMatchObject({ status: 'ordered', version: 1, is_active: true, order_id: s.orderId, patient_id: PATIENT[A], centre_id: CENTRE[A], specimen_type_code: 'WB', container_code: 'EDTA', priority: 'routine',
      replaces_specimen_id: old.id, parent_specimen_id: null, processing_centre_id: CENTRE_A2, processing_branch_id: BRANCH_A2, collected_at: null, rejected_at: null });
    expect(n.barcode).not.toBe(old.barcode);
    expect(n.barcode).toMatch(/^[A-Z0-9]{1,20}$/);
    expect(r.body.recollection_specimen).toMatchObject({ id: n.id, status: 'ordered', version: 1, barcode: n.barcode, replaces_specimen_id: old.id, processing_centre_id: CENTRE_A2 });
    expect((await transitionsOf(n.id)).map((x) => [x.transition_code, x.from_status, x.to_status, x.specimen_version])).toEqual([['S1', null, 'ordered', 1]]);
    // order tests re-pointed to the new specimen, following it (specimen ordered -> awaiting_collection)
    for (const t of old.tests) expect(await orderTestRow(t.orderTestId)).toMatchObject({ specimen_id: n.id, status: 'awaiting_collection', cancelled_at: null, cancel_reason: null });
    expect(r.body.recollection_specimen.tests.map((x: any) => x.test_id).sort()).toEqual(old.tests.map((x) => x.testId).sort());
    // results: old rows cancelled (D-12), NEW pending rows inserted for the re-pointed tests, never re-pointed
    for (const t of old.tests) {
      const rows = await resultsOfTest(t.orderTestId);
      expect(rows).toHaveLength(2);
      const oldRow = rows.find((x) => x.id === t.resultIds[0])!;
      const newRow = rows.find((x) => x.id !== t.resultIds[0])!;
      expect(oldRow).toMatchObject({ status: 'cancelled', cancel_reason: 'specimen_rejected', specimen_id: old.id });
      expect(oldRow.cancelled_at).not.toBeNull();
      expect(newRow).toMatchObject({ status: 'pending', specimen_id: n.id, order_test_id: t.orderTestId, order_item_id: t.itemId, order_id: s.orderId, patient_id: PATIENT[A], test_id: t.testId, analyte_id: t.analyteIds[0],
        analyte_code: `${t.code}A0`, centre_id: CENTRE[A], processing_centre_id: CENTRE_A2, processing_branch_id: BRANCH_A2, is_reportable: true, result_type: 'numeric', version: 1 });
    }
    // events, in order (AC-05.1 and 02-TRD §7.1 keys)
    expect(r.probe.events.map((e) => e.type)).toEqual(['lab.specimen.status_changed.v1', 'lab.specimen.rejected.v1', 'lab.specimen.status_changed.v1', 'lab.specimen.status_changed.v1']);
    const [e1, e2, e3, e4] = r.probe.events;
    expect(e1!.input.payload).toMatchObject({ specimen_id: old.id, order_id: s.orderId, patient_id: PATIENT[A], centre_id: CENTRE[A], from_status: 'received', to_status: 'rejected', changed_at: iso(NOW) });
    expect(e1!.input).toMatchObject({ aggregate: { type: 'specimen', id: old.id }, idempotencyKey: `${old.id}:rejected:2` });
    expect(e2!.input.payload).toMatchObject({ specimen_id: old.id, order_id: s.orderId, patient_id: PATIENT[A], centre_id: CENTRE[A], reason_code: REASON, rejected_at: iso(NOW), recollection_required: true });
    expect([...e2!.input.payload.order_item_ids].sort()).toEqual(old.tests.map((x) => x.itemId).sort());
    expect(e2!.input).toMatchObject({ aggregate: { type: 'specimen', id: old.id }, idempotencyKey: `${old.id}:rejected` });
    expect(e3!.input.payload).toMatchObject({ specimen_id: old.id, from_status: 'rejected', to_status: 'recollection_ordered' });
    expect(e3!.input).toMatchObject({ aggregate: { type: 'specimen', id: old.id }, idempotencyKey: `${old.id}:recollection_ordered:3` });
    expect(e4!.input.payload).toMatchObject({ specimen_id: n.id, order_id: s.orderId, patient_id: PATIENT[A], centre_id: CENTRE[A], specimen_type_code: 'WB', to_status: 'ordered' });
    expect(e4!.input.payload.from_status).toBeUndefined();            // absent -> ordered
    expect(e4!.input).toMatchObject({ aggregate: { type: 'specimen', id: n.id }, idempotencyKey: `${n.id}:ordered:1` });
    for (const e of [e1!, e3!, e4!]) for (const k of Object.keys(e.input.payload)) expect(keysOf(STATUS_EVENT).has(k), `status_changed payload key ${k}`).toBe(true);
    for (const k of STATUS_EVENT.required) for (const e of [e1!, e3!, e4!]) expect(e.input.payload[k], `status_changed required ${k}`).toBeDefined();
    for (const k of Object.keys(e2!.input.payload)) expect(keysOf(REJECTED_EVENT).has(k), `rejected payload key ${k}`).toBe(true);
    for (const k of REJECTED_EVENT.required) expect(e2!.input.payload[k], `rejected required ${k}`).toBeDefined();
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(P.reject);
  });

  it('AC-05.6: the free-text comment is in no event payload, no response key, and no audit entry', async () => {
    const s = await scenario(A, [{ status: 'received' }, { status: 'received' }]);
    const r1 = await reject(s, { reason_code: REASON, comment: COMMENT, recollection_required: true });
    const r2 = await reject(s, { reason_code: REASON, comment: COMMENT, recollection_required: false }, {}, 1);
    for (const r of [r1, r2]) {
      expect(JSON.stringify(r.probe.events)).not.toContain('SECRET-COMMENT');
      expect(JSON.stringify(r.probe.events)).not.toContain('comment');
      expect(JSON.stringify(r.body)).not.toContain('SECRET-COMMENT');
      expect(JSON.stringify(r.probe.audit)).not.toContain('SECRET-COMMENT');
    }
    expect((await specimenRow(sp(s).id)).rejection_comment).toBe(COMMENT);       // stored, just never published
  });

  it('a comment is optional; a 500-char comment is stored, 501 -> 400 (nothing written)', async () => {
    const s = await scenario(A, [{ status: 'received' }, { status: 'received' }, { status: 'received' }]);
    expect((await reject(s, { reason_code: REASON, recollection_required: true })).status).toBe(200);
    expect((await specimenRow(sp(s).id)).rejection_comment).toBeNull();
    expect((await reject(s, { reason_code: REASON, comment: 'c'.repeat(500), recollection_required: true }, {}, 1)).status).toBe(200);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(reject(s, { reason_code: REASON, comment: 'c'.repeat(501), recollection_required: true }, {}, 2)), 'common.validation_failed', 400);
    expect(await orderSnap(s.orderId)).toBe(before);
  });

  it.each(FROM)('AC-05.1: a specimen in %s can be rejected with recollection (S11 transition row from that state)', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const r = await reject(s);
    expect(r.status).toBe(200);
    expect(r.body.specimen).toMatchObject({ status: 'recollection_ordered', version: 3 });
    expect(r.body.recollection_specimen).toMatchObject({ status: 'ordered', replaces_specimen_id: sp(s).id });
    expect((await transitionsOf(sp(s).id))[0]).toMatchObject({ transition_code: 'S11', from_status: from, to_status: 'rejected' });
    expect(r.probe.events.filter((e) => e.type === 'lab.specimen.rejected.v1')).toHaveLength(1);
    expect(await orderTestRow(sp(s).orderTestId)).toMatchObject({ status: 'awaiting_collection', specimen_id: (await replacementsOf(sp(s).id))[0]!.id });
  });

  it('D-12: a test with 2 analytes gets 2 new pending rows; the partial unique index (order_test_id, analyte_id WHERE status <> cancelled) holds', async () => {
    const s = await scenario(A, [{ status: 'received', analytes: 2 }]);
    await reject(s);
    const rows = await resultsOfTest(sp(s).orderTestId);
    expect(rows).toHaveLength(4);
    expect(rows.filter((x) => x.status === 'cancelled')).toHaveLength(2);
    const live2 = rows.filter((x) => x.status === 'pending');
    expect(live2).toHaveLength(2);
    expect(new Set(live2.map((x) => x.analyte_id))).toEqual(new Set(sp(s).tests[0]!.analyteIds));
  });

  it('only non-approved results are cancelled: an approved result keeps its row (still the single live row for its analyte); the other test is re-pointed with new pending rows', async () => {
    const s = await scenario(A, [{ status: 'verified', tests: 2, approvedFirst: true }]);
    const [a, b] = sp(s).tests as [Tst, Tst];
    const before = await resultRow(a.resultIds[0]!);
    expect((await reject(s)).status).toBe(200);
    expect(await resultRow(a.resultIds[0]!)).toEqual(before);                     // untouched: status approved, no cancel_reason
    expect(await orderTestRow(a.orderTestId)).toMatchObject({ status: 'approved' });
    expect((await resultsOfTest(a.orderTestId)).filter((x) => x.status !== 'cancelled')).toHaveLength(1);
    const rowsB = await resultsOfTest(b.orderTestId);
    expect(rowsB.filter((x) => x.status === 'cancelled' && x.cancel_reason === 'specimen_rejected')).toHaveLength(1);
    expect(rowsB.filter((x) => x.status === 'pending')).toHaveLength(1);
  });

  it('isolation: other specimens, existing-material tests and results of the same order are untouched', async () => {
    const s = await scenario(A, [{ status: 'received' }, { status: 'received' }], { existing: true });
    const other = [await specimenRow(sp(s, 1).id), await orderTestRow(sp(s, 1).orderTestId), await resultRow(sp(s, 1).resultId), await orderTestRow(s.existing!.orderTestId), await resultRow(s.existing!.resultId)];
    expect((await reject(s)).status).toBe(200);
    expect([await specimenRow(sp(s, 1).id), await orderTestRow(sp(s, 1).orderTestId), await resultRow(sp(s, 1).resultId), await orderTestRow(s.existing!.orderTestId), await resultRow(s.existing!.resultId)]).toEqual(other);
    expect(await transitionsOf(sp(s, 1).id)).toHaveLength(0);
  });

  it('AC-05.7: the old barcode resolves only to the old (rejected) specimen, the new barcode to the new one', async () => {
    const s = await scenario(A, [{ status: 'received' }]);
    const r = await reject(s);
    const old = (await lookup(sp(s).barcode)).body;
    expect(old).toMatchObject({ id: sp(s).id, status: 'recollection_ordered', barcode: sp(s).barcode });
    const fresh = (await lookup(r.body.recollection_specimen.barcode)).body;
    expect(fresh).toMatchObject({ id: r.body.recollection_specimen.id, status: 'ordered' });
    expect((await sql('SELECT count(*)::int AS n FROM lab.specimens WHERE tenant_id = $1 AND barcode = $2', [A, sp(s).barcode]))[0].n).toBe(1);
  });

  it('AC-05.9 / D-15: the rejected tube (recollection_ordered) can then be discarded with a reason', async () => {
    const s = await scenario(A, [{ status: 'received' }]);
    await reject(s);
    const d = await call('discardSpecimen', req({ params: { specimen_id: sp(s).id }, headers: ifm(3), body: { discard_reason: 'Biohazard bin (SYNTHETIC)' } }));
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ status: 'discarded', version: 4 });
    expect((await transitionsOf(sp(s).id)).at(-1)).toMatchObject({ transition_code: 'S14', from_status: 'recollection_ordered', to_status: 'discarded' });
  });

  it('one-tx semantics: a failure while publishing the 4th event rolls back everything — specimen, new specimen, order tests, results, transitions (the harness commits only on success)', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    const before = await orderSnap(s.orderId);
    await failure(reject(s, undefined, { failPublishOf: 'lab.specimen.rejected.v1' }));
    expect(await orderSnap(s.orderId)).toBe(before);
    expect(await replacementsOf(sp(s).id)).toHaveLength(0);
  });

  it('race: 5 concurrent rejects with the same If-Match -> exactly one 200, one replacement specimen, one rejected event, one set of new result rows', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    const out = await Promise.allSettled(Array.from({ length: 5 }, () => reject(s)));
    const ok = out.filter((x) => x.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof reject>>>[];
    expect(ok).toHaveLength(1);
    for (const x of out) if (x.status === 'rejected') { expect(['common.version_conflict', 'lab.specimen_invalid_transition']).toContain(x.reason.code); expect(x.reason.statusCode).toBe(409); }
    expect(await replacementsOf(sp(s).id)).toHaveLength(1);
    expect((await sql('SELECT count(*)::int AS n FROM lab.results WHERE order_id = $1 AND status = $2', [s.orderId, 'pending']))[0].n).toBe(2);
    expect(rejectedEvents(ok[0]!.value.probe)).toHaveLength(1);
    expect((await specimenRow(sp(s).id)).version).toBe(3);
  });
});

describe.skipIf(!live)('T-08 rejectSpecimen with recollection_required = false (AC-05.8; D-5, R8)', () => {
  it('S11 only: specimen -> rejected (v2), NO new specimen, response without recollection_specimen; order tests + their pending results cancelled (specimen_rejected); events status_changed + rejected', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    const old = sp(s);
    const r = await reject(s, { reason_code: REASON, comment: COMMENT, recollection_required: false });
    expect(r.status).toBe(200);
    expect(schemaErrors('RejectSpecimenResponse', r.body)).toEqual([]);
    expect(r.body).not.toHaveProperty('recollection_specimen');
    expect(r.body.specimen).toMatchObject({ id: old.id, status: 'rejected', version: 2, barcode: old.barcode, rejection_reason_code: REASON });
    expect(await specimenRow(old.id)).toMatchObject({ status: 'rejected', version: 2, rejection_reason_code: REASON, rejection_comment: COMMENT, rejected_by_membership_id: MEM, recollection_ordered_at: null });
    expect((await transitionsOf(old.id)).map((x) => [x.transition_code, x.to_status])).toEqual([['S11', 'rejected']]);
    expect(await replacementsOf(old.id)).toHaveLength(0);
    for (const t of old.tests) {
      expect(await orderTestRow(t.orderTestId)).toMatchObject({ status: 'cancelled', cancel_reason: 'specimen_rejected', specimen_id: old.id });
      expect(new Date((await orderTestRow(t.orderTestId)).cancelled_at).toISOString()).toBe(iso(NOW));
      const rows = await resultsOfTest(t.orderTestId);
      expect(rows).toHaveLength(1);                                          // R8 only: no new rows
      expect(rows[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'specimen_rejected', specimen_id: old.id });
    }
    expect(r.probe.events.map((e) => e.type)).toEqual(['lab.specimen.status_changed.v1', 'lab.specimen.rejected.v1']);
    expect(r.probe.events[0]!.input).toMatchObject({ idempotencyKey: `${old.id}:rejected:2` });
    expect(r.probe.events[0]!.input.payload).toMatchObject({ from_status: 'received', to_status: 'rejected' });
    expect(r.probe.events[1]!.input.payload).toMatchObject({ specimen_id: old.id, reason_code: REASON, recollection_required: false });
    expect(r.probe.events[1]!.input.idempotencyKey).toBe(`${old.id}:rejected`);
    expect(JSON.stringify(r.probe.events)).not.toContain('SECRET-COMMENT');
  });

  it('AC-05.7: the old barcode still resolves to the rejected specimen', async () => {
    const s = await scenario(A, [{ status: 'received' }]);
    await reject(s, { reason_code: REASON, recollection_required: false });
    expect((await lookup(sp(s).barcode)).body).toMatchObject({ id: sp(s).id, status: 'rejected' });
  });

  it('only non-approved results are cancelled; an approved result and its order test keep their state', async () => {
    const s = await scenario(A, [{ status: 'verified', tests: 2, approvedFirst: true }]);
    const [a, b] = sp(s).tests as [Tst, Tst];
    const approvedBefore = [await resultRow(a.resultIds[0]!), await orderTestRow(a.orderTestId)];
    expect((await reject(s, { reason_code: REASON, recollection_required: false })).status).toBe(200);
    expect([await resultRow(a.resultIds[0]!), await orderTestRow(a.orderTestId)]).toEqual(approvedBefore);
    expect(await resultRow(b.resultIds[0]!)).toMatchObject({ status: 'cancelled', cancel_reason: 'specimen_rejected' });
    expect(await orderTestRow(b.orderTestId)).toMatchObject({ status: 'cancelled', cancel_reason: 'specimen_rejected' });
  });

  it('other specimens, existing-material tests and results of the order are untouched', async () => {
    const s = await scenario(A, [{ status: 'received' }, { status: 'received' }], { existing: true });
    const keep = [await orderTestRow(sp(s, 1).orderTestId), await resultRow(sp(s, 1).resultId), await orderTestRow(s.existing!.orderTestId), await resultRow(s.existing!.resultId)];
    await reject(s, { reason_code: REASON, recollection_required: false });
    expect([await orderTestRow(sp(s, 1).orderTestId), await resultRow(sp(s, 1).resultId), await orderTestRow(s.existing!.orderTestId), await resultRow(s.existing!.resultId)]).toEqual(keep);
  });

  it('AC-05.9: a rejected tube (no recollection) can be discarded; one-tx: a publish failure leaves the specimen, order tests and results untouched', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    const before = await orderSnap(s.orderId);
    await failure(reject(s, { reason_code: REASON, recollection_required: false }, { failPublishOf: 'lab.specimen.rejected.v1' }));
    expect(await orderSnap(s.orderId)).toBe(before);
    await reject(s, { reason_code: REASON, recollection_required: false });
    const d = await call('discardSpecimen', req({ params: { specimen_id: sp(s).id }, headers: ifm(2), body: { discard_reason: 'Biohazard bin (SYNTHETIC)' } }));
    expect(d.body).toMatchObject({ status: 'discarded' });
  });
});

describe.skipIf(!live)('T-08 rejectSpecimen — validation and state guards (AC-05.2 - AC-05.4)', () => {
  const bad = async (body: unknown, code: string, status: number, check?: (e: any) => void) => {
    const s = await scenario(A, [{ status: 'received' }]);
    const before = await orderSnap(s.orderId);
    const e = await failure(reject(s, body as object));
    expectCode(e, code, status);
    check?.(e);
    expect(await orderSnap(s.orderId)).toBe(before);
  };

  it('AC-05.2: no reason_code -> 422 lab.rejection_reason_required, nothing written', async () => {
    await bad({ recollection_required: true }, 'lab.rejection_reason_required', 422);
    await bad({ recollection_required: false, comment: 'x' }, 'lab.rejection_reason_required', 422);
  });
  it('AC-05.3: a reason_code not in the tenant\'s active reasons -> 400 common.validation_failed, errors[0].path = /reason_code', async () => {
    for (const code of ['no_such_reason', 'rt08_off', 'rt08_shadow', 'rt08_b_only'])      // unknown | inactive tenant row | inactive tenant override of an ACTIVE global | another tenant's code
      await bad({ reason_code: code, recollection_required: true }, 'common.validation_failed', 400, (e) => expect(e.errors?.[0]?.path, code).toBe('/reason_code'));
  });
  it('a global active reason without a tenant row is accepted (effective set = tenant rows + non-overridden global rows)', async () => {
    const s = await scenario(A, [{ status: 'received' }]);
    const r = await reject(s, { reason_code: 'rt08_glob', recollection_required: false });
    expect(r.status).toBe(200);
    expect(r.body.specimen).toMatchObject({ rejection_reason_code: 'rt08_glob' });
  });
  it.each([
    ['recollection_required missing', { reason_code: REASON }],
    ['recollection_required not a boolean', { reason_code: REASON, recollection_required: 'yes' }],
    ['recollection_required null', { reason_code: REASON, recollection_required: null }],
    ['reason_code not a string', { reason_code: 5, recollection_required: true }],
    ['reason_code violating the pattern', { reason_code: 'bad code!', recollection_required: true }],
    ['reason_code over 100 chars', { reason_code: 'a'.repeat(101), recollection_required: true }],
    ['comment not a string', { reason_code: REASON, comment: 5, recollection_required: true }],
    ['unknown key', { reason_code: REASON, recollection_required: true, version: 3 }],
  ])('400 common.validation_failed: %s', async (_n, body) => { await bad(body, 'common.validation_failed', 400); });
  it.each(['approved', 'reported', 'rejected', 'recollection_ordered', 'stored', 'discarded'])('AC-05.4: a %s specimen -> 409 lab.specimen_invalid_transition, nothing written', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(reject(s)), 'lab.specimen_invalid_transition', 409);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('rejecting twice: the second reject is a 409 and creates no second recollection or rejected event', async () => {
    const s = await scenario(A, [{ status: 'received' }]);
    await reject(s, { reason_code: REASON, recollection_required: false });
    expectCode(await failure(reject(s, { reason_code: REASON, recollection_required: true }, {}, 0)), 'common.version_conflict', 409);   // stale If-Match (v1; the specimen is at v2)
    expectCode(await failure(call('rejectSpecimen', req({ params: { specimen_id: sp(s).id }, headers: ifm(2), body: { reason_code: REASON, recollection_required: true } }))), 'lab.specimen_invalid_transition', 409);
    expect(await replacementsOf(sp(s).id)).toHaveLength(0);
  });
});

// ================================================================== #10 requestRecollection (AC-05.5; S12; D-5, D-6, D-12)
describe.skipIf(!live)('T-08 requestRecollection — late recollection after a reject without recollection (AC-05.5)', () => {
  /** reject through the handler first (D-5 state), then recollect with the specimen's new version. */
  const rejectedWithoutRecollection = async (spec: SpecIn = { status: 'received', tests: 2 }) => {
    const s = await scenario(A, [spec]);
    const rej = await reject(s, { reason_code: REASON, recollection_required: false });
    return { s, rej };
  };

  it('AC-05.5: S12 — recollection_ordered (v3), new specimen (ordered, replaces_specimen_id, copied processing centre/branch), cancelled order tests re-opened + re-pointed, NEW pending rows, old rows stay cancelled', async () => {
    const { s } = await rejectedWithoutRecollection({ status: 'received', processing: CENTRE_A2, tests: 2 });
    const old = sp(s);
    const r = await recollect(s, { scope: { all: false, centreIds: [CENTRE[A], CENTRE_A2] } }, 0, 2);
    expect(r.status).toBe(200);
    expect(schemaErrors('RecollectionResponse', r.body)).toEqual([]);
    for (const d of [r.body.specimen, r.body.recollection_specimen]) for (const k of Object.keys(d)) expect(DTO_KEYS.has(k), `non-allowlisted key ${k}`).toBe(true);
    const o = await specimenRow(old.id);
    expect(o).toMatchObject({ status: 'recollection_ordered', version: 3, barcode: old.barcode, rejection_reason_code: REASON });
    expect(new Date(o.recollection_ordered_at).toISOString()).toBe(iso(NOW));
    expect(r.body.specimen).toMatchObject({ id: old.id, status: 'recollection_ordered', version: 3 });
    expect((await transitionsOf(old.id)).map((x) => [x.transition_code, x.to_status, x.specimen_version])).toEqual([['S11', 'rejected', 2], ['S12', 'recollection_ordered', 3]]);
    const news = await replacementsOf(old.id);
    expect(news).toHaveLength(1);
    const n = news[0]!;
    expect(n).toMatchObject({ status: 'ordered', version: 1, order_id: s.orderId, replaces_specimen_id: old.id, processing_centre_id: CENTRE_A2, processing_branch_id: BRANCH_A2, specimen_type_code: 'WB', container_code: 'EDTA' });
    expect(n.barcode).not.toBe(old.barcode);
    expect(r.body.recollection_specimen).toMatchObject({ id: n.id, status: 'ordered', replaces_specimen_id: old.id, barcode: n.barcode });
    for (const t of old.tests) {
      expect(await orderTestRow(t.orderTestId)).toMatchObject({ specimen_id: n.id, status: 'awaiting_collection', cancelled_at: null, cancel_reason: null });     // re-opened
      const rows = await resultsOfTest(t.orderTestId);
      expect(rows).toHaveLength(2);
      expect(rows.find((x) => x.id === t.resultIds[0])).toMatchObject({ status: 'cancelled', cancel_reason: 'specimen_rejected', specimen_id: old.id });   // old rows stay cancelled
      expect(rows.find((x) => x.id !== t.resultIds[0])).toMatchObject({ status: 'pending', specimen_id: n.id, analyte_id: t.analyteIds[0], processing_centre_id: CENTRE_A2, version: 1 });
    }
  });

  it('events: status_changed (-> recollection_ordered, key <old>:recollection_ordered:3) + status_changed (new: absent -> ordered); NO second lab.specimen.rejected.v1 (AC-05.5, D-6)', async () => {
    const { s } = await rejectedWithoutRecollection();
    const r = await recollect(s, {}, 0, 2);
    expect(r.probe.events.map((e) => e.type)).toEqual(['lab.specimen.status_changed.v1', 'lab.specimen.status_changed.v1']);
    expect(rejectedEvents(r.probe)).toHaveLength(0);
    const n = (await replacementsOf(sp(s).id))[0]!;
    expect(r.probe.events[0]!.input.payload).toMatchObject({ specimen_id: sp(s).id, order_id: s.orderId, from_status: 'rejected', to_status: 'recollection_ordered', changed_at: iso(NOW) });
    expect(r.probe.events[0]!.input).toMatchObject({ aggregate: { type: 'specimen', id: sp(s).id }, idempotencyKey: `${sp(s).id}:recollection_ordered:3` });
    expect(r.probe.events[1]!.input.payload).toMatchObject({ specimen_id: n.id, to_status: 'ordered', specimen_type_code: 'WB' });
    expect(r.probe.events[1]!.input.payload.from_status).toBeUndefined();
    expect(r.probe.events[1]!.input).toMatchObject({ idempotencyKey: `${n.id}:ordered:1` });
    for (const e of r.probe.events) for (const k of Object.keys(e.input.payload)) expect(keysOf(STATUS_EVENT).has(k), `payload key ${k}`).toBe(true);
    expect(JSON.stringify(r.probe.events)).not.toContain('SECRET-COMMENT');
  });

  it('AC-05.7: after the late recollection the old barcode still resolves to the old specimen only', async () => {
    const { s } = await rejectedWithoutRecollection();
    const r = await recollect(s, {}, 0, 2);
    expect((await lookup(sp(s).barcode)).body).toMatchObject({ id: sp(s).id, status: 'recollection_ordered' });
    expect((await lookup(r.body.recollection_specimen.barcode)).body).toMatchObject({ id: r.body.recollection_specimen.id });
  });

  it('only the tests cancelled with specimen_rejected are re-opened: a test C4 removed (cancel_reason item_removed) stays cancelled on the old specimen and gets no new row', async () => {
    // C5.T-08 ruling: cancelled result rows are frozen (05-SCHEMA.md:583,1283), so seed the C4 removal BEFORE the reject; the reject skips it.
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    const [kept, removed] = sp(s).tests as [Tst, Tst];
    await write("UPDATE lab.results SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'item_removed' WHERE order_test_id = $1", [removed.orderTestId]);
    await write("UPDATE lab.order_tests SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'item_removed' WHERE id = $1", [removed.orderTestId]);
    await reject(s, { reason_code: REASON, recollection_required: false });
    const removedBefore = [await orderTestRow(removed.orderTestId), await resultsOfTest(removed.orderTestId)];
    const r = await recollect(s, {}, 0, 2);
    expect(r.status).toBe(200);
    const n = (await replacementsOf(sp(s).id))[0]!;
    expect(await orderTestRow(kept.orderTestId)).toMatchObject({ specimen_id: n.id, status: 'awaiting_collection', cancel_reason: null });
    expect([await orderTestRow(removed.orderTestId), await resultsOfTest(removed.orderTestId)]).toEqual(removedBefore);
  });

  it('S12 guard: no order test left cancelled with specimen_rejected (all removed by C4) -> 409 lab.specimen_invalid_transition, nothing written', async () => {
    const { s } = await rejectedWithoutRecollection({ status: 'received', tests: 1 });
    await write("UPDATE lab.order_tests SET cancel_reason = 'item_removed' WHERE order_id = $1", [s.orderId]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(recollect(s, {}, 0, 2)), 'lab.specimen_invalid_transition', 409);
    expect(await orderSnap(s.orderId)).toBe(before);
  });

  it('at most one recollection per rejected specimen: a second recollect is a 409 (specimen is recollection_ordered) and creates no second specimen', async () => {
    const { s } = await rejectedWithoutRecollection();
    await recollect(s, {}, 0, 2);
    expectCode(await failure(recollect(s, {}, 0, 3)), 'lab.specimen_invalid_transition', 409);
    expect(await replacementsOf(sp(s).id)).toHaveLength(1);
  });

  it('a recollection requested after reject WITH recollection is a 409 as well (already recollection_ordered)', async () => {
    const s = await scenario(A, [{ status: 'received' }]);
    await reject(s);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(recollect(s, {}, 0, 3)), 'lab.specimen_invalid_transition', 409);
    expect(await orderSnap(s.orderId)).toBe(before);
  });

  it.each(['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'stored', 'discarded'])('a %s specimen -> 409 lab.specimen_invalid_transition (S12 is from rejected only), nothing written', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(recollect(s)), 'lab.specimen_invalid_transition', 409);
    expect(await orderSnap(s.orderId)).toBe(before);
  });

  it('400 common.validation_failed for a body with any key (the body is `{}`)', async () => {
    const { s } = await rejectedWithoutRecollection();
    const before = await orderSnap(s.orderId);
    expectCode(await failure(call('requestRecollection', req({ params: { specimen_id: sp(s).id }, headers: ifm(2), body: { reason_code: REASON } }))), 'common.validation_failed', 400);
    expect(await orderSnap(s.orderId)).toBe(before);
  });

  it('one-tx semantics: a failure while publishing the last event rolls back specimen, new specimen, re-opened order tests and new results', async () => {
    const { s } = await rejectedWithoutRecollection();
    const before = await orderSnap(s.orderId);
    await failure(call('requestRecollection', req({ params: { specimen_id: sp(s).id }, headers: ifm(2), body: {} }), { failPublishOf: 'lab.specimen.status_changed.v1' }));
    expect(await orderSnap(s.orderId)).toBe(before);
    expect(await replacementsOf(sp(s).id)).toHaveLength(0);
  });

  it('race: 5 concurrent recollects with the same If-Match -> exactly one 200 and exactly one replacement specimen with one set of new result rows', async () => {
    const { s } = await rejectedWithoutRecollection({ status: 'received', tests: 2 });
    const out = await Promise.allSettled(Array.from({ length: 5 }, () => recollect(s, {}, 0, 2)));
    expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of out) if (x.status === 'rejected') { expect(['common.version_conflict', 'lab.specimen_invalid_transition']).toContain(x.reason.code); expect(x.reason.statusCode).toBe(409); }
    expect(await replacementsOf(sp(s).id)).toHaveLength(1);
    expect((await sql('SELECT count(*)::int AS n FROM lab.results WHERE order_id = $1 AND status = $2', [s.orderId, 'pending']))[0].n).toBe(2);
  });
});

// ================================================================== #11 createAliquots (AC-06.1 - AC-06.3; S5; D-13)
describe.skipIf(!live)('T-08 createAliquots (AC-06.1 - AC-06.3; S5)', () => {
  const ids = (s: Scen, ...idx: number[]) => idx.map((i) => sp(s).tests[i]!.testId);

  it('AC-06.1: 2 aliquots with test assignments -> 2 children (parent_specimen_id, own barcodes, status received, copied processing centre/branch), parent received -> aliquoted (S5), assigned results move to the aliquots', async () => {
    const s = await scenario(A, [{ status: 'received', processing: CENTRE_A2, tests: 3 }]);
    const p = sp(s);
    const r = await aliquot(s, { aliquots: [{ specimen_type_code: 'SER', test_ids: ids(s, 0) }, { test_ids: ids(s, 1) }] }, { scope: { all: false, centreIds: [CENTRE[A], CENTRE_A2] } });
    expect(r.status).toBe(200);
    expect(schemaErrors('AliquotsResponse', r.body)).toEqual([]);
    for (const d of [r.body.parent, ...r.body.aliquots]) for (const k of Object.keys(d)) expect(DTO_KEYS.has(k), `non-allowlisted key ${k}`).toBe(true);
    expect(r.body.parent).toMatchObject({ id: p.id, status: 'aliquoted', version: 2, barcode: p.barcode });
    expect(await specimenRow(p.id)).toMatchObject({ status: 'aliquoted', version: 2 });
    expect((await transitionsOf(p.id)).map((x) => [x.transition_code, x.from_status, x.to_status, x.specimen_version])).toEqual([['S5', 'received', 'aliquoted', 2]]);
    const kids = await childrenOf(p.id);
    expect(kids).toHaveLength(2);
    expect(r.body.aliquots).toHaveLength(2);
    expect(r.body.aliquots.map((x: any) => x.id).sort()).toEqual(kids.map((k) => k.id).sort());
    const barcodes = new Set([p.barcode, ...kids.map((k) => k.barcode)]);
    expect(barcodes.size).toBe(3);                                                              // own, unique barcodes
    for (const k of kids) {
      expect(k).toMatchObject({ status: 'received', version: 1, parent_specimen_id: p.id, replaces_specimen_id: null, order_id: s.orderId, patient_id: PATIENT[A], centre_id: CENTRE[A], priority: 'routine',
        processing_centre_id: CENTRE_A2, processing_branch_id: BRANCH_A2, is_active: true });
      expect(k.barcode).toMatch(/^[A-Z0-9]{1,20}$/);
      expect((await transitionsOf(k.id)).map((x) => [x.transition_code, x.from_status, x.to_status, x.specimen_version])).toEqual([['S5', null, 'received', 1]]);
    }
    const [k1, k2] = r.body.aliquots as any[];
    expect(k1.specimen_type_code).toBe('SER');                                                 // requested type; the second defaults to the parent's
    expect(k2.specimen_type_code).toBe('WB');
    expect(k1.tests.map((x: any) => x.test_id)).toEqual(ids(s, 0));
    expect(k2.tests.map((x: any) => x.test_id)).toEqual(ids(s, 1));
    // results of the assigned tests move (same rows, new specimen_id — "results re-pointed", no new rows); the unassigned test stays on the parent
    expect((await resultRow(p.tests[0]!.resultIds[0]!)).specimen_id).toBe(k1.id);
    expect((await resultRow(p.tests[1]!.resultIds[0]!)).specimen_id).toBe(k2.id);
    expect((await resultRow(p.tests[2]!.resultIds[0]!)).specimen_id).toBe(p.id);
    expect(await resultsOfTest(p.tests[0]!.orderTestId)).toHaveLength(1);
    expect((await resultRow(p.tests[0]!.resultIds[0]!))).toMatchObject({ status: 'pending', version: expect.any(Number) });
    // events: parent status_changed first, then one (absent -> received) per aliquot in request order
    expect(r.probe.events.map((e) => e.type)).toEqual(Array(3).fill('lab.specimen.status_changed.v1'));
    expect(r.probe.events[0]!.input).toMatchObject({ aggregate: { type: 'specimen', id: p.id }, idempotencyKey: `${p.id}:aliquoted:2` });
    expect(r.probe.events[0]!.input.payload).toMatchObject({ specimen_id: p.id, order_id: s.orderId, from_status: 'received', to_status: 'aliquoted', changed_at: iso(NOW) });
    for (const [i, k] of [k1, k2].entries()) {
      const e = r.probe.events[i + 1]!;
      expect(e.input).toMatchObject({ aggregate: { type: 'specimen', id: k.id }, idempotencyKey: `${k.id}:received:1` });
      expect(e.input.payload).toMatchObject({ specimen_id: k.id, order_id: s.orderId, patient_id: PATIENT[A], centre_id: CENTRE[A], to_status: 'received', changed_at: iso(NOW) });
      expect(e.input.payload.from_status).toBeUndefined();
    }
    for (const e of r.probe.events) for (const k of Object.keys(e.input.payload)) expect(keysOf(STATUS_EVENT).has(k), `payload key ${k}`).toBe(true);
    expect(r.probe.roleCalls.map((c) => c.permission)).toContain(P.receive);
  });

  it('a test with several analytes: all of its results move to the aliquot', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2, analytes: 3 }]);
    const r = await aliquot(s, { aliquots: [{ test_ids: ids(s, 0) }] });
    const kid = r.body.aliquots[0].id;
    for (const rid of sp(s).tests[0]!.resultIds) expect((await resultRow(rid)).specimen_id).toBe(kid);
    for (const rid of sp(s).tests[1]!.resultIds) expect((await resultRow(rid)).specimen_id).toBe(sp(s).id);
  });

  it('AC-06.3: when every result moved to aliquots the parent stays `aliquoted` — no roll-up, no further transition or event — until stored / discarded', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    const r = await aliquot(s, { aliquots: [{ test_ids: ids(s, 0) }, { test_ids: ids(s, 1) }] });
    expect(r.status).toBe(200);
    for (const t of sp(s).tests) expect((await resultRow(t.resultIds[0]!)).specimen_id).not.toBe(sp(s).id);
    expect((await specimenRow(sp(s).id)).status).toBe('aliquoted');
    expect(await transitionsOf(sp(s).id)).toHaveLength(1);
    expect(statusEvents(r.probe).filter((e) => e.input.payload.specimen_id === sp(s).id)).toHaveLength(1);
    const st = await call('storeSpecimen', req({ params: { specimen_id: sp(s).id }, headers: ifm(2), body: { location: 'Rack 7 (SYNTHETIC)' } }));
    expect(st.body).toMatchObject({ status: 'stored' });
  });

  it('AC-06.2: a test that is not on the parent -> 400 common.validation_failed, nothing written (08 A13 P-1)', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    const before = await orderSnap(s.orderId);
    const e = await failure(aliquot(s, { aliquots: [{ test_ids: [...ids(s, 0), u(0xbeef01)] }] }));
    expectCode(e, 'common.validation_failed', 400);
    expect(e.errors?.length ?? 0).toBeGreaterThan(0);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('a test of another specimen of the same order, and a test of another tenant (07-SECURITY P-07) -> 400, nothing written in either tenant', async () => {
    const s = await scenario(A, [{ status: 'received' }, { status: 'received' }]);
    const other = await scenario(B, [{ status: 'received' }]);
    const before = [await orderSnap(s.orderId), await orderSnap(other.orderId)];
    expectCode(await failure(aliquot(s, { aliquots: [{ test_ids: [sp(s, 1).tests[0]!.testId] }] })), 'common.validation_failed', 400);
    expectCode(await failure(aliquot(s, { aliquots: [{ test_ids: [sp(other).tests[0]!.testId] }] })), 'common.validation_failed', 400);
    expect([await orderSnap(s.orderId), await orderSnap(other.orderId)]).toEqual(before);
  });
  it('S5 guard: a test whose results are all cancelled or approved cannot be aliquoted -> 400; a request that lists it next to valid tests fails as a whole', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 3 }]);
    const [t0, t1, t2] = sp(s).tests as [Tst, Tst, Tst];
    await write("UPDATE lab.results SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'item_removed' WHERE order_test_id = $1", [t1.orderTestId]);
    await write("UPDATE lab.order_tests SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'item_removed' WHERE id = $1", [t1.orderTestId]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(aliquot(s, { aliquots: [{ test_ids: [t1.testId] }] })), 'common.validation_failed', 400);
    expectCode(await failure(aliquot(s, { aliquots: [{ test_ids: [t0.testId, t1.testId] }, { test_ids: [t2.testId] }] })), 'common.validation_failed', 400);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('the same test in two aliquots of one request -> 400 (a result can move to one aliquot only), nothing written', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(aliquot(s, { aliquots: [{ test_ids: ids(s, 0) }, { test_ids: ids(s, 0, 1) }] })), 'common.validation_failed', 400);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('limits: 10 aliquots are accepted; 11, 0, an empty test_ids, a non-uuid id, a bad specimen_type_code, an unknown aliquot key and a missing `aliquots` -> 400, nothing written', async () => {
    const big = await scenario(A, [{ status: 'received', tests: 11 }]);
    const before = await orderSnap(big.orderId);
    const one = (i: number) => ({ test_ids: [sp(big).tests[i]!.testId] });
    expectCode(await failure(aliquot(big, { aliquots: Array.from({ length: 11 }, (_, i) => one(i)) })), 'common.validation_failed', 400);
    expectCode(await failure(aliquot(big, { aliquots: [] })), 'common.validation_failed', 400);
    expectCode(await failure(aliquot(big, { aliquots: [{ test_ids: [] }] })), 'common.validation_failed', 400);
    expectCode(await failure(aliquot(big, { aliquots: [{ test_ids: ['not-a-uuid'] }] })), 'common.validation_failed', 400);
    expectCode(await failure(aliquot(big, { aliquots: [{ ...one(0), specimen_type_code: 'bad code!' }] })), 'common.validation_failed', 400);
    expectCode(await failure(aliquot(big, { aliquots: [{ ...one(0), barcode: 'X1' }] })), 'common.validation_failed', 400);
    expectCode(await failure(aliquot(big, { aliquots: [{ ...one(0), tenant_id: B }] })), 'common.validation_failed', 400);
    expectCode(await failure(aliquot(big, {})), 'common.validation_failed', 400);
    expectCode(await failure(aliquot(big, { aliquots: 'x' })), 'common.validation_failed', 400);
    expect(await orderSnap(big.orderId)).toBe(before);
    const ok = await aliquot(big, { aliquots: Array.from({ length: 10 }, (_, i) => one(i)) });
    expect(ok.status).toBe(200);
    expect(ok.body.aliquots).toHaveLength(10);
    expect(new Set(ok.body.aliquots.map((x: any) => x.barcode)).size).toBe(10);
  });
  it.each(['ordered', 'collected', 'in_transit', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'rejected', 'recollection_ordered', 'stored', 'discarded'])('a %s specimen -> 409 lab.specimen_invalid_transition (S5 is from received only), nothing written', async (from) => {
    const s = await scenario(A, [{ status: from }]);
    const before = await orderSnap(s.orderId);
    expectCode(await failure(aliquot(s, { aliquots: [{ test_ids: ids(s, 0) }] })), 'lab.specimen_invalid_transition', 409);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('a second aliquot request on an aliquoted parent -> 409 (no second S5), the first aliquots are untouched', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    await aliquot(s, { aliquots: [{ test_ids: ids(s, 0) }] });
    const before = await orderSnap(s.orderId);
    expectCode(await failure(aliquot(s, { aliquots: [{ test_ids: ids(s, 1) }] }, {}, 0, 2)), 'lab.specimen_invalid_transition', 409);
    expect(await orderSnap(s.orderId)).toBe(before);
  });
  it('one-tx semantics: a failure while publishing the last event rolls back the parent transition, the children and the moved results', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    const before = await orderSnap(s.orderId);
    await failure(aliquot(s, { aliquots: [{ test_ids: ids(s, 0) }, { test_ids: ids(s, 1) }] }, { failPublishOf: 'lab.specimen.status_changed.v1' }));
    expect(await orderSnap(s.orderId)).toBe(before);
    expect(await childrenOf(sp(s).id)).toHaveLength(0);
  });
  it('race: 4 concurrent aliquot requests with the same If-Match -> exactly one 200, one set of children, one S5 on the parent', async () => {
    const s = await scenario(A, [{ status: 'received', tests: 2 }]);
    const out = await Promise.allSettled(Array.from({ length: 4 }, () => aliquot(s, { aliquots: [{ test_ids: ids(s, 0) }, { test_ids: ids(s, 1) }] })));
    expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of out) if (x.status === 'rejected') { expect(['common.version_conflict', 'lab.specimen_invalid_transition']).toContain(x.reason.code); expect(x.reason.statusCode).toBe(409); }
    expect(await childrenOf(sp(s).id)).toHaveLength(2);
    expect(await transitionsOf(sp(s).id)).toHaveLength(1);
  });
});
