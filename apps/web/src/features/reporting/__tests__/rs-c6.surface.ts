// RS-C6 shared helper (tester-owned): file walker, raw-style detector and the "behaviour surface" (API calls, routes, field names,
// permission codes, data files) of the C6 paths. Node built-ins only, so it also runs as a plain script to record the baseline:
//   node --experimental-strip-types -e "import('./rs-c6.surface.ts').then(m => m.record())"   (from this folder; only on purpose)
// Paths owned by RS-C6: apps/web/src/features/reporting/**, apps/web/src/app/(staff)/reporting/**, apps/portal/**.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const webSrc = join(here, '..', '..', '..'); // apps/web/src
export const portalRoot = join(webSrc, '..', '..', 'portal'); // apps/portal
export const baselineFile = join(here, 'rs-c6.baseline.json');

const EXTS = /\.(?:tsx?|jsx?|mjs|cjs|css|scss)$/;
const SKIP_DIRS = new Set(['__tests__', 'node_modules', '.next']);
export type Src = { rel: string; text: string };

function* walk(abs: string, rel: string): Generator<[string, string]> {
  for (const n of readdirSync(abs).sort()) {
    const a = join(abs, n);
    const r = `${rel}/${n}`;
    if (statSync(a).isDirectory()) {
      if (!SKIP_DIRS.has(n)) yield* walk(a, r);
    } else if (EXTS.test(n)) yield [a, r];
  }
}
const load = (pairs: Iterable<[string, string]>): Src[] => [...pairs].map(([a, rel]) => ({ rel, text: readFileSync(a, 'utf8').replace(/\r\n/g, '\n') }));

/** Everything RS-C6 owns that holds code or CSS (rel paths start with `web/` or `portal/`). */
export const files: Src[] = [
  ...load(walk(join(webSrc, 'features', 'reporting'), 'web/features/reporting')),
  ...load(walk(join(webSrc, 'app', '(staff)', 'reporting'), 'web/app/(staff)/reporting')),
  ...load(walk(join(portalRoot, 'src'), 'portal/src')),
];
export const read = (rel: string) => files.find((f) => f.rel === rel)?.text ?? '';

// ---------------------------------------------------------------- raw style detector (same rules as packages/ui/scripts/__tests__/no-raw-style-literals.test.ts)
export type Hit = { file: string; line: number; kind: string; text: string };
const nonZeroPx = (v: string) => [...v.matchAll(/(?<![\w.-])(\d*\.?\d+)px/g)].some((m) => parseFloat(m[1]!) !== 0);
export function stripComments(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*(?:\/\/|\*)/.test(l) ? '' : l.replace(/(^|\s)\/\/.*$/, '$1')));
}
export function scan(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  const lines = stripComments(text);
  const add = (i: number, kind: string) => hits.push({ file, line: i + 1, kind, text: lines[i]!.trim().slice(0, 120) });
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

// ---------------------------------------------------------------- behaviour surface
// Files with no markup (server actions, API clients, route handlers, middleware, nav manifest, hooks): a restyle has no reason to touch them.
export const DATA_FILES = [
  'web/features/reporting/nav.manifest.ts',
  'web/features/reporting/server/actions.ts', 'web/features/reporting/server/pdf.server.ts', 'web/features/reporting/server/read.server.ts',
  'web/features/reporting/server/types.ts', 'web/features/reporting/server/write.server.ts',
  'web/features/reporting/components/useShortcuts.ts', 'web/features/reporting/components/useUrlFilters.ts',
  'portal/src/middleware.ts', 'portal/src/server/api.ts', 'portal/src/server/origin.ts', 'portal/src/server/session.ts', 'portal/src/features/portal/actions.ts',
  'portal/src/app/r/[token]/download/route.ts', 'portal/src/app/r/[token]/pay/route.ts', 'portal/src/app/r/[token]/reissue/route.ts', 'portal/src/app/r/[token]/signout/route.ts',
];
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const uniq = (xs: string[]) => [...new Set(xs)].sort();
const ROUTE_FILE = /(?:^|\/)(?:page|route|layout|loading|error|not-found|default|template|middleware)\.[tj]sx?$/;

export function surface() {
  const all = files.map((f) => f.text).join('\n');
  const ui = files.filter((f) => !DATA_FILES.includes(f.rel) && /\.tsx?$/.test(f.rel));
  const importedSymbols = ui.flatMap((f) =>
    [...f.text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'((?:\.{1,2}\/|@\/)[^']*(?:server|actions|api|session|notices)[^']*)'/g)].flatMap((m) =>
      m[1]!.split(',').map((s) => s.trim().replace(/^type\s+/, '').replace(/\s+as\s+\w+$/, '')).filter(Boolean).map((s) => `${m[2]!.replace(/^(?:\.{1,2}\/)+/, '')}#${s}`)),
  );
  return {
    data_files: Object.fromEntries(DATA_FILES.map((d) => [d, sha(files.find((f) => f.rel === d)?.text ?? 'MISSING')])),
    route_files: files.filter((f) => ROUTE_FILE.test(f.rel) && !f.rel.startsWith('web/features/')).map((f) => f.rel).sort(),
    internal_links: uniq([...all.matchAll(/['"`](\/(?:r|v|reporting|app|phlebo)(?:\/[\w${}.:[\]-]*)*)/g)].map((m) => m[1]!)),
    portal_api_calls: uniq([...all.matchAll(/callApi(?:<[^>]*>)?\(\s*'(GET|POST)'\s*,\s*['"`]([^'"`]+)/g)].map((m) => `${m[1]} ${m[2]}`)),
    web_api_paths: uniq([...all.matchAll(/(?:\/v1|\$\{[A-Z_]+\})\/[\w/${}.:-]+/g)].map((m) => m[0])),
    imported_server_symbols: uniq(importedSymbols),
    permission_codes: uniq([...all.matchAll(/['"`]([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)['"`]/g)].map((m) => m[1]!)),
    field_names: uniq([
      ...ui.flatMap((f) => [...f.text.matchAll(/\bname\s*=\s*["']([\w.[\]-]+)["']/g)].map((m) => m[1]!)),
      ...[...all.matchAll(/\.get\(\s*['"]([\w.-]+)['"]\s*\)/g)].map((m) => m[1]!),
    ]),
    portal_package_json: sha(readFileSync(join(portalRoot, 'package.json'), 'utf8').replace(/\r\n/g, '\n')),
  };
}

export function record() {
  writeFileSync(baselineFile, `${JSON.stringify(surface(), null, 2)}\n`);
}
