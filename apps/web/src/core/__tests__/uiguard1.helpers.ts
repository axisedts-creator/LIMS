// T0D-UIGUARD-1 helpers (tester-owned). LD-353 rules 2, 3, 5, 6, 10: static detectors + the page walk used by uiguard1.guard.test.ts.
// T0D-UIGUARD-2 (LD-436 R7, LD-438, LD-439) adds rule 7: no raw h1 to h4 and no raw ul or ol for page structure (detector rawStructureViolations).
// A "page" is every page.tsx under app/(staff). Its "own sources" are the page file plus the app/features/core files it imports (relative or '@/'),
// followed up to HOPS levels. Kit parts (@lims/ui) and the shell (core/shell, nav, i18n, session, api) are leaves: they are pinned by their own tests.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const WEB = join(import.meta.dirname, '..', '..', '..'); // apps/web
export const ROOT = join(WEB, '..', '..');
export const SRC = join(WEB, 'src');
export const STAFF = join(SRC, 'app', '(staff)');
export const HOPS = 5;

export const RULES = [1, 2, 3, 4, 5, 6, 7] as const;
export type Rule = (typeof RULES)[number];
export const RULE_TEXT: Record<Rule, string> = {
  1: 'renders the kit PageHeader',
  2: 'uses FilterBar (no hand built filter row)',
  3: 'declares no font-weight 600/700 and no control height in px in its own CSS',
  4: 'shows ErrorState or NotAvailable (not a raw error page) for a failed read',
  5: 'keeps the table header when the list is empty',
  6: 'draws every chart inside ChartCard',
  7: 'uses no raw h1 to h4 and no raw ul or ol for page structure (kit parts, DataTable cell lists, registry-named print layouts are allowed)',
};

/** LD-439 (c): the 18 area names a rule 7 legacy entry may carry; the follow-up task is T0D-UIGUARD-1-<AREA>. */
export const AREAS = ['ANALYTICS', 'BILLING', 'CATALOG', 'ENGAGEMENT', 'FRONTDESK', 'HOMECOLLECTION', 'INSTRUMENTS', 'INVENTORY', 'LAB', 'OFFLINE', 'PARTNERS', 'QUALITY', 'SMARTREPORT', 'ADMIN', 'ANATOMIC', 'MICRO', 'PAYMENTS', 'REPORTING'] as const;
/** LD-439 (c): the only rule 7 entries that may be pinned: app/(auth), app/(platform), features/platform and features/admin/auth. */
export const PINNED7 = /[\\/]src[\\/](features[\\/]platform[\\/]|features[\\/]admin[\\/]auth[\\/]|app[\\/]\((auth|platform)\)[\\/])/;

/** Files under these folders are pinned by rs-c2.static (shared kit fixes only). */
export const PINNED = /[\\/]src[\\/](features[\\/](admin|platform)[\\/]|app[\\/]\((auth|platform)\)[\\/])/;

const LEAF = /[\\/]src[\\/]core[\\/](shell|nav|i18n|session|api|errors)[\\/]|[\\/]__tests__[\\/]|\.test\.|\.d\.ts$/;
const EXT = ['.tsx', '.ts', '/index.tsx', '/index.ts'];
const read = (f: string) => readFileSync(f, 'utf8');

export function walkPages(dir = STAFF): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) out.push(...walkPages(f));
    else if (name === 'page.tsx') out.push(f);
  }
  return out.sort();
}

/** /frontdesk/registrations/new for app/(staff)/frontdesk/registrations/new/page.tsx; dynamic segments stay as [name]. */
export const routeOf = (file: string) => '/' + relative(STAFF, dirname(file)).split(/[\\/]/).filter(Boolean).join('/');

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = join(dirname(from), spec);
  else return null;
  if (spec.endsWith('.css')) return existsSync(base) ? base : null;
  for (const e of EXT) {
    const f = base + e;
    if (existsSync(f) && statSync(f).isFile()) return f;
  }
  return null;
}

const importSpecs = (src: string) =>
  [...src.matchAll(/(?:\bimport|\bexport)\s*(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => (m[1] ?? m[2])!);

export interface PageSources { page: string; route: string; ts: string[]; css: string[] }

export function sourcesOf(page: string): PageSources {
  const ts = [page];
  const css: string[] = [];
  const seen = new Set<string>([page]);
  let layer = [page];
  for (let hop = 0; hop < HOPS && layer.length; hop++) {
    const next: string[] = [];
    for (const f of layer) {
      for (const spec of importSpecs(read(f))) {
        const r = resolveImport(f, spec);
        if (!r || seen.has(r) || LEAF.test(r)) continue;
        seen.add(r);
        if (r.endsWith('.css')) css.push(r);
        else { ts.push(r); next.push(r); }
      }
    }
    layer = next;
  }
  return { page, route: routeOf(page), ts, css };
}

// ---------- detectors (pure: source text in, findings out) ----------

/** Rule 1: the page draws the kit PageHeader. */
export const rendersPageHeader = (src: string) => /<PageHeader\b/.test(src);

/** Rule 2: a hand built filter row = the filter row class or a search landmark written by hand in a file that never renders <FilterBar. */
export const handBuiltFilterRow = (src: string) =>
  !/<FilterBar\b/.test(src) && (/className=(?:"[^"]*\blims-filter-?bar\b|\{`[^`]*\blims-filter-?bar\b|\{'[^']*\blims-filter-?bar\b)/.test(src) || /<form\b[^>]*\bclassName="[^"]*filters?\b/.test(src));

/** Rule 3 (TSX side): inline style weight 600/700/bold or a pixel control height. */
export function inlineStyleViolations(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bfontWeight\s*:\s*(?:['"]?(bold|bolder|[6-9]00)['"]?|['"]?var\(--lims-font-weight-(?:semibold|bold)\)['"]?)/g)) out.push(`inline fontWeight ${m[0].trim()}`);
  for (const m of src.matchAll(/\bstyle=\{\{[^}]*\b(?:min|max)?[hH]eight\s*:\s*(?:\d+|['"`]\d+px['"`])/g)) out.push(`inline height ${m[0].slice(-24).trim()}`);
  return out;
}

const HEAVY = /^(bold|bolder|[6-9]00|var\(\s*--lims-font-weight-(?:semibold|bold)[^)]*\))$/;
// a control selector: the tag (input, select, textarea, button) or a class token such as .lims-input, .x-btn, .y-control (not .selected-row)
const CONTROL = /(?:^|[\s,>+~])(?:input|select|textarea|button)\b|[.\-_](?:input|select|btn|button|control|textfield|combobox|datepicker)(?![a-z])/i;
const hidden = (body: string) => /clip(-path)?\s*:|position\s*:\s*absolute/.test(body) && /width\s*:\s*1px/.test(body);

/** Rule 3 (CSS side): declarations in a feature's own CSS file. kit.css and shell.css are shared and pinned elsewhere, so they are never passed here. */
export function cssViolations(css: string): string[] {
  const out: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().replace(/\s+/g, ' ');
    const body = m[2]!;
    for (const d of body.matchAll(/font-weight\s*:\s*([^;}]+)/g)) if (HEAVY.test(d[1]!.trim())) out.push(`${sel} { font-weight: ${d[1]!.trim()} }`);
    if (CONTROL.test(sel) && !hidden(body)) for (const d of body.matchAll(/(?:^|[;\s])((?:min-|max-)?height)\s*:\s*(\d+(?:\.\d+)?px)/g)) out.push(`${sel} { ${d[1]}: ${d[2]} }`);
  }
  return out;
}

/** Rule 4: the page performs a read (server loader, server action, client query) ... */
export const readsData = (src: string) => /\.server['"]|\.actions['"]|\bapiFetch\s*\(|\buseQuery\s*\(|\bfetch\(\s*['"`]\//.test(src);
/** ... and answers a failed one in the page: loadOr / pendingOr, ErrorState, LoadError or NotAvailable (the title is kept by all of them). */
export const handlesFailedRead = (src: string) => /\b(loadOr|pendingOr|ErrorState|LoadError|NotAvailable)\b/.test(src);

/** ... or the page's nearest error.tsx (walking up to app/) draws the kit ErrorState, so a thrown read failure is never the raw framework error page. */
export function errorBoundaryDrawsErrorState(page: string): boolean {
  for (let d = dirname(page); d.startsWith(join(SRC, 'app')); d = dirname(d)) {
    const f = join(d, 'error.tsx');
    if (existsSync(f)) return /<ErrorState\b|<LoadError\b/.test(read(f));
  }
  return false;
}

/** Rule 5: the table (or DataTable / ListTable) is swapped for something else when the list is empty, so its header disappears. */
export function hidesTableHeaderWhenEmpty(src: string): boolean {
  if (!/<(table|DataTable|ListTable)\b/.test(src)) return false;
  const EMPTY = String.raw`(?:\.length\s*(?:===?\s*0|<\s*1)|!\s*[\w.?]+\.length\b|\.length\s*===?\s*0)`;
  const NONEMPTY = String.raw`(?:\.length\s*(?:>\s*0|!==?\s*0|>=\s*1)|\.length\b(?!\s*[=<>!]))`;
  // empty ? <something that is not a table> : <table|DataTable|ListTable ...>  (the table itself is the else branch, so it is gone when empty)
  const emptyThenOther = new RegExp(String.raw`${EMPTY}\s*\)?\s*\?\s*\(?\s*<(?!(?:tr|td|DataTable|ListTable|table|EmptyRow|PlaceholderRows)\b)[\s\S]{0,500}?:\s*\(?\s*(?:<>\s*)?<(?:table|DataTable|ListTable)\b`);
  const earlyReturn = new RegExp(String.raw`if\s*\(\s*(?:[\w.?]+${EMPTY}|!\s*[\w.?]+\.length\b)\s*\)\s*\{?\s*return\s*\(?\s*<(?!(?:tr|td|DataTable|ListTable|table)\b)`);
  const nonEmptyThenTable = new RegExp(String.raw`${NONEMPTY}\s*\)?\s*(?:\?|&&)\s*\(?\s*<(?:table|DataTable|ListTable)\b`);
  return emptyThenOther.test(src) || earlyReturn.test(src) || nonEmptyThenTable.test(src);
}

// ---------- rule 7 (T0D-UIGUARD-2): raw h1 to h4 / ul / ol ----------

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).replace(/(^|[\s;{}(,])\/\/[^\n]*/g, (m, p: string) => p + ' '.repeat(m.length - p.length));

/** [start, end) of every column `cell:` renderer expression: from after `cell:` to the next property of the column object or its closing brace. */
function cellRanges(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of src.matchAll(/\bcell\s*:\s*/g)) {
    const start = m.index! + m[0].length;
    let depth = 0;
    let i = start;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (--depth < 0) break; }
      else if (c === ',' && depth === 0 && /^,\s*\n\s*[A-Za-z_$][\w$]*\s*:/.test(src.slice(i, i + 80))) break;
    }
    out.push([start, i]);
  }
  return out;
}

/**
 * Rule 7: a raw h1..h4 element, or a raw ul/ol element, written in JSX. Page structure belongs to PageHeader, Card (title row), ActionList, StatusStepper,
 * DataTable, Tabs and the other kit parts. A ul/ol inside a DataTable column `cell:` renderer is a plain list of values and is allowed; h1..h4 never is.
 * ponytail: textual scan, ceiling = a `cell:` helper written outside the column object counts as page structure; upgrade path is a TS AST walk.
 */
export function rawStructureViolations(src: string): string[] {
  const text = stripComments(src);
  const cells = cellRanges(text);
  const out: string[] = [];
  for (const m of text.matchAll(/<(h[1-4]|ul|ol)(?=[\s>/])/g)) {
    const tag = m[1]!;
    if (tag[0] !== 'h' && cells.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    out.push(`raw <${tag}>`);
  }
  return out;
}

const CHART = /<(?:BarChart|TimeSeriesChart|LineChart|AreaChart|Sparkline|DonutChart|PieChart|Chart)\b/g;
/** Rule 6: a file that draws more charts than it has ChartCard wrappers. Returns the number of unwrapped charts. */
export function unwrappedCharts(src: string): number {
  const charts = (src.match(CHART) ?? []).length;
  const cards = (src.match(/<ChartCard\b/g) ?? []).length;
  return Math.max(0, charts - cards);
}

// ---------- the exceptions registry ----------

export interface GuardException { route: string; rule: Rule; reason: string }

/** Exact route, or a prefix ending in /* . */
export const routeMatches = (pattern: string, route: string) => (pattern.endsWith('/*') ? route === pattern.slice(0, -2) || route.startsWith(pattern.slice(0, -1)) : pattern === route);

export type Findings = Map<string, Map<Rule, string[]>>; // route -> rule -> evidence

/** Pages whose finding for `rule` is not covered by an exception (the guard fails on these). */
export const unexcused = (findings: Findings, exceptions: GuardException[], rule: Rule): string[] =>
  [...findings.entries()]
    .filter(([route, byRule]) => byRule.has(rule) && !exceptions.some((e) => e.rule === rule && routeMatches(e.route, route)))
    .map(([route, byRule]) => `${route}  ->  ${byRule.get(rule)!.slice(0, 3).join(' | ')}`)
    .sort();

/** Exceptions whose page no longer breaks the rule (LD-434 stale-entry rule): the guard fails until the entry is deleted, so the baseline shrinks. */
export const staleExceptions = (findings: Findings, exceptions: GuardException[]): GuardException[] =>
  exceptions.filter((e) => ![...findings.entries()].some(([route, by]) => routeMatches(e.route, route) && by.has(e.rule)));

export function analyse(pages = walkPages()): { findings: Findings; sources: Map<string, PageSources> } {
  const findings: Findings = new Map();
  const sources = new Map<string, PageSources>();
  const add = (route: string, rule: Rule, ev: string) => {
    const m = findings.get(route) ?? new Map<Rule, string[]>();
    m.set(rule, [...(m.get(rule) ?? []), ev]);
    findings.set(route, m);
  };
  for (const page of pages) {
    const s = sourcesOf(page);
    sources.set(s.route, s);
    const tsText = s.ts.map((f) => [f, read(f)] as const);
    const all = tsText.map(([, x]) => x).join('\n');
    const rel = (f: string) => relative(SRC, f).replace(/\\/g, '/');
    if (!rendersPageHeader(all)) add(s.route, 1, 'no <PageHeader in the page or the components it imports');
    for (const [f, x] of tsText) if (handBuiltFilterRow(x)) add(s.route, 2, `hand built filter row in ${rel(f)}`);
    for (const c of s.css) for (const v of cssViolations(read(c))) add(s.route, 3, `${rel(c)}: ${v}`);
    for (const [f, x] of tsText) for (const v of inlineStyleViolations(x)) add(s.route, 3, `${rel(f)}: ${v}`);
    if (readsData(all) && !handlesFailedRead(all) && !errorBoundaryDrawsErrorState(page)) add(s.route, 4, 'reads data; no loadOr/pendingOr/ErrorState/LoadError/NotAvailable in the page and no error.tsx with ErrorState above it');
    for (const [f, x] of tsText) if (hidesTableHeaderWhenEmpty(x)) add(s.route, 5, `table swapped for another element when empty in ${rel(f)}`);
    for (const [f, x] of tsText) { const n = unwrappedCharts(x); if (n) add(s.route, 6, `${n} chart(s) without ChartCard in ${rel(f)}`); }
    for (const [f, x] of tsText) { const v = rawStructureViolations(x); if (v.length) add(s.route, 7, `${v.length} raw heading/list element(s) in ${rel(f)} (${[...new Set(v)].join(', ')})`); }
  }
  return { findings, sources };
}
