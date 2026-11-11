// C5 T-06 — order consumers' service layer against the migrated database (06 row T-06; 02-TRD §4.1, §7.2; PRD AC-01.1–AC-01.8; 03-APP-FLOW E2/E3; 07-SECURITY P-11, REQ-SEC-024).
// Needs the migrated+seeded database that tests/db/c5-t03/run.sh starts (LIMS_T03_CMD hook, see .orchestra/notes/C5.T-06-verify.cmd):
//   LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under
//   LIMS_T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
//
// SEAMS (spec fixes behaviour, not names) — the writer implements ../order.service.ts exporting
//   applyOrderCreated(ctx, envelope) / applyOrderItemsChanged(ctx, envelope) / applyOrderCancelled(ctx, envelope): Promise<void>
//   envelope = the frontdesk.order.* event envelope: { event_id, event_type, tenant_id, aggregate: { type: 'order', id, seq }, payload (contract shape, snake_case) }.
//   ctx = LabCtx of ./specimen.service.ts (tenantId, actor, tx, now(): Date, ports.IdentityPort) + ports.FrontdeskPort + ports.CatalogPort (contracts/ports, camelCase)
//         + events: { publish(ctx, type, { aggregate: { type, id, seq }, idempotencyKey, payload }): Promise<{ eventId, duplicate }> }  (same shape as events/publish.ts takes).
//   Runs in the caller's transaction (ctx.tx = the job transaction, claims set): any throw means the caller rolls everything back (retry / dead letter).
//   The tenant is ctx.tenantId only (REQ-SEC-024); inbox dedupe (02-CV §7.4) is the worker wrapper's (core/consumer.ts), so the service must additionally be
//   idempotent for a re-applied event (creation_key / (order_item_id,test_id) / results (order_test_id,analyte_id) uniqueness).
// ASSUMED (spec silent): getOrderSummary / getPatientDemographics are called with the ctx object; `lab.orders.last_order_seq` = envelope.aggregate.seq;
//   a `created` with aggregate.seq lower than last_order_seq creates no items/specimens; a late `created` still fills collection_mode (schema comment of lab.orders.collection_mode).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError, LimsError } from '../../../../core/errors.js';
import { applyOrderCancelled, applyOrderCreated, applyOrderItemsChanged } from '../order.service.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const mem = '01a1a98a-ac40-7000-8000-00000000a500';
const BRANCH = { [A]: '01a1a98a-ac40-7000-8000-00000000a101', [B]: '01a1a98a-ac40-7000-8000-00000000b101' } as Record<string, string>;
const CENTRE = { [A]: '01a1a98a-ac40-7000-8000-00000000a201', [B]: '01a1a98a-ac40-7000-8000-00000000b201' } as Record<string, string>;
const u = (n: number) => `0190c606-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PATIENT = { [A]: u(0xa1), [B]: u(0xb1) } as Record<string, string>;
const REGISTERED_AT = '2026-06-15T05:00:00.000Z';
const NOW = new Date('2026-06-15T05:00:30Z');
const CATALOG_REVISION = 7;

// ------------------------------------------------------------------ synthetic catalog (CatalogPort shape)
const D = { hema: u(0x901), chem: u(0x902), path: u(0x903) };
const an = (n: number, code: string, reportable: boolean, extra: Record<string, unknown> = {}) =>
  ({ id: u(0x500 + n), code, name: `${code} (SYNTHETIC)`, resultType: 'numeric', reportable, sortOrder: n, ...extra });
const TESTS: Record<string, any> = {
  cbc: { id: u(0x301), code: 'CBC', name: 'CBC', departmentId: D.hema, departmentCode: 'HEMA', specimenTypeCodes: ['WB'], containerCode: 'EDTA', workflowType: 'standard',
    tatTargetSeconds: { routine: 7200, urgent: 3600 }, isActive: true, revision: 4,
    analytes: [an(1, 'HB', true), an(2, 'WBC', true), an(3, 'RBC', false), an(4, 'HCT', false),
      an(5, 'MCV', true, { formula: { expression: 'HCT/RBC*10', inputAnalyteCodes: ['HCT', 'RBC'] } }), an(6, 'NOISE', false)] },
  glu: { id: u(0x302), code: 'GLU', name: 'Glucose', departmentId: D.chem, departmentCode: 'CHEM', specimenTypeCodes: ['SERUM'], workflowType: 'standard',
    tatTargetSeconds: { routine: 5400 }, isActive: true, revision: 2, analytes: [an(7, 'GLU', true)] },
  narr: { id: u(0x303), code: 'HPE', name: 'Narrative', departmentId: D.path, departmentCode: 'PATH', specimenTypeCodes: ['TISSUE'], workflowType: 'narrative', isActive: true, revision: 1,
    analytes: [an(8, 'NARR', true, { resultType: 'narrative' })] },
  ihc: { id: u(0x304), code: 'IHC', name: 'IHC add-on', departmentId: D.path, departmentCode: 'PATH', specimenTypeCodes: [], workflowType: 'anatomic', usesExistingMaterial: true,
    isActive: true, revision: 3, analytes: [an(9, 'IHC1', true)] },
  out: { id: u(0x305), code: 'SEND', name: 'Send-out', departmentId: D.chem, departmentCode: 'CHEM', specimenTypeCodes: [], workflowType: 'outsourced', isActive: true, revision: 1,
    analytes: [an(10, 'SEND1', true)] },
  esr: { id: u(0x306), code: 'ESR', name: 'ESR', departmentId: D.hema, departmentCode: 'HEMA', specimenTypeCodes: ['WB'], containerCode: 'EDTA', workflowType: 'standard',
    tatTargetSeconds: { routine: 7200, urgent: 3600 }, isActive: true, revision: 5, analytes: [an(11, 'ESR1', true)] },
  urine: { id: u(0x307), code: 'UR', name: 'Urinalysis', departmentId: D.chem, departmentCode: 'CHEM', specimenTypeCodes: ['URINE'], workflowType: 'standard',
    tatTargetSeconds: { routine: 3600 }, isActive: true, revision: 1, analytes: [an(12, 'UCOL', true)] },
};
const ITEM_KEYS = Object.keys(TESTS);
const orderableOf = (k: string) => u(0x400 + ITEM_KEYS.indexOf(k));
const testByOrderable = new Map(ITEM_KEYS.map((k) => [orderableOf(k), k]));

function resolveOrderables(_ctx: unknown, input: { orderableIds: readonly string[]; asOf?: string }) {
  const keys = [...new Set(input.orderableIds.map((o) => testByOrderable.get(o)!))];
  const groups = new Map<string, { specimenTypeCode: string; containerCode?: string; testIds: string[] }>();
  for (const k of keys) {
    const t = TESTS[k];
    if (t.usesExistingMaterial || t.workflowType === 'outsourced') continue;
    const g = `${t.specimenTypeCodes[0]}|${t.containerCode ?? ''}`;
    if (!groups.has(g)) groups.set(g, { specimenTypeCode: t.specimenTypeCodes[0], ...(t.containerCode ? { containerCode: t.containerCode } : {}), testIds: [] });
    groups.get(g)!.testIds.push(t.id);
  }
  return Promise.resolve({
    orderables: input.orderableIds.map((o) => ({ orderableId: o, kind: 'test', testIds: [TESTS[testByOrderable.get(o)!].id] })),
    tests: keys.map((k) => TESTS[k]), specimenRequirements: [...groups.values()], catalogRevision: CATALOG_REVISION,
  });
}

// ------------------------------------------------------------------ database helpers
let api: pg.Pool;
let admin: pg.Pool;
const claims = (tenantId: string) => JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' });
const sql = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;
const colsCache = new Map<string, Set<string>>();

/** Superuser write with the system actor's claims set so the C0 audit triggers have a context (same technique as tests/db/c5-t03/fixtures.sql). */
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
  await c.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => (r[k] !== null && typeof r[k] === 'object' && !Array.isArray(r[k]) ? JSON.stringify(r[k]) : r[k])));
}

interface Order { orderId: string; tenant: string; regNo: string; items: Record<string, string> }
let nextId = 0x1000;
/** frontdesk.orders + frontdesk.order_items (the FK parents of lab.orders / lab.order_tests); one item per catalog test key. */
async function seedFrontdeskOrder(tenant: string): Promise<Order> {
  const orderId = u(nextId++);
  const regNo = `R-T06-${orderId.slice(-4)}`;
  const items: Record<string, string> = Object.fromEntries(ITEM_KEYS.map((k) => [k, u(nextId++)]));
  await asAdmin(tenant, async (c) => {
    await ins(c, 'frontdesk.orders', { id: orderId, tenant_id: tenant, branch_id: BRANCH[tenant], centre_id: CENTRE[tenant], patient_id: PATIENT[tenant], registration_no: regNo, status: 'registered',
      visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk', is_first_order_of_patient: false, catalog_revision: 1, registered_at: REGISTERED_AT });
    for (const k of ITEM_KEYS) {
      await ins(c, 'frontdesk.order_items', { id: items[k], tenant_id: tenant, order_id: orderId, centre_id: CENTRE[tenant], orderable_id: orderableOf(k), orderable_kind: 'test', code: TESTS[k].code,
        name: `${TESTS[k].code} (SYNTHETIC)`, test_ids: [TESTS[k].id], priority: 'routine', unit_price_paisa: 1000, price_list_id: u(0x98), price_list_version: 1, price_source: 'tenant_default',
        vat_treatment: 'exempt', added_in_items_version: 1 });
    }
  });
  return { orderId, tenant, regNo, items };
}

// ------------------------------------------------------------------ ports, ctx, envelopes
type Pub = { type: string; input: any };
interface Rig { summaries: Map<string, any>; demographics: any; numbering: any; calls: { summary: any[]; demo: any[]; resolve: any[] }; events: Pub[] }
const rig = (o: Partial<Rig> = {}): Rig => ({ summaries: new Map(), demographics: { sex: 'female', ageAtOrder: { years: 30, months: 6, days: 10 } }, numbering: { barcodePrefix: 'E' },
  calls: { summary: [], demo: [], resolve: [] }, events: [], ...o });

const itemPayload = (order: Order, key: string, priority: 'routine' | 'urgent' = 'routine', extra: Record<string, unknown> = {}) =>
  ({ order_item_id: order.items[key], orderable_id: orderableOf(key), orderable_kind: 'test', test_ids: [TESTS[key].id], priority, ...extra });
const summaryOf = (order: Order, keys: string[], extra: Record<string, unknown> = {}) => ({
  orderId: order.orderId, registrationNo: order.regNo, patientId: PATIENT[order.tenant], branchId: BRANCH[order.tenant], centreId: CENTRE[order.tenant], visitType: 'opd', billingMode: 'cash',
  priority: 'routine', status: 'registered', source: 'front_desk', registeredAt: REGISTERED_AT, version: 1,
  items: keys.map((k) => ({ orderItemId: order.items[k], orderableId: orderableOf(k), orderableKind: 'test', testIds: [TESTS[k].id], priority: 'routine', status: 'active', outsourced: false })), ...extra });

let evN = 0;
const env = (order: Order, type: string, seq: number, payload: Record<string, unknown>, eventId = u(0x7000 + evN++)) =>
  ({ event_id: eventId, event_type: type, tenant_id: order.tenant, producer: 'frontdesk', aggregate: { type: 'order', id: order.orderId, seq }, occurred_at: REGISTERED_AT, payload });
const createdEnv = (order: Order, keys: string[], seq = 1, o: { eventId?: string; priorities?: Record<string, 'urgent'>; extra?: Record<string, unknown>; outsourced?: string[] } = {}) =>
  env(order, 'frontdesk.order.created.v1', seq, {
    order_id: order.orderId, patient_id: PATIENT[order.tenant], branch_id: BRANCH[order.tenant], centre_id: CENTRE[order.tenant], visit_type: 'opd', billing_mode: 'cash', priority: 'routine',
    collection_mode: 'walk_in', source: 'front_desk', registered_at: REGISTERED_AT,
    items: keys.map((k) => itemPayload(order, k, o.priorities?.[k] ?? 'routine', o.outsourced?.includes(k) ? { outsourced: true } : {})), ...(o.extra ?? {}) }, o.eventId);
const changedEnv = (order: Order, version: number, added: { key: string; priority?: 'urgent' | 'routine' }[], removed: string[], seq = version, eventId?: string) =>
  env(order, 'frontdesk.order.items_changed.v1', seq, { order_id: order.orderId, items_version: version, added: added.map((a) => itemPayload(order, a.key, a.priority ?? 'routine')),
    removed: removed.map((k) => ({ order_item_id: order.items[k], reason_code: 'entered_in_error' })), changed_at: REGISTERED_AT }, eventId);
const cancelledEnv = (order: Order, seq = 9, eventId?: string) =>
  env(order, 'frontdesk.order.cancelled.v1', seq, { order_id: order.orderId, reason_code: 'patient_request', cancelled_at: '2026-06-15T06:00:00.000Z', requires_credit_note: false }, eventId);

/** One job-shaped transaction (claims transaction-local, lims_api + RLS); COMMIT on success, ROLLBACK on throw. */
async function run(tenant: string, r: Rig, fn: (ctx: any) => Promise<void>): Promise<void> {
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const ctx = {
      tenantId: tenant, actor: { type: 'system', id: SYS }, tx: client, now: () => NOW,
      events: { publish: async (_c: unknown, type: string, input: unknown) => { r.events.push({ type, input }); return { eventId: u(0x8000 + r.events.length), duplicate: false }; } },
      ports: {
        IdentityPort: { getTenantSettings: async () => ({ numbering: r.numbering }) },
        FrontdeskPort: {
          getOrderSummary: async (_c: unknown, input: { orderId: string }) => { r.calls.summary.push(input); const s = r.summaries.get(input.orderId); if (!s) throw new LimsError('common.not_found'); return s; },
          getPatientDemographics: async (_c: unknown, input: unknown) => { r.calls.demo.push(input); return { patientId: PATIENT[tenant], patientCode: 'P-T06', status: 'active', consents: {}, ...r.demographics }; },
        },
        CatalogPort: { resolveOrderables: async (c: unknown, input: any) => { r.calls.resolve.push(input); return resolveOrderables(c, input); } },
      },
    };
    await fn(ctx);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}
const apply = (tenant: string, r: Rig, which: 'created' | 'changed' | 'cancelled', e: any) =>
  run(tenant, r, (ctx) => (which === 'created' ? applyOrderCreated : which === 'changed' ? applyOrderItemsChanged : applyOrderCancelled)(ctx, e as never));
const failure = async (p: Promise<unknown>): Promise<unknown> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

const orderRow = async (id: string) => (await sql('SELECT * FROM lab.orders WHERE id = $1', [id]))[0];
const specimensOf = (id: string) => sql('SELECT * FROM lab.specimens WHERE order_id = $1 ORDER BY creation_key', [id]);
const orderTestsOf = (id: string) => sql('SELECT * FROM lab.order_tests WHERE order_id = $1 ORDER BY test_code', [id]);
const resultsOf = (id: string) => sql('SELECT * FROM lab.results WHERE order_id = $1 ORDER BY analyte_code', [id]);
const counterOf = async (tenant: string) => { const r = await sql('SELECT last_value FROM lab.barcode_counters WHERE tenant_id = $1', [tenant]); return r[0] ? Number(r[0]['last_value']) : 0; };
const statusEvents = (r: Rig) => r.events.filter((e) => e.type === 'lab.specimen.status_changed.v1');
const daysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 10 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await asAdmin(t, (c) => ins(c, 'frontdesk.patients', { id: PATIENT[t], tenant_id: t, patient_code: 'P-T06', full_name: 'Test Patient T06', name_search: 'test patient t06',
    sex: 'female', registered_centre_id: CENTRE[t] }));
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-06 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

describe.skipIf(!live)('T-06 order.created (AC-01.1, AC-01.5, AC-01.5b, AC-01.6; 02-TRD §4.1)', () => {
  let order: Order;
  const r = rig();
  const e = () => createdEnv(order, ['cbc', 'glu', 'narr', 'ihc', 'out'], 1, { outsourced: ['out'] });
  beforeAll(async () => { order = await seedFrontdeskOrder(A); r.summaries.set(order.orderId, summaryOf(order, ['cbc', 'glu', 'narr', 'ihc', 'out'])); await apply(A, r, 'created', e()); }, 60_000);

  it('step 1-2: lab.orders row from the payload + registration_no (getOrderSummary) + sex/age snapshot (getPatientDemographics purpose result_evaluation)', async () => {
    const o = await orderRow(order.orderId);
    expect(o).toMatchObject({ tenant_id: A, centre_id: CENTRE[A], branch_id: BRANCH[A], patient_id: PATIENT[A], registration_no: order.regNo, visit_type: 'opd', priority: 'routine',
      collection_mode: 'walk_in', source: 'front_desk', lab_status: 'active', last_order_seq: 1, items_version: 1, patient_sex: 'female', patient_age_days: 30 * 365 + 6 * 30 + 10 });
    expect(new Date(o.registered_at).toISOString()).toBe(REGISTERED_AT);
    expect(r.calls.summary).toEqual([{ orderId: order.orderId }]);
    expect(r.calls.demo).toEqual([{ patientId: PATIENT[A], purpose: 'result_evaluation' }]);
  });

  it('step 3: CatalogPort.resolveOrderables once, with the items\' orderable ids and asOf = registered_at; order_tests snapshot test_revision/catalog_revision', async () => {
    expect(r.calls.resolve).toHaveLength(1);
    expect([...r.calls.resolve[0].orderableIds].sort()).toEqual(['cbc', 'glu', 'narr', 'ihc', 'out'].map(orderableOf).sort());
    expect(new Date(r.calls.resolve[0].asOf).toISOString()).toBe(REGISTERED_AT);
    const cbc = (await orderTestsOf(order.orderId)).find((t) => t.test_code === 'CBC');
    expect(cbc).toMatchObject({ test_revision: 4, catalog_revision: CATALOG_REVISION, department_id: D.hema, workflow_type: 'standard', priority: 'routine', tat_target_seconds: 7200,
      centre_id: CENTRE[A], order_item_id: order.items['cbc'], test_id: TESTS['cbc'].id, status: 'awaiting_collection', uses_existing_material: false });
  });

  it('AC-01.1: exactly two specimens (WB/EDTA, SERUM), status ordered, creation_key per 02-TRD §4.1, barcode from the numbering pattern (E + yy + 8 digits)', async () => {
    const s = await specimensOf(order.orderId);
    expect(s).toHaveLength(2);
    expect(s.map((x) => x.creation_key).sort()).toEqual([`${order.orderId}:SERUM:-`, `${order.orderId}:WB:EDTA`]);
    for (const x of s) {
      expect(x).toMatchObject({ status: 'ordered', is_active: true, patient_id: PATIENT[A], centre_id: CENTRE[A], priority: 'routine', patient_sex: 'female', patient_age_days: 11140 });
      expect(x.barcode).toMatch(/^E26\d{8}$/);
    }
    expect(new Set(s.map((x) => x.barcode)).size).toBe(2);
    const wb = s.find((x) => x.specimen_type_code === 'WB')!;
    expect(wb.container_code).toBe('EDTA');
    expect(s.find((x) => x.specimen_type_code === 'SERUM')!.container_code).toBeNull();
  });

  it('AC-01.1: two lab.specimen.status_changed.v1 events, from_status absent, to_status ordered, one per specimen, aggregate specimen', async () => {
    const ev = statusEvents(r);
    expect(ev).toHaveLength(2);
    const s = await specimensOf(order.orderId);
    for (const x of s) {
      const m = ev.find((p) => p.input.payload.specimen_id === x.id)!;
      expect(m).toBeDefined();
      expect(m.input.payload).toMatchObject({ order_id: order.orderId, patient_id: PATIENT[A], centre_id: CENTRE[A], specimen_type_code: x.specimen_type_code, to_status: 'ordered' });
      expect('from_status' in m.input.payload).toBe(false);
      expect(m.input.aggregate).toMatchObject({ type: 'specimen', id: x.id });
    }
    expect(r.events.filter((p) => p.type !== 'lab.specimen.status_changed.v1')).toEqual([]);
  });

  it('AC-01.5: the narrative item is recorded as excluded in lab.order_tests; no specimen (its TISSUE requirement is excluded-only) and no result row for it', async () => {
    const t = (await orderTestsOf(order.orderId)).find((x) => x.test_code === 'HPE')!;
    expect(t).toMatchObject({ status: 'excluded', specimen_id: null, workflow_type: 'narrative' });
    expect((await specimensOf(order.orderId)).some((x) => x.specimen_type_code === 'TISSUE')).toBe(false);
    expect((await resultsOf(order.orderId)).filter((x) => x.test_id === TESTS['narr'].id)).toEqual([]);
  });

  it('AC-01.5b: usesExistingMaterial test has an in_process order_tests row (uses_existing_material, specimen_id NULL, no processing centre yet) and a pending result with specimen_id NULL', async () => {
    const t = (await orderTestsOf(order.orderId)).find((x) => x.test_code === 'IHC')!;
    expect(t).toMatchObject({ uses_existing_material: true, specimen_id: null, status: 'in_process', processing_centre_id: null, processing_branch_id: null });
    const res = (await resultsOf(order.orderId)).filter((x) => x.test_id === TESTS['ihc'].id);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ status: 'pending', specimen_id: null, order_test_id: t.id });
    expect((await specimensOf(order.orderId)).length).toBe(2);
  });

  it('outsourced item: order_tests status outsourced, no result rows', async () => {
    const t = (await orderTestsOf(order.orderId)).find((x) => x.test_code === 'SEND')!;
    expect(t.status).toBe('outsourced');
    expect((await resultsOf(order.orderId)).filter((x) => x.test_id === TESTS['out'].id)).toEqual([]);
  });

  it('AC-01.6: one pending result per reportable analyte + one per non-reportable formula input (is_reportable snapshot), none for other non-reportable analytes; linked to the specimen listing the test', async () => {
    const res = await resultsOf(order.orderId);
    const cbc = res.filter((x) => x.test_id === TESTS['cbc'].id);
    expect(cbc.map((x) => x.analyte_code).sort()).toEqual(['HB', 'HCT', 'MCV', 'RBC', 'WBC']);
    expect(Object.fromEntries(cbc.map((x) => [x.analyte_code, x.is_reportable]))).toEqual({ HB: true, WBC: true, MCV: true, RBC: false, HCT: false });
    const s = await specimensOf(order.orderId);
    const wb = s.find((x) => x.specimen_type_code === 'WB')!;
    const ser = s.find((x) => x.specimen_type_code === 'SERUM')!;
    for (const x of cbc) expect(x).toMatchObject({ status: 'pending', specimen_id: wb.id, order_id: order.orderId, patient_id: PATIENT[A], department_id: D.hema, result_type: 'numeric', centre_id: CENTRE[A],
      analyte_id: TESTS['cbc'].analytes.find((a: any) => a.code === x.analyte_code).id });
    const glu = res.filter((x) => x.test_id === TESTS['glu'].id);
    expect(glu).toHaveLength(1);
    expect(glu[0]).toMatchObject({ analyte_code: 'GLU', status: 'pending', specimen_id: ser.id });
    const ot = await orderTestsOf(order.orderId);
    expect(ot.find((x) => x.test_code === 'CBC')!.specimen_id).toBe(wb.id);
    expect(ot.find((x) => x.test_code === 'GLU')!.specimen_id).toBe(ser.id);
    for (const x of cbc) expect(x.order_test_id).toBe(ot.find((t) => t.test_code === 'CBC')!.id);
  });
});

describe.skipIf(!live)('T-06 age snapshot (02-TRD §4.1 step 2)', () => {
  it('birthOn present: patient_age_days = days from birthOn to registered_at (not the years/months/days approximation)', async () => {
    const order = await seedFrontdeskOrder(A);
    const r = rig({ demographics: { sex: 'male', birthOn: '1996-06-15', ageAtOrder: { years: 99, months: 0, days: 0 } }, summaries: new Map([[order.orderId, summaryOf(order, ['glu'])]]) });
    await apply(A, r, 'created', createdEnv(order, ['glu']));
    const o = await orderRow(order.orderId);
    expect(o.patient_age_days).toBe(daysBetween('1996-06-15T00:00:00Z', '2026-06-15T00:00:00Z'));   // 10957 whole days, not 99 * 365
    expect(o.patient_sex).toBe('male');
    expect((await specimensOf(order.orderId))[0]).toMatchObject({ patient_sex: 'male', patient_age_days: o.patient_age_days });
  });
});

describe.skipIf(!live)('T-06 AC-01.2 duplicate delivery, redelivery, concurrency', () => {
  it('the same event applied twice: no new rows, no new events (incl. a re-delivery under another event_id)', async () => {
    const order = await seedFrontdeskOrder(A);
    const r = rig({ summaries: new Map([[order.orderId, summaryOf(order, ['cbc', 'glu'])]]) });
    const first = createdEnv(order, ['cbc', 'glu']);
    await apply(A, r, 'created', first);
    const snap = async () => JSON.stringify([await specimensOf(order.orderId), await orderTestsOf(order.orderId), await resultsOf(order.orderId), (await orderRow(order.orderId)).version]);
    const before = await snap();
    const nEvents = r.events.length;
    await apply(A, r, 'created', first);
    await apply(A, r, 'created', createdEnv(order, ['cbc', 'glu'], 1));
    expect(await snap()).toBe(before);
    expect(r.events).toHaveLength(nEvents);
    expect((await specimensOf(order.orderId))).toHaveLength(2);
    expect((await resultsOf(order.orderId))).toHaveLength(6);
  });

  it('5 parallel deliveries of one event: one order row, two specimens, six results; each delivery commits or fails (never a partial state)', async () => {
    const order = await seedFrontdeskOrder(A);
    const r = rig({ summaries: new Map([[order.orderId, summaryOf(order, ['cbc', 'glu'])]]) });
    const out = await Promise.allSettled(Array.from({ length: 5 }, () => apply(A, r, 'created', createdEnv(order, ['cbc', 'glu']))));
    expect(out.some((x) => x.status === 'fulfilled')).toBe(true);
    expect((await sql('SELECT count(*)::int n FROM lab.orders WHERE id = $1', [order.orderId]))[0].n).toBe(1);
    expect(await specimensOf(order.orderId)).toHaveLength(2);
    expect(await orderTestsOf(order.orderId)).toHaveLength(2);
    expect(await resultsOf(order.orderId)).toHaveLength(6);
    expect(new Set((await specimensOf(order.orderId)).map((x) => x.barcode)).size).toBe(2);
  });
});

describe.skipIf(!live)('T-06 stale seq (02-CV §11.4 stale-seq test)', () => {
  it('a created with aggregate.seq lower than the stored last_order_seq changes nothing (no extra item, no event)', async () => {
    const order = await seedFrontdeskOrder(A);
    const r = rig({ summaries: new Map([[order.orderId, summaryOf(order, ['glu', 'urine'])]]) });
    await apply(A, r, 'created', createdEnv(order, ['glu'], 5));
    const nEvents = r.events.length;
    await apply(A, r, 'created', createdEnv(order, ['glu', 'urine'], 3));
    expect((await orderRow(order.orderId)).last_order_seq).toBe(5);
    expect((await orderTestsOf(order.orderId)).map((t) => t.test_code)).toEqual(['GLU']);
    expect(await specimensOf(order.orderId)).toHaveLength(1);
    expect(r.events).toHaveLength(nEvents);
  });

  it('items_changed with items_version <= stored is ignored; a higher one applies and raises items_version', async () => {
    const order = await seedFrontdeskOrder(A);
    const r = rig({ summaries: new Map([[order.orderId, summaryOf(order, ['glu', 'urine', 'esr'])]]) });
    await apply(A, r, 'created', createdEnv(order, ['glu']));
    await apply(A, r, 'changed', changedEnv(order, 2, [{ key: 'urine' }], []));
    expect((await orderRow(order.orderId)).items_version).toBe(2);
    const before = (await orderTestsOf(order.orderId)).length;
    await apply(A, r, 'changed', changedEnv(order, 2, [{ key: 'esr' }], []));           // same version, another event: stale
    expect((await orderTestsOf(order.orderId))).toHaveLength(before);
    await apply(A, r, 'changed', changedEnv(order, 3, [{ key: 'esr' }], []));
    expect((await orderRow(order.orderId)).items_version).toBe(3);
    expect((await orderTestsOf(order.orderId)).map((t) => t.test_code)).toContain('ESR');
  });
});

describe.skipIf(!live)('T-06 AC-01.4 invalid barcode pattern', () => {
  it('pattern with {fy} (not allowed) -> lab.barcode_pattern_invalid, everything rolled back: no order row, specimen, order_test, result, event', async () => {
    const order = await seedFrontdeskOrder(A);
    const r = rig({ summaries: new Map([[order.orderId, summaryOf(order, ['cbc', 'glu'])]]), numbering: { barcodePattern: 'E{fy}{seq:8}' } });
    const err = await failure(apply(A, r, 'created', createdEnv(order, ['cbc', 'glu'])));
    expect(isLimsError(err, 'lab.barcode_pattern_invalid')).toBe(true);
    expect(await orderRow(order.orderId)).toBeUndefined();
    expect(await specimensOf(order.orderId)).toEqual([]);
    expect(await orderTestsOf(order.orderId)).toEqual([]);
    expect(await resultsOf(order.orderId)).toEqual([]);
    expect(statusEvents(r)).toEqual([]);
  });
});

describe.skipIf(!live)('T-06 order.items_changed (AC-01.7)', () => {
  let order: Order;
  const r = rig();
  let ctrBefore = 0;
  let wbBefore: any;
  beforeAll(async () => {
    order = await seedFrontdeskOrder(A);
    r.summaries.set(order.orderId, summaryOf(order, ['cbc', 'glu', 'esr', 'urine']));
    await apply(A, r, 'created', createdEnv(order, ['cbc', 'glu']));
    wbBefore = (await specimensOf(order.orderId)).find((x) => x.specimen_type_code === 'WB');
    ctrBefore = await counterOf(A);
    r.events.length = 0;
    await apply(A, r, 'changed', changedEnv(order, 2, [{ key: 'esr', priority: 'urgent' }, { key: 'urine' }], ['glu']));
  }, 60_000);

  it('AC-01.7: an urgent test added with an ordered WB/EDTA specimen present attaches to it: no new barcode for it, order_test urgent with the urgent TAT, results pending on that specimen', async () => {
    const esr = (await orderTestsOf(order.orderId)).find((t) => t.test_code === 'ESR')!;
    expect(esr).toMatchObject({ priority: 'urgent', tat_target_seconds: 3600, specimen_id: wbBefore.id, status: 'awaiting_collection', test_revision: 5 });
    const res = (await resultsOf(order.orderId)).filter((x) => x.test_id === TESTS['esr'].id);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ status: 'pending', specimen_id: wbBefore.id });
    expect((await specimensOf(order.orderId)).filter((x) => x.specimen_type_code === 'WB')).toHaveLength(1);
  });

  it('an added test without a matching active specimen gets a new specimen: S1 event, creation_key suffixed with items_version, only one new barcode allocated', async () => {
    const urine = (await specimensOf(order.orderId)).find((x) => x.specimen_type_code === 'URINE')!;
    expect(urine).toMatchObject({ status: 'ordered', creation_key: `${order.orderId}:URINE:-:2`, is_active: true });
    expect(urine.barcode).toMatch(/^E26\d{8}$/);
    expect(await counterOf(A)).toBe(ctrBefore + 1);
    const ev = statusEvents(r);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.input.payload).toMatchObject({ specimen_id: urine.id, to_status: 'ordered' });
    expect('from_status' in ev[0]!.input.payload).toBe(false);
  });

  it('removed item: its results become cancelled (R8), order_tests cancelled (item_removed), its un-received specimen with no active tests is_active = false; the other specimen stays active', async () => {
    const glu = (await orderTestsOf(order.orderId)).find((t) => t.test_code === 'GLU')!;
    expect(glu).toMatchObject({ status: 'cancelled', cancel_reason: 'item_removed' });
    expect(glu.cancelled_at).not.toBeNull();
    const res = (await resultsOf(order.orderId)).filter((x) => x.test_id === TESTS['glu'].id);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ status: 'cancelled' });
    expect(res[0].cancelled_at).not.toBeNull();
    const s = await specimensOf(order.orderId);
    expect(s.find((x) => x.specimen_type_code === 'SERUM')!.is_active).toBe(false);
    expect(s.find((x) => x.specimen_type_code === 'WB')!.is_active).toBe(true);
    expect(statusEvents(r).some((e) => e.input.payload.to_status !== 'ordered')).toBe(false);   // no specimen status event for the inactivation (no state exists, AC-01.8)
  });

  it('removing an item whose specimen still has another active test keeps that specimen active', async () => {
    await apply(A, r, 'changed', changedEnv(order, 3, [], ['esr']));
    const wb = (await specimensOf(order.orderId)).find((x) => x.specimen_type_code === 'WB')!;
    expect(wb.is_active).toBe(true);                                            // CBC is still on it
    expect((await orderTestsOf(order.orderId)).find((t) => t.test_code === 'ESR')).toMatchObject({ status: 'cancelled', cancel_reason: 'item_removed' });
  });
});

describe.skipIf(!live)('T-06 unknown order (03-APP-FLOW E2/E3; 02-TRD §7.2)', () => {
  it('E2 items_changed before created: lab.orders built from getOrderSummary + demographics (result_evaluation) with collection_mode NULL; a later created fills collection_mode and creates no duplicate order_tests', async () => {
    const order = await seedFrontdeskOrder(A);
    const r = rig({ summaries: new Map([[order.orderId, summaryOf(order, ['glu', 'esr'])]]) });
    await apply(A, r, 'changed', changedEnv(order, 2, [{ key: 'esr' }], []));
    const o = await orderRow(order.orderId);
    expect(o).toMatchObject({ registration_no: order.regNo, collection_mode: null, lab_status: 'active', items_version: 2, patient_sex: 'female', patient_age_days: 11140, patient_id: PATIENT[A],
      centre_id: CENTRE[A], branch_id: BRANCH[A], visit_type: 'opd', source: 'front_desk' });
    expect(r.calls.summary).toEqual([{ orderId: order.orderId }]);
    expect(r.calls.demo).toEqual([{ patientId: PATIENT[A], purpose: 'result_evaluation' }]);
    expect((await orderTestsOf(order.orderId)).map((t) => t.test_code)).toEqual(['ESR']);
    await apply(A, r, 'created', createdEnv(order, ['glu', 'esr'], 1));
    expect((await orderRow(order.orderId)).collection_mode).toBe('walk_in');
    const ot = await orderTestsOf(order.orderId);
    expect(ot.map((t) => t.test_code).sort()).toEqual(['ESR', 'GLU']);
    expect(new Set((await specimensOf(order.orderId)).map((x) => x.barcode)).size).toBe((await specimensOf(order.orderId)).length);
  });

  it('E3 cancelled before created: row built as above with lab_status cancelled; the later created creates nothing', async () => {
    const order = await seedFrontdeskOrder(A);
    const r = rig({ summaries: new Map([[order.orderId, summaryOf(order, ['glu'])]]) });
    await apply(A, r, 'cancelled', cancelledEnv(order));
    const o = await orderRow(order.orderId);
    expect(o).toMatchObject({ lab_status: 'cancelled', collection_mode: null, registration_no: order.regNo, patient_sex: 'female' });
    expect(o.cancelled_at).not.toBeNull();
    await apply(A, r, 'created', createdEnv(order, ['glu'], 1));
    expect(await specimensOf(order.orderId)).toEqual([]);
    expect(await orderTestsOf(order.orderId)).toEqual([]);
    expect(await resultsOf(order.orderId)).toEqual([]);
    expect(r.events).toEqual([]);
  });
});

describe.skipIf(!live)('T-06 order.cancelled (AC-01.8)', () => {
  let order: Order;
  const r = rig();
  let received: any;
  let ordered: any;
  beforeAll(async () => {
    order = await seedFrontdeskOrder(A);
    r.summaries.set(order.orderId, summaryOf(order, ['cbc', 'glu', 'urine']));
    await apply(A, r, 'created', createdEnv(order, ['cbc', 'glu', 'urine']));
    const s = await specimensOf(order.orderId);
    received = s.find((x) => x.specimen_type_code === 'WB');
    ordered = s.filter((x) => x.specimen_type_code !== 'WB');
    // physical state set directly (superuser, claims for the audit triggers): WB received; its HB result resulted, WBC verified, MCV approved; GLU pending
    await asAdmin(A, async (c) => {
      await c.query("UPDATE lab.specimens SET status = 'received', received_at = now(), processing_centre_id = $2, processing_branch_id = $3 WHERE id = $1", [received.id, CENTRE[A], BRANCH[A]]);
      await c.query("UPDATE lab.results SET status = 'resulted', origin = 'manual', value_numeric = 12.5, resulted_at = now() WHERE order_id = $1 AND analyte_code = 'HB'", [order.orderId]);
      await c.query("UPDATE lab.results SET status = 'verified', origin = 'manual', value_numeric = 6.1, resulted_at = now(), verified_at = now(), verified_by_membership_id = $2 WHERE order_id = $1 AND analyte_code = 'WBC'", [order.orderId, mem]);
      await c.query("UPDATE lab.results SET status = 'approved', origin = 'manual', value_numeric = 88, resulted_at = now(), approved_at = now(), approved_by_membership_id = $2 WHERE order_id = $1 AND analyte_code = 'MCV'", [order.orderId, mem]);
    });
    r.events.length = 0;
    await apply(A, r, 'cancelled', cancelledEnv(order));
  }, 60_000);

  it('lab.orders.lab_status = cancelled with cancelled_at from the payload', async () => {
    const o = await orderRow(order.orderId);
    expect(o.lab_status).toBe('cancelled');
    expect(new Date(o.cancelled_at).toISOString()).toBe('2026-06-15T06:00:00.000Z');
  });

  it('every pending/resulted/verified result becomes cancelled; an approved result is not touched (02-TRD §7.2 "non-approved")', async () => {
    const res = await resultsOf(order.orderId);
    const by = Object.fromEntries(res.map((x) => [x.analyte_code, x.status]));
    expect(by).toMatchObject({ HB: 'cancelled', WBC: 'cancelled', GLU: 'cancelled', UCOL: 'cancelled', RBC: 'cancelled', HCT: 'cancelled', MCV: 'approved' });
  });

  it('specimens not yet received get is_active = false; the received one stays active; no specimen status event is emitted', async () => {
    const s = await specimensOf(order.orderId);
    for (const o of ordered) expect(s.find((x) => x.id === o.id)).toMatchObject({ is_active: false, status: 'ordered' });
    expect(s.find((x) => x.id === received.id)).toMatchObject({ is_active: true, status: 'received' });
    expect(r.events).toEqual([]);
  });

  it('order_tests without an approved result become cancelled (order_cancelled)', async () => {
    const ot = await orderTestsOf(order.orderId);
    for (const code of ['GLU', 'UR']) expect(ot.find((t) => t.test_code === code)).toMatchObject({ status: 'cancelled', cancel_reason: 'order_cancelled' });
  });

  it('re-delivery of the cancellation changes nothing', async () => {
    const snap = async () => JSON.stringify([await resultsOf(order.orderId), await specimensOf(order.orderId), await orderTestsOf(order.orderId)]);
    const before = await snap();
    await apply(A, r, 'cancelled', cancelledEnv(order));
    expect(await snap()).toBe(before);
    expect(r.events).toEqual([]);
  });
});

describe.skipIf(!live)('T-06 tenant isolation (07-SECURITY P-11, REQ-SEC-024)', () => {
  it('a cancellation in tenant A that names tenant B\'s order: no B row changes and no A row is built from it (the A-scoped port does not know the order)', async () => {
    const other = await seedFrontdeskOrder(B);
    const rb = rig({ summaries: new Map([[other.orderId, summaryOf(other, ['glu'])]]) });
    await apply(B, rb, 'created', createdEnv(other, ['glu']));
    const before = JSON.stringify([await specimensOf(other.orderId), await resultsOf(other.orderId), await orderRow(other.orderId)]);
    const ra = rig();                                                          // tenant A's FrontdeskPort: common.not_found for B's order
    const e = cancelledEnv({ ...other, tenant: A });
    await Promise.allSettled([apply(A, ra, 'cancelled', e), apply(A, ra, 'changed', changedEnv({ ...other, tenant: A }, 2, [], ['glu'])), apply(A, ra, 'created', createdEnv({ ...other, tenant: A }, ['glu']))]);
    expect(JSON.stringify([await specimensOf(other.orderId), await resultsOf(other.orderId), await orderRow(other.orderId)])).toBe(before);
    expect((await sql('SELECT count(*)::int n FROM lab.orders WHERE id = $1 AND tenant_id = $2', [other.orderId, A]))[0].n).toBe(0);
    expect((await sql('SELECT count(*)::int n FROM lab.specimens WHERE order_id = $1 AND tenant_id = $2', [other.orderId, A]))[0].n).toBe(0);
    expect(ra.events).toEqual([]);
  });

  it('each tenant gets its own barcode series: the same order shape in A and B both start from their own counter', async () => {
    const a = await seedFrontdeskOrder(A);
    const b = await seedFrontdeskOrder(B);
    const ra = rig({ summaries: new Map([[a.orderId, summaryOf(a, ['glu'])]]) });
    const rb = rig({ summaries: new Map([[b.orderId, summaryOf(b, ['glu'])]]) });
    const cb = await counterOf(B);
    await Promise.all([apply(A, ra, 'created', createdEnv(a, ['glu'])), apply(B, rb, 'created', createdEnv(b, ['glu']))]);
    expect(await counterOf(B)).toBe(cb + 1);
    expect((await specimensOf(b.orderId))[0]!.tenant_id).toBe(B);
  });
});
