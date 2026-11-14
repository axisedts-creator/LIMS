// C5 T-09 — home-collection consumer contract against the migrated database (06 row T-09; 02-TRD §7.2 row 8, §3.2; 03-APP-FLOW S2/S3;
// PRD AC-03.2, AC-03.2a (08 A19 D-120); 07-SECURITY P-11, REQ-SEC-024). Needs the DB that tests/db/c5-t03/run.sh starts (see .orchestra/notes/C5.T-09-verify.cmd):
// LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1.
// Lives in services/api so it runs with the package's vitest setup and `pg`; the consumer under test is the worker file, imported by relative path.
//
// SEAMS (spec fixes behaviour, not names) — the writer implements services/worker/src/jobs/lab/consumers/homecollection.collection.synced.v1.ts exporting
//   `handle(envelope, jobCtx): Promise<void>` (ConsumerHandler). envelope = { event_id, event_type, tenant_id, aggregate: { type: 'home_visit', id: visit_id, seq }, payload (03-IC §3.23) }.
//   jobCtx = worker JobContext: { tenantId, actor: { type: 'system', id }, requestId, tx (lims_api client, claims set, ONE job transaction), now(): ISO string,
//   events: { publish(ctx, type, { aggregate, idempotencyKey, payload }) }, ports.IdentityPort.getTenantSettings, log }. Runs in the caller's tx: any throw = the caller rolls back.
// BEHAVIOUR (PRD AC-03.2): per collection whose specimen is `ordered` (and active) -> S2 then S3 (ordered -> collected -> in_transit), specimen version +2, two specimen_transitions rows
//   (S2 v2, S3 v3, actor system), two lab.specimen.status_changed.v1 events (key `<id>:<to>:<version>`), collected_at = min(collected_at_device, synced_at), collected_at_device = raw device
//   time, collected_via_visit_id = visit_id, collection_barcode_unverified = !barcode_verified, in_transit_at set, the order test -> awaiting_receipt (02-TRD §3.3, as manual collect).
//   Specimens not in `ordered` (or inactive, unknown, or of another tenant) are skipped without a write or an event and without failing the event (TRD: "skip ... log outcome").
//   booking_id is ignored (AC-03.2a); `payments[]` belongs to C4 and is ignored.
// ASSUMED (spec silent): in_transit_at = ctx.now() (the consumer's clock) and must be >= collected_at; collected_by_membership_id not asserted; a collection of a specimen of another order than
//   payload.order_id is NOT rejected (TRD: "matches specimens by barcode/specimen id only"); an inactive `ordered` specimen is skipped (state machine blocks S2 when inactive).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { handle } from '../../../../../../worker/src/jobs/lab/consumers/homecollection.collection.synced.v1.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEM = '01a1a98a-ac40-7000-8000-00000000a500';
const BRANCH = { [A]: '01a1a98a-ac40-7000-8000-00000000a101', [B]: '01a1a98a-ac40-7000-8000-00000000b101' } as Record<string, string>;
const CENTRE = { [A]: '01a1a98a-ac40-7000-8000-00000000a201', [B]: '01a1a98a-ac40-7000-8000-00000000b201' } as Record<string, string>;
const u = (n: number) => `0190c609-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PATIENT = { [A]: u(0xa9), [B]: u(0xb9) } as Record<string, string>;
const NOW = '2026-06-15T05:00:30.000Z';
const SYNCED_AT = '2026-06-15T05:00:00.000Z';
const DEVICE_OK = '2026-06-15T04:50:00.000Z';
const iso = (d: unknown) => new Date(d as string | Date).toISOString();
const STATUS_EVENT_KEYS = new Set(Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'events', 'lab.specimen.status_changed.v1.schema.json'), 'utf8'))['$defs'].Payload.properties));

// ------------------------------------------------------------------ database helpers (same technique as the T-06/T-07 suites)
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
let nextId = 0x3000;
let barcodeN = Date.now() % 90_000_000;
interface Seeded { id: string; barcode: string; orderTestId: string; resultId: string }
interface Scen { tenant: string; orderId: string; specimens: Seeded[] }

/** frontdesk order + items -> lab.orders -> one specimen (+ 1 order test + 1 pending result) per requested status. */
async function scenario(tenant: string, statuses: { status: string; active?: boolean }[]): Promise<Scen> {
  const orderId = u(nextId++);
  const centre = CENTRE[tenant]!;
  const branch = BRANCH[tenant]!;
  const out: Scen = { tenant, orderId, specimens: [] };
  await asAdmin(tenant, async (c) => {
    await ins(c, 'frontdesk.orders', { id: orderId, tenant_id: tenant, branch_id: branch, centre_id: centre, patient_id: PATIENT[tenant], registration_no: `RT09${orderId.slice(-6).toUpperCase()}`,
      status: 'registered', visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'home', source: 'front_desk', is_first_order_of_patient: false, catalog_revision: 1,
      registered_at: '2026-06-15T03:00:00.000Z' });
    await ins(c, 'lab.orders', { id: orderId, tenant_id: tenant, centre_id: centre, branch_id: branch, patient_id: PATIENT[tenant], registration_no: `RT09${orderId.slice(-6).toUpperCase()}`,
      visit_type: 'opd', priority: 'routine', collection_mode: 'home', source: 'front_desk', registered_at: '2026-06-15T03:00:00.000Z', patient_sex: 'female', patient_age_days: 10950,
      lab_status: 'active', last_order_seq: 1, items_version: 1 });
    for (const [i, s] of statuses.entries()) {
      const id = u(nextId++); const itemId = u(nextId++); const orderTestId = u(nextId++); const resultId = u(nextId++); const testId = u(nextId++);
      const barcode = `T9${String(barcodeN++).padStart(8, '0')}`;
      await ins(c, 'frontdesk.order_items', { id: itemId, tenant_id: tenant, order_id: orderId, centre_id: centre, orderable_id: u(nextId++), orderable_kind: 'test', code: `T9${i}`, name: `T9${i} (SYNTHETIC)`,
        test_ids: [testId], priority: 'routine', unit_price_paisa: 1000, price_list_id: u(0x98), price_list_version: 1, price_source: 'tenant_default', vat_treatment: 'exempt', added_in_items_version: 1 });
      const st = s.status;
      const received = ['received', 'in_process'].includes(st);
      await ins(c, 'lab.specimens', { id, tenant_id: tenant, centre_id: centre, order_id: orderId, patient_id: PATIENT[tenant], barcode, creation_key: `${orderId}:WB:EDTA:${i}`,
        specimen_type_code: 'WB', container_code: 'EDTA', priority: 'routine', patient_sex: 'female', patient_age_days: 10950, status: st, ordered_at: '2026-06-15T03:00:00.000Z',
        ...(st !== 'ordered' ? { collected_at: '2026-06-15T04:10:00.000Z', collected_by_membership_id: MEM } : {}),
        ...(st === 'in_transit' ? { in_transit_at: '2026-06-15T04:20:00.000Z' } : {}),
        ...(received ? { received_at: '2026-06-15T04:30:00.000Z', received_by_membership_id: MEM, processing_centre_id: centre, processing_branch_id: branch } : {}),
        ...(st === 'rejected' ? { rejected_at: '2026-06-15T04:40:00.000Z', rejection_reason_code: 'HEMOLYZED', rejection_comment: 'Synthetic comment' } : {}),
        is_active: s.active ?? true });
      await ins(c, 'lab.order_tests', { id: orderTestId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, test_id: testId, test_code: `T9${i}`, test_revision: 1, catalog_revision: 1,
        department_id: u(0x901), workflow_type: 'standard', priority: 'routine', specimen_id: id, status: st === 'ordered' ? 'awaiting_collection' : received ? 'in_process' : 'awaiting_receipt',
        ordered_at: '2026-06-15T03:00:00.000Z', ...(received ? { received_at: '2026-06-15T04:30:00.000Z', processing_centre_id: centre, processing_branch_id: branch } : {}) });
      await ins(c, 'lab.results', { id: resultId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, order_test_id: orderTestId, specimen_id: id, patient_id: PATIENT[tenant],
        test_id: testId, analyte_id: u(nextId++), analyte_code: `T9${i}A`, department_id: u(0x901), is_reportable: true, result_type: 'numeric', status: 'pending' });
      out.specimens.push({ id, barcode, orderTestId, resultId });
    }
  });
  return out;
}
const specimenRow = async (id: string) => (await sql('SELECT * FROM lab.specimens WHERE id = $1', [id]))[0];
const transitionsOf = (id: string) => sql('SELECT * FROM lab.specimen_transitions WHERE specimen_id = $1 ORDER BY specimen_version', [id]);
const orderTestRow = async (id: string) => (await sql('SELECT * FROM lab.order_tests WHERE id = $1', [id]))[0];
const snapshot = async (s: Scen) => JSON.stringify(await Promise.all(s.specimens.map(async (x) => [await specimenRow(x.id), await transitionsOf(x.id), await orderTestRow(x.orderTestId)])));

// ------------------------------------------------------------------ driving the consumer
type Pub = { type: string; input: any };
interface Collection { specimen: string; verified?: boolean; device?: string }
interface Over { visitId?: string; bookingId?: string | null; syncedAt?: string; collections?: Collection[]; payments?: unknown[]; tenantOfEnvelope?: string; failEventAt?: number }
let seq = 0;
const envelopeOf = (s: Scen, cols: Collection[], o: Over = {}) => {
  const visit = o.visitId ?? u(0x7000 + seq);
  return { event_id: u(0x6000 + seq++), event_type: 'homecollection.collection.synced.v1', tenant_id: o.tenantOfEnvelope ?? s.tenant, producer: 'homecollection',
    occurred_at: NOW, aggregate: { type: 'home_visit', id: visit, seq: 3 }, idempotency_key: `${visit}:sync:${seq}`,
    payload: { visit_id: visit, order_id: s.orderId, phlebotomist_membership_id: MEM, ...(o.bookingId ? { booking_id: o.bookingId } : {}), synced_at: o.syncedAt ?? SYNCED_AT,
      collections: cols.map((c) => ({ client_mutation_id: u(0x5000 + seq++), specimen_id: c.specimen, barcode_verified: c.verified ?? true, collected_at_device: c.device ?? DEVICE_OK })),
      payments: o.payments ?? [] } };
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

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 8 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await asAdmin(t, (c) => ins(c, 'frontdesk.patients', { id: PATIENT[t], tenant_id: t, patient_code: 'P-T09', full_name: 'Test Patient T09', name_search: 'test patient t09',
    sex: 'female', registered_centre_id: CENTRE[t] }));
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-09 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

describe.skipIf(!live)('T-09 AC-03.2 ordered -> collected -> in_transit in one transaction', () => {
  it('S2 + S3: version +2, two transition rows, two status events, collected_via_visit_id, device time, order test awaiting_receipt', async () => {
    const s = await scenario(A, [{ status: 'ordered' }]);
    const x = s.specimens[0]!;
    const env = envelopeOf(s, [{ specimen: x.id, verified: true, device: DEVICE_OK }]);
    const r = await ok(deliver(env));
    const row = await specimenRow(x.id);
    expect(row).toMatchObject({ status: 'in_transit', version: 3, collected_via_visit_id: env.payload.visit_id, collection_barcode_unverified: false, is_active: true });
    expect(iso(row.collected_at)).toBe(DEVICE_OK);
    expect(iso(row.collected_at_device)).toBe(DEVICE_OK);
    expect(row.in_transit_at).not.toBeNull();
    expect(new Date(row.in_transit_at).getTime()).toBeGreaterThanOrEqual(new Date(row.collected_at).getTime());
    const tr = await transitionsOf(x.id);
    expect(tr.map((t) => [t.transition_code, t.from_status, t.to_status, t.specimen_version])).toEqual([['S2', 'ordered', 'collected', 2], ['S3', 'collected', 'in_transit', 3]]);
    for (const t of tr) expect(t).toMatchObject({ actor_type: 'system', actor_id: SYS });
    expect((await orderTestRow(x.orderTestId)).status).toBe('awaiting_receipt');
    const ev = statusEvents(r.events);
    expect(ev).toHaveLength(2);
    expect(r.events).toHaveLength(2);
    expect(ev.map((e) => [e.input.payload.from_status, e.input.payload.to_status])).toEqual([['ordered', 'collected'], ['collected', 'in_transit']]);
    expect(ev.map((e) => e.input.idempotencyKey)).toEqual([`${x.id}:collected:2`, `${x.id}:in_transit:3`]);
    expect(ev.map((e) => e.input.aggregate)).toEqual([{ type: 'specimen', id: x.id, seq: 2 }, { type: 'specimen', id: x.id, seq: 3 }]);
    for (const e of ev) {
      expect(e.input.payload).toMatchObject({ specimen_id: x.id, order_id: s.orderId, patient_id: PATIENT[A], centre_id: CENTRE[A], specimen_type_code: 'WB' });
      for (const k of Object.keys(e.input.payload)) expect(STATUS_EVENT_KEYS.has(k), `payload key ${k} is not in the event schema`).toBe(true);
      expect(JSON.stringify(e.input.payload)).not.toContain(x.barcode);
    }
  });

  it('several collections in one event: each ordered specimen is processed, payments[] is ignored (C4 owns it)', async () => {
    const s = await scenario(A, [{ status: 'ordered' }, { status: 'ordered' }, { status: 'ordered' }]);
    const env = envelopeOf(s, s.specimens.map((x) => ({ specimen: x.id })), { payments: [{ client_mutation_id: u(0x4000), payment_method_code: 'cash', amount: { amount_paisa: 1000, currency: 'NPR' }, captured_at_device: DEVICE_OK }] });
    const r = await ok(deliver(env));
    for (const x of s.specimens) expect(await specimenRow(x.id)).toMatchObject({ status: 'in_transit', version: 3 });
    expect(r.events).toHaveLength(6);
    expect(statusEvents(r.events)).toHaveLength(6);
  });

  describe('device time is clamped to synced_at', () => {
    for (const [name, device, expected] of [
      ['device ahead of synced_at -> collected_at = synced_at', '2026-06-15T09:00:00.000Z', SYNCED_AT],
      ['device equal to synced_at -> unchanged', SYNCED_AT, SYNCED_AT],
      ['device before synced_at -> unchanged', '2026-06-15T01:00:00.000Z', '2026-06-15T01:00:00.000Z'],
    ] as const) {
      it(name, async () => {
        const s = await scenario(A, [{ status: 'ordered' }]);
        const x = s.specimens[0]!;
        const r = await ok(deliver(envelopeOf(s, [{ specimen: x.id, device }])));
        const row = await specimenRow(x.id);
        expect(iso(row.collected_at)).toBe(expected);
        expect(iso(row.collected_at_device)).toBe(device);
        const tr = await transitionsOf(x.id);
        expect(iso(tr[0].occurred_at)).toBe(expected);
        expect(statusEvents(r.events)[0]!.input.payload.changed_at).toBe(expected);
        expect(new Date(row.in_transit_at).getTime()).toBeGreaterThanOrEqual(new Date(row.collected_at).getTime());
      });
    }
  });

  describe('collection_barcode_unverified', () => {
    for (const [verified, flag] of [[false, true], [true, false]] as const) {
      it(`barcode_verified = ${verified} -> collection_barcode_unverified = ${flag}`, async () => {
        const s = await scenario(A, [{ status: 'ordered' }, { status: 'ordered' }]);
        await ok(deliver(envelopeOf(s, [{ specimen: s.specimens[0]!.id, verified }, { specimen: s.specimens[1]!.id, verified: !verified }])));
        expect((await specimenRow(s.specimens[0]!.id)).collection_barcode_unverified).toBe(flag);
        expect((await specimenRow(s.specimens[1]!.id)).collection_barcode_unverified).toBe(!flag);
      });
    }
  });
});

describe.skipIf(!live)('T-09 AC-03.2a optional booking_id is tolerated and ignored (08 A19 D-120)', () => {
  const normalise = (x: unknown) => JSON.stringify(x, (k, v) => (['id', 'specimen_id', 'barcode', 'creation_key', 'order_id', 'order_test_id', 'result_id', 'created_at', 'updated_at', 'collected_via_visit_id', 'idempotencyKey', 'client_mutation_id'].includes(k) ? undefined : v));
  const outcome = async (s: Scen, r: { events: Pub[] }) => normalise({ spec: await Promise.all(s.specimens.map(async (x) => [await specimenRow(x.id), await transitionsOf(x.id)])),
    events: r.events.map((e) => [e.type, e.input.payload, e.input.aggregate.seq]) });

  it('the same event with and without booking_id gives the same specimens, transitions and events; the booking id is stored nowhere', async () => {
    const without = await scenario(A, [{ status: 'ordered' }, { status: 'ordered' }]);
    const withBk = await scenario(A, [{ status: 'ordered' }, { status: 'ordered' }]);
    const BOOKING = u(0xb00c);
    const cols = (s: Scen): Collection[] => [{ specimen: s.specimens[0]!.id, verified: false }, { specimen: s.specimens[1]!.id, verified: true, device: '2026-06-15T09:00:00.000Z' }];
    const r1 = await ok(deliver(envelopeOf(without, cols(without))));
    const r2 = await ok(deliver(envelopeOf(withBk, cols(withBk), { bookingId: BOOKING })));
    // order tests/specimens differ only in generated ids, which normalise() drops
    expect(await outcome(withBk, r2)).toBe(await outcome(without, r1));
    expect(JSON.stringify(r2.events)).not.toContain(BOOKING);
    for (const x of withBk.specimens) expect(JSON.stringify([await specimenRow(x.id), await transitionsOf(x.id), await orderTestRow(x.orderTestId)])).not.toContain(BOOKING);
    expect(r2.events.every((e) => e.input.payload.booking_id === undefined)).toBe(true);
  });

  it('a booking_id of a visit whose specimens are already collected changes nothing (skip, no error)', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    const before = await snapshot(s);
    const r = await ok(deliver(envelopeOf(s, [{ specimen: s.specimens[0]!.id }], { bookingId: u(0xb00d) })));
    expect(r.events).toHaveLength(0);
    expect(await snapshot(s)).toBe(before);
  });
});

describe.skipIf(!live)('T-09 specimens that cannot move are skipped (02-TRD §7.2: "skip specimens not in ordered, log outcome")', () => {
  for (const status of ['collected', 'in_transit', 'received', 'rejected']) {
    it(`a specimen in ${status}: no write, no event, no failure`, async () => {
      const s = await scenario(A, [{ status }]);
      const before = await snapshot(s);
      const r = await ok(deliver(envelopeOf(s, [{ specimen: s.specimens[0]!.id, verified: false, device: '2026-06-15T01:00:00.000Z' }])));
      expect(r.events).toHaveLength(0);
      expect(await snapshot(s)).toBe(before);
    });
  }

  it('an inactive ordered specimen is skipped (ASSUMED: the state machine blocks S2 while inactive)', async () => {
    const s = await scenario(A, [{ status: 'ordered', active: false }]);
    const before = await snapshot(s);
    const r = await ok(deliver(envelopeOf(s, [{ specimen: s.specimens[0]!.id }])));
    expect(r.events).toHaveLength(0);
    expect(await snapshot(s)).toBe(before);
  });

  it('an unknown specimen id is skipped and does not stop the other collections of the event', async () => {
    const s = await scenario(A, [{ status: 'ordered' }]);
    const r = await ok(deliver(envelopeOf(s, [{ specimen: u(0xdead) }, { specimen: s.specimens[0]!.id }])));
    expect(await specimenRow(s.specimens[0]!.id)).toMatchObject({ status: 'in_transit', version: 3 });
    expect(statusEvents(r.events)).toHaveLength(2);
  });

  it('a mixed event moves only the ordered specimen', async () => {
    const s = await scenario(A, [{ status: 'received' }, { status: 'ordered' }]);
    const recvBefore = JSON.stringify(await specimenRow(s.specimens[0]!.id));
    const r = await ok(deliver(envelopeOf(s, s.specimens.map((x) => ({ specimen: x.id })))));
    expect(JSON.stringify(await specimenRow(s.specimens[0]!.id))).toBe(recvBefore);
    expect(await specimenRow(s.specimens[1]!.id)).toMatchObject({ status: 'in_transit', version: 3 });
    expect(statusEvents(r.events)).toHaveLength(2);
  });

  it('re-delivery of the same event (replay after the first success) changes nothing more: no extra rows, no extra events', async () => {
    const s = await scenario(A, [{ status: 'ordered' }]);
    const env = envelopeOf(s, [{ specimen: s.specimens[0]!.id }]);
    await ok(deliver(env));
    const after1 = await snapshot(s);
    const r2 = await ok(deliver(env));
    expect(r2.events).toHaveLength(0);
    expect(await snapshot(s)).toBe(after1);
    expect(await transitionsOf(s.specimens[0]!.id)).toHaveLength(2);
  });
});

describe.skipIf(!live)('T-09 one transaction: a failure leaves nothing half-applied', () => {
  for (const failAt of [0, 1, 3]) {
    it(`the event bus failing at publish #${failAt + 1} rejects the handler and (after the caller's rollback) every specimen is still ordered`, async () => {
      const s = await scenario(A, [{ status: 'ordered' }, { status: 'ordered' }]);
      const before = await snapshot(s);
      const r = await deliver(envelopeOf(s, s.specimens.map((x) => ({ specimen: x.id }))), A, { failEventAt: failAt });
      expect(r.error, 'a publish failure must propagate (retry / dead letter), never be swallowed').toBeInstanceOf(Error);
      expect(await snapshot(s)).toBe(before);
      for (const x of s.specimens) expect((await specimenRow(x.id)).status).toBe('ordered');
    });
  }
});

describe.skipIf(!live)('T-09 tenant isolation (REQ-SEC-024, 07-SECURITY P-11)', () => {
  it('a tenant-A event naming a tenant-B specimen id changes no tenant-B row and emits nothing for it; the A specimen of the same event is processed', async () => {
    const a = await scenario(A, [{ status: 'ordered' }]);
    const b = await scenario(B, [{ status: 'ordered' }]);
    const beforeB = await snapshot(b);
    const r = await deliver(envelopeOf(a, [{ specimen: b.specimens[0]!.id }, { specimen: a.specimens[0]!.id }]));
    if (r.error) expect(r.error).toBeInstanceOf(Error);          // dead letter is an acceptable outcome (P-11: "as the consumer defines")
    expect(await snapshot(b)).toBe(beforeB);
    expect(JSON.stringify(r.events)).not.toContain(b.specimens[0]!.id);
    expect(await sql('SELECT 1 FROM lab.specimen_transitions WHERE specimen_id = $1', [b.specimens[0]!.id])).toHaveLength(0);
  });

  it('an envelope of tenant B delivered on a tenant-A job is refused before any write', async () => {
    const a = await scenario(A, [{ status: 'ordered' }]);
    const b = await scenario(B, [{ status: 'ordered' }]);
    const beforeA = await snapshot(a); const beforeB = await snapshot(b);
    const r = await deliver(envelopeOf(b, [{ specimen: b.specimens[0]!.id }, { specimen: a.specimens[0]!.id }]), A);
    expect(r.error).toBeInstanceOf(Error);
    expect(r.events).toHaveLength(0);
    expect(await snapshot(a)).toBe(beforeA);
    expect(await snapshot(b)).toBe(beforeB);
  });
});
