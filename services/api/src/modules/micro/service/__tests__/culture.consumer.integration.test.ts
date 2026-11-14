// C10 T-06 — consumer lab.specimen.status_changed.v1 against the migrated database (06 row T-06; 02-TRD §8.2; 03-APP-FLOW §2.1 C1/C9/C10; 05-SCHEMA cultures, culture_transitions,
// cultures_guard, report_versions; PRD AC-01.1–01.9 incl. 01.4a; 07-SECURITY T-C3/T-C4, S-18, S-19).
// Needs a database with the micro DDL + RLS of 05-SCHEMA applied (C0 prerequisite, 06 §1): LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser.
// Without them the DB tests skip, except under LIMS_T06_REQUIRE_DB=1 where "database is provided" fails. (Same harness status as C10 T-05: no micro migration in db/migrations yet.)
// SEAMS: as culture.consumer.test.ts — `onSpecimenStatusChanged(envelope, ctx)` from the worker consumer file; ctx.tx = ONE tx per delivery under RLS (system claims of the ctx tenant),
//   ctx.ports.{LabPort,CatalogPort} = hand-written fakes over the seeded world (the TRD lists @lims/fakes; these are the same two calls with full control), ctx.metrics.inc spy.
// Parent rows (tenant, centre, patient, order, order_item, specimen, catalog test) are seeded by `seedRow`: the admin session inserts the identity columns we know and fills every other
//   NOT NULL column without default from information_schema by type, with session_replication_role = replica (parents' own FKs/triggers ignored). Best effort: a CHECK on a parent
//   table that the type-based filler cannot satisfy is a test-harness problem -> dispute, not a spec failure.
// ASSUMED (spec silent): "audited" (re-point) = the audit.audit_log trigger row for micro.cultures UPDATE with specimen_id in changed_columns (TRD §4.1 "write audited by trigger");
//   a to_status=rejected event with aggregate.seq <= last_specimen_seq is ignored (TRD "per culture aggregate.seq > last_specimen_seq else ignore").
// Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { onSpecimenStatusChanged } from '../../../../../../worker/src/jobs/micro/consumers/lab.specimen.status_changed.v1.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T06_REQUIRE_DB'] === '1';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const RUN = Date.now();
let seqN = 0;
const uid = () => `0190c60b-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
const TYPE = 'lab.specimen.status_changed.v1';
const CHANGED_AT = '2026-11-05T03:20:41.300Z';

let api: pg.Pool;
let admin: pg.Pool;
const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;

/** Insert one parent row as superuser with replica role; unknown NOT NULL/no-default columns are filled by type. */
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
      row[column_name] = udt_name === 'uuid' ? uid() : /^(int|numeric|float)/.test(udt_name) ? 1 : udt_name === 'bool' ? false : udt_name === 'timestamptz' || udt_name === 'timestamp' ? CHANGED_AT
        : udt_name === 'date' ? '2026-11-05' : udt_name === 'jsonb' || udt_name === 'json' ? '{}' : `syn-${seqN}`;
    }
    const keys = Object.keys(row);
    await c.query(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ${onConflict}`, keys.map((k) => row[k]));
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

interface W { tenant: string; centre: string; orderCentre: string; patient: string; order: string; items: { urine: string; blood: string; cbc: string }; tests: { urine: string; blood: string; cbc: string };
  sp: { urine: string; urine2: string; blood: string; parent: string; aliquot: string; old: string; recol: string }; specimens: { specimenId: string; specimenTypeCode: string; status: string }[] }
async function world(tenant = A, o: { specimens?: W['specimens'] } = {}): Promise<W> {
  await seedRow('core.tenants', { id: tenant }, 'ON CONFLICT DO NOTHING');
  const w: W = { tenant, centre: uid(), orderCentre: uid(), patient: uid(), order: uid(), items: { urine: uid(), blood: uid(), cbc: uid() }, tests: { urine: uid(), blood: uid(), cbc: uid() },
    sp: { urine: uid(), urine2: uid(), blood: uid(), parent: uid(), aliquot: uid(), old: uid(), recol: uid() }, specimens: [] };
  for (const id of [w.centre, w.orderCentre]) await seedRow('core.collection_centres', { tenant_id: tenant, id });
  await seedRow('frontdesk.patients', { tenant_id: tenant, id: w.patient });
  await seedRow('frontdesk.orders', { tenant_id: tenant, id: w.order });
  for (const id of Object.values(w.items)) await seedRow('frontdesk.order_items', { tenant_id: tenant, id, order_id: w.order });
  for (const id of Object.values(w.tests)) await seedRow('catalog.tests', { tenant_id: tenant, id });
  for (const id of Object.values(w.sp)) await seedRow('lab.specimens', { tenant_id: tenant, id });
  w.specimens = o.specimens ?? [{ specimenId: w.sp.urine, specimenTypeCode: 'urine', status: 'received' }];
  return w;
}

const TEST_KIND = (w: W): Record<string, { workflowType: string; specimenTypeCodes: string[] }> => ({
  [w.tests.urine]: { workflowType: 'microbiology', specimenTypeCodes: ['urine'] }, [w.tests.blood]: { workflowType: 'microbiology', specimenTypeCodes: ['blood'] },
  [w.tests.cbc]: { workflowType: 'standard', specimenTypeCodes: ['blood'] } });

interface Deliv { seq?: number; eventId?: string; tenant?: string; ctxTenant?: string; metrics?: ReturnType<typeof vi.fn> }
/** One delivery = one committed tx under RLS (claims of the ctx tenant); a throw rolls back, like the C0 consumer wrapper. */
async function deliver(w: W, p: Record<string, unknown>, d: Deliv = {}): Promise<{ metrics: ReturnType<typeof vi.fn> }> {
  const ctxTenant = d.ctxTenant ?? w.tenant;
  const inc = d.metrics ?? vi.fn();
  const items = [w.items.urine, w.items.blood, w.items.cbc].map((orderItemId, i) => ({ orderItemId, testId: [w.tests.urine, w.tests.blood, w.tests.cbc][i]!, departmentId: uid(), results: [] }));
  const kinds = TEST_KIND(w);
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: ctxTenant, sub: SYS, actor_type: 'system' })]);
    const ctx = { tenantId: ctxTenant, actor: { type: 'system', id: SYS }, requestId: uid(), tx: client, metrics: { inc }, now: () => '2026-11-05T03:21:00.000Z',
      isNewer: (l: number | undefined, s: number) => l === undefined || s > l, events: { publish: vi.fn() }, audit: { access: async () => undefined }, log: { info() {}, warn() {}, error() {}, child() { return this; } },
      ports: { LabPort: { getOrderResults: async () => ({ orderId: w.order, specimens: w.specimens, items, approvedSetHash: 'h' }) },
        CatalogPort: { getTest: async (_c: unknown, i: { testId: string }) => ({ id: i.testId, code: 'X', name: 'X', isActive: true, revision: 1, analytes: [], ...kinds[i.testId]! }) } } };
    const seq = d.seq ?? 1;
    const env = { event_id: d.eventId ?? uid(), event_type: TYPE, tenant_id: d.tenant ?? w.tenant, occurred_at: CHANGED_AT, actor: { type: 'system', id: uid() }, idempotency_key: `${p['specimen_id']}:${p['to_status']}:${seq}`,
      producer: 'lab', aggregate: { type: 'specimen', id: p['specimen_id'], seq }, request_id: uid(), payload: p };
    await (onSpecimenStatusChanged as (e: unknown, c: unknown) => Promise<void>)(env, ctx);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return { metrics: inc };
}
const payload = (w: W, o: Record<string, unknown> = {}) => ({ specimen_id: w.sp.urine, order_id: w.order, patient_id: w.patient, centre_id: w.centre, specimen_type_code: 'urine', to_status: 'received',
  changed_at: CHANGED_AT, order_item_ids: [w.items.urine], ...o });

const culturesOf = (w: W, item?: string) => q('SELECT * FROM micro.cultures WHERE tenant_id = $1 AND order_id = $2' + (item ? ' AND order_item_id = $3' : '') + ' ORDER BY created_at, id', item ? [w.tenant, w.order, item] : [w.tenant, w.order]);
const transitionsOf = (cultureId: string) => q('SELECT * FROM micro.culture_transitions WHERE culture_id = $1 ORDER BY created_at, id', [cultureId]);
async function seedCulture(w: W, o: { item?: string; specimen?: string; status?: string; seq?: number; reported?: boolean } = {}): Promise<string> {
  const id = uid(); const status = o.status ?? 'awaiting_setup';
  await seedRow('micro.cultures', { id, tenant_id: w.tenant, centre_id: w.centre, order_id: w.order, order_item_id: o.item ?? w.items.urine, specimen_id: o.specimen ?? w.sp.urine, patient_id: w.patient,
    test_id: w.tests.urine, specimen_type_code: 'urine', status, received_at: CHANGED_AT, last_specimen_seq: o.seq ?? 1, created_by: SYS, updated_by: SYS,
    ...(status === 'final_submitted' ? { outcome_code: 'no_growth' } : {}) });
  if (o.reported) await seedRow('micro.report_versions', { tenant_id: w.tenant, centre_id: w.centre, culture_id: id, order_item_id: o.item ?? w.items.urine, version_no: 1, report_phase: 'preliminary', version_kind: 'initial',
    submission_kind: 'manual', created_by: SYS });
  return id;
}

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 4 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
});
afterAll(async () => { await api?.end(); await admin?.end(); });

describe.skipIf(!live && !REQUIRE)('T-06 consumer lab.specimen.status_changed.v1 (live DB)', () => {
  it('database is provided', () => { expect(live).toBe(true); });

  describe('AC-01.1 received -> culture', () => {
    it('exactly one culture for (item, specimen): awaiting_setup, received_at = changed_at, centre/patient/order/test/specimen_type from event + ports, last_specimen_seq = aggregate.seq; transition ∅ -> awaiting_setup with the same centre', async () => {
      const w = await world();
      await deliver(w, payload(w), { seq: 4 });
      const rows = await culturesOf(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenant_id: w.tenant, order_item_id: w.items.urine, specimen_id: w.sp.urine, status: 'awaiting_setup', centre_id: w.centre, patient_id: w.patient, order_id: w.order,
        test_id: w.tests.urine, specimen_type_code: 'urine', last_specimen_seq: 4, current_report_version_no: 0 });
      expect(new Date(rows[0].received_at).toISOString()).toBe(CHANGED_AT);
      const tr = await transitionsOf(rows[0].id);
      expect(tr).toHaveLength(1);
      expect(tr[0]).toMatchObject({ from_status: null, to_status: 'awaiting_setup', centre_id: w.centre, tenant_id: w.tenant });
    });
    it('a non-micro item and a micro item in order_item_ids: only the micro item gets a culture (AC-01.4 half)', async () => {
      const w = await world();
      await deliver(w, payload(w, { order_item_ids: [w.items.cbc, w.items.urine] }));
      expect((await culturesOf(w)).map((r) => r.order_item_id)).toEqual([w.items.urine]);
    });
  });

  describe('AC-01.2 / AC-01.3 duplicates', () => {
    it('same event delivered twice to the handler: still ONE culture and ONE transition, no error (inbox is the wrapper; the handler is idempotent too)', async () => {
      const w = await world();
      const eventId = uid();
      await deliver(w, payload(w), { eventId });
      await expect(deliver(w, payload(w), { eventId })).resolves.toBeDefined();
      const rows = await culturesOf(w);
      expect(rows).toHaveLength(1);
      expect(await transitionsOf(rows[0].id)).toHaveLength(1);
    });
    it('a second event with a DIFFERENT event_id and the same (order_item_id, specimen_id): no second culture (creation key), consumer succeeds', async () => {
      const w = await world();
      await deliver(w, payload(w), { seq: 2 });
      await expect(deliver(w, payload(w), { seq: 3 })).resolves.toBeDefined();
      expect(await culturesOf(w)).toHaveLength(1);
    });
    it('S-18: concurrent deliveries of the same logical event create exactly one culture', async () => {
      const w = await world();
      await Promise.allSettled([deliver(w, payload(w)), deliver(w, payload(w)), deliver(w, payload(w))]);
      expect(await culturesOf(w)).toHaveLength(1);
    });
  });

  describe('AC-01.4 / AC-01.4a', () => {
    it('only a standard item: no culture row', async () => {
      const w = await world();
      await deliver(w, payload(w, { order_item_ids: [w.items.cbc], specimen_type_code: 'blood' }));
      expect(await culturesOf(w)).toEqual([]);
    });
    it('order_item_ids absent, urine C/S + blood culture on two specimens: the urine specimen -> urine item; the blood specimen -> blood item (one culture each)', async () => {
      const w = await world(A, { specimens: undefined });
      w.specimens = [{ specimenId: w.sp.urine, specimenTypeCode: 'urine', status: 'received' }, { specimenId: w.sp.blood, specimenTypeCode: 'blood', status: 'received' }];
      await deliver(w, payload(w, { order_item_ids: undefined }));
      await deliver(w, payload(w, { order_item_ids: undefined, specimen_id: w.sp.blood, specimen_type_code: 'blood' }));
      const rows = await culturesOf(w);
      expect(rows.map((r) => [r.order_item_id, r.specimen_id]).sort()).toEqual([[w.items.urine, w.sp.urine], [w.items.blood, w.sp.blood]].sort());
    });
    it('order_item_ids absent, two non-rejected urine specimens: no culture + lims_micro_unmapped_received_total', async () => {
      const w = await world();
      w.specimens = [{ specimenId: w.sp.urine, specimenTypeCode: 'urine', status: 'received' }, { specimenId: w.sp.urine2, specimenTypeCode: 'urine', status: 'received' }];
      const { metrics } = await deliver(w, payload(w, { order_item_ids: undefined }));
      expect(await culturesOf(w)).toEqual([]);
      expect(metrics).toHaveBeenCalledWith('lims_micro_unmapped_received_total', expect.objectContaining({ tenant_id: w.tenant }));
    });
  });

  describe('AC-01.5 stale / ordering', () => {
    it('aggregate.seq <= last_specimen_seq is ignored: a rejected event with seq 5 on a culture at last_specimen_seq 5, and seq 3, leave it awaiting_setup', async () => {
      const w = await world();
      const id = await seedCulture(w, { seq: 5 });
      await deliver(w, payload(w, { to_status: 'rejected', from_status: 'received' }), { seq: 5 });
      await deliver(w, payload(w, { to_status: 'rejected', from_status: 'received' }), { seq: 3 });
      const [c] = await q('SELECT status, last_specimen_seq, cancel_reason_code FROM micro.cultures WHERE id = $1', [id]);
      expect(c).toMatchObject({ status: 'awaiting_setup', last_specimen_seq: 5, cancel_reason_code: null });
      expect(await transitionsOf(id)).toEqual([]);
    });
    it('a stale received event does not move last_specimen_seq back and creates nothing', async () => {
      const w = await world();
      const id = await seedCulture(w, { seq: 9 });
      await deliver(w, payload(w), { seq: 2 });
      expect((await q('SELECT last_specimen_seq FROM micro.cultures WHERE id = $1', [id]))[0].last_specimen_seq).toBe(9);
      expect(await culturesOf(w)).toHaveLength(1);
    });
    it('a newer non-received/non-rejected status (resulted, seq 6) only advances last_specimen_seq', async () => {
      const w = await world();
      const id = await seedCulture(w, { status: 'incubating', seq: 2 });
      await deliver(w, payload(w, { to_status: 'resulted', from_status: 'received' }), { seq: 6 });
      expect((await q('SELECT status, last_specimen_seq FROM micro.cultures WHERE id = $1', [id]))[0]).toMatchObject({ status: 'incubating', last_specimen_seq: 6 });
      expect(await transitionsOf(id)).toEqual([]);
    });
  });

  describe('AC-01.6 rejection cancels a non-reported culture', () => {
    for (const status of ['awaiting_setup', 'incubating', 'growth_detected']) {
      it(`${status} + rejected (newer seq): cancelled, cancel_reason_code = specimen_rejected, cancelled_at set, transition ${status} -> cancelled, last_specimen_seq advanced`, async () => {
        const w = await world();
        const id = await seedCulture(w, { status, seq: 1 });
        await deliver(w, payload(w, { to_status: 'rejected', from_status: 'received' }), { seq: 3 });
        const [c] = await q('SELECT status, cancel_reason_code, cancelled_at, last_specimen_seq FROM micro.cultures WHERE id = $1', [id]);
        expect(c).toMatchObject({ status: 'cancelled', cancel_reason_code: 'specimen_rejected', last_specimen_seq: 3 });
        expect(c.cancelled_at).not.toBeNull();
        const tr = await transitionsOf(id);
        expect(tr.at(-1)).toMatchObject({ from_status: status, to_status: 'cancelled', reason_code: 'specimen_rejected', centre_id: w.centre });
      });
    }
    it('rejecting a specimen cancels the cultures of THAT specimen only (a culture of another specimen of the order stays)', async () => {
      const w = await world();
      const a = await seedCulture(w, { item: w.items.urine, specimen: w.sp.urine });
      const b = await seedCulture(w, { item: w.items.blood, specimen: w.sp.blood });
      await deliver(w, payload(w, { to_status: 'rejected', from_status: 'received' }), { seq: 2 });
      expect((await q('SELECT id, status FROM micro.cultures WHERE id = ANY($1)', [[a, b]])).sort((x, y) => (x.id < y.id ? -1 : 1)).map((r) => [r.id, r.status]))
        .toEqual([[a, 'cancelled'], [b, 'awaiting_setup']].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)));
    });
    it('an already cancelled culture + a second rejected event (new seq): unchanged, no second transition, no error', async () => {
      const w = await world();
      const id = await seedCulture(w);
      await deliver(w, payload(w, { to_status: 'rejected' }), { seq: 2 });
      await expect(deliver(w, payload(w, { to_status: 'rejected' }), { seq: 3 })).resolves.toBeDefined();
      expect(await transitionsOf(id)).toHaveLength(1);
    });
  });

  describe('AC-01.7 rejection after a submitted report', () => {
    it('culture with >=1 submitted report version: NOT changed, lims_micro_specimen_rejected_after_report_total +1', async () => {
      const w = await world();
      const id = await seedCulture(w, { status: 'incubating', reported: true });
      const { metrics } = await deliver(w, payload(w, { to_status: 'rejected', from_status: 'received' }), { seq: 5 });
      expect((await q('SELECT status, cancel_reason_code FROM micro.cultures WHERE id = $1', [id]))[0]).toMatchObject({ status: 'incubating', cancel_reason_code: null });
      expect(metrics).toHaveBeenCalledWith('lims_micro_specimen_rejected_after_report_total');
      expect(await transitionsOf(id)).toEqual([]);
    });
    it('final_submitted culture + rejected: unchanged (cancelled/final never overwritten)', async () => {
      const w = await world();
      const id = await seedCulture(w, { status: 'final_submitted', reported: true });
      await deliver(w, payload(w, { to_status: 'rejected' }), { seq: 5 });
      expect((await q('SELECT status FROM micro.cultures WHERE id = $1', [id]))[0].status).toBe('final_submitted');
    });
  });

  describe('AC-01.8 aliquot', () => {
    const aliquot = (w: W, o: Record<string, unknown> = {}) => payload(w, { specimen_id: w.sp.aliquot, parent_specimen_id: w.sp.parent, ...o });
    it('culture (I, P) awaiting_setup: specimen_id re-pointed to the aliquot (audited), last_specimen_seq = aliquot event seq, NO new culture', async () => {
      const w = await world();
      const id = await seedCulture(w, { specimen: w.sp.parent, seq: 2 });
      await deliver(w, aliquot(w), { seq: 8 });
      const rows = await culturesOf(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id, specimen_id: w.sp.aliquot, status: 'awaiting_setup', last_specimen_seq: 8 });
      const audit = await q(`SELECT changed_columns FROM audit.audit_log WHERE tenant_id = $1 AND schema_name = 'micro' AND table_name = 'cultures' AND row_id = $2 AND action = 'UPDATE'`, [w.tenant, id]);
      expect(audit.some((r) => (r.changed_columns as string[]).includes('specimen_id'))).toBe(true);
    });
    it('then a rejected event of the ALIQUOT cancels that culture (AC-01.6)', async () => {
      const w = await world();
      const id = await seedCulture(w, { specimen: w.sp.parent, seq: 2 });
      await deliver(w, aliquot(w), { seq: 8 });
      await deliver(w, payload(w, { specimen_id: w.sp.aliquot, to_status: 'rejected', from_status: 'received' }), { seq: 9 });
      expect((await q('SELECT status, cancel_reason_code FROM micro.cultures WHERE id = $1', [id]))[0]).toMatchObject({ status: 'cancelled', cancel_reason_code: 'specimen_rejected' });
    });
    it('aliquot seq is per-specimen: parent culture seq 5, aliquot event seq 1 still re-points (last_specimen_seq = 1), then aliquot rejected (seq 2) cancels', async () => {
      const w = await world();
      const id = await seedCulture(w, { specimen: w.sp.parent, seq: 5 });
      await deliver(w, aliquot(w), { seq: 1 });
      const rows = await culturesOf(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id, specimen_id: w.sp.aliquot, status: 'awaiting_setup', last_specimen_seq: 1 });
      await deliver(w, payload(w, { specimen_id: w.sp.aliquot, to_status: 'rejected', from_status: 'received' }), { seq: 2 });
      expect((await q('SELECT status, cancel_reason_code FROM micro.cultures WHERE id = $1', [id]))[0]).toMatchObject({ status: 'cancelled', cancel_reason_code: 'specimen_rejected' });
    });
    it('a re-delivered / older aliquot event (seq <= last_specimen_seq) does not re-point again', async () => {
      const w = await world();
      const id = await seedCulture(w, { specimen: w.sp.aliquot, seq: 8 });
      await deliver(w, aliquot(w), { seq: 8 });
      expect(await culturesOf(w)).toHaveLength(1);
      expect((await q('SELECT specimen_id, last_specimen_seq FROM micro.cultures WHERE id = $1', [id]))[0]).toMatchObject({ specimen_id: w.sp.aliquot, last_specimen_seq: 8 });
    });
    for (const status of ['incubating', 'growth_detected', 'final_submitted']) {
      it(`culture left awaiting_setup (${status}): NOTHING changes, no culture is ever created for (I, aliquot), lims_micro_aliquot_after_setup_total +1`, async () => {
        const w = await world();
        const id = await seedCulture(w, { specimen: w.sp.parent, status, seq: 2, reported: status === 'final_submitted' });
        const before = (await q('SELECT * FROM micro.cultures WHERE id = $1', [id]))[0];
        const { metrics } = await deliver(w, aliquot(w), { seq: 8 });
        expect(await culturesOf(w)).toHaveLength(1);
        const after = (await q('SELECT * FROM micro.cultures WHERE id = $1', [id]))[0];
        expect({ specimen_id: after.specimen_id, status: after.status, last_specimen_seq: after.last_specimen_seq }).toEqual({ specimen_id: before.specimen_id, status: before.status, last_specimen_seq: before.last_specimen_seq });
        expect(await q('SELECT 1 FROM micro.cultures WHERE tenant_id = $1 AND specimen_id = $2', [w.tenant, w.sp.aliquot])).toEqual([]);
        expect(metrics).toHaveBeenCalledWith('lims_micro_aliquot_after_setup_total');
      });
    }
    it('aliquot after setup stays inert on a LATER delivery too (still no culture for (I, aliquot))', async () => {
      const w = await world();
      await seedCulture(w, { specimen: w.sp.parent, status: 'incubating' });
      await deliver(w, aliquot(w), { seq: 8 });
      await deliver(w, aliquot(w), { seq: 9 });
      expect(await q('SELECT 1 FROM micro.cultures WHERE tenant_id = $1 AND specimen_id = $2', [w.tenant, w.sp.aliquot])).toEqual([]);
    });
  });

  describe('AC-01.9 recollection', () => {
    it('recollection specimen received for micro item I: a NEW culture for (I, new specimen); the old culture (cancelled by the earlier rejection) is untouched', async () => {
      const w = await world();
      const old = await seedCulture(w, { specimen: w.sp.old, status: 'awaiting_setup', seq: 1 });
      await deliver(w, payload(w, { specimen_id: w.sp.old, to_status: 'rejected', from_status: 'received' }), { seq: 2 });
      const beforeOld = (await q('SELECT status, specimen_id, last_specimen_seq, cancel_reason_code FROM micro.cultures WHERE id = $1', [old]))[0];
      await deliver(w, payload(w, { specimen_id: w.sp.recol, replaces_specimen_id: w.sp.old }), { seq: 1 });
      const rows = await culturesOf(w, w.items.urine);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.specimen_id === w.sp.recol)).toMatchObject({ status: 'awaiting_setup', centre_id: w.centre });
      expect((await q('SELECT status, specimen_id, last_specimen_seq, cancel_reason_code FROM micro.cultures WHERE id = $1', [old]))[0]).toEqual(beforeOld);
    });
  });

  describe('cross-tenant (07 T-C4 / S-19)', () => {
    it('tenant-A envelope carrying tenant-B ids: rejects (dead letter after retries), no row in either tenant, no partial write', async () => {
      const wa = await world(A); const wb = await world(B);
      const err = await deliver(wa, payload(wb), { tenant: A, ctxTenant: A }).then(() => undefined, (e: unknown) => e);
      expect(err, 'composite FKs / port scoping must fail the delivery').toBeDefined();
      expect(await q('SELECT 1 FROM micro.cultures WHERE order_item_id = ANY($1)', [[wb.items.urine, wb.items.blood, wb.items.cbc]])).toEqual([]);
    });
    it('a tenant-B envelope on a tenant-A job writes nothing', async () => {
      const wa = await world(A);
      await deliver(wa, payload(wa), { tenant: B, ctxTenant: A }).catch(() => undefined);
      expect(await culturesOf(wa)).toEqual([]);
    });
    it('RLS: the lims_api session of tenant A sees none of tenant B\'s cultures', async () => {
      const wb = await world(B);
      await deliver(wb, payload(wb));
      const c = await api.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'system' })]);
        expect((await c.query('SELECT 1 FROM micro.cultures WHERE order_id = $1', [wb.order])).rows).toEqual([]);
      } finally { await c.query('ROLLBACK'); c.release(); }
    });
  });
});
