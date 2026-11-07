// T0A-12 "lint bans module-local copies" (08 A13 P-9: "Module-local copies are banned (C3, C4, C8)").
// Run: node --test tools/lint/tests/spreadsheet-guard-ban.test.mjs
// ASSUMED (spec names no rule): tools/lint/rules/no-local-spreadsheet-guard.ts following the T0A-03 contract
//   export const name = 'no-local-spreadsheet-guard'; export function check(path, source): Array<{rule,line,message}>.
// Flags a declaration of neutraliseFormula / restoreNeutralised (also the US spelling neutralizeFormula) anywhere except packages/shared-ts/src/spreadsheet/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const RULE = 'no-local-spreadsheet-guard';
const load = async () => {
  const file = join(root, 'tools/lint/rules', `${RULE}.ts`);
  assert.ok(existsSync(file), `tools/lint/rules/${RULE}.ts must exist`);
  return import(pathToFileURL(file).href);
};
const API = 'services/api/src';
const bad = [
  [`${API}/modules/billing/domain/csv.ts`, 'export function neutraliseFormula(c: string): string { return c; }', 'C8-style local copy (domain/csv.ts#neutraliseFormula)'],
  [`${API}/modules/catalog/domain/xlsx.ts`, "export const neutraliseFormula = (c: string) => (/^[=+\\-@]/.test(c) ? \"'\" + c : c);", 'arrow const copy'],
  [`${API}/modules/billing/domain/x.ts`, 'function restoreNeutralised(c: string) { return c.slice(1); }', 'restore copy'],
  [`${API}/modules/billing/domain/x.ts`, 'const neutralizeFormula = (c) => c;', 'US spelling'],
  ['services/worker/src/modules/analytics/csv.ts', 'async function neutraliseFormula(c) { return c; }', 'async function'],
  ['apps/web/src/lib/csv.ts', 'export { neutraliseFormula };\nfunction neutraliseFormula(c) { return c; }', 'declaration on line 2'],
  ['packages/shared-ts/src/spreadsheet-extra/index.ts', 'export function neutraliseFormula(c: string) { return c; }', 'prefix lookalike of spreadsheet dir'],
  ['packages\\shared-ts\\src\\money\\m.ts', 'export function neutraliseFormula(c: string) { return c; }', 'backslash path, shared-ts but not spreadsheet/'],
];
const good = [
  ['packages/shared-ts/src/spreadsheet/index.ts', 'export function neutraliseFormula(c: string): string { return c; }\nexport function restoreNeutralised(c: string): string { return c; }', 'the one implementation'],
  ['packages\\shared-ts\\src\\spreadsheet\\index.ts', 'export function neutraliseFormula(c: string): string { return c; }', 'backslash path to the one implementation'],
  [`${API}/modules/billing/domain/csv.ts`, "import { neutraliseFormula } from '@lims/shared-ts/spreadsheet';\nconst out = rows.map((r) => neutraliseFormula(r));", 'import and call is the intended use'],
  [`${API}/modules/billing/domain/csv.ts`, "import { restoreNeutralised as restore } from '@lims/shared-ts/spreadsheet';", 'aliased import'],
  [`${API}/modules/billing/domain/csv.ts`, 'function neutraliseFormulaCount() { return 0; }', 'different identifier that merely contains the name'],
  [`${API}/modules/billing/domain/csv.ts`, '// we call neutraliseFormula() from the shared lib', 'mention in a comment'],
  [`${API}/modules/billing/domain/csv.ts`, '', 'empty file'],
];

test(`${RULE}: module-local copies are violations`, async () => {
  const { check, name } = await load(); assert.equal(name, RULE);
  for (const [p, src, why] of bad) {
    const v = check(p, src); assert.ok(v.length >= 1, `expected violation: ${why}`);
    assert.equal(v[0].rule, RULE); assert.ok(Number.isInteger(v[0].line) && v[0].line >= 1); assert.equal(typeof v[0].message, 'string');
  }
});
test(`${RULE}: clean files produce no violations`, async () => {
  const { check } = await load();
  for (const [p, src, why] of good) assert.deepEqual(check(p, src), [], why);
});
test(`${RULE}: message names the shared module`, async () => {
  const { check } = await load(); const [v] = check(bad[0][0], bad[0][1]);
  assert.match(v.message, /@lims\/shared-ts\/spreadsheet/);
});
test(`${RULE}: reports the line of the declaration`, async () => {
  const { check } = await load(); const [v] = check(bad[5][0], bad[5][1]); assert.equal(v.line, 2);
});

// Repo scan (works without the rule): no local copy exists in product code today.
test('repo scan: neutraliseFormula / restoreNeutralised declared only under packages/shared-ts/src/spreadsheet/', () => {
  const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'spec', '.orchestra', 'tests', 'test', '.dart_tool', '.turbo']);
  const DECL = /\b(function|const|let|var)\s+(neutrali[sz]eFormula|restoreNeutralised)\b/;
  const hits = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      if (SKIP.has(e)) continue;
      const p = join(d, e); const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(e)) continue;
      const rel = relative(root, p).replaceAll('\\', '/');
      if (rel.startsWith('packages/shared-ts/src/spreadsheet/')) continue;
      if (DECL.test(readFileSync(p, 'utf8'))) hits.push(rel);
    }
  })(root);
  assert.deepEqual(hits, []);
});
