// C1 T-32 / AC-24.1 — staging flood + burst load test (k6). Synthetic data only; staging only.
//   baseline -> burst (500 req/s, PgBouncer cl_waiting probe) -> flood (5,000 req/s x 60 s anonymous)
//   with an authenticated staff probe running alongside the flood.
// LD-45: TARGET_ENV must be `staging` or `staging-lean`; anything else is refused in setup(), before any request.
// Pass (also enforced by k6 thresholds => non-zero exit) [CONV]: shed 429/503 seen on flood traffic AND staff p95 during
//   flood < 2x idle baseline AND PgBouncer cl_waiting max == 0 AND fd used ratio max < 0.9. No Prometheus evidence = fail.
//   Also: burst_ok rate > 0.99 (burst must really reach the API, not be shed by edge `perip` 100r/s; review T-32 item 1).
// Env: TARGET_URL TARGET_ENV STAFF_TOKEN PROMETHEUS_URL REPORT_PATH (required); STAFF_PATH (default below);
//   STAFF_URL (default TARGET_URL): base URL for ALL bearer traffic (calibration, baseline, burst, staff probe).
//   BASELINE_/BURST_/FLOOD_ RATE (req/s) and DURATION (e.g. 60s) overrides. Nothing is read-and-thrown at init so
//   `k6 inspect` works with no env.
// RUN NOTES (review T-32 item 2): edge `perip` and fail2ban `lims-ratelimit` shed/ban the flood source IP. Send the flood from
//   one source IP (TARGET_URL) and the bearer traffic from a SEPARATE source IP (STAFF_URL, e.g. a second k6 instance or
//   `--local-ips`). Add that load-generator IP to fail2ban `ignoreip` for the staging run only; remove it afterwards.
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';

function toSec(v) {
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(v);
  if (!v || !m) throw new Error('bad duration ' + v + ' (use e.g. 60s, 2m)');
  return (Number(m[1]) || 0) * 60 + (Number(m[2]) || 0);
}

const RATE = { baseline: Number(__ENV.BASELINE_RATE || 60), burst: Number(__ENV.BURST_RATE || 500), flood: Number(__ENV.FLOOD_RATE || 5000) };
const DUR = {
  baseline: toSec(__ENV.BASELINE_DURATION || '60s'),
  burst: toSec(__ENV.BURST_DURATION || '60s'),
  flood: toSec(__ENV.FLOOD_DURATION || '60s'),
};
const BURST_AT = DUR.baseline;
const FLOOD_AT = DUR.baseline + DUR.burst;
const TOTAL_S = FLOOD_AT + DUR.flood;
const STAFF_RATE = 20; // staff probe alongside the flood, well below the flood rate
// ponytail: staff-readable list route GET /v1/catalog/tests (owner C3, 02-TRD row 23) used as the API probe; override with STAFF_PATH if renamed.
const STAFF_PATH = __ENV.STAFF_PATH || '/v1/catalog/tests';

const arrival = (name, rate, duration, startTime, maxVUs) => ({
  executor: 'constant-arrival-rate',
  rate,
  timeUnit: '1s',
  duration: duration + 's',
  startTime: startTime + 's',
  preAllocatedVUs: Math.max(5, Math.min(maxVUs, Math.ceil(rate / 10))),
  maxVUs,
  exec: name,
});

export const options = {
  scenarios: {
    baseline: arrival('baselineTraffic', RATE.baseline, DUR.baseline, 0, 200),
    burst: arrival('burstTraffic', RATE.burst, DUR.burst, BURST_AT, 1000),
    flood: arrival('floodTraffic', RATE.flood, DUR.flood, FLOOD_AT, Math.max(500, Math.ceil(RATE.flood / 2))),
    staff_during_flood: arrival('staffDuringFlood', STAFF_RATE, DUR.flood, FLOOD_AT, 200),
  },
  thresholds: {
    shed_responses: ['count>0'],
    burst_ok: ['rate>0.99'],
    staff_flood_samples: ['count>0'],
    staff_flood_errors: ['rate==0'],
    staff_flood_ratio: ['p(95)<2'],
    pgbouncer_cl_waiting_max: ['value==0'],
    fd_used_ratio_max: ['value<0.9'],
    prom_evidence_missing: ['count==0'],
  },
};

const shed = new Counter('shed_responses');
const burstOk = new Rate('burst_ok');
const staffSamples = new Counter('staff_flood_samples');
const staffErrors = new Rate('staff_flood_errors');
const staffFloodMs = new Trend('staff_flood_ms', true);
const staffFloodRatio = new Trend('staff_flood_ratio'); // flood latency / idle baseline p95 => p95 of this is the AC-24.1 ratio
const baselineP95 = new Gauge('staff_baseline_p95_ms');
const clWaitingMax = new Gauge('pgbouncer_cl_waiting_max');
const fdRatioMax = new Gauge('fd_used_ratio_max');
const promMissing = new Counter('prom_evidence_missing');

const base = (u) => String(u || '').replace(/\/+$/, '');
const staffReq = (phase) =>
  http.get(base(__ENV.STAFF_URL || __ENV.TARGET_URL) + STAFF_PATH, {
    headers: { Authorization: `Bearer ${__ENV.STAFF_TOKEN}` },
    tags: { phase },
    timeout: '10s',
  });

function p95(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

export function setup() {
  const env = __ENV.TARGET_ENV;
  if (env !== 'staging' && env !== 'staging-lean') {
    throw new Error('refused: TARGET_ENV must be staging or staging-lean (LD-45), got ' + JSON.stringify(env));
  }
  for (const k of ['TARGET_URL', 'STAFF_TOKEN', 'PROMETHEUS_URL', 'REPORT_PATH']) {
    if (!__ENV[k]) throw new Error('refused: ' + k + ' is required');
  }
  // Idle baseline for AC-24.1 "p95 < 2x baseline": 40 sequential authenticated probes before any load.
  const lat = [];
  for (let i = 0; i < 40; i++) {
    const r = staffReq('calibration');
    if (r.status !== 200) throw new Error('refused: staff probe returned ' + r.status + ' before load; check STAFF_TOKEN/STAFF_PATH');
    lat.push(r.timings.duration);
    sleep(0.02);
  }
  const b = p95(lat);
  baselineP95.add(b);
  return { baseline: b };
}

export function baselineTraffic() {
  staffReq('baseline');
}

export function burstTraffic() {
  const r = staffReq('burst'); // authenticated; PgBouncer cl_waiting is read from Prometheus in teardown
  burstOk.add(r.status === 200); // a shed (429) burst never reached PgBouncer, so cl_waiting==0 alone proves nothing
}

export function floodTraffic() {
  const r = http.get(base(__ENV.TARGET_URL) + STAFF_PATH, { tags: { phase: 'flood' }, timeout: '5s' }); // anonymous, no token
  shed.add(r.status === 429 || r.status === 503 ? 1 : 0);
}

export function staffDuringFlood(data) {
  const r = staffReq('staff_during_flood');
  staffSamples.add(1);
  staffErrors.add(r.status !== 200);
  if (r.status === 200) {
    staffFloodMs.add(r.timings.duration);
    staffFloodRatio.add(r.timings.duration / data.baseline);
  }
}

function promMax(query) {
  try {
    const r = http.get(base(__ENV.PROMETHEUS_URL) + '/api/v1/query?query=' + encodeURIComponent(query), { timeout: '10s', tags: { phase: 'prometheus' } });
    if (r.status !== 200) return null;
    const res = r.json().data.result;
    if (!res || res.length === 0) return null;
    const vals = res.map((x) => Number(x.value[1]));
    return vals.some((v) => Number.isNaN(v)) ? null : Math.max(...vals);
  } catch (e) {
    return null;
  }
}

export function teardown() {
  const win = TOTAL_S + 90; // whole run + setup calibration + graceful stop
  const waiting = promMax(`max(max_over_time(pgbouncer_pools_client_waiting_connections[${win}s]))`);
  const fd = promMax(`max(max_over_time((node_filefd_allocated / node_filefd_maximum)[${win}s:5s]))`);
  if (waiting === null || fd === null) {
    promMissing.add(1); // empty/failed Prometheus answer is NOT "0 waiting": fail
  } else {
    promMissing.add(0);
    clWaitingMax.add(waiting);
    fdRatioMax.add(fd);
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const v = (name, key) => (m[name] && m[name].values && m[name].values[key] !== undefined ? m[name].values[key] : null);
  const ratio = v('staff_flood_ratio', 'p(95)');
  const waiting = v('pgbouncer_cl_waiting_max', 'value');
  const fd = v('fd_used_ratio_max', 'value');
  const shedN = v('shed_responses', 'count');
  const burstRate = v('burst_ok', 'rate');
  const thresholdsOk = Object.values(m).every((x) => !x.thresholds || Object.values(x.thresholds).every((t) => t.ok));
  const pass = !!(
    thresholdsOk && burstRate !== null && burstRate > 0.99 && shedN > 0 && ratio !== null && ratio < 2 && waiting === 0 && fd !== null && fd < 0.9
  );
  const report = {
    ac: 'AC-24.1',
    pass,
    target_env: __ENV.TARGET_ENV || null,
    flood_rate: RATE.flood,
    burst_ok_rate: burstRate,
    shed_responses: shedN,
    staff_p95_baseline_ms: v('staff_baseline_p95_ms', 'value'),
    staff_p95_flood_ms: v('staff_flood_ms', 'p(95)'),
    staff_p95_ratio: ratio,
    pgbouncer_cl_waiting_max: waiting,
    fd_used_ratio_max: fd,
    dropped_iterations: v('dropped_iterations', 'count'), // informational: flood rate actually delivered
  };
  const out = { stdout: 'AC-24.1 ' + (pass ? 'PASS' : 'FAIL') + '\n' };
  if (__ENV.REPORT_PATH) out[__ENV.REPORT_PATH] = JSON.stringify(report, null, 2);
  return out;
}
