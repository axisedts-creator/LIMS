// SP-5 decision record check (migration runner: Atlas community vs sqitch; 02-TRD §4.2 (a)-(g); CV §15.2; 04 §11; 04 S12).
// Run: node --test tests/spikes/SP-5.decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../db/meta/decisions/SP-5.md', import.meta.url));
const rec = () => {
  assert.ok(existsSync(path), 'db/meta/decisions/SP-5.md must exist');
  return readFileSync(path, 'utf8');
};
const lines = (t) => t.split('\n');
const runner = (t) => (t.match(/^\W*(?:decision|runner)\W*[:\-]?\s*\**\s*(atlas|sqitch)\b/im) || [])[1]?.toLowerCase();
const CRITERIA = {
  a: /forward-only|lexical/i,
  b: /CONCURRENTLY|non-transactional/i,
  c: /SET (LOCAL )?ROLE|lims_owner/i,
  d: /migrations_meta|revision table/i,
  e: /checksum|integrity/i,
  f: /telemetry|phone[- ]home|network/i,
  g: /licen[cs]e/i,
};
const crit = (t, k) => lines(t).filter((x) => new RegExp(`\\(${k}\\)|\\|\\s*${k}\\s*\\|`, 'i').test(x) && CRITERIA[k].test(x));

test('decision: runner is exactly one of atlas | sqitch', () => {
  assert.ok(runner(rec()), 'need a line "Decision: atlas" or "Decision: sqitch"');
});

test('not supabase CLI (04 S12) recorded', () => {
  assert.match(rec(), /supabase (cli|db)[^\n]*(not|never|rejected|excluded)|not[^\n]*supabase (cli|db)/i);
});

test('exact version pinned: runner name + full x.y.z, no floating range', () => {
  const t = rec();
  const r = runner(t);
  assert.ok(r, 'runner decided');
  assert.match(t, new RegExp(`\\b${r}\\b[^\\n]{0,80}?v?\\d+\\.\\d+\\.\\d+`, 'i'), 'exact x.y.z next to runner name');
  assert.doesNotMatch(t, /\b(latest|\^\d|~\d|>=\s*\d)/i, 'no floating version/range');
});

test('version evidence: command output in a code block', () => {
  const t = rec();
  assert.match(t, /```/);
  assert.match(t, new RegExp(`${runner(t) || '(atlas|sqitch)'}\\s+(version|--version|-v)`, 'i'));
});

test('Atlas evaluated first, then sqitch (02-TRD §4.2 order); both have a verdict', () => {
  const t = rec();
  const ia = t.search(/atlas/i);
  const is = t.search(/sqitch/i);
  assert.ok(ia >= 0 && is >= 0, 'both tools discussed');
  assert.ok(ia < is, 'Atlas appears before sqitch');
  if (runner(t) === 'atlas') assert.match(t, /sqitch[^\n]*(fallback|not (chosen|needed)|rejected|R-9)/i);
  if (runner(t) === 'sqitch') assert.match(t, /atlas[^\n]*(fail|reject|not|no |paid|login|pro)/i);
});

for (const k of Object.keys(CRITERIA)) {
  test(`criterion (${k}) has a line with a verdict`, () => {
    const ls = crit(rec(), k);
    assert.ok(ls.length, `need a line marked (${k}) mentioning ${CRITERIA[k]}`);
    assert.ok(ls.some((l) => /\b(pass|fail|met|not met|ok|yes|no)\b|✅|❌/i.test(l)), `(${k}) verdict`);
  });
}

test('all of (a)-(g) pass for the chosen runner', () => {
  const t = rec();
  for (const k of Object.keys(CRITERIA)) {
    const ls = crit(t, k);
    assert.ok(ls.length, `(${k}) line`);
    assert.ok(
      ls.some((x) => /\b(pass|met|ok|yes)\b|✅/i.test(x) && !/\b(fail|not met)\b|❌/i.test(x)),
      `(${k}) must pass for chosen runner`,
    );
  }
});

test('(b)/(c) both file modes shown: SET LOCAL ROLE and SET ROLE lims_owner + CREATE INDEX CONCURRENTLY', () => {
  const t = rec();
  assert.match(t, /CREATE INDEX CONCURRENTLY/i);
  assert.match(t, /SET ROLE lims_owner/);
  assert.match(t, /SET LOCAL ROLE lims_owner/);
});

test('(d) revision table is migrations_meta, owned by lims_migrator, no lims_app grants', () => {
  const t = rec();
  assert.match(t, /migrations_meta/);
  assert.match(t, /lims_migrator/);
  assert.match(t, /lims_app[^\n]*(no (grant|privilege|access)|cannot|denied|no grants)|(no|without) grants?[^\n]*lims_app/i);
});

test('(e) checksum/integrity: tampered-file case detected', () => {
  assert.match(
    rec(),
    /(tamper|edited|modified|changed)[^\n]*(checksum|hash|integrity)[^\n]*(fail|detect|reject|error|refus)|(checksum|hash|integrity)[^\n]*(mismatch|fail)/i,
  );
});

test('session settings lock_timeout 5s and statement_timeout 15min settable by runner', () => {
  const t = rec();
  assert.match(t, /lock_timeout[^\n]*5\s*s/i);
  assert.match(t, /statement_timeout[^\n]*15\s*min/i);
});

test('(f) offline: sandbox with outbound network blocked; method + result recorded', () => {
  const t = rec();
  assert.match(t, /(sandbox|--network[ =]none|network (blocked|disabled|none)|egress (blocked|denied)|offline)/i);
  assert.match(t, /(no|zero|0)[^\n]*(outbound|connection|DNS|telemetry|call)/i);
  assert.match(t, /```/);
});

test('(f) telemetry disabled or absent, with the exact switch or "absent"', () => {
  const l = lines(rec()).find((x) => /telemetry/i.test(x) && /(disabled|absent|none|off|DO_NOT_TRACK|no_update)/i.test(x));
  assert.ok(l, 'telemetry line with switch or absent');
});

test('(f) Atlas only: no `atlas login`, update check off', () => {
  const t = rec();
  if (runner(t) !== 'atlas') return;
  assert.match(t, /atlas login[^\n]*(not|never|no)|(no|not|without)[^\n]*atlas login/i);
  assert.match(t, /(update (check|notifier)|version check)[^\n]*(disabled|off|none|blocked)/i);
});

test('lint gap: Atlas migrate lint is Pro-only; linter or CR recorded (research 03 §3.5, D7)', () => {
  const t = rec();
  assert.match(t, /lint/i);
  assert.match(t, /Pro|squawk|check-migrations|CR\b/);
});

test('(g) licence is an allowed SPDX-style licence per CV §15.2; SSPL/BUSL/RSAL/AGPL absent from verdict', () => {
  const t = rec();
  assert.match(t, /15\.2/);
  const l = lines(t).find((x) => /licen[cs]e/i.test(x) && /(Apache|MIT|BSD|PostgreSQL)/.test(x));
  assert.ok(l, 'licence line names an SPDX-style licence');
  assert.doesNotMatch(l, /SSPL|BUSL|RSAL|AGPL|proprietary/i, 'banned licence in verdict line');
});

test('fresh apply from empty DB recorded (AC-0B-6.1 hand-off) on the pinned PG image', () => {
  const t = rec();
  assert.match(t, /empty/i);
  assert.match(t, /supabase\/postgres:17\.6\.1\.136|postgres(:| )17/i);
});

test('downstream hand-off: T0A-09 and T0B-01/02 unblocked', () => {
  const t = rec();
  assert.match(t, /T0A-09/);
  assert.match(t, /T0B-0[12]/);
});

test('no secrets: no JWT, private key, token or password-bearing DSN in record', () => {
  const t = rec();
  assert.doesNotMatch(t, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'raw JWT');
  assert.doesNotMatch(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(t, /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@/, 'DSN with embedded password');
  assert.doesNotMatch(t, /\bATLAS_TOKEN\s*=\s*\S{8,}/i);
});
