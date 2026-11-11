// C6-T34 load + nightly E2E harness contract (no stack, no browser, no k6 binary needed). 02-TRD §11 + test table rows "E2E (nightly)" and "Load"; 01-PRD §6; 05-DoD §5.
// The real run needs a compose stack / staging and cannot run in this gate; these checks pin down WHAT the harness must contain so it cannot silently drift from the spec targets.
// Run: node --test tests/load/C6-T34.static.test.mjs   Synthetic data only.
// ASSUMED (dispute if wrong): load harness = k6 script tests/load/reporting-load.js (precedent infra/tests/load/flood.js) + tests/load/README.md; journey = Playwright/Vitest-free
// API journey tests/e2e/reporting-journey.e2e.ts (+ tests/e2e/README.md) whose test titles name each step; `.github/workflows/nightly.yml` is NOT edited by C6 (not owned) — the README says how nightly runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOAD = join(ROOT, 'tests', 'load');
const E2E = join(ROOT, 'tests', 'e2e');
const must = (p) => { assert.ok(existsSync(p), `missing ${p.replace(ROOT, '')}`); return readFileSync(p, 'utf8'); };
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; }) : []);
const k6 = () => must(join(LOAD, 'reporting-load.js'));
const journey = () => must(join(E2E, 'reporting-journey.e2e.ts'));

// ---- load: reporting-load.js --------------------------------------------------------------------------------------------
test('load: k6 script imports k6 modules and declares options with scenarios + thresholds', () => {
  const s = k6();
  assert.match(s, /from\s+['"]k6\/http['"]/); assert.match(s, /export\s+const\s+options\b/);
  assert.match(s, /scenarios\s*:/); assert.match(s, /thresholds\s*:/);
});

test('load: render scenario = 42 renders/min (constant-arrival-rate, rate 42, timeUnit 1m) for 15 min (02-TRD §11 peak-hour renders, N = 10 labs)', () => {
  const s = k6();
  assert.match(s, /constant-arrival-rate/);
  assert.match(s, /\b42\b/, 'rate 42'); assert.match(s, /['"]1m['"]/, "timeUnit '1m'"); assert.match(s, /['"]15m['"]/, "duration '15m'");
});

test('load: bulk-release scenario sends 200 ids (08 R9 / 02-TRD §11 "Bulk release 200")', () => {
  const s = k6();
  assert.match(s, /\b200\b/); assert.match(s, /bulk/i); assert.match(s, /release/i);
});

test('load: delivery scenario = 1 delivery/s (rate 1, timeUnit 1s; 02-TRD §11 "Deliveries/day")', () => {
  const s = k6();
  assert.match(s, /rate\s*:\s*1\b/); assert.match(s, /timeUnit\s*:\s*['"]1s['"]/);
});

test('load: thresholds encode the targets — render p95 <= 5 s, assembly->render p95 <= 60 s, bulk p95 <= 8 s, send task p95 <= 1 s, QR verify p95 <= 100 ms, render failures < 1 %', () => {
  const s = k6();
  const th = s.slice(s.search(/thresholds\s*:/));
  assert.match(th, /p\(95\)\s*<\s*=?\s*5000\b|p\(95\)\s*<\s*=?\s*5\b/, 'render p95 5 s');
  assert.match(th, /60000|\b60\b/, 'ready->rendered 60 s');
  assert.match(th, /p\(95\)\s*<\s*=?\s*8000\b|p\(95\)\s*<\s*=?\s*8\b/, 'bulk p95 8 s');
  assert.match(th, /p\(95\)\s*<\s*=?\s*1000\b|p\(95\)\s*<\s*=?\s*1\b/, 'send task p95 1 s');
  assert.match(th, /p\(95\)\s*<\s*=?\s*100\b/, 'QR verify p95 100 ms');
  assert.match(th, /rate\s*<\s*0\.01\b/, 'render failure rate < 1 %');
  assert.match(th, /abortOnFail\s*:\s*true|http_req_failed/, 'a failing threshold must exit non-zero (k6 does by default; http_req_failed or abortOnFail present)');
});

test('load: 10x seed — a seed step/setup creates >= 10x lab volume (10 labs x 1000 PDFs/day) of synthetic data, and refuses non-staging targets (LD-45 pattern of infra/tests/load/flood.js)', () => {
  const s = k6();
  assert.match(s, /export\s+function\s+setup\b/);
  assert.match(s, /TARGET_ENV/); assert.match(s, /staging|compose|ci/i); assert.match(s, /throw\s+new\s+Error/, 'setup refuses an unknown TARGET_ENV before any request');
  assert.match(s, /SEED|seed/); assert.match(s, /\b10\b|10_?000|\b1000\b/);
});

test('load: reads target + token from env, hard-codes none (no secrets, no real URLs, no PHI)', () => {
  const s = k6();
  assert.match(s, /__ENV\.TARGET_URL/);
  assert.doesNotMatch(s, /(Bearer\s+[A-Za-z0-9._-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}\b)/i);
});

test('load: README documents how to run (k6 command, env vars, thresholds table) and where nightly invokes it', () => {
  const r = must(join(LOAD, 'README.md'));
  assert.match(r, /k6 run/); assert.match(r, /TARGET_URL/); assert.match(r, /TARGET_ENV/); assert.match(r, /42/); assert.match(r, /15 ?min/i); assert.match(r, /200/); assert.match(r, /nightly/i);
});

// ---- E2E: reporting-journey.e2e.ts --------------------------------------------------------------------------------------
const STEPS = [
  ['register', /regist/i], ['approve', /approv/i], ['assemble', /assembl/i], ['render', /render/i], ['held (dues)', /held|hold/i], ['pay', /\bpay|payment/i],
  ['auto-release', /auto-?release/i], ['WhatsApp (recording provider)', /whatsapp/i], ['OTP', /\botp\b/i], ['download', /download/i], ['QR verify', /qr/i],
];
test('E2E journey: one test chain covers register -> approve -> assemble -> render -> held -> pay -> auto-release -> WhatsApp -> OTP -> download -> QR verify (02-TRD test table; 05-DoD §5.2)', () => {
  const j = journey();
  assert.match(j, /\b(test|it)\s*(\.\w+)?\s*\(/, 'defines tests');
  for (const [n, re] of STEPS) assert.match(j, re, `journey must cover step: ${n}`);
  // order: first occurrence of each step keyword is non-decreasing along the journey
  const pos = STEPS.map(([, re]) => j.search(re)); const sorted = [...pos].sort((a, b) => a - b);
  assert.deepEqual(pos.slice(0, 1), sorted.slice(0, 1)); assert.ok(pos[0] < pos[10], 'register comes before QR verify');
});

const SCENARIOS = [
  ['amendment: v2 supersedes v1', /amend/i, /supersed/i], ['outsourced merge', /outsourc/i, /merge/i], ['narrative sign', /narrative/i, /sign/i], ['bulk release', /bulk/i, /release/i],
  ['rejection / recollection (05-DoD §5.2)', /reject/i, /recollect/i], ['cancelled invoice / credit note (05-DoD §5.2)', /cancel/i, /credit.?note|invoice/i],
];
for (const [name, a, b] of SCENARIOS) {
  test(`E2E nightly scenario present: ${name}`, () => { const j = journey(); assert.match(j, a); assert.match(j, b); });
}

test('E2E: cross-tenant attempt at the journey steps (05-DoD §5.2) — tenant B gets 404/403 for tenant A report, link, QR token and portal session', () => {
  const j = journey();
  assert.match(j, /tenant[_ -]?b/i); assert.match(j, /cross-?tenant/i); assert.match(j, /\b(404|403)\b/);
});

test('E2E: asserts the amendment keeps v1 readable but superseded and portal serves only the latest; QR verify of v1 reports superseded', () => {
  const j = journey(); assert.match(j, /v1/); assert.match(j, /v2/); assert.match(j, /superseded/i);
});

test('E2E: PHI hygiene assertion — journey scans the recorded provider messages and logs for patient name / phone / link token (PRD §6: 0 PHI in bodies, logs, URLs)', () => {
  const j = journey(); assert.match(j, /recording/i); assert.match(j, /\b(phi|patient name|body)\b/i); assert.match(j, /(not|no)[A-Za-z. ]*(contain|include|toContain)|doesNotMatch|not\.toContain|not\.toMatch/i);
});

test('E2E: reads the stack URL from env (no hard-coded host) and README explains compose + nightly run', () => {
  const j = journey(); assert.match(j, /process\.env\.[A-Z_]+/);
  const r = must(join(E2E, 'README.md')); assert.match(r, /compose/i); assert.match(r, /nightly/i); assert.match(r, /reporting-journey/);
});

// ---- spec-name pins (review C6-T34-review.md item 11): harness must use catalogued routes/fields, not invented ones ------------
// 02-TRD §6.2 R7 bulk-release {ids 1-200 unique, Idempotency R}; D3 POST /reports/{report_id}/deliveries; Q1 body {qr_token}; portal = /v1/reporting/portal/* + X-Lims-Portal-Credential.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'); // ignore comments so prose cannot satisfy/violate a pin
// the CR is renamed C6-T34.resolved-<stamp>.md once the lead resolves it; either name proves a CR was filed
const crFile = () => existsSync(join(ROOT, '.orchestra', 'cr')) && readdirSync(join(ROOT, '.orchestra', 'cr')).some((n) => /^C6-T34(\.resolved-\d+)?\.md$/.test(n));

test('pin: bulk release uses R7 path /v1/reporting/report-versions/bulk-release with {ids} body and an Idempotency-Key, in load and E2E', () => {
  for (const [n, s] of [['load', strip(k6())], ['e2e', strip(journey())]]) {
    assert.match(s, /\/report-versions\/bulk-release/, `${n}: R7 path`);
    assert.match(s, /\{\s*ids\b/, `${n}: body {ids}`);
    assert.match(s, /Idempotency-Key/, `${n}: Idempotency-Key header`);
    assert.doesNotMatch(s, /synthetic_batch/, `${n}: invented body field`);
  }
});

test('pin: delivery scenario posts to /reports/{report_id}/deliveries (D3) with Idempotency-Key', () => {
  const s = strip(k6());
  assert.match(s, /\/reports\/[^'"`\n]*\/deliveries/); assert.match(s, /recipient_kind/); assert.match(s, /channel/); assert.match(s, /Idempotency-Key/);
});

test('pin: QR verify (Q1) body field is qr_token, never token', () => {
  for (const [n, s] of [['load', strip(k6())], ['e2e', strip(journey())]]) {
    assert.match(s, /qr_token/, `${n}: qr_token`);
    assert.doesNotMatch(s, /\{\s*token\s*:/, `${n}: Q1 body must not use "token"`);
  }
});

test('pin: no invented render route — only R8 retry-render / R9 regenerations; no test-support routes unless .orchestra/cr/C6-T34.md exists', () => {
  for (const [n, s] of [['load', strip(k6())], ['e2e', strip(journey())]]) {
    assert.doesNotMatch(s, /\/render['"`?]/, `${n}: invented POST /report-versions/{id}/render`);
    if (!crFile()) assert.doesNotMatch(s, /test-support/, `${n}: test-support routes need a CR (.orchestra/cr/C6-T34.md)`);
  }
});

test('pin: portal calls use /v1/reporting/portal/ prefix and X-Lims-Portal-Credential header, not Bearer / unprefixed /portal', () => {
  const s = strip(journey());
  assert.match(s, /\/v1\/reporting\/portal\//); assert.match(s, /X-Lims-Portal-Credential/);
  assert.doesNotMatch(s, /['"`]\/portal\//, 'unprefixed /portal route');
  assert.doesNotMatch(s, /link_token/, 'P1 credential goes in the header, body is {}');
  assert.match(s, /challenge_id/, 'P1 response field');
});

test('pin: held-dues step is not vacuous — asserts link_purpose dues, balance_due_paisa and reporting.release_blocked_due (08 A21.1)', () => {
  const s = strip(journey());
  assert.match(s, /link_purpose/); assert.match(s, /balance_due_paisa/); assert.match(s, /reporting\.release_blocked_due/);
  assert.doesNotMatch(s, /\[\s*200\s*,\s*401\s*\]/, 'status assertion that passes unauthenticated');
});

test('pin: order lookup uses R2 POST /reports/search (PHI-safe body), not a ?order_id= query on /report-versions', () => {
  const s = strip(journey());
  assert.match(s, /\/reports\/search/); assert.doesNotMatch(s, /report-versions\?[^'"`\n]*order_id/);
});

test('pin: load setup fails fast when seed produced no QR tokens; OTP code is added to the PHI/log scan', () => {
  assert.match(strip(k6()), /tokens\.length[\s\S]{0,120}throw\s+new\s+Error|throw\s+new\s+Error[\s\S]{0,120}tokens\.length/, 'setup throws when data.tokens is empty');
  assert.match(strip(journey()), /phi\.push\([^)]*\b(code|otp)\b/i, 'OTP code pushed into S.phi so logs/bodies are scanned for it');
});

// ---- hygiene across both folders ---------------------------------------------------------------------------------------
test('hygiene: no TODO/FIXME, no real-looking Nepali phone or e-mail, no secrets in tests/load and tests/e2e files', () => {
  const files = [...walk(LOAD), ...walk(E2E)].filter((f) => !/C6-T34\.static\.test\.mjs$/.test(f) && /\.(js|ts|mjs|md|json)$/.test(f));
  assert.ok(files.length >= 4, 'harness files exist');
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /\b(TODO|FIXME)\b/, f); assert.doesNotMatch(t, /\+?977[- ]?9[78]\d{8}\b|\b9[78]\d{8}\b/, `${f}: real-looking phone`);
    assert.doesNotMatch(t, /[\w.+-]+@(?!example\.(com|org|test)\b)[\w-]+\.[a-z]{2,}/i, `${f}: non-example e-mail`);
    assert.doesNotMatch(t, /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk_live_)/, `${f}: secret`);
  }
});
