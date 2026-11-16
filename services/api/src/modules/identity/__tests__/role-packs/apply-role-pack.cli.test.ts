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
