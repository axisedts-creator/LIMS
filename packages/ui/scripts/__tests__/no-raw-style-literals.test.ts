// T0D-UI-R07 (LD-140; 10-DESIGN-SYSTEM s7 + s8): lint test. No raw colours, pixel radii or inline style objects in
// apps/web/src, apps/portal/src, apps/partner/src and packages/ui-flutter/lib (generated token files excluded),
// except inside directories listed in packages/ui/scripts/raw-style-pending.json (one directory per line; the lead
// removes a line when that chunk's restyle task is done). The scanner lives here; the detector is unit-tested, a
// planted literal in a scratch tree must fail, and the real tree must be clean outside the pending list.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ui = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repo = join(ui, '..', '..');
const pendingFile = join(ui, 'scripts', 'raw-style-pending.json');

const ROOTS = ['apps/web/src', 'apps/portal/src', 'apps/partner/src', 'packages/ui-flutter/lib'];
const EXTS = /\.(?:tsx?|jsx?|mjs|cjs|css|scss|dart)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.dart_tool', '.next', '.turbo', 'coverage']);
// generated token outputs (tokens.g.dart etc.) legitimately hold raw values
const GENERATED = /(?:^|\/)(?:[\w.-]+\.g\.dart|tokens\.(?:g|generated)\.\w+)$/;

type Hit = { file: string; line: number; kind: string; text: string };

const nonZeroPx = (v: string) => [...v.matchAll(/(?<![\w.-])(\d*\.?\d+)px/g)].some((m) => parseFloat(m[1]!) !== 0);

/** Blank comment-only text but keep line numbers. */
function stripComments(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*(?:\/\/|\*)/.test(l) ? '' : l.replace(/(^|\s)\/\/.*$/, '$1')));
}

export function scanSource(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  const dart = file.endsWith('.dart');
  const lines = stripComments(text);
  const add = (i: number, kind: string) => hits.push({ file, line: i + 1, kind, text: lines[i]!.trim().slice(0, 120) });
  lines.forEach((l, i) => {
    if (dart) {
      if (/\bColor\(\s*0x[0-9a-fA-F]+\s*\)/.test(l)) add(i, 'hex-colour');
      if (/\bColor\.from(?:ARGB|RGBO)\(/.test(l)) add(i, 'colour-fn');
      const r = /\b(?:Border)?Radius\.(?:circular|elliptical)\(\s*(\d*\.?\d+)/.exec(l);
      if (r && parseFloat(r[1]!) !== 0) add(i, 'radius-px');
      return;
    }
    if (/(?<![\w&.#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/.test(l)) add(i, 'hex-colour');
    if (/\b(?:rgba?|hsla?)\(\s*\d/.test(l)) add(i, 'colour-fn');
    const css = /border(?:-[a-z]+)*-radius\s*:\s*([^;}\n]+)/i.exec(l);
    if (css && nonZeroPx(css[1]!)) add(i, 'radius-px');
    const camel = /\bborder\w*Radius\s*:\s*([^,}\n]+)/.exec(l);
    if (camel && (nonZeroPx(camel[1]!) || /^\s*\d*\.?\d+\s*$/.test(camel[1]!) && parseFloat(camel[1]!) !== 0)) add(i, 'radius-px');
    if (/\bstyle\s*=\s*["']/.test(l)) add(i, 'inline-style');
  });
  const joined = lines.join('\n');
  for (const m of joined.matchAll(/\bstyle\s*=\s*\{\s*\{/g)) {
    const i = joined.slice(0, m.index).split('\n').length - 1;
    add(i, 'inline-style');
  }
  return hits;
}

function* walk(abs: string, rel: string): Generator<[string, string]> {
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return; // root absent (e.g. scratch tree) is fine
  }
  for (const n of names.sort()) {
    const a = join(abs, n);
    const r = `${rel}/${n}`;
    if (statSync(a).isDirectory()) {
      if (!SKIP_DIRS.has(n)) yield* walk(a, r);
    } else if (EXTS.test(n) && !GENERATED.test(r)) yield [a, r];
  }
}

const covered = (file: string, pending: string[]) => pending.some((d) => file.startsWith(`${d}/`));

export function findViolations(root: string, pending: string[]): Hit[] {
  const out: Hit[] = [];
  for (const r of ROOTS)
    for (const [abs, rel] of walk(join(root, r), r))
      if (!covered(rel, pending)) out.push(...scanSource(rel, readFileSync(abs, 'utf8')));
  return out;
}

function loadPending(): string[] {
  const list = JSON.parse(readFileSync(pendingFile, 'utf8'));
  if (!Array.isArray(list) || list.some((d) => typeof d !== 'string')) throw new Error('pending list must be a JSON array of strings');
  return list;
}

const kinds = (file: string, text: string) => scanSource(file, text).map((h) => h.kind);

describe('detector (unit)', () => {
  it.each([
    ['a.css', '.x { color: #0E4B3B; }', 'hex-colour'],
    ['a.css', '.x { color: #fff; }', 'hex-colour'],
    ['a.tsx', "const c = '#F3F7F4cc';", 'hex-colour'],
    ['a.css', '.x { background: rgba(0, 0, 0, .5); }', 'colour-fn'],
    ['a.css', '.x { color: hsl(150 40% 20%); }', 'colour-fn'],
    ['a.css', '.x { border-radius: 8px; }', 'radius-px'],
    ['a.css', '.x { border-radius: 0 0 4px 4px; }', 'radius-px'],
    ['a.css', '.x { border-top-left-radius: 2.5px; }', 'radius-px'],
    ['a.tsx', 'const s = { borderRadius: 8 };', 'radius-px'],
    ['a.tsx', "const s = { borderRadius: '12px' };", 'radius-px'],
    ['a.tsx', 'const e = <div style={{ color: tone }} />;', 'inline-style'],
    ['a.tsx', 'const e = <div style={\n{ margin: 0 }} />;', 'inline-style'],
    ['a.dart', 'const k = Color(0xFF0E4B3B);', 'hex-colour'],
    ['a.dart', 'final k = Color.fromARGB(255, 14, 75, 59);', 'colour-fn'],
    ['a.dart', 'final r = BorderRadius.circular(16);', 'radius-px'],
    ['a.dart', 'final r = BorderRadius.all(Radius.circular(8.0));', 'radius-px'],
  ])('flags %s: %s', (file, src, kind) => {
    expect(kinds(file, src)).toContain(kind);
  });

  it.each([
    ['a.css', '.x { color: var(--color-accent); border-radius: var(--radius-md); }'],
    ['a.css', '.x { border-radius: 0; }'],
    ['a.css', '.x { border-radius: 50%; }'],
    ['a.css', '.x { padding: 8px; margin: 4px 8px; }'],
    ['a.tsx', 'const s = { borderRadius: 0 };'],
    ['a.tsx', "const s = { borderRadius: 'var(--radius-md)' };"],
    ['a.tsx', 'const e = <div className="card" />;'],
    ['a.tsx', '// color #fff, border-radius: 8px, style={{ a: 1 }}'],
    ['a.tsx', '/* #0E4B3B\n border-radius: 8px */\nconst a = 1;'],
    ['a.tsx', 'const b = 1; // see #123 and #fff'],
    ['a.tsx', "const href = 'https://x.test/#section';"],
    ['a.tsx', 'const n = "&#123; &#x1F600;";'],
    ['a.tsx', 'class A { #count = 1; get() { return this.#count; } }'],
    ['a.dart', 'final r = BorderRadius.circular(LimsRadius.md);'],
    ['a.dart', 'final k = LimsColors.accent;'],
    ['a.dart', '// Color(0xFF0E4B3B) BorderRadius.circular(8)'],
  ])('does not flag %s: %s', (file, src) => {
    expect(scanSource(file, src)).toEqual([]);
  });

  it('reports 1-based line numbers', () => {
    const h = scanSource('a.css', '.a {}\n\n.b { color: #abc; }');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ line: 3, kind: 'hex-colour' });
  });
});

describe('scan over a scratch tree (planted literals must fail)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'raw-style-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const put = (rel: string, body: string) => {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    writeFileSync(join(tmp, rel), body);
  };
  put('apps/web/src/clean/ok.tsx', 'export const A = () => <div className="card" />;\n');
  put('apps/web/src/planted/bad.tsx', 'export const A = () => <div style={{ color: "#ff0000" }} />;\n');
  put('apps/portal/src/p.css', '.x { border-radius: 6px; }\n');
  put('apps/partner/src/deep/er/q.css', '.x { color: #123456; }\n');
  put('packages/ui-flutter/lib/src/tokens.g.dart', 'const a = Color(0xFF0E4B3B);\nfinal r = BorderRadius.circular(16);\n');
  put('packages/ui-flutter/lib/src/hand.dart', 'const a = Color(0xFF0E4B3B);\n');
  put('apps/web/src/node_modules/x/y.css', '.x { color: #fff; }\n');
  put('packages/ui/src/inside-ui.css', '.x { color: #fff; border-radius: 8px; }\n'); // packages/ui is not scanned
  put('apps/bridge-agent/src/z.css', '.x { color: #fff; }\n'); // not a scanned root

  const files = (pending: string[]) => [...new Set(findViolations(tmp, pending).map((h) => h.file))].sort();

  it('with an empty pending list it fails on every planted literal', () => {
    expect(files([])).toEqual([
      'apps/partner/src/deep/er/q.css',
      'apps/portal/src/p.css',
      'apps/web/src/planted/bad.tsx',
      'packages/ui-flutter/lib/src/hand.dart',
    ]);
    const planted = findViolations(tmp, []).filter((h) => h.file === 'apps/web/src/planted/bad.tsx').map((h) => h.kind);
    expect(planted).toEqual(expect.arrayContaining(['hex-colour', 'inline-style']));
  });

  it('excludes generated token files, node_modules, packages/ui and unlisted roots', () => {
    const f = files([]);
    expect(f).not.toContain('packages/ui-flutter/lib/src/tokens.g.dart');
    expect(f.some((x) => x.includes('node_modules') || x.startsWith('packages/ui/') || x.startsWith('apps/bridge-agent'))).toBe(false);
  });

  it('a pending directory covers its subtree and nothing else', () => {
    expect(files(['apps/web/src/planted'])).not.toContain('apps/web/src/planted/bad.tsx');
    expect(files(['apps/web/src/planted'])).toContain('apps/portal/src/p.css');
    expect(files(['apps/partner/src'])).not.toContain('apps/partner/src/deep/er/q.css');
    expect(files(['apps/partner/src/deep'])).not.toContain('apps/partner/src/deep/er/q.css');
  });

  it('pending match is on path segments, not string prefix', () => {
    expect(files(['apps/web/src/plan'])).toContain('apps/web/src/planted/bad.tsx');
    expect(files(['apps/web/src/planted/bad.ts'])).toContain('apps/web/src/planted/bad.tsx');
  });

  it('with every offending directory pending it is clean', () => {
    expect(files(['apps/web/src/planted', 'apps/portal/src', 'apps/partner/src', 'packages/ui-flutter/lib'])).toEqual([]);
  });
});

describe('raw-style-pending.json', () => {
  it('exists and is a JSON array with one directory per line', () => {
    const text = readFileSync(pendingFile, 'utf8');
    const list = loadPending();
    expect(text.split('\n').filter((l) => /^\s*"[^"]+",?\s*$/.test(l))).toHaveLength(list.length);
  });

  it('lists repo-relative forward-slash directories inside the scanned roots, once each', () => {
    const list = loadPending();
    expect(new Set(list).size).toBe(list.length);
    for (const d of list) {
      expect(d, d).toMatch(/^[\w.@()[\]-]+(?:\/[\w.@()[\]-]+)*$/); // allows Next.js (group) and [param] segments; no backslash, ./, .., trailing slash, absolute path
      expect(d.split('/')).not.toContain('..');
      expect(ROOTS.some((r) => d === r || d.startsWith(`${r}/`)), `${d} is outside ${ROOTS.join(', ')}`).toBe(true);
      expect(statSync(join(repo, d)).isDirectory(), `${d} must be an existing directory`).toBe(true);
    }
  });

  it('never exempts packages/ui', () => {
    expect(loadPending().filter((d) => d.startsWith('packages/ui/') || d === 'packages/ui')).toEqual([]);
  });
});

describe('real tree (10-DESIGN-SYSTEM s7, s8)', () => {
  it('has no raw colour, pixel radius or inline style outside packages/ui and the pending directories', () => {
    const v = findViolations(repo, loadPending());
    const msg = v.slice(0, 25).map((h) => `${h.file}:${h.line} [${h.kind}] ${h.text}`).join('\n');
    expect(v, `${v.length} violation(s); add the directory to raw-style-pending.json or fix them:\n${msg}`).toEqual([]);
  }, 60_000);
});
