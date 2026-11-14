// T0D-10 metric presence tests — 02-TRD §13 (required metrics, CV §9.4), §11 LIMS_CORE_METRICS_PORT, §8 note.
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { createMetrics, REQUIRED_METRICS, startMetricsServer } from '../metrics.js';
import { find, samples } from './helpers.js';

// name -> prom type. Source: CV §9.4 "Required per service" + 02-TRD §13 "C0 additions".
const EXPECTED: Record<string, 'counter' | 'gauge' | 'histogram'> = {
  lims_http_requests_total: 'counter',
  lims_http_request_duration_seconds: 'histogram',
  lims_jobs_total: 'counter',
  lims_job_duration_seconds: 'histogram',
  lims_queue_depth: 'gauge',
  lims_core_dead_letters_total: 'counter',
  lims_ratelimit_rejections_total: 'counter',
  lims_rls_denied_total: 'counter',
  lims_core_events_published_total: 'counter',
  lims_core_event_fanout_lag_seconds: 'histogram',
  lims_core_idempotency_replays_total: 'counter',
  lims_core_idempotency_conflicts_total: 'counter',
  lims_core_tx_retries_total: 'counter',
  lims_core_auth_failures_total: 'counter',
  lims_core_fake_ports_active: 'gauge',
  lims_core_phase_stub_ports_active: 'gauge',
  lims_core_authz_not_asserted_total: 'counter',
  lims_core_retention_purged_total: 'counter',
  lims_core_retention_purge_capped_total: 'counter',
  lims_core_storage_deletes_total: 'counter',
  lims_core_port_consumer_not_listed_total: 'counter',
  // C8 additions — LD-88 / CR-C8-016, names+types verbatim from C8 02-TRD §13 lines 846-854.
  lims_analytics_refresh_duration_seconds: 'histogram',
  lims_analytics_refresh_failures_total: 'counter',
  lims_analytics_family_stale: 'gauge',
  lims_analytics_dirty_partitions: 'gauge',
  lims_analytics_reconciliation_mismatch_total: 'counter',
  lims_analytics_exports_total: 'counter',
  lims_analytics_export_rows: 'histogram',
  lims_analytics_export_downloads_total: 'counter',
  lims_analytics_schedule_sends_total: 'counter',
  // C5 additions — LD-120 / CR-C5-T31-001, names+types verbatim from C5 02-TRD §11 lines 468-481.
  lims_lab_specimen_transitions_total: 'counter',
  lims_lab_specimen_creation_lag_seconds: 'histogram',
  lims_lab_results_ingested_total: 'counter',
  lims_lab_ingest_exceptions_open: 'gauge',
  lims_lab_ingest_exception_age_seconds: 'histogram',
  lims_lab_ingest_exception_oldest_open_age_seconds: 'gauge',
  lims_lab_critical_unnotified_oldest_age_seconds: 'gauge',
  lims_lab_result_transitions_total: 'counter',
  lims_lab_critical_detected_total: 'counter',
  lims_lab_critical_unnotified_open: 'gauge',
  lims_lab_formula_errors_total: 'counter',
  lims_lab_host_query_duration_seconds: 'histogram',
  lims_lab_readiness_emitted_total: 'counter',
  lims_lab_barcode_alloc_failures_total: 'counter',
  // C14 additions — CR-C14-T17-001 / lead T17-01, names+types verbatim from C14 02-TRD §12 lines 573-586.
  lims_smartreport_builds_total: 'counter',
  lims_smartreport_build_duration_seconds: 'histogram',
  lims_smartreport_supersede_total: 'counter',
  lims_smartreport_drafts_pending: 'gauge',
  lims_smartreport_draft_age_seconds: 'histogram',
  lims_smartreport_reviews_total: 'counter',
  lims_smartreport_library_transitions_total: 'counter',
  lims_smartreport_followup_skipped_total: 'counter',
  lims_smartreport_trend_unavailable_total: 'counter',
  lims_smartreport_llm_runs_total: 'counter',
  lims_smartreport_llm_items_total: 'counter',
  lims_smartreport_llm_calls_while_disabled_total: 'counter',
  lims_smartreport_drafts_oldest_age_seconds: 'gauge',
  lims_smartreport_llm_circuit_open: 'gauge',
  lims_smartreport_llm_endpoint_refused_total: 'counter',
  // C15 additions — LD-127 / PG-T20, names+types from the C15 TRD section 11 (line 548; ten metrics plus the two backing gauges of 08 A22.4).
  lims_payments_intents_created_total: 'counter',
  lims_payments_intents_transitions_total: 'counter',
  lims_payments_intents_held_total: 'counter',
  lims_payments_gateway_requests_total: 'counter',
  lims_payments_gateway_request_duration_seconds: 'histogram',
  lims_payments_callbacks_total: 'counter',
  lims_payments_open_intents_past_deadline: 'gauge',
  lims_payments_reconciliation_findings_total: 'counter',
  lims_payments_reconciliation_last_success_timestamp_seconds: 'gauge',
  lims_payments_refunds_total: 'counter',
  lims_payments_held_for_review_oldest_age_seconds: 'gauge',
  lims_payments_reconciliation_stalled_runs: 'gauge',
  // C16 additions — LD-142 / CR-C16-T-OPS1, names and types from the C16 TRD section 13 (lines 812-824).
  lims_engagement_otp_requests_total: 'counter',
  lims_engagement_otp_verifications_total: 'counter',
  lims_engagement_link_events_total: 'counter',
  lims_engagement_projection_lag_seconds: 'histogram',
  lims_engagement_projection_drift_total: 'counter',
  lims_engagement_bookings_total: 'counter',
  lims_engagement_slot_conflicts_total: 'counter',
  lims_engagement_queue_tokens_total: 'counter',
  lims_engagement_queue_wait_seconds: 'histogram',
  lims_engagement_displays_stale: 'gauge',
  lims_engagement_payment_requests_total: 'counter',
  lims_engagement_reminders_total: 'counter',
  lims_engagement_report_downloads_total: 'counter',

  // C2 additions — LD-147 / CR-C2-T28-001, names and types from C2 02-TRD section 13 (lines 607-621).
  lims_identity_logins_total: 'counter',
  lims_identity_login_ip_throttles_active: 'gauge',
  lims_identity_mfa_verifications_total: 'counter',
  lims_identity_session_resolves_total: 'counter',
  lims_identity_claims_resolve_duration_seconds: 'histogram',
  lims_identity_authz_decisions_total: 'counter',
  lims_identity_active_sessions: 'gauge',
  lims_identity_gotrue_requests_total: 'counter',
  lims_identity_gotrue_request_duration_seconds: 'histogram',
  lims_identity_audit_exports_total: 'counter',
  lims_identity_support_sessions_active: 'gauge',
  lims_identity_support_sessions_opened_total: 'counter',
  lims_identity_breached_list_loaded: 'gauge',
  lims_identity_settings_cache_total: 'counter',
  lims_identity_login_failures_by_tenant_5m: 'gauge',
  lims_identity_stuffing_distinct_accounts_15m: 'gauge',
  lims_identity_stuffing_distinct_ips_15m: 'gauge',
  lims_identity_audit_exports_tenant_day: 'gauge',
  // LD-162 (CR-C17-HC-T17-REG): C17 02-TRD §14 lines 589-596, verbatim.
  lims_homecollection_mutations_total: 'counter',
  lims_homecollection_push_duration_seconds: 'histogram',
  lims_homecollection_snapshot_duration_seconds: 'histogram',
  lims_homecollection_held_open: 'gauge',
  lims_homecollection_clock_skew_seconds: 'histogram',
  lims_homecollection_devices_stale_total: 'gauge',
  lims_homecollection_handover_overdue_open: 'gauge',
  lims_homecollection_events_published_total: 'counter',

  // C13 additions — CR-C13-T23 / lead T23-01, names and types from C13 02-TRD section 13 (lines 530-539).
  lims_partners_manifests_total: 'counter',
  lims_partners_line_conversions_total: 'counter',
  lims_partners_conversion_duration_seconds: 'histogram',
  lims_partners_events_consumed_total: 'counter',
  lims_partners_projection_lag_seconds: 'gauge',
  lims_partners_report_downloads_total: 'counter',
  lims_partners_access_slips_total: 'counter',
  lims_partners_access_slip_issue_seconds: 'histogram',
  lims_partners_pickups_total: 'counter',
  lims_partners_partner_inactive_rejections_total: 'counter',
};

// LD-88: TRD §13 fixes this C8 histogram as a row count, so it cannot end in _seconds.
const NOT_A_DURATION = new Set(['lims_analytics_export_rows']);

describe('required metrics exist (CV §9.4, 02-TRD §13)', () => {
  it('REQUIRED_METRICS lists exactly the spec names', () => {
    expect([...REQUIRED_METRICS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('every required metric has HELP and TYPE in a fresh registry, before any observation', async () => {
    const text = await createMetrics().render();
    for (const [name, type] of Object.entries(EXPECTED)) {
      expect(text, name).toMatch(new RegExp(`^# HELP ${name} .+$`, 'm'));
      expect(text, name).toContain(`# TYPE ${name} ${type}`);
    }
  });

  it('names follow lims_<module>_<name>_<unit>: counters end _total, histograms _seconds', async () => {
    const text = await createMetrics().render();
    const types = [...text.matchAll(/^# TYPE (\S+) (\S+)$/gm)];
    expect(types.length).toBeGreaterThanOrEqual(Object.keys(EXPECTED).length);
    for (const [, name, type] of types) {
      if (!name!.startsWith('lims_')) continue;
      expect(name).toMatch(/^lims_[a-z0-9_]+$/);
      if (type === 'counter') expect(name).toMatch(/_total$/);
      if (type === 'histogram' && !NOT_A_DURATION.has(name!)) expect(name).toMatch(/_seconds$/);
    }
  });

  it('labels are exactly the spec label sets', async () => {
    const m = createMetrics();
    m.inc('lims_http_requests_total', { module: 'core', operation_id: 'getLiveness', status: '200' });
    m.inc('lims_jobs_total', { task: 'core.event_fanout', outcome: 'ok' });
    m.inc('lims_core_dead_letters_total', { task: 'core.event_fanout' });
    m.inc('lims_ratelimit_rejections_total', { tier: 'login' });
    m.inc('lims_rls_denied_total');
    m.inc('lims_core_events_published_total', { event_type: 'patient.registered' });
    m.inc('lims_core_idempotency_conflicts_total', { kind: 'payload_mismatch' });
    m.inc('lims_core_tx_retries_total', { sqlstate: '40001' });
    m.inc('lims_core_auth_failures_total', { reason: 'alg' });
    m.inc('lims_core_authz_not_asserted_total', { operation_id: 'getThing' });
    m.inc('lims_core_retention_purged_total', { table: 'audit.access_log' });
    m.inc('lims_core_storage_deletes_total', { bucket: 'reports', reason: 'retention' });
    m.inc('lims_core_port_consumer_not_listed_total', { module: 'lab', port: 'CatalogPort' });
    m.set('lims_queue_depth', 3, { task: 'core.event_fanout' });
    m.set('lims_core_fake_ports_active', 2);
    m.observe('lims_job_duration_seconds', 0.2, { task: 'core.event_fanout' });
    m.observe('lims_core_event_fanout_lag_seconds', 1.5);
    const text = await m.render();
    expect(find(text, 'lims_http_requests_total')[0]).toMatchObject({
      labels: { module: 'core', operation_id: 'getLiveness', status: '200' }, value: 1,
    });
    expect(find(text, 'lims_rls_denied_total')[0]!.value).toBe(1);
    expect(find(text, 'lims_queue_depth', { task: 'core.event_fanout' })[0]!.value).toBe(3);
    expect(find(text, 'lims_core_fake_ports_active')[0]!.value).toBe(2);
    expect(find(text, 'lims_job_duration_seconds_count', { task: 'core.event_fanout' })[0]!.value).toBe(1);
    expect(find(text, 'lims_core_event_fanout_lag_seconds_bucket').length).toBeGreaterThan(1);
    expect(find(text, 'lims_core_tx_retries_total', { sqlstate: '40001' })[0]!.value).toBe(1);
  });

  it('rejects unknown metric names and labels (typo guard; no id/PHI labels — CV §9.4)', () => {
    const m = createMetrics();
    expect(() => m.inc('lims_nope_total')).toThrow(/lims_nope_total/);
    expect(() => m.inc('lims_http_requests_total', { module: 'core', operation_id: 'x', status: '200', patient_id: 'p1' } as any)).toThrow();
    expect(() => m.inc('lims_http_requests_total', { module: 'core', operation_id: 'x', status: '200', tenant_id: 't1' } as any)).toThrow();
  });

  it('registries are independent per createMetrics() call (no process-global state)', async () => {
    const a = createMetrics();
    const b = createMetrics();
    a.inc('lims_rls_denied_total');
    expect(find(await a.render(), 'lims_rls_denied_total')[0]!.value).toBe(1);
    expect(find(await b.render(), 'lims_rls_denied_total').every((s) => s.value === 0)).toBe(true);
  });

  it('exposes the Prometheus content type', () => {
    expect(createMetrics().contentType).toMatch(/^text\/plain/);
  });
});

describe('LIMS_CORE_METRICS_PORT config (02-TRD §11)', () => {
  const env = (extra: Record<string, string> = {}) => loadConfig({ LIMS_CORE_ENV: 'ci', ...extra });
  it('defaults to 9464', () => expect(env().metricsPort).toBe(9464));
  it('reads the key', () => expect(env({ LIMS_CORE_METRICS_PORT: '9100' }).metricsPort).toBe(9100));
  it.each(['abc', '-1', '70000', '9100.5', ''])('rejects %j naming the key', (v) => {
    expect(() => env({ LIMS_CORE_METRICS_PORT: v })).toThrow(/LIMS_CORE_METRICS_PORT/);
  });
});

describe('metrics listener (separate internal port, 02-TRD §8/§11)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });
  const start = async () => {
    const metrics = createMetrics();
    metrics.inc('lims_rls_denied_total');
    const srv = await startMetricsServer(metrics, { port: 0, host: '127.0.0.1' });
    closers.push(srv.close);
    return { srv, base: `http://127.0.0.1:${srv.port}` };
  };

  it('GET /metrics serves the exposition with all required metrics', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/metrics`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await r.text();
    for (const name of Object.keys(EXPECTED)) expect(text).toContain(`# TYPE ${name} `);
    expect(samples(text).find((s) => s.name === 'lims_rls_denied_total')!.value).toBe(1);
  });

  it('GET /health/live is also served here (LIMS_CORE_SHUTDOWN_GRACE_S row)', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/health/live`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
  });

  it('serves nothing else: unknown paths 404, non-GET 404/405, no API surface', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/v1/core/health/ready`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect([404, 405]).toContain((await fetch(`${base}/metrics`, { method: 'POST', body: 'x' })).status);
  });

  it('close() stops the listener', async () => {
    const { srv, base } = await start();
    await srv.close();
    closers.length = 0;
    await expect(fetch(`${base}/metrics`)).rejects.toThrow();
  });
});
