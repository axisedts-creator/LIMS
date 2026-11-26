// tools/test-env/live-db.ts and tools/devstack/test-env.ts: which login each LIMS_TEST_* variable gets per module, that a
// hand-set value is kept, and that the CI script puts passwords only into the target file (masked), never on stdout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { applyLiveDbEnv, baseFromEnv, liveDbEnv } from '../../test-env/live-db.ts';

const root = resolve(import.meta.dirname, '..', '..', '..');
const B = { superUrl: 'postgres://super', apiUrl: 'postgres://api', workerUrl: 'postgres://worker' };
const api = (m) => `/repo/services/api/src/modules/${m}/__tests__/x.live.test.ts`;
const job = (m) => `C:\\repo\\services\\worker\\src\\jobs\\${m}\\__tests__\\x.live.test.ts`;

test('the four agreed variables are the same for every file', () => {
  for (const p of [api('lab'), api('billing'), job('micro'), '/repo/services/api/src/core/sync/__tests__/a.test.ts']) {
    const e = liveDbEnv(p, B);
    assert.equal(e.LIMS_TEST_APP_URL, B.apiUrl);
    assert.equal(e.LIMS_TEST_SUPER_URL, B.superUrl);
    assert.equal(e.LIMS_TEST_ADMIN_DATABASE_URL, B.superUrl);
    assert.equal(e.LIMS_TEST_WORKER_URL, B.workerUrl);
  }
});

test('LIMS_TEST_DATABASE_URL: superuser in the modules written that way, lims_api in the others', () => {
  for (const m of ['analytics', 'anatomic', 'billing', 'payments', 'identity']) assert.equal(liveDbEnv(api(m), B).LIMS_TEST_DATABASE_URL, B.superUrl, m);
  for (const m of ['lab', 'inventory', 'quality', 'micro', 'smartreport', 'frontdesk', 'homecollection']) assert.equal(liveDbEnv(api(m), B).LIMS_TEST_DATABASE_URL, B.apiUrl, m);
  for (const m of ['analytics', 'billing', 'frontdesk']) assert.equal(liveDbEnv(job(m), B).LIMS_TEST_DATABASE_URL, B.superUrl, `job ${m}`);
  for (const m of ['inventory', 'micro', 'homecollection']) assert.equal(liveDbEnv(job(m), B).LIMS_TEST_DATABASE_URL, B.apiUrl, `job ${m}`);
  assert.equal(liveDbEnv('/repo/services/api/src/core/pipeline/__tests__/pipeline.integration.test.ts', B).LIMS_TEST_DATABASE_URL, B.apiUrl);
});

test('LIMS_TEST_APP_DATABASE_URL: superuser only where the suite runs SET LOCAL ROLE lims_app', () => {
  for (const m of ['anatomic', 'billing', 'payments']) assert.equal(liveDbEnv(api(m), B).LIMS_TEST_APP_DATABASE_URL, B.superUrl, m);
  for (const m of ['analytics', 'lab']) assert.equal(liveDbEnv(api(m), B).LIMS_TEST_APP_DATABASE_URL, B.apiUrl, m);
  assert.equal(liveDbEnv(job('analytics'), B).LIMS_TEST_APP_DATABASE_URL, B.apiUrl);
});

test('a module name inside another word or folder does not match', () => {
  assert.equal(liveDbEnv('/repo/services/api/src/modules/lab/__tests__/billing/x.test.ts', B).LIMS_TEST_DATABASE_URL, B.apiUrl);
  assert.equal(liveDbEnv('/repo/services/api/src/modules/billingx/__tests__/x.test.ts', B).LIMS_TEST_DATABASE_URL, B.apiUrl);
});

test('nothing is set without all three base URLs; a hand-set value is kept; a value set for an earlier file is replaced', () => {
  assert.equal(baseFromEnv({ LIMS_CI_DB_SUPER_URL: 'a', LIMS_CI_DB_API_URL: 'b' }), undefined);
  const none = { LIMS_CI_DB_SUPER_URL: 'a' };
  assert.deepEqual(applyLiveDbEnv(api('lab'), none), []);
  assert.equal(none.LIMS_TEST_APP_URL, undefined);

  const env = { LIMS_CI_DB_SUPER_URL: B.superUrl, LIMS_CI_DB_API_URL: B.apiUrl, LIMS_CI_DB_WORKER_URL: B.workerUrl, LIMS_TEST_SUPER_URL: 'postgres://mine' };
  applyLiveDbEnv(api('billing'), env);
  assert.equal(env.LIMS_TEST_SUPER_URL, 'postgres://mine');
  assert.equal(env.LIMS_TEST_DATABASE_URL, B.superUrl);
  applyLiveDbEnv(api('lab'), env); // same worker process, next file
  assert.equal(env.LIMS_TEST_DATABASE_URL, B.apiUrl);
  assert.equal(env.LIMS_TEST_SUPER_URL, 'postgres://mine');
});

test('test-env.ts: passwords reach only the target file, are masked first, and bad input fails closed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lims-test-env-'));
  try {
    mkdirSync(join(tmp, 'tools', 'devstack'), { recursive: true });
    cpSync(join(root, 'tools', 'devstack', 'test-env.ts'), join(tmp, 'tools', 'devstack', 'test-env.ts'));
    const script = join(tmp, 'tools', 'devstack', 'test-env.ts');
    const out = join(tmp, 'github-env');
    const pw = { POSTGRES_PASSWORD: 'aa11', LIMS_API_PASSWORD: 'bb22', LIMS_WORKER_PASSWORD: 'cc33' };
    const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

    assert.notEqual(run(['--github-env', out]).status, 0, 'no .env.devstack must fail');
    writeFileSync(join(tmp, 'tools', 'devstack', '.env.devstack'), Object.entries(pw).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    assert.notEqual(run([]).status, 0, 'no target file must fail');

    writeFileSync(out, '');
    const r = run(['--github-env', out]);
    assert.equal(r.status, 0, r.stderr);
    const written = readFileSync(out, 'utf8');
    assert.match(written, /^LIMS_CI_DB_SUPER_URL=postgres:\/\/supabase_admin:aa11@127\.0\.0\.1:5432\/postgres$/m);
    assert.match(written, /^LIMS_CI_DB_API_URL=postgres:\/\/lims_api:bb22@/m);
    assert.match(written, /^LIMS_CI_DB_WORKER_URL=postgres:\/\/lims_worker:cc33@/m);
    const plain = r.stdout.split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n') + r.stderr;
    for (const v of Object.values(pw)) {
      assert.ok(r.stdout.includes(`::add-mask::${v}`), 'each password is masked');
      assert.ok(!plain.includes(v), 'no password outside a mask line');
    }
    assert.ok(!r.stdout.includes('postgres://'), 'no URL on stdout');

    writeFileSync(join(tmp, 'tools', 'devstack', '.env.devstack'), 'POSTGRES_PASSWORD=not hex!\nLIMS_API_PASSWORD=bb22\nLIMS_WORKER_PASSWORD=cc33\n');
    const bad = run(['--github-env', out]);
    assert.notEqual(bad.status, 0);
    assert.ok(!(bad.stdout + bad.stderr).includes('not hex!'), 'a malformed secret is not echoed');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
