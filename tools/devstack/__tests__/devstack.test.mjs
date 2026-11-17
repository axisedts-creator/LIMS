// T0A-09: Dev stack. Spec: 01-PRD US-0A-6 (AC-0A-6.1/6.2/6.3), 02-TRD s3.6, 07-SECURITY REQ-SEC-037/128, 04 S6/S8.
// Run: node --test tools/devstack/__tests__/devstack.test.mjs      (live port scan: set DEVSTACK_LIVE=1 with the stack up)
//
// No YAML parser is installed, so compose.yaml is read as text (service ids at 2-space indent under `services:`).
// Contracts the spec does not fix (test-side choices):
//  1. node tools/devstack/init-secrets.ts [--out <file>] [--example <file>]
//       default --out = tools/devstack/.env.devstack ; default --example = tools/devstack/upstream.env.example
//       (committed copy of the pinned Supabase `.env.example`; it is the REQ-SEC-037 "published value" list).
//       Writes KEY=VALUE lines. For every key in --example whose NAME looks secret (SECRET_NAME below) and whose value is
//       non-empty, writes a fresh random value that differs from every example value. Also writes
//       LIMS_API_PASSWORD, LIMS_WORKER_PASSWORD, LIMS_MIGRATOR_PASSWORD (>= 24 chars, all distinct). If the example holds
//       JWT-shaped ANON_KEY / SERVICE_ROLE_KEY they are re-signed (HS256) with the NEW JWT_SECRET, roles anon/service_role.
//       Never prints a secret to stdout/stderr. Existing --out is left untouched (exit 0): `up` runs it "if absent".
//  2. node tools/devstack/init-secrets.ts --check <env file> [--example <file>]
//       exit 0 ok; 1 if any secret key is missing/empty, or ANY value equals ANY secret value of the example (message
//       names the KEY, never the value); 2 bad usage / unreadable file (fail closed).
//  3. Root package.json scripts dev:up / dev:down / dev:reset run tools/devstack/{up,down,reset}.ts.
//  4. Static compose checks stand in for a port scan when Docker is absent; the live scan is opt-in (DEVSTACK_LIVE=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const P = (p) => join(root, p);
const DS = 'tools/devstack';
const tmp = mkdtempSync(join(tmpdir(), 'devstack-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const SECRET_NAME = /(PASSWORD|_PASS$|SECRET|(^|_)KEY(_|$)|TOKEN)/;
const b64u = (b) => Buffer.from(b).toString('base64url');
const jwt = (payload, secret) => {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
};
const parseEnv = (text) => {
  const o = {};
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (m) o[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return o;
};
const run = (args) =>
  spawnSync(process.execPath, [P(`${DS}/init-secrets.ts`), ...args], { cwd: root, encoding: 'utf8', timeout: 60000 });

// Synthetic fixture standing in for a published .env.example (values are fake; not Supabase's).
const FIX_SECRET = 'fixture-jwt-secret-not-for-real-use-0123456789';
const fixtureText = [
  'POSTGRES_PASSWORD=fixture-postgres-password-placeholder',
  `JWT_SECRET=${FIX_SECRET}`,
  `ANON_KEY=${jwt({ role: 'anon', iss: 'supabase-demo', exp: 1983812996 }, FIX_SECRET)}`,
  `SERVICE_ROLE_KEY=${jwt({ role: 'service_role', iss: 'supabase-demo', exp: 1983812996 }, FIX_SECRET)}`,
  'DASHBOARD_USERNAME=supabase',
  'DASHBOARD_PASSWORD=fixture-dashboard-password-placeholder',
  'SECRET_KEY_BASE=fixture-secret-key-base-placeholder-aaaaaaaaaaaaaaaaaaaaaaaa',
  'VAULT_ENC_KEY=fixture-vault-enc-key-placeholder',
  'SMTP_PASS=fixture-smtp-pass-placeholder',
  'JWT_EXPIRY=3600',
  'SITE_URL=http://localhost:3000',
  'EMPTY_TOKEN=',
  '',
].join('\n');
const fixturePath = join(tmp, 'fixture.env.example');
writeFileSync(fixturePath, fixtureText);
const fixture = parseEnv(fixtureText);
const fixtureSecrets = Object.entries(fixture).filter(([k, v]) => v && SECRET_NAME.test(k));
const LIMS_PW = ['LIMS_API_PASSWORD', 'LIMS_WORKER_PASSWORD', 'LIMS_MIGRATOR_PASSWORD'];

// ---------- AC-0A-6.3 / REQ-SEC-037: init-secrets ----------
test('AC-0A-6.3 init-secrets writes fresh secrets that differ from every example value', () => {
  const out = join(tmp, 'a.env');
  const r = run(['--out', out, '--example', fixturePath]);
  assert.equal(r.status, 0, r.stderr);
  const env = parseEnv(readFileSync(out, 'utf8'));
  const exampleVals = new Set(fixtureSecrets.map(([, v]) => v));
  for (const [k, v] of fixtureSecrets) {
    assert.ok(env[k], `missing ${k}`);
    assert.ok(env[k].length >= 24, `${k} too short`);
    assert.notEqual(env[k], v, `${k} equals example`);
    assert.ok(!exampleVals.has(env[k]), `${k} equals another example value`);
  }
  assert.equal(env.DASHBOARD_USERNAME, 'supabase', 'non-secret keys pass through');
  for (const k of LIMS_PW) assert.ok(env[k] && env[k].length >= 24, `${k} missing/short`);
  const all = [...fixtureSecrets.map(([k]) => env[k]), ...LIMS_PW.map((k) => env[k])].filter((v) => !v.includes('.'));
  assert.equal(new Set(all).size, all.length, 'secrets must be distinct from each other');
});

test('AC-0A-6.3 two runs on a fresh checkout give different secrets', () => {
  const a = join(tmp, 'r1.env'), b = join(tmp, 'r2.env');
  assert.equal(run(['--out', a, '--example', fixturePath]).status, 0);
  assert.equal(run(['--out', b, '--example', fixturePath]).status, 0);
  const A = parseEnv(readFileSync(a, 'utf8')), B = parseEnv(readFileSync(b, 'utf8'));
  for (const [k] of fixtureSecrets) assert.notEqual(A[k], B[k], `${k} repeated across runs`);
  for (const k of LIMS_PW) assert.notEqual(A[k], B[k], `${k} repeated across runs`);
});

test('init-secrets re-signs ANON_KEY / SERVICE_ROLE_KEY with the new JWT_SECRET', () => {
  const out = join(tmp, 'jwt.env');
  assert.equal(run(['--out', out, '--example', fixturePath]).status, 0);
  const env = parseEnv(readFileSync(out, 'utf8'));
  for (const [name, role] of [['ANON_KEY', 'anon'], ['SERVICE_ROLE_KEY', 'service_role']]) {
    const [h, p, s] = env[name].split('.');
    assert.ok(h && p && s, `${name} not a JWT`);
    assert.equal(s, createHmac('sha256', env.JWT_SECRET).update(`${h}.${p}`).digest('base64url'), `${name} signature`);
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    assert.equal(claims.role, role);
    assert.ok(claims.exp > Date.now() / 1000, `${name} already expired`);
  }
});

test('init-secrets never prints secret values and leaves an existing file untouched', () => {
  const out = join(tmp, 'keep.env');
  const r = run(['--out', out, '--example', fixturePath]);
  assert.equal(r.status, 0, r.stderr);
  const first = readFileSync(out, 'utf8');
  for (const v of Object.values(parseEnv(first)).filter((v) => v.length >= 24))
    assert.ok(!(r.stdout + r.stderr).includes(v), 'secret leaked to output');
  const r2 = run(['--out', out, '--example', fixturePath]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(out, 'utf8'), first, 'existing .env.devstack must not be rotated/overwritten');
});

test('init-secrets --check rejects example values, missing and empty secrets (fail closed)', () => {
  const good = join(tmp, 'chk-good.env');
  assert.equal(run(['--out', good, '--example', fixturePath]).status, 0);
  assert.equal(run(['--check', good, '--example', fixturePath]).status, 0);

  const bad = (name, mutate, key) => {
    const f = join(tmp, `chk-${name}.env`);
    const env = parseEnv(readFileSync(good, 'utf8'));
    mutate(env);
    writeFileSync(f, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    const r = run(['--check', f, '--example', fixturePath]);
    assert.equal(r.status, 1, `${name}: expected 1, got ${r.status} ${r.stderr}`);
    assert.ok((r.stdout + r.stderr).includes(key), `${name}: message must name ${key}`);
    assert.ok(!(r.stdout + r.stderr).includes(fixture.POSTGRES_PASSWORD), 'check output must not echo values');
  };
  bad('same', (e) => (e.POSTGRES_PASSWORD = fixture.POSTGRES_PASSWORD), 'POSTGRES_PASSWORD');
  bad('swapped', (e) => (e.LIMS_API_PASSWORD = fixture.DASHBOARD_PASSWORD), 'LIMS_API_PASSWORD'); // example value under another key
  bad('missing', (e) => delete e.JWT_SECRET, 'JWT_SECRET');
  bad('empty', (e) => (e.SMTP_PASS = ''), 'SMTP_PASS');
  bad('lims-missing', (e) => delete e.LIMS_MIGRATOR_PASSWORD, 'LIMS_MIGRATOR_PASSWORD');

  assert.equal(run(['--check', join(tmp, 'does-not-exist.env'), '--example', fixturePath]).status, 2);
  assert.equal(run(['--check', good, '--example', join(tmp, 'nope')]).status, 2);
  assert.equal(run(['--bogus']).status, 2);
});

// ---------- AC-0A-6.3 against the real vendored .env.example ----------
test('AC-0A-6.3 vendored upstream.env.example exists and init-secrets default run differs from it', () => {
  const ex = P(`${DS}/upstream.env.example`);
  assert.ok(existsSync(ex), 'tools/devstack/upstream.env.example (pinned Supabase .env.example copy) missing');
  const secrets = Object.entries(parseEnv(readFileSync(ex, 'utf8'))).filter(([k, v]) => v && SECRET_NAME.test(k));
  assert.ok(secrets.length >= 5, 'upstream example should list several secret keys');
  const out = join(tmp, 'real.env');
  const r = run(['--out', out, '--example', ex]);
  assert.equal(r.status, 0, r.stderr);
  const env = parseEnv(readFileSync(out, 'utf8'));
  const vals = new Set(secrets.map(([, v]) => v));
  for (const [k] of secrets) assert.ok(env[k] && !vals.has(env[k]), `${k} missing or equals published value`);
  assert.equal(run(['--check', out, '--example', ex]).status, 0);
  // default invocation (no --example) must pick the same vendored file: a copy of the example itself must fail --check
  assert.equal(run(['--check', ex]).status, 1, 'default example path not used / example values accepted');
});

test('REQ-SEC-037/128 no published example value appears in any committed devstack file; .env.devstack is gitignored', () => {
  const ex = P(`${DS}/upstream.env.example`);
  assert.ok(existsSync(ex), 'upstream.env.example missing');
  const vals = Object.entries(parseEnv(readFileSync(ex, 'utf8')))
    .filter(([k, v]) => v && SECRET_NAME.test(k) && v.length >= 8)
    .map(([, v]) => v);
  assert.ok(vals.length > 0);
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name);
      if (e.name === 'node_modules' || e.name === '__tests__') return [];
      return e.isDirectory() ? walk(p) : [p];
    });
  for (const f of walk(P(DS))) {
    if (f === ex || f.endsWith('.env.devstack')) continue;
    const t = readFileSync(f, 'utf8');
    for (const v of vals) assert.ok(!t.includes(v), `${relative(root, f)} contains a published .env.example secret`);
  }
  const r = spawnSync('git', ['check-ignore', '-q', `${DS}/.env.devstack`], { cwd: root });
  assert.equal(r.status, 0, '.env.devstack must be gitignored');
  // env/ templates carry no secret values
  const envDir = P(`${DS}/env`);
  assert.ok(existsSync(envDir) && statSync(envDir).isDirectory(), 'tools/devstack/env/ templates missing');
  for (const f of walk(envDir))
    for (const [k, v] of Object.entries(parseEnv(readFileSync(f, 'utf8'))))
      if (SECRET_NAME.test(k)) assert.ok(v === '' || /^\$\{[A-Z0-9_]+\}$/.test(v), `${relative(root, f)}: ${k} has a literal value`);
});

// ---------- AC-0A-6.2 / 6.1: compose.yaml static checks ----------
const composePath = P(`${DS}/compose.yaml`);
const compose = existsSync(composePath) ? readFileSync(composePath, 'utf8') : '';
const need = () => assert.ok(compose, 'tools/devstack/compose.yaml missing');
const services = () => {
  need();
  const body = compose.split(/^services:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  const out = {};
  let cur = null;
  for (const l of body.split(/\r?\n/)) {
    const m = /^  ([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(l);
    if (m) (cur = m[1]), (out[cur] = []);
    else if (cur) out[cur].push(l);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]));
};
const publishedPorts = (block) => {
  const found = [];
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ports:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2].startsWith('[')) found.push(...m[2].replace(/[\[\]#].*$/, '').split(',').map((s) => s.trim()).filter(Boolean));
    else
      for (let j = i + 1; j < lines.length && (/^\s*-\s/.test(lines[j]) || /^\s*(#.*)?$/.test(lines[j])); j++) {
        const it = /^\s*-\s*(.+?)\s*(#.*)?$/.exec(lines[j]);
        if (it) found.push(it[1]);
      }
  }
  return found.map((s) => s.replace(/^["']|["']$/g, ''));
};

test('AC-0A-6.2 every published port is 127.0.0.1:<host>:<container>; no host networking', () => {
  const svc = services();
  assert.ok(Object.keys(svc).length >= 6, 'compose must define the stack services');
  let total = 0;
  for (const [name, block] of Object.entries(svc)) {
    assert.ok(!/network_mode:\s*["']?host/.test(block), `${name}: host networking bypasses port binding`);
    for (const p of publishedPorts(block)) {
      total++;
      assert.match(p, /^127\.0\.0\.1:\d+:\d+(\/(tcp|udp))?$/, `${name}: port "${p}" not bound to 127.0.0.1`);
    }
  }
  assert.ok(total >= 3, 'db/pgbouncer/gateway/mailpit should publish at least a few loopback ports');
  assert.ok(!/0\.0\.0\.0|\[::\]/.test(compose.replace(/^\s*#.*$/gm, '')), 'wildcard bind address present');
});

test('AC-0A-6.2 studio/meta, realtime, redis are profile-gated; Supavisor is absent (04 S5/S8/S11)', () => {
  const svc = services();
  const profile = (n, p) => assert.match(svc[n] ?? '', new RegExp(`profiles:[^\\n]*\\b${p}\\b|profiles:\\s*\\n(\\s*-\\s*["']?\\w+["']?\\s*\\n)*\\s*-\\s*["']?${p}\\b`), `${n} must be in profile ${p}`);
  for (const n of ['studio', 'meta']) profile(n, 'studio');
  profile('realtime', 'flutter');
  profile('redis', 'ratelimit');
  assert.ok(!Object.keys(svc).some((n) => /supavisor|pooler/i.test(n)) && !/supabase\/supavisor/i.test(compose), 'Supavisor must be disabled');
  assert.match(svc.redis ?? '', /--save\s+(''|""|\\?"\\?")|--save\s*''/, "redis must run with --save ''");
  assert.match(svc.redis ?? '', /--appendonly\s+no/);
});

test('AC-0A-6.1 services, pinned images, hardening env present in compose.yaml', () => {
  const svc = services();
  for (const n of ['db', 'auth', 'storage', 'rest', 'pgbouncer', 'mailpit'])
    assert.ok(svc[n], `service ${n} missing`);
  assert.ok(Object.values(svc).some((b) => /image:\s*\S*envoy/i.test(b)), 'Envoy gateway service missing');
  const images = [...compose.matchAll(/^\s*image:\s*["']?([^"'\s#]+)/gm)].map((m) => m[1]);
  assert.ok(images.length >= 6);
  const mutable = images.filter((i) => !/@sha256:[0-9a-f]{64}$/.test(i));
  assert.deepEqual(mutable, [], `images must be pinned by digest: ${mutable.join(', ')}`);
  assert.match(svc.db, /image:\s*["']?supabase\/postgres(:17\.6\.1\.136)?@sha256:[0-9a-f]{64}/, 'db = supabase/postgres 17.6.1.136');
  assert.match(compose, /PGRST_DB_SCHEMAS:?[=\s]+["']?api\b/, 'PostgREST exposes only the api schema (04 S3)');
  assert.match(compose, /PGRST_DB_MAX_ROWS/, 'db-max-rows must be set (04 S3)');
  assert.doesNotMatch(compose.replace(/^\s*#.*$/gm, ''), /GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN/, 'access-token hook unused (08 R10)');
  assert.match(svc.auth, /GOTRUE_SMTP_HOST:?[=\s]+["']?mailpit\b/, 'GoTrue SMTP -> mailpit:1025');
  assert.match(svc.auth, /1025/);
  assert.match(compose, /pgbouncer/i);
});

test('REQ-SEC-037 compose.yaml holds no literal secret values (all via ${VAR} from .env.devstack)', () => {
  need();
  const offenders = [];
  for (const l of compose.split(/\r?\n/)) {
    if (/^\s*#/.test(l)) continue;
    const m = /^\s*(?:-\s*)?([A-Z][A-Z0-9_]*)\s*[:=]\s*(.*?)\s*$/.exec(l);
    if (!m || !SECRET_NAME.test(m[1])) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (v && !/^\$\{[A-Z0-9_]+(:?[-?][^}]*)?\}$/.test(v) && !/^\$\{[A-Z0-9_]+\}/.test(v)) offenders.push(`${m[1]}=${v.slice(0, 12)}…`);
  }
  assert.deepEqual(offenders, []);
  assert.match(compose, /\$\{POSTGRES_PASSWORD/);
  assert.match(compose, /\$\{JWT_SECRET/);
});

// ---------- lifecycle scripts ----------
test('AC-0A-6.1 up.ts runs the TRD s3.6 steps in order; down/reset exist; root scripts wired', () => {
  for (const f of ['up.ts', 'down.ts', 'reset.ts']) assert.ok(existsSync(P(`${DS}/${f}`)), `${f} missing`);
  const up = readFileSync(P(`${DS}/up.ts`), 'utf8');
  const steps = ['init-secrets', '--wait', 'bootstrap', 'migrat', 'seeds', 'seedAuthUsers', 'registry-sync'];
  let at = -1;
  for (const s of steps) {
    const i = up.indexOf(s, at + 1);
    assert.ok(i > at, `up.ts: step "${s}" missing or out of order`);
    at = i;
  }
  assert.match(up, /lims_migrator/, 'migrations run as lims_migrator');
  assert.doesNotMatch(up, /0\.0\.0\.0/);
  assert.match(readFileSync(P(`${DS}/down.ts`), 'utf8'), /\bdown\b/);
  assert.match(readFileSync(P(`${DS}/reset.ts`), 'utf8'), /(down[^\n]*(-v|--volumes)|(-v|--volumes)[^\n]*down)/s, 'reset drops volumes');
  const scripts = JSON.parse(readFileSync(P('package.json'), 'utf8')).scripts ?? {};
  for (const [s, f] of [['dev:up', 'up'], ['dev:down', 'down'], ['dev:reset', 'reset']])
    assert.match(scripts[s] ?? '', new RegExp(`tools/devstack/${f}\\.ts`), `root script ${s}`);
});

// ---------- live port scan (opt-in: needs Docker + stack up) ----------
const live = process.env.DEVSTACK_LIVE === '1';
const probe = (host, port) =>
  new Promise((res) => {
    const s = net.connect({ host, port, timeout: 1500 });
    s.once('connect', () => (s.destroy(), res(true)));
    s.once('timeout', () => (s.destroy(), res(false)));
    s.once('error', () => res(false));
  });
test('AC-0A-6.2 LIVE port scan: published ports answer on 127.0.0.1 only, never on external interface addresses', { skip: !live && 'set DEVSTACK_LIVE=1 with `pnpm dev:up` running' }, async () => {
  const ports = [...new Set(Object.values(services()).flatMap(publishedPorts).map((p) => Number(p.split(':')[1])))];
  const externals = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  assert.ok(ports.length > 0);
  for (const p of ports) assert.equal(await probe('127.0.0.1', p), true, `127.0.0.1:${p} should answer`);
  for (const ip of externals) for (const p of ports) assert.equal(await probe(ip, p), false, `${ip}:${p} answers on an external interface`);
});
