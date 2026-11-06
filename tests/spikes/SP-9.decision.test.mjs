// SP-9 decision record check (transaction-local claims via PgBouncer >= 1.21 transaction mode + node-postgres; 04 S8/S9; AC-0D-2.3; 07-SECURITY AB-8, R-8).
// Run: node --test tests/spikes/SP-9.decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../db/meta/decisions/SP-9.md', import.meta.url));
const rec = () => {
  assert.ok(existsSync(path), 'db/meta/decisions/SP-9.md must exist');
  return readFileSync(path, 'utf8');
};
const lines = (t) => t.split('\n');
const has = (t, re) => lines(t).filter((l) => re.test(l));
// "max_prepared_statements = N" (N>0) or the literal "unnamed only"
const setting = (t) => {
  const m = t.match(/^\W*(?:decision|prepared[- ]statements?)\W*[:\-]?\s*\**\s*(?:max_prepared_statements\s*[=:]?\s*(\d+)|(unnamed only))/im);
  return m && (m[2] ? 'unnamed' : Number(m[1]));
};

test('decision: prepared-statement setting is "max_prepared_statements = N" (N>0) or "unnamed only"', () => {
  const s = setting(rec());
  assert.ok(s !== null && s !== undefined, 'need line "Decision: max_prepared_statements = N" or "Decision: unnamed only"');
  if (s !== 'unnamed') assert.ok(s > 0, 'N must be > 0 (0 = disabled; then record "unnamed only")');
});

test('PgBouncer exact version >= 1.21.0 pinned, no floating range', () => {
  const t = rec();
  const m = t.match(/pgbouncer[^\n]{0,80}?v?(\d+)\.(\d+)\.(\d+)/i);
  assert.ok(m, 'PgBouncer x.y.z next to name');
  assert.ok(+m[1] > 1 || (+m[1] === 1 && +m[2] >= 21), `PgBouncer ${m[0]} must be >= 1.21 (04 S8)`);
  assert.doesNotMatch(t, /\b(latest|\^\d|~\d|>=\s*\d+\.\d+\.\d)/i, 'no floating version/range');
});

test('node-postgres (pg) exact x.y.z pinned', () => {
  assert.match(rec(), /\b(node-postgres|pg)\b[^\n]{0,40}?v?\d+\.\d+\.\d+/i);
});

test('version evidence: command output in a code block', () => {
  const t = rec();
  assert.match(t, /```/);
  assert.match(t, /(pgbouncer\s+(--version|-V|version)|SHOW VERSION|select version)/i);
});

test('pool_mode = transaction and exactly 2 PgBouncer server connections', () => {
  const t = rec();
  assert.match(t, /pool_mode\s*=?\s*transaction/i);
  assert.match(t, /(default_pool_size|max_db_connections|server connections?)[^\n]{0,40}\b2\b|\b2\b[^\n]{0,40}server connections?/i);
});

test('workload: 1,000 interleaved transactions, tenants A and B', () => {
  const t = rec();
  assert.match(t, /1,?000\b[^\n]{0,60}(interleaved|transactions|txns?)/i);
  assert.match(t, /tenant[s]? A\b[^\n]*\bB\b|\bA\/B\b|tenant_a[^\n]*tenant_b/i);
});

test('each transaction asserts app.current_tenant_id()', () => {
  assert.match(rec(), /app\.current_tenant_id\(\)/);
});

test('outside-transaction statements assert NULL (AC-0D-2.3)', () => {
  assert.match(rec(), /(outside|autocommit|no transaction|without (a )?transaction)[^\n]*NULL|NULL[^\n]*(outside|autocommit)/i);
});

test('zero leaks reported as a count, in BOTH modes', () => {
  const t = rec();
  const z = has(t, /leaks?\W+(?:count\W+)?[:=|]?\s*0\b|\b0\s+leaks?\b|zero leaks?/i);
  assert.ok(z.length >= 2, 'at least two zero-leak lines (with and without prepared statements)');
  assert.doesNotMatch(t, /leaks?\W*[:=|]\s*[1-9]\d*\b/i, 'no non-zero leak count');
});

test('tested with AND without protocol-level prepared statements', () => {
  const t = rec();
  assert.match(t, /(with|enabled|max_prepared_statements\s*=\s*[1-9])[^\n]*prepared/i);
  assert.match(t, /(without|disabled|unnamed|max_prepared_statements\s*=\s*0)/i);
  assert.match(t, /(named|protocol-level|extended protocol|Parse\/Bind)/i);
});

test('claims are transaction-local: set_config(..., true) / SET LOCAL; no session-level SET', () => {
  const t = rec();
  assert.match(t, /set_config\([^)]*,\s*true\)|SET LOCAL/i);
  assert.match(t, /(no|never|ban|forbid|not)[^\n]*(session[- ]level|bare `?SET`?|set_config\([^)]*false)/i);
});

test('node-postgres pitfalls recorded: one pool.connect client per txn; pool.query / statement names noted', () => {
  const t = rec();
  assert.match(t, /pool\.connect|client\.query|BEGIN/i);
  assert.match(t, /pool\.query|name:|prepare:?|statement name/i);
});

test('interleaving is real: concurrency > server connections, shared backend pid evidence', () => {
  const t = rec();
  assert.match(t, /(concurren\w+|parallel|interleav\w+)[^\n]*\b(\d{2,})\b|\b(\d{2,})\b[^\n]*(concurren|clients?)/i);
  assert.match(t, /pg_backend_pid|backend pid|server pid|same server connection/i);
});

test('cross-check: rows read under RLS match caller tenant (not only the function result)', () => {
  assert.match(rec(), /RLS|row[s]? (visible|returned)|SELECT[^\n]*tenant_id/i);
});

test('hand-off: C1 PgBouncer settings recorded; gates T0D-03; permanent CI test (AB-8, AC-0D-2.3, R-8)', () => {
  const t = rec();
  assert.match(t, /\bC1\b/);
  assert.match(t, /T0D-03/);
  assert.match(t, /(permanent|kept)[^\n]*CI|CI[^\n]*(permanent|kept)/i);
  assert.match(t, /AC-0D-2\.3|AB-8|R-8/);
});

test('failure path: a leak would fail the spike, and fallback recorded', () => {
  assert.match(rec(), /(fallback|if (a )?leak|fail(s|ed)? the spike|CR\b)/i);
});

test('synthetic data only, no secrets/passwords/real hosts', () => {
  const t = rec();
  assert.doesNotMatch(t, /(password|passwd|secret|api[_-]?key)\s*[=:]\s*\S{4,}/i);
  assert.doesNotMatch(t, /postgres(ql)?:\/\/[^\s:@]+:[^\s@]+@/i, 'no credentialed DSN');
});
