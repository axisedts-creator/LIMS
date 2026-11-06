// SP-8 decision record check (fastify-openapi-glue 4.12.0 fit; 06 row SP-8; 02-TRD §5.2, §6.1, §6.3; TRD §1 Fastify pin).
// Run: node --test tests/spikes/SP-8.decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../db/meta/decisions/SP-8.md', import.meta.url));
const rec = () => {
  assert.ok(existsSync(path), 'db/meta/decisions/SP-8.md must exist');
  return readFileSync(path, 'utf8');
};
const lines = (t) => t.split('\n');
const outcome = (t) =>
  (t.match(/^\W*(?:decision|outcome)\W*[:\-]?\s*\**\s*(as[- ]designed|route[- ]metadata[- ]map)\b/im) || [])[1]
    ?.toLowerCase()
    .replace(/[- ]/g, '-');
// Each feature probed by the spike (06 SP-8 "Mount a 3.0.3 spec ... check:").
const FEATURES = {
  mount: /3\.0\.3[^\n]*(mount|spec)|(mount|spec)[^\n]*3\.0\.3/i,
  securitySchemes: /securitySchemes?/i,
  extensions: /x-\*|extension/i,
  additionalProperties: /additionalProperties\s*:?\s*false/i,
  multipart: /multipart/i,
  operationIdLookup: /operationId[^\n]*(handler|lookup|service)|handler[^\n]*operationId/i,
  securityHandler: /security (handler|resolver)[^\n]*(scheme|per)|per[- ]scheme/i,
  xPermission: /x-permission/,
  xIdempotency: /x-idempotency/,
  xRateLimit: /x-rate-limit-tier/,
  responseValidation: /response (validation|serializ)[^\n]*(toggle|off|on|enable|disable)|(toggle|disable|enable)[^\n]*response validation/i,
  validationErrorShape: /(validation (error|failure)s?|400)[^\n]*(shape|body|envelope|format|code)|error (shape|envelope)/i,
};
const feat = (t, k) => lines(t).filter((x) => FEATURES[k].test(x));
const VERDICT = /\b(pass|reachable|supported|works?|ok|yes|gap|fail|not reachable|unsupported|no)\b|✅|❌/i;
const PASS = /\b(pass|reachable|supported|works?|ok|yes)\b|✅/i;
const GAP = /\b(gap|fail|not reachable|unsupported)\b|❌/i;

test('decision: outcome is exactly one of as-designed | route-metadata-map', () => {
  assert.ok(outcome(rec()), 'need a line "Decision: as-designed" or "Decision: route-metadata-map"');
});

test('exact version pinned: fastify-openapi-glue 4.12.0, no floating range', () => {
  const t = rec();
  assert.match(t, /fastify-openapi-glue[^\n]{0,40}\b4\.12\.0\b/i);
  assert.doesNotMatch(t, /\b(latest|\^\d|~\d|>=\s*\d)/i, 'no floating version/range');
});

test('Fastify major recorded as supported by the glue (TRD §1 pin)', () => {
  const t = rec();
  assert.match(t, /fastify\b[^\n]{0,40}\bv?\d+\.\d+\.\d+/i, 'exact Fastify x.y.z');
  assert.match(t, /(peer|supports?|supported|compatible)[^\n]*fastify|fastify[^\n]*(peer|supported|compatible)/i);
});

test('version evidence: command output in a code block', () => {
  const t = rec();
  assert.match(t, /```/);
  assert.match(t, /(npm (ls|view|list)|pnpm (ls|list|why)|fastify-openapi-glue@4\.12\.0)/i);
});

for (const k of Object.keys(FEATURES)) {
  test(`feature "${k}" probed with a verdict`, () => {
    const ls = feat(rec(), k);
    assert.ok(ls.length, `need a line covering ${FEATURES[k]}`);
    assert.ok(ls.some((l) => VERDICT.test(l)), `"${k}" verdict (pass/gap)`);
  });
}

test('as-designed requires all features reachable (no gap/fail verdict lines)', () => {
  const t = rec();
  assert.equal(outcome(t) !== undefined, true, 'outcome decided');
  if (outcome(t) !== 'as-designed') return;
  for (const k of Object.keys(FEATURES)) {
    const ls = feat(t, k);
    assert.ok(ls.some((l) => PASS.test(l) && !GAP.test(l)), `as-designed but "${k}" not shown as passing`);
  }
});

test('route-metadata-map: names gap(s), operationId key, pre-parse, still mounts through the glue', () => {
  const t = rec();
  assert.equal(outcome(t) !== undefined, true, 'outcome decided');
  if (outcome(t) !== 'route-metadata-map') return;
  assert.match(t, /(gap|not reachable|unsupported|fail)/i, 'which feature forced the fallback');
  assert.match(t, /operationId[^\n]*(key|keyed)|keyed (by|on) operationId/i);
  assert.match(t, /pre-?pars/i);
  assert.match(t, /(through|via) the glue/i);
});

test('x-* extension access method recorded (how core reads x-permission / x-idempotency / x-rate-limit-tier per route)', () => {
  assert.match(rec(), /(routeOptions|schema\.|config\.|route-metadata map|metadata map|onRoute)/i);
});

test('mounted spike spec uses >=2 securitySchemes names from TRD §5.2', () => {
  const t = rec();
  const names = ['bffSession', 'bearerJwt', 'deviceToken', 'queueDisplayToken', 'portalSession', 'patientPreAuth', 'paymentCallbackToken'];
  const n = names.filter((s) => t.includes(s)).length;
  assert.ok(n >= 2, `only ${n} scheme names found`);
});

test('validation failures: a spec error code (common.*) named, none invented', () => {
  assert.match(rec(), /common\.[a-z_]+/);
});

test('response validation toggle: default state and switch (env/option) recorded', () => {
  assert.match(rec(), /response[^\n]*(validation|serializ)[^\n]*(default|prod|dev|ci|env|option)/i);
});

test('multipart: upload handling path recorded (limits / x-upload / multipart plugin)', () => {
  assert.match(rec(), /multipart[^\n]*(limit|x-upload|@fastify\/multipart|attachFieldsToBody|stream)/i);
});

test('downstream hand-off: T0D-01 unblocked (gated by SP-8)', () => {
  assert.match(rec(), /T0D-01/);
});

test('no secrets: no JWT, private key, or password-bearing DSN in record', () => {
  const t = rec();
  assert.doesNotMatch(t, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'raw JWT');
  assert.doesNotMatch(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(t, /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@/, 'DSN with embedded password');
});
