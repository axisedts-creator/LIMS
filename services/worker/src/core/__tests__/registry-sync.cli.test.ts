// T0B-ASYNC-3 (LD-281, LD-282; founder runs of 2026-11-16 19:16 and 19:17): `pnpm --filter @lims/worker registry-sync` must work with the
// migrator login alone and with no module variables set.
//   (1) the CLI block connects with a plain pg Client (LIMS_MIGRATOR_DATABASE_URL, else the PG* variables) and calls syncAllManifests;
//       graphile-worker is not used on this path (makeWorkerUtils runs graphile-worker's own migrate step: 42501 on schema graphile_worker).
//   (2) static: registry-sync.ts does not import graphile-worker.   (3) pg declared in the worker package at the lockfile's version.
//   (4) runbook.   (5) no import-time config check (payments, ...) runs at sync time.
// The CLI tests start the real entry in a child process with an EMPTY environment (database variables only) against a tiny fake Postgres
// (wire protocol v3, trust auth) that records every statement it receives: no real database, no secrets, synthetic data only.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fakePostgres, type Fake } from './fake-pg.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../../../api/src/core/module.js';
import { PAYMENTS_ENV_NAMES } from './async-env.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });   // the child loads every jobs module

const WORKER = join(REPO_ROOT, 'services', 'worker');
const SRC = readFileSync(join(WORKER, 'src', 'core', 'registry-sync.ts'), 'utf8');
// code without comments (the comments may name graphile-worker to explain why it is not used)
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// ------------------------------------------------------------------------------------------------------------------ (2) static
describe('(1)(2) the CLI block uses a plain pg Client and no graphile-worker', () => {
  it('registry-sync.ts does not import or call graphile-worker (no import, no makeWorkerUtils, no graphile_worker schema)', () => {
    expect(CODE).not.toMatch(/graphile-worker/);
    expect(CODE).not.toMatch(/makeWorkerUtils|withPgClient|utils\.release|graphile_worker/);
  });
  it('it imports pg and builds a Client; connection string from LIMS_MIGRATOR_DATABASE_URL, else Client() reads PG* (and PGSSLMODE)', () => {
    expect(CODE).toMatch(/from\s+'pg'|import\(\s*'pg'\s*\)|require\(\s*'pg'\s*\)/);
    expect(CODE).toMatch(/new\s+(?:\w+\.)?Client\(/);
    expect(CODE).toMatch(/LIMS_MIGRATOR_DATABASE_URL/);
    expect(CODE).toMatch(/\.connect\(\)/);
    expect(CODE).toMatch(/\.end\(\)/);                                    // the connection is closed (finally), or the process would hang
    expect(CODE).toMatch(/syncAllManifests\(/);
    expect(CODE).not.toMatch(/postgres(ql)?:\/\/[^\s'"`]+:[^\s'"`@]+@/i);   // no URL with a password
    expect(CODE).not.toMatch(/\bssl\s*:\s*\{[^}]*rejectUnauthorized\s*:\s*false/);   // TLS settings come from PGSSLMODE, never weakened here
  });
  it('the CLI still runs only as the entry point and reports failure with a non-zero exit', () => {
    expect(CODE).toMatch(/process\.argv\[1\]/);
    expect(CODE).toMatch(/pathToFileURL\(process\.argv\[1\]\)/);
    expect(CODE).toMatch(/process\.exitCode\s*=\s*1/);
  });
  it('syncRegistry and syncAllManifests keep their signatures and the unchanged transaction (SET LOCAL ROLE lims_owner, lock, upsert, deactivate)', () => {
    expect(CODE).toMatch(/export\s+async\s+function\s+syncRegistry\(client:\s*SyncClient,\s*entries:\s*readonly\s+RegistryEntry\[\]\)/);
    expect(CODE).toMatch(/export\s+async\s+function\s+syncAllManifests\(client:\s*SyncClient\)/);
    expect(CODE).toMatch(/SET LOCAL ROLE lims_owner/);
    expect(CODE).toMatch(/LOCK TABLE core\.g_task_registry IN SHARE ROW EXCLUSIVE MODE/);
  });
});

describe('(3) pg is declared in the worker package at the version already in pnpm-lock.yaml', () => {
  const pkg = JSON.parse(readFileSync(join(WORKER, 'package.json'), 'utf8'));
  const lock = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n');
  it('services/worker/package.json lists pg, pinned (no range) to the lockfile version', () => {
    const wanted = lock.match(/^  pg@(\d+\.\d+\.\d+):/m)?.[1];
    expect(wanted).toBeTruthy();
    expect(pkg.dependencies.pg).toBe(wanted);
    expect(pkg.dependencies.pg).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('the lockfile importer block of services/worker lists pg at the same specifier and version; graphile-worker is still there (other worker code uses it)', () => {
    const block = lock.split(/^ {2}services\/worker:\n/m)[1]?.split(/^ {2}\S.*:\n/m)[0] ?? '';
    expect(block).toMatch(/\n {6}pg:\n {8}specifier: (\d+\.\d+\.\d+)\n {8}version: \1\n/);
    expect(block).toMatch(/graphile-worker:/);
  });
  it('the scripts are unchanged', () => {
    expect(pkg.scripts['registry-sync']).toBe('node --import ../../tools/node-ts/register.mjs src/core/registry-sync.ts');
    expect(pkg.scripts.start).toBe('node --import ../../tools/node-ts/register.mjs src/main.ts');
    expect(pkg.dependencies['graphile-worker']).toBe('0.18.0');
  });
});

// ------------------------------------------------------------------------------------------------------------------ (4) runbook
describe('(4) docs/runbooks/staging-worker.md', () => {
  const t = readFileSync(join(REPO_ROOT, 'docs', 'runbooks', 'staging-worker.md'), 'utf8');
  const step1 = t.split(/^## 2\./m)[0]!;
  it('step 1 says the migrator login needs no graphile_worker rights for registry-sync', () => {
    expect(step1).toMatch(/graphile_worker/);
    expect(step1).toMatch(/no\s+(?:USAGE\s+|access\s+|rights?\s+|grants?\s+|privileges?\s+)?(?:on|to)?[^.\n]{0,60}graphile_worker|graphile_worker[^.\n]{0,80}(?:not needed|no (?:rights|grant|access|privilege)|none)|without[^.\n]{0,60}graphile_worker/i);
    expect(step1).toMatch(/lims_migrator|migrator login/);
  });
  it('step 1 says the payments, mail, SMS and storage variables are not needed for registry-sync, and the database variables it reads', () => {
    expect(step1).toMatch(/LIMS_MIGRATOR_DATABASE_URL/);
    expect(step1).toMatch(/PGSSLMODE|PG\*|PGHOST/);
    expect(step1).toMatch(/(?:no|not|none|without)[^.\n]{0,100}(?:payments|LIMS_PAYMENTS)|(?:payments|LIMS_PAYMENTS)[^.\n]{0,100}(?:not (?:needed|required)|no need)/i);
  });
  it('gives the cloud PowerShell line the lead uses: variable names only, no value', () => {
    expect(t).toMatch(/\$env:LIMS_MIGRATOR_DATABASE_URL/);
    expect(t).toMatch(/registry-sync-cloud\.ps1|\$env:LIMS_MIGRATOR_DATABASE_URL[\s\S]{0,300}pnpm --filter @lims\/worker registry-sync/);
    expect(t).not.toMatch(/\$env:[A-Z_]+\s*=\s*['"]?(?:postgres|https?:|[A-Za-z0-9+/_-]{20,})/);
    expect(t).not.toMatch(/postgres(ql)?:\/\/[^\s:@/]+:[^\s@]+@/i);
  });
});

let open: Fake | undefined;
afterEach(async () => { await open?.close(); open = undefined; });

// A minimal environment: only what node needs to start (PATH, SystemRoot) plus the database variables. No LIMS_* module variable at all.
function run(dbEnv: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = { ...dbEnv };
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k]!;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(REPO_ROOT, 'tools', 'node-ts', 'register.mjs')).href, 'src/core/registry-sync.ts'], { cwd: WORKER, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`registry-sync did not finish in 150 s\nstdout: ${stdout}\nstderr: ${stderr}`)); }, 150_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const explain = (r: { code: number | null; stdout: string; stderr: string }, f: Fake) => `exit ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr.slice(-1500)}\nstatements: ${JSON.stringify(f.statements)}`;

// ------------------------------------------------------------------------------------------------------------------ (1)(5) the real CLI
describe('(1)(5) the CLI as the founder runs it: migrator login only, empty environment, no module variables', () => {
  it('LIMS_MIGRATOR_DATABASE_URL: exit 0, prints the counts, one transaction as lims_owner, and no graphile_worker statement is ever sent', async () => {
    open = await fakePostgres();
    const r = await run({ LIMS_MIGRATOR_DATABASE_URL: `postgres://lims_migrator@127.0.0.1:${open.port}/lims_fake` });
    expect(r.code, explain(r, open)).toBe(0);
    expect(r.stdout).toMatch(/^registry-sync upserted [1-9]\d* deactivated 0\s*$/m);
    const s = open.statements;
    expect(s.some((x) => /graphile_worker/i.test(x)), `graphile-worker's own migrate step ran: ${JSON.stringify(s.filter((x) => /graphile/i.test(x)))}`).toBe(false);
    expect(s[0]).toMatch(/^BEGIN/i);
    const role = s.findIndex((x) => /^SET LOCAL ROLE lims_owner/i.test(x));
    const insert = s.findIndex((x) => /^INSERT INTO core\.g_task_registry/i.test(x));
    expect(role).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(role);
    expect(s.at(-1)).toMatch(/^COMMIT/i);
    expect(s.filter((x) => /^BEGIN/i.test(x)).length).toBe(1);
  });

  it('no payments, mail, SMS or storage variable is set and the sync still succeeds (no import-time config check runs: payments, or any other module)', async () => {
    open = await fakePostgres();
    const r = await run({ LIMS_MIGRATOR_DATABASE_URL: `postgres://lims_migrator@127.0.0.1:${open.port}/lims_fake` });
    for (const name of PAYMENTS_ENV_NAMES) expect(r.stderr, name).not.toContain(name);
    expect(r.stderr).not.toMatch(/is required|config(uration)? (error|invalid)|must be set/i);
    expect(r.code, explain(r, open)).toBe(0);
  });

  it('LIMS_MIGRATOR_DATABASE_URL unset: the PG* variables are used', async () => {
    open = await fakePostgres();
    const r = await run({ PGHOST: '127.0.0.1', PGPORT: String(open.port), PGUSER: 'lims_migrator', PGDATABASE: 'lims_fake' });
    expect(r.code, explain(r, open)).toBe(0);
    expect(r.stdout).toMatch(/registry-sync upserted [1-9]\d* deactivated 0/);
    expect(open.statements.some((x) => /graphile_worker/i.test(x))).toBe(false);
  });

  it('a database error (42501 on the registry write) rolls back, prints "registry-sync failed: 42501 ..." to stderr and exits 1; nothing is committed', async () => {
    open = await fakePostgres(/INSERT INTO core\.g_task_registry/i);
    const r = await run({ LIMS_MIGRATOR_DATABASE_URL: `postgres://lims_migrator@127.0.0.1:${open.port}/lims_fake` });
    expect(r.code, explain(r, open)).toBe(1);
    expect(r.stderr).toMatch(/registry-sync failed: 42501 /);
    expect(open.statements.some((x) => /^ROLLBACK/i.test(x))).toBe(true);
    expect(open.statements.some((x) => /^COMMIT/i.test(x))).toBe(false);
    expect(r.stdout).not.toMatch(/registry-sync upserted/);
  });

  it('an unreachable database exits 1 with "registry-sync failed:" and no stack trace of an unhandled rejection', async () => {
    const dead = await fakePostgres();
    const port = dead.port;
    await dead.close();                                                      // nothing listens on this port now
    const r = await run({ LIMS_MIGRATOR_DATABASE_URL: `postgres://lims_migrator@127.0.0.1:${port}/lims_fake` });
    expect(r.code, `exit ${r.code}\nstderr: ${r.stderr.slice(-1500)}`).toBe(1);
    expect(r.stderr).toMatch(/registry-sync failed:/);
    expect(r.stderr).not.toMatch(/unhandled|at process\.processTicksAndRejections/i);
    expect(r.stdout).not.toMatch(/registry-sync upserted/);
  });
});
