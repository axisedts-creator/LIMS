// C8 AN-T10 — the CI gate script __tests__/ci/no-commission.sh (job c8-no-commission, CR-C8-015; PRD US-07.3, B13 "no payout features").
// Runs the script with bash against (a) the real repo (must be clean) and (b) scratch trees with planted violations. Synthetic files only.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const WORD = ['commis', 'sion'].join('');                       // never spell the word in this file
const SCRIPT = fileURLToPath(new URL('./no-commission.sh', import.meta.url)).replace(/\\/g, '/');
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.env.BASH_EXE ?? (existsSync(GIT_BASH) ? GIT_BASH : 'bash');
const fwd = (p: string) => p.replace(/\\/g, '/');
const run = (root?: string) => spawnSync(BASH, root ? [SCRIPT, fwd(root)] : [SCRIPT], { encoding: 'utf8', timeout: 60_000 });

const PATHS = [
  'services/api/src/modules/analytics/handlers', 'services/worker/src/jobs/analytics/tasks', 'apps/web/src/features/analytics',
  'apps/web/src/app/(staff)/analytics', 'docs/manual/analytics', 'services/renderer/templates/analytics',
];
const roots: string[] = [];
function scratch(): string { const r = mkdtempSync(join(tmpdir(), 'lims-nocomm-')); roots.push(r); return r; }
function put(root: string, rel: string, text = 'synthetic content\n'): void { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('c8-no-commission script', () => {
  it('the real repo is clean: exit 0 (fails while any non-test C8 file mentions the word, even in a comment)', () => {
    const r = run();
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).not.toMatch(/no-commission: (content|file name):/);
    expect(r.status).toBe(0);
  });

  it('a tree without any C8 path, and a tree with clean files, exit 0', () => {
    expect(run(scratch()).status).toBe(0);
    const root = scratch();
    for (const p of PATHS) put(root, `${p}/ok.ts`, 'export const referral = "net billed";\n');
    expect(run(root).status).toBe(0);
  }, 60_000);

  it.each(PATHS)('content in %s → exit 1 and the file is named', (p) => {
    const root = scratch();
    put(root, `${p}/leak.txt`, `title: Agent ${WORD} report\n`);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('leak.txt');
  });

  it.each(['Upper', 'UPPER', 'MiXeD'])('case-insensitive (%s)', (kind) => {
    const root = scratch();
    const w = kind === 'Upper' ? WORD[0]!.toUpperCase() + WORD.slice(1) : kind === 'UPPER' ? WORD.toUpperCase() : WORD.replace(/./g, (c, i) => (i % 2 ? c : c.toUpperCase()));
    put(root, 'services/api/src/modules/analytics/mappers/x.ts', `// ${w}\n`);
    expect(run(root).status).toBe(1);
  });

  it('a file NAME containing the word fails even when its content is clean (export file names, templates)', () => {
    const root = scratch();
    put(root, `services/renderer/templates/analytics/${WORD}_summary.hbs`, 'clean\n');
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${WORD}_summary.hbs`);
  });

  it('a path with spaces/parentheses is scanned: apps/web/src/app/(staff)/analytics', () => {
    const root = scratch();
    put(root, `apps/web/src/app/(staff)/analytics/page with space.tsx`, `<h1>${WORD}</h1>\n`);
    expect(run(root).status).toBe(1);
  });

  it('__tests__ directories are skipped (tests assert absence of the word); the same text one level up fails', () => {
    const root = scratch();
    put(root, 'services/api/src/modules/analytics/handlers/__tests__/a.test.ts', `expect(x).not.toMatch(/${WORD}/i);\n`);
    put(root, 'services/worker/src/jobs/analytics/__tests__/b.test.ts', `${WORD}\n`);
    expect(run(root).status).toBe(0);
    put(root, 'services/api/src/modules/analytics/handlers/a.ts', `// ${WORD}\n`);
    expect(run(root).status).toBe(1);
  }, 60_000);

  it('outside the listed paths nothing is scanned (other modules may use the word)', () => {
    const root = scratch();
    put(root, 'services/api/src/modules/billing/x.ts', `${WORD}\n`);
    put(root, 'apps/web/src/features/billing/x.ts', `${WORD}\n`);
    expect(run(root).status).toBe(0);
  });

  it('an unreadable root is a tool error (exit 2), never a silent pass', () => {
    expect(run(join(scratch(), 'does-not-exist')).status).toBe(2);
  });
});

// ---------------------------------------------------------------- T0B-MISREPORTS-1 (LD-342 / A39-6f): the allow list no-commission.allow next to the script
const ALLOW_FILE = fileURLToPath(new URL('./no-commission.allow', import.meta.url));
const listed = (): string[] => readFileSync(ALLOW_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
/** A private copy of the script with its own allow file (so malformed lists can be tried without touching the real one). */
function withAllow(text: string): string {
  const dir = scratch();
  copyFileSync(fileURLToPath(new URL('./no-commission.sh', import.meta.url)), join(dir, 'no-commission.sh'));
  writeFileSync(join(dir, 'no-commission.allow'), text);
  return fwd(join(dir, 'no-commission.sh'));
}
const runWith = (script: string, root: string) => spawnSync(BASH, [script, fwd(root)], { encoding: 'utf8', timeout: 60_000 });

describe('c8-no-commission allow list (A39-6f)', () => {
  it('the shipped list exists, holds exact paths only, all under the scanned C8 paths', () => {
    expect(existsSync(ALLOW_FILE)).toBe(true);
    const entries = listed();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e, e).not.toMatch(/[*?]|\.\.|^\/|\/$|\\/);
      expect(PATHS.concat(['services/api/src/modules/analytics']).some((p) => e.startsWith(`${p}/`)), e).toBe(true);
      expect(e, e).not.toMatch(/__tests__/);
    }
    expect(new Set(entries).size).toBe(entries.length);
  });

  it('a listed file may hold the word: exit 0; the same text in a file that is not listed: exit 1 and the file is named', () => {
    const root = scratch();
    const first = listed()[0]!;
    put(root, first, `// ${WORD}\n`);
    expect(run(root).status).toBe(0);
    put(root, 'services/api/src/modules/analytics/domain/other.ts', `// ${WORD}\n`);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('other.ts');
    expect(r.stdout).not.toContain(first);
  }, 60_000);

  it('matching is exact: a sibling, a longer name and a different case of a listed path are not exempt', () => {
    const first = listed()[0]!;
    for (const variant of [`${first}.bak`, first.replace(/\.ts$/, '2.ts'), first.replace('/domain/', '/Domain/')]) {
      const root = scratch();
      put(root, variant, `// ${WORD}\n`);
      expect(run(root).status, variant).toBe(1);
    }
  }, 120_000);

  it('a listed file is exempt, its name too; any other file with the word in its name still fails', () => {
    const script = withAllow(`services/renderer/templates/analytics/${WORD}_summary.hbs\n`);
    const root = scratch();
    put(root, `services/renderer/templates/analytics/${WORD}_summary.hbs`, `${WORD}\n`);
    expect(runWith(script, root).status).toBe(0);
    put(root, `services/renderer/templates/analytics/${WORD}_other.hbs`, 'clean\n');
    const r = runWith(script, root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${WORD}_other.hbs`);
  }, 60_000);

  it('comments, blank lines, CRLF and surrounding spaces in the list are tolerated', () => {
    const script = withAllow('# comment\r\n\r\n   services/api/src/modules/analytics/domain/x.ts   \r\n');
    const root = scratch();
    put(root, 'services/api/src/modules/analytics/domain/x.ts', `${WORD}\n`);
    expect(runWith(script, root).status).toBe(0);
  }, 60_000);

  it.each([['a glob', 'services/api/src/modules/analytics/**'], ['a directory', 'services/api/src/modules/analytics/domain/'], ['a parent segment', 'services/api/../api/x.ts'],
    ['an absolute path', '/etc/passwd'], ['a question mark', 'services/api/src/modules/analytics/domain/x?.ts']])('a malformed entry (%s) is a tool error: exit 2, nothing passes silently', (_n, entry) => {
    const script = withAllow(`${entry}\n`);
    const root = scratch();
    put(root, 'services/api/src/modules/analytics/domain/x.ts', 'clean\n');
    const r = runWith(script, root);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/bad allow list entry/);
  }, 60_000);

  it('an empty list exempts nothing', () => {
    const script = withAllow('# nothing\n');
    const root = scratch();
    put(root, listed()[0]!, `${WORD}\n`);
    expect(runWith(script, root).status).toBe(1);
  }, 60_000);
});
