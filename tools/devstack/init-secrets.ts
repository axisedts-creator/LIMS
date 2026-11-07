// tools/devstack/init-secrets.ts — C0 02-TRD §3.6, REQ-SEC-037, REQ-SEC-128, AC-0A-6.3.
//   node tools/devstack/init-secrets.ts [--out <file>] [--example <file>]   write fresh secrets (existing --out left untouched)
//   node tools/devstack/init-secrets.ts --check <env file> [--example <file>] exit 0 ok · 1 secret missing/empty/published · 2 usage/IO
// Defaults: --out tools/devstack/.env.devstack (gitignored) · --example tools/devstack/upstream.env.example (pinned Supabase copy).
// Never prints a secret value; messages name keys only.
import { randomBytes, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const HERE = import.meta.dirname;
// Secret-looking key names (the REQ-SEC-037 list: JWT secret/keys, Postgres password, dashboard credentials, SMTP, enc keys).
const SECRET_NAME = /(PASSWORD|_PASS$|SECRET|(^|_)KEY(_|$)|TOKEN)/;
// LIMS login roles of db/bootstrap/00_roles.sql (02-TRD §3.6 names lims_api/lims_worker/lims_migrator; the rest are needed by the same file).
export const LIMS_PASSWORDS = [
  'LIMS_API_PASSWORD', 'LIMS_WORKER_PASSWORD', 'LIMS_MIGRATOR_PASSWORD',
  'LIMS_MONITOR_PASSWORD', 'LIMS_REPLICATOR_PASSWORD', 'LIMS_AUDIT_SHIP_PASSWORD',
];

type Env = Map<string, string>;

function parseEnv(text: string): Env {
  const out: Env = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out.set(m[1], m[2].replace(/^(["'])(.*)\1$/, '$2'));
  }
  return out;
}

const exampleSecrets = (ex: Env) => [...ex].filter(([k, v]) => v !== '' && SECRET_NAME.test(k));

// Hex: URL-safe, so values can sit inside postgres:// URLs in compose.yaml. VAULT_ENC_KEY is a 32-char key upstream.
const fresh = (key: string) => randomBytes(key === 'VAULT_ENC_KEY' ? 16 : 32).toString('hex');

function jwtClaims(v: string): Record<string, unknown> | null {
  const parts = v.split('.');
  if (parts.length !== 3) return null;
  try {
    const h = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return h?.alg === 'HS256' && p && typeof p.role === 'string' ? p : null;
  } catch {
    return null;
  }
}

function signHS256(claims: Record<string, unknown>, secret: string): string {
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** Problems with `env` against the published example: missing/empty secrets and any value equal to a published secret value. */
export function problems(env: Env, ex: Env): string[] {
  const out: string[] = [];
  const published = new Set(exampleSecrets(ex).map(([, v]) => v));
  for (const k of [...exampleSecrets(ex).map(([k]) => k), ...LIMS_PASSWORDS])
    if (!env.get(k)) out.push(`${k}: missing or empty`);
  for (const [k, v] of env) if (v && published.has(v)) out.push(`${k}: equals a published .env.example value`);
  return out;
}

export function generate(ex: Env): Env {
  const env: Env = new Map();
  for (const [k, v] of ex) env.set(k, v !== '' && SECRET_NAME.test(k) ? fresh(k) : v);
  for (const k of LIMS_PASSWORDS) env.set(k, fresh(k));
  // Re-sign JWT-shaped keys (ANON_KEY, SERVICE_ROLE_KEY, ...) with the new JWT_SECRET; keep their role.
  const secret = env.get('JWT_SECRET');
  if (secret) {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of ex) {
      const c = jwtClaims(v);
      if (c) env.set(k, signHS256({ ...c, iat: now, exp: now + 5 * 365 * 24 * 3600 }, secret));
    }
  }
  return env;
}

function main(argv: string[]): number {
  let a;
  try {
    a = parseArgs({ args: argv, options: { out: { type: 'string' }, example: { type: 'string' }, check: { type: 'string' } }, strict: true }).values;
  } catch (e) {
    console.error(`init-secrets: ${(e as Error).message}`);
    return 2;
  }
  if (a.check !== undefined && a.out !== undefined) return console.error('init-secrets: --check and --out are exclusive'), 2;
  const examplePath = a.example ?? join(HERE, 'upstream.env.example');
  let ex: Env;
  try {
    ex = parseEnv(readFileSync(examplePath, 'utf8'));
  } catch {
    console.error(`init-secrets: cannot read example file ${examplePath}`);
    return 2;
  }
  if (exampleSecrets(ex).length === 0) return console.error(`init-secrets: ${examplePath} lists no secrets`), 2;

  if (a.check !== undefined) {
    let env: Env;
    try {
      env = parseEnv(readFileSync(a.check, 'utf8'));
    } catch {
      console.error(`init-secrets: cannot read ${a.check}`);
      return 2;
    }
    const p = problems(env, ex);
    for (const m of p) console.error(`init-secrets --check: ${m}`);
    return p.length ? 1 : 0;
  }

  const out = a.out ?? join(HERE, '.env.devstack');
  if (existsSync(out)) {
    console.log(`init-secrets: ${out} exists, left untouched`);
    return 0;
  }
  const env = generate(ex);
  const p = problems(env, ex);
  if (p.length) return p.forEach((m) => console.error(`init-secrets: ${m}`)), 1; // REQ-SEC-037: abort, write nothing
  const text = '# GENERATED by tools/devstack/init-secrets.ts — dev only, never commit (REQ-SEC-128)\n' +
    [...env].map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  try {
    writeFileSync(out, text, { flag: 'wx', mode: 0o600 }); // wx: never overwrite, even if created concurrently
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return console.log(`init-secrets: ${out} exists, left untouched`), 0;
    console.error(`init-secrets: cannot write ${out}`);
    return 2;
  }
  console.log(`init-secrets: wrote ${env.size} keys to ${out}`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
