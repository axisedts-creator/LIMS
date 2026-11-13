// C16 T-OPS1 (02-TRD §13 "Metric" table): the 13 lims_engagement_* metrics + best-effort emitters. Names/types/labels are copied from the TRD.
// Labels are codes only: no id, phone, name, code or token (02-CV §9.2). A missing sink or a rejected name/label never fails a patient request.
// [CONV] registering these in core/observability/metrics.ts DEFS is a C0 path: see .orchestra/cr/T-OPS1.md.
type L = Record<string, string | number>;
type Sink = { inc?: (n: string, l?: L, by?: number) => void; set?: (n: string, v: number, l?: L) => void; observe?: (n: string, v: number, l?: L) => void };
const sinkOf = (ctx: unknown): Sink | undefined => (ctx as { metrics?: Sink } | undefined)?.metrics;
const safe = (f: () => void): void => { try { f(); } catch { /* best effort */ } };

export type EngagementMetricKind = 'counter' | 'gauge' | 'histogram';

export const ENGAGEMENT_METRICS: Readonly<Record<string, readonly [EngagementMetricKind, readonly string[]]>> = Object.freeze({
  lims_engagement_otp_requests_total: ['counter', ['outcome']],
  lims_engagement_otp_verifications_total: ['counter', ['outcome']],
  lims_engagement_link_events_total: ['counter', ['method', 'outcome']],
  lims_engagement_projection_lag_seconds: ['histogram', ['event_type']],
  lims_engagement_projection_drift_total: ['counter', ['table']],
  lims_engagement_bookings_total: ['counter', ['kind', 'outcome']],
  lims_engagement_slot_conflicts_total: ['counter', []],
  lims_engagement_queue_tokens_total: ['counter', ['event']],
  lims_engagement_queue_wait_seconds: ['histogram', []],
  lims_engagement_displays_stale: ['gauge', []],
  lims_engagement_payment_requests_total: ['counter', ['gateway', 'outcome']],
  lims_engagement_reminders_total: ['counter', ['kind', 'outcome']],
  lims_engagement_report_downloads_total: ['counter', ['outcome']],
} as const);

const inc = (ctx: unknown, name: string, labels: L = {}) => safe(() => sinkOf(ctx)?.inc?.(name, labels));

export const engagementMetrics = {
  otpRequest: (ctx: unknown, outcome: string) => inc(ctx, 'lims_engagement_otp_requests_total', { outcome }),
  otpVerification: (ctx: unknown, outcome: string) => inc(ctx, 'lims_engagement_otp_verifications_total', { outcome }),
  linkEvent: (ctx: unknown, method: string, outcome: string) => inc(ctx, 'lims_engagement_link_events_total', { method, outcome }),
  projectionLag: (ctx: unknown, eventType: string, seconds: number) => safe(() => sinkOf(ctx)?.observe?.('lims_engagement_projection_lag_seconds', seconds, { event_type: eventType })),
  projectionDrift: (ctx: unknown, table: string) => inc(ctx, 'lims_engagement_projection_drift_total', { table }),
  booking: (ctx: unknown, kind: string, outcome: string) => inc(ctx, 'lims_engagement_bookings_total', { kind, outcome }),
  slotConflict: (ctx: unknown) => inc(ctx, 'lims_engagement_slot_conflicts_total'),
  queueToken: (ctx: unknown, event: string) => inc(ctx, 'lims_engagement_queue_tokens_total', { event }),
  queueWait: (ctx: unknown, seconds: number) => safe(() => sinkOf(ctx)?.observe?.('lims_engagement_queue_wait_seconds', seconds, {})),
  displaysStale: (ctx: unknown, count: number) => safe(() => sinkOf(ctx)?.set?.('lims_engagement_displays_stale', count, {})),
  paymentRequest: (ctx: unknown, gateway: string, outcome: string) => inc(ctx, 'lims_engagement_payment_requests_total', { gateway, outcome }),
  reminder: (ctx: unknown, kind: string, outcome: string) => inc(ctx, 'lims_engagement_reminders_total', { kind, outcome }),
  reportDownload: (ctx: unknown, outcome: string) => inc(ctx, 'lims_engagement_report_downloads_total', { outcome }),
};
