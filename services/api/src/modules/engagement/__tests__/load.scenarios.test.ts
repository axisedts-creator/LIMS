// T-PERF1 (C16) — load-test scenario files per 02-TRD §12, at 1x (one lab) and 10x (N = 10 labs). Tester contract.
// LD-140 does not apply (backend only). Mirrors the C1 T-32 pattern (infra/tests/load/flood.js): k6 script, thresholds = exit code.
//
// Files the implementer must create under `__tests__/load/` (this test reads them; it never writes them):
//   engagement.k6.js        k6 script. One scenario per flow, scenario name == flow name, executor constant-arrival-rate:
//                             getMyOrder GET /me/orders/{ORDER_ID}                 17 req/s at 10x (TRD §12 row 1)
//                             listMyOrders GET /me/orders?limit=50                 2.1 req/s
//                             getQueueBoard GET /queue-board                       40 req/s (display token)
//                             listMyAvailableSlots GET /me/slots?booking_kind=centre_visit&centre_id&date_from&date_to
//                             createMyBooking POST /me/bookings (Idempotency-Key)  0.07 req/s
//                           all under prefix /v1/engagement; rates are /10 at SCALE=1.
//                           getMyOrder and getQueueBoard send If-None-Match with the last ETag (>= 90 % become 304).
//                           Thresholds (http_req_duration, tags flow + status, p95, ms): getMyOrder 200:40 304:10;
//                           listMyOrders 80; getQueueBoard 200:20 304:5; listMyAvailableSlots 100; createMyBooking 150.
//                           Env: TARGET_URL TARGET_ENV SCALE(1|10, default 1; anything else throws at init) DURATION(default 5m)
//                           PATIENT_TOKEN DISPLAY_TOKEN ORDER_ID PROFILE_ID CENTRE_ID ORDERABLE_ID.
//                           TARGET_ENV must be staging | staging-lean (LD-45 pattern): refused in setup() before any request.
//                           Tokens go in headers only, never in URLs. `k6 inspect` must work with no env except SCALE.
//   consumer.pgbench.sql    pgbench custom script: the specimen-status consumer upsert (2.5/s at 10x, p95 <= 30 ms), against
//                           engagement.patient_order_specimens guarded by status_seq (TRD §12 row 6, §7 consumer algorithm).
//   seed.mjs                exports generateSeed({scale, rngSeed}) -> {scale, counts, tenants, probe}; deterministic, synthetic only.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'load');
const K6_FILE = join(DIR, 'engagement.k6.js');
const PGB_FILE = join(DIR, 'consumer.pgbench.sql');
const SEED_FILE = join(DIR, 'seed.mjs');
const k6Available = spawnSync('k6', ['version']).status === 0;
const it6 = it.skipIf(!k6Available); // k6 is a developer/CI tool; skipped (and reported) when absent, like T-32.

const UUID = '00000000-0000-4000-8000-0000000000aa';
const BASE_ENV = {
  TARGET_ENV: 'staging', PATIENT_TOKEN: 'synthetic-patient-token', DISPLAY_TOKEN: 'synthetic-display-token',
  ORDER_ID: UUID, PROFILE_ID: UUID, CENTRE_ID: UUID, ORDERABLE_ID: UUID,
};

function toSec(v: unknown): number {
  if (typeof v === 'number') return v / 1e9; // k6 inspect emits Go durations: nanoseconds when numeric
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let t = 0;
  let any = false;
  for (const [, n, u] of String(v).matchAll(re)) { any = true; t += Number(n) * { ms: 0.001, s: 1, m: 60, h: 3600 }[u as 'ms']; }
  if (!any) throw new Error(`unparseable duration ${String(v)}`);
  return t;
}
function k6(args: string[], env: Record<string, string>) {
  const r = spawnSync('k6', args, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
// Async variant for `k6 run`: spawnSync would block the event loop and the in-process mock could never answer (T-PERF1 ruling, defect B).
function k6Run(args: string[], env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('k6', args, { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => p.kill(), 120000);
    p.on('close', (status) => { clearTimeout(t); resolve({ status, out }); });
  });
}
function inspect(scale: string) {
  // `k6 inspect` does not expose system env to __ENV; pass SCALE with -e (T-PERF1 ruling, defect A).
  const r = k6(['inspect', '-e', `SCALE=${scale}`, K6_FILE], {});
  expect(r.status, r.out).toBe(0);
  const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
  return j as { scenarios: Record<string, { rate: number; timeUnit?: unknown; executor: string }>; thresholds: Record<string, string[]> };
}
const rps = (s: { rate: number; timeUnit?: unknown }) => s.rate / toSec(s.timeUnit ?? '1s');

// threshold lookup: any metric key containing http_req_duration, the flow tag and (optionally) the status tag
function p95(th: Record<string, string[]>, flow: string, status?: string): number | undefined {
  for (const [k, exprs] of Object.entries(th)) {
    if (!k.startsWith('http_req_duration{') || !k.includes(`flow:${flow}`)) continue;
    if (status ? !k.includes(`status:${status}`) : /status:/.test(k)) continue;
    const m = exprs.map((e) => /^p\(95\)\s*<=?\s*(\d+(?:\.\d+)?)$/.exec(e.replace(/\s+/g, ' ').trim())).find(Boolean);
    if (m) return Number(m[1]);
  }
  return undefined;
}

describe('T-PERF1 files exist', () => {
  it('k6 scenario, pgbench script and seed generator are present under __tests__/load', () => {
    expect([K6_FILE, PGB_FILE, SEED_FILE].filter((f) => !existsSync(f))).toEqual([]);
  });
});

describe('engagement.k6.js — static', () => {
  const src = () => readFileSync(K6_FILE, 'utf8');
  it('cites LD-45-style env guard and keeps secrets/real data out of the file', () => {
    const s = src();
    expect(s).toMatch(/staging-lean/);
    expect(s).not.toMatch(/Bearer [A-Za-z0-9_-]{16,}/); // no literal token
    expect(s).not.toMatch(/\b(?:\+?977)?9[78]\d{8}\b/); // no literal phone number
  });
  it('targets only /v1/engagement operations of TRD §5 and sends Idempotency-Key on the booking POST', () => {
    const s = src();
    for (const p of ['/me/orders', '/queue-board', '/me/slots', '/me/bookings']) expect(s).toContain(p);
    expect(s).toContain('/v1/engagement');
    expect(s).toMatch(/Idempotency-Key/i);
    expect(s).toMatch(/If-None-Match/i);
  });
});

describe.skipIf(!existsSync(K6_FILE))('engagement.k6.js — options via k6 inspect', () => {
  it6('SCALE=10 arrival rates equal TRD §12 req/s (±10 %)', () => {
    const sc = inspect('10').scenarios;
    const want: Record<string, number> = { getMyOrder: 17, listMyOrders: 2.1, getQueueBoard: 40, createMyBooking: 0.07 };
    for (const [name, r] of Object.entries(want)) {
      expect(sc[name], `scenario ${name}`).toBeDefined();
      expect(sc[name].executor).toBe('constant-arrival-rate');
      expect(rps(sc[name])).toBeGreaterThan(r * 0.9);
      expect(rps(sc[name])).toBeLessThan(r * 1.1);
    }
    expect(sc.listMyAvailableSlots, 'scenario listMyAvailableSlots').toBeDefined();
    expect(rps(sc.listMyAvailableSlots)).toBeGreaterThanOrEqual(rps(sc.createMyBooking));
  });
  it6('SCALE=1 is exactly one tenth of SCALE=10 for every scenario', () => {
    const one = inspect('1').scenarios;
    const ten = inspect('10').scenarios;
    for (const name of ['getMyOrder', 'listMyOrders', 'getQueueBoard', 'listMyAvailableSlots', 'createMyBooking']) {
      expect(one[name], name).toBeDefined();
      expect(rps(one[name]) * 10).toBeCloseTo(rps(ten[name]), 2);
    }
  });
  it6('thresholds carry the TRD §12 p95 budgets (ms), split 200 vs 304 where the TRD does', () => {
    const th = inspect('10').thresholds;
    expect(p95(th, 'getMyOrder', '200')).toBe(40);
    expect(p95(th, 'getMyOrder', '304')).toBe(10);
    expect(p95(th, 'getQueueBoard', '200')).toBe(20);
    expect(p95(th, 'getQueueBoard', '304')).toBe(5);
    expect(p95(th, 'listMyOrders')).toBe(80);
    expect(p95(th, 'listMyAvailableSlots')).toBe(100);
    expect(p95(th, 'createMyBooking')).toBe(150);
  });
  it6('rejects a SCALE other than 1 or 10 at init', () => {
    expect(k6(['inspect', '-e', 'SCALE=3', K6_FILE], {}).status).not.toBe(0);
  });
});

// ---- real k6 runs against a local mock API (tiny duration, SCALE=10 so every flow fires) ----
type Hit = { method: string; url: string; headers: IncomingMessage['headers']; status: number };
let srv: Server | undefined;
afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));

async function mock(delayMs: number) {
  const hits: Hit[] = [];
  srv = createServer((req, res) => {
    const url = req.url ?? '';
    const path = url.split('?')[0];
    const etagged = path.endsWith(`/me/orders/${UUID}`) || path.endsWith('/queue-board');
    const send = () => {
      let status = 200;
      const h: Record<string, string> = { 'content-type': 'application/json' };
      if (etagged) { h.etag = '"v1"'; if (req.headers['if-none-match'] === '"v1"') status = 304; }
      if (req.method === 'POST') status = 201;
      hits.push({ method: req.method ?? '', url, headers: req.headers, status });
      res.writeHead(status, h);
      res.end(status === 304 ? undefined : JSON.stringify({ data: [] }));
    };
    req.resume();
    req.on('end', () => (delayMs === 0 ? send() : setTimeout(send, delayMs)));
  });
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
  return { hits, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}
const RUN = { SCALE: '10', DURATION: '6s', ...BASE_ENV };

describe.skipIf(!existsSync(K6_FILE))('engagement.k6.js — k6 run vs mock', () => {
  it6('fast mock: exits 0; every flow hit on its /v1/engagement path; conditional GETs get 304s', async () => {
    const m = await mock(0);
    const r = await k6Run(['run', '--quiet', K6_FILE], { ...RUN, TARGET_URL: m.url });
    // T-PERF1 ruling: win32 timer tick (~15.6 ms) makes the 5/10 ms 304 budgets unreachable vs a localhost mock;
    // exit 99 = thresholds crossed but the script ran to the end. Real p95 evidence comes from a Linux/staging run.
    if (process.platform === 'win32') expect([0, 99], r.out).toContain(r.status);
    else expect(r.status, r.out).toBe(0);
    const at = (method: string, re: RegExp) => m.hits.filter((h) => h.method === method && re.test(h.url));
    expect(at('GET', new RegExp(`^/v1/engagement/me/orders/${UUID}`)).length).toBeGreaterThan(0);
    expect(at('GET', /^\/v1\/engagement\/me\/orders(\?|$)/).length).toBeGreaterThan(0);
    expect(at('GET', /^\/v1\/engagement\/queue-board/).length).toBeGreaterThan(0);
    expect(at('GET', /^\/v1\/engagement\/me\/slots\?/).length).toBeGreaterThan(0);
    expect(at('POST', /^\/v1\/engagement\/me\/bookings/).length).toBeGreaterThan(0);
    for (const re of [new RegExp(`/me/orders/${UUID}`), /\/queue-board/]) {
      const hs = m.hits.filter((h) => re.test(h.url));
      expect(hs.filter((h) => h.status === 304).length / hs.length).toBeGreaterThan(0.5);
    }
    for (const h of at('POST', /bookings/)) expect(h.headers['idempotency-key']).toBeTruthy();
  });
  it6('slow mock (300 ms): p95 budgets are breached so k6 exits non-zero', async () => {
    const m = await mock(300);
    expect((await k6Run(['run', '--quiet', K6_FILE], { ...RUN, TARGET_URL: m.url })).status).not.toBe(0);
  });
  it6('tokens travel in headers only, never in the URL', async () => {
    const m = await mock(0);
    await k6Run(['run', '--quiet', K6_FILE], { ...RUN, TARGET_URL: m.url });
    expect(m.hits.length).toBeGreaterThan(0);
    for (const h of m.hits) expect(h.url).not.toMatch(/synthetic-(patient|display)-token/);
    const sent = m.hits.map((h) => JSON.stringify(h.headers)).join('');
    expect(sent).toContain('synthetic-patient-token');
    expect(sent).toContain('synthetic-display-token');
  });
  it6.each([['production'], ['prod'], ['']])('TARGET_ENV=%j is refused before any request', async (env) => {
    const m = await mock(1);
    const r = await k6Run(['run', '--quiet', K6_FILE], { ...RUN, TARGET_URL: m.url, TARGET_ENV: env });
    expect(r.status).not.toBe(0);
    expect(m.hits).toHaveLength(0);
  });
  it6('missing TARGET_URL fails fast, no request', async () => {
    const m = await mock(1);
    expect((await k6Run(['run', '--quiet', K6_FILE], { ...RUN, TARGET_URL: '' })).status).not.toBe(0);
    expect(m.hits).toHaveLength(0);
  });
});

describe('consumer.pgbench.sql', () => {
  const sql = () => readFileSync(PGB_FILE, 'utf8');
  it('upserts engagement.patient_order_specimens with a status_seq guard and randomised keys', () => {
    const s = sql();
    expect(s).toMatch(/^\\set\s+\w+\s+random\(/m);
    expect(s).toMatch(/INSERT INTO engagement\.patient_order_specimens/i);
    expect(s).toMatch(/ON CONFLICT[\s\S]*DO UPDATE[\s\S]*status_seq/i);
    expect(s).toMatch(/WHERE[\s\S]*status_seq\s*</i); // stale event (lower seq) must not overwrite
  });
  it('is synthetic and cites the 30 ms consumer budget', () => {
    const s = sql();
    expect(s).toMatch(/30\s*ms/);
    expect(s).toMatch(/2\.5\s*\/\s*s|2\.5 per second|2\.5 tps/i);
    expect(s).not.toMatch(/\b9[78]\d{8}\b/); // no phone-number-like literals
  });
});

describe('seed generator (seed.mjs)', () => {
  type Seed = { scale: number; counts: Record<string, number>; tenants: { id: string; name: string }[]; probe: Record<string, string> };
  const load = async () => (await import(pathToFileURL(SEED_FILE).href)) as { generateSeed: (o: { scale: number; rngSeed: number }) => Seed };
  const COUNT_KEYS = ['labs', 'centres', 'displays', 'patients', 'linked_patients', 'orders', 'specimens'];

  it('10x is exactly ten times 1x for every count; sizes follow TRD §12 inputs', async () => {
    const { generateSeed } = await load();
    const a = generateSeed({ scale: 1, rngSeed: 7 });
    const b = generateSeed({ scale: 10, rngSeed: 7 });
    for (const k of COUNT_KEYS) expect(b.counts[k], k).toBe(a.counts[k] * 10);
    expect(a.counts.labs).toBe(1);
    expect(a.counts.centres).toBe(20); // 20 centres per lab (04 §14)
    expect(a.counts.displays).toBe(20); // 1 display per centre
    expect(a.counts.patients).toBeGreaterThanOrEqual(500); // 500 patients/day/lab
    expect(a.counts.linked_patients).toBeGreaterThanOrEqual(Math.floor(a.counts.patients * 0.4)); // 40 % use the app
    expect(a.counts.specimens).toBe(a.counts.orders * 3); // 3 specimens per order (C0-TRD §10.1)
  });
  it('is deterministic per rngSeed and differs across seeds', async () => {
    const { generateSeed } = await load();
    expect(generateSeed({ scale: 1, rngSeed: 1 })).toEqual(generateSeed({ scale: 1, rngSeed: 1 }));
    expect(generateSeed({ scale: 1, rngSeed: 1 }).probe).not.toEqual(generateSeed({ scale: 1, rngSeed: 2 }).probe);
  });
  it('is synthetic: tenant names marked Synthetic, probe ids are uuids', async () => {
    const { generateSeed } = await load();
    const s = generateSeed({ scale: 10, rngSeed: 3 });
    expect(s.tenants).toHaveLength(10);
    for (const t of s.tenants) expect(t.name).toMatch(/^Synthetic /);
    for (const k of ['order_id', 'profile_id', 'centre_id', 'orderable_id']) {
      expect(s.probe[k], k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
  it.each([[0], [3], [-1], [1.5], [Number.NaN]])('rejects scale %s (only 1 or 10)', async (scale) => {
    const { generateSeed } = await load();
    expect(() => generateSeed({ scale, rngSeed: 1 })).toThrow();
  });
});
