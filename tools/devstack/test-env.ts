// tools/devstack/test-env.ts — after `pnpm dev:up --ci`: hands the dev stack's three database logins to the test jobs.
// Usage (CI): node tools/devstack/test-env.ts --github-env "$GITHUB_ENV" [--create-app-login]
//   --create-app-login also creates the test-only login lims_ci_app in the dev stack database and writes LIMS_CI_DB_APPROLE_URL:
//   NOSUPERUSER, NOBYPASSRLS, member of lims_app WITH INHERIT TRUE, SET TRUE. Some suites need a login that is lims_app on
//   connect and may also SET ROLE lims_app; no production login is allowed both (00_roles.sql gives lims_api SET FALSE on
//   purpose). The role exists only in a CI dev stack: nothing in db/bootstrap, db/migrations or infra creates it.
// Writes LIMS_CI_DB_SUPER_URL / LIMS_CI_DB_API_URL / LIMS_CI_DB_WORKER_URL into the file GitHub Actions reads for later
// steps. tools/test-env/live-db.ts turns them into the LIMS_TEST_* variables each suite expects.
// Secrets: passwords are read from tools/devstack/.env.devstack (written by init-secrets.ts), go only into that file, and
// each one is registered with ::add-mask:: first so a later step that echoes a URL shows *** instead. Nothing else is printed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const i = process.argv.indexOf('--github-env');
const out = i > 0 ? process.argv[i + 1] : undefined;
if (!out) { console.error('test-env: need --github-env <file>'); process.exit(2); }

let text: string;
try { text = readFileSync(join(HERE, '.env.devstack'), 'utf8'); } catch { console.error('test-env: tools/devstack/.env.devstack missing; run pnpm dev:up first'); process.exit(2); }
const env = Object.fromEntries(text.split(/\r?\n/).flatMap((l) => { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l); return m ? [[m[1], m[2]]] : []; }));

const need = (k: string): string => {
  const v = env[k];
  if (!v || !/^[0-9a-f]+$/.test(v)) { console.error(`test-env: ${k} missing or not in the hex form init-secrets writes`); process.exit(2); }
  return v;
};
const url = (user: string, pw: string) => `postgres://${user}:${pw}@127.0.0.1:5432/postgres`; // same host, port and database as up.ts pgEnv
const logins: [string, string, string][] = [
  ['LIMS_CI_DB_SUPER_URL', 'supabase_admin', need('POSTGRES_PASSWORD')],
  ['LIMS_CI_DB_API_URL', 'lims_api', need('LIMS_API_PASSWORD')],
  ['LIMS_CI_DB_WORKER_URL', 'lims_worker', need('LIMS_WORKER_PASSWORD')],
];
if (process.argv.includes('--create-app-login')) {
  const pw = randomBytes(24).toString('hex'); // hex only: safe inside the SQL literal below
  console.log(`::add-mask::${pw}`);
  const sql = [
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lims_ci_app') THEN",
    '  CREATE ROLE lims_ci_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;',
    `ALTER ROLE lims_ci_app PASSWORD '${pw}';`,
    'GRANT lims_app TO lims_ci_app WITH INHERIT TRUE, SET TRUE;',
    'GRANT CONNECT ON DATABASE postgres TO lims_ci_app;',
  ].join(' ');
  // SQL goes in on stdin, so the password is in no argument list; psql inside the db container, as up.ts does
  const r = spawnSync('docker', ['compose', '-f', join(HERE, 'compose.yaml'), '--env-file', join(HERE, '.env.devstack'), 'exec', '-T', 'db',
    'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
  if (r.status !== 0) { console.error(`test-env: could not create lims_ci_app (psql exit ${r.status})`); process.exit(1); } // stderr not echoed: it could quote the statement
  logins.push(['LIMS_CI_DB_APPROLE_URL', 'lims_ci_app', pw]);
}
for (const [, , pw] of logins) console.log(`::add-mask::${pw}`);
appendFileSync(out, logins.map(([k, user, pw]) => `${k}=${url(user, pw)}\n`).join(''));
console.log(`test-env: wrote ${logins.map(([k]) => k).join(', ')}`);
