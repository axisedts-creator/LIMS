// RS-C4 shared helper (tester-owned; NOT a test file). Walks the four paths RS-C4 owns and builds the "behaviour signature" that must not change
// in a restyle (LD-140: no change to API calls, field names, validation, permissions or routes), plus the raw-style scanner (10-DESIGN-SYSTEM s7/s8).
// Erasable TypeScript only: `node rs-c4.signature.ts --write` regenerates rs-c4.baseline.json (only ever done by the tester, from the pre-restyle tree).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname also works under vitest's jsdom environment, where new URL(.., import.meta.url) is not a file: URL; cwd (= apps/web) is the last resort
export const web = import.meta.dirname ? join(import.meta.dirname, '..', '..', '..', '..') : process.cwd(); // apps/web/
export const OWNED = {
  frontdesk_feature: 'src/features/frontdesk',
  billing_feature: 'src/features/billing',
  frontdesk_app: 'src/app/(staff)/frontdesk',
  billing_app: 'src/app/(staff)/billing',
} as const;
export type Area = keyof typeof OWNED;

const SKIP = new Set(['__tests__', 'node_modules', '.next']);
export function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    if (SKIP.has(n)) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
export const rel = (p: string) => relative(web, p).replace(/\\/g, '/');
export const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SRC = /\.(?:tsx?|mjs|cjs|jsx?)$/;

/** Files whose content is pure behaviour (API calls, validation, permissions, shortcuts): must be byte-identical (modulo CRLF). */
export function logicFiles(): string[] {
  const out: string[] = [];
  for (const sub of ['server', 'forms', 'hooks']) out.push(...walk(join(web, OWNED.frontdesk_feature, sub)));
  out.push(...walk(join(web, OWNED.billing_feature, 'server')));
  out.push(join(web, OWNED.frontdesk_feature, 'nav.manifest.ts'), join(web, OWNED.billing_feature, 'nav.manifest.ts'), join(web, OWNED.billing_feature, 'components', 'useUrlFilters.ts'));
  return out.filter((f) => existsSync(f) && SRC.test(f)).sort();
}

const uniq = (xs: Iterable<string>) => [...new Set(xs)].sort();
const all = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => m[1] ?? m[0]);
const PERM = /['"`]((?:frontdesk|billing|catalog|lab|patient|platform|admin)\.[a-z0-9_]+(?:\.[a-z0-9_]+)+)['"`]/g; // permission / error codes
const ROUTE = /['"`](\/(?:frontdesk|billing|v1)\/[A-Za-z0-9_\-./${}[\]]*)/g;
const NAME_ATTR = /\bname=["']([a-z0-9_]+)["']/g;
const SERVER_IMPORT = /from\s+['"]([^'"]*\/server\/[^'"]*|\.\.?\/server\/[^'"]*|\.\.?\/server)['"]/g;
const IMPORTED = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*server[^'"]*['"]/g;

export interface Signature { permissions: string[]; routes: string[]; field_names: string[]; server_imports: string[]; server_symbols: string[] }

/** Per area, union over its non-test source files (so splitting a component into new files does not change it). */
export function signature(area: Area): Signature {
  const files = walk(join(web, OWNED[area])).filter((f) => SRC.test(f));
  const text = files.map(read).join('\n');
  const symbols = all(IMPORTED, text).flatMap((g) => g.split(',').map((x) => x.replace(/\btype\b/, '').replace(/\s+as\s+\w+/, '').trim()).filter(Boolean));
  return {
    permissions: uniq(all(PERM, text)),
    routes: uniq(all(ROUTE, text).map((r) => r.replace(/\/+$/, ''))),
    field_names: uniq(all(NAME_ATTR, text)),
    server_imports: uniq(all(SERVER_IMPORT, text).map((s) => s.replace(/^(?:\.\.?\/)+/, ''))),
    server_symbols: uniq(symbols),
  };
}

/** Route tree: every route-defining file under the two app dirs. */
export function routeFiles(): string[] {
  return [...walk(join(web, OWNED.frontdesk_app)), ...walk(join(web, OWNED.billing_app))].map(rel).filter((f) => /\/(?:page|route|layout|loading|error|not-found)\.tsx?$/.test(f)).sort();
}

export function buildBaseline() {
  const logic: Record<string, string> = {};
  for (const f of logicFiles()) logic[rel(f)] = sha(read(f));
  const sigs = Object.fromEntries((Object.keys(OWNED) as Area[]).map((a) => [a, signature(a)]));
  return { logic, signatures: sigs, route_files: routeFiles() };
}

// ---- raw-style scanner: same rules as packages/ui/scripts/__tests__/no-raw-style-literals.test.ts (T0D-UI-R07), restricted to this task's paths. ----
export type Hit = { file: string; line: number; kind: string; text: string };
const nonZeroPx = (v: string) => [...v.matchAll(/(?<![\w.-])(\d*\.?\d+)px/g)].some((m) => parseFloat(m[1]!) !== 0);
function stripComments(text: string): string[] {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n').map((l) => (/^\s*(?:\/\/|\*)/.test(l) ? '' : l.replace(/(^|\s)\/\/.*$/, '$1')));
}
export function scanSource(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  const lines = stripComments(text);
  const add = (i: number, kind: string) => hits.push({ file, line: i + 1, kind, text: lines[i]!.trim().slice(0, 100) });
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
export function rawStyleHits(): Hit[] {
  const files = (Object.keys(OWNED) as Area[]).flatMap((a) => walk(join(web, OWNED[a]))).filter((f) => /\.(?:tsx?|jsx?|mjs|cjs|css|scss)$/.test(f));
  return files.flatMap((f) => scanSource(rel(f), read(f)));
}

if (process.argv.includes('--write') && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'rs-c4.baseline.json'), `${JSON.stringify(buildBaseline(), null, 2)}\n`);
  console.log('rs-c4.baseline.json written');
}
