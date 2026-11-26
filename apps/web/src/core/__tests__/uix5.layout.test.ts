// @vitest-environment jsdom
// T0D-UIX-5 (LD-442, LD-436, LD-437, LD-438; founder order 2026-11-22 09:10 NPT): staff web PAGE LAYOUT, measured by VALUES.
// Reads apps/web/src/core/shell/layout.css (new, owned by this task) and apps/web/src/app/layout.tsx (the import site) as text, asserts every number of
// done_when 2 to 5, then renders PageShell, PageHeader, EmptyState (and Card, ErrorState, Banner, StatTileRow, NotAvailable) with jsdom and asserts that the
// class names the CSS targets really exist in the markup.  No route, permission, contract or API is touched.
//
// Value reading: 1rem = 16 px, var(--lims-space-N) = tokens.json space (N=3 -> 12, 4 -> 16, 6 -> 24, 10 -> 40), the font size tokens are read from the
// :root block of shell.css (xs 10.8, sm 11.7, base 12.6 px).  A value may be written as a token or in rem; a literal px is not allowed (tokens only).
// Selector contract (the implementer's CSS must target these existing kit class names, the tests fix them):
//   page body      .lims-shell-main, .lims-page-header, .lims-page-header-row, .lims-page-heading, .lims-page-title, .lims-page-caption, .lims-page-actions
//   cards          .lims-grid > .lims-card, .lims-stat-row, .lims-stat, .lims-card-head, .lims-card-title, .lims-card-caption
//   calm states    .lims-state (with .lims-state-art, .lims-state-title, .lims-state-body) scoped under .lims-card and under a table wrapper
//                  (.lims-table, .lims-data-table or td); the stacked NotAvailable variant keys on .lims-state-art[data-art='not-available']
//   banners        .lims-banner (+ .lims-banner-text, .lims-banner-title) and the danger ErrorState (.lims-state with .lims-tone-danger or [data-tone='danger'])
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PageShell } from '@lims/ui/components/PageShell';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { Banner } from '@lims/ui/components/Banner';
import { Card } from '@lims/ui/components/Card';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { NotAvailable } from '@lims/ui/components/NotAvailable';

afterEach(cleanup);

const SRC = join(import.meta.dirname, '..', '..'); // apps/web/src
const LAYOUT_CSS = join(SRC, 'core', 'shell', 'layout.css');
const SHELL_CSS = join(SRC, 'core', 'shell', 'shell.css');
const KIT_CSS = join(SRC, '..', '..', '..', 'packages', 'ui', 'src', 'components', 'kit.css');
const IMPORT_SITE = join(SRC, 'app', 'layout.tsx');

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

// ---- a small CSS reader (same shape as uikit2.shell.test.ts, plus the important flag) ----
type Decl = { value: string; important: boolean };
type Rule = { sels: string[]; decls: Map<string, Decl>; media: string };
const normSel = (x: string) => x.trim().replace(/\s+/g, ' ').replace(/"/g, "'").replace(/\s*>\s*/g, ' > ').replace(/\s*~\s*/g, ' ~ ').replace(/\s*\+\s*/g, ' + ');
function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(normSel(cur)); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(normSel(cur));
  return out;
}
function parseCss(s: string): Rule[] {
  const out: Rule[] = [];
  const media: string[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    const close = s.indexOf('}', i);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) { media.pop(); i = close + 1; continue; }
    const prelude = s.slice(i, open).trim();
    if (/^@(media|supports|container|layer)/.test(prelude)) { media.push(prelude); i = open + 1; continue; }
    const end = s.indexOf('}', open);
    const decls = new Map<string, Decl>();
    for (const d of s.slice(open + 1, end).split(';')) {
      const k = d.indexOf(':');
      if (k <= 0) continue;
      const raw = d.slice(k + 1).trim();
      const important = /\s*!important\s*$/i.test(raw);
      decls.set(d.slice(0, k).trim().toLowerCase(), { value: raw.replace(/\s*!important\s*$/i, '').trim(), important });
    }
    if (!prelude.startsWith('@')) out.push({ sels: splitSelectors(prelude), decls, media: media.join(' ') });
    i = end + 1;
  }
  return out;
}

const layoutText = read(LAYOUT_CSS);
const layoutSrc = strip(layoutText);
const shellSrc = strip(read(SHELL_CSS));
const kitSrc = strip(read(KIT_CSS));
const layoutRules = parseCss(layoutSrc);
const shellRules = parseCss(shellSrc);

// ---- value resolution ----
const SPACE: Record<string, number> = { '0': 0, '0-5': 2, '1': 4, '1-5': 6, '2': 8, '3': 12, '4': 16, '5': 20, '6': 24, '8': 32, '10': 40, '12': 48, '16': 64 };
const rootVars = new Map<string, string>();
for (const r of shellRules) if (r.sels.includes(':root')) for (const [k, d] of r.decls) if (k.startsWith('--')) rootVars.set(k, d.value);
/** px of a token / rem / 0 value, or null when it is not a plain length. */
function px(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === '0') return 0;
  let m = t.match(/^var\(--lims-space-([0-9-]+)\)$/);
  if (m) return SPACE[m[1]!] ?? null;
  m = t.match(/^var\((--lims-font-size-[a-z0-9]+-size)\)$/);
  if (m) return px(rootVars.get(m[1]!));
  m = t.match(/^(-?\d*\.?\d+)rem$/);
  if (m) return Math.round(parseFloat(m[1]!) * 16 * 1000) / 1000;
  return null;
}
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 0.01;

/** Rules (in source order) that have at least one of the selectors exactly (after normalisation). */
const rulesFor = (rs: Rule[], sels: string[]) => rs.filter((r) => r.sels.some((s) => sels.map(normSel).includes(s)));
/** The last declaration of prop in layout.css for those selectors (no media rules unless wantMedia). */
function lay(sels: string[], prop: string, opts: { media?: boolean } = {}): Decl | undefined {
  const hits = rulesFor(layoutRules, sels).filter((r) => (opts.media ? true : r.media === '')).filter((r) => r.decls.has(prop));
  return hits.length ? hits.at(-1)!.decls.get(prop) : undefined;
}
/** The 4 sides of padding / margin from the shorthand and the logical or physical longhands, in source order. */
function box4(sels: string[], base: 'padding' | 'margin'): { top: number | null; right: number | null; bottom: number | null; left: number | null } | null {
  const hits = rulesFor(layoutRules, sels).filter((r) => r.media === '');
  let b: { top: number | null; right: number | null; bottom: number | null; left: number | null } | null = null;
  const set = (o: Partial<NonNullable<typeof b>>) => { b = { top: null, right: null, bottom: null, left: null, ...(b ?? {}), ...o }; };
  for (const r of hits) {
    for (const [k, d] of r.decls) {
      const parts = d.value.split(/\s+/).map(px);
      if (k === base) {
        if (parts.length === 1) set({ top: parts[0]!, right: parts[0]!, bottom: parts[0]!, left: parts[0]! });
        else if (parts.length === 2) set({ top: parts[0]!, bottom: parts[0]!, right: parts[1]!, left: parts[1]! });
        else if (parts.length === 3) set({ top: parts[0]!, right: parts[1]!, left: parts[1]!, bottom: parts[2]! });
        else if (parts.length === 4) set({ top: parts[0]!, right: parts[1]!, bottom: parts[2]!, left: parts[3]! });
      } else if (k === `${base}-block`) set(parts.length === 1 ? { top: parts[0]!, bottom: parts[0]! } : { top: parts[0]!, bottom: parts[1]! });
      else if (k === `${base}-inline`) set(parts.length === 1 ? { left: parts[0]!, right: parts[0]! } : { left: parts[0]!, right: parts[1]! });
      else if (k === `${base}-top` || k === `${base}-block-start`) set({ top: parts[0]! });
      else if (k === `${base}-bottom` || k === `${base}-block-end`) set({ bottom: parts[0]! });
      else if (k === `${base}-left` || k === `${base}-inline-start`) set({ left: parts[0]! });
      else if (k === `${base}-right` || k === `${base}-inline-end`) set({ right: parts[0]! });
    }
  }
  return b;
}
/** True when shell.css sets prop with !important on a rule that has one of these selectors (so layout.css must also use !important to win, it loads later). */
const shellImportant = (sels: string[], prop: string) => rulesFor(shellRules, sels).some((r) => r.decls.get(prop)?.important === true);
/** Declaration must exist and, where shell.css fixed it with !important, layout.css must carry the flag too (the neighbouring rule already uses it). */
function layWins(sels: string[], prop: string): string {
  const d = lay(sels, prop);
  expect(d, `layout.css: ${sels[0]} { ${prop} } is not set`).toBeDefined();
  if (shellImportant(sels, prop)) expect(d!.important, `layout.css: ${sels[0]} { ${prop} } must carry !important (shell.css sets it with !important and loads first)`).toBe(true);
  return d!.value;
}
const colorIs = (v: string | undefined, token: string) => v === `var(--lims-${token})`;

// ======================================================================================================================
describe('done_when 1: layout.css exists, imported exactly once, tokens only, in scope', () => {
  it('apps/web/src/core/shell/layout.css exists and has rules', () => {
    expect(existsSync(LAYOUT_CSS), 'layout.css is missing').toBe(true);
    expect(layoutRules.length).toBeGreaterThan(5);
  });

  it('the file that imports shell.css imports layout.css once, on one line, right after the shell.css import', () => {
    const lines = readFileSync(IMPORT_SITE, 'utf8').split(/\r?\n/);
    const shellAt = lines.findIndex((l) => /^import\s+'@\/core\/shell\/shell\.css';/.test(l));
    expect(shellAt).toBeGreaterThanOrEqual(0);
    const hits = lines.map((l, i) => [l, i] as const).filter(([l]) => /layout\.css/.test(l));
    expect(hits.length, 'exactly one line mentions layout.css').toBe(1);
    expect(hits[0]![0]).toMatch(/^import\s+'@\/core\/shell\/layout\.css';/);
    expect(hits[0]![1], 'after the shell.css import (it must win the cascade)').toBeGreaterThan(shellAt);
  });

  it('no other source file under apps/web/src imports shell/layout.css', () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (n === 'node_modules' || n === '__tests__' || n === '.next') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|css|mjs)$/.test(n) && p !== IMPORT_SITE && /shell\/layout\.css/.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('tokens only: no hex, rgb/hsl/oklch, gradient or literal px in layout.css', () => {
    expect(layoutSrc.length).toBeGreaterThan(0);
    expect(layoutSrc).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(layoutSrc).not.toMatch(/\b(rgba?|hsla?|oklch)\(/i);
    expect(layoutSrc).not.toMatch(/gradient\(/i);
    expect(layoutSrc.match(/\b\d+(\.\d+)?px\b/g) ?? []).toEqual([]);
  });

  it('no new !important property beyond the ones the neighbouring shell.css rules already use', () => {
    const shellProps = new Set<string>();
    for (const r of shellRules) for (const [k, d] of r.decls) if (d.important) shellProps.add(k);
    const bad: string[] = [];
    for (const r of layoutRules) for (const [k, d] of r.decls) if (d.important && !shellProps.has(k)) bad.push(`${r.sels[0]} { ${k} !important }`);
    expect(bad).toEqual([]);
  });

  it('stays in scope: no button, table, tab, field or description list rule (T0D-UIX-1 owns them); only state and banner descendants may name them', () => {
    const owned = /\.lims-(btn|table|tabs?|tablist|input|select|field|dl|desc[a-z-]*|filter[a-z-]*|col|cell|row)\b/;
    const bad: string[] = [];
    for (const r of layoutRules) for (const s of r.sels) if (owned.test(s) && !/\.lims-(state|banner)\b/.test(s)) bad.push(s);
    expect(bad).toEqual([]);
  });
});

// ======================================================================================================================
describe('done_when 2: page body and PageHeader (LD-442)', () => {
  const MAIN = ['.lims-shell-main'];
  it('content padding is 16px on every side (and wins over the shell.css important rule)', () => {
    layWins(MAIN, 'padding');
    const b = box4(MAIN, 'padding');
    expect(b, '.lims-shell-main padding').not.toBeNull();
    for (const side of ['top', 'right', 'bottom', 'left'] as const) expect(near(b![side], 16), `padding-${side} = ${b![side]}`).toBe(true);
  });

  it('the main area is a column with a 12px gap between header, tabs, filter bar and cards', () => {
    expect(lay(MAIN, 'display')?.value).toBe('flex');
    expect(lay(MAIN, 'flex-direction')?.value).toBe('column');
    expect(near(px(lay(MAIN, 'gap')?.value), 12), `gap = ${lay(MAIN, 'gap')?.value}`).toBe(true);
  });

  it('the main content fills the available width: no max-width on the main area, the page header or its row', () => {
    expect(rulesFor(layoutRules, MAIN).length, 'layout.css has a .lims-shell-main rule').toBeGreaterThan(0);
    for (const sels of [MAIN, ['.lims-page-header'], ['.lims-page-header-row']]) {
      const mw = lay(sels, 'max-width', { media: true })?.value;
      expect([undefined, 'none', '100%']).toContain(mw);
    }
    for (const sels of [MAIN, ['.lims-page-header']]) {
      const m = lay(sels, 'margin-inline')?.value ?? lay(sels, 'margin')?.value;
      expect(m ?? '', `${sels[0]} must not be centred with auto margins`).not.toMatch(/\bauto\b/);
    }
  });

  it('PageHeader has a 12px bottom margin', () => {
    const b = box4(['.lims-page-header'], 'margin');
    expect(b, '.lims-page-header margin').not.toBeNull();
    expect(near(b!.bottom, 12), `margin-bottom = ${b!.bottom}`).toBe(true);
  });

  it('PageHeader is one row: flex row, title block left, actions pushed to the right', () => {
    const ROW = ['.lims-page-header-row'];
    expect(lay(ROW, 'display')?.value).toBe('flex');
    const dir = lay(ROW, 'flex-direction')?.value;
    expect([undefined, 'row']).toContain(dir);
    const spread = lay(ROW, 'justify-content')?.value === 'space-between';
    const pushed = /^auto$/.test(lay(['.lims-page-actions'], 'margin-inline-start')?.value ?? '') || /^auto$/.test(lay(['.lims-page-actions'], 'margin-left')?.value ?? '');
    expect(spread || pushed, 'actions right aligned: justify-content: space-between on the row, or margin-inline-start: auto on .lims-page-actions').toBe(true);
    expect(['center', 'flex-end', 'baseline', 'end']).toContain(lay(ROW, 'align-items')?.value);
    const wrap = lay(ROW, 'flex-wrap')?.value;
    expect([undefined, 'nowrap', 'wrap']).toContain(wrap);
  });

  it('the title block stacks the h1 over the caption', () => {
    const HEAD = ['.lims-page-heading'];
    expect(lay(HEAD, 'display')?.value).toBe('flex');
    expect(lay(HEAD, 'flex-direction')?.value).toBe('column');
  });

  it('h1 (lims-page-title) is 16px, weight 600, accent text tone', () => {
    const T = ['.lims-page-title'];
    expect(near(px(layWins(T, 'font-size')), 16)).toBe(true);
    expect(layWins(T, 'font-weight')).toBe('var(--lims-font-weight-semibold)');
    expect(colorIs(layWins(T, 'color'), 'accent')).toBe(true);
  });

  it('caption (lims-page-caption) is 10.8px neutral.500, no margin, under the title', () => {
    const C = ['.lims-page-caption'];
    expect(near(px(layWins(C, 'font-size')), 10.8), `font-size = ${lay(C, 'font-size')?.value}`).toBe(true);
    expect(colorIs(layWins(C, 'color'), 'neutral-500')).toBe(true);
    const m = box4(C, 'margin');
    expect(m === null || (near(m.top, 0) && near(m.bottom, 0)), 'caption margin is 0').toBe(true);
  });
});

// ======================================================================================================================
describe('done_when 3: cards in one row are equal height; stat tiles equal columns; card title row', () => {
  it('a Grid of cards stretches: align-items stretch on .lims-grid and the card fills its cell', () => {
    expect(lay(['.lims-grid'], 'align-items')?.value).toBe('stretch');
    const fill = lay(['.lims-grid > .lims-card'], 'height')?.value ?? lay(['.lims-grid > .lims-card'], 'block-size')?.value;
    const self = lay(['.lims-grid > .lims-card'], 'align-self')?.value;
    expect(fill === '100%' || self === 'stretch', '.lims-grid > .lims-card { height: 100% } or { align-self: stretch }').toBe(true);
  });

  it('a row of stat tiles is equal columns with a 12px gap and equal heights', () => {
    const ROW = ['.lims-stat-row'];
    expect(near(px(lay(ROW, 'gap')?.value), 12), `gap = ${lay(ROW, 'gap')?.value}`).toBe(true);
    expect(lay(ROW, 'align-items')?.value).toBe('stretch');
    const cols = lay(ROW, 'grid-template-columns')?.value ?? '';
    const auto = lay(ROW, 'grid-auto-columns')?.value ?? '';
    const equal = (v: string) => /1fr/.test(v) && !/\b[02-9]\d*(\.\d+)?fr\b/.test(v);
    expect(equal(cols) || (lay(ROW, 'grid-auto-flow')?.value === 'column' && equal(auto)), 'equal 1fr columns (grid-template-columns: repeat(.., minmax(0, 1fr)) or auto-flow column with 1fr)').toBe(true);
    const tileFill = lay(['.lims-stat-row > .lims-stat'], 'height')?.value ?? lay(['.lims-stat-row > .lims-stat'], 'block-size')?.value;
    const tileSelf = lay(['.lims-stat-row > .lims-stat', '.lims-stat'], 'align-self')?.value;
    expect(tileFill === '100%' || tileSelf === 'stretch', 'each tile fills its cell (height: 100% or align-self: stretch)').toBe(true);
    expect(lay(ROW, 'grid-template-columns', { media: false })?.value ?? '', 'no lead column ratio').not.toMatch(/2fr/);
  });

  it('card title row: h2 at base size, weight 500, one short caption on the right', () => {
    const HEAD = ['.lims-card-head'];
    expect(lay(HEAD, 'display')?.value).toBe('flex');
    expect(lay(HEAD, 'justify-content')?.value).toBe('space-between');
    expect(['baseline', 'center']).toContain(lay(HEAD, 'align-items')?.value);
    const T = ['.lims-card-title'];
    expect(layWins(T, 'font-size')).toBe('var(--lims-font-size-base-size)');
    expect(near(px('var(--lims-font-size-base-size)'), 12.6)).toBe(true);
    expect(layWins(T, 'font-weight')).toBe('var(--lims-font-weight-medium)');
    const C = ['.lims-card-caption'];
    expect(colorIs(layWins(C, 'color'), 'neutral-500')).toBe(true);
    expect(near(px(layWins(C, 'font-size')), 10.8)).toBe(true);
    expect(lay(C, 'white-space')?.value).toBe('nowrap');
  });
});

// ======================================================================================================================
describe('done_when 4: EmptyState, ErrorState and NotAvailable inside a card or a table are compact and centred', () => {
  const sel = (r: Rule, re: RegExp) => r.sels.some((s) => re.test(s));
  const stateRules = (scope: RegExp) => layoutRules.filter((r) => r.media === '' && sel(r, new RegExp(`${scope.source}[^,]*\\.lims-state$`)));
  const CARD = /\.lims-card/;
  const TABLE = /(\.lims-data-table|\.lims-table|\btd\b|\.lims-cell)/;
  const last = (rs: Rule[], prop: string) => rs.filter((r) => r.decls.has(prop)).at(-1)?.decls.get(prop);
  const vpad = (rs: Rule[]) => {
    let top: number | null = null;
    let bottom: number | null = null;
    for (const r of rs) for (const [k, d] of r.decls) {
      const p = d.value.split(/\s+/).map(px);
      if (k === 'padding') { top = p[0] ?? null; bottom = (p.length === 1 ? p[0] : p.length === 2 ? p[0] : p[2]) ?? null; }
      else if (k === 'padding-block') { top = p[0] ?? null; bottom = (p[1] ?? p[0]) ?? null; }
      else if (k === 'padding-top') top = p[0] ?? null;
      else if (k === 'padding-bottom') bottom = p[0] ?? null;
    }
    return { top, bottom };
  };

  for (const [name, scope] of [['a card', CARD], ['a table', TABLE]] as const) {
    describe(`inside ${name}`, () => {
      const rs = stateRules(scope);
      it('has a .lims-state rule scoped to it', () => {
        expect(rs.length, `no layout.css rule for "<scope> .lims-state" (scope ${scope.source})`).toBeGreaterThan(0);
      });
      it('is 24px top and bottom padding, centred, with no min-height stretching', () => {
        const v = vpad(rs);
        expect(near(v.top, 24) && near(v.bottom, 24), `vertical padding ${v.top}/${v.bottom}`).toBe(true);
        const c = last(rs, 'text-align')?.value;
        const ai = last(rs, 'align-items')?.value;
        expect(c === 'center' || ai === 'center', 'centred').toBe(true);
        const mh = last(rs, 'min-height')?.value ?? last(rs, 'min-block-size')?.value;
        expect([undefined, '0', 'auto', 'none']).toContain(mh);
      });
      it('the illustration is 40px', () => {
        const art = layoutRules.filter((r) => r.media === '' && r.sels.some((s) => scope.test(s) && /\.lims-state-art$/.test(s)));
        const w = last(art, 'width')?.value ?? last(art, 'inline-size')?.value;
        const hh = last(art, 'height')?.value ?? last(art, 'block-size')?.value;
        expect(near(px(w), 40), `art width ${w}`).toBe(true);
        expect(near(px(hh), 40), `art height ${hh}`).toBe(true);
      });
      it('shows one title line and one caption line (no wrapping)', () => {
        for (const part of ['.lims-state-title', '.lims-state-body']) {
          const ps = layoutRules.filter((r) => r.media === '' && r.sels.some((s) => scope.test(s) && s.endsWith(part)));
          expect(last(ps, 'white-space')?.value, `${part} white-space`).toBe('nowrap');
          expect(last(ps, 'text-overflow')?.value, `${part} text-overflow`).toBe('ellipsis');
          expect(last(ps, 'overflow')?.value ?? last(ps, 'overflow-x')?.value, `${part} overflow`).toBe('hidden');
        }
      });
    });
  }

  it('several "Not available yet" cards stacked on one screen collapse to a one-row variant, 40px tall, title and caption in one row', () => {
    const stacked = layoutRules.filter((r) => r.media === '' && r.sels.some((s) => /not-available/.test(s) && /(~|\+|:has\([^)]*~)/.test(s)));
    expect(stacked.length, "no rule keyed on [data-art='not-available'] with a sibling combinator (~ or +)").toBeGreaterThan(0);
    const g = (prop: string) => stacked.filter((r) => r.decls.has(prop)).at(-1)?.decls.get(prop)?.value;
    // the row variant: the state lays out as a row, centred, and the box (state or card) is 40px high
    const inState = stacked.filter((r) => r.sels.some((s) => /\.lims-state$/.test(s) || /\.lims-state\b/.test(s)));
    const dir = inState.filter((r) => r.decls.has('flex-direction')).at(-1)?.decls.get('flex-direction')?.value;
    expect(dir, 'flex-direction: row on the collapsed .lims-state').toBe('row');
    const heightVal = g('height') ?? g('block-size') ?? g('min-height') ?? g('min-block-size');
    expect(near(px(heightVal), 40), `collapsed height ${heightVal}`).toBe(true);
    expect(g('align-items') ?? inState.filter((r) => r.decls.has('align-items')).at(-1)?.decls.get('align-items')?.value).toBe('center');
  });
});

// ======================================================================================================================
describe('done_when 5: Banner and ErrorState as a block above a list are one row, 36px high', () => {
  const dangerState = (s: string) => /\.lims-state\b/.test(s) && /(\.lims-tone-danger|\[data-tone='danger'\])/.test(s) && !/\.lims-card\b|\.lims-data-table|\.lims-table\b|\btd\b/.test(s);
  const blocks: Array<[string, (s: string) => boolean]> = [
    ['Banner (.lims-banner)', (s) => /^\.lims-banner(\.lims-tone-danger|\[data-tone='danger'\])?$/.test(s)],
    ['ErrorState block (.lims-state danger, not inside a card or table)', (s) => dangerState(s) && !/\.lims-state-/.test(s.split(' ').at(-1) ?? '')],
  ];
  for (const [name, match] of blocks) {
    describe(name, () => {
      const rs = layoutRules.filter((r) => r.media === '' && r.sels.some((s) => match(s)));
      const last = (prop: string) => rs.filter((r) => r.decls.has(prop)).at(-1)?.decls.get(prop)?.value;
      it('has a rule', () => expect(rs.length, `no layout.css rule for ${name}`).toBeGreaterThan(0));
      it('is a single row 36px high, border-box, centred vertically, text from the left', () => {
        expect(last('display')).toBe('flex');
        expect([undefined, 'row']).toContain(last('flex-direction'));
        expect(last('align-items')).toBe('center');
        expect(near(px(last('height') ?? last('block-size')), 36), `height ${last('height') ?? last('block-size')}`).toBe(true);
        expect(last('box-sizing')).toBe('border-box');
        expect(['start', 'left']).toContain(last('text-align') ?? 'start');
        const pv = rs.flatMap((r) => [...r.decls.entries()]).filter(([k]) => k === 'padding' || k === 'padding-block');
        for (const [, d] of pv) expect(near(px(d.value.split(/\s+/)[0]), 0), `vertical padding ${d.value}`).toBe(true);
      });
    });
  }

  it('danger tone: subtle fill and a 1px danger border on the ErrorState block and on the danger Banner', () => {
    for (const match of [(s: string) => dangerState(s) && !/\.lims-state-/.test(s.split(' ').at(-1) ?? ''), (s: string) => /^\.lims-banner(\.lims-tone-danger|\[data-tone='danger'\])$/.test(s) || /^\.lims-tone-danger\.lims-banner$/.test(s) || /^\.lims-banner\.lims-tone-danger$/.test(s)]) {
      const rs = layoutRules.filter((r) => r.media === '' && r.sels.some(match));
      expect(rs.length, 'a danger-tone rule').toBeGreaterThan(0);
      const decl = (prop: string) => rs.filter((r) => r.decls.has(prop)).at(-1)?.decls.get(prop)?.value;
      expect(decl('background') ?? decl('background-color')).toBe('var(--lims-tone-danger-bg)');
      const border = decl('border');
      const okBorder = border === 'var(--lims-hairline, 0.0625rem) solid var(--lims-tone-danger-border)' || /^0\.0625rem solid var\(--lims-tone-danger-border\)$/.test(border ?? '') || (near(px(decl('border-width')), 1) && decl('border-color') === 'var(--lims-tone-danger-border)');
      expect(okBorder, `1px danger-tone border, got ${border}`).toBe(true);
    }
  });

  it('message left, Retry on the right as a ghost button (transparent, no border, accent text)', () => {
    for (const root of ['.lims-banner', '.lims-state']) {
      const rs = layoutRules.filter((r) => r.media === '' && r.sels.some((s) => s.startsWith(root) && /\.lims-btn$/.test(s) && (root === '.lims-banner' || dangerState(s))));
      expect(rs.length, `a ${root} .lims-btn rule (Retry as ghost)`).toBeGreaterThan(0);
      const decl = (prop: string) => rs.filter((r) => r.decls.has(prop)).at(-1)?.decls.get(prop)?.value;
      expect(decl('background') ?? decl('background-color')).toBe('transparent');
      expect(['0', 'none', '0 none']).toContain(decl('border') ?? decl('border-width') ?? 'MISSING');
      expect(colorIs(decl('color'), 'accent')).toBe(true);
      expect(decl('margin-inline-start') === 'auto' || decl('margin-left') === 'auto', 'pushed to the right').toBe(true);
    }
  });

  it('the banner message is one line (no wrapping) so the row stays 36px', () => {
    const t = layoutRules.filter((r) => r.media === '' && r.sels.some((s) => /\.lims-banner-title$/.test(s) || /\.lims-banner-text$/.test(s)));
    const decl = (prop: string) => t.filter((r) => r.decls.has(prop)).at(-1)?.decls.get(prop)?.value;
    expect(decl('white-space')).toBe('nowrap');
    expect(decl('text-overflow')).toBe('ellipsis');
  });

  it('the danger ErrorState inside a banner row does not draw the 40px illustration (it does not fit 36px)', () => {
    const rs = layoutRules.filter((r) => r.media === '' && r.sels.some((s) => dangerState(s) && /\.lims-state-art$/.test(s)));
    const decl = (prop: string) => rs.filter((r) => r.decls.has(prop)).at(-1)?.decls.get(prop)?.value;
    const hidden = decl('display') === 'none';
    const small = (px(decl('width') ?? decl('inline-size')) ?? 99) <= 24;
    expect(hidden || small, 'art hidden or <= 24px in the one-row ErrorState').toBe(true);
  });
});

// ======================================================================================================================
describe('markup contract (jsdom): the class names the CSS targets exist', () => {
  const noop = () => {};
  const classesOf = (c: Element) => new Set([...c.querySelectorAll('*'), c].flatMap((e) => [...e.classList]));
  const has = (c: Element, cls: string) => c.querySelector(`.${cls}`) !== null || c.classList.contains(cls);

  it('PageShell renders lims-shell-main (the padded, flex column page body)', () => {
    const { container } = render(h(PageShell, { topBar: 'top', nav: 'nav', children: h('p', null, 'body') }));
    const main = container.querySelector('main.lims-shell-main');
    expect(main).not.toBeNull();
    expect(main!.textContent).toBe('body');
  });

  it('PageHeader renders the row, heading block, h1 title, caption and actions the CSS targets', () => {
    const { container } = render(h(PageHeader, { title: 'Worklist', caption: 'Samples registered today', helpKey: 'k', actions: h('button', { type: 'button' }, 'Export'), onHelp: noop }));
    for (const c of ['lims-page-header', 'lims-page-header-row', 'lims-page-heading', 'lims-page-title', 'lims-page-caption', 'lims-page-actions']) expect(has(container, c), c).toBe(true);
    expect(container.querySelector('h1.lims-page-title')?.textContent).toBe('Worklist');
    expect(container.querySelector('p.lims-page-caption')?.textContent).toBe('Samples registered today');
    expect(container.querySelector('.lims-page-heading > h1.lims-page-title + p.lims-page-caption')).not.toBeNull();
    expect(container.querySelector('.lims-page-header-row > .lims-page-actions')).not.toBeNull();
  });

  it('EmptyState renders lims-state with lims-state-art, lims-state-title and lims-state-body', () => {
    const { container } = render(h(Card, { title: 'Parameters', caption: '0 rows', children: h(EmptyState, { title: 'No parameters yet', body: 'Add the first one.' }) }));
    for (const c of ['lims-card', 'lims-card-head', 'lims-card-title', 'lims-card-caption', 'lims-state', 'lims-state-art', 'lims-state-title', 'lims-state-body']) expect(has(container, c), c).toBe(true);
    expect(container.querySelector('.lims-card > .lims-state')).not.toBeNull();
    expect(container.querySelector('.lims-card-head > h2.lims-card-title')).not.toBeNull();
  });

  it('ErrorState and Banner carry the danger tone hooks and the Retry / action button', () => {
    const e = render(h(ErrorState, { title: 'Critical alerts could not be loaded', onRetry: noop }));
    const st = e.container.querySelector('.lims-state');
    expect(st?.classList.contains('lims-tone-danger')).toBe(true);
    expect(st?.getAttribute('data-tone')).toBe('danger');
    expect(e.container.querySelector('.lims-state > .lims-btn')).not.toBeNull();
    cleanup();
    const b = render(h(Banner, { tone: 'danger', title: 'Could not load', action: { label: 'Retry', onPress: noop } }));
    for (const c of ['lims-banner', 'lims-tone-danger', 'lims-banner-text', 'lims-banner-title', 'lims-btn']) expect(has(b.container, c), c).toBe(true);
    expect(b.container.querySelector('.lims-banner > .lims-banner-text')).not.toBeNull();
  });

  it('NotAvailable draws the state art with data-art="not-available" (the stacked variant keys on it)', () => {
    const { container } = render(h(NotAvailable, { title: 'Stock' }));
    expect(container.querySelector(".lims-state > .lims-state-art[data-art='not-available']")).not.toBeNull();
    expect(container.querySelector('.lims-state-title')?.textContent).toBe('Not available yet');
  });

  it('stat tiles: the row holds the tiles as direct children (equal columns need it)', () => {
    const { container } = render(h(StatTileRow, null, ...['a', 'b', 'c', 'd', 'e'].map((k) => h(StatTile, { key: k, label: k, value: '1' }))));
    expect(container.querySelectorAll('.lims-stat-row > .lims-stat').length).toBe(5);
  });

  it('every .lims-* class named in layout.css exists in the kit, shell.css or the rendered markup (no typo targets)', () => {
    const rendered = new Set<string>();
    const add = (el: Element) => classesOf(el).forEach((c) => rendered.add(c));
    add(render(h(PageShell, { topBar: 'a', nav: 'b', children: 'c' })).container);
    add(render(h(PageHeader, { title: 't', caption: 'c', helpKey: 'k' })).container);
    add(render(h(Card, { title: 't', caption: 'c', children: h(EmptyState, { title: 'x', body: 'y' }) })).container);
    add(render(h(ErrorState, { title: 'x', onRetry: noop })).container);
    add(render(h(Banner, { tone: 'danger', title: 'x', action: { label: 'r', onPress: noop } })).container);
    add(render(h(NotAvailable, { title: 'x' })).container);
    const known = (c: string) => rendered.has(c) || new RegExp(`\\.${c}(?![\\w-])`).test(kitSrc) || new RegExp(`\\.${c}(?![\\w-])`).test(shellSrc);
    const used = new Set(layoutSrc.match(/\.lims-[a-z0-9-]+/g)?.map((x) => x.slice(1)) ?? []);
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((c) => !known(c))).toEqual([]);
  });
});
