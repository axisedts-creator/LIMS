// T25 bootstrap CLI (03-APP-FLOW s9.4, F19; 05-SCHEMA s6 app.identity_bootstrap_platform_admin, s11 tests 11 + 25; 07-SECURITY REQ-SEC-063).
// ASSUMED API of ../bootstrap-platform-admin.ts (pure of process/env; importing it must NOT run anything or call process.exit):
//   export interface BootstrapDeps { gotrue: Pick<GoTrueGateway,'adminCreateUser'>; db: { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }; newId: () => string }
//   export async function bootstrapPlatformAdmin(input: { email: string; displayName?: string }, deps: BootstrapDeps): Promise<{ staffId: string; userId: string }>
//   export async function main(argv: string[], deps: BootstrapDeps & { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown } }): Promise<number>   // exit code
// argv = what follows the script name: `--email <ops email>` (or `--email=<x>`), optional `--display-name <name>`. Flow: normalise email -> gotrue.adminCreateUser (an existing
// user is reused, so a re-run after a partial failure works) -> ONE `SELECT app.identity_bootstrap_platform_admin($1,$2,$3,$4,$5)` with UUIDv7 staff + event ids from deps.newId.
// The "only when zero active superadmins" gate lives in the DEFINER (P0001 'bootstrap_closed'); the CLI has no SQL of its own and sets no password (the user uses forgot-password).
// Exit codes: 0 ok - 1 failure (incl. bootstrap_closed, GoTrue/DB error) - 2 usage. The real DEFINER (closed gate, no-claims success, no audit row) is db/tests/identity/T0B-06 tests 11 + 25.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { bootstrapPlatformAdmin, main } from '../bootstrap-platform-admin.js';

const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fake pair: gotrue + a db whose only accepted statement is the DEFINER call, emulating its gate (advisory lock = serialised, active superadmin -> P0001 bootstrap_closed). */
function world(o: { existingUser?: boolean; gotrueError?: Error; dbError?: Error; activeSuperadmin?: boolean } = {}) {
  const staff: Array<{ id: string; user_id: string; email: string; display_name: string; role: string }> = o.activeSuperadmin ? [{ id: idN(1), user_id: idN(2), email: 'old@example.test', display_name: 'Old', role: 'platform_superadmin' }] : [];
  const events: Array<{ id: string; type: string; target: string }> = [];
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let lock: Promise<unknown> = Promise.resolve(); let userSeq = 0x300; let ids = 0x100;
  const created: Array<{ email: string; emailConfirm: boolean }> = [];
  const gotrue = { adminCreateUser: vi.fn(async (i: { email: string; emailConfirm: boolean }) => {
    if (o.gotrueError) throw o.gotrueError;
    if (o.existingUser) return { exists: true as const, userId: idN(0x2ff) };
    created.push(i); return { userId: idN(userSeq++) };
  }) };
  const db = { async query(text: string, values: unknown[] = []) {
    statements.push({ text, values });
    if (!/app\.identity_bootstrap_platform_admin\s*\(/i.test(text) || /\bINSERT\b/i.test(text)) throw new Error(`unexpected SQL: ${text}`);
    const run = lock.then(async () => {
      if (o.dbError) throw o.dbError;
      await new Promise((r) => setTimeout(r, 5));                                                        // widen the race window
      if (staff.some((s) => s.role === 'platform_superadmin')) throw Object.assign(new Error('bootstrap_closed'), { code: 'P0001' });
      const [staffId, userId, email, displayName, eventId] = values as string[];
      staff.push({ id: staffId!, user_id: userId!, email: email!.trim().toLowerCase(), display_name: displayName!, role: 'platform_superadmin' });
      events.push({ id: eventId!, type: 'bootstrap_admin_created', target: staffId! });
      return { rows: [{}] };
    });
    lock = run.catch(() => undefined); return run;
  } };
  const out: string[] = []; const err: string[] = [];
  const deps = { gotrue: gotrue as never, db, newId: () => idN(ids++), stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } };
  return { deps, staff, events, statements, gotrue, created, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('bootstrapPlatformAdmin: first run', () => {
  it('creates the GoTrue user, then ONE DEFINER call with (staff id, user id, email, display name, event id): UUIDv7s from deps.newId, staff id != event id', async () => {
    const w = world();
    const r = await bootstrapPlatformAdmin({ email: 'Ops@Example.test', displayName: 'Ops Lead' }, w.deps);
    expect(w.gotrue.adminCreateUser).toHaveBeenCalledTimes(1); expect(w.created[0]!.email).toBe('ops@example.test');
    expect(w.statements).toHaveLength(1);
    const [staffId, userId, email, displayName, eventId] = w.statements[0]!.values as string[];
    expect([staffId, userId, eventId].every((x) => UUID.test(x!))).toBe(true); expect(staffId).not.toBe(eventId);
    expect(userId).toBe(idN(0x300)); expect(email!.trim().toLowerCase()).toBe('ops@example.test'); expect(displayName).toBe('Ops Lead');
    expect(r).toEqual({ staffId, userId });
    expect(w.staff).toEqual([expect.objectContaining({ id: staffId, user_id: userId, role: 'platform_superadmin' })]);
    expect(w.events).toEqual([{ id: eventId, type: 'bootstrap_admin_created', target: staffId }]);
  });
  it('display name defaults to a non-empty value of at most 120 characters (platform_staff__display_name__ck)', async () => {
    const w = world(); await bootstrapPlatformAdmin({ email: 'ops@example.test' }, w.deps);
    const dn = w.statements[0]!.values[3] as string; expect(dn.length).toBeGreaterThanOrEqual(1); expect(dn.length).toBeLessThanOrEqual(120);
  });
  it('an email GoTrue already knows (re-run after a partial failure) reuses that user id', async () => {
    const w = world({ existingUser: true }); const r = await bootstrapPlatformAdmin({ email: 'ops@example.test' }, w.deps);
    expect(r.userId).toBe(idN(0x2ff)); expect(w.statements[0]!.values[1]).toBe(idN(0x2ff));
  });
});

describe('bootstrap is CLOSED once an active superadmin exists (done_when; 05-SCHEMA s11 test 11)', () => {
  it('a second run is refused with bootstrap_closed: no new staff row, no second event, nothing but the DEFINER call attempted', async () => {
    const w = world();
    await bootstrapPlatformAdmin({ email: 'first@example.test' }, w.deps);
    const e = await bootstrapPlatformAdmin({ email: 'second@example.test' }, w.deps).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error); expect(String((e as Error).message)).toContain('bootstrap_closed');
    expect(w.staff).toHaveLength(1); expect(w.staff[0]!.email).toBe('first@example.test'); expect(w.events).toHaveLength(1);
    expect(w.statements.every((s) => /identity_bootstrap_platform_admin/.test(s.text))).toBe(true);
  });
  it('main(): first run exit 0, second exit non-zero with bootstrap_closed on stderr and nothing on stdout', async () => {
    const w = world();
    expect(await main(['--email', 'first@example.test'], w.deps)).toBe(0);
    const again = world({ activeSuperadmin: true });
    expect(await main(['--email', 'second@example.test'], again.deps)).toBe(1);
    expect(again.stderr()).toContain('bootstrap_closed'); expect(again.stdout()).toBe(''); expect(again.staff).toHaveLength(1);
  });
  it('closed also when the existing superadmin was seeded by someone else (any active platform_superadmin closes it)', async () => {
    const w = world({ activeSuperadmin: true });
    expect(await main(['--email=ops@example.test'], w.deps)).toBe(1); expect(w.events).toEqual([]);
  });
  it('race: two simultaneous runs -> exactly one wins (exit 0), the other is closed (exit 1); one staff row, one event', async () => {
    const w = world();
    const codes = await Promise.all([main(['--email', 'a@example.test'], w.deps), main(['--email', 'b@example.test'], w.deps)]);
    expect([...codes].sort()).toEqual([0, 1]); expect(w.staff).toHaveLength(1); expect(w.events).toHaveLength(1);
  });
});

describe('main(): arguments and output', () => {
  it('success: exit 0, stdout names the new staff id and tells the operator to use forgot-password and enrol TOTP; stderr empty; no password anywhere', async () => {
    const w = world(); expect(await main(['--email', 'ops@example.test', '--display-name', 'Ops Lead'], w.deps)).toBe(0);
    expect(w.stdout()).toContain(w.staff[0]!.id); expect(w.stdout().toLowerCase()).toMatch(/forgot.?password|password reset|recover/); expect(w.stdout().toLowerCase()).toMatch(/totp|mfa/); expect(w.stderr()).toBe('');
    expect(w.statements[0]!.values[3]).toBe('Ops Lead');
  });
  it('--email=<x> form is accepted', async () => {
    const w = world(); expect(await main(['--email=ops@example.test'], w.deps)).toBe(0); expect(w.created[0]!.email).toBe('ops@example.test');
  });
  const usage: Array<[string, string[]]> = [
    ['no arguments', []], ['--email without a value', ['--email']], ['empty email', ['--email', '']], ['not an email', ['--email', 'nope']], ['no domain dot', ['--email', 'a@b']],
    ['email > 254 chars', ['--email', `${'a'.repeat(250)}@x.test`]], ['unknown flag', ['--email', 'ops@example.test', '--role', 'platform_support']],
    ['email twice', ['--email', 'a@example.test', '--email', 'b@example.test']], ['display name > 120', ['--email', 'ops@example.test', '--display-name', 'x'.repeat(121)]],
    ['empty display name', ['--email', 'ops@example.test', '--display-name', '']], ['positional junk', ['ops@example.test']],
  ];
  it.each(usage)('usage error (%s) -> exit 2, a usage hint on stderr, GoTrue and DB never touched', async (_n, argv) => {
    const w = world(); expect(await main(argv, w.deps)).toBe(2);
    expect(w.gotrue.adminCreateUser).not.toHaveBeenCalled(); expect(w.statements).toEqual([]); expect(w.stderr().toLowerCase()).toContain('--email'); expect(w.stdout()).toBe('');
  });
  it('GoTrue failure -> exit 1, DEFINER never called, no stack trace or object dump on stderr', async () => {
    const w = world({ gotrueError: new Error('gotrue adminCreateUser failed: 500 unexpected_failure') });
    expect(await main(['--email', 'ops@example.test'], w.deps)).toBe(1); expect(w.statements).toEqual([]); expect(w.stderr()).not.toMatch(/\n\s+at /);
  });
  it('DB failure (not bootstrap_closed) -> exit 1, stdout empty, no staff row', async () => {
    const w = world({ dbError: new Error('connection refused') });
    expect(await main(['--email', 'ops@example.test'], w.deps)).toBe(1); expect(w.stdout()).toBe(''); expect(w.staff).toEqual([]); expect(w.stderr()).not.toContain('bootstrap_closed');
  });
});

describe('static: the CLI is a thin caller of the DEFINER (07-SECURITY REQ-SEC-063; 05-SCHEMA s5.4 owner-only INSERT)', () => {
  const src = readFileSync(join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity', 'cli', 'bootstrap-platform-admin.ts'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  it('calls app.identity_bootstrap_platform_admin and has no SQL of its own on identity.platform_staff / platform_events', () => {
    expect(code).toMatch(/app\.identity_bootstrap_platform_admin\s*\(/);
    expect(code).not.toMatch(/INSERT\s+INTO|UPDATE\s+identity\.|DELETE\s+FROM|identity\.platform_staff|identity\.platform_events|SELECT\s+count/i);
  });
  it('sets no password and sends no mail itself (the operator uses forgot-password; the first login enrols TOTP)', () => {
    expect(code).not.toMatch(/adminUpdatePassword|signInWithPassword|sendInvite|sendRecovery|password\s*[:=]/i);
  });
  it('is not auto-run on import and reads no secret from argv (only --email / --display-name)', () => {
    expect(code).not.toMatch(/^\s*(await\s+)?main\(\s*process\.argv/m);                                    // must be guarded (import.meta / entry check)
    expect(code).not.toMatch(/--password|--token|--secret/i);
  });
  it('services/api/package.json exposes the runbook command identity:bootstrap-platform-admin pointing at the CLI file', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'services', 'api', 'package.json'), 'utf8'));
    expect(pkg.scripts?.['identity:bootstrap-platform-admin']).toMatch(/cli[\\/]bootstrap-platform-admin/);
  });
});
