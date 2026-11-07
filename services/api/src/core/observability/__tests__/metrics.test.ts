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
};

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
      if (type === 'histogram') expect(name).toMatch(/_seconds$/);
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
