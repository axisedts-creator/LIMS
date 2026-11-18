// T0D-ELABMENU-3 shared helpers (tester-owned). LD-340: the heading (h1) of the page a sidebar entry opens is the menu label text of that entry.
// Static walk: entry.path -> app/(staff)<path>/page.tsx -> the components it imports (3 hops, '@/features/..' and relative imports only) -> every
// <PageHeader title=..> / <h1>. A string literal or t('key') is resolved against core/i18n/messages; anything else is "dynamic" (named in the table, never guessed).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { navEntries } from '@/core/nav/generated';
import { ELAB_PLACE } from '@/core/nav/elab-menu';
import { t } from '@/core/i18n/messages';

export const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
export const ROOT = join(WEB, '..', '..');
const SRC = join(WEB, 'src');

/** Pages that rs-c2.static pins (features/admin, features/platform, app/(auth), app/(platform)): only a message VALUE may change there. */
export const PINNED = /[\\/]src[\\/](features[\\/](admin|platform)[\\/]|app[\\/]\((auth|platform)\)[\\/])/;
/** Entry-id prefixes whose page lives under a pinned folder. */
export const isPinnedFile = (f: string) => PINNED.test(f);

export interface Heading { file: string; tag: 'PageHeader' | 'Frame' | 'h1'; kind: 'literal' | 'key' | 'dynamic'; text: string; raw: string }

export const pageFile = (path: string): string | null => {
  const parts = path.split('/').filter(Boolean);
  // platform entries (/platform/..) live in the (platform) route group; every other entry in (staff)
  const f = [join(SRC, 'app', '(staff)', ...parts, 'page.tsx'), join(SRC, 'app', '(platform)', ...parts, 'page.tsx')].find(existsSync);
  return f ?? null;
};

const EXT = ['.tsx', '.ts', '/index.tsx', '/index.ts'];
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = join(dirname(from), spec);
  else return null;
  for (const e of EXT) {
    const f = base + e;
    if (existsSync(f) && /\.(tsx|ts)$/.test(f)) return f;
  }
  return null;
}

const read = (f: string) => readFileSync(f, 'utf8');
const importsOf = (f: string) => [...read(f).matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);

/** Headings of ONE source file. */
export function headingsIn(file: string): Heading[] {
  const src = read(file);
  const out: Heading[] = [];
  for (const m of src.matchAll(/<(PageHeader|Frame)\b[^>]*?\btitle=(?:"([^"]*)"|\{\s*'([^']*)'\s*\}|\{\s*t\(\s*'([^']+)'\s*\)\s*\}|\{([^}]*)\})/gs)) {
    const tag = m[1] as Heading['tag'];
    if (m[2] !== undefined) out.push({ file, tag, kind: 'literal', text: m[2], raw: m[2] });
    else if (m[3] !== undefined) out.push({ file, tag, kind: 'literal', text: m[3], raw: m[3] });
    else if (m[4] !== undefined) out.push({ file, tag, kind: 'key', text: t(m[4]), raw: m[4] });
    else out.push({ file, tag, kind: 'dynamic', text: '', raw: (m[5] ?? '').trim() });
  }
  for (const m of src.matchAll(/<h1\b[^>]*>\s*(?:\{\s*t\(\s*'([^']+)'\s*\)\s*\}|([^<{}]+?)|\{([^}]*)\})\s*<\/h1>/gs)) {
    if (m[1] !== undefined) out.push({ file, tag: 'h1', kind: 'key', text: t(m[1]), raw: m[1] });
    else if (m[2] !== undefined) out.push({ file, tag: 'h1', kind: 'literal', text: m[2].trim(), raw: m[2].trim() });
    else out.push({ file, tag: 'h1', kind: 'dynamic', text: '', raw: (m[3] ?? '').trim() });
  }
  return out;
}

/** Breadth-first over imports, 3 hops, stops at the first hop that holds a heading (a page heading is drawn by the nearest screen component). */
export function pageHeadings(path: string): { page: string | null; headings: Heading[]; files: string[] } {
  const page = pageFile(path);
  if (!page) return { page: null, headings: [], files: [] };
  const seen = new Set<string>([page]);
  let layer = [page];
  const files = [page];
  for (let hop = 0; hop <= 4; hop++) {
    const found = layer.flatMap(headingsIn);
    if (found.length) return { page, headings: found, files };
    const next: string[] = [];
    for (const f of layer) for (const spec of importsOf(f)) {
      const r = resolveImport(f, spec);
      // server loaders that return JSX (server/pages.tsx, summaries-page.tsx) are followed; data modules (.server.ts, actions) are not
      if (r && !seen.has(r) && !/[\\/]__tests__[\\/]|\.server\.|\.actions\.|\.test\./.test(r) && !(/[\\/]server[\\/]/.test(r) && r.endsWith('.ts'))) { seen.add(r); next.push(r); files.push(r); }
    }
    layer = next;
  }
  return { page, headings: [], files };
}

export interface Row { id: string; routeId: string; path: string; labelKey: string; label: string; group: string; section: string; page: string | null; headings: Heading[]; pinned: boolean }

export const rows: Row[] = navEntries.map((e) => {
  const { page, headings } = pageHeadings(e.path);
  const place = ELAB_PLACE.get(e.id);
  return {
    id: e.id, routeId: e.routeId, path: e.path, labelKey: e.label, label: t(e.label), group: place?.group ?? e.group, section: place?.section ? t(place.section) : '',
    page: page ? page.replace(SRC, 'src') : null, headings, pinned: !!page && (isPinnedFile(page) || headings.some((h) => isPinnedFile(h.file))),
  };
});

/** True when one of the page's headings (literal or message key) is exactly the entry label. */
export const matches = (r: Row) => r.headings.some((h) => h.kind !== 'dynamic' && h.text === r.label);
