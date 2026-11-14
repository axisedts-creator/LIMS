// T-36 (C3) — AC-11.5 / S-17: CI job `c3-wording-commission` = `bash services/api/src/modules/catalog/__tests__/ci/wording-grep.sh` (02-TRD §13, CR-C3-009).
// The script is real and runnable (tests/ci path owned by this task); this file proves it: clean repo -> 0; the word planted in ANY trigger path (any case,
// incl. the worker xlsx template dir) -> non-zero with the file named; test files and other chunks' paths are not scanned; absent trigger dirs are tolerated.
// Planting is done in a throw-away mirror tree (script copied to the same relative location), never in the repository.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const REL = 'services/api/src/modules/catalog/__tests__/ci/wording-grep.sh';
const SCRIPT = join(REPO_ROOT, REL);
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const TRIGGERS = [
  'services/api/src/modules/catalog', 'services/worker/src/jobs/catalog', 'apps/web/src/features/catalog', 'apps/web/src/app/(staff)/catalog', 'docs/manual/catalog',
];
const fwd = (p: string) => p.replaceAll('\\', '/');
const run = (script: string) => spawnSync(BASH, [fwd(script)], { encoding: 'utf8', timeout: 60_000 });

const roots: string[] = [];
function mirror(): string {
  const root = mkdtempSync(join(tmpdir(), 'c3-wording-'));
  roots.push(root);
  mkdirSync(dirname(join(root, REL)), { recursive: true });
  cpSync(SCRIPT, join(root, REL));
  for (const t of TRIGGERS) { mkdirSync(join(root, t), { recursive: true }); writeFileSync(join(root, t, 'clean.ts'), 'export const ok = 1;\n'); }
  return root;
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const plant = (root: string, rel: string, text = 'const x = "Commission rate";\n') => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel, ''), text); };

describe('AC-11.5 / S-17: wording-grep.sh', () => {
  it('the script exists at the path the TRD CI job names, starts with a bash shebang and names all five trigger paths', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text.startsWith('#!')).toBe(true);
    for (const t of TRIGGERS) expect(text, t).toContain(t);
    expect(text).toMatch(/grep\s+-[a-zA-Z]*r[a-zA-Z]*i|grep\s+-[a-zA-Z]*i[a-zA-Z]*r/);   // recursive + case-insensitive (04 L19)
  });

  it('the real repository is clean: exit 0, no output', () => {
    const r = run(SCRIPT);
    expect(r.error).toBeUndefined();
    expect({ status: r.status, out: r.stdout.trim() }).toEqual({ status: 0, out: '' });
  }, 60_000);

  it('a clean mirror passes; trigger directories that do not exist (docs/manual/catalog) are tolerated', () => {
    const root = mirror();
    expect(run(join(root, REL)).status).toBe(0);
    rmSync(join(root, 'docs'), { recursive: true, force: true });
    expect(run(join(root, REL)).status).toBe(0);
  }, 60_000);

  it.each([
    ...TRIGGERS.map((t) => [t, `${t}/offender.ts`] as const),
    ['worker xlsx templates (template texts are covered)', 'services/worker/src/jobs/catalog/xlsx/templates/referrers.ts'],
    ['nested module path', 'services/api/src/modules/catalog/service/deep/er/x.ts'],
    ['a generated sheet label in a .json', 'apps/web/src/features/catalog/labels.json'],
  ] as const)('the word planted in %s -> exit 1 and the file is named', (_n, rel) => {
    const root = mirror();
    for (const variant of ['Commission rate', 'COMMISSION', 'commission', 'referral commission %']) {
      plant(root, rel, `const x = "${variant}";\n`);
      const r = run(join(root, REL));
      expect(r.status, variant).toBe(1);
      expect(r.stdout, variant).toContain(rel.split('/').pop()!);
    }
  }, 60_000);

  it('test files / __tests__ trees quote the word legitimately and are not scanned; other chunks’ paths are out of scope', () => {
    const root = mirror();
    plant(root, 'services/api/src/modules/catalog/__tests__/probes/x.ts');
    plant(root, 'services/api/src/modules/catalog/service/x.test.ts');
    plant(root, 'apps/web/src/features/catalog/y.spec.tsx');
    plant(root, 'services/api/src/modules/billing/z.ts');
    plant(root, 'spec/chunks/C3-catalog-pricing/04-UI.md');
    const r = run(join(root, REL));
    expect({ status: r.status, out: r.stdout.trim() }).toEqual({ status: 0, out: '' });
  }, 60_000);

  it('word-boundary neighbours that are not the word do not trip it (co-mission, committee)', () => {
    const root = mirror();
    plant(root, 'services/api/src/modules/catalog/ok.ts', '// co-mission, committee, commit\n');
    expect(run(join(root, REL)).status).toBe(0);
  }, 60_000);
});
