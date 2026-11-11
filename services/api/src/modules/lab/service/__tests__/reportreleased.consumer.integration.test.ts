// C5 T-27 — reporting.report.released.v1 consumer (A8) against the migrated database (06 row T-27; 02-TRD §7.2 row 9 + "one rule" (finding C5 #4), §3.2;
// 03-APP-FLOW S10; PRD AC-18.2, AC-18.3 (CR-C5-006 order_item_ids); 05-SCHEMA lab.report_releases (report_kind stored as received, 08 A13 P-4); 07-SECURITY P-11, REQ-SEC-024).
// Needs the DB that tests/db/c5-t03/run.sh starts (see .orchestra/notes/C5.T-27-verify.cmd): LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser.
// Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1 where "database is provided" fails.
//
// SEAM — the writer implements services/worker/src/jobs/lab/consumers/reporting.report.released.v1.ts exporting `handle(envelope, jobCtx): Promise<void>` (ConsumerHandler, as T-09).
//   envelope = { event_id, event_type, tenant_id, aggregate: { type: 'report', id: report_id, seq: version_no }, payload (contracts/events/reporting.report.released.v1.schema.json) }.
//   jobCtx = worker JobContext (tenantId, actor system, tx = lims_api client in ONE job transaction, now(): ISO string, events.publish(ctx, type, { aggregate, idempotencyKey, payload }), log).
// BEHAVIOUR (the one rule, 02-TRD §7.2 / PRD AC-18.3):
//   always: insert lab.report_releases (order_id, report_id, version_no, report_kind AS RECEIVED, released_at, release_basis, order_item_ids = payload list or NULL, event_id = envelope.event_id, created_by system).
//   final / amended / addendum / any other value -> S10 (approved -> reported) for the `approved` specimens of the listed order_item_ids (all items of the order when the field is absent)
//        + order_tests.reported_at for the `approved` order tests of those items; partial -> the same but only for the listed ids (absent -> no change);
//        preliminary -> recorded only (no S10, no reported_at, no event).
//   S10 = specimen version + 1, status reported, reported_at set, one specimen_transitions row (S10, approved -> reported, actor system), one lab.specimen.status_changed.v1 event
//        (idempotencyKey `<specimen_id>:reported:<version>`, aggregate { type: 'specimen', id, seq: version }). order_tests.status stays 'approved' (the CHECK has no 'reported').
//   Redelivery (same event or same report_id + version_no) and an older version_no of a report change nothing more and do not throw. A tenant-B id in a tenant-A event changes no B row.
// ASSUMED (spec silent): reported_at = payload.released_at (or the consumer clock; both accepted below); an unknown/other-tenant order is either skipped or dead-lettered (P-11 "as the consumer defines");
//   item ids that do not belong to the event's order are ignored; the status_changed event carries no barcode (PHI-light, as T-09).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { handle } from '../../../../../../worker/src/jobs/lab/consumers/reporting.report.released.v1.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEM = '01a1a98a-ac40-7000-8000-00000000a500';
const BRANCH = { [A]: '01a1a98a-ac40-7000-8000-00000000a101', [B]: '01a1a98a-ac40-7000-8000-00000000b101' } as Record<string, string>;
const CENTRE = { [A]: '01a1a98a-ac40-7000-8000-00000000a201', [B]: '01a1a98a-ac40-7000-8000-00000000b201' } as Record<string, string>;
const u = (n: number) => `0190c60a-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PATIENT = { [A]: u(0xa9), [B]: u(0xb9) } as Record<string, string>;
const NOW = '2026-06-15T06:00:30.000Z';
const RELEASED = '2026-06-15T05:55:00.000Z';
const APPROVED = '2026-06-15T05:00:00.000Z';
const iso = (d: unknown) => new Date(d as string | Date).toISOString();
const STATUS_EVENT_KEYS = new Set(Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'events', 'lab.specimen.status_changed.v1.schema.json'), 'utf8'))['$defs'].Payload.properties));

// ------------------------------------------------------------------ database helpers (same technique as the T-06/T-09 suites)
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
let nextId = 0x5000;
let barcodeN = Date.now() % 90_000_000;
interface Seeded { id: string; barcode: string; itemId: string; orderTestId: string; resultId: string }
interface Scen { tenant: string; orderId: string; units: Seeded[] }
const PRE_RECEIPT = new Set(['ordered', 'collected', 'in_transit']);
const OT_STATUS: Record<string, string> = { ordered: 'awaiting_collection', collected: 'awaiting_receipt', in_transit: 'awaiting_receipt', received: 'in_process', in_process: 'in_process',
  resulted: 'resulted', verified: 'verified', approved: 'approved', reported: 'approved' };

/** frontdesk order + items -> lab.orders -> one unit (item + specimen + order test + result) per requested specimen status. */
async function scenario(tenant: string, statuses: string[]): Promise<Scen> {
  const orderId = u(nextId++);
  const centre = CENTRE[tenant]!;
  const branch = BRANCH[tenant]!;
  const reg = `RT27${orderId.slice(-6).toUpperCase()}`;
  const out: Scen = { tenant, orderId, units: [] };
  await asAdmin(tenant, async (c) => {
    await ins(c, 'frontdesk.orders', { id: orderId, tenant_id: tenant, branch_id: branch, centre_id: centre, patient_id: PATIENT[tenant], registration_no: reg,
      status: 'registered', visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk', is_first_order_of_patient: false, catalog_revision: 1,
      registered_at: '2026-06-15T03:00:00.000Z' });
    await ins(c, 'lab.orders', { id: orderId, tenant_id: tenant, centre_id: centre, branch_id: branch, patient_id: PATIENT[tenant], registration_no: reg,
      visit_type: 'opd', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk', registered_at: '2026-06-15T03:00:00.000Z', patient_sex: 'female', patient_age_days: 10950,
      lab_status: 'active', last_order_seq: 1, items_version: 1 });
    for (const [i, st] of statuses.entries()) {
      const id = u(nextId++); const itemId = u(nextId++); const orderTestId = u(nextId++); const resultId = u(nextId++); const testId = u(nextId++);
      const barcode = `T27${String(barcodeN++).padStart(8, '0')}`;
      const received = !PRE_RECEIPT.has(st);
      const approved = st === 'approved' || st === 'reported';
      await ins(c, 'frontdesk.order_items', { id: itemId, tenant_id: tenant, order_id: orderId, centre_id: centre, orderable_id: u(nextId++), orderable_kind: 'test', code: `T27${i}`, name: `T27${i} (SYNTHETIC)`,
        test_ids: [testId], priority: 'routine', unit_price_paisa: 1000, price_list_id: u(0x98), price_list_version: 1, price_source: 'tenant_default', vat_treatment: 'exempt', added_in_items_version: 1 });
      await ins(c, 'lab.specimens', { id, tenant_id: tenant, centre_id: centre, order_id: orderId, patient_id: PATIENT[tenant], barcode, creation_key: `${orderId}:WB:EDTA:${i}`,
        specimen_type_code: 'WB', container_code: 'EDTA', priority: 'routine', patient_sex: 'female', patient_age_days: 10950, status: st, ordered_at: '2026-06-15T03:00:00.000Z',
        ...(st !== 'ordered' ? { collected_at: '2026-06-15T04:10:00.000Z', collected_by_membership_id: MEM } : {}),
        ...(received ? { in_transit_at: '2026-06-15T04:20:00.000Z', received_at: '2026-06-15T04:30:00.000Z', received_by_membership_id: MEM, processing_centre_id: centre, processing_branch_id: branch } : {}),
        ...(approved ? { all_approved_at: APPROVED } : {}), ...(st === 'reported' ? { reported_at: '2026-06-15T05:30:00.000Z' } : {}), version: st === 'approved' ? 7 : 1 });
      await ins(c, 'lab.order_tests', { id: orderTestId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, test_id: testId, test_code: `T27${i}`, test_revision: 1, catalog_revision: 1,
        department_id: u(0x901), workflow_type: 'standard', priority: 'routine', specimen_id: id, status: OT_STATUS[st], ordered_at: '2026-06-15T03:00:00.000Z',
        ...(received ? { received_at: '2026-06-15T04:30:00.000Z', processing_centre_id: centre, processing_branch_id: branch } : {}), ...(approved ? { approved_at: APPROVED } : {}),
        ...(st === 'reported' ? { reported_at: '2026-06-15T05:30:00.000Z' } : {}) });
      await ins(c, 'lab.results', { id: resultId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, order_test_id: orderTestId, specimen_id: id, patient_id: PATIENT[tenant],
        test_id: testId, analyte_id: u(nextId++), analyte_code: `T27${i}A`, department_id: u(0x901), is_reportable: true, result_type: 'numeric',
        ...(approved ? { status: 'approved', origin: 'manual', value_numeric: '5.0', unit_code: 'g/dL', approved_at: APPROVED, approved_by_membership_id: MEM } : { status: 'pending' }) });
      out.units.push({ id, barcode, itemId, orderTestId, resultId });
    }
  });
  return out;
}
const specimenRow = async (id: string) => (await sql('SELECT * FROM lab.specimens WHERE id = $1', [id]))[0];
const transitionsOf = (id: string) => sql('SELECT * FROM lab.specimen_transitions WHERE specimen_id = $1 ORDER BY specimen_version', [id]);
const orderTestRow = async (id: string) => (await sql('SELECT * FROM lab.order_tests WHERE id = $1', [id]))[0];
const releasesOf = (orderId: string) => sql('SELECT * FROM lab.report_releases WHERE order_id = $1 ORDER BY version_no, created_at', [orderId]);
const snapshot = async (s: Scen) => JSON.stringify([await Promise.all(s.units.map(async (x) => [await specimenRow(x.id), await transitionsOf(x.id), await orderTestRow(x.orderTestId)])), (await releasesOf(s.orderId)).length]);

// ------------------------------------------------------------------ driving the consumer
type Pub = { type: string; input: any };
interface Over { reportId?: string; version?: number; kind?: string; itemIds?: string[] | null; eventId?: string; tenantOfEnvelope?: string; failEventAt?: number; orderId?: string; basis?: string }
let seq = 0;
const envelopeOf = (s: Scen, o: Over = {}) => {
  const reportId = o.reportId ?? u(0x7000 + seq);
  const version = o.version ?? 1;
  return { event_id: o.eventId ?? u(0x6000 + seq++), event_type: 'reporting.report.released.v1', tenant_id: o.tenantOfEnvelope ?? s.tenant, producer: 'reporting',
    occurred_at: NOW, aggregate: { type: 'report', id: reportId, seq: version }, idempotency_key: `${reportId}:${version}:released`,
    payload: { report_id: reportId, version_no: version, order_id: o.orderId ?? s.orderId, patient_id: PATIENT[s.tenant], centre_id: CENTRE[s.tenant], report_kind: o.kind ?? 'final',
      ...(o.itemIds === null || o.itemIds === undefined ? {} : { order_item_ids: o.itemIds }), released_at: RELEASED, release_basis: o.basis ?? 'paid_in_full', audiences: ['patient'] } };
};

/** One delivery = one job tx under RLS (claims of the job tenant); a throw rolls the whole tx back, like the worker wrapper. */
async function deliver(env: ReturnType<typeof envelopeOf>, tenant: string = env.tenant_id, o: Over = {}): Promise<{ events: Pub[]; error?: any }> {
  const events: Pub[] = [];
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const ctx: any = {
      tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: u(0x9000 + seq++), tx: client, now: () => NOW, attempt: 1, maxAttempts: 10, jobId: '1',
      log: { info() {}, warn() {}, error() {}, child() { return this; } },
      events: { publish: async (_c: unknown, type: string, input: unknown) => {
        if (o.failEventAt !== undefined && events.length === o.failEventAt) throw new Error('SENTINEL event bus down');
        events.push({ type, input }); return { eventId: u(0x8000 + events.length), duplicate: false };
      } },
      ports: { IdentityPort: { async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; } } },
    };
    try { await handle(env as never, ctx); } catch (error) { await client.query('ROLLBACK').catch(() => undefined); return { events: [], error }; }
    await client.query('COMMIT');
    return { events };
  } finally { client.release(); }
}
const ok = async (p: ReturnType<typeof deliver>) => { const r = await p; expect(r.error, String(r.error?.stack ?? r.error)).toBeUndefined(); return r; };
const statusEvents = (e: Pub[]) => e.filter((x) => x.type === 'lab.specimen.status_changed.v1');

/** Asserts exactly `moved` units went approved -> reported (S10) and every other unit is byte-identical to `before`. */
async function expectMoved(s: Scen, before: string[], moved: number[], r: { events: Pub[] }) {
  for (const [i, x] of s.units.entries()) {
    const sp = await specimenRow(x.id); const ot = await orderTestRow(x.orderTestId); const tr = await transitionsOf(x.id);
    if (moved.includes(i)) {
      expect(sp, `unit ${i} specimen`).toMatchObject({ status: 'reported', version: 8, is_active: true });
      expect(sp.reported_at, `unit ${i} specimen.reported_at`).not.toBeNull();
      expect([RELEASED, NOW]).toContain(iso(sp.reported_at));
      expect(ot, `unit ${i} order test`).toMatchObject({ status: 'approved' });
      expect(iso(ot.reported_at)).toBe(iso(sp.reported_at));
      const s10 = tr.filter((t) => t.transition_code === 'S10');
      expect(s10, `unit ${i} S10 rows`).toHaveLength(1);
      expect(s10[0]).toMatchObject({ from_status: 'approved', to_status: 'reported', specimen_version: 8, actor_type: 'system', actor_id: SYS });
    } else {
      expect(JSON.stringify([sp, tr, ot]), `unit ${i} must be untouched`).toBe(before[i]);
    }
  }
  const ev = statusEvents(r.events);
  expect(r.events, 'only specimen status events are emitted').toHaveLength(ev.length);
  expect(ev).toHaveLength(moved.length);
  expect(ev.map((e) => e.input.idempotencyKey).sort()).toEqual(moved.map((i) => `${s.units[i]!.id}:reported:8`).sort());
  for (const e of ev) {
    expect(e.input.payload).toMatchObject({ order_id: s.orderId, from_status: 'approved', to_status: 'reported', patient_id: PATIENT[s.tenant], centre_id: CENTRE[s.tenant] });
    expect(e.input.aggregate).toMatchObject({ type: 'specimen', seq: 8 });
    for (const k of Object.keys(e.input.payload)) expect(STATUS_EVENT_KEYS.has(k), `payload key ${k} is not in the event schema`).toBe(true);
    for (const x of s.units) expect(JSON.stringify(e.input.payload)).not.toContain(x.barcode);
  }
}
const rowsBefore = (s: Scen) => Promise.all(s.units.map(async (x) => JSON.stringify([await specimenRow(x.id), await transitionsOf(x.id), await orderTestRow(x.orderTestId)])));

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 8 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await asAdmin(t, (c) => ins(c, 'frontdesk.patients', { id: PATIENT[t], tenant_id: t, patient_code: 'P-T27', full_name: 'Test Patient T27', name_search: 'test patient t27',
    sex: 'female', registered_centre_id: CENTRE[t] }));
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-27 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

// units: 0 approved, 1 approved, 2 received (NOT approved), 3 approved
const MIXED = ['approved', 'approved', 'received', 'approved'];

describe.skipIf(!live)('T-27 AC-18.3 final / amended / addendum / unknown -> S10 for the approved specimens of the listed items (all items when absent)', () => {
  for (const kind of ['final', 'amended', 'addendum', 'corrected_by_c6', 'x'.repeat(32)]) {
    it(`report_kind "${kind.length > 20 ? kind.length + ' chars' : kind}" without order_item_ids: every approved specimen -> reported, the received one untouched; kind stored as received`, async () => {
      const s = await scenario(A, MIXED);
      const before = await rowsBefore(s);
      const env = envelopeOf(s, { kind });
      const r = await ok(deliver(env));
      await expectMoved(s, before, [0, 1, 3], r);
      expect((await orderTestRow(s.units[2]!.orderTestId)).reported_at).toBeNull();
      const rel = await releasesOf(s.orderId);
      expect(rel).toHaveLength(1);
      expect(rel[0]).toMatchObject({ report_id: env.payload.report_id, version_no: 1, report_kind: kind, release_basis: 'paid_in_full', order_item_ids: null, event_id: env.event_id, created_by: SYS, tenant_id: A });
      expect(iso(rel[0].released_at)).toBe(RELEASED);
    });
  }

  for (const kind of ['final', 'corrected_by_c6']) {
    it(`report_kind "${kind}" with order_item_ids [item0, item2(not approved)]: only unit 0 moves; the list is stored`, async () => {
      const s = await scenario(A, MIXED);
      const before = await rowsBefore(s);
      const ids = [s.units[0]!.itemId, s.units[2]!.itemId];
      const r = await ok(deliver(envelopeOf(s, { kind, itemIds: ids })));
      await expectMoved(s, before, [0], r);
      const rel = await releasesOf(s.orderId);
      expect([...rel[0].order_item_ids].sort()).toEqual([...ids].sort());
    });
  }

  it('an approved specimen of an item NOT in the list is untouched (item filter, final)', async () => {
    const s = await scenario(A, MIXED);
    const before = await rowsBefore(s);
    const r = await ok(deliver(envelopeOf(s, { kind: 'amended', itemIds: [s.units[3]!.itemId] })));
    await expectMoved(s, before, [3], r);
  });

  it('item ids of ANOTHER order of the same tenant are ignored: nothing moves in either order', async () => {
    const s = await scenario(A, MIXED);
    const other = await scenario(A, ['approved', 'approved']);
    const b1 = await rowsBefore(s); const b2 = await rowsBefore(other);
    const r = await ok(deliver(envelopeOf(s, { kind: 'final', itemIds: other.units.map((x) => x.itemId) })));
    await expectMoved(s, b1, [], r);
    await expectMoved(other, b2, [], { events: [] });
  });

  it('an order without any approved specimen: recorded, nothing moves, no event', async () => {
    const s = await scenario(A, ['received', 'collected']);
    const before = await rowsBefore(s);
    const r = await ok(deliver(envelopeOf(s, { kind: 'final' })));
    await expectMoved(s, before, [], r);
    expect(await releasesOf(s.orderId)).toHaveLength(1);
  });

  it('a specimen that is already reported is skipped (no second S10, no event)', async () => {
    const s = await scenario(A, ['reported', 'approved']);
    const before = await rowsBefore(s);
    const r = await ok(deliver(envelopeOf(s, { kind: 'final' })));
    expect(JSON.stringify([await specimenRow(s.units[0]!.id), await transitionsOf(s.units[0]!.id), await orderTestRow(s.units[0]!.orderTestId)])).toBe(before[0]);
    expect((await specimenRow(s.units[1]!.id)).status).toBe('reported');
    expect(statusEvents(r.events)).toHaveLength(1);
  });
});

describe.skipIf(!live)('T-27 AC-18.3 partial: only the listed items (CR-C5-006); absent list -> no change', () => {
  it('partial with [item0, item3] moves exactly those; list stored', async () => {
    const s = await scenario(A, MIXED);
    const before = await rowsBefore(s);
    const ids = [s.units[0]!.itemId, s.units[3]!.itemId];
    const env = envelopeOf(s, { kind: 'partial', itemIds: ids });
    const r = await ok(deliver(env));
    await expectMoved(s, before, [0, 3], r);
    const rel = await releasesOf(s.orderId);
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ report_kind: 'partial' });
    expect([...rel[0].order_item_ids].sort()).toEqual([...ids].sort());
  });

  it('partial WITHOUT order_item_ids: release recorded (order_item_ids NULL), no specimen changes, no event, no reported_at', async () => {
    const s = await scenario(A, MIXED);
    const before = await rowsBefore(s);
    const r = await ok(deliver(envelopeOf(s, { kind: 'partial' })));
    await expectMoved(s, before, [], r);
    const rel = await releasesOf(s.orderId);
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ report_kind: 'partial', order_item_ids: null });
  });

  it('partial listing only a not-approved item: nothing moves', async () => {
    const s = await scenario(A, MIXED);
    const before = await rowsBefore(s);
    const r = await ok(deliver(envelopeOf(s, { kind: 'partial', itemIds: [s.units[2]!.itemId] })));
    await expectMoved(s, before, [], r);
  });
});

describe.skipIf(!live)('T-27 AC-18.3 preliminary: recorded, no S10, no reported_at', () => {
  for (const itemIds of [undefined, 'all'] as const) {
    it(`preliminary ${itemIds ? 'with every item listed' : 'without order_item_ids'}: release row only`, async () => {
      const s = await scenario(A, MIXED);
      const before = await rowsBefore(s);
      const r = await ok(deliver(envelopeOf(s, { kind: 'preliminary', ...(itemIds ? { itemIds: s.units.map((x) => x.itemId) } : {}) })));
      await expectMoved(s, before, [], r);
      for (const x of s.units) expect((await orderTestRow(x.orderTestId)).reported_at).toBeNull();
      const rel = await releasesOf(s.orderId);
      expect(rel).toHaveLength(1);
      expect(rel[0]).toMatchObject({ report_kind: 'preliminary' });
    });
  }
});

describe.skipIf(!live)('T-27 AC-18.2 redelivery: the board and specimens change once', () => {
  it('the same event delivered twice: one release row, one S10 per specimen, one event set; the 2nd delivery succeeds and does nothing', async () => {
    const s = await scenario(A, MIXED);
    const before = await rowsBefore(s);
    const env = envelopeOf(s, { kind: 'final' });
    const r1 = await ok(deliver(env));
    await expectMoved(s, before, [0, 1, 3], r1);
    const after1 = await snapshot(s);
    const r2 = await ok(deliver(env));
    expect(r2.events).toHaveLength(0);
    expect(await snapshot(s)).toBe(after1);
    for (const i of [0, 1, 3]) expect((await transitionsOf(s.units[i]!.id)).filter((t) => t.transition_code === 'S10')).toHaveLength(1);
  });

  it('the same report_id + version_no under a NEW event_id (producer re-emit) changes nothing more', async () => {
    const s = await scenario(A, MIXED);
    const first = envelopeOf(s, { kind: 'final' });
    await ok(deliver(first));
    const after1 = await snapshot(s);
    const r = await ok(deliver(envelopeOf(s, { kind: 'final', reportId: first.payload.report_id, version: 1 })));
    expect(r.events).toHaveLength(0);
    expect(await snapshot(s)).toBe(after1);
    expect(await releasesOf(s.orderId)).toHaveLength(1);
  });

  it('two deliveries racing on the same specimens: exactly one S10 per specimen (row lock / unique release key)', async () => {
    const s = await scenario(A, ['approved', 'approved']);
    const env = envelopeOf(s, { kind: 'final' });
    const [x, y] = await Promise.all([deliver(env), deliver(env)]);
    for (const r of [x, y]) if (r.error) expect(r.error).toBeInstanceOf(Error);   // a serialization failure is retried by the worker; a double write is not allowed
    const total = statusEvents(x.events).length + statusEvents(y.events).length;
    expect(total).toBeLessThanOrEqual(2);
    for (const u0 of s.units) expect((await transitionsOf(u0.id)).filter((t) => t.transition_code === 'S10')).toHaveLength(1);
    expect(await releasesOf(s.orderId)).toHaveLength(1);
  });

  it('an OLDER version_no of a report delivered after a newer one moves nothing', async () => {
    const s = await scenario(A, MIXED);
    const reportId = u(0x7fff);
    await ok(deliver(envelopeOf(s, { kind: 'amended', reportId, version: 2 })));
    const after = await snapshot(s);
    const r = await ok(deliver(envelopeOf(s, { kind: 'final', reportId, version: 1 })));
    expect(r.events).toHaveLength(0);
    for (const i of [0, 1, 3]) {
      expect((await specimenRow(s.units[i]!.id)).version).toBe(8);
      expect((await transitionsOf(s.units[i]!.id)).filter((t) => t.transition_code === 'S10')).toHaveLength(1);
    }
    expect((await releasesOf(s.orderId)).filter((x) => x.version_no === 2)).toHaveLength(1);   // the newer release stays as it was
    expect(JSON.parse(after)[1]).toBe(1);
  });

  it('a later amended version of a new report for the same order records a second release and does not move reported specimens again', async () => {
    const s = await scenario(A, ['approved', 'approved']);
    await ok(deliver(envelopeOf(s, { kind: 'final', version: 1, reportId: u(0x7ffe) })));
    const r = await ok(deliver(envelopeOf(s, { kind: 'amended', version: 2, reportId: u(0x7ffe) })));
    expect(r.events).toHaveLength(0);
    expect((await releasesOf(s.orderId)).map((x) => [x.version_no, x.report_kind])).toEqual([[1, 'final'], [2, 'amended']]);
    for (const x of s.units) expect(await specimenRow(x.id)).toMatchObject({ status: 'reported', version: 8 });
  });
});

describe.skipIf(!live)('T-27 one transaction: a failure leaves nothing half-applied', () => {
  for (const failAt of [0, 1, 2]) {
    it(`the event bus failing at publish #${failAt + 1} rejects the handler and (after the caller's rollback) no release row, no S10, no reported_at remain`, async () => {
      const s = await scenario(A, ['approved', 'approved', 'approved']);
      const before = await snapshot(s);
      const r = await deliver(envelopeOf(s, { kind: 'final' }), A, { failEventAt: failAt });
      expect(r.error, 'a publish failure must propagate (retry / dead letter), never be swallowed').toBeInstanceOf(Error);
      expect(await snapshot(s)).toBe(before);
      expect(await releasesOf(s.orderId)).toHaveLength(0);
      for (const x of s.units) expect((await specimenRow(x.id)).status).toBe('approved');
    });
  }
});

describe.skipIf(!live)('T-27 tenant isolation (REQ-SEC-024, 07-SECURITY P-11)', () => {
  it('a tenant-A event naming a tenant-B order id changes no tenant-B row, records no release for it and emits nothing for it', async () => {
    const a = await scenario(A, ['approved']);
    const b = await scenario(B, ['approved', 'approved']);
    const beforeB = await snapshot(b);
    const r = await deliver(envelopeOf(a, { kind: 'final', orderId: b.orderId, itemIds: b.units.map((x) => x.itemId) }));
    if (r.error) expect(r.error).toBeInstanceOf(Error);          // skip or dead letter are both fine (P-11: "as the consumer defines")
    expect(await snapshot(b)).toBe(beforeB);
    expect(JSON.stringify(r.events)).not.toContain(b.units[0]!.id);
    expect(await sql('SELECT 1 FROM lab.report_releases WHERE order_id = $1', [b.orderId])).toHaveLength(0);
    expect(await sql('SELECT 1 FROM lab.specimen_transitions WHERE specimen_id = ANY($1)', [b.units.map((x) => x.id)])).toHaveLength(0);
  });

  it('a tenant-A event naming tenant-B ORDER ITEM ids on an A order moves nothing', async () => {
    const a = await scenario(A, ['approved']);
    const b = await scenario(B, ['approved']);
    const beforeA = await rowsBefore(a); const beforeB = await snapshot(b);
    const r = await ok(deliver(envelopeOf(a, { kind: 'final', itemIds: [b.units[0]!.itemId] })));
    await expectMoved(a, beforeA, [], r);
    expect(await snapshot(b)).toBe(beforeB);
  });

  it('an envelope of tenant B delivered on a tenant-A job is refused before any write', async () => {
    const a = await scenario(A, ['approved']);
    const b = await scenario(B, ['approved']);
    const beforeA = await snapshot(a); const beforeB = await snapshot(b);
    const r = await deliver(envelopeOf(b, { kind: 'final' }), A);
    expect(r.error).toBeInstanceOf(Error);
    expect(r.events).toHaveLength(0);
    expect(await snapshot(a)).toBe(beforeA);
    expect(await snapshot(b)).toBe(beforeB);
  });
});
