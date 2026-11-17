// T0B-DEPFIX-1 (LD-310, LD-312) done_when (3)-(6): the pnpm audit advisories of 2026-11-17 are closed or have a CR, only listed packages move,
// and docs/ops/PRODUCTION-BAR.md shows the new counts.
// Run: node --test tests/monorepo/T0B-DEPFIX-1.audit.test.mjs
// Advisories (pnpm audit 2026-11-17): lodash GHSA-r5fr-rjxr-66jc <4.18.1 (high); @faker-js/faker GHSA-qxc2-j82w-r537 <10.5.0 (high, 5.5.3 via prism, MAJOR);
// vitest GHSA-5xrq-8626-4rwp <3.2.6 (critical); tinypool GHSA-5gmw-xhrv-c9v3 <2.1.1 and GHSA-85c8-ppgw-ccpr <2.1.2 (critical, 1.1.1 via vitest 3, MAJOR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const p = (...s) => join(ROOT, ...s);
const read = (f) => readFileSync(f, 'utf8');
const KEY = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s']+)@([^\s':(]+)[^\s']*'?:/; // lockfile v9 `packages:` / `snapshots:` key

const cmp = (a, b) => { const x = a.split(/[.-]/).map(Number), y = b.split(/[.-]/).map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
function versions(lock) {
  const out = new Map();
  let inPackages = false;
  for (const line of lock.split(/\r?\n/)) {
    if (/^\S/.test(line)) inPackages = /^packages:/.test(line);
    const m = inPackages && KEY.exec(line);
    if (m) { if (!out.has(m[1])) out.set(m[1], new Set()); out.get(m[1]).add(m[2]); }
  }
  return out;
}
const lock = read(p('pnpm-lock.yaml'));
const V = versions(lock);
const vers = (name) => [...(V.get(name) ?? [])];
const crFiles = () => readdirSync(p('.orchestra', 'cr')).filter((f) => /^T0B-DEPFIX-1.*\.md$/.test(f)).map((f) => read(p('.orchestra', 'cr', f)));

// ---------- (3) minor / patch fixes inside the current major: must be applied ----------
test('vitest: no 3.x below 3.2.6 in the lockfile (GHSA-5xrq-8626-4rwp, patch bump inside 3.x)', () => {
  const bad = vers('vitest').filter((v) => v.startsWith('3.') && cmp(v, '3.2.6') < 0);
  assert.deepEqual(bad, [], `vulnerable vitest versions still locked: ${bad}`);
  assert.ok(vers('vitest').some((v) => v.startsWith('3.')), 'vitest 3.x is still used by contracts, packages/fakes, tools/codegen (no major jump)');
});
test('lodash: no 4.x below 4.18.1 in the lockfile (GHSA-r5fr-rjxr-66jc, minor bump inside 4.x)', () => {
  const bad = vers('lodash').filter((v) => cmp(v, '4.18.1') < 0);
  assert.deepEqual(bad, [], `vulnerable lodash versions still locked: ${bad}`);
});

// ---------- (3) major / no-fix advisories: either gone, or NOT bumped and a CR holds the option and risk ----------
const MAJOR_CASES = [
  ['@faker-js/faker', '10.5.0', 'GHSA-qxc2-j82w-r537'],
  ['tinypool', '2.1.2', 'GHSA-85c8-ppgw-ccpr'],
];
for (const [name, fixed, ghsa] of MAJOR_CASES) {
  test(`${name}: no version below ${fixed} remains, or a CR .orchestra/cr/T0B-DEPFIX-1*.md names it with option and risk (${ghsa})`, () => {
    const bad = vers(name).filter((v) => cmp(v, fixed) < 0);
    if (bad.length === 0) return;
    const hit = crFiles().find((t) => t.includes(name) && t.includes(ghsa));
    assert.ok(hit, `${name} ${bad} is vulnerable and needs a major bump: write .orchestra/cr/T0B-DEPFIX-1.md naming ${name} and ${ghsa}`);
    assert.match(hit, /option/i, 'CR gives the exact option');
    assert.match(hit, /risk/i, 'CR gives the risk');
  });
}

// ---------- (4)(5) only the listed packages move; no auth / session / crypto library bumped ----------
test('lockfile diff against main touches only vitest, its direct tool chain, lodash, tinypool and faker; no auth or crypto package', () => {
  const base = spawnSync('git', ['merge-base', 'HEAD', 'main'], { cwd: ROOT, encoding: 'utf8' });
  if (base.status !== 0) return; // no main ref in this checkout: nothing to compare (CI has it)
  const d = spawnSync('git', ['diff', '-U0', base.stdout.trim(), '--', 'pnpm-lock.yaml'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(d.status, 0, d.stderr);
  const touched = new Set();
  for (const line of d.stdout.split(/\r?\n/)) {
    if (!/^[+-] {2}\S/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    const m = KEY.exec(line.slice(1));
    if (m) touched.add(m[1]);
  }
  const ALLOWED = /^(vitest|vite-node|tinypool|lodash|@faker-js\/faker|@vitest\/[\w-]+|@types\/chai|chai|expect-type|pathe|std-env|tinyrainbow|tinyspy|tinybench|tinyexec|magic-string|why-is-node-running|vite|debug|ms|es-module-lexer|picomatch|fdir|tinyglobby|@jridgewell\/sourcemap-codec)$/;
  const AUTH_CRYPTO = /^(jose|jsonwebtoken|jws|jwa|bcrypt\w*|argon2|@node-rs\/argon2|@supabase\/.+|@supabase\/gotrue-js|passport.*|node-forge|tweetnacl|@noble\/.+|otplib|speakeasy|fastify-jwt|@fastify\/(jwt|cookie|session|csrf-protection)|fast-jwt|cookie|iron-session)$/;
  const auth = [...touched].filter((n) => AUTH_CRYPTO.test(n));
  assert.deepEqual(auth, [], `auth / session / crypto package changed in the lockfile: ${auth}`);
  const extra = [...touched].filter((n) => !ALLOWED.test(n));
  assert.deepEqual(extra, [], `lockfile changed for packages outside the listed set (list each bumped package and reason in the notes, or narrow the change): ${extra}`);
});

// ---------- (6) PRODUCTION-BAR.md audit row ----------
const BAR = read(p('docs', 'ops', 'PRODUCTION-BAR.md'));
const ROW = BAR.split(/\r?\n/).find((l) => /^\|\s*Dependency audit/.test(l)) ?? '';
test('PRODUCTION-BAR.md: dependency audit row exists with a date and high / critical counts', () => {
  assert.ok(ROW, 'row "Dependency audit ..." present');
  assert.match(ROW, /20\d\d-\d\d-\d\d/, 'row carries the audit date');
  assert.match(ROW, /\b\d+ high\b/i);
  assert.match(ROW, /\b\d+ critical\b/i);
});
test('PRODUCTION-BAR.md: counts are lower than the 2 high + 3 critical of the first run, and the status follows the counts', () => {
  const high = Number(/\b(\d+) high\b/i.exec(ROW)?.[1]);
  const crit = Number(/\b(\d+) critical\b/i.exec(ROW)?.[1]);
  assert.ok(Number.isInteger(high) && Number.isInteger(crit), 'counts parse');
  assert.ok(high + crit < 5, `vitest (critical) and lodash (high) are fixable in place, so the total must drop below 5, got ${high} high + ${crit} critical`);
  const status = /\|\s*(not met|partly met|met)\s*\|/i.exec(ROW)?.[1]?.toLowerCase();
  if (high + crit === 0) assert.equal(status, 'met', 'zero high and critical means met');
  else {
    assert.notEqual(status, 'met', 'open high or critical findings cannot be met');
    assert.match(ROW, /CR|\.orchestra\/cr/, 'remaining findings point at the CR');
  }
});
test('a CR exists for every remaining major-bump advisory (row does not say met while one is open)', () => {
  const open = MAJOR_CASES.filter(([n, f]) => vers(n).some((v) => cmp(v, f) < 0));
  if (open.length) assert.ok(existsSync(p('.orchestra', 'cr')) && crFiles().length > 0, 'open advisories need .orchestra/cr/T0B-DEPFIX-1*.md');
});
