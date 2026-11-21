// WEB-BUILD-1 static guard (LD-194, 2026-11-14): the class of error that failed `next build` on Vercel (deploy commit c8b8db1) must not return.
//   (a) a 'use server' file may export only async function declarations (types excluded)  -> "Server Actions must be async functions"
//   (b) a server entry (page.tsx / layout.tsx / route.ts under src/app) must not reach, through non-'use client' modules, a module that imports a React hook
//   (c) packages/ui DiffTable.tsx (uses useState) starts with 'use client'
//   (d) config.actions.ts keeps its export names; labels/page.tsx still gets the real NO_ACCESS string from a plain (non-client) module
// Static: no build, no network. Planted-failure fixtures prove the scanners fire. Run: .orchestra/notes/WEB-BUILD-1-verify.cmd
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(fileURLToPath(new URL('../../', import.meta.url))); // apps/web/
const webSrc = join(web, 'src');
const uiComponents = resolve(web, '..', '..', 'packages', 'ui', 'src', 'components');
const repo = resolve(web, '..', '..');

// ---------- scanners (pure; take source text or a virtual file reader) ----------

type Reader = (absPath: string) => string | undefined;
const realRead: Reader = (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } };

/** Source with block comments and whole-line // comments removed (enough for import / export scanning). */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** The leading directive ('use client' / 'use server') if it is the first statement, else undefined. */
const directive = (s: string): string | undefined => stripComments(s).trimStart().match(/^(['"])(use client|use server)\1/)?.[2];

/** (a) Every export of a 'use server' file must be `export async function name`. Types are fine. Returns one message per offending export. */
function serverActionViolations(src: string): string[] {
  if (directive(src) !== 'use server') return [];
  const bad: string[] = [];
  const text = stripComments(src);
  for (const m of text.matchAll(/^export\b([^\n]*)/gm)) {
    const rest = (m[1] ?? '').trim();
    if (/^async\s+function\b/.test(rest)) continue;
    // Next accepts an exported ASYNC arrow / function expression (catalog actions use it); the build error is for NON-async exports.
    if (/^const\s+\w+\s*(?::[^=]+)?=\s*async\b/.test(rest)) continue;
    if (/^(type|interface)\b/.test(rest)) continue;
    bad.push(`export ${rest.slice(0, 60)}`);
  }
  return bad;
}

const HOOKS = ['useState', 'useRef', 'useEffect', 'useReducer', 'useMemo', 'useCallback', 'useContext', 'useId', 'useLayoutEffect', 'useTransition', 'useOptimistic', 'useActionState'];

interface Imp { spec: string; hooks: string[] }
/** Runtime imports of a module (type-only imports are erased and skipped). hooks = React hooks named in this module's imports from 'react'. */
function importsOf(src: string): Imp[] {
  const text = stripComments(src);
  const out: Imp[] = [];
  for (const m of text.matchAll(/\bimport\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = (m[1] ?? '').trim();
    if (/^type\s/.test(clause)) continue;
    const spec = m[2] as string;
    const hooks: string[] = [];
    if (spec === 'react') {
      const named = clause.match(/\{([^}]*)\}/)?.[1] ?? '';
      for (const part of named.split(',')) {
        const p = part.trim();
        if (!p || /^type\s/.test(p)) continue;
        const name = (p.split(/\s+as\s+/)[0] as string).trim();
        if (HOOKS.includes(name)) hooks.push(name);
      }
      const ns = clause.replace(/\{[^}]*\}/, '').replace(/[,\s]+/g, ' ').trim(); // default / namespace binding
      if (ns && new RegExp(`\\b(?:${ns.split(' ').map((x) => x.replace(/^\*\s*as\s*/, '')).filter(Boolean).join('|')})\\.(${HOOKS.join('|')})\\b`).test(text)) {
        for (const h of HOOKS) if (new RegExp(`\\.${h}\\b`).test(text)) hooks.push(h);
      }
    }
    out.push({ spec, hooks: [...new Set(hooks)] });
  }
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push({ spec: m[1] as string, hooks: [] });
  for (const m of text.matchAll(/\bexport\s+(?!type\b)(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s*from\s*['"]([^'"]+)['"]/g)) out.push({ spec: m[1] as string, hooks: [] });
  return out;
}

const EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs'];
function resolveSpec(spec: string, from: string, read: Reader): string | undefined {
  let base: string | undefined;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@/')) base = join(webSrc, spec.slice(2));
  else {
    const ui = spec.match(/^@lims\/ui\/components\/([^/]+)$/);
    if (ui) base = join(uiComponents, ui[1] as string, ui[1] as string); // packages/ui exports "./components/*": "./src/components/*/*.tsx"
  }
  if (!base) return undefined; // external package
  for (const c of [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base as string, 'index' + e))]) {
    if (read(c) !== undefined) return c;
  }
  return undefined;
}

/** (b) Walk imports from the entries, stopping at 'use client' modules; report every reached module that imports a React hook. */
function hookViolations(entries: string[], read: Reader, rel: (p: string) => string = (p) => p): { violations: string[]; reached: Set<string> } {
  const reached = new Set<string>();
  const violations: string[] = [];
  const queue = entries.map((e) => ({ file: e, entry: e }));
  while (queue.length) {
    const { file, entry } = queue.shift() as { file: string; entry: string };
    if (reached.has(file)) continue;
    const src = read(file);
    if (src === undefined) continue;
    if (directive(src) === 'use client') continue; // a client boundary: its imports are client code
    reached.add(file);
    for (const imp of importsOf(src)) {
      for (const h of imp.hooks) violations.push(`${rel(file)} imports ${h} without 'use client' (reached from ${rel(entry)})`);
      const next = resolveSpec(imp.spec, file, read);
      if (next) queue.push({ file: next, entry });
    }
  }
  return { violations, reached };
}

// ---------- real-repo helpers ----------
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  if (n === '__tests__' || n === 'node_modules' || n === '.next') return [];
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const relRepo = (p: string) => relative(repo, p).replace(/\\/g, '/');
const srcFiles = walk(webSrc).filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.(test|spec)\./.test(f));
const entries = walk(join(webSrc, 'app')).filter((f) => /[\\/](page\.tsx|layout\.tsx|route\.ts)$/.test(f));

// ---------- planted-failure fixtures ----------
const V = resolve('/virt/apps/web/src'); // virtual web/src; '@/' maps to the real webSrc, so virtual specs use relative paths only
const virt = (files: Record<string, string>): Reader => {
  const m = new Map(Object.entries(files).map(([k, v]) => [resolve(V, k), v]));
  return (p) => m.get(resolve(p));
};
const at = (n: string) => resolve(V, n);

describe('WEB-BUILD-1 scanner self-tests (planted failures)', () => {
  it("(a) an exported arrow function returning a Promise in a 'use server' file is reported", () => {
    const src = "'use server';\nexport const getX = (): Promise<number> => run();\nexport async function ok() { return 1; }\n";
    expect(serverActionViolations(src)).toEqual(['export const getX = (): Promise<number> => run();']);
  });
  it("(a) non-async function, class, default and re-export in 'use server' are reported; async functions and types pass", () => {
    const bad = ["export function f() {}", 'export default async function () {}', 'export class C {}', "export { a } from './a';", 'export let n = 1;', 'export const g = () => 1;', 'export const h = (): Promise<number> => run();'];
    for (const b of bad) expect(serverActionViolations(`"use server"\n${b}\n`), b).toHaveLength(1);
    expect(serverActionViolations("'use server';\nexport const z = async (x: number) => x;\nexport async function a() {}\nexport type T = 1;\nexport interface I { x: 1 }\n")).toEqual([]);
  });
  it("(a) a file without the 'use server' directive is not checked; a directive after a comment header still counts", () => {
    expect(serverActionViolations("export const x = () => 1;\n")).toEqual([]);
    expect(serverActionViolations("// header\n/* c */\n'use server';\nexport const x = () => 1;\n")).toHaveLength(1);
    expect(serverActionViolations("import 'server-only';\n'use server';\nexport const x = () => 1;\n")).toEqual([]); // not the first statement = not a directive
  });
  it('(b) a server page that reaches a hook module without use client is reported, with the entry named', () => {
    const read = virt({
      'app/p/page.tsx': "import { A } from '../../lib/shared';\nexport default function P() { return A; }",
      'lib/shared.tsx': "import { useRef } from 'react';\nexport const A = 1;\nexport function useS() { return useRef(0); }",
    });
    const r = hookViolations([at('app/p/page.tsx')], read);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(/shared\.tsx imports useRef without 'use client' \(reached from .*page\.tsx\)/);
  });
  it('(b) hook found through two hops, aliased import, namespace use, and re-export are all reported', () => {
    const read = virt({
      'app/p/layout.tsx': "import { a } from '../../lib/a';\nexport default () => a;",
      'lib/a.ts': "export { b as a } from './b';",
      'lib/b.ts': "import { useState as us } from 'react';\nexport const b = us;",
      'app/r/route.ts': "import { c } from '../../lib/c';\nexport const GET = c;",
      'lib/c.tsx': "import React from 'react';\nexport const c = () => React.useEffect;",
    });
    const r = hookViolations([at('app/p/layout.tsx'), at('app/r/route.ts')], read);
    expect(r.violations.map((v) => v.split(' ')[0]).sort()).toEqual([resolve(V, 'lib/b.ts'), resolve(V, 'lib/c.tsx')].sort());
  });
  it("(b) traversal stops at a 'use client' module (its hooks and its imports are fine)", () => {
    const read = virt({
      'app/p/page.tsx': "import { Box } from '../../lib/box';\nexport default () => Box;",
      'lib/box.tsx': "'use client';\nimport { useState } from 'react';\nimport { deep } from './deep';\nexport const Box = useState(deep);",
      'lib/deep.ts': "import { useRef } from 'react';\nexport const deep = useRef;",
    });
    const r = hookViolations([at('app/p/page.tsx')], read);
    expect(r.violations).toEqual([]);
    expect(r.reached.has(at('lib/box.tsx'))).toBe(false);
    expect(r.reached.has(at('lib/deep.ts'))).toBe(false);
  });
  it('(b) type-only imports, comments mentioning hooks, and non-hook react imports are not violations', () => {
    const read = virt({
      'app/p/page.tsx': "import type { Foo } from '../../lib/hooky';\nimport { cache } from 'react';\n// import { useState } from 'react';\n/* import { useRef } from 'react'; */\nexport default () => cache;",
      'lib/hooky.ts': "import { useState } from 'react';\nexport type Foo = typeof useState;",
    });
    expect(hookViolations([at('app/p/page.tsx')], read).violations).toEqual([]);
  });
  it('(b) directory index and extension resolution follow the import', () => {
    const read = virt({
      'app/p/page.tsx': "import { x } from '../../lib/dir';\nexport default () => x;",
      'lib/dir/index.ts': "import { useId } from 'react';\nexport const x = useId;",
    });
    expect(hookViolations([at('app/p/page.tsx')], read).violations).toHaveLength(1);
  });
});

describe('WEB-BUILD-1 repo guards', () => {
  it("(a) every 'use server' file under apps/web/src exports only async function declarations", () => {
    const server = srcFiles.filter((f) => directive(readFileSync(f, 'utf8')) === 'use server');
    expect(server.length).toBeGreaterThan(5); // sanity: the scan really sees the action files
    const bad = server.flatMap((f) => serverActionViolations(readFileSync(f, 'utf8')).map((v) => `${relRepo(f)}: ${v}`));
    expect(bad).toEqual([]);
  });

  it("(b) no module reached from a page.tsx / layout.tsx / route.ts (stopping at 'use client') imports a React hook", () => {
    expect(entries.length).toBeGreaterThan(20); // sanity
    const { violations, reached } = hookViolations(entries, realRead, relRepo);
    expect(reached.size).toBeGreaterThan(entries.length); // sanity: imports were followed
    expect([...new Set(violations)].sort()).toEqual([]);
  });

  it("(b) the two failing spots are on the walked graph: labels page reaches shared.tsx (server-safe); audit page imports DiffTable, which is a 'use client' boundary and so is NOT reached", () => {
    const labels = join(webSrc, 'app', '(staff)', 'lab', 'orders', '[order_id]', 'labels', 'page.tsx');
    const audit = join(webSrc, 'app', '(staff)', 'admin', 'audit', '[audit_id]', 'page.tsx');
    const { reached } = hookViolations([labels, audit], realRead);
    const reachedRel = [...reached].map(relRepo);
    expect(reachedRel).toContain('apps/web/src/features/lab/components/shared.tsx');
    const diffSpec = importsOf(readFileSync(audit, 'utf8')).map((i) => i.spec).find((s) => /DiffTable$/.test(s));
    expect(diffSpec, 'audit page must still import DiffTable').toBeDefined();
    const diff = resolveSpec(diffSpec as string, audit, realRead);
    expect(diff && relRepo(diff)).toBe('packages/ui/src/components/DiffTable/DiffTable.tsx');
    expect(reachedRel).not.toContain('packages/ui/src/components/DiffTable/DiffTable.tsx'); // stops at 'use client'
  });

  it("(c) DiffTable.tsx starts with 'use client' (first statement) - packages/ui, imported by a server page", () => {
    const f = join(uiComponents, 'DiffTable', 'DiffTable.tsx');
    expect(directive(readFileSync(f, 'utf8'))).toBe('use client');
    expect(stripComments(readFileSync(f, 'utf8')).trimStart().startsWith("'use client'") || stripComments(readFileSync(f, 'utf8')).trimStart().startsWith('"use client"')).toBe(true);
  });

  it('(d) config.actions.ts still exports every action name, each an async function declaration', () => {
    const f = join(webSrc, 'features', 'lab', 'server', 'config.actions.ts');
    const s = stripComments(readFileSync(f, 'utf8'));
    expect(directive(s)).toBe('use server');
    const names = ['getLabSettingsAction', 'updateLabSettingsAction', 'listDeltaRulesAction', 'createDeltaRuleAction', 'versionDeltaRuleAction', 'deactivateDeltaRuleAction', 'listCodedSetAction', 'upsertCodeAction'];
    for (const n of names) expect(s, n).toMatch(new RegExp(`^export async function ${n}\\s*[(<]`, 'm'));
    expect(serverActionViolations(s)).toEqual([]);
  });

  it('(d) the two actions keep their bodies: same endpoints, same result shape (no behaviour change)', () => {
    const s = readFileSync(join(webSrc, 'features', 'lab', 'server', 'config.actions.ts'), 'utf8');
    expect(s).toMatch(/getLabSettingsAction[\s\S]{0,200}serverFetch<LabSettings>\('\/v1\/lab\/settings'\)/);
    expect(s).toMatch(/listDeltaRulesAction[\s\S]{0,260}serverFetch<\{ data: DeltaRule\[\] \}>\('\/v1\/lab\/delta-check-rules'\)\)\.data/);
  });

  it("(d) labels/page.tsx imports NO_ACCESS from a plain module: no 'use client', value is an exported string constant, module has no hook", () => {
    const page = join(webSrc, 'app', '(staff)', 'lab', 'orders', '[order_id]', 'labels', 'page.tsx');
    const ps = readFileSync(page, 'utf8');
    expect(directive(ps)).toBeUndefined();
    const imp = importsOf(ps);
    const spec = [...stripComments(ps).matchAll(/\bimport\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g)].find((m) => /\bNO_ACCESS\b/.test(m[1] as string))?.[2];
    expect(spec, 'labels/page.tsx must still import NO_ACCESS').toBeDefined();
    expect(imp.some((i) => i.spec === spec)).toBe(true);
    const mod = resolveSpec(spec as string, page, realRead);
    expect(mod, `cannot resolve ${spec}`).toBeDefined();
    const ms = readFileSync(mod as string, 'utf8');
    expect(directive(ms), `${relRepo(mod as string)} is imported by a server page: it must not be 'use client' (the page would get a client reference, not the string)`).toBeUndefined();
    expect(stripComments(ms)).toMatch(/^export const NO_ACCESS\s*(?::\s*string\s*)?=\s*"You don't have access to this screen\."\s*;?\s*$/m);
    expect(importsOf(ms).flatMap((i) => i.hooks)).toEqual([]);
  });

  it("(b) useSerial (the useRef code) lives in a 'use client' module and every lab importer resolves it there", () => {
    const labFiles = srcFiles.filter((f) => f.startsWith(join(webSrc, 'features', 'lab')));
    const definers = labFiles.filter((f) => /\bexport\s+(?:function|const)\s+useSerial\b/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(definers.map(relRepo).length).toBe(1); // moved, not duplicated
    expect(directive(readFileSync(definers[0] as string, 'utf8'))).toBe('use client');
    const importers = labFiles.filter((f) => /\buseSerial\b/.test(stripComments(readFileSync(f, 'utf8'))) && f !== definers[0]);
    expect(importers.length).toBeGreaterThan(0);
    for (const f of importers) {
      const text = stripComments(readFileSync(f, 'utf8'));
      const m = [...text.matchAll(/\bimport\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g)].find((x) => /\buseSerial\b/.test(x[1] as string));
      expect(m, `${relRepo(f)} uses useSerial without importing it`).toBeDefined();
      expect(resolveSpec(m?.[2] as string, f, realRead), `${relRepo(f)}: useSerial import must resolve to the client module`).toBe(definers[0]);
    }
  });
});
