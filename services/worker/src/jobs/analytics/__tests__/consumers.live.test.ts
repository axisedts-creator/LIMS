// AN-T05 live-DB check of the consumers' real SQL (order_index upsert / cancel-before-create placeholder / markDirty / bd() in Postgres), 02-TRD §8.2.
// Gated like analytics refresh.live.test.ts: skipped unless LIMS_TEST_DATABASE_URL (superuser, migrated + seeded) and LIMS_TEST_APP_DATABASE_URL (may SET ROLE lims_app) are set.
// The handler runs through createDb().requestTx as the analytics system actor, tenant A. Synthetic ids only; rows it creates are removed afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../../../../api/src/core/db/tx.js';
import { manifest } from '../index.js';

const SU = process.env['LIMS_TEST_DATABASE_URL'], APP = process.env['LIMS_TEST_APP_DATABASE_URL'];
const TA = '01a1a98a-ac40-7000-8000-00000000a001';
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const CLAIMS = { actor_type: 'system', tenant_id: TA, sub: SYS, membership_id: MEMBERSHIP };
const uid = (n: number) => `0190c405-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ORDER_NEW = uid(5001), ORDER_LATE = uid(5002), INVOICE = uid(5003), CENTRE = uid(5004), BRANCH = uid(5005);

describe.skipIf(!SU || !APP)('analytics consumers over a real DB', () => {
  let su: any, app: any, db: ReturnType<typeof createDb>;
  let reqN = 5000, evN = 6000;
  const env = (type: string, producer: string, agg: string, aggId: string, payload: Record<string, unknown>) => ({
    event_id: uid(++evN), event_type: type, tenant_id: TA, occurred_at: new Date().toISOString(), actor: { type: 'user', id: uid(1) }, idempotency_key: `${type}:${evN}`,
    producer, aggregate: { type: agg, id: aggId, seq: 1 }, request_id: uid(2), payload,
  });
  const deliver = (type: string, ev: unknown) => db.requestTx(
    { claims: CLAIMS as never, requestId: uid(++reqN), clientIp: '203.0.113.7', operation: { module: 'analytics', operationId: 'AN-T05.live' } },
    async (tx: any) => {
      const ctx: any = { tenantId: TA, actor: { type: 'system', id: SYS }, requestId: uid(reqN), jobId: '1', attempt: 1, maxAttempts: 10, tx, now: () => new Date().toISOString(), isNewer: () => true,
        log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } };
      ctx.db = { tx: async (fn: any) => fn(ctx) };
      await manifest.subscriptions![type]!(ev, ctx);
    });
  const dirty = async () => (await su.query(`SELECT family || '@' || business_date::text AS m FROM analytics.dirty_partitions WHERE tenant_id = $1 ORDER BY 1`, [TA])).rows.map((r: any) => r.m as string);
  const order = async (o: string) => (await su.query(
    `SELECT centre_id::text, registered_at, registered_on::text AS registered_on, cancelled_at, source_event_id::text AS source_event_id, created_by::text AS created_by,
            expires_at, (expires_at - coalesce(registered_at, now()))::text AS ttl FROM analytics.order_index WHERE tenant_id = $1 AND order_id = $2`, [TA, o])).rows[0];
  const cleanup = async () => {
    await su.query(`DELETE FROM analytics.order_index WHERE tenant_id = $1 AND order_id = ANY($2)`, [TA, [ORDER_NEW, ORDER_LATE]]);
    await su.query(`DELETE FROM analytics.dirty_partitions WHERE tenant_id = $1`, [TA]);
  };

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    su = new Pool({ connectionString: SU, max: 2 }); app = new Pool({ connectionString: APP, max: 4 });
    db = createDb({ pool: app, identitySystemActorId: SYS });
    await cleanup();
  });
  afterAll(async () => { if (su) await cleanup().catch(() => undefined); await su?.end(); await app?.end(); });

  it('invoice.issued at 18:14:59.999Z / 18:15:00.000Z: Postgres buckets them on 11-05 / 11-06; a re-delivery adds no row', async () => {
    const mk = (ts: string) => env('billing.invoice.issued.v1', 'billing', 'invoice', INVOICE, { invoice_id: INVOICE, invoice_no: 'INV-1', fiscal_year_bs: '2083/84', invoice_kind: 'tax_invoice', branch_id: BRANCH, issued_at: ts, totals: {} });
    const a = mk('2026-11-05T18:14:59.999Z'), b = mk('2026-11-05T18:15:00.000Z');
    await deliver('billing.invoice.issued.v1', a); await deliver('billing.invoice.issued.v1', a); await deliver('billing.invoice.issued.v1', b);
    const fams = ['department_income', 'income', 'referrer_billing'];
    expect(await dirty()).toEqual(['2026-11-05', '2026-11-06'].flatMap((d) => fams.map((f) => `${f}@${d}`)).sort());
    expect((await su.query(`SELECT DISTINCT reason, created_by::text AS cb FROM analytics.dirty_partitions WHERE tenant_id = $1`, [TA])).rows).toEqual([{ reason: 'event', cb: SYS }]);
  });

  it('cancel-before-create then create: placeholder is completed in place (ON CONFLICT … WHERE registered_on IS NULL), created_by/expires_at set, a 2nd create changes nothing', async () => {
    await su.query(`DELETE FROM analytics.dirty_partitions WHERE tenant_id = $1`, [TA]);
    const cancel = env('frontdesk.order.cancelled.v1', 'frontdesk', 'order', ORDER_LATE, { order_id: ORDER_LATE, reason_code: 'duplicate_registration', cancelled_at: '2026-11-08T05:00:00.000Z', requires_credit_note: false });
    await deliver('frontdesk.order.cancelled.v1', cancel);
    let r = await order(ORDER_LATE);
    expect(r).toMatchObject({ registered_at: null, registered_on: null, source_event_id: cancel.event_id, created_by: SYS });
    expect(new Date(r.expires_at).getTime()).toBeGreaterThan(Date.now() + 399 * 86_400_000);
    expect(await dirty()).toEqual(['report_backlog@1970-01-01']);

    const create = (extra: Record<string, unknown> = {}) => env('frontdesk.order.created.v1', 'frontdesk', 'order', ORDER_LATE, {
      order_id: ORDER_LATE, patient_id: uid(5010), branch_id: BRANCH, centre_id: CENTRE, visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk',
      registered_at: '2026-11-05T18:15:00.000Z', items: [], ...extra });
    await deliver('frontdesk.order.created.v1', create());
    r = await order(ORDER_LATE);
    expect(r).toMatchObject({ centre_id: CENTRE, registered_on: '2026-11-06', source_event_id: cancel.event_id, created_by: SYS });
    expect(new Date(r.cancelled_at).toISOString()).toBe('2026-11-08T05:00:00.000Z');
    expect(new Date(r.expires_at).toISOString()).toBe('2027-12-10T18:15:00.000Z');          // registered_at + 400 d
    expect(await dirty()).toEqual(['centre_volume@2026-11-06', 'orders@2026-11-06', 'referrer_volume@2026-11-06', 'report_backlog@1970-01-01']);

    const before = JSON.stringify(await order(ORDER_LATE));
    await deliver('frontdesk.order.created.v1', create({ centre_id: uid(5020), registered_at: '2026-11-01T01:00:00.000Z' }));
    expect(JSON.stringify(await order(ORDER_LATE))).toBe(before);
  });

  it('order.created then order.cancelled: cancelled_at set, order families dirtied at the registration day', async () => {
    await su.query(`DELETE FROM analytics.dirty_partitions WHERE tenant_id = $1`, [TA]);
    await deliver('frontdesk.order.created.v1', env('frontdesk.order.created.v1', 'frontdesk', 'order', ORDER_NEW, {
      order_id: ORDER_NEW, patient_id: uid(5010), branch_id: BRANCH, centre_id: CENTRE, visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk',
      registered_at: '2026-11-02T04:20:00.000Z', items: [] }));
    await su.query(`DELETE FROM analytics.dirty_partitions WHERE tenant_id = $1`, [TA]);
    await deliver('frontdesk.order.cancelled.v1', env('frontdesk.order.cancelled.v1', 'frontdesk', 'order', ORDER_NEW, { order_id: ORDER_NEW, reason_code: 'duplicate_registration', cancelled_at: '2026-11-08T05:00:00.000Z', requires_credit_note: false }));
    expect((await order(ORDER_NEW)).cancelled_at).not.toBeNull();
    expect(await dirty()).toEqual(['centre_volume@2026-11-02', 'orders@2026-11-02', 'referrer_volume@2026-11-02', 'report_backlog@1970-01-01']);
  });
});
