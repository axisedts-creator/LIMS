// T0A-12 / 08 R12a, TRD §3.1 decimal row: exact decimal, >= 28 significant digits, half-up; library pinned by 0A within the licence allowlist.
// Spec names no function API for @lims/shared-ts/decimal, so arithmetic is proven through evaluateFormula (formula.test.mjs).
// ASSUMED: src/decimal/index.ts exists and exports at least one function; formula/ builds on it (no second decimal implementation).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('@lims/shared-ts/decimal', () => {
  it('module loads and exports at least one function', async () => {
    const m = await import(new URL('decimal/index.ts', SRC).href);
    assert.ok(Object.values(m).some((v) => typeof v === 'function'), `exports: ${Object.keys(m)}`);
  });
  it('is the only decimal arithmetic: formula/ imports ../decimal and not a decimal library directly', () => {
    const dir = new URL('formula/', SRC); const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length > 0, 'formula/ has sources');
    const all = files.map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
    assert.match(all, /from\s+['"]\.\.\/decimal(\/index(\.ts)?)?(\.ts)?['"]/, 'formula must use ../decimal');
    assert.doesNotMatch(all, /from\s+['"](decimal\.js|big\.js|bignumber\.js|decimal\.js-light|mathjs)/, 'no direct decimal lib in formula/');
  });
  it('package.json: every dependency is an exact pin (no ^ ~ ranges, no tags) — pinned decimal lib included', () => {
    // LD-40 (2026-11-07): internal pnpm `workspace:` links (LD-03) are not versions; PIN-C0 applies to external deps only.
    for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (v.startsWith('workspace:')) continue;
      assert.match(v, /^\d+\.\d+\.\d+$/, `${name}@${v}`);
    }
  });
  it('package.json: any decimal-capable dependency is a runtime dependency, not a dev one', () => {
    const dev = Object.keys(pkg.devDependencies ?? {});
    for (const n of dev) assert.doesNotMatch(n, /^(decimal\.js|big\.js|bignumber\.js|decimal\.js-light)$/, `${n} must be in dependencies`);
  });
});
