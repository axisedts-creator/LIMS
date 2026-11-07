// SP-4 decision record check (Storage/Realtime request.jwt.claims cross-tenant probes; 04 D3; 05-SCHEMA §8; REQ-SEC-034/035/036).
// Run: node --test db/tests/spikes/SP-4.decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../meta/decisions/SP-4.md', import.meta.url));
const rec = () => {
  assert.ok(existsSync(path), 'db/meta/decisions/SP-4.md must exist');
  return readFileSync(path, 'utf8');
};
// Decided path: storage-policies | api-proxied (plan row SP-4). Read from the "Outcome"/"Decision" line.
const decided = (t) => (t.match(/(?:outcome|decision|decided)[^\n]*?\b(storage-policies|api-proxied)\b/i) || [])[1]?.toLowerCase();

test('record exists and decides storage-policies or api-proxied', () => {
  assert.ok(decided(rec()), 'need "Outcome: storage-policies" or "Outcome: api-proxied"');
});

test('evidence section with commands/outputs in code blocks', () => {
  const t = rec();
  assert.match(t, /evidence/i);
  assert.match(t, /```/, 'commands/outputs in code blocks');
});

test('probe setup: bucket reports, tenants A and B, tokens via C2 login flow / claims resolver', () => {
  const t = rec();
  assert.match(t, /\breports\b/);
  assert.match(t, /tenant A/i);
  assert.match(t, /tenant B/i);
  assert.match(t, /claimsResolver|claims resolver|login flow|C2/i, 'token issuance path');
  assert.match(t, /request\.jwt\.claims/);
});

test('Storage API probes: cross-tenant read AND write denied, same-tenant read works', () => {
  const t = rec();
  assert.match(t, /cross-tenant[^\n]*(read|download|select)/i, 'cross-tenant read probe');
  assert.match(t, /cross-tenant[^\n]*(write|upload|insert|update|delete)|(write|upload|insert)[^\n]*cross-tenant/i, 'cross-tenant write probe');
  assert.match(t, /denied|forbidden|403|404|not found|0 rows|RLS/i, 'denial result recorded');
  assert.match(t, /same-tenant[^\n]*(read|download|select)[^\n]*(works|succe|200|allowed|ok)|(positive|same-tenant)[^\n]*(works|succe|200)/i, 'positive same-tenant read');
});

test('policy under test is the 05-SCHEMA §8 template on first path segment', () => {
  const t = rec();
  assert.match(t, /storage\.foldername\(name\)\)\[1\]|first path segment/i);
  assert.match(t, /app\.current_tenant_id\(\)/);
  assert.match(t, /storage\.objects/);
});

test('Realtime private channel probe with foreign-tenant JWT recorded (or deferred with reason)', () => {
  const t = rec();
  assert.match(t, /realtime/i);
  assert.match(t, /realtime\.topic\(\)|private channel|tenant:\{?tenant_id\}?:/i);
  assert.match(t, /foreign[- ]tenant|cross-tenant|tenant B/i);
  assert.match(t, /denied|rejected|not joined|unauthori[sz]ed|deferred|Phase[- ]3|lag/i, 'result or explicit deferral');
});

test('storage-policies: all attempts denied + gates T0B-12 / T0B-14 (policies may be created)', () => {
  const t = rec();
  if (decided(t) !== 'storage-policies') return;
  assert.match(t, /every|all[^\n]*(cross-tenant|attempt)/i);
  assert.match(t, /T0B-12/);
  assert.match(t, /REQ-SEC-034/);
  assert.doesNotMatch(t, /\b(any|some)\b[^\n]*cross-tenant[^\n]*(succeeded|allowed|leaked)/i, 'a successful cross-tenant access contradicts storage-policies');
});

test('api-proxied: server-credentials-only path, C6/C4 TRD adapt via CR, no end-user policies', () => {
  const t = rec();
  if (decided(t) !== 'api-proxied') return;
  assert.match(t, /ctx\.storage/);
  assert.match(t, /server[- ](side )?(credential|key|role)|service[_ -]role/i);
  assert.match(t, /C6/);
  assert.match(t, /C4/);
  assert.match(t, /\.orchestra\/cr\/SP-4[\w.-]*\.md|CR-C2-011/);
  assert.ok(existsSync(fileURLToPath(new URL('../../../.orchestra/cr/SP-4.nonblocking.md', import.meta.url))), 'C4 wording CR filed');
  assert.match(t, /T0B-12/);
  assert.match(t, /no end-user (storage )?polic|end-user polic[^\n]*(not|none|no)/i);
});

test('REQ-SEC-036: Realtime policies stay gated/Flutter-only; REQ-SEC-035 signed URLs not logged', () => {
  const t = rec();
  assert.match(t, /T0B-14|REQ-SEC-036/);
  assert.match(t, /Flutter/i);
});

test('no secrets/real data: no JWT, private key, service key or password-bearing DSN', () => {
  const t = rec();
  assert.doesNotMatch(t, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'raw JWT');
  assert.doesNotMatch(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(t, /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@/, 'DSN with embedded password');
  assert.doesNotMatch(t, /https?:\/\/[^\s]*[?&]token=[A-Za-z0-9._-]{16,}/, 'signed URL with token (REQ-SEC-035)');
});
