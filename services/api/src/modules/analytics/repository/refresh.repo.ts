// Refresh engine SQL (02-TRD §8.2 markDirty, §9.1 families, §9.2 partition replace; PRD US-20.2-4; 08 A13 D-3/P-4, A17 P-22/D-48).
// Every function takes the caller's `tx` (the CALLER owns BEGIN/COMMIT). Sources are analytics.* and published v_pub_* views only.
// Tenant, range, run id and lookback are always bound; the only interpolated text is a table name from the closed FAMILY_TABLE set.
import type { IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { FAMILIES, FAMILY_TABLE, SNAPSHOT_DATE, isSnapshotFamily, type Family } from '../domain/families.js';
import type { FamilyState } from '../domain/freshness.js';

export interface RefreshTx { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

export const REFRESH_TRIGGERS = ['event', 'sweep_recent', 'sweep_nightly', 'manual', 'self_check', 'backfill'] as const; // dirty_partitions__reason__ck = refresh_runs__trigger__ck
export type RefreshTrigger = (typeof REFRESH_TRIGGERS)[number];
export const DEFAULT_BACKLOG_LOOKBACK_DAYS = 30; // [CONV] LIMS_ANALYTICS_BACKLOG_LOOKBACK_DAYS

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(v: unknown, what: string): asserts v is string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new TypeError(`${what}: uuid expected`);
}
export function assertIsoDate(v: unknown, what: string): asserts v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new TypeError(`${what}: ISO date expected`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new TypeError(`${what}: not a calendar date`);
}
export function assertInstant(v: unknown, what: string): asserts v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) throw new TypeError(`${what}: ISO timestamp expected`);
}
export function assertFamily(v: unknown): asserts v is Family {
  if (typeof v !== 'string' || !(FAMILIES as readonly string[]).includes(v)) throw new TypeError('family: unknown');
}
export function assertTrigger(v: unknown): asserts v is RefreshTrigger {
  if (typeof v !== 'string' || !(REFRESH_TRIGGERS as readonly string[]).includes(v)) throw new TypeError('trigger: unknown');
}

// ---- SQL building blocks ----
const FROM_TS = `($2::timestamp AT TIME ZONE 'Asia/Kathmandu')`; // local midnights as instants (§9.2)
const TO_TS = `($3::timestamp AT TIME ZONE 'Asia/Kathmandu')`;
const STAMP = '$4::uuid, now()';
const RANGE = 'v.business_date >= $2 AND v.business_date < $3';

/** Straight copy of a view's columns for [from,to). `cols` are the shared column names after (tenant_id, business_date). */
function copy(family: Family, view: string, cols: string): string {
  const list = cols.split(', ');
  return `INSERT INTO analytics.${FAMILY_TABLE[family]} (tenant_id, business_date, ${cols}, refresh_run_id, refreshed_at)
SELECT v.tenant_id, v.business_date, ${list.map((c) => `v.${c}`).join(', ')}, ${STAMP}
FROM ${view} v
WHERE v.tenant_id = $1 AND ${RANGE}`;
}

const SPECIMEN_LEG = (k: string, ts: string) => `SELECT tenant_id, centre_id, processing_branch_id, specimen_type_code, priority, '${k}' AS k,
       (${ts} AT TIME ZONE 'Asia/Kathmandu')::date AS d
FROM lab.v_pub_specimen_timeline
WHERE tenant_id = $1 AND ${ts} >= ${FROM_TS} AND ${ts} < ${TO_TS} AND parent_specimen_id IS NULL`;

const SPECIMENS = `INSERT INTO analytics.daily_specimens (tenant_id, business_date, centre_id, processing_branch_id, specimen_type_code, priority,
       collected, received, rejected, refresh_run_id, refreshed_at)
SELECT tenant_id, d, centre_id, processing_branch_id, specimen_type_code, priority,
       count(*) FILTER (WHERE k = 'c'), count(*) FILTER (WHERE k = 'r'), count(*) FILTER (WHERE k = 'x'), ${STAMP}
FROM (${SPECIMEN_LEG('c', 'collected_at')}
      UNION ALL ${SPECIMEN_LEG('r', 'received_at')}
      UNION ALL ${SPECIMEN_LEG('x', 'rejected_at')}) s
GROUP BY tenant_id, d, centre_id, processing_branch_id, specimen_type_code, priority`;

const RELEASES = `INSERT INTO analytics.daily_releases (tenant_id, business_date, centre_id, report_kind, release_basis, released, refresh_run_id, refreshed_at)
SELECT v.tenant_id, (v.released_at AT TIME ZONE 'Asia/Kathmandu')::date, v.centre_id,
       CASE WHEN v.report_kind IN ('final', 'partial', 'preliminary', 'amended', 'addendum') THEN v.report_kind ELSE 'amended' END,
       v.release_basis, count(*), ${STAMP}
FROM reporting.v_pub_report_release v
WHERE v.tenant_id = $1 AND v.released_at >= ${FROM_TS} AND v.released_at < ${TO_TS}
GROUP BY 1, 2, 3, 4, 5`;

const DELIVERIES = `INSERT INTO analytics.daily_deliveries (tenant_id, business_date, channel, purpose, recipient_kind, centre_id,
       queued, sent, delivered, "read", failed, suppressed, refresh_run_id, refreshed_at)
SELECT v.tenant_id, v.business_date, v.channel, v.purpose,
       CASE WHEN v.recipient_kind IN ('patient', 'referrer', 'centre', 'partner', 'staff', 'phone_otp') THEN v.recipient_kind ELSE 'other' END,
       v.centre_id, sum(v.queued), sum(v.sent), sum(v.delivered), sum(v."read"), sum(v.failed), sum(v.suppressed), ${STAMP}
FROM reporting.v_pub_delivery_daily v
WHERE v.tenant_id = $1 AND ${RANGE}
GROUP BY 1, 2, 3, 4, 5, 6`;

/** TAT new-rows SELECT (§9.2): evaluated by statement 2 (subject move) and statement 3 (insert) - one text, so they cannot drift. */
const TAT_ROWS = `SELECT tenant_id, 'pre_analytical' AS segment, specimen_id AS subject_id, centre_id, processing_branch_id, priority, specimen_type_code,
       collected_at, received_at, (received_at AT TIME ZONE 'Asia/Kathmandu')::date,
       floor(extract(epoch FROM (received_at - collected_at)))::bigint, received_at < collected_at, ${STAMP}
FROM lab.v_pub_specimen_timeline
WHERE tenant_id = $1 AND received_at >= ${FROM_TS} AND received_at < ${TO_TS} AND collected_at IS NOT NULL AND rejected_at IS NULL
  AND parent_specimen_id IS NULL
UNION ALL
SELECT tenant_id, 'transport', specimen_id, centre_id, processing_branch_id, priority, specimen_type_code,
       in_transit_at, received_at, (received_at AT TIME ZONE 'Asia/Kathmandu')::date,
       floor(extract(epoch FROM (received_at - in_transit_at)))::bigint, received_at < in_transit_at, ${STAMP}
FROM lab.v_pub_specimen_timeline
WHERE tenant_id = $1 AND received_at >= ${FROM_TS} AND received_at < ${TO_TS} AND in_transit_at IS NOT NULL AND rejected_at IS NULL
  AND parent_specimen_id IS NULL
UNION ALL
SELECT tenant_id, 'within_lab', specimen_id, centre_id, processing_branch_id, priority, specimen_type_code,
       received_at, first_verified_at, (first_verified_at AT TIME ZONE 'Asia/Kathmandu')::date,
       floor(extract(epoch FROM (first_verified_at - received_at)))::bigint, first_verified_at < received_at, ${STAMP}
FROM lab.v_pub_specimen_timeline
WHERE tenant_id = $1 AND first_verified_at >= ${FROM_TS} AND first_verified_at < ${TO_TS} AND received_at IS NOT NULL AND rejected_at IS NULL
  AND parent_specimen_id IS NULL
UNION ALL
SELECT tenant_id, 'total_first_release', order_id, centre_id, NULL, NULL, NULL, registered_at, first_released_at,
       (first_released_at AT TIME ZONE 'Asia/Kathmandu')::date,
       floor(extract(epoch FROM (first_released_at - registered_at)))::bigint, first_released_at < registered_at, ${STAMP}
FROM reporting.v_pub_order_report_tat
WHERE tenant_id = $1 AND first_released_at >= ${FROM_TS} AND first_released_at < ${TO_TS} AND registered_at IS NOT NULL
UNION ALL
SELECT tenant_id, 'total_final_release', order_id, centre_id, NULL, NULL, NULL, registered_at, final_released_at,
       (final_released_at AT TIME ZONE 'Asia/Kathmandu')::date,
       floor(extract(epoch FROM (final_released_at - registered_at)))::bigint, final_released_at < registered_at, ${STAMP}
FROM reporting.v_pub_order_report_tat
WHERE tenant_id = $1 AND final_released_at >= ${FROM_TS} AND final_released_at < ${TO_TS} AND registered_at IS NOT NULL
  AND total_tat_seconds IS NOT NULL`;

const TAT_DEL_RANGE = 'DELETE FROM analytics.tat_facts WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3';
const TAT_DEL_MOVED = `DELETE FROM analytics.tat_facts f WHERE f.tenant_id = $1
  AND (f.segment, f.subject_id) IN (SELECT n.segment, n.subject_id FROM (${TAT_ROWS}) n)`;
const TAT_INSERT = `INSERT INTO analytics.tat_facts (tenant_id, segment, subject_id, centre_id, processing_branch_id, priority, specimen_type_code,
       started_at, stopped_at, business_date, duration_seconds, is_anomaly, refresh_run_id, refreshed_at)
${TAT_ROWS}`;

const BACKLOG_DEL = 'DELETE FROM analytics.report_backlog WHERE tenant_id = $1';
const BACKLOG_INSERT = `INSERT INTO analytics.report_backlog (tenant_id, centre_id, stage, age_bucket, orders, oldest_registered_at, refresh_run_id, refreshed_at)
WITH o AS (
  SELECT oi.order_id, oi.centre_id, oi.registered_at FROM analytics.order_index oi
  WHERE oi.tenant_id = $1 AND oi.cancelled_at IS NULL AND oi.registered_at >= now() - make_interval(days => $2)),
rel AS (
  SELECT r.order_id FROM reporting.v_pub_order_report_tat r
  WHERE r.tenant_id = $1 AND r.first_released_at IS NOT NULL AND r.registered_at >= now() - make_interval(days => $2)),
sp AS (
  SELECT s.order_id, bool_and(s.all_approved_at IS NOT NULL) AS all_approved
  FROM lab.v_pub_specimen_timeline s
  WHERE s.tenant_id = $1 AND s.status NOT IN ('rejected', 'recollection_ordered', 'discarded')
    AND s.order_id IN (SELECT order_id FROM o)
  GROUP BY s.order_id)
SELECT $1::uuid, o.centre_id,
       CASE WHEN sp.all_approved IS TRUE THEN 'ready_unreleased' ELSE 'awaiting_results' END,
       CASE WHEN now() - o.registered_at < interval '4 hours' THEN 'lt_4h' WHEN now() - o.registered_at < interval '24 hours' THEN 'h4_24'
            WHEN now() - o.registered_at < interval '3 days' THEN 'd1_3' ELSE 'gt_3d' END,
       count(*), min(o.registered_at), $3::uuid, now()
FROM o LEFT JOIN sp ON sp.order_id = o.order_id
WHERE o.order_id NOT IN (SELECT order_id FROM rel)
GROUP BY 2, 3, 4`;

/** INSERT statements per date family (everything but tat/report_backlog). */
const INSERTS: Readonly<Partial<Record<Family, string>>> = {
  orders: copy('orders', 'frontdesk.v_pub_order_daily', 'branch_id, centre_id, orders_registered, patients_distinct, new_patients, urgent_orders, cancelled_orders, opd_orders, ipd_orders'),
  centre_volume: copy('centre_volume', 'frontdesk.v_pub_centre_volume', 'branch_id, centre_id, collection_mode, orders, patients_distinct, order_items'),
  referrer_volume: copy('referrer_volume', 'frontdesk.v_pub_referrer_volume', 'branch_id, centre_id, referrer_id, orders, patients_distinct, order_items'),
  income: copy('income', 'billing.v_pub_invoice_daily', 'branch_id, centre_id, invoices_issued, invoices_cancelled, gross_paisa, discount_paisa, exempt_paisa, taxable_paisa, vat_paisa, other_tax_paisa, net_paisa, credit_notes_paisa'),
  department_income: copy('department_income', 'billing.v_pub_department_income', 'branch_id, centre_id, department_id, line_count, gross_paisa, discount_paisa, net_paisa'),
  collections: copy('collections', 'billing.v_pub_payment_collection', 'branch_id, centre_id, collected_by_membership_id, payment_method_code, entries, reversals, gross_collected_paisa, reversed_paisa, net_collected_paisa'),
  referrer_billing: copy('referrer_billing', 'billing.v_pub_referrer_billing', 'centre_id, referrer_id, orders, net_billed_paisa'),
  results: copy('results', 'lab.v_pub_result_daily', 'processing_branch_id, department_id, test_id, centre_id, results_resulted, results_verified, results_approved, results_amended, auto_verified, critical_count, abnormal_count, tests_approved'),
  specimens: SPECIMENS,
  rejections: copy('rejections', 'lab.v_pub_rejection_daily', 'centre_id, specimen_type_code, reason_code, rejections, recollections_ordered'),
  critical_values: copy('critical_values', 'lab.v_pub_critical_value_daily', 'analyte_id, centre_id, detected, notified, median_notify_seconds, max_notify_seconds'),
  releases: RELEASES,
  deliveries: DELIVERIES,
  interface_messages: copy('interface_messages', 'instruments.v_pub_message_daily', 'instrument_id, centre_id, messages, patient_records, qc_records, unmatched, quarantined, duplicates'),
};

export interface ReplaceInput {
  readonly tenantId: string; readonly family: Family; readonly runId: string;
  readonly from?: string | undefined; readonly to?: string | undefined; // ISO dates, half-open [from,to); ignored for report_backlog
  readonly backlogLookbackDays?: number | undefined;
}

/** One family partition, atomically within the caller's tx: DELETE then INSERT … SELECT from the §9.1 source. */
export async function replacePartition(tx: RefreshTx, a: ReplaceInput): Promise<{ rowsWritten: number }> {
  assertUuid(a.tenantId, 'tenantId'); assertUuid(a.runId, 'runId'); assertFamily(a.family);
  let written = 0;
  const insert = async (text: string, values: unknown[]) => { written += Number((await tx.query(text, values)).rowCount ?? 0); };

  if (isSnapshotFamily(a.family)) {
    const days = a.backlogLookbackDays ?? DEFAULT_BACKLOG_LOOKBACK_DAYS;
    if (!Number.isInteger(days) || days < 1) throw new TypeError('backlogLookbackDays: positive integer expected');
    await tx.query(BACKLOG_DEL, [a.tenantId]);
    await insert(BACKLOG_INSERT, [a.tenantId, days, a.runId]);
    return { rowsWritten: written };
  }

  assertIsoDate(a.from, 'from'); assertIsoDate(a.to, 'to');
  if (a.from >= a.to) throw new RangeError('from must be before to');
  const range = [a.tenantId, a.from, a.to];
  const bound = [...range, a.runId];
  if (a.family === 'tat') {
    await tx.query(TAT_DEL_RANGE, range);
    await tx.query(TAT_DEL_MOVED, bound); // the fact moves with its subject (review #4)
    await insert(TAT_INSERT, bound);
    return { rowsWritten: written };
  }
  await tx.query(`DELETE FROM analytics.${FAMILY_TABLE[a.family]} WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3`, range);
  await insert(INSERTS[a.family]!, bound);
  return { rowsWritten: written };
}

export interface MarkDirtyInput {
  readonly tenantId: string; readonly family: Family; readonly businessDate: string; readonly reason: RefreshTrigger; readonly actorId: string;
}

/** §8.2: first_marked_at is kept, last_marked_at bumped; no row locks. report_backlog <-> SNAPSHOT_DATE only (dirty_partitions__snapshot__ck). */
export async function markDirty(tx: RefreshTx, a: MarkDirtyInput): Promise<void> {
  assertUuid(a.tenantId, 'tenantId'); assertUuid(a.actorId, 'actorId'); assertFamily(a.family); assertTrigger(a.reason); assertIsoDate(a.businessDate, 'businessDate');
  if ((a.family === 'report_backlog') !== (a.businessDate === SNAPSHOT_DATE)) throw new RangeError('report_backlog <-> snapshot date only');
  await tx.query(
    `INSERT INTO analytics.dirty_partitions (tenant_id, family, business_date, first_marked_at, last_marked_at, reason, created_by)
VALUES ($1, $2, $3, now(), now(), $4, $5)
ON CONFLICT (tenant_id, family, business_date) DO UPDATE SET last_marked_at = now()`,
    [a.tenantId, a.family, a.businessDate, a.reason, a.actorId]);
}

const iso = (v: unknown): IsoUtc | null => (v == null ? null : (new Date(v as string).toISOString() as IsoUtc));

/** One FamilyState per family. A family without a refresh_state row has lastSuccessAt null -> never_refreshed (P-22); nothing is written. */
export async function loadFamilyStates(tx: RefreshTx, a: { tenantId: string }): Promise<FamilyState[]> {
  assertUuid(a.tenantId, 'tenantId');
  const st = (await tx.query(
    'SELECT family, last_success_at, last_error_code FROM analytics.refresh_state WHERE tenant_id = $1', [a.tenantId])).rows;
  const dirty = (await tx.query(
    'SELECT family, min(first_marked_at) AS oldest FROM analytics.dirty_partitions WHERE tenant_id = $1 GROUP BY family', [a.tenantId])).rows;
  const stateOf = new Map<string, any>(st.map((r) => [r.family as string, r]));
  const dirtyOf = new Map<string, any>(dirty.map((r) => [r.family as string, r]));
  return FAMILIES.map((family) => {
    const s = stateOf.get(family), d = dirtyOf.get(family);
    return { family, lastSuccessAt: iso(s?.last_success_at), oldestDirtyAt: iso(d?.oldest), lastAttemptFailed: s?.last_error_code != null };
  });
}
