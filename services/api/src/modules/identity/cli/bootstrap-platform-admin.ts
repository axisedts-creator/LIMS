// One-shot bootstrap of the first platform superadmin (03-APP-FLOW §9.4; 05-SCHEMA §6; 07-SECURITY REQ-SEC-063).
// Runbook: `pnpm --filter @lims/api identity:bootstrap-platform-admin --email <ops email> [--display-name <name>]`.
// Creates (or reuses) the GoTrue user, then makes ONE call to the DEFINER, which inserts the staff row and the bootstrap event only
// when no active superadmin exists (else P0001 'bootstrap_closed'). No password is set here: the operator uses forgot-password
// and enrols TOTP on first login. Importing this file runs nothing.
import { pathToFileURL } from 'node:url';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';

export interface BootstrapDeps {
  gotrue: Pick<GoTrueGateway, 'adminCreateUser'>;
  db: { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
  newId: () => string;
}
interface Io { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown } }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_NAME = 'Platform Administrator';
const USAGE = 'usage: identity:bootstrap-platform-admin --email <ops email> [--display-name <name, 1-120 chars>]\n';

class UsageError extends Error {}

function parseArgs(argv: string[]): { email: string; displayName?: string } {
  const seen: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const m = /^(--email|--display-name)(?:=(.*))?$/s.exec(a);
    if (!m) throw new UsageError();
    const value = m[2] ?? argv[++i];
    if (value === undefined || m[1]! in seen) throw new UsageError();
    seen[m[1]!] = value;
  }
  const email = (seen['--email'] ?? '').trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) throw new UsageError();
  const name = seen['--display-name'];
  if (name !== undefined && (name.trim() === '' || [...name].length > 120)) throw new UsageError();
  return name === undefined ? { email } : { email, displayName: name };
}

export async function bootstrapPlatformAdmin(input: { email: string; displayName?: string }, deps: BootstrapDeps): Promise<{ staffId: string; userId: string }> {
  const email = input.email.trim().toLowerCase();
  const user = await deps.gotrue.adminCreateUser({ email, emailConfirm: true });   // an existing user is reused (re-run after a partial failure)
  const staffId = deps.newId(); const eventId = deps.newId();
  await deps.db.query('SELECT app.identity_bootstrap_platform_admin($1, $2, $3, $4, $5)', [staffId, user.userId, email, input.displayName ?? DEFAULT_NAME, eventId]);
  return { staffId, userId: user.userId };
}

/** Exit codes: 0 ok, 1 failure (incl. bootstrap_closed), 2 usage. Errors print one line, never a stack or an object dump. */
export async function main(argv: string[], deps: BootstrapDeps & Io): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(argv); } catch { deps.stderr.write(USAGE); return 2; }
  try {
    const r = await bootstrapPlatformAdmin(args, deps);
    deps.stdout.write(`platform superadmin created: platform_staff_id=${r.staffId}\n`
      + 'next: open the staff login, use "forgot password" to set a password, then enrol TOTP (MFA) at first login.\n');
    return 0;
  } catch (e) {
    const closed = (e as { message?: unknown })?.message === 'bootstrap_closed';
    const msg = closed ? 'bootstrap_closed: an active platform superadmin already exists; invite further staff from the platform console'
      : `bootstrap failed: ${String((e as { message?: unknown })?.message ?? 'unknown error').split('\n')[0]!.slice(0, 200)}`;
    deps.stderr.write(`${msg}\n`);
    return 1;
  }
}

// Entry point only when executed directly. DB connection from the standard libpq PG* environment of the operator's shell.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { gotrueGatewayFromEnv } = await import('../gotrue/gateway.http.js');
  const pg = (await import('pg' as string)).default as { Client: new () => { connect(): Promise<void>; end(): Promise<void>; query: BootstrapDeps['db']['query'] } };
  const client = new pg.Client();
  await client.connect();
  try {
    const gotrue = gotrueGatewayFromEnv();
    process.exitCode = await main(process.argv.slice(2), { gotrue, db: client, newId: uuidv7, stdout: process.stdout, stderr: process.stderr });
  } finally { await client.end(); }
}
