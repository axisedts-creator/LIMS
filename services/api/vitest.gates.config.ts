// Gate split for pr.yml (02-TRD gate 4): `vitest run --config vitest.gates.config.ts --mode unit|integration`.
// A test file belongs to the integration gate when it needs a live dependency:
//   - its name says so (*.live.test.*, *.integration.test.*), or
//   - it, or a test helper it imports (relative imports, followed transitively), reads a LIMS_TEST_* connection variable.
// Everything else is the unit gate.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

const ROOT = import.meta.dirname;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|mjs|js)$/;
const BY_NAME = /\.(live|integration)\.test\./;
const LIVE_ENV = /LIMS_TEST_[A-Z0-9_]*(URL|PSQL|KEY)\b/;
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const SKIP_DIR = new Set(['node_modules', 'dist', '.turbo']);

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) yield* walk(join(dir, e.name)); } else if (TEST_FILE.test(e.name)) yield join(dir, e.name);
  }
}

// `./helpers.js` in a .ts source means helpers.ts (tools/node-ts/register.mjs convention); also plain and index forms.
function resolveImport(from: string, spec: string): string | undefined {
  const target = resolve(dirname(from), spec);
  const stem = target.replace(/\.(js|mjs)$/, '');
  for (const c of [target, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(target, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return undefined;
}

const memo = new Map<string, boolean>();
// Only test-side files are followed (paths under __tests__ or test-sweep): production sources never read LIMS_TEST_*.
function needsLive(file: string): boolean {
  const known = memo.get(file);
  if (known !== undefined) return known;
  memo.set(file, false); // cycle guard
  const source = readFileSync(file, 'utf8');
  let live = LIVE_ENV.test(source);
  if (!live) {
    for (const m of source.matchAll(IMPORT)) {
      const dep = resolveImport(file, m[1]!);
      if (dep && /[\\/](__tests__|test-sweep)[\\/]/.test(dep) && needsLive(dep)) { live = true; break; }
    }
  }
  memo.set(file, live);
  return live;
}

export function splitGates(): { unit: string[]; integration: string[] } {
  const unit: string[] = [];
  const integration: string[] = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join('/');
    (BY_NAME.test(rel) || needsLive(file) ? integration : unit).push(rel);
  }
  return { unit: unit.sort(), integration: integration.sort() };
}

export default defineConfig(({ mode }) => {
  if (mode !== 'unit' && mode !== 'integration') throw new Error('vitest.gates.config.ts: pass --mode unit or --mode integration');
  const gates = splitGates();
  return mergeConfig(base, {
    test: mode === 'unit'
      ? { exclude: [...configDefaults.exclude, ...gates.integration] }
      : { include: gates.integration },
  });
});
