// WEB-BUILD-2 static guard (LD-195, 2026-11-15). No build, no network. Run: .orchestra/notes/WEB-BUILD-2-verify.cmd
//   (a) next build type-checks with tsconfig.build.json (tests excluded); tsconfig.json + typecheck script stay as they are
//   (b) the two catalog Combobox calls must not pass the AbortSignal into searchOrderablesAction (server action takes (q, kind?))
//   (c) PriceListDetail Code field maxLength 32 (contracts/openapi/catalog.yaml PriceList.code)
//   (d) packages/ui TextField inputMode union contains 'decimal' and reaches the <input>
//   (e) no ignoreBuildErrors / @ts-ignore / @ts-expect-error in non-test apps/web or packages/ui sources
// Planted-failure fixtures prove each scanner fires on the old form.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(fileURLToPath(new URL('../../', import.meta.url))); // apps/web/
const repo = resolve(web, '..', '..');
const ui = join(repo, 'packages', 'ui', 'src');
const read = (p: string): string => readFileSync(p, 'utf8');

// ---------- scanners ----------

/** Parse JSON-with-comments (tsconfig style). Strings are skipped so "src/**" is not taken for a comment. */
function parseJsonc(src: string): any {
  const noComments = src.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, s) => s ?? '');
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
}

/** Every Combobox loadOptions={...} expression found in a source (expression has no braces of its own). */
const loadOptionsExprs = (src: string): string[] => [...src.matchAll(/\bloadOptions=\{([^{}]*)\}/g)].map((m) => (m[1] ?? '').trim());

/** Violations: loadOptions given searchOrderablesAction directly, or a wrapper that forwards anything but the query alone. */
function searchSignalViolations(src: string): string[] {
  const bad: string[] = [];
  for (const e of loadOptionsExprs(src)) {
    if (!/searchOrderablesAction/.test(e)) continue;
    if (/^searchOrderablesAction$/.test(e)) { bad.push(`passes searchOrderablesAction directly: ${e}`); continue; }
    // allowed: (q) => searchOrderablesAction(q)  |  (q: string) => searchOrderablesAction(q)  |  q => searchOrderablesAction(q)
    const ok = e.match(/^\(?\s*(\w+)\s*(?::\s*string\s*)?\)?\s*=>\s*searchOrderablesAction\(\s*\1\s*\)$/);
    if (!ok) bad.push(`wrapper forwards more than the query: ${e}`);
  }
  return bad;
}

/** The props text of every <TextField ... /> element that has name="<name>". */
function textFieldProps(src: string, name: string): string[] {
  const out: string[] = [];
  for (const seg of src.split(/<TextField\b/).slice(1)) {
    const end = seg.search(/\/>|<\/TextField>/);
    const props = end < 0 ? seg : seg.slice(0, end);
    if (new RegExp(`\\bname="${name}"`).test(props)) out.push(props);
  }
  return out;
}

/** String members of the `inputMode?: 'a' | 'b'` union declared in a props interface. */
function inputModeUnion(src: string): string[] {
  const m = src.match(/\binputMode\?:\s*([^;]+);/);
  return m ? [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string) : [];
}

const isTestPath = (p: string): boolean => /[\\/]__tests__[\\/]|\.(test|spec)\.tsx?$/.test(p);
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.next') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|json)$/.test(n) && !isTestPath(p)) out.push(p);
  }
  return out;
}
const suppressions = (src: string): string[] => [...src.matchAll(/@ts-ignore|@ts-expect-error|ignoreBuildErrors/g)].map((m) => m[0]);

// ---------- scanner self-tests (planted failures) ----------

describe('scanners fire on the old form (planted failures)', () => {
  const OLD = '<Combobox<O> label="x" onChange={f} loadOptions={searchOrderablesAction} getKey={(o) => o.id} />';
  const NEW = '<Combobox<O> label="x" onChange={f} loadOptions={(q) => searchOrderablesAction(q)} getKey={(o) => o.id} />';
  it('direct pass-through is flagged', () => expect(searchSignalViolations(OLD)).toHaveLength(1));
  it('wrapper forwarding the signal or a kind is flagged', () => {
    expect(searchSignalViolations('<C loadOptions={(q, signal) => searchOrderablesAction(q, signal)} />')).toHaveLength(1);
    expect(searchSignalViolations("<C loadOptions={(q) => searchOrderablesAction(q, 'test')} />")).toHaveLength(1);
    expect(searchSignalViolations("<C loadOptions={(q) => searchOrderablesAction('x')} />")).toHaveLength(1);
  });
  it('query-only wrapper passes', () => {
    expect(searchSignalViolations(NEW)).toEqual([]);
    expect(searchSignalViolations('<C loadOptions={(q: string) => searchOrderablesAction(q)} />')).toEqual([]);
  });
  it('TextField scanner: old Code field has no maxLength, fixed one has 32', () => {
    const oldF = '<TextField label="Code" name="code" isReadOnly value={priceList.code} />';
    const newF = '<TextField label="Code" name="code" maxLength={32} isReadOnly value={priceList.code} />';
    expect(textFieldProps(oldF, 'code')[0]).not.toMatch(/maxLength=\{32\}/);
    expect(textFieldProps(newF, 'code')[0]).toMatch(/maxLength=\{32\}/);
    expect(textFieldProps(oldF + '<TextField name="name" maxLength={120} onChange={(v) => x(v)} />', 'name')[0]).toMatch(/maxLength=\{120\}/);
  });
  it('inputMode union scanner', () => {
    expect(inputModeUnion("inputMode?: 'text' | 'numeric' | 'tel' | 'email';")).not.toContain('decimal');
    expect(inputModeUnion("inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email';")).toContain('decimal');
  });
  it('suppression scanner', () => {
    expect(suppressions('// @ts-ignore\nx')).toHaveLength(1);
    expect(suppressions('typescript: { ignoreBuildErrors: true }')).toHaveLength(1);
    expect(suppressions('const ok = 1;')).toEqual([]);
  });
  it('jsonc parser keeps globs and drops comments', () => {
    expect(parseJsonc('{ /* c */ "a": ["src/**/*.ts"], // t\n "b": 1, }')).toEqual({ a: ['src/**/*.ts'], b: 1 });
  });
});

// ---------- repo guards ----------

describe('(a) build tsconfig excludes tests; dev tsconfig and typecheck unchanged', () => {
  const buildPath = join(web, 'tsconfig.build.json');
  it('tsconfig.build.json exists and extends ./tsconfig.json', () => {
    expect(existsSync(buildPath)).toBe(true);
    expect(parseJsonc(read(buildPath)).extends).toBe('./tsconfig.json');
  });
  it('tsconfig.build.json excludes node_modules and every test glob', () => {
    const ex: string[] = parseJsonc(read(buildPath)).exclude ?? [];
    for (const g of ['node_modules', 'src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.spec.ts', 'src/**/*.spec.tsx']) expect(ex, g).toContain(g);
  });
  it('tsconfig.build.json does not widen include or switch off checking', () => {
    const j = parseJsonc(read(buildPath));
    if (j.include) for (const i of j.include as string[]) expect(i).not.toMatch(/__tests__|\.test\.|\.spec\./);
    expect(JSON.stringify(j.compilerOptions ?? {})).not.toMatch(/"noCheck"|"strict"\s*:\s*false/);
  });
  it('next.config.mjs sets typescript.tsconfigPath to tsconfig.build.json (and no ignoreBuildErrors)', () => {
    const cfg = read(join(web, 'next.config.mjs'));
    expect(cfg).toMatch(/typescript\s*:\s*\{[^}]*tsconfigPath\s*:\s*['"]tsconfig\.build\.json['"]/);
    expect(cfg).not.toMatch(/ignoreBuildErrors/);
  });
  it('tsconfig.json still includes src/**/*.ts and src/**/*.tsx and does not exclude tests', () => {
    const j = parseJsonc(read(join(web, 'tsconfig.json')));
    expect(j.include).toContain('src/**/*.ts');
    expect(j.include).toContain('src/**/*.tsx');
    expect(JSON.stringify(j.exclude)).not.toMatch(/test|spec|__tests__/);
  });
  it('typecheck script still runs tsc -p tsconfig.json --noEmit', () => {
    expect(parseJsonc(read(join(web, 'package.json'))).scripts.typecheck).toBe('pnpm run build:nav && tsc -p tsconfig.json --noEmit');
  });
});

describe('(b) catalog search box does not hand the AbortSignal to the server action', () => {
  for (const f of ['SurchargeRulesScreen.tsx', 'TaxScreen.tsx']) {
    const src = read(join(web, 'src', 'features', 'catalog', 'components', f));
    it(`${f}: still has the Combobox search`, () => expect(loadOptionsExprs(src).some((e) => /searchOrderablesAction/.test(e))).toBe(true));
    it(`${f}: loadOptions is not searchOrderablesAction and forwards the query only`, () => expect(searchSignalViolations(src)).toEqual([]));
  }
});

describe('(c) PriceListDetail Code field', () => {
  it('has maxLength={32}', () => {
    const fields = textFieldProps(read(join(web, 'src', 'features', 'catalog', 'components', 'PriceListDetail.tsx')), 'code');
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatch(/\bmaxLength=\{32\}/);
  });
});

describe('(d) TextField accepts inputMode decimal and forwards it', () => {
  it('TextFieldProps inputMode union has decimal and keeps text/numeric/tel/email', () => {
    expect(inputModeUnion(read(join(ui, 'components', 'TextField', 'TextField.tsx'))).sort()).toEqual(['decimal', 'email', 'numeric', 'tel', 'text']);
  });
  it('TextInputBase accepts decimal and sets inputMode on the input element', () => {
    const base = read(join(ui, 'components', '_shared', 'TextInputBase.tsx'));
    expect(inputModeUnion(base)).toContain('decimal');
    expect(base).toMatch(/inputMode:\s*p\.inputMode/);
  });
});

describe('(e) no error suppression in shipped sources', () => {
  it('apps/web/src, web config and packages/ui/src (non-test) have no ts suppression or ignoreBuildErrors', () => {
    const files = [...walk(join(web, 'src')), ...walk(ui), join(web, 'next.config.mjs'), join(web, 'tsconfig.json'), join(web, 'tsconfig.build.json')].filter(existsSync);
    const hits = files.flatMap((f) => suppressions(read(f)).map((s) => `${f.slice(repo.length + 1)}: ${s}`));
    expect(hits).toEqual([]);
  });
});
