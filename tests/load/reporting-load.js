// C6-T34 load harness (k6). 02-TRD §11 targets at 10x seed (01-PRD §6 success metrics). Synthetic data only.
// Routes are the catalogued ones of 02-TRD §6 (base /v1/reporting): R3 getReport, R7 bulk-release {ids}, R9 regenerations,
// R17 coded-sets, D3 POST /reports/{report_id}/deliveries, Q1 POST /verifications {qr_token}. No invented render route:
// a render is triggered with R9 (new version -> assemble -> render) and observed with R3 polls (C6-T34 ruling).
// The seed uses the non-production test-support route of .orchestra/cr/C6-T34 (resolved); it is absent in production.
// Run: see tests/load/README.md. Refuses any TARGET_ENV other than staging, compose or ci (LD-45 pattern, infra/tests/load/flood.js).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BULK_SIZE = 200; // R7 max ids per request (02-TRD §6.2; §11 "Bulk release 200")
const SEED_DEFAULT = 10 * 1000; // 10x seed: 10 labs x 1000 PDFs/day (02-TRD §11)
const API = '/v1/reporting';

const P = {
  seed: `${API}/test-support/seed`,
  codedSet: (name) => `${API}/coded-sets/${name}`,
  report: (reportId) => `${API}/reports/${reportId}`,
  regenerate: (reportId) => `${API}/reports/${reportId}/regenerations`,
  bulkRelease: `${API}/report-versions/bulk-release`,
  deliveries: (reportId) => `${API}/reports/${reportId}/deliveries`,
  verify: `${API}/verifications`,
};

export const options = {
  scenarios: {
    renders: { executor: 'constant-arrival-rate', rate: 42, timeUnit: '1m', duration: '15m', preAllocatedVUs: 20, maxVUs: 120, exec: 'renderReport' },
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
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.floor(Math.random() * 16);
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});
const hdr = (idem) => ({
  headers: { Authorization: `Bearer ${__ENV.STAFF_TOKEN}`, 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': uuid() } : {}) },
  timeout: '30s',
});
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const distinct = (a, n) => {
  const copy = a.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy.slice(0, n);
};
const newestVersion = (detail) => (detail && Array.isArray(detail.versions) ? detail.versions.reduce((m, v) => (!m || v.version_no > m.version_no ? v : m), null) : null);

export function setup() {
  const env = __ENV.TARGET_ENV;
  if (!['staging', 'compose', 'ci'].includes(env)) throw new Error(`refusing TARGET_ENV=${env}: use staging, compose or ci`);
  if (!__ENV.TARGET_URL || !__ENV.STAFF_TOKEN) throw new Error('TARGET_URL and STAFF_TOKEN are required');
  const count = Number(__ENV.SEED_COUNT || SEED_DEFAULT);
  if (!(count >= SEED_DEFAULT)) throw new Error(`SEED_COUNT ${count} < 10x seed (${SEED_DEFAULT})`);

  const r = http.post(base() + P.seed, JSON.stringify({ count }), { ...hdr(true), timeout: '600s' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`seed failed: ${r.status}`);
  const data = {
    reportIds: r.json('report_ids') || [],
    versionIds: r.json('report_version_ids') || [],
    releasedReportIds: r.json('released_report_ids') || [],
    tokens: r.json('qr_tokens') || [],
  };
  if (data.tokens.length === 0) throw new Error('seed returned no qr_tokens: QR verify scenario would be vacuous');
  if (data.versionIds.length < BULK_SIZE) throw new Error(`seed returned ${data.versionIds.length} report_version_ids, need >= ${BULK_SIZE} for bulk release`);
  if (data.releasedReportIds.length === 0) throw new Error('seed returned no released_report_ids: delivery scenario would be vacuous');
  if (data.reportIds.length === 0 && data.releasedReportIds.length === 0) throw new Error('seed returned no report_ids: render scenario would be vacuous');

  const codes = http.get(base() + P.codedSet('regeneration_reasons'), hdr(false));
  const list = (codes.status === 200 && codes.json('data')) || [];
  const reason = list.find((c) => c.code !== 'other' && c.code !== 'smart_summary_added');
  if (!reason) throw new Error('coded set regeneration_reasons has no usable code');
  data.reasonCode = reason.code;
  return data;
}

// R9 regeneration -> new version is assembled and rendered by the worker; R3 polls observe it.
// ready_to_rendered_ms = R9 accepted -> new version `rendered`; render_ms = first `rendering` poll -> `rendered` (250 ms granularity).
export function renderReport(data) {
  const reportId = pick(data.reportIds.length ? data.reportIds : data.releasedReportIds);
  const before = newestVersion(http.get(base() + P.report(reportId), hdr(false)).json());
  const t0 = Date.now();
  const r = http.post(base() + P.regenerate(reportId), JSON.stringify({ reason_code: data.reasonCode }), hdr(true));
  if (!check(r, { 'regeneration accepted': (x) => x.status === 202 })) { renderFailed.add(true); return; }
  let renderingAt = null;
  while (Date.now() - t0 < 90000) {
    sleep(0.25);
    const v = newestVersion(http.get(base() + P.report(reportId), hdr(false)).json());
    if (!v || (before && v.version_no <= before.version_no)) continue;
    if (v.status === 'rendering' && renderingAt === null) renderingAt = Date.now();
    if (v.status === 'render_failed') { renderFailed.add(true); return; }
    if (v.status === 'rendered' || v.status === 'released' || v.status === 'held') {
      const now = Date.now();
      readyToRendered.add(now - t0);
      renderMs.add(now - (renderingAt === null ? t0 : renderingAt));
      renderFailed.add(false);
      return;
    }
  }
  renderFailed.add(true);
}

export function bulkRelease(data) {
  const ids = distinct(data.versionIds, BULK_SIZE); // R7: 1-200 unique ids
  const r = http.post(base() + P.bulkRelease, JSON.stringify({ ids }), hdr(true));
  check(r, { 'bulk release 200 with per-id results': (x) => x.status === 200 && Array.isArray(x.json('results')) });
  bulkMs.add(r.timings.duration);
}

// send_task_ms = D3 enqueue latency (the worker send-task metric is not scraped by k6).
export function sendDelivery(data) {
  const reportId = pick(data.releasedReportIds);
  const r = http.post(base() + P.deliveries(reportId), JSON.stringify({ recipient_kind: 'patient', channel: 'whatsapp' }), hdr(true));
  check(r, { 'delivery created': (x) => x.status === 201 });
  sendMs.add(r.timings.duration);
}

export function qrVerify(data) {
  const r = http.post(base() + P.verify, JSON.stringify({ qr_token: pick(data.tokens) }), { headers: { 'Content-Type': 'application/json' }, timeout: '5s' });
  check(r, { 'verify ok': (x) => x.status === 200 });
  qrMs.add(r.timings.duration);
}
