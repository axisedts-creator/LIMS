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
