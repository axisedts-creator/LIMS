// HC-T17 (02-TRD §14 "Metric" table): the 8 lims_homecollection_* metrics behind one best-effort emitter. Names, types and labels are copied from the TRD.
// Labels are codes only: never a visit / device / patient id, barcode, name, phone or GPS (02-CV §9.2, 07-SECURITY §6). A missing sink or a rejected name/label never fails a request.
// The 8 names are registered in core/observability/metrics.ts DEFS (LD-162, CR-C17-HC-T17-REG). Emitters stay best-effort: a rejected name/label is swallowed
//   (same seam as engagement/metrics.ts and lab/service/metrics.ts).
type L = Record<string, string | number>;
type Sink = { inc?: (n: string, l?: L, by?: number) => void; set?: (n: string, v: number, l?: L) => void; observe?: (n: string, v: number, l?: L) => void };
const sinkOf = (ctx: unknown): Sink | undefined => (ctx as { metrics?: Sink } | undefined)?.metrics;
const safe = (f: () => void): void => { try { f(); } catch { /* best effort */ } };

export type HomecollectionMetricKind = 'counter' | 'gauge' | 'histogram';

export const HOMECOLLECTION_METRICS: Readonly<Record<string, readonly [HomecollectionMetricKind, readonly string[]]>> = Object.freeze({
  lims_homecollection_mutations_total: ['counter', ['type', 'outcome']],
  lims_homecollection_push_duration_seconds: ['histogram', []],
  lims_homecollection_snapshot_duration_seconds: ['histogram', ['changed']],
  lims_homecollection_held_open: ['gauge', ['tenant_id']],
  lims_homecollection_clock_skew_seconds: ['histogram', ['clock_source']],
  lims_homecollection_devices_stale_total: ['gauge', ['tenant_id']],
  lims_homecollection_handover_overdue_open: ['gauge', ['tenant_id']],
  lims_homecollection_events_published_total: ['counter', []],
} as const);

export const hcMetrics = {
  mutation: (ctx: unknown, type: string, outcome: string) => safe(() => sinkOf(ctx)?.inc?.('lims_homecollection_mutations_total', { type, outcome })),
  pushDuration: (ctx: unknown, seconds: number) => safe(() => sinkOf(ctx)?.observe?.('lims_homecollection_push_duration_seconds', seconds)),
  snapshotDuration: (ctx: unknown, seconds: number, changed: boolean) => safe(() => sinkOf(ctx)?.observe?.('lims_homecollection_snapshot_duration_seconds', seconds, { changed: String(changed) })),
  clockSkew: (ctx: unknown, seconds: number, clockSource: string) => safe(() => sinkOf(ctx)?.observe?.('lims_homecollection_clock_skew_seconds', Math.abs(seconds), { clock_source: clockSource })),
  eventPublished: (ctx: unknown) => safe(() => sinkOf(ctx)?.inc?.('lims_homecollection_events_published_total')),
  heldOpen: (ctx: unknown, tenantId: string, n: number) => safe(() => sinkOf(ctx)?.set?.('lims_homecollection_held_open', n, { tenant_id: tenantId })),
  devicesStale: (ctx: unknown, tenantId: string, n: number) => safe(() => sinkOf(ctx)?.set?.('lims_homecollection_devices_stale_total', n, { tenant_id: tenantId })),
  handoverOverdueOpen: (ctx: unknown, tenantId: string, n: number) => safe(() => sinkOf(ctx)?.set?.('lims_homecollection_handover_overdue_open', n, { tenant_id: tenantId })),
};

/** wall-clock seconds of an async step; the emit callback runs once, on success or failure. */
export async function timed<T>(run: () => Promise<T>, emit: (seconds: number, result: T | undefined) => void): Promise<T> {
  const t0 = process.hrtime.bigint();
  let result: T | undefined;
  try { result = await run(); return result; } finally { emit(Number(process.hrtime.bigint() - t0) / 1e9, result); }
}
