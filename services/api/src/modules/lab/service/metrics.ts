// C5 T-31: the 14 lims_lab_* metrics of 02-TRD §11 behind one best-effort emitter. Names and label sets are registered in core/observability/metrics.ts (CR-C5-T31-001).
// Metrics never break a clinical write: a missing sink or a rejected name/label is swallowed. Labels are codes only (no barcode, registration no, value, comment, patient: 02-CV §9.2, S-18).
type Sink = { inc?: (n: string, l?: Record<string, string | number>, by?: number) => void; set?: (n: string, v: number, l?: Record<string, string | number>) => void; observe?: (n: string, v: number, l?: Record<string, string | number>) => void };
type L = Record<string, string | number>;
const sinkOf = (ctx: unknown): Sink | undefined => (ctx as { metrics?: Sink } | undefined)?.metrics;
const safe = (f: () => void): void => { try { f(); } catch { /* best effort */ } };

export const labMetrics = {
  specimenTransition: (ctx: unknown, toStatus: unknown) => safe(() => sinkOf(ctx)?.inc?.('lims_lab_specimen_transitions_total', { to_status: String(toStatus) })),
  specimenCreationLag: (ctx: unknown, seconds: number) => safe(() => sinkOf(ctx)?.observe?.('lims_lab_specimen_creation_lag_seconds', seconds)),
  resultIngested: (ctx: unknown, outcome: string) => safe(() => sinkOf(ctx)?.inc?.('lims_lab_results_ingested_total', { outcome })),
  ingestExceptionsOpen: (ctx: unknown, reason: string, tenantId: string, n: number) => safe(() => sinkOf(ctx)?.set?.('lims_lab_ingest_exceptions_open', n, { reason, tenant_id: tenantId })),
  ingestExceptionAge: (ctx: unknown, reason: string, seconds: number) => safe(() => sinkOf(ctx)?.observe?.('lims_lab_ingest_exception_age_seconds', seconds, { reason })),
  ingestExceptionOldest: (ctx: unknown, reason: string, tenantId: string, seconds: number) => safe(() => sinkOf(ctx)?.set?.('lims_lab_ingest_exception_oldest_open_age_seconds', seconds, { reason, tenant_id: tenantId })),
  criticalOldestUnnotified: (ctx: unknown, tenantId: string, seconds: number) => safe(() => sinkOf(ctx)?.set?.('lims_lab_critical_unnotified_oldest_age_seconds', seconds, { tenant_id: tenantId })),
  resultTransition: (ctx: unknown, toStatus: string, origin: string) => safe(() => sinkOf(ctx)?.inc?.('lims_lab_result_transitions_total', { to_status: toStatus, origin })),
  criticalDetected: (ctx: unknown, direction: unknown) => safe(() => sinkOf(ctx)?.inc?.('lims_lab_critical_detected_total', { direction: String(direction) })),
  criticalUnnotifiedOpen: (ctx: unknown, tenantId: string, n: number) => safe(() => sinkOf(ctx)?.set?.('lims_lab_critical_unnotified_open', n, { tenant_id: tenantId })),
  formulaError: (ctx: unknown, reason: string) => safe(() => sinkOf(ctx)?.inc?.('lims_lab_formula_errors_total', { reason })),
  hostQuery: (ctx: unknown, seconds: number, outcome: 'ok' | 'error') => safe(() => sinkOf(ctx)?.observe?.('lims_lab_host_query_duration_seconds', seconds, { outcome })),
  readinessEmitted: (ctx: unknown, completeness: unknown) => safe(() => sinkOf(ctx)?.inc?.('lims_lab_readiness_emitted_total', { completeness: String(completeness) })),
  barcodeAllocFailure: (ctx: unknown, reason: string) => safe(() => sinkOf(ctx)?.inc?.('lims_lab_barcode_alloc_failures_total', { reason })),
};
