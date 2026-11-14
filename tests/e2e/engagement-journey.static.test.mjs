// C16 T-E2E1 static checks (no stack needed): the nightly workflow runs the C16 journey and the journey keeps its contract.
// Run: node --test tests/e2e/engagement-journey.static.test.mjs   Synthetic data only.
// Spec: 06-PLAN row T-E2E1 ("runs in nightly.yml"), 02-TRD §14 E2E (nightly), 02-TRD §5 routes, §7 events, 07-SECURITY (cross-account 404, PHI-free logs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WF = join(ROOT, '.github', 'workflows', 'nightly.yml');
const JOURNEY = join(ROOT, 'tests', 'e2e', 'engagement-journey.e2e.ts');
const wf = () => readFileSync(WF, 'utf8');
const journey = () => readFileSync(JOURNEY, 'utf8');
const JOURNEY_PATH = 'tests/e2e/engagement-journey.e2e.ts';

/** Split the nightly job's steps into {name, text} blocks (line based; the file is small and flat). */
function steps(text) {
  const out = []; let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^      - (?:name: (.+)|uses: .+)$/.exec(line);
    if (m) { cur = { name: m[1] ?? '', text: line + '\n' }; out.push(cur); continue; }
    if (cur && /^\s{8}\S|^\s{10}/.test(line)) cur.text += line + '\n';
    else if (cur && /^  \S|^\S/.test(line)) cur = null;
  }
  return out;
}
const c16Step = () => steps(wf()).find((s) => s.text.includes(JOURNEY_PATH));

test('nightly.yml exists and keeps its Gate-16 shape: schedule + manual only, read-only token, existing steps intact', () => {
  const t = wf();
  assert.match(t, /^on:\s*\n\s+schedule:/m);
  assert.match(t, /workflow_dispatch:/);
  assert.doesNotMatch(t, /pull_request|pull_request_target|push:/, 'nightly must never run PR code');
  assert.match(t, /^permissions:\s*\n\s+contents: read/m);
  for (const keep of ['pnpm dev:up --ci', 'pnpm db:migrate', 'pnpm db:seed --scale 1', 'pnpm turbo run test:smoke', 'pnpm turbo run test:e2e', 'pnpm turbo run test:isolation', 'pnpm turbo run test:load-smoke']) {
    assert.ok(t.includes(keep), `existing step "${keep}" must stay`);
  }
  assert.match(t, /report:\s*\n\s+needs: nightly\s*\n\s+if: failure\(\)/, 'failure issue job must still depend on the nightly job');
});

test('nightly job has a C16 E2E step that runs the journey file with vitest (T-E2E1 done_when: runs in nightly.yml)', () => {
  const s = c16Step();
  assert.ok(s, `no step in nightly.yml mentions ${JOURNEY_PATH}`);
  assert.match(s.text, /vitest run[^\n]*tests\/e2e\/engagement-journey\.e2e\.ts/, 'step must `vitest run` the journey file');
  assert.match(s.name, /C16|engagement|patient/i, 'step name must say it is the C16 / engagement / patient E2E');
});

test('C16 step comes after the stack, migrations and 1x seed, and is inside the job that opens the nightly issue on failure', () => {
  const all = steps(wf());
  const idx = (needle) => all.findIndex((s) => s.text.includes(needle));
  const at = all.findIndex((s) => s.text.includes(JOURNEY_PATH));
  for (const need of ['pnpm dev:up --ci', 'pnpm db:migrate', 'pnpm db:seed --scale 1']) assert.ok(idx(need) >= 0 && idx(need) < at, `"${need}" must run before the C16 journey`);
  const t = wf();
  assert.ok(t.indexOf(JOURNEY_PATH) < t.indexOf('\n  report:'), 'the C16 step must be in the nightly job, above the report job');
});

test('C16 step gives the journey its env (base URL, tenant code, staff token) and does not hide failures', () => {
  const s = c16Step();
  assert.ok(s, 'C16 step missing');
  for (const v of ['E2E_BASE_URL', 'E2E_TENANT_CODE', 'E2E_STAFF_TOKEN_A']) assert.match(s.text, new RegExp(`${v}\\s*[:=]`), `${v} must be set for the journey`);
  assert.doesNotMatch(s.text, /continue-on-error:\s*true/, 'a failing C16 journey must fail the nightly');
  assert.doesNotMatch(s.text, /\|\|\s*(true|:)\b/, 'no `|| true` swallowing the exit code');
  assert.doesNotMatch(s.text, /E2E_STAFF_TOKEN_A\s*[:=]\s*['"]?(eyJ|[A-Za-z0-9_-]{24,})/, 'no literal token in the workflow; use secrets.* or a value minted in the job');
  assert.doesNotMatch(s.text, /(?:^|\s)(?:sh|bash)\s+-c\s+["']?curl[^\n]*Authorization/i, 'no inline bearer in a curl');
});

test('the journey runs through the package vitest from the repo root without the services/api setup (it is an HTTP client of the stack)', () => {
  assert.ok(existsSync(JOURNEY), `${JOURNEY_PATH} missing`);
  assert.doesNotMatch(c16Step()?.text ?? '', /--dir services\/api/, 'the journey is a root-level HTTP test, not a services/api module test');
});

test('journey 1 covers issue code -> redeem -> C5/C6 fake events -> release -> download (names verbatim from 02-TRD)', () => {
  const j = journey();
  for (const frag of [
    '/link-codes', 'bind_phone', '/auth/otp-challenges', '/auth/otp-challenges/verify', '/me/profiles/redeem-code',
    'lab.specimen.status_changed.v1', 'reporting.report.released.v1', "audiences: ['patient']",
    '/me/orders/', '/me/reports', '/versions/1/file', 'application/pdf', 'content-disposition', '%PDF', 'sha256', 'report_ready',
  ]) assert.ok(j.includes(frag), `journey 1 must contain ${frag}`);
  assert.match(j, /expect\(sha256\(r\.bytes\)\)\.toBe\(j\.report_sha256\)/, 'download must be compared by sha256 with the released report, not just status 200');
});

test('journey 1 security attempts: unauthenticated 401, other account 404 common.not_found, staff bearer on /me, revoked link', () => {
  const j = journey();
  assert.match(j, /toBe\(401\)/);
  assert.match(j, /common\.not_found/);
  assert.match(j, /\/app-links\/\$\{link\.id\}\/revoke/);
  assert.match(j, /\/me`, staff\(\)/, 'a staff bearer must be refused on a patient route');
});

test('journey 2 covers booking -> C4 fake consumer -> completion, idempotent create and the last-place race', () => {
  const j = journey();
  for (const frag of [
    '/me/bookable-items', '/me/booking-centres', '/me/slots', '/me/bookings', 'Idempotency-Key', 'centre_visit',
    'engagement.slot_unavailable', 'engagement.reconcile_bookings', 'consumers/c4/run', "'completed'", 'order_id', 'transitions',
  ]) assert.ok(j.includes(frag), `journey 2 must contain ${frag}`);
});

test('journey: PHI hygiene step reads the logs and fails when a phone, OTP, token, link code or name is present (02-TRD §13)', () => {
  const j = journey();
  assert.match(j, /test-support\/logs|\$\{TS\}\/logs/);
  assert.match(j, /logs\.text\.includes\(secret\)/);
  for (const k of ['phone', 'otp', 'code', 'access_token', 'session_token', 'challenge_token']) assert.ok(new RegExp(k).test(j), `${k} must be collected for the log scan`);
});

test('journey is synthetic and secret-free: test phones only, no real tokens, no hard-coded base URL, env-driven', () => {
  const j = journey();
  assert.match(j, /process\.env\.E2E_BASE_URL/);
  assert.match(j, /process\.env\.E2E_STAFF_TOKEN_A/);
  assert.doesNotMatch(j, /https?:\/\/(?!portal\.lims\.test)[a-z0-9.-]+\.(com|np|org|io)\b/i, 'no real host');
  assert.doesNotMatch(j, /eyJ[A-Za-z0-9_-]{10,}/, 'no JWT literal');
  assert.doesNotMatch(j, /\+9779[78]\d{8}\b(?<!\+977980000\d{4})/, 'phones, if any, must be the synthetic +977980000xxxx range');
});

test('test-support routes the journey needs are proposed in a CR (never invented silently), and are non-production only', () => {
  const j = journey();
  const used = [...j.matchAll(/\$\{TS\}\/([a-z0-9/-]+)/g)].map((m) => m[1].replace(/\?.*$/, ''));
  assert.ok(used.length >= 5, 'journey should use the test-support surface for scenarios, events, recorded OTP, C4 consumer, jobs and logs');
  const cr = join(ROOT, '.orchestra', 'cr', 'T-E2E1.md');
  const done = [join(ROOT, '.orchestra', 'cr', 'T-E2E1.resolved.md')];
  const found = [cr, ...done].find(existsSync) ?? (readdirResolved());
  assert.ok(found, '.orchestra/cr/T-E2E1*.md must exist and list the test-support routes');
  const t = readFileSync(found, 'utf8');
  assert.ok(t.includes('/v1/engagement/test-support'), 'CR must state the test-support prefix');
  for (const r of ['/scenarios', '/events', '/recorded-messages', '/consumers/c4/run', '/jobs/run', '/logs']) assert.ok(t.includes(r), `CR must list ${r}`);
  assert.match(t, /non-production|never .*production|absent \(404\) in production/i);
});

function readdirResolved() {
  // CR may be renamed `T-E2E1.resolved-<stamp>.md` by the lead (see .orchestra/cr/C6-T34.resolved-*.md).
  const dir = join(ROOT, '.orchestra', 'cr');
  if (!existsSync(dir)) return undefined;
  return globFirst(dir, /^T-E2E1.*\.md$/);
}
import { readdirSync } from 'node:fs';
function globFirst(dir, re) { const n = readdirSync(dir).find((f) => re.test(f)); return n ? join(dir, n) : undefined; }
