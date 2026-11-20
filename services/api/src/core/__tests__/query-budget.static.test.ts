// T0B-PERF-1 (done_when 3): the static half of the query budget. No repository / service file of identity, catalog,
// frontdesk or billing awaits a database call inside a loop (one query per row = N+1). Fix by one set-based statement
// (= ANY($1), a JOIN, or a lateral); the helper (query-budget.helpers.ts) is the rule and is never loosened here.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeStatements, expectListBudget, isControlStatement, normalizeSql, scanNPlusOne } from './query-budget.helpers.js';

const MODULES = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'modules');
const TARGETS = ['identity', 'catalog', 'frontdesk', 'billing'];

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p, out); } else if (/\.ts$/.test(n) && !/\.(test|spec)\.ts$/.test(n)) out.push(p);
  }
  return out;
}
const sources = TARGETS.flatMap((m) => walk(join(MODULES, m))).filter((f) => /[\\/](repository|repo|service|services)[\\/]/.test(f));

describe('query-budget helper (the rule itself)', () => {
  it('control statements are not counted, the endpoint queries are', () => {
    const r = analyzeStatements(['BEGIN', "SELECT set_config('request.jwt.claims', $1::text, true), now() AS tx_started_at", 'SELECT * FROM t WHERE id = $1', 'COMMIT']);
    expect(r.count).toBe(1);
    expect(isControlStatement('SAVEPOINT s1')).toBe(true);
  });
  it('an empty list inside the budget of 4 passes; 5 fails', () => {
    expect(() => expectListBudget(['SELECT 1 FROM a', 'SELECT 1 FROM b', 'SELECT 1 FROM c', 'SELECT 1 FROM d'])).not.toThrow();
    expect(() => expectListBudget(['SELECT 1 FROM a', 'SELECT 1 FROM b', 'SELECT 1 FROM c', 'SELECT 1 FROM d', 'SELECT 1 FROM e'])).toThrow(/5 queries/);
  });
  it('the same shape three times is an N+1 even under the count budget', () => {
    expect(normalizeSql("SELECT * FROM t WHERE id = 'a'")).toBe(normalizeSql('SELECT * FROM t WHERE id = $1'));
    expect(() => expectListBudget(['SELECT * FROM t WHERE id = $1', 'SELECT * FROM t WHERE id = $1', 'SELECT * FROM t WHERE id = $1'])).toThrow(/N\+1/);
  });
  it('the static scan flags a query awaited in a loop and in a map, not a hoisted one', () => {
    expect(scanNPlusOne('for (const id of ids) {\n  await tx.query("SELECT 1", [id]);\n}')).toHaveLength(1);
    expect(scanNPlusOne('ids.map(async (id) => {\n  return await tx.query("SELECT 1", [id]);\n})')).toHaveLength(1);
    expect(scanNPlusOne('const r = await tx.query("SELECT 1 WHERE id = ANY($1)", [ids]);\nfor (const row of r.rows) {\n  out.push(row.id);\n}')).toHaveLength(0);
  });
});

describe('no N+1 in the first-target modules (identity, catalog, frontdesk, billing)', () => {
  it('finds the source files to scan', () => { expect(sources.length).toBeGreaterThan(30); });

  it('no repository or service file awaits a database call inside a loop', () => {
    const found = sources.flatMap((f) => scanNPlusOne(readFileSync(f, 'utf8')).map((h) => `${relative(MODULES, f).replace(/\\/g, '/')}:${h.line}  ${h.loop}`));
    expect(found, `N+1 candidates (batch them with = ANY($1) or a join):\n${found.join('\n')}`).toEqual([]);
  });
});
