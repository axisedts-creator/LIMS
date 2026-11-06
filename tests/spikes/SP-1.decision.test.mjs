// SP-1 decision record check (AC-SP-1.1; REQ-SEC-065/067; 08 R10). Run: node --test tests/spikes/SP-1.decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../db/meta/decisions/SP-1.md', import.meta.url));
const rec = () => {
  assert.ok(existsSync(path), 'db/meta/decisions/SP-1.md must exist');
  return readFileSync(path, 'utf8');
};

test('record exists and states outcome', () => {
  assert.match(rec(), /outcome/i);
  assert.match(rec(), /claims as expected|session_id.{0,40}missing/i);
});

test('evidence: commands run, outputs, pinned GoTrue image digest', () => {
  const t = rec();
  assert.match(t, /evidence/i);
  assert.match(t, /sha256:[0-9a-f]{64}/, 'pinned image digest');
  assert.match(t, /```/, 'commands/outputs in code blocks');
});

test('session_id and aal: present (format recorded) or blocker for C2 T1 raised', () => {
  const t = rec();
  assert.match(t, /session_id/);
  assert.match(t, /\baal\b/);
  const present = /session_id[^\n]*present/i.test(t) && /aal1/.test(t) && /aal2/.test(t);
  const blocker = /blocker/i.test(t) && /C2 T1/.test(t) && /07-BLOCKERS/.test(t);
  assert.ok(present || blocker, 'need aal1->aal2 evidence, or blocker for C2 T1 in 07-BLOCKERS');
});

test('alg fixes LIMS_CORE_JWT_ALG to one of HS256|ES256|RS256', () => {
  assert.match(rec(), /LIMS_CORE_JWT_ALG\s*[=:`]*\s*`?(HS256|ES256|RS256)\b/);
});

test('iss, aud and exp lifetime (<= 1 h, REQ-SEC-065) recorded', () => {
  const t = rec();
  assert.match(t, /\biss\b/);
  assert.match(t, /\baud\b/);
  assert.match(t, /exp[^\n]*(3600|1 ?h|\d+ ?(s|min))/i);
});

test('session_id stable across refresh of same session', () => {
  assert.match(rec(), /stable[^\n]*refresh|refresh[^\n]*stable/i);
});

test('custom access-token hook not used; claims from identity claimsResolver (R10)', () => {
  const t = rec();
  assert.match(t, /claimsResolver/);
  assert.match(t, /hook[^\n]*not used|no[^\n]*hook/i);
});

test('no secrets/real data: no JWT or key material in record', () => {
  const t = rec();
  assert.doesNotMatch(t, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'raw JWT');
  assert.doesNotMatch(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
});
