// RS-C5 — static checks (no render). LD-140: no raw colour, pixel radius or inline style under this task's paths; no change to API calls, field names, validation, permissions or routes.
// Same detectors as packages/ui/scripts/__tests__/no-raw-style-literals.test.ts (T0D-UI-R07), applied to exactly the two RS-C5 path trees (the lead removes
// apps/web/src/features/lab from raw-style-pending.json when the task is done; this test does not depend on that edit).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');
const ROOTS = ['apps/web/src/features/lab', 'apps/web/src/app/(staff)/lab'];
const EXTS = /\.(?:tsx?|jsx?|css|scss)$/;
const nonZeroPx = (v: string) => [...v.matchAll(/(?<![\w.-])(\d*\.?\d+)px/g)].some((m) => parseFloat(m[1]!) !== 0);

function strip(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*(?:\/\/|\*)/.test(l) ? '' : l.replace(/(^|\s)\/\/.*$/, '$1')));
}
function scan(file: string, text: string): string[] {
  const out: string[] = [];
  const lines = strip(text);
  lines.forEach((l, i) => {
    const add = (kind: string) => out.push(`${file}:${i + 1} [${kind}] ${l.trim().slice(0, 100)}`);
    if (/(?<![\w&.#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/.test(l)) add('hex-colour');
    if (/\b(?:rgba?|hsla?)\(\s*\d/.test(l)) add('colour-fn');
    const css = /border(?:-[a-z]+)*-radius\s*:\s*([^;}\n]+)/i.exec(l);
    if (css && nonZeroPx(css[1]!)) add('radius-px');
    const camel = /\bborder\w*Radius\s*:\s*([^,}\n]+)/.exec(l);
    if (camel && (nonZeroPx(camel[1]!) || (/^\s*\d*\.?\d+\s*$/.test(camel[1]!) && parseFloat(camel[1]!) !== 0))) add('radius-px');
    if (/\bstyle\s*=\s*["']/.test(l)) add('inline-style');
  });
  const joined = lines.join('\n');
  for (const m of joined.matchAll(/\bstyle\s*=\s*\{\s*\{/g)) out.push(`${file}:${joined.slice(0, m.index).split('\n').length} [inline-style]`);
  return out;
}
function* walk(abs: string, rel: string): Generator<[string, string]> {
  for (const n of readdirSync(abs).sort()) {
    const a = join(abs, n);
    if (statSync(a).isDirectory()) {
      if (n !== '__tests__' && n !== 'node_modules') yield* walk(a, `${rel}/${n}`);
    } else if (EXTS.test(n)) yield [a, `${rel}/${n}`];
  }
}

describe('10-DESIGN-SYSTEM s7/s8 — no raw colour, pixel radius or inline style under the RS-C5 paths', () => {
  for (const root of ROOTS) {
    it(`${root}`, () => {
      const hits = [...walk(join(repo, root), root)].flatMap(([abs, rel]) => scan(rel, readFileSync(abs, 'utf8')));
      expect(hits, hits.join('\n')).toEqual([]);
    });
  }
  it('the detector sees a planted literal (guards the test itself)', () => {
    expect(scan('x.tsx', 'const a = <div style={{ color: "#0E4B3B" }} />;')).toHaveLength(2);
    expect(scan('x.tsx', "const s = '.a { border-radius: 8px }';")).toHaveLength(1);
    expect(scan('x.tsx', '// #fff style={{ a: 1 }}\nconst a = 1;')).toEqual([]);
  });
});

describe('LD-140 — no change to API calls, field names, validation, permissions or routes', () => {
  const baseline = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'rs-c5.baseline.json'), 'utf8')) as { server: Record<string, string>; routes: string[] };
  const hash = (f: string) => createHash('sha256').update(readFileSync(join(repo, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex');

  it('features/lab/server/** (the api-client: actions, BFF fetchers, DTO types) is byte-identical to the pre-restyle baseline', () => {
    const now = Object.fromEntries([...walk(join(repo, 'apps/web/src/features/lab/server'), 'apps/web/src/features/lab/server')].filter(([, r]) => /\.tsx?$/.test(r)).map(([, r]) => [r, hash(r)]));
    expect(now).toEqual(baseline.server);
  });

  it('the set of (staff)/lab page routes is unchanged (no route added, removed or renamed)', () => {
    const now = [...walk(join(repo, 'apps/web/src/app/(staff)/lab'), 'apps/web/src/app/(staff)/lab')].map(([, r]) => r).filter((r) => r.endsWith('/page.tsx')).sort();
    expect(now).toEqual(baseline.routes);
  });

  it('screens still gate on the same permission strings (every permission literal of the baseline components is still present)', () => {
    const perms = new Set<string>();
    for (const [abs] of walk(join(repo, 'apps/web/src/features/lab/components'), 'c')) for (const m of readFileSync(abs, 'utf8').matchAll(/'(lab\.[a-z_]+\.[a-z_]+)'/g)) perms.add(m[1]!);
    // the permissions the current screens check (04-UI-UX; 11-ROLE-MATRIX): losing one would silently show a screen to everyone
    for (const p of ['lab.specimen.receive', 'lab.specimen.reject', 'lab.specimen.read', 'lab.specimen.collect', 'lab.result.enter', 'lab.result.verify', 'lab.result.approve', 'lab.result.amend', 'lab.worksheet.manage'])
      expect(perms.has(p), p).toBe(true);
  });
});
