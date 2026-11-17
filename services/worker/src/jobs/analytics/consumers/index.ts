// The 12 analytics event consumers (02-TRD §8.2; PRD US-20.1/20.2). Each handler runs inside the C0 wrapper's tenant tx and only
// (a) maintains analytics.order_index, (b) marks dirty (family, business_date) partitions, (c) enqueues one debounced analytics.refresh_tenant.
// Metric values are never read from payloads; only the date field(s) below and, for order.*, the order_index ids. Tenant = ctx.tenantId only.
// Order-insensitive by design (D-C8-04): no aggregate.seq checks. Business date = (ts AT TIME ZONE 'Asia/Kathmandu')::date, evaluated in SQL.
import { upsertOrderCreated, recordOrderCancelled } from '../../../../../api/src/modules/analytics/repository/orderIndex.repo.js';
import { assertUuid, markDirty, type RefreshTx } from '../../../../../api/src/modules/analytics/repository/refresh.repo.js';
import { SNAPSHOT_DATE, type Family } from '../../../../../api/src/modules/analytics/domain/families.js';
import type { ConsumerHandler, JobContext } from '../../../core/manifest.js';

// Strict RFC 3339 instant with explicit offset (a bare local time would silently be read in the DB session zone).
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const instant = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !INSTANT.test(v) || Number.isNaN(Date.parse(v))) throw new TypeError(`${what}: ISO timestamp with offset expected`);
  return v;
};

async function bd(tx: RefreshTx, ts: string): Promise<string> {
  const r = await tx.query(`SELECT (($1::timestamptz) AT TIME ZONE 'Asia/Kathmandu')::date::text AS business_date`, [ts]);
  return String(r.rows[0].business_date);
}

type Pick = (p: Record<string, unknown>) => readonly Family[];
interface Spec {
  /** payload field carrying the business instant; undefined = "today" (bd of the job clock) */
  readonly anchor?: string;
  readonly dated: readonly Family[] | Pick;
  readonly backlog?: boolean;
}

const TAT_STATUS = ['received', 'verified', 'rejected'], REJ_STATUS = ['rejected', 'recollection_ordered'];
const SPECS: Record<string, Spec> = {
  'billing.invoice.issued.v1': { anchor: 'issued_at', dated: ['income', 'department_income', 'referrer_billing'] },
  'billing.invoice.cancelled.v1': { anchor: 'cancelled_at', dated: ['income', 'department_income', 'referrer_billing'] },
  'lab.specimen.status_changed.v1': {
    anchor: 'changed_at', backlog: true,
    dated: (p) => ['specimens', ...(TAT_STATUS.includes(p['to_status'] as string) ? ['tat' as const] : []), ...(REJ_STATUS.includes(p['to_status'] as string) ? ['rejections' as const] : [])],
  },
  'lab.result.verified.v1': { anchor: 'verified_at', dated: ['results', 'tat'] },
  'lab.result.approved.v1': { anchor: 'approved_at', dated: ['results'], backlog: true },
  'lab.result.amended.v1': { anchor: 'amended_at', dated: ['results'] },
  'lab.critical_value.detected.v1': { anchor: 'detected_at', dated: ['critical_values', 'results'] },
  'instruments.agent.health_changed.v1': { dated: ['interface_messages'] },
  'reporting.report.released.v1': { anchor: 'released_at', dated: ['releases', 'tat'], backlog: true },
  // D-48: cohort day = delivery_created_at when present (optional, additive); else changed_at.
  'reporting.delivery.status_changed.v1': { anchor: 'changed_at', dated: ['deliveries'] },
};

async function finish(ctx: JobContext, tenantId: string, marks: readonly [Family, string][]): Promise<void> {
  for (const [family, businessDate] of marks) await markDirty(ctx.tx, { tenantId, family, businessDate, reason: 'event', actorId: ctx.actor.id });
  await ctx.tx.query(
    `SELECT app.enqueue_job('analytics.refresh_tenant', $1::jsonb, $2, now() + interval '60 seconds', 5)`,
    [JSON.stringify({ tenant_id: tenantId }), `analytics.refresh_tenant:${tenantId}`]);
}

function scope(env: any, ctx: JobContext): { tenantId: string; p: Record<string, unknown> } {
  const tenantId = ctx.tenantId;
  assertUuid(tenantId, 'ctx.tenantId');
  if (env?.tenant_id !== tenantId) throw new Error('analytics consumer: envelope tenant differs from the job tenant context');
  const p = env.payload;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new TypeError('analytics consumer: payload object expected');
  return { tenantId, p };
}

const simple = (type: string): ConsumerHandler => async (env, ctx) => {
  const spec = SPECS[type]!;
  const { tenantId, p } = scope(env, ctx);
  let ts: string;
  if (type === 'reporting.delivery.status_changed.v1' && p['delivery_created_at'] != null) ts = instant(p['delivery_created_at'], 'delivery_created_at');
  else ts = spec.anchor ? instant(p[spec.anchor], spec.anchor) : ctx.now();
  const day = await bd(ctx.tx, ts);
  const families = typeof spec.dated === 'function' ? spec.dated(p) : spec.dated;
  const marks: [Family, string][] = families.map((f) => [f, day]);
  if (spec.backlog) marks.push(['report_backlog', SNAPSHOT_DATE]);
  await finish(ctx, tenantId, marks);
};

const orderCreated: ConsumerHandler = async (env, ctx) => {
  const { tenantId, p } = scope(env, ctx);
  const registeredAt = instant(p['registered_at'], 'registered_at');
  await upsertOrderCreated(ctx.tx, {
    tenantId, orderId: p['order_id'] as string, centreId: (p['centre_id'] ?? null) as string | null, branchId: (p['branch_id'] ?? null) as string | null,
    referrerId: (p['referrer_id'] ?? null) as string | null, registeredAt, eventId: env.event_id, actorId: ctx.actor.id,
  });
  const day = await bd(ctx.tx, registeredAt);
  await finish(ctx, tenantId, [['orders', day], ['centre_volume', day], ['referrer_volume', day], ['report_backlog', SNAPSHOT_DATE]]);
};

const orderCancelled: ConsumerHandler = async (env, ctx) => {
  const { tenantId, p } = scope(env, ctx);
  const cancelledAt = instant(p['cancelled_at'], 'cancelled_at');
  const orderId = p['order_id'];
  assertUuid(orderId, 'order_id');
  await recordOrderCancelled(ctx.tx, { tenantId, orderId, cancelledAt, eventId: env.event_id, actorId: ctx.actor.id });
  // The order families are dated by the REGISTRATION day; a placeholder (cancel before create) has none yet.
  const r = await ctx.tx.query('SELECT registered_on::text AS registered_on FROM analytics.order_index WHERE tenant_id = $1 AND order_id = $2', [tenantId, orderId]);
  const on: unknown = r.rows[0]?.registered_on;
  const marks: [Family, string][] = typeof on === 'string' ? [['orders', on], ['centre_volume', on], ['referrer_volume', on]] : [];
  await finish(ctx, tenantId, [...marks, ['report_backlog', SNAPSHOT_DATE]]);
};

export const consumers: Readonly<Record<string, ConsumerHandler>> = {
  ...Object.fromEntries(Object.keys(SPECS).map((t) => [t, simple(t)])),
  'frontdesk.order.created.v1': orderCreated,
  'frontdesk.order.cancelled.v1': orderCancelled,
};
