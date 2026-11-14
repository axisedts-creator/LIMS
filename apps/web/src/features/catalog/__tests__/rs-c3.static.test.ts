// RS-C3 (LD-140; 10-DESIGN-SYSTEM s4/s6/s8) static checks, node environment.
//  1. No raw colour, pixel radius or inline style object under apps/web/src/features/catalog/** and apps/web/src/app/(staff)/catalog/**
//     (same detector rules as packages/ui/scripts/__tests__/no-raw-style-literals.test.ts; this task's paths only).
//  2. No emoji in the screens (s6: one stroke icon family, no emoji).
//  3. "No change to API calls, field names, validation, permissions or routes": features/catalog/server/** is byte-identical (LF-normalised),
//     the route tree is identical, and every screen imports exactly the same server-layer symbols as before the restyle
//     (baseline in rs-c3.baseline.json, captured before the restyle).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { featureDir, routeDir, routes, serverHashes, serverImports, walk, web } from './rs-c3.surface';

type Hit = { file: string; line: number; kind: string; text: string };
const nonZeroPx = (v: string) => [...v.matchAll(/(?<![\w.-])(\d*\.?\d+)px/g)].some((m) => parseFloat(m[1]!) !== 0);
function stripComments(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*(?:\/\/|\*)/.test(l) ? '' : l.replace(/(^|\s)\/\/.*$/, '$1')));
}
function scan(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  const lines = stripComments(text);
  const add = (i: number, kind: string) => hits.push({ file, line: i + 1, kind, text: lines[i]!.trim().slice(0, 110) });
  lines.forEach((l, i) => {
    if (/(?<![\w&.#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/.test(l)) add(i, 'hex-colour');
    if (/\b(?:rgba?|hsla?)\(\s*\d/.test(l)) add(i, 'colour-fn');
    const css = /border(?:-[a-z]+)*-radius\s*:\s*([^;}\n]+)/i.exec(l);
    if (css && nonZeroPx(css[1]!)) add(i, 'radius-px');
    const camel = /\bborder\w*Radius\s*:\s*([^,}\n]+)/.exec(l);
    if (camel && (nonZeroPx(camel[1]!) || (/^\s*\d*\.?\d+\s*$/.test(camel[1]!) && parseFloat(camel[1]!) !== 0))) add(i, 'radius-px');
    if (/\bstyle\s*=\s*["']/.test(l)) add(i, 'inline-style');
  });
  const joined = lines.join('\n');
  for (const m of joined.matchAll(/\bstyle\s*=\s*\{\s*\{/g)) add(joined.slice(0, m.index).split('\n').length - 1, 'inline-style');
  return hits;
}

const sourceFiles = () => [...walk(featureDir), ...walk(routeDir)].filter((f) => /\.(?:tsx?|css|scss)$/.test(f));
const baseline = JSON.parse(readFileSync(join(featureDir, '__tests__', 'rs-c3.baseline.json'), 'utf8')) as {
  serverHashes: Record<string, string>;
  routes: string[];
  serverImports: Record<string, string[]>;
};

describe('RS-C3 detector (self-check)', () => {
  it('flags the three banned things and ignores tokens and comments', () => {
    expect(scan('x.tsx', '<div style={{ gap: 1 }} />').map((h) => h.kind)).toEqual(['inline-style']);
    expect(scan('x.tsx', 'const c = "#1f7a4d";').map((h) => h.kind)).toEqual(['hex-colour']);
    expect(scan('x.css', '.a { border-radius: 8px; }').map((h) => h.kind)).toEqual(['radius-px']);
    expect(scan('x.tsx', "<div className=\"a\" data-x=\"var(--lims-space-2)\" /> // style={{ a: 1 }} #fff")).toEqual([]);
  });
});

describe('RS-C3 no raw colour, pixel radius or inline style under this task\'s paths (10-DESIGN-SYSTEM s6/s8, LD-140)', () => {
  it('scans a non-trivial number of files', () => {
    expect(sourceFiles().length).toBeGreaterThan(40);
  });
  it('has zero raw-style hits', () => {
    const hits = sourceFiles().flatMap((f) => scan(f.slice(web.length + 1).split('\\').join('/'), readFileSync(f, 'utf8')));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`)).toEqual([]);
  });
  it('has no emoji (10-DESIGN-SYSTEM s6: one stroke icon family)', () => {
    const hits = sourceFiles().flatMap((f) =>
      readFileSync(f, 'utf8').split('\n').flatMap((l, i) => (/\p{Extended_Pictographic}/u.test(l) ? [`${f.slice(web.length + 1).split('\\').join('/')}:${i + 1} ${l.trim().slice(0, 90)}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});

describe('RS-C3 behaviour is unchanged: API surface equals the pre-restyle baseline', () => {
  it('server layer (api-client usage, fields, validation, permissions) is byte-identical', () => {
    expect(serverHashes()).toEqual(baseline.serverHashes);
  });
  it('route tree is identical', () => {
    expect(routes()).toEqual(baseline.routes);
  });
  it('the screens still import exactly the same set of server-layer symbols (same actions and loaders are called)', () => {
    const all = (m: Record<string, string[]>) => [...new Set(Object.values(m).flat())].sort();
    expect(all(serverImports())).toEqual(all(baseline.serverImports));
  });
  it('every route page still imports its own loaders/actions (no page lost a call)', () => {
    const now = serverImports();
    for (const [file, syms] of Object.entries(baseline.serverImports).filter(([f]) => f.startsWith('app/'))) expect(now[file], file).toEqual(syms);
  });
});
