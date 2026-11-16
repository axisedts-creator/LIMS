// PLATFORM-WIRE-1 review item 2 (LD-271 option A): markAsserted (core/ports/authz-guard.ts) is exported from the shared core port, so the
// guard invariant "only a passed PlatformAuthz check marks a request asserted" holds only if platform/authz.ts is its single importer.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', '..'); // services/api/src
const ALLOWED = ['modules/identity/platform/authz.ts'];
const DEFINER = 'core/ports/authz-guard.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === 'dist') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(n)) out.push(p);
  }
  return out;
}
const isTest = (rel: string) => /(^|\/)__tests__\//.test(rel) || /\.(test|spec)\.[a-z]+$/.test(rel);

describe('markAsserted importers', () => {
  const files = walk(SRC).map((f) => ({ rel: relative(SRC, f).split(sep).join('/'), text: readFileSync(f, 'utf8') }));
  const users = files.filter((f) => !isTest(f.rel) && f.rel !== DEFINER && /\bmarkAsserted\b/.test(f.text)).map((f) => f.rel);

  it('the only non-test file that mentions markAsserted (besides its definition) is platform/authz.ts', () => {
    expect(users).toEqual(ALLOWED);
  });

  it('no file re-exports it (export ... markAsserted / export * from the guard) outside the definition', () => {
    const bad = files.filter((f) => !isTest(f.rel) && f.rel !== DEFINER && (/export\s*\{[^}]*\bmarkAsserted\b/.test(f.text) || /export\s*\*\s*from\s*['"][^'"]*authz-guard/.test(f.text))).map((f) => f.rel);
    expect(bad).toEqual([]);
  });

  it('no dynamic import or require of the guard module outside the allowed importer (cannot be reached around the static check)', () => {
    const bad = files.filter((f) => !isTest(f.rel) && f.rel !== DEFINER && !ALLOWED.includes(f.rel) && /(import\(|require\()\s*['"][^'"]*authz-guard/.test(f.text)).map((f) => f.rel);
    expect(bad).toEqual([]);
  });
});
