// T0D-FIX-1 item 6 (LD-446, CR DEPLOY-AXIS-012 items 4 and 5): source scan over services/api/src/modules (non-test files).
// (a) SCOPE: clock offenders must be EMPTY in the files this task owns (CLOCK_SCOPE). The rest of the tree has ~100 older `ctx.now().toISOString()` sites
//     (lab write paths, frontdesk, anatomic, identity: the host warned about them, CR DEPLOY-AXIS-012 item 4) that do not fit the task's 16 file cap; for those
//     the scan is a RATCHET: per file the count may only go down (fixtures/ctx-clock-baseline.json; lower the numbers by hand after a fix).
//     The left-over list is in .orchestra/notes/T0D-FIX-1-left.md. A lead decision is needed to turn the ratchet into "empty".
// (b) limit offenders must be EMPTY in the whole tree.
// Offender rules:
//   (a) a handler that calls .getTime() or .toISOString() on ctx.now() (the pipeline clock is an ISO string, so it throws): directly, or through a
//       variable assigned from `<x>.now()` / `nowOf(...)` without wrapping in new Date(...) / Date.parse(...) / String(...);
//   (b) a handler that reads `limit` only as a numeric string (the validator injects the number 50): `typeof <...limit...> === 'string'` on a line
//       that does not also accept 'number'.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MODULES = fileURLToPath(new URL('../../modules', import.meta.url));
const isTestPath = (p: string) => /(^|[\\/])(__tests__|tests?|fixtures)[\\/]/.test(p) || /\.(test|spec)\.ts$/.test(p) || /\.helpers?\.ts$/.test(p);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') sources(p, out); continue; }
    if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !isTestPath(p)) out.push(p);
  }
  return out;
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** `<ident>.now()` that is the ctx clock: not Date.now(), not performance.now(), not a fake/system clock helper. */
const CLOCK = String.raw`(?<![\w.])(?!Date\b|performance\b)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.now\(\)`;
const NOWOF = String.raw`\bnowOf\([^)]*\)`;

export function clockOffenders(file: string, text: string): string[] {
  const src = strip(text);
  const found: string[] = [];
  const lines = src.split('\n');
  const at = (re: RegExp) => lines.map((l, i) => (re.test(l) ? i + 1 : 0)).filter(Boolean);
  const direct = new RegExp(String.raw`(?:${CLOCK}|${NOWOF})\s*\.(?:getTime|toISOString)\(`);
  for (const n of at(direct)) found.push(`${file}:${n} method called on the clock result`);
  // variable assigned straight from the clock (not wrapped), then used with .getTime()/.toISOString()
  const assign = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:${CLOCK}|${NOWOF})\s*(?:;|,|$|\)|\?\?[^;]*;)`, 'gm');
  for (const m of src.matchAll(assign)) {
    const v = m[1]!;
    const use = new RegExp(String.raw`(?<![\w$.])${v.replace(/\$/g, '\\$')}\s*\.(?:getTime|toISOString)\(`);
    for (const n of at(use)) found.push(`${file}:${n} \`${v}\` comes from the clock and is used as a Date`);
  }
  return [...new Set(found)];
}

export function limitOffenders(file: string, text: string): string[] {
  const found: string[] = [];
  strip(text).split('\n').forEach((l, i) => {
    if (/typeof\s+[\w$.[\]'"]*limit[\w$\]'"]*\s*===\s*'string'/i.test(l) && /:\s*NaN\s*;?\s*$/.test(l) && !/'number'/.test(l)) found.push(`${file}:${i + 1} limit accepted only as a string`);
  });
  return found;
}

const files = sources(MODULES);
const BASELINE = fileURLToPath(new URL('./fixtures/ctx-clock-baseline.json', import.meta.url));
const CLOCK_SCOPE = [/^micro\/service\/chain\.service\.ts$/, /^smartreport\/handlers\/summaries\.ts$/, /^reporting\/handlers\/reports-read\.handlers\.ts$/, /^inventory\/handlers\/alerts/,
  /^catalog\/service\/tests\.service\.ts$/, /^catalog\/repo\/tests\.repo\.ts$/, /^lab\/service\/worklist\.service\.ts$/];
const inScope = (f: string) => CLOCK_SCOPE.some((re) => re.test(f));
const rel = (p: string) => relative(MODULES, p).replace(/\\/g, '/');

describe('source scan of services/api/src/modules (item 6)', () => {
  it('scans a real tree (guards against an empty scan)', () => { expect(files.length).toBeGreaterThan(300); });

  it('the detectors catch the known bad shapes (self check)', () => {
    expect(clockOffenders('x.ts', 'const now = c.now();\nconst a = now.getTime();')).toHaveLength(1);
    expect(clockOffenders('x.ts', 'const now = ctx.now(); f({ now: now.toISOString() });')).toHaveLength(1);
    expect(clockOffenders('x.ts', 'const t = c.now().getTime();')).toHaveLength(1);
    expect(clockOffenders('x.ts', 'const now = nowOf(c);\nconst filter = { now: now.toISOString() };')).toHaveLength(1);
    expect(limitOffenders('x.ts', "const raw = q.limit === undefined ? 50 : typeof q.limit === 'string' && /^[0-9]{1,4}$/.test(q.limit) ? Number(q.limit) : NaN;")).toHaveLength(1);
  });
  it('the detectors let the safe shapes through (self check)', () => {
    expect(clockOffenders('x.ts', 'const now = new Date(c.now());\nconst a = now.getTime();')).toEqual([]);
    expect(clockOffenders('x.ts', 'const now = Date.parse(String(c.now()));\nconst iso = new Date(now).toISOString();')).toEqual([]);
    expect(clockOffenders('x.ts', 'const t = Date.now();\nconst a = new Date(t).toISOString(); const p = performance.now();')).toEqual([]);
    expect(clockOffenders('x.ts', '// c.now().getTime() in a comment\nconst x = 1;')).toEqual([]);
    expect(limitOffenders('x.ts', "const n = typeof q.limit === 'number' ? q.limit : typeof q.limit === 'string' && /^\\d+$/.test(q.limit) ? Number(q.limit) : NaN;")).toEqual([]);
  });

  it('item 6a: no clock offender in the files of this task (micro, smartreport, reporting reads, inventory handlers, catalog tests, lab worklist)', () => {
    const bad = files.filter((f) => inScope(rel(f))).flatMap((f) => clockOffenders(rel(f), readFileSync(f, 'utf8')));
    expect(bad, `offenders:\n${bad.join('\n')}`).toEqual([]);
  });

  it('item 6a ratchet: elsewhere in the tree the count per file never goes up (older sites, see T0D-FIX-1-left.md)', () => {
    const cur: Record<string, number> = {};
    for (const f of files.filter((x) => !inScope(rel(x)))) { const n = clockOffenders(rel(f), readFileSync(f, 'utf8')).length; if (n) cur[rel(f)] = n; }
    expect(existsSync(BASELINE), 'baseline fixture missing').toBe(true);
    const base: Record<string, number> = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const worse = Object.entries(cur).filter(([f, n]) => n > (base[f] ?? 0)).map(([f, n]) => `${f}: ${n} > baseline ${base[f] ?? 0}`);
    expect(worse, `new ctx.now() Date uses:\n${worse.join('\n')}`).toEqual([]);
  });

  it('item 6b: no handler keeps the pattern `limit` accepted only as a numeric string', () => {
    const bad = files.flatMap((f) => limitOffenders(rel(f), readFileSync(f, 'utf8')));
    expect(bad, `offenders:\n${bad.join('\n')}`).toEqual([]);
  });
});
