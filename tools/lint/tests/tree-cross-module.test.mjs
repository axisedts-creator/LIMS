// Runs the module-boundary rules (no-cross-module-import, no-foreign-schema-sql) over the real tree (02-CONVENTIONS §1.3, REQ-ARCH-076).
// rules.test.mjs proves the rules on fixtures only; nothing else applies them to real files.
// Run: node --test tools/lint/tests/tree-cross-module.test.mjs
//
// Existing violations are frozen in tree-cross-module.baseline.json. A new one fails; a fixed one must be removed from the
// baseline (stale entries fail too), so the list only shrinks. Source-file entries are debt to remove (each needs a port
// method or a shared helper); test-file entries share test harnesses across modules.
// Regenerate after fixing: UPDATE_BASELINE=1 node --test tools/lint/tests/tree-cross-module.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const RULES = ['no-cross-module-import', 'no-foreign-schema-sql'];
const checks = await Promise.all(RULES.map(async (r) => (await import(pathToFileURL(join(root, 'tools/lint/rules', `${r}.ts`)).href)).check));
const baselineUrl = new URL('./tree-cross-module.baseline.json', import.meta.url);

const ROOTS = ['services/api/src/modules', 'apps/web/src/features'];
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.([cm]?[jt]sx?|sql)$/.test(e.name)) yield p;
  }
}

const found = new Set();
for (const r of ROOTS) {
  for (const file of walk(join(root, r))) {
    const rel = relative(root, file).split(sep).join('/');
    // key has no line number, so unrelated edits to a file do not churn the baseline
    const source = readFileSync(file, 'utf8');
    for (const check of checks) for (const v of check(rel, source)) found.add(`${rel} :: ${v.rule}: ${v.message}`);
  }
}
const now = [...found].sort();
if (process.env.UPDATE_BASELINE === '1') writeFileSync(baselineUrl, `${JSON.stringify(now, null, 2)}\n`);
const baseline = JSON.parse(readFileSync(baselineUrl, 'utf8'));
const lines = (a) => a.join('\n');

test('no new module-boundary violation', () => {
  const added = now.filter((k) => !baseline.includes(k));
  assert.deepEqual(added, [], `new module-boundary violations (go through contracts/ports):\n${lines(added)}`);
});

test('baseline has no stale entry', () => {
  const stale = baseline.filter((k) => !found.has(k));
  assert.deepEqual(stale, [], `fixed, remove from tree-cross-module.baseline.json:\n${lines(stale)}`);
});
