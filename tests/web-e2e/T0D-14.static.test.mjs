// T0D-14 static/build checks (no browser). AC-0D-7.3 (bundle/deps scan), AC-0D-7.5 (duplicate shortcut fails build,
// naming both modules), dev-only BffSessionStore (08 R10), cookie prefix, CSP source guard (REQ-SEC-089).
// Run: node --test tests/web-e2e/T0D-14.static.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const SRC = join(WEB, 'src');
const FIX = join(ROOT, 'tests', 'web-e2e', 'fixtures');
const read = (...p) => readFileSync(join(WEB, ...p), 'utf8');
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => {
  const f = join(d, n);
  return statSync(f).isDirectory() ? (n === 'node_modules' || n === '.next' ? [] : walk(f)) : [f];
}) : []);

test('apps/web package: @lims/web, build:nav script, next + server-only, no @supabase/*', () => {
  assert.ok(existsSync(join(WEB, 'package.json')), 'apps/web/package.json missing');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, '@lims/web');
  assert.ok(pkg.scripts?.['build:nav'], 'script build:nav (runs core/nav/build-nav.ts) missing');
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const d of ['next', 'server-only', '@playwright/test', '@lims/ui']) assert.ok(deps[d], `dependency ${d} missing`);
  assert.deepEqual(Object.keys(deps).filter((d) => d.startsWith('@supabase/')), []);
  for (const [k, v] of Object.entries(deps)) assert.match(String(v), /^(workspace:|\d)/, `${k} must be exact-pinned (CV §15.1)`);
});

test('AC-0D-7.3: no @supabase/* import or JWT-like literal anywhere in apps/web/src', () => {
  const files = walk(SRC).filter((f) => /\.(tsx?|mjs|js)$/.test(f));
  assert.ok(files.length > 0, 'apps/web/src has no source files');
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /@supabase\//, `${f} imports @supabase/*`);
    assert.doesNotMatch(t, /eyJ[A-Za-z0-9_-]{10,}\.eyJ/, `${f} contains a JWT literal`);
  }
});

test('server-only modules: api/server-fetch.ts imports "server-only"', () => {
  assert.match(read('src', 'core', 'api', 'server-fetch.ts'), /import\s+['"]server-only['"]/);
});

test('session cookie: __Host-lims_sid, HttpOnly, Secure, SameSite=Lax, no Domain', () => {
  const t = read('src', 'core', 'session', 'cookie.ts');
  assert.match(t, /__Host-lims_sid/);
  assert.match(t, /httpOnly\s*:\s*true|HttpOnly/);
  assert.match(t, /secure\s*:\s*true|Secure/);
  assert.match(t, /sameSite\s*:\s*['"]lax['"]|SameSite=Lax/i);
  assert.doesNotMatch(t, /\bdomain\s*:|Domain=/i);
});

test('08 R10: BffSessionStore dev provider refuses to load in staging/production; C2 resolveSession path exists', () => {
  const store = read('src', 'core', 'session', 'store.ts');
  assert.match(store, /BffSessionStore/);
  const prov = read('src', 'core', 'session', 'provider.ts');
  assert.match(prov, /LIMS_CORE_ENV/);
  assert.match(prov, /staging/);
  assert.match(prov, /production/);
  const all = walk(join(SRC, 'core')).map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.match(all, /\/v1\/identity\/auth\/session\/resolve/, 'BFF must call C2 resolveSession');
  assert.match(all, /X-Lims-Bff-Key/i);
  assert.match(all, /X-Lims-Background/i);
  assert.match(all, /touch/);
  assert.match(all, /auth\.session_expired/);
});

test('REQ-SEC-089/091 middleware source: CSP nonce + img-src \'self\' data:, Origin/Sec-Fetch-Site, auth.csrf_failed', () => {
  const t = read('src', 'middleware.ts');
  assert.match(t, /img-src 'self' data:/);
  assert.match(t, /nonce-/);
  assert.match(t, /sec-fetch-site/i);
  assert.match(t, /origin/i);
  assert.match(t, /auth\.csrf_failed/);
  assert.doesNotMatch(t, /unsafe-inline/);
  assert.doesNotMatch(t, /img-src[^;`'"]*https?:/);
});

// ---- AC-0D-7.5 + build-nav rules (04-UI-UX §3). ASSUMED: `pnpm --filter @lims/web run build:nav`, features dir from env LIMS_WEB_FEATURES_DIR.
const buildNav = (fixture) => spawnSync('pnpm', ['--filter', '@lims/web', 'run', 'build:nav'],
  { cwd: ROOT, shell: true, encoding: 'utf8', env: { ...process.env, LIMS_WEB_FEATURES_DIR: join(FIX, fixture) } });
const out = (r) => `${r.stdout}\n${r.stderr}`;

test('AC-0D-7.5: duplicate chord in two modules fails the build and names both modules', () => {
  const r = buildNav('features-dup-chord');
  assert.notEqual(r.status, 0, out(r));
  const o = out(r);
  assert.match(o, /g s/);
  assert.match(o, /\blab\b/);
  assert.match(o, /\bbilling\b/);
});

test('build-nav: routeId missing from routes.yaml fails', () => {
  const r = buildNav('features-bad-route');
  assert.notEqual(r.status, 0, out(r));
  assert.match(out(r), /staff\.lab\.does_not_exist/);
});

test('build-nav: permission differing from the route\'s permission fails', () => {
  const r = buildNav('features-bad-permission');
  assert.notEqual(r.status, 0, out(r));
  assert.match(out(r), /staff\.lab\.status_board|billing\.invoice\.read/);
});

test('build-nav: valid manifests succeed and generated.ts lists both entries', () => {
  const r = buildNav('features-ok');
  assert.equal(r.status, 0, out(r));
  const gen = read('src', 'core', 'nav', 'generated.ts');
  assert.match(gen, /lab\.status_board/);
  assert.match(gen, /billing\.daily_cash/);
});

test('shortcut registry: page-level duplicate or global-key conflict throws (04-UI-UX §4)', () => {
  const t = read('src', 'core', 'shortcuts', 'registry.ts');
  assert.match(t, /throw/);
  assert.match(t, /register/);
});
