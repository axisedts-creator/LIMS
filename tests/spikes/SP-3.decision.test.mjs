// SP-3 decision record check (pgTAP + extensions in supabase/postgres:17.6.1.136; CV §5.12; 05-SCHEMA §1; 08 A31.1; review C0 m#36).
// Run: node --test tests/spikes/SP-3.decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../db/meta/decisions/SP-3.md', import.meta.url));
const rec = () => {
  assert.ok(existsSync(path), 'db/meta/decisions/SP-3.md must exist');
  return readFileSync(path, 'utf8');
};
const EXTS = ['pgtap', 'pg_trgm', 'btree_gin', 'pgcrypto', 'pg_uuidv7'];
const MISSING = /not available|missing|unavailable|absent/i;
const harness = (t) => (t.match(/harness[^\n]*?\b(pgtap|sql-harness)\b/i) || [])[1]?.toLowerCase();
const isMissing = (t, e) => t.split('\n').some((l) => new RegExp(`\\b${e}\\b`).test(l) && MISSING.test(l));

test('record names the pinned image supabase/postgres:17.6.1.136', () => {
  assert.match(rec(), /supabase\/postgres:17\.6\.1\.136/);
});

test('decision: harness is exactly one of pgtap | sql-harness', () => {
  assert.ok(harness(rec()), 'need "Harness: pgtap" or "Harness: sql-harness"');
});

test('evidence: pg_available_extensions query output for all five extensions in a code block', () => {
  const t = rec();
  assert.match(t, /pg_available_extensions/);
  assert.match(t, /```/, 'query/output in code block');
  assert.match(t, /default_version/);
  for (const e of EXTS) assert.match(t, new RegExp(`\\b${e}\\b`), `extension ${e}`);
});

test('each extension states a version or missing', () => {
  const t = rec();
  for (const e of EXTS) {
    const line = t.split('\n').find((l) => new RegExp(`\\b${e}\\b`).test(l) && (/\d+\.\d+/.test(l) || MISSING.test(l)));
    assert.ok(line, `${e}: need a line with version or missing`);
  }
});

test('CREATE EXTENSION pgtap tried in a throwaway DB as image superuser', () => {
  const t = rec();
  assert.match(t, /CREATE EXTENSION[^\n]*pgtap/i);
  assert.match(t, /throwaway|scratch|temporary/i);
  assert.match(t, /superuser|supabase_admin|postgres role/i);
});

test('pgtap harness: test DBs only, never prod migrations', () => {
  const t = rec();
  if (harness(t) !== 'pgtap') return;
  assert.match(t, /(test|CI|dev)[^\n]*(only|DBs?|databases?)/i);
  assert.match(t, /never[^\n]*(prod|migration)/i);
});

test('sql-harness only if pgtap unusable; reason stated', () => {
  const t = rec();
  if (harness(t) !== 'sql-harness') return;
  assert.match(t, /pgtap[^\n]*(not available|missing|unavailable|fail|error)/i);
});

test('pg_trgm: availability recorded; bootstrap creates it in schema extensions', () => {
  const t = rec();
  assert.match(t, /pg_trgm/);
  assert.match(t, /\bextensions\b/);
  assert.match(t, /01_database\.sql|bootstrap/i);
});

test('pg_trgm missing -> CR to C4 (REQ-ARCH-023 alternative)', () => {
  const t = rec();
  if (!isMissing(t, 'pg_trgm')) return;
  assert.match(t, /\bC4\b/);
  assert.match(t, /REQ-ARCH-023/);
  assert.match(t, /\.orchestra\/cr\/SP-3\.md|\bCR\b/);
});

test('btree_gin recorded with C11 / 08 A31.1 hand-off; index exception if missing', () => {
  const t = rec();
  assert.match(t, /btree_gin/);
  assert.match(t, /C11|A31\.1/);
  if (isMissing(t, 'btree_gin')) assert.match(t, /index exception|cs_diagnoses/i);
});

test('GoTrue, Storage, PostgREST: database they connect to recorded', () => {
  const t = rec();
  for (const s of ['GoTrue', 'Storage', 'PostgREST']) assert.match(t, new RegExp(s), s);
  assert.match(t, /connect[^\n]*(database|DB)|(database|DB)[^\n]*connect/i);
});

test('login role names recorded verbatim from the image', () => {
  const t = rec();
  assert.match(t, /supabase_auth_admin/, 'GoTrue login role');
  assert.match(t, /supabase_storage_admin/, 'Storage login role');
  assert.match(t, /\bauthenticator\b/, 'PostgREST login role');
});

test('GRANT CONNECT decision: LIMS DB -> exact grants for the three roles; else stated not needed', () => {
  const t = rec();
  assert.match(t, /GRANT CONNECT/i);
  const lims = /connect[^\n]*(LIMS database|same database)|:.dbname./i.test(t);
  if (lims) {
    for (const r of ['supabase_auth_admin', 'supabase_storage_admin', 'authenticator']) {
      assert.match(t, new RegExp(`GRANT CONNECT ON DATABASE[^\\n]*TO[^\\n]*${r}`), `GRANT CONNECT to ${r}`);
    }
  } else {
    assert.match(t, /not needed|no grant|separate database|different database|own database/i);
  }
});

test('no GoTrue hook privilege on app (08 R10)', () => {
  assert.doesNotMatch(rec(), /GRANT[^\n]*ON SCHEMA app[^\n]*TO[^\n]*supabase_auth_admin/i);
});

test('no secrets/real data: no JWT, private key or password-bearing DSN in record', () => {
  const t = rec();
  assert.doesNotMatch(t, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'raw JWT');
  assert.doesNotMatch(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(t, /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@/, 'DSN with embedded password');
});
