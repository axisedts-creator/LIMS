// tools/devstack/up.ts — `pnpm dev:up [--ci]`. C0 02-TRD §3.6 order:
//   init-secrets (if absent) → docker compose up -d --wait → db/bootstrap (image superuser, dev only)
//   → migrations (as lims_migrator) → db/seeds → seedAuthUsers → task-registry sync → print URLs.
// Fails closed: any failing step stops the run. Secrets go to child processes via env/stdin, never argv or stdout.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..', '..');
const ENV_FILE = join(HERE, '.env.devstack');
const COMPOSE = ['compose', '-f', join(HERE, 'compose.yaml'), '--env-file', ENV_FILE];
const DB = 'postgres'; // SP-3: LIMS uses the image's init database

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ['pipe', opts.stdio === 'pipe' ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    console.error(`dev:up: step failed: ${cmd} ${args.filter((a) => !a.includes(ENV_FILE)).slice(0, 4).join(' ')} …`);
    process.exit(r.status || 1);
  }
  return String(r.stdout ?? '');
}
const step = (s: string) => console.log(`\n== dev:up: ${s}`);
const env = (): Record<string, string> =>
  Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).flatMap((l) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    return m ? [[m[1], m[2]]] : [];
  }));
// psql inside the db container; PGPASSWORD for supabase_admin is the container's own env (never on the host argv).
const psqlAdmin = (args: string[], input?: string) =>
  run('docker', [...COMPOSE, 'exec', '-T', 'db', 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', DB, '-v', 'ON_ERROR_STOP=1', ...args],
    input === undefined ? { stdio: 'pipe' } : { input });
const q = (v: string) => {
  if (!/^[0-9a-f]+$/.test(v)) throw new Error('unexpected secret format (init-secrets writes hex)');
  return `'${v}'`;
};

// 1. init-secrets (writes only if absent), then fail closed on published .env.example values (REQ-SEC-037)
step('init-secrets');
run(process.execPath, [join(HERE, 'init-secrets.ts')]);
run(process.execPath, [join(HERE, 'init-secrets.ts'), '--check', ENV_FILE]);
const E = env();

// 2. stack up, healthy
step('docker compose up -d --wait');
run('docker', [...COMPOSE, 'up', '-d', '--wait']);

// 3. db/bootstrap as the image superuser (dev only); once per db volume
step('db/bootstrap');
if (psqlAdmin(['-tAc', "SELECT 1 FROM pg_roles WHERE rolname = 'lims_migrator'"]).trim() === '1') {
  console.log('already bootstrapped');
} else {
  const vars = {
    lims_migrator_pw: E.LIMS_MIGRATOR_PASSWORD, lims_api_pw: E.LIMS_API_PASSWORD, lims_worker_pw: E.LIMS_WORKER_PASSWORD,
    lims_monitor_pw: E.LIMS_MONITOR_PASSWORD, lims_replicator_pw: E.LIMS_REPLICATOR_PASSWORD, lims_audit_ship_pw: E.LIMS_AUDIT_SHIP_PASSWORD,
  };
  const sql = [
    ...Object.entries(vars).map(([k, v]) => `\\set ${k} ${q(v)}`),
    `\\set dbname ${DB}`,
    readFileSync(join(ROOT, 'db/bootstrap/00_roles.sql'), 'utf8'),
    readFileSync(join(ROOT, 'db/bootstrap/01_database.sql'), 'utf8'),
    // [CONV] dev glue until db/bootstrap carries it: SP-3 service roles keep CONNECT after REVOKE ... FROM PUBLIC;
    // SP-5 runner contract (Atlas revisions schema).
    `GRANT CONNECT ON DATABASE ${DB} TO supabase_auth_admin, supabase_storage_admin, authenticator;`,
    'CREATE SCHEMA migrations_meta AUTHORIZATION lims_migrator;',
    'GRANT USAGE ON SCHEMA migrations_meta TO lims_owner;',
    'ALTER DEFAULT PRIVILEGES FOR ROLE lims_migrator IN SCHEMA migrations_meta GRANT SELECT, INSERT, UPDATE ON TABLES TO lims_owner;',
  ].join('\n');
  psqlAdmin(['-1', '-q', '-f', '-'], sql);
}

// 4. migrations as lims_migrator (Atlas, SP-5 runner contract; compose service `migrate`)
step('migrations (lims_migrator)');
run('docker', [...COMPOSE, '--profile', 'tools', 'run', '--rm', 'migrate']);

// 5. db/seeds — each file in one transaction as lims_migrator (files do SET LOCAL ROLE lims_owner)
step('db/seeds');
for (const f of readdirSync(join(ROOT, 'db/seeds')).filter((f) => f.endsWith('.sql')).sort()) {
  console.log(f);
  run('docker', [...COMPOSE, 'exec', '-T', '-e', 'PGPASSWORD', 'db', 'psql', '-h', 'localhost', '-U', 'lims_migrator', '-d', DB,
    '-v', 'ON_ERROR_STOP=1', '-1', '-q', '-f', '-'],
  { input: readFileSync(join(ROOT, 'db/seeds', f), 'utf8'), env: { ...process.env, PGPASSWORD: E.LIMS_MIGRATOR_PASSWORD } });
}

// libpq-standard connection env for the TS steps below (no password on argv)
const pgEnv = (user: string, pw: string) => ({ ...process.env, PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: DB, PGUSER: user, PGPASSWORD: pw });

// 6. seedAuthUsers (packages/test-fixtures gotrue export, 02-TRD §3.5; lands with its own task)
step('seedAuthUsers');
const seedMod = ['packages/test-fixtures/src/gotrue/index.ts', 'packages/test-fixtures/gotrue/index.ts'].map((p) => join(ROOT, p)).find(existsSync);
if (seedMod) {
  const { seedAuthUsers } = await import(pathToFileURL(seedMod).href);
  await seedAuthUsers({ ...E, LIMS_CORE_ENV: 'development', GOTRUE_URL: 'http://127.0.0.1:8000/auth/v1' });
} else console.log('skipped: seedAuthUsers module not present yet');

// 7. task-registry sync as lims_migrator (02-TRD worker core registry-sync.ts)
step('registry-sync');
const sync = join(ROOT, 'services/worker/src/core/registry-sync.ts');
if (existsSync(sync)) run(process.execPath, [sync], { env: pgEnv('lims_migrator', E.LIMS_MIGRATOR_PASSWORD) });
else console.log('skipped: services/worker/src/core/registry-sync.ts not present yet');

// 8. URLs (all loopback, 04 S6)
step('ready');
console.log([
  'API gateway  http://127.0.0.1:8000  (/auth/v1 /rest/v1 /storage/v1)',
  'Postgres     127.0.0.1:5432  (direct)   PgBouncer 127.0.0.1:6432 (lims_api)',
  'Mailpit      http://127.0.0.1:8025',
  'Studio       http://127.0.0.1:3000  (only with --profile studio)',
  `Secrets      ${ENV_FILE}`,
].join('\n'));
