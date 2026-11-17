// RM-T02 CLI (LD-141): `pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack <pack code>`. Synthetic data only.
// ASSUMED API of ../../cli/apply-role-pack.ts (pure of process/env; importing it must NOT run anything or call process.exit; same shape as bootstrap-platform-admin.ts):
//   export interface ApplyDeps { apply(tenantId: string, packCode: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }>; stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown } }
//   export async function main(argv: string[], deps: ApplyDeps): Promise<number>      // exit code: 0 ok, 1 failure (apply rejected), 2 usage
//   argv = what follows the script name: `--tenant <uuid>` and `--pack <code>` (each also as `--flag=value`), both required, each exactly once, nothing else.
//   The entry-point block (only when run directly) wires pg (libpq PG* env), the service (createRolePackService) and a ctx whose actor is a system actor, then calls main.
//   Output: one summary line on stdout with the three counts; errors print ONE line on stderr, never a stack or an object dump.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { main } from '../../cli/apply-role-pack.js';

const T = '0190a000-0000-7000-8000-0000000000a1';
const mk = (apply?: (t: string, p: string) => Promise<any>) => {
  const out: string[] = [], err: string[] = [];
  const a = vi.fn(apply ?? (async () => ({ created: ['corp_admin', 'corp_accounts'], updated: [], unchanged: ['corp_lab_user'] })));
  return { deps: { apply: a, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } }, a, out: () => out.join(''), err: () => err.join('') };
};

describe('RM-T02 CLI apply-role-pack', () => {
  it('--tenant and --pack (space or = form) -> apply once with those values, exit 0, counts on stdout', async () => {
    for (const argv of [['--tenant', T, '--pack', 'elabcorp_default'], [`--tenant=${T}`, '--pack=elabcorp_default'], ['--pack', 'elabcorp_default', '--tenant', T]]) {
      const w = mk(); expect(await main(argv, w.deps)).toBe(0);
      expect(w.a).toHaveBeenCalledTimes(1); expect(w.a).toHaveBeenCalledWith(T, 'elabcorp_default');
      expect(w.out()).toMatch(/\b2\b[^\n]*\b0\b[^\n]*\b1\b|created[^\n]*2/i); expect(w.err()).toBe('');
    }
  });
  it('a re-run that changes nothing still exits 0', async () => {
    const w = mk(async () => ({ created: [], updated: [], unchanged: ['corp_admin'] }));
    expect(await main(['--tenant', T, '--pack', 'elabassist_standard'], w.deps)).toBe(0);
  });
  it.each([
    ['no args', []], ['no pack', ['--tenant', T]], ['no tenant', ['--pack', 'elabcorp_default']], ['tenant not a uuid', ['--tenant', 'acme', '--pack', 'elabcorp_default']],
    ['sql in tenant', ['--tenant', "x'; DROP TABLE core.roles;--", '--pack', 'elabcorp_default']], ['empty pack', ['--tenant', T, '--pack', '']],
    ['pack with spaces/shell chars', ['--tenant', T, '--pack', 'a b; rm -rf /']], ['duplicate flag', ['--tenant', T, '--tenant', T, '--pack', 'elabcorp_default']],
    ['unknown flag', ['--tenant', T, '--pack', 'elabcorp_default', '--force']], ['positional arg', ['--tenant', T, '--pack', 'elabcorp_default', 'extra']],
    ['flag without value', ['--tenant', T, '--pack']],
  ])('usage error (%s) -> exit 2, usage on stderr, apply never called', async (_n, argv) => {
    const w = mk(); expect(await main(argv as string[], w.deps)).toBe(2);
    expect(w.a).not.toHaveBeenCalled(); expect(w.err()).toMatch(/usage/i); expect(w.out()).toBe('');
  });
  it('apply rejects -> exit 1, ONE line on stderr, no stack, no object dump, nothing on stdout', async () => {
    const w = mk(async () => { throw Object.assign(new Error('db down\n    at secret (/srv/app.js:1:1)'), { detail: { password: 'hunter2' } }); });
    expect(await main(['--tenant', T, '--pack', 'elabcorp_default'], w.deps)).toBe(1);
    expect(w.err().trim().split('\n')).toHaveLength(1); expect(w.err()).not.toMatch(/\bat \w|hunter2|\[object/); expect(w.out()).toBe('');
  });
  it('a long or non-Error rejection never prints more than one bounded line', async () => {
    const w = mk(async () => { throw 'x'.repeat(5000); });
    expect(await main(['--tenant', T, '--pack', 'elabcorp_default'], w.deps)).toBe(1);
    expect(w.err().trim().split('\n')).toHaveLength(1); expect(w.err().length).toBeLessThan(400);
  });
  it('importing the module runs nothing (entry point is guarded) and the file has no HTTP / secret', () => {
    const src = readFileSync(join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity', 'cli', 'apply-role-pack.ts'), 'utf8');
    expect(src).toMatch(/import\.meta\.url\s*===\s*pathToFileURL\(process\.argv\[1\]\)\.href/);
    expect(src).toMatch(/LD-141/);
    expect(src).not.toMatch(/process\.exit\s*\(|\bpassword\s*[:=]\s*['"]/i);
  });
});

// ADMINPACK-3 (LD-262): `--add-missing <role_code>` (repeatable, also `=` form) and `--yes`.
// ASSUMED API addition to ../../cli/apply-role-pack.ts:
//   ApplyDeps gains an OPTIONAL  addMissing(tenantId, packCode, roles: string[], yes: boolean): Promise<Array<{ role_code: string; missing: string[]; extra: string[]; added: string[] }>>
//   Without --add-missing, `apply` is called exactly as before (2 args) and addMissing is never called. With --add-missing, `apply` is NOT called; addMissing is called once
//   with the roles in argv order and yes = (--yes present). Role codes must match /^[a-z][a-z0-9_]{0,63}$/. --yes takes no value and needs at least one --add-missing.
//   Dry run (no --yes) stdout: says "dry run", then per role the codes it WOULD add (`would add`) and the codes only the lab role holds (informational); exit 0, nothing written.
//   --yes stdout: per role the codes it added (`added`). A rejection with code 'common.validation_failed' (role not in pack / lab lacks it / privileged on non-MFA role) -> exit 2 (usage-type refusal);
//   any other rejection -> exit 1; both print ONE bounded stderr line. Exit 0 also when nothing was missing.
describe('ADMINPACK-3 CLI --add-missing / --yes', () => {
  const R = [{ role_code: 'corp_admin', missing: ['audit.log.read', 'qc.run.manage'], extra: ['lab.custom.thing'], added: [] as string[] }];
  const mkA = (res: any = R, reject?: unknown) => {
    const w = mk(); const am = vi.fn(async (..._a: unknown[]) => { if (reject !== undefined) throw reject; return res; });
    return { ...w, am, deps: { ...w.deps, addMissing: am } };
  };
  const base = ['--tenant', T, '--pack', 'elabcorp_default'];

  it('dry run: addMissing(T, pack, [role], false); apply not called; exit 0; lists would-add and lab-only codes; says dry run', async () => {
    const w = mkA(); expect(await main([...base, '--add-missing', 'corp_admin'], w.deps)).toBe(0);
    expect(w.am).toHaveBeenCalledTimes(1); expect(w.am).toHaveBeenCalledWith(T, 'elabcorp_default', ['corp_admin'], false); expect(w.a).not.toHaveBeenCalled();
    const o = w.out(); expect(o).toMatch(/dry[- ]run/i); expect(o).toMatch(/would add/i);
    for (const c of ['corp_admin', 'audit.log.read', 'qc.run.manage', 'lab.custom.thing']) expect(o).toContain(c);
    expect(w.err()).toBe('');
  });
  it('--yes: addMissing(..., true); stdout names what was added', async () => {
    const w = mkA([{ ...R[0]!, added: R[0]!.missing }]); expect(await main([...base, '--add-missing=corp_admin', '--yes'], w.deps)).toBe(0);
    expect(w.am).toHaveBeenCalledWith(T, 'elabcorp_default', ['corp_admin'], true); expect(w.a).not.toHaveBeenCalled();
    expect(w.out()).toMatch(/added/i); expect(w.out()).toContain('qc.run.manage'); expect(w.out()).not.toMatch(/dry[- ]run/i);
  });
  it('repeatable, argv order kept, flags in any position', async () => {
    const w = mkA(); expect(await main(['--yes', '--add-missing', 'corp_admin', ...base, '--add-missing', 'corp_accounts'], w.deps)).toBe(0);
    expect(w.am).toHaveBeenCalledWith(T, 'elabcorp_default', ['corp_admin', 'corp_accounts'], true);
  });
  it('nothing missing still exits 0', async () => {
    const w = mkA([{ role_code: 'corp_admin', missing: [], extra: [], added: [] }]); expect(await main([...base, '--add-missing', 'corp_admin', '--yes'], w.deps)).toBe(0);
  });
  it('default call is byte-for-byte as before: apply(T, pack) with two args, addMissing never called', async () => {
    const w = mkA(); expect(await main(base, w.deps)).toBe(0);
    expect(w.a).toHaveBeenCalledTimes(1); expect(w.a.mock.calls[0]).toEqual([T, 'elabcorp_default']); expect(w.am).not.toHaveBeenCalled();
  });
  it.each([
    ['--yes without --add-missing', [...base, '--yes']], ['--add-missing without a value', [...base, '--add-missing']], ['--add-missing with an empty value', [...base, '--add-missing=']],
    ['role with shell chars', [...base, '--add-missing', 'a b; rm -rf /']], ['role in capitals', [...base, '--add-missing', 'CORP_ADMIN']], ['sql in role', [...base, '--add-missing', "x'; DROP TABLE core.roles;--"]],
    ['--yes with a value', [...base, '--add-missing', 'corp_admin', '--yes=true']], ['--yes twice', [...base, '--add-missing', 'corp_admin', '--yes', '--yes']],
    ['--add-missing but no tenant', ['--pack', 'elabcorp_default', '--add-missing', 'corp_admin']], ['--add-missing but no pack', ['--tenant', T, '--add-missing', 'corp_admin']],
    ['unknown flag next to it', [...base, '--add-missing', 'corp_admin', '--force']], ['positional arg', [...base, '--add-missing', 'corp_admin', 'extra']],
  ])('usage error (%s) -> exit 2, usage on stderr, nothing called', async (_n, argv) => {
    const w = mkA(); expect(await main(argv as string[], w.deps)).toBe(2);
    expect(w.am).not.toHaveBeenCalled(); expect(w.a).not.toHaveBeenCalled(); expect(w.err()).toMatch(/usage/i); expect(w.out()).toBe('');
  });
  it('--add-missing with a deps object that has no addMissing: exit 1 (not a crash), nothing applied', async () => {
    const w = mk(); expect(await main([...base, '--add-missing', 'corp_admin', '--yes'], w.deps)).toBe(1);
    expect(w.a).not.toHaveBeenCalled(); expect(w.err().trim().split('\n')).toHaveLength(1);
  });
  it('a refusal (common.validation_failed) -> exit 2, ONE line on stderr, nothing on stdout', async () => {
    const w = mkA(R, Object.assign(new Error('role corp_admin is not in the lab\n    at secret (/srv/app.js:1:1)'), { code: 'common.validation_failed' }));
    expect(await main([...base, '--add-missing', 'corp_admin', '--yes'], w.deps)).toBe(2);
    expect(w.err().trim().split('\n')).toHaveLength(1); expect(w.err()).not.toMatch(/\bat \w|\[object/); expect(w.out()).toBe('');
  });
  it('any other failure -> exit 1, ONE bounded line, no stack, no secret', async () => {
    const w = mkA(R, Object.assign(new Error('db down\n    at x (/srv/a.js:1:1)'), { detail: { password: 'hunter2' } }));
    expect(await main([...base, '--add-missing', 'corp_admin', '--yes'], w.deps)).toBe(1);
    expect(w.err().trim().split('\n')).toHaveLength(1); expect(w.err()).not.toMatch(/\bat \w|hunter2|\[object/); expect(w.err().length).toBeLessThan(400);
  });
  it('a non-Error rejection of 5000 chars prints one bounded line', async () => {
    const w = mkA(R, 'x'.repeat(5000)); expect(await main([...base, '--add-missing', 'corp_admin'], w.deps)).toBe(1);
    expect(w.err().trim().split('\n')).toHaveLength(1); expect(w.err().length).toBeLessThan(400);
  });
  it('the entry point wires the flags to the service in one transaction and still has no process.exit / env reads', () => {
    const src = readFileSync(join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity', 'cli', 'apply-role-pack.ts'), 'utf8');
    expect(src).toContain('--add-missing'); expect(src).toContain('--yes'); expect(src).toMatch(/addMissing/);
    expect(src).not.toMatch(/process\.exit\s*\(|process\.env\./); expect(src).toContain('libpq PG* environment');
  });
});

// =====================================================================================================================================================
// ADMINPACK-4 (LD-265, LD-189). ASSUMED API additions to ../../cli/apply-role-pack.ts (everything else, every exit code and every old test stays as is):
//  (1) REFUSAL LINE. A rejection with code 'common.validation_failed' AND own property reason in the closed set
//      {args, role_not_in_pack, role_missing_in_lab, role_is_system_default, unassignable_code, privileged_without_mfa} prints exactly ONE stderr line
//          `refused: <reason> <role_code>`      (role_code from the error's own property role_code, only when it matches /^[a-z][a-z0-9_]{0,63}$/; `refused: args` has none)
//      INSTEAD of the `apply-role-pack failed:` line. Exit codes unchanged: 2 with --add-missing, 1 for plain apply. A reason outside the set (or none) keeps the old line.
//  (2) PLAIN APPLY prints, after the counts line (unchanged), three more lines: `created: a, b` / `updated: (none)` / `unchanged: c` (codes joined by ", ", "(none)" when empty).
//  (3) `--list` (no value, once; needs --tenant and --pack; refuses --add-missing and --yes as usage errors, exit 2). ApplyDeps gains an OPTIONAL
//          list(tenantId, packCode): Promise<ListRow[]>  with  ListRow = { role_code, in_lab, is_system_default, is_active, mfa_required: boolean; lab_permissions, pack_permissions, missing_in_lab: number }
//      main calls ONLY deps.list(T, pack) (never apply / addMissing). stdout: first line `role pack <pack>: list, read-only, nothing written`, then one line per row, in order:
//          `role <code>: in_lab=yes|no is_system_default=yes|no is_active=yes|no mfa_required=yes|no lab_permissions=<n> pack_permissions=<n> missing_in_lab=<n>`
//      a row with in_lab=false prints `-` for the three yes/no fields after in_lab. Exit 0. Rejection handling is as for add-missing (refusal -> 2, other -> 1). No `list` dep -> exit 1.
//      The CLI also exports the pure helper  describePackRoles(packRoles: Array<{ code: string; permissions: string[] }>, labRoles: PackRoleRow[]): ListRow[]  (pack order; the real entry point
//      feeds it loadRolePacks() and repo.listRoles(tx, tenant): a SELECT only, no audit, no write).
//  (4) DB LINE. The CLI exports  captureDbErrors(tx): { tx, diag(): { code?, schema?, table?, constraint? } | undefined }  : tx is a wrapper whose query() passes through to the original
//      (same args, same resolved value), and on a rejection records the FIRST failing statement's pg fields code, schema, table, constraint (never message, detail, parameters, hint, where, column),
//      then rethrows THE SAME error object. A field is kept only if it looks like an identifier: code /^[0-9A-Z]{5}$/, schema/table/constraint /^[A-Za-z0-9_]{1,63}$/; else it is left out.
//      No SQLSTATE -> nothing recorded. All other tx properties stay reachable through the wrapper. ApplyDeps gains OPTIONAL dbDiag(): same shape | undefined. After the
//      `apply-role-pack failed:` line (NOT after a `refused:` line) main prints ONE more line  `db: <code> <schema>.<table> <constraint>`  with `-` for a missing field, only when dbDiag() has a code.
//      main re-validates what dbDiag returns with the same patterns (a bad field prints `-`, a bad code prints no line) and swallows a dbDiag that throws.
// =====================================================================================================================================================
describe('ADMINPACK-4 CLI refusal reason on stderr', () => {
  const base = ['--tenant', T, '--pack', 'elabcorp_default'];
  const refusal = (reason: unknown, role_code?: unknown, code = 'common.validation_failed') =>
    Object.assign(new Error(`${code}\n    at secret (/srv/app.js:1:1)`), { code, reason, role_code });
  const mkR = (reject: unknown) => { const w = mk(async () => { throw reject; }); const am = vi.fn(async (..._a: unknown[]) => { throw reject; }); return { ...w, am, deps: { ...w.deps, addMissing: am } }; };
  const lines = (s: string) => s.split('\n').filter((l) => l !== '');

  it.each([
    ['role_not_in_pack', 'corp_admin'], ['role_missing_in_lab', 'corp_admin'], ['role_is_system_default', 'corp_admin'],
    ['unassignable_code', 'corp_admin'], ['privileged_without_mfa', 'corp_admin'],
  ])('--add-missing refusal %s -> exit 2, exactly `refused: <reason> <role>` and nothing else (role %s)', async (reason, role) => {
    const w = mkR(refusal(reason, role));
    expect(await main([...base, '--add-missing', role!, '--yes'], w.deps)).toBe(2);
    expect(lines(w.err())).toEqual([`refused: ${reason} ${role}`]); expect(w.out()).toBe('');
  });
  it('refusal args -> `refused: args` (no role code), exit 2', async () => {
    const w = mkR(refusal('args'));
    expect(await main([...base, '--add-missing', 'corp_admin'], w.deps)).toBe(2);
    expect(lines(w.err())).toEqual(['refused: args']);
  });
  it('the dry run refusal prints the same line (the reason does not depend on --yes)', async () => {
    const w = mkR(refusal('role_missing_in_lab', 'corp_admin'));
    expect(await main([...base, '--add-missing', 'corp_admin'], w.deps)).toBe(2); expect(lines(w.err())).toEqual(['refused: role_missing_in_lab corp_admin']);
  });
  it('plain apply refusal: same line, exit code stays 1', async () => {
    const w = mk(async () => { throw refusal('args'); });
    expect(await main(base, w.deps)).toBe(1); expect(lines(w.err())).toEqual(['refused: args']); expect(w.out()).toBe('');
  });
  it('a reason outside the closed set, a missing reason, or another error code keeps the old one-line message', async () => {
    for (const e of [refusal('table_dropped; rm -rf /', 'corp_admin'), refusal(undefined, 'corp_admin'), refusal(42, 'x'), refusal('role_missing_in_lab', 'corp_admin', 'common.not_found')]) {
      const w = mkR(e); await main([...base, '--add-missing', 'corp_admin', '--yes'], w.deps);
      expect(lines(w.err())).toHaveLength(1); expect(w.err()).toMatch(/^apply-role-pack failed: /); expect(w.err()).not.toMatch(/^refused:/);
    }
  });
  it('a hostile role_code on the error (newline, stack text, shell chars, 5000 chars, wrong type) is never printed: one bounded line', async () => {
    for (const rc of ['corp_admin\nat evil (/x.js:1:1)', 'a b; rm -rf /', 'X'.repeat(5000), 'a'.repeat(300), { toString: () => 'boom' }, 42, null]) {
      const w = mkR(refusal('role_missing_in_lab', rc));
      expect(await main([...base, '--add-missing', 'corp_admin'], w.deps)).toBe(2);
      expect(lines(w.err())).toEqual(['refused: role_missing_in_lab']); expect(w.err().length).toBeLessThan(120); expect(w.err()).not.toMatch(/evil|rm -rf|boom|\[object/);
    }
  });
  it('a refusal prints no db line even when dbDiag knows something', async () => {
    const w = mkR(refusal('role_missing_in_lab', 'corp_admin'));
    expect(await main([...base, '--add-missing', 'corp_admin'], { ...w.deps, dbDiag: () => ({ code: '42501', schema: 'core', table: 'roles', constraint: 'c' }) } as any)).toBe(2);
    expect(w.err()).not.toMatch(/db:/);
  });
  it('an old-style refusal without reason still exits 2 with --add-missing (ADMINPACK-3 behaviour kept)', async () => {
    const w = mkR(Object.assign(new Error('x'), { code: 'common.validation_failed' })); expect(await main([...base, '--add-missing', 'corp_admin'], w.deps)).toBe(2);
  });
});

describe('ADMINPACK-4 plain apply lists the role codes', () => {
  const base = ['--tenant', T, '--pack', 'elabcorp_default'];
  it('counts line unchanged, then created / updated / unchanged with codes; "(none)" when empty', async () => {
    const w = mk(async () => ({ created: ['corp_admin', 'corp_accounts'], updated: [], unchanged: ['corp_lab_user'] }));
    expect(await main(base, w.deps)).toBe(0);
    const o = w.out().split('\n');
    expect(o[0]).toBe('role pack elabcorp_default: created=2 updated=0 unchanged=1');
    expect(o).toContain('created: corp_admin, corp_accounts'); expect(o).toContain('updated: (none)'); expect(o).toContain('unchanged: corp_lab_user');
    expect(o.indexOf('created: corp_admin, corp_accounts')).toBeLessThan(o.indexOf('updated: (none)')); expect(o.indexOf('updated: (none)')).toBeLessThan(o.indexOf('unchanged: corp_lab_user'));
    expect(w.err()).toBe('');
  });
  it('nothing changed: all "(none)" except unchanged', async () => {
    const w = mk(async () => ({ created: [], updated: [], unchanged: ['corp_admin'] }));
    expect(await main(base, w.deps)).toBe(0); expect(w.out()).toContain('created: (none)'); expect(w.out()).toContain('unchanged: corp_admin');
  });
  it('the --add-missing output is unchanged by this task (no created: / unchanged: lines)', async () => {
    const w = mk(); const am = vi.fn(async (..._a: unknown[]) => [{ role_code: 'corp_admin', missing: ['qc.run.manage'], extra: [], added: [] as string[] }]);
    expect(await main([...base, '--add-missing', 'corp_admin'], { ...w.deps, addMissing: am })).toBe(0);
    expect(w.out()).toMatch(/dry[- ]run/i); expect(w.out()).not.toMatch(/^created:/m);
  });
});

describe('ADMINPACK-4 CLI --list (read-only)', () => {
  const base = ['--tenant', T, '--pack', 'elabcorp_default'];
  const ROW = { role_code: 'corp_admin', in_lab: true, is_system_default: false, is_active: true, mfa_required: true, lab_permissions: 30, pack_permissions: 36, missing_in_lab: 6 };
  const ABSENT = { role_code: 'corp_accounts', in_lab: false, is_system_default: false, is_active: false, mfa_required: false, lab_permissions: 0, pack_permissions: 12, missing_in_lab: 12 };
  const DEFAULT = { role_code: 'corp_lab_user', in_lab: true, is_system_default: true, is_active: false, mfa_required: false, lab_permissions: 3, pack_permissions: 5, missing_in_lab: 2 };
  const mkL = (rows: any = [ROW, ABSENT, DEFAULT], reject?: unknown) => {
    const w = mk(); const li = vi.fn(async (..._a: unknown[]) => { if (reject !== undefined) throw reject; return rows; }); const am = vi.fn(async () => []);
    return { ...w, li, am, deps: { ...w.deps, list: li, addMissing: am } };
  };

  it('calls only list(T, pack); exit 0; header says read-only; one line per row in order with every field', async () => {
    const w = mkL(); expect(await main([...base, '--list'], w.deps)).toBe(0);
    expect(w.li).toHaveBeenCalledTimes(1); expect(w.li).toHaveBeenCalledWith(T, 'elabcorp_default'); expect(w.a).not.toHaveBeenCalled(); expect(w.am).not.toHaveBeenCalled();
    expect(w.out().split('\n').filter(Boolean)).toEqual([
      'role pack elabcorp_default: list, read-only, nothing written',
      'role corp_admin: in_lab=yes is_system_default=no is_active=yes mfa_required=yes lab_permissions=30 pack_permissions=36 missing_in_lab=6',
      'role corp_accounts: in_lab=no is_system_default=- is_active=- mfa_required=- lab_permissions=0 pack_permissions=12 missing_in_lab=12',
      'role corp_lab_user: in_lab=yes is_system_default=yes is_active=no mfa_required=no lab_permissions=3 pack_permissions=5 missing_in_lab=2',
    ]);
    expect(w.err()).toBe('');
  });
  it('--list=… forms and any argument order work: `--list` first, `=` forms', async () => {
    for (const argv of [['--list', `--tenant=${T}`, '--pack=elabcorp_default'], ['--pack', 'elabcorp_default', '--list', '--tenant', T]]) {
      const w = mkL(); expect(await main(argv, w.deps)).toBe(0); expect(w.li).toHaveBeenCalledWith(T, 'elabcorp_default');
    }
  });
  it('an empty pack list still exits 0 with the header only', async () => {
    const w = mkL([]); expect(await main([...base, '--list'], w.deps)).toBe(0); expect(w.out().split('\n').filter(Boolean)).toHaveLength(1);
  });
  it.each([
    ['--list with --add-missing', [...base, '--list', '--add-missing', 'corp_admin']], ['--list with --yes', [...base, '--list', '--yes']],
    ['--list with --add-missing and --yes', [...base, '--list', '--add-missing', 'corp_admin', '--yes']], ['--list with a value', [...base, '--list=yes']],
    ['--list twice', [...base, '--list', '--list']], ['--list without a tenant', ['--pack', 'elabcorp_default', '--list']], ['--list without a pack', ['--tenant', T, '--list']],
    ['--list with a bad tenant', ['--tenant', 'acme', '--pack', 'elabcorp_default', '--list']], ['--list with a bad pack', ['--tenant', T, '--pack', 'a b; rm -rf /', '--list']],
    ['--list with a positional arg', [...base, '--list', 'extra']],
  ])('usage error (%s) -> exit 2, usage on stderr, nothing called', async (_n, argv) => {
    const w = mkL(); expect(await main(argv as string[], w.deps)).toBe(2);
    expect(w.li).not.toHaveBeenCalled(); expect(w.am).not.toHaveBeenCalled(); expect(w.a).not.toHaveBeenCalled(); expect(w.err()).toMatch(/usage/i); expect(w.out()).toBe('');
  });
  it('the usage text mentions --list', async () => { const w = mkL(); await main([], w.deps); expect(w.err()).toContain('--list'); });
  it('without --list nothing about list is called (default call is unchanged)', async () => {
    const w = mkL(); expect(await main(base, w.deps)).toBe(0); expect(w.li).not.toHaveBeenCalled(); expect(w.a.mock.calls[0]).toEqual([T, 'elabcorp_default']);
  });
  it('--list with a deps object that has no list: exit 1, one line, nothing else called', async () => {
    const w = mk(); expect(await main([...base, '--list'], w.deps)).toBe(1); expect(w.a).not.toHaveBeenCalled(); expect(w.err().trim().split('\n')).toHaveLength(1);
  });
  it('list refusals: bad pack (reason args) -> `refused: args`, exit 2; other failure -> exit 1, one bounded line, no secret', async () => {
    const r = mkL([], Object.assign(new Error('x'), { code: 'common.validation_failed', reason: 'args' }));
    expect(await main([...base, '--list'], r.deps)).toBe(2); expect(r.err().trim()).toBe('refused: args'); expect(r.out()).toBe('');
    const f = mkL([], Object.assign(new Error('db down\n    at x (/srv/a.js:1:1)'), { detail: { password: 'hunter2' } }));
    expect(await main([...base, '--list'], f.deps)).toBe(1);
    expect(f.err().trim().split('\n')).toHaveLength(1); expect(f.err()).not.toMatch(/\bat \w|hunter2|\[object/); expect(f.err().length).toBeLessThan(400);
  });
  it('a hostile role_code in a row is not echoed raw: one line per row, no newline injection', async () => {
    const w = mkL([{ ...ROW, role_code: 'corp_admin\nrole evil: in_lab=yes' }]); await main([...base, '--list'], w.deps);
    expect(w.out().split('\n').filter(Boolean).length).toBeLessThanOrEqual(2); expect(w.out()).not.toContain('evil');   // printed as `role -: ...` or skipped, never raw
  });
});

describe('ADMINPACK-4 describePackRoles (pure; what --list shows)', () => {
  const packRoles = [{ code: 'corp_admin', permissions: ['a.b', 'c.d', 'e.f', 'e.f'] }, { code: 'corp_accounts', permissions: ['x.y'] }, { code: 'corp_lab_user', permissions: ['a.b', 'c.d'] }];
  const lr = (o: any) => ({ id: '0190a000-0000-7000-8000-000000000001', is_system_default: false, is_active: true, mfa_required: false, permission_codes: [] as string[], ...o });
  it('counts the pack permissions once each, the lab role permissions, and what the lab role lacks; keeps pack order; marks absent roles', async () => {
    const { describePackRoles } = await import('../../cli/apply-role-pack.js');
    const rows = describePackRoles(packRoles, [
      lr({ code: 'zzz_custom', permission_codes: ['q.q'] }),    // a lab-only role is never listed
      lr({ code: 'corp_admin', mfa_required: true, permission_codes: ['a.b', 'lab.extra'] }),
      lr({ code: 'corp_lab_user', is_system_default: true, is_active: false, permission_codes: ['a.b', 'c.d'] }),
    ]);
    expect(rows).toEqual([
      { role_code: 'corp_admin', in_lab: true, is_system_default: false, is_active: true, mfa_required: true, lab_permissions: 2, pack_permissions: 3, missing_in_lab: 2 },
      { role_code: 'corp_accounts', in_lab: false, is_system_default: false, is_active: false, mfa_required: false, lab_permissions: 0, pack_permissions: 1, missing_in_lab: 1 },
      { role_code: 'corp_lab_user', in_lab: true, is_system_default: true, is_active: false, mfa_required: false, lab_permissions: 2, pack_permissions: 2, missing_in_lab: 0 },
    ]);
  });
  it('works on the real pack data and does not mutate its inputs', async () => {
    const { describePackRoles } = await import('../../cli/apply-role-pack.js');
    const { loadRolePacks } = await import('../../role-packs/loader.js');
    const pack = loadRolePacks().packs.find((p: any) => p.code === 'elabcorp_default')!; const before = JSON.stringify(pack);
    const rows = describePackRoles(pack.roles, []);
    expect(rows.map((r) => r.role_code)).toEqual(pack.roles.map((r: any) => r.code)); expect(rows.every((r) => !r.in_lab && r.lab_permissions === 0 && r.missing_in_lab === r.pack_permissions)).toBe(true);
    expect(JSON.stringify(pack)).toBe(before);
  });
  it('--list reads with the existing repo: listRoles is a SELECT only (no write, no audit statement)', async () => {
    const { createRolePackRepo } = await import('../../service/role-pack.service.js');
    const stmts: string[] = []; const tx = { async query(s: string) { stmts.push(s); return { rows: [] }; } };
    await createRolePackRepo().listRoles(tx, T);
    expect(stmts).toHaveLength(1); expect(stmts[0]).toMatch(/^\s*SELECT/i); expect(stmts.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|SET)\b/i);
  });
  it('the CLI entry point wires --list to describePackRoles and listRoles, and never to audit / apply / addMissing in that branch', () => {
    const src = readFileSync(join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity', 'cli', 'apply-role-pack.ts'), 'utf8');
    expect(src).toContain('--list'); expect(src).toContain('describePackRoles'); expect(src).toMatch(/\blistRoles\b/); expect(src).toMatch(/LD-265/);
    expect(src).toMatch(/\blist:\s/);   // the entry point passes a `list` dependency to main
    expect(src).not.toMatch(/insertRole\s*\(|addPermissions\s*\(/);   // the CLI itself never calls the write methods of the repo
  });
});

describe('ADMINPACK-4 captureDbErrors + the `db:` line', () => {
  const base = ['--tenant', T, '--pack', 'elabcorp_default'];
  const SECRET_VALUE = 'Jane Roe 1980-02-03';
  /** A pg DatabaseError look-alike: the detail / message / parameters hold a ROW VALUE and must never reach any output. */
  const pgErr = (over: Record<string, unknown> = {}) => Object.assign(new Error(`duplicate key value violates unique constraint (${SECRET_VALUE})`), {
    code: '23503', schema: 'core', table: 'role_permissions', constraint: 'role_permissions_permission_code_fkey',
    detail: `Key (display_name)=(${SECRET_VALUE}) is not present in table "permissions".`, hint: SECRET_VALUE, where: SECRET_VALUE, column: 'display_name', parameters: [SECRET_VALUE], ...over,
  });
  const fakeTx = (impl: (sql: string, params?: unknown[]) => Promise<any>) => ({ marker: 'm1', query: vi.fn(impl) });

  it('passes a successful statement through: same arguments, same result object, nothing recorded', async () => {
    const { captureDbErrors } = await import('../../cli/apply-role-pack.js');
    const res = { rows: [{ a: 1 }] }; const t = fakeTx(async () => res); const w = captureDbErrors(t);
    expect(await w.tx.query('SELECT 1 WHERE x = $1', ['p'])).toBe(res); expect(t.query).toHaveBeenCalledWith('SELECT 1 WHERE x = $1', ['p']); expect(w.diag()).toBeUndefined();
  });
  it('a failing statement: the SAME error object is rethrown; code, schema, table, constraint are recorded and nothing else', async () => {
    const { captureDbErrors } = await import('../../cli/apply-role-pack.js');
    const e = pgErr(); const w = captureDbErrors(fakeTx(async () => { throw e; }));
    await expect(w.tx.query('INSERT x')).rejects.toBe(e);
    expect(w.diag()).toEqual({ code: '23503', schema: 'core', table: 'role_permissions', constraint: 'role_permissions_permission_code_fkey' });
    expect(JSON.stringify(w.diag())).not.toContain(SECRET_VALUE);
  });
  it('42501 without a constraint records code, schema, table only', async () => {
    const { captureDbErrors } = await import('../../cli/apply-role-pack.js');
    const w = captureDbErrors(fakeTx(async () => { throw pgErr({ code: '42501', table: 'roles', constraint: undefined }); }));
    await w.tx.query('INSERT x').catch(() => undefined); expect(w.diag()).toEqual({ code: '42501', schema: 'core', table: 'roles' });
  });
  it('the FIRST failure wins: a later 25P02 in the aborted transaction does not hide the cause', async () => {
    const { captureDbErrors } = await import('../../cli/apply-role-pack.js');
    let n = 0; const w = captureDbErrors(fakeTx(async () => { throw n++ === 0 ? pgErr({ code: '42501', table: 'roles' }) : pgErr({ code: '25P02', table: undefined, schema: undefined, constraint: undefined }); }));
    await w.tx.query('a').catch(() => undefined); await w.tx.query('b').catch(() => undefined); expect(w.diag()).toMatchObject({ code: '42501', table: 'roles' });
  });
  it('an error without a SQLSTATE (network, plain Error, string) records nothing and is rethrown unchanged', async () => {
    const { captureDbErrors } = await import('../../cli/apply-role-pack.js');
    for (const bad of [new Error('socket hang up'), 'boom', Object.assign(new Error('x'), { code: 'ECONNRESET' })]) {
      const w = captureDbErrors(fakeTx(async () => { throw bad; })); await expect(w.tx.query('q')).rejects.toBe(bad); expect(w.diag()).toBeUndefined();
    }
  });
  it('fields that are not plain identifiers are dropped (newline, spaces, quotes, too long, wrong type): a row value can never ride in', async () => {
    const { captureDbErrors } = await import('../../cli/apply-role-pack.js');
    const w = captureDbErrors(fakeTx(async () => { throw pgErr({ schema: 'core\nat evil', table: `roles (${SECRET_VALUE})`, constraint: 'x'.repeat(200) }); }));
    await w.tx.query('q').catch(() => undefined); expect(w.diag()).toEqual({ code: '23503' });
    const w2 = captureDbErrors(fakeTx(async () => { throw pgErr({ code: '42501; DROP', table: 5, schema: {}, constraint: null }); }));
    await w2.tx.query('q').catch(() => undefined); expect(w2.diag()).toBeUndefined();
  });
  it('other properties of the transaction stay reachable through the wrapper', () => {
    return import('../../cli/apply-role-pack.js').then(({ captureDbErrors }) => { const t = fakeTx(async () => ({ rows: [] })); expect((captureDbErrors(t).tx as any).marker).toBe('m1'); });
  });

  it('main prints the `db:` line right after the failed line: sqlstate, schema.table, constraint; the row value appears nowhere', async () => {
    const { captureDbErrors } = await import('../../cli/apply-role-pack.js');
    const w0 = mk(); const cap = captureDbErrors(fakeTx(async () => { throw pgErr(); }));
    const deps = { ...w0.deps, dbDiag: cap.diag, apply: vi.fn(async () => { try { await cap.tx.query('INSERT x', [SECRET_VALUE]); } catch { throw Object.assign(new Error('common.not_found'), { code: 'common.not_found' }); } return { created: [], updated: [], unchanged: [] }; }) };
    expect(await main(base, deps as any)).toBe(1);
    expect(w0.err().split('\n').filter(Boolean)).toEqual(['apply-role-pack failed: common.not_found', 'db: 23503 core.role_permissions role_permissions_permission_code_fkey']);
    expect(w0.err() + w0.out()).not.toContain(SECRET_VALUE); expect(w0.out()).toBe('');
  });
  it('a missing constraint / table prints `-` in its place; no code means no db line', async () => {
    const w = mk(async () => { throw new Error('boom'); });
    expect(await main(base, { ...w.deps, dbDiag: () => ({ code: '42501', schema: 'core', table: 'roles' }) } as any)).toBe(1);
    expect(w.err().split('\n').filter(Boolean)[1]).toBe('db: 42501 core.roles -');
    const w2 = mk(async () => { throw new Error('boom'); });
    expect(await main(base, { ...w2.deps, dbDiag: () => ({ code: '42501' }) } as any)).toBe(1); expect(w2.err().split('\n').filter(Boolean)[1]).toBe('db: 42501 -.- -');
    for (const d of [undefined, {}, { table: 'roles' }]) { const w3 = mk(async () => { throw new Error('boom'); }); await main(base, { ...w3.deps, dbDiag: () => d } as any); expect(w3.err()).not.toMatch(/db:/); }
  });
  it('the db line is bounded and clean even if dbDiag misbehaves (hostile strings, throws): still exit 1, never a crash, never a stack', async () => {
    const w = mk(async () => { throw new Error('boom'); });
    expect(await main(base, { ...w.deps, dbDiag: () => ({ code: '42501', schema: 'core\nat evil (/x.js:1:1)', table: 'r'.repeat(5000), constraint: SECRET_VALUE }) } as any)).toBe(1);
    expect(w.err().split('\n').filter(Boolean)).toHaveLength(2); expect(w.err().length).toBeLessThan(400); expect(w.err()).not.toMatch(/evil|\bat \w|rrrrr/);
    const w2 = mk(async () => { throw new Error('boom'); });
    expect(await main(base, { ...w2.deps, dbDiag: () => { throw new Error('diag exploded'); } } as any)).toBe(1); expect(w2.err()).toMatch(/^apply-role-pack failed: boom/); expect(w2.err()).not.toMatch(/exploded/);
  });
  it('--add-missing failures (exit 1) and --list failures print the db line too; a success prints none', async () => {
    const diag = () => ({ code: '42501', schema: 'core', table: 'roles', constraint: 'roles_pkey' });
    const a = mk(); const am = vi.fn(async () => { throw new Error('boom'); });
    expect(await main([...base, '--add-missing', 'corp_admin', '--yes'], { ...a.deps, addMissing: am, dbDiag: diag } as any)).toBe(1); expect(a.err()).toContain('db: 42501 core.roles roles_pkey');
    const ok = mk(); expect(await main(base, { ...ok.deps, dbDiag: diag } as any)).toBe(0); expect(ok.err()).toBe('');
  });
  it('the entry point wraps the transaction handed to the service, does not touch core/, prints no message / detail / parameters, cites LD-265', () => {
    const src = readFileSync(join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity', 'cli', 'apply-role-pack.ts'), 'utf8');
    expect(src).toMatch(/captureDbErrors\(tx\)/); expect(src).toMatch(/dbDiag/); expect(src).toMatch(/LD-265/);
    expect(src).not.toMatch(/\.(detail|hint|where|parameters)\b/);
    expect(src).not.toMatch(/process\.exit\s*\(|process\.env\./);
  });
});
