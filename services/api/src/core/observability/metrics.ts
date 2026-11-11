// Required metrics (CV §9.4 + 02-TRD §13). One prom-client Registry per createMetrics() call: no process-global state.
// Names and label sets are fixed here; an unknown name or label throws (typo guard, no id/PHI labels).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

type Kind = 'counter' | 'gauge' | 'histogram';
const DEFS = {
  // CV §9.4 "Required per service"
  lims_http_requests_total: ['counter', ['module', 'operation_id', 'status'], 'HTTP requests by module, operationId and status'],
  lims_http_request_duration_seconds: ['histogram', ['module', 'operation_id'], 'HTTP request duration in seconds'],
  lims_jobs_total: ['counter', ['task', 'outcome'], 'Worker jobs by task and outcome'],
  lims_job_duration_seconds: ['histogram', ['task'], 'Worker job duration in seconds'],
  lims_queue_depth: ['gauge', ['task'], 'Queued jobs by task'],
  lims_core_dead_letters_total: ['counter', ['task'], 'Dead letters created by task'],
  // tenant_id allowed only here and on events_published (02-TRD §13 note, low cardinality)
  lims_ratelimit_rejections_total: ['counter', ['tier', 'tenant_id'], 'Rate-limit rejections by tier'],
  lims_rls_denied_total: ['counter', [], 'RLS denials (REQ-SEC-045/133)'],
  // 02-TRD §13 "C0 additions"
  lims_core_events_published_total: ['counter', ['event_type', 'tenant_id'], 'Domain events published by type'],
  lims_core_event_fanout_lag_seconds: ['histogram', [], 'Event fan-out lag in seconds'],
  lims_core_idempotency_replays_total: ['counter', [], 'Idempotent responses replayed'],
  lims_core_idempotency_conflicts_total: ['counter', ['kind'], 'Idempotency key conflicts by kind'],
  lims_core_tx_retries_total: ['counter', ['sqlstate'], 'Request transaction retries by SQLSTATE'],
  lims_core_auth_failures_total: ['counter', ['reason'], 'Authentication failures by reason'],
  lims_core_fake_ports_active: ['gauge', [], 'Ports resolved to fakes'],
  lims_core_phase_stub_ports_active: ['gauge', [], 'Ports resolved to phase stubs (08 R9)'],
  lims_core_authz_not_asserted_total: ['counter', ['operation_id'], 'Operations that returned without assertRole'],
  lims_core_retention_purged_total: ['counter', ['table'], 'Rows purged by retention, by table'],
  lims_core_retention_purge_capped_total: ['counter', ['table'], 'Retention purges stopped at the cap, by table'],
  lims_core_storage_deletes_total: ['counter', ['bucket', 'reason'], 'Storage objects deleted by bucket and reason'],
  lims_core_port_consumer_not_listed_total: ['counter', ['module', 'port'], 'Port calls from a consumer not listed for the port'],
  // C8 analytics (LD-88 / CR-C8-016; names, types, labels verbatim from C8 02-TRD §13 lines 846-854)
  lims_analytics_refresh_duration_seconds: ['histogram', ['family'], 'Analytics refresh duration in seconds by family'],
  lims_analytics_refresh_failures_total: ['counter', ['family'], 'Analytics refresh failures by family'],
  lims_analytics_family_stale: ['gauge', ['tenant_id', 'family'], 'Analytics family staleness flag (0 or 1) by tenant and family'],
  lims_analytics_dirty_partitions: ['gauge', ['family'], 'Analytics dirty partitions awaiting refresh by family'],
  lims_analytics_reconciliation_mismatch_total: ['counter', ['rule', 'family'], 'Analytics reconciliation mismatches by rule and family'],
  lims_analytics_exports_total: ['counter', ['tenant_id', 'format', 'outcome'], 'Analytics exports by tenant, format and outcome'],
  lims_analytics_export_rows: ['histogram', ['report_code'], 'Rows per analytics export by report code'],
  lims_analytics_export_downloads_total: ['counter', ['tenant_id'], 'Analytics export downloads by tenant'],
  lims_analytics_schedule_sends_total: ['counter', ['outcome'], 'Analytics scheduled report sends by outcome'],
  // C5 lab (LD-120 / C5 02-TRD §11 lines 468-481; names, types, labels verbatim; gauges refreshed every 60 s by the lab module)
  lims_lab_specimen_transitions_total: ['counter', ['to_status'], 'Specimen status transitions by target status'],
  lims_lab_specimen_creation_lag_seconds: ['histogram', [], 'Lag between collection and specimen creation in seconds'],
  lims_lab_results_ingested_total: ['counter', ['outcome'], 'Instrument results ingested by outcome'],
  lims_lab_ingest_exceptions_open: ['gauge', ['reason', 'tenant_id'], 'Open ingest exceptions by reason and tenant'],
  lims_lab_ingest_exception_age_seconds: ['histogram', ['reason'], 'Age of ingest exceptions when resolved, in seconds'],
  lims_lab_ingest_exception_oldest_open_age_seconds: ['gauge', ['reason', 'tenant_id'], 'Age of the oldest open ingest exception in seconds'],
  lims_lab_critical_unnotified_oldest_age_seconds: ['gauge', ['tenant_id'], 'Age of the oldest unnotified critical value in seconds (0 when none)'],
  lims_lab_result_transitions_total: ['counter', ['to_status', 'origin'], 'Result status transitions by target status and origin'],
  lims_lab_critical_detected_total: ['counter', ['direction'], 'Critical values detected by direction'],
  lims_lab_critical_unnotified_open: ['gauge', ['tenant_id'], 'Open critical values without a recorded notification'],
  lims_lab_formula_errors_total: ['counter', ['reason'], 'Calculated-result formula errors by reason'],
  lims_lab_host_query_duration_seconds: ['histogram', ['outcome'], 'Analyser host query duration in seconds by outcome'],
  lims_lab_readiness_emitted_total: ['counter', ['completeness'], 'Order readiness events emitted by completeness'],
  lims_lab_barcode_alloc_failures_total: ['counter', ['reason'], 'Specimen barcode allocation failures by reason'],
  // C14 smart report (CR-C14-T17-001 / lead T17-01; 02-TRD §12 lines 573-586; names, types, labels verbatim)
  lims_smartreport_builds_total: ['counter', ['path', 'outcome'], 'Smart-report builds by path and outcome'],
  lims_smartreport_build_duration_seconds: ['histogram', ['path', 'cached'], 'Smart-report build duration in seconds by path and cache hit'],
  lims_smartreport_supersede_total: ['counter', ['reason'], 'Smart-report summaries superseded by reason'],
  lims_smartreport_drafts_pending: ['gauge', ['tenant_id'], 'Smart-report drafts pending review by tenant'],
  lims_smartreport_draft_age_seconds: ['histogram', [], 'Age of smart-report drafts when reviewed, in seconds'],
  lims_smartreport_reviews_total: ['counter', ['action'], 'Smart-report reviews by action'],
  lims_smartreport_library_transitions_total: ['counter', ['to_status'], 'Smart-report library status transitions by target status'],
  lims_smartreport_followup_skipped_total: ['counter', ['reason'], 'Smart-report follow-up suggestions skipped by reason'],
  lims_smartreport_trend_unavailable_total: ['counter', [], 'Smart-report trend computations unavailable'],
  lims_smartreport_llm_runs_total: ['counter', ['outcome'], 'Smart-report LLM runs by outcome'],
  lims_smartreport_llm_items_total: ['counter', ['outcome', 'failure_code'], 'Smart-report LLM items by outcome and failure code'],
  lims_smartreport_llm_calls_while_disabled_total: ['counter', [], 'Smart-report LLM calls attempted while disabled'],
  lims_smartreport_drafts_oldest_age_seconds: ['gauge', ['tenant_id'], 'Age of the oldest pending smart-report draft in seconds (0 when none)'],
  lims_smartreport_llm_circuit_open: ['gauge', [], 'Smart-report LLM circuit breaker open (1) or closed (0)'],
  lims_smartreport_llm_endpoint_refused_total: ['counter', [], 'Smart-report LLM endpoint refusals'],
} as const satisfies Record<string, readonly [Kind, readonly string[], string]>;

export type MetricName = keyof typeof DEFS;
export const REQUIRED_METRICS: readonly MetricName[] = Object.freeze(Object.keys(DEFS) as MetricName[]);
export type Labels = Readonly<Record<string, string | number>>;

export interface CoreMetrics {
  inc(name: MetricName, labels?: Labels, by?: number): void;
  set(name: MetricName, value: number, labels?: Labels): void;
  observe(name: MetricName, value: number, labels?: Labels): void;
  render(): Promise<string>;
  readonly contentType: string;
}

export function createMetrics(): CoreMetrics {
  const registry = new Registry();
  const m = new Map<string, { kind: Kind; metric: Counter | Gauge | Histogram }>();
  for (const [name, [kind, labelNames, help]] of Object.entries(DEFS)) {
    const o = { name, help, labelNames: [...labelNames], registers: [registry] };
    const metric = kind === 'counter' ? new Counter(o) : kind === 'gauge' ? new Gauge(o) : new Histogram(o);
    m.set(name, { kind, metric });
  }
  const get = (name: string, kind: Kind) => {
    const e = m.get(name);
    if (!e || e.kind !== kind) throw new Error(`metrics: unknown ${kind} ${name}`);
    return e.metric as any;
  };
  // prom-client throws on a label outside the declared set.
  return {
    inc: (name, labels = {}, by = 1) => get(name, 'counter').inc(labels, by),
    set: (name, value, labels = {}) => get(name, 'gauge').set(labels, value),
    observe: (name, value, labels = {}) => get(name, 'histogram').observe(labels, value),
    render: () => registry.metrics(),
    contentType: registry.contentType,
  };
}

/** Internal listener on LIMS_CORE_METRICS_PORT (02-TRD §8/§11): GET /metrics and GET /health/live only. */
export async function startMetricsServer(
  metrics: CoreMetrics,
  opts: { port: number; host: string },
): Promise<{ port: number; close(): Promise<void> }> {
  const srv = createServer((req, res) => {
    const path = (req.url ?? '').split('?', 1)[0];
    if (req.method === 'GET' && path === '/metrics') {
      metrics.render().then(
        (text) => { res.writeHead(200, { 'content-type': metrics.contentType }).end(text); },
        () => { res.writeHead(500).end(); },
      );
    } else if (req.method === 'GET' && path === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((ok, fail) => { srv.once('error', fail).listen(opts.port, opts.host, ok); });
  return {
    port: (srv.address() as AddressInfo).port,
    close: () => new Promise<void>((ok) => { srv.closeAllConnections(); srv.close(() => ok()); }),
  };
}
