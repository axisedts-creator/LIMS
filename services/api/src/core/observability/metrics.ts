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
