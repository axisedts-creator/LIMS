// C16 T-PERF1 — engagement load test (k6) per 02-TRD §12, at 1x (one lab) and 10x (N = 10 labs). Synthetic data only; staging only.
// Pattern: infra/tests/load/flood.js (C1 T-32). LD-45: TARGET_ENV must be `staging` or `staging-lean`, refused in setup() before any request.
// LD-184: this file is a TEST-folder file owned by the tester; p95 evidence at SCALE=1 and SCALE=10 must come from a Linux/staging run
//   (a localhost mock on a Windows host quantises to the ~15.6 ms timer tick). Thresholds below are the TRD §12 budgets, unchanged.
// Flows (scenario name == flow tag), all under /v1/engagement, rates are req/s at SCALE=10 and /10 at SCALE=1:
//   getMyOrder 17 | listMyOrders 2.1 | getQueueBoard 40 | listMyAvailableSlots 0.35 [CONV: TRD gives no rate; 5x bookings] | createMyBooking 0.07
// Budgets (p95, ms): getMyOrder 200:40 304:10; listMyOrders 80; getQueueBoard 200:20 304:5; listMyAvailableSlots 100; createMyBooking 150.
// Not covered here: queue operations (50 ms), OTP verify (250 ms), report download (500 ms); consumer p95 30 ms is consumer.pgbench.sql.
// Env: TARGET_URL TARGET_ENV SCALE(1|10, default 1) DURATION(default 5m) PATIENT_TOKEN DISPLAY_TOKEN ORDER_ID PROFILE_ID CENTRE_ID ORDERABLE_ID.
//   Tokens travel in headers only. Nothing but SCALE is read at init, so `k6 inspect -e SCALE=10` works with no other env.
// Run (Linux/staging):  k6 run -e SCALE=10 -e DURATION=5m <this file>   then again with -e SCALE=1.
import http from 'k6/http';

const SCALE = __ENV.SCALE === undefined || __ENV.SCALE === '' ? 1 : Number(__ENV.SCALE);
if (SCALE !== 1 && SCALE !== 10) throw new Error('SCALE must be 1 or 10, got ' + JSON.stringify(__ENV.SCALE));
const DURATION = __ENV.DURATION || '5m';
const PREFIX = '/v1/engagement';

// timeUnit 1000s keeps every rate an integer at both scales (0.07 req/s = 70 per 1000 s; 1x = exactly one tenth).
const arrival = (flow, perSec10, maxVUs) => ({
  executor: 'constant-arrival-rate',
  rate: Math.round((perSec10 * 1000 * SCALE) / 10),
  timeUnit: '1000s',
  duration: DURATION,
  preAllocatedVUs: 5,
  maxVUs,
  exec: flow,
  tags: { flow },
});

export const options = {
  scenarios: {
    getMyOrder: arrival('getMyOrder', 17, 400),
    listMyOrders: arrival('listMyOrders', 2.1, 100),
    getQueueBoard: arrival('getQueueBoard', 40, 400),
    listMyAvailableSlots: arrival('listMyAvailableSlots', 0.35, 50),
    createMyBooking: arrival('createMyBooking', 0.07, 50),
  },
  thresholds: {
    'http_req_duration{flow:getMyOrder,status:200}': ['p(95)<=40'],
    'http_req_duration{flow:getMyOrder,status:304}': ['p(95)<=10'],
    'http_req_duration{flow:listMyOrders}': ['p(95)<=80'],
    'http_req_duration{flow:getQueueBoard,status:200}': ['p(95)<=20'],
    'http_req_duration{flow:getQueueBoard,status:304}': ['p(95)<=5'],
    'http_req_duration{flow:listMyAvailableSlots}': ['p(95)<=100'],
    'http_req_duration{flow:createMyBooking}': ['p(95)<=150'],
  },
};

// 304 is the expected steady state of conditional GETs; 409 = slot already taken (booking probe reuses slots).
http.setResponseCallback(http.expectedStatuses(200, 201, 304, 409));

export function setup() {
  const env = __ENV.TARGET_ENV;
  if (env !== 'staging' && env !== 'staging-lean') {
    throw new Error('refused: TARGET_ENV must be staging or staging-lean (LD-45), got ' + JSON.stringify(env));
  }
  for (const k of ['TARGET_URL', 'PATIENT_TOKEN', 'DISPLAY_TOKEN', 'ORDER_ID', 'PROFILE_ID', 'CENTRE_ID', 'ORDERABLE_ID']) {
    if (!__ENV[k]) throw new Error('refused: ' + k + ' is required');
  }
}

const base = () => String(__ENV.TARGET_URL).replace(/\/+$/, '') + PREFIX;
const patient = () => ({ Authorization: 'Bearer ' + __ENV.PATIENT_TOKEN });
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// Per-VU ETag memory: first poll is unconditional, later polls send If-None-Match (TRD §3 polling contract), so >= 90 % become 304.
const etags = {};
function conditionalGet(flow, path, headers) {
  const h = Object.assign({}, headers);
  if (etags[flow]) h['If-None-Match'] = etags[flow];
  const r = http.get(base() + path, { headers: h, tags: { flow } });
  if (r.status === 200 && r.headers.Etag) etags[flow] = r.headers.Etag;
  return r;
}

export function getMyOrder() {
  conditionalGet('getMyOrder', '/me/orders/' + __ENV.ORDER_ID, patient());
}

export function listMyOrders() {
  http.get(base() + '/me/orders?limit=50', { headers: patient(), tags: { flow: 'listMyOrders' } });
}

export function getQueueBoard() {
  conditionalGet('getQueueBoard', '/queue-board', { 'X-Lims-Display-Token': __ENV.DISPLAY_TOKEN });
}

export function listMyAvailableSlots() {
  const q = 'booking_kind=centre_visit&centre_id=' + __ENV.CENTRE_ID + '&date_from=' + day(1) + '&date_to=' + day(7);
  http.get(base() + '/me/slots?' + q, { headers: patient(), tags: { flow: 'listMyAvailableSlots' } });
}

export function createMyBooking() {
  const body = JSON.stringify({
    profile_id: __ENV.PROFILE_ID,
    booking_kind: 'centre_visit',
    centre_id: __ENV.CENTRE_ID,
    slot_start: day(1 + (__ITER % 6)) + 'T0' + (4 + (__VU % 5)) + ':00:00Z',
    orderable_ids: [__ENV.ORDERABLE_ID],
  });
  const headers = Object.assign({ 'Content-Type': 'application/json', 'Idempotency-Key': 'perf-' + __VU + '-' + __ITER + '-' + Date.now() }, patient());
  http.post(base() + '/me/bookings', body, { headers, tags: { flow: 'createMyBooking' } });
}
