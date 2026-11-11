// C6-T34 — reporting/delivery load test (k6). Synthetic data only; non-production targets only.
// Targets: 02-TRD §11 (N = 10 labs, 10x seed = 10 labs x 1000 PDFs/day), 01-PRD §6.
//   renders: 42/min for 15 min | bulk release: 200 ids per request | deliveries: 1/s
// Pass = k6 thresholds below (a failed threshold makes k6 exit non-zero):
//   render p95 <= 5 s | ready->rendered p95 <= 60 s | bulk-200 p95 <= 8 s | send task p95 <= 1 s | QR verify p95 <= 100 ms | render failures < 1 %.
// Env: TARGET_URL TARGET_ENV (staging|compose|ci) STAFF_TOKEN SEED_COUNT (default 10000) ; *_PATH overrides below.
// setup() validates TARGET_ENV and throws before any request, so `k6 inspect` works with no env (LD-45 pattern, infra/tests/load/flood.js).
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BULK_SIZE = 200;
const SEED_DEFAULT = 10 * 1000; // 10 labs x 1000 PDFs/day
// ponytail: route paths are overridable; the spec fixes only POST /v1/reporting/verifications, the rest are assumed (see C6-T34-impl.md).
const P = {
  seed: __ENV.SEED_PATH || '/v1/reporting/test-support/seed',
  render: __ENV.RENDER_PATH || '/v1/reporting/report-versions',
  bulkRelease: __ENV.BULK_RELEASE_PATH || '/v1/reporting/report-versions/release',
  delivery: __ENV.DELIVERY_PATH || '/v1/reporting/deliveries',
  verify: __ENV.VERIFY_PATH || '/v1/reporting/verifications',
};

export const options = {
  scenarios: {
    renders: { executor: 'constant-arrival-rate', rate: 42, timeUnit: '1m', duration: '15m', preAllocatedVUs: 10, maxVUs: 60, exec: 'renderReport' },
    bulk_release: { executor: 'constant-arrival-rate', rate: 1, timeUnit: '1m', duration: '15m', preAllocatedVUs: 2, maxVUs: 10, exec: 'bulkRelease' },
    deliveries: { executor: 'constant-arrival-rate', rate: 1, timeUnit: '1s', duration: '15m', preAllocatedVUs: 5, maxVUs: 40, exec: 'sendDelivery' },
    qr_verify: { executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: '15m', preAllocatedVUs: 5, maxVUs: 30, exec: 'qrVerify' },
  },
  thresholds: {
    render_ms: [{ threshold: 'p(95)<5000', abortOnFail: true, delayAbortEval: '2m' }],
    ready_to_rendered_ms: ['p(95)<60000'],
    bulk_release_ms: ['p(95)<8000'],
    send_task_ms: ['p(95)<1000'],
    qr_verify_ms: ['p(95)<100'],
    render_failed: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

const renderMs = new Trend('render_ms', true);
const readyToRendered = new Trend('ready_to_rendered_ms', true);
const bulkMs = new Trend('bulk_release_ms', true);
const sendMs = new Trend('send_task_ms', true);
const qrMs = new Trend('qr_verify_ms', true);
const renderFailed = new Rate('render_failed');

const base = () => String(__ENV.TARGET_URL || '').replace(/\/+$/, '');
const hdr = () => ({ headers: { Authorization: `Bearer ${__ENV.STAFF_TOKEN}`, 'Content-Type': 'application/json' }, timeout: '30s' });
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function setup() {
  const env = __ENV.TARGET_ENV;
  if (!['staging', 'compose', 'ci'].includes(env)) throw new Error(`refusing TARGET_ENV=${env}: use staging, compose or ci`);
  if (!__ENV.TARGET_URL || !__ENV.STAFF_TOKEN) throw new Error('TARGET_URL and STAFF_TOKEN are required');
  const count = Number(__ENV.SEED_COUNT || SEED_DEFAULT);
  if (count < SEED_DEFAULT) throw new Error(`SEED_COUNT ${count} < 10x seed (${SEED_DEFAULT})`);
  // seed = synthetic ready reports (10x seed); the server returns the ids that drive the scenarios.
  const r = http.post(base() + P.seed, JSON.stringify({ count, synthetic: true }), hdr());
  if (r.status !== 200 && r.status !== 201) throw new Error(`seed failed: ${r.status}`);
  return { ids: r.json('report_version_ids') || [], tokens: r.json('qr_tokens') || [] };
}

export function renderReport(data) {
  const t0 = Date.now();
  const r = http.post(`${base()}${P.render}/${pick(data.ids)}/render`, '{}', hdr());
  renderFailed.add(!check(r, { 'render accepted/ok': (x) => x.status === 200 || x.status === 202 }));
  renderMs.add(r.timings.duration);
  readyToRendered.add(Date.now() - t0);
}

export function bulkRelease(data) {
  const ids = Array.from({ length: BULK_SIZE }, () => pick(data.ids));
  const r = http.post(base() + P.bulkRelease, JSON.stringify({ report_version_ids: ids }), hdr());
  check(r, { 'bulk release ok': (x) => x.status === 200 || x.status === 207 });
  bulkMs.add(r.timings.duration);
}

export function sendDelivery(data) {
  const r = http.post(base() + P.delivery, JSON.stringify({ report_version_id: pick(data.ids), channel: 'whatsapp' }), hdr());
  check(r, { 'delivery task enqueued': (x) => x.status === 200 || x.status === 202 });
  sendMs.add(r.timings.duration);
}

export function qrVerify(data) {
  const r = http.post(base() + P.verify, JSON.stringify({ token: pick(data.tokens) }), { headers: { 'Content-Type': 'application/json' }, timeout: '5s' });
  check(r, { 'verify ok': (x) => x.status === 200 });
  qrMs.add(r.timings.duration);
}
