// tools/devstack/test-env.ts — after `pnpm dev:up --ci`: hands the dev stack's three database logins to the test jobs.
// Usage (CI): node tools/devstack/test-env.ts --github-env "$GITHUB_ENV"
// Writes LIMS_CI_DB_SUPER_URL / LIMS_CI_DB_API_URL / LIMS_CI_DB_WORKER_URL into the file GitHub Actions reads for later
// steps. tools/test-env/live-db.ts turns them into the LIMS_TEST_* variables each suite expects.
// Secrets: passwords are read from tools/devstack/.env.devstack (written by init-secrets.ts), go only into that file, and
// each one is registered with ::add-mask:: first so a later step that echoes a URL shows *** instead. Nothing else is printed.
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
for (const [, , pw] of logins) console.log(`::add-mask::${pw}`);
appendFileSync(out, logins.map(([k, user, pw]) => `${k}=${url(user, pw)}\n`).join(''));
console.log(`test-env: wrote ${logins.map(([k]) => k).join(', ')}`);
