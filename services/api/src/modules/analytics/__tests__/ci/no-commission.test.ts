// C8 AN-T10 — the CI gate script __tests__/ci/no-commission.sh (job c8-no-commission, CR-C8-015; PRD US-07.3, B13 "no payout features").
// Runs the script with bash against (a) the real repo (must be clean) and (b) scratch trees with planted violations. Synthetic files only.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
