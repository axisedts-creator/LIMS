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
  // C15 payments (PG-T20; LD-127 2026-11-12; 02-TRD §11 incl. the 08 A22.4 backing gauges; names, types, labels verbatim)
  lims_payments_intents_created_total: ['counter', ['gateway'], 'Payment intents created by gateway'],
  lims_payments_intents_transitions_total: ['counter', ['gateway', 'to_status'], 'Payment intent transitions by gateway and target status'],
  lims_payments_intents_held_total: ['counter', ['gateway', 'reason'], 'Payment intents held for review by gateway and reason'],
  lims_payments_gateway_requests_total: ['counter', ['gateway', 'operation', 'outcome'], 'Gateway requests by gateway, operation and outcome'],
  lims_payments_gateway_request_duration_seconds: ['histogram', ['gateway', 'operation'], 'Gateway request duration in seconds'],
  lims_payments_callbacks_total: ['counter', ['gateway', 'kind', 'outcome'], 'Gateway callbacks by gateway, kind and outcome'],
  lims_payments_open_intents_past_deadline: ['gauge', ['gateway'], 'Open payment intents past their deadline by gateway (set by sweep)'],
  lims_payments_reconciliation_findings_total: ['counter', ['kind', 'severity'], 'Reconciliation findings by kind and severity'],
  lims_payments_reconciliation_last_success_timestamp_seconds: ['gauge', ['tenant_id'], 'Unix time of the last successful reconciliation run by tenant'],
  lims_payments_refunds_total: ['counter', ['gateway', 'mode', 'status'], 'Refunds by gateway, mode and status'],
  lims_payments_held_for_review_oldest_age_seconds: ['gauge', ['tenant_id', 'kind'], 'Age of the oldest held_for_review intent or refund in seconds (0 when none)'],
  lims_payments_reconciliation_stalled_runs: ['gauge', ['tenant_id'], 'Reconciliation runs stalled in running for over 2 h'],
  // C16 patient engagement (CR-C16-T-OPS1; LD-142 2026-11-13; 02-TRD §13 lines 812-824; names, types, labels verbatim)
  lims_engagement_otp_requests_total: ['counter', ['outcome'], 'Patient OTP requests by outcome'],
  lims_engagement_otp_verifications_total: ['counter', ['outcome'], 'Patient OTP verifications by outcome'],
  lims_engagement_link_events_total: ['counter', ['method', 'outcome'], 'Patient link events by method and outcome'],
  lims_engagement_projection_lag_seconds: ['histogram', ['event_type'], 'Engagement projection lag in seconds by event type'],
  lims_engagement_projection_drift_total: ['counter', ['table'], 'Engagement projection drift detections by table'],
  lims_engagement_bookings_total: ['counter', ['kind', 'outcome'], 'Bookings by kind and outcome'],
  lims_engagement_slot_conflicts_total: ['counter', [], 'Booking slot conflicts'],
  lims_engagement_queue_tokens_total: ['counter', ['event'], 'Queue token events by event'],
  lims_engagement_queue_wait_seconds: ['histogram', [], 'Queue wait time in seconds'],
  lims_engagement_displays_stale: ['gauge', [], 'Queue displays currently stale'],
  lims_engagement_payment_requests_total: ['counter', ['gateway', 'outcome'], 'Patient payment requests by gateway and outcome'],
  lims_engagement_reminders_total: ['counter', ['kind', 'outcome'], 'Reminders by kind and outcome'],
  lims_engagement_report_downloads_total: ['counter', ['outcome'], 'Patient report downloads by outcome'],
  // C2 identity (CR-C2-T28-001; LD-147 2026-11-13; C2 02-TRD §13 lines 607-621 incl. the four backing gauges; names, types, labels verbatim)
  lims_identity_logins_total: ['counter', ['outcome', 'kind'], 'Staff login attempts by outcome and login kind'],
  lims_identity_login_ip_throttles_active: ['gauge', [], 'Client IPs currently under the login IP throttle'],
  lims_identity_mfa_verifications_total: ['counter', ['outcome', 'flow'], 'MFA code verifications by outcome and flow'],
  lims_identity_session_resolves_total: ['counter', ['outcome'], 'Session resolves by outcome'],
  lims_identity_claims_resolve_duration_seconds: ['histogram', [], 'Bearer claims resolve duration in seconds'],
  lims_identity_authz_decisions_total: ['counter', ['outcome', 'privileged'], 'Authorisation decisions by outcome and privileged flag'],
  lims_identity_active_sessions: ['gauge', ['kind'], 'Active sessions by session kind'],
  lims_identity_gotrue_requests_total: ['counter', ['op', 'outcome'], 'GoTrue requests by operation and outcome'],
  lims_identity_gotrue_request_duration_seconds: ['histogram', ['op', 'outcome'], 'GoTrue request duration in seconds by operation and outcome'],
  lims_identity_audit_exports_total: ['counter', ['tenant_id', 'source'], 'Audit exports created by tenant and source'],
  lims_identity_support_sessions_active: ['gauge', [], 'Support sessions currently active'],
  lims_identity_support_sessions_opened_total: ['counter', ['scope'], 'Support sessions opened by scope'],
  lims_identity_breached_list_loaded: ['gauge', [], 'Breached-password list loaded (1) or missing (0)'],
  lims_identity_settings_cache_total: ['counter', ['result'], 'Tenant settings cache lookups by result'],
  lims_identity_login_failures_by_tenant_5m: ['gauge', ['tenant_id'], 'Failed logins of known accounts in the last 5 minutes by tenant'],
  lims_identity_stuffing_distinct_accounts_15m: ['gauge', [], 'Distinct failing accounts in the last 15 minutes'],
  lims_identity_stuffing_distinct_ips_15m: ['gauge', [], 'Distinct failing client IPs in the last 15 minutes'],
  lims_identity_audit_exports_tenant_day: ['gauge', ['tenant_id'], 'Audit exports created today by tenant'],
  // C17 home collection (CR-C17-HC-T17-REG; LD-162 2026-11-14; C17 02-TRD §14 lines 589-596; names, types, labels verbatim)
  lims_homecollection_mutations_total: ['counter', ['type', 'outcome'], 'Home-collection sync mutations by type and outcome'],
  lims_homecollection_push_duration_seconds: ['histogram', [], 'Home-collection sync push duration in seconds'],
  lims_homecollection_snapshot_duration_seconds: ['histogram', ['changed'], 'Home-collection sync snapshot duration in seconds by changed flag'],
  lims_homecollection_held_open: ['gauge', ['tenant_id'], 'Open held home-collection mutations by tenant'],
  lims_homecollection_clock_skew_seconds: ['histogram', ['clock_source'], 'Device clock skew in seconds by clock source'],
  lims_homecollection_devices_stale_total: ['gauge', ['tenant_id'], 'Stale phlebotomy devices (pending sync, last seen over 2 h ago) by tenant'],
  lims_homecollection_handover_overdue_open: ['gauge', ['tenant_id'], 'Open overdue sample handovers by tenant'],
  lims_homecollection_events_published_total: ['counter', [], 'Home-collection domain events published'],
  // C13 b2b partner portal (CR-C13-T23; 02-TRD §13 lines 530-539; names, types, labels verbatim; lead T23-01)
  lims_partners_manifests_total: ['counter', ['transition'], 'Partner manifest transitions by transition'],
  lims_partners_line_conversions_total: ['counter', ['outcome', 'failure_code'], 'Partner manifest line conversions by outcome and failure code'],
  lims_partners_conversion_duration_seconds: ['histogram', [], 'Partner manifest line conversion duration in seconds'],
  lims_partners_events_consumed_total: ['counter', ['event_type', 'outcome'], 'Partner events consumed by event type and outcome'],
  lims_partners_projection_lag_seconds: ['gauge', ['projection'], 'Partner projection lag in seconds by projection'],
  lims_partners_report_downloads_total: ['counter', ['outcome'], 'Partner report downloads by outcome'],
  lims_partners_access_slips_total: ['counter', ['outcome'], 'Partner access slips by outcome'],
  lims_partners_access_slip_issue_seconds: ['histogram', [], 'Partner access slip issue duration in seconds'],
  lims_partners_pickups_total: ['counter', ['transition'], 'Partner pickup transitions by transition'],
  lims_partners_partner_inactive_rejections_total: ['counter', [], 'Requests rejected because the partner is inactive'],
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
