// Rollup families and event -> dirtied families (02-TRD §9.1 table, §8.2 consumed events). Pure data + lookup.

export const FAMILIES = Object.freeze([
  'orders', 'centre_volume', 'referrer_volume', 'income', 'department_income', 'collections', 'referrer_billing', 'results',
  'specimens', 'rejections', 'critical_values', 'tat', 'releases', 'deliveries', 'interface_messages', 'report_backlog',
] as const);
export type Family = (typeof FAMILIES)[number];

/** Target table in schema `analytics` (§9.1). Interpolated into partition-replace SQL: keep to safe identifiers. */
export const FAMILY_TABLE: Readonly<Record<Family, string>> = Object.freeze({
  orders: 'daily_orders', centre_volume: 'daily_centre_volume', referrer_volume: 'daily_referrer_volume', income: 'daily_income',
  department_income: 'daily_department_income', collections: 'daily_collections', referrer_billing: 'daily_referrer_billing',
  results: 'daily_results', specimens: 'daily_specimens', rejections: 'daily_rejections', critical_values: 'daily_critical_values',
  tat: 'tat_facts', releases: 'daily_releases', deliveries: 'daily_deliveries', interface_messages: 'daily_interface_messages',
  report_backlog: 'report_backlog',
});

/** report_backlog is a whole-snapshot family keyed by this sentinel business_date (§8.2). */
export const SNAPSHOT_DATE = '1970-01-01';
export const isSnapshotFamily = (f: Family): boolean => f === 'report_backlog';

const ORDER: readonly Family[] = ['orders', 'centre_volume', 'referrer_volume', 'report_backlog'];
const INVOICE: readonly Family[] = ['income', 'department_income', 'referrer_billing'];
const SPECIMEN_EVENT = 'lab.specimen.status_changed.v1';

// Map, not an object literal: keys like 'constructor' / '__proto__' must not resolve.
const FIXED: ReadonlyMap<string, readonly Family[]> = new Map([
  ['frontdesk.order.created.v1', ORDER],
  ['frontdesk.order.cancelled.v1', ORDER],
  ['billing.invoice.issued.v1', INVOICE],
  ['billing.invoice.cancelled.v1', INVOICE],
  ['lab.result.verified.v1', ['results', 'tat']],
  ['lab.result.approved.v1', ['results', 'report_backlog']],
  ['lab.result.amended.v1', ['results']],
  ['lab.critical_value.detected.v1', ['critical_values', 'results']],
  ['instruments.agent.health_changed.v1', ['interface_messages']],
  ['reporting.report.released.v1', ['releases', 'tat', 'report_backlog']],
  ['reporting.delivery.status_changed.v1', ['deliveries']],
]);

/** The 12 events of IC §3.25 consumed by C8. */
export const CONSUMED_EVENTS: readonly string[] = Object.freeze([...FIXED.keys(), SPECIMEN_EVENT]);

const TAT_STATUSES = ['received', 'verified', 'rejected'];
const REJECTION_STATUSES = ['rejected', 'recollection_ordered'];

/** Set semantics; unknown event -> []. Only `to_status` is read, and only for the specimen event. */
export function familiesDirtiedBy(eventType: string, payload?: { to_status?: string }): readonly Family[] {
  const fixed = FIXED.get(eventType);
  if (fixed) return fixed;
  if (eventType !== SPECIMEN_EVENT) return [];
  const to = payload?.to_status;
  return [
    'specimens',
    ...(typeof to === 'string' && TAT_STATUSES.includes(to) ? (['tat'] as const) : []),
    ...(typeof to === 'string' && REJECTION_STATUSES.includes(to) ? (['rejections'] as const) : []),
    'report_backlog',
  ];
}
