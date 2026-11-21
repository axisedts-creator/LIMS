// SEC-ABUSE-1 / LD-237 (audit 2.4): ONE helper (core/api/client-context.ts) derives the client address for every BFF call. No other web source
// reads x-forwarded-for / x-real-ip / x-vercel-forwarded-for, and none splits a client-supplied list for "the first element".
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)); // apps/web/src
const HELPER = ['core', 'api', 'client-context.ts'].join(sep);
const files: string[] = [];
(function walk(d: string) {
  for (const n of readdirSync(d)) {
    const p = join(d, n); const s = statSync(p);
    if (s.isDirectory()) { if (n !== 'node_modules' && n !== '__tests__') walk(p); }
    else if (/\.(ts|tsx)$/.test(n) && !/\.(test|spec)\./.test(n)) files.push(p);
  }
})(ROOT);
const code = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');   // comments do not count

describe('single client-IP helper', () => {
  it('finds the web sources (guards the guard)', () => { expect(files.length).toBeGreaterThan(50); expect(files.some((f) => relative(ROOT, f) === HELPER)).toBe(true); });
  it('no source other than the helper reads an address header', () => {
    const offenders = files.filter((f) => relative(ROOT, f) !== HELPER && /x-real-ip|x-vercel-forwarded-for|['"`]x-forwarded-for['"`]/i.test(code(f))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
  it('the helper reads x-vercel-forwarded-for and x-real-ip, and never reads x-forwarded-for from the incoming request', () => {
    const src = code(join(ROOT, HELPER));
    expect(src).toMatch(/x-vercel-forwarded-for/); expect(src).toMatch(/x-real-ip/);
    expect(src).not.toMatch(/\.get\(\s*['"`]x-forwarded-for['"`]\s*\)/i);   // the OUTGOING header name may still appear as an object key
    expect(src).not.toMatch(/split\(\s*['"`],['"`]\s*\)/);
  });
  it('every BFF caller that forwards an address goes through the helper (clientContextHeaders / readClientContext)', () => {
    const users = files.filter((f) => /clientContextHeaders|readClientContext/.test(code(f))).map((f) => relative(ROOT, f));
    expect(users).toEqual(expect.arrayContaining([join('features', 'admin', 'auth', 'actions.ts'), join('core', 'api', 'server-fetch.ts')]));
  });
});
