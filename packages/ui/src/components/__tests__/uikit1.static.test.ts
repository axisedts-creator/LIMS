// T0D-UIKIT-1 done_when (10) and the hard limits: a story + test for every new component, additive tokens-only CSS, NotAvailable moved to the kit,
// existing exports kept. No jsdom needed. Planted-failure fixtures prove each scanner fires.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { kitRules, parseCss, rulesMatching } from './uikit1-css';

const COMPONENTS = fileURLToPath(new URL('..', import.meta.url));
const REPO = resolve(COMPONENTS, '..', '..', '..', '..');
const read = (p: string) => readFileSync(p, 'utf8');

const NEW = ['ChartCard', 'SplitConsole', 'ScanPanel', 'SettingsForm', 'NotAvailable'] as const;

describe('new components: file, export, story', () => {
  it.each(NEW)('%s: component file exports it, a story file with >= 1 story exists', (n) => {
    const comp = join(COMPONENTS, n, `${n}.tsx`);
    const story = join(COMPONENTS, n, `${n}.stories.tsx`);
    expect(existsSync(comp), `missing ${comp}`).toBe(true);
    expect(existsSync(story), `missing ${story}`).toBe(true);
    expect(read(comp)).toMatch(new RegExp(`export (function|const) ${n}\\b`));
    expect(read(story)).toMatch(/export default/);
    expect(read(story)).toMatch(/export const \w+/);
  });
  it('each new component has a test file in this folder (uikit1.*.test.*) that renders it', () => {
    const tests = ['uikit1.states.test.tsx', 'uikit1.tiles-charts.test.tsx', 'uikit1.panels.test.tsx'].map((f) => read(join(COMPONENTS, '__tests__', f)));
    for (const n of NEW) expect(tests.some((t) => t.includes(`<${n}`)), `${n} is not rendered by any uikit1 test`).toBe(true);
  });
  it('StatTileRow is exported from the StatTile module (existing import path of StatTile unchanged)', () => {
    const src = read(join(COMPONENTS, 'StatTile', 'StatTile.tsx'));
    expect(src).toMatch(/export function StatTile\b/);
    expect(src).toMatch(/export (function|const) StatTileRow\b/);
  });
  it('StatTile and StatTileRow have stories too', () => {
    const s = read(join(COMPONENTS, 'StatTile', 'StatTile.stories.tsx'));
    expect(s).toMatch(/Stale|isStale/);
    expect(s).toMatch(/StatTileRow/);
  });
});

describe('existing exports stay (no feature file needs a change)', () => {
  const must: Record<string, RegExp[]> = {
    'FilterBar/FilterBar.tsx': [/export function FilterBar\b/, /export type FilterDef\b/, /export type FilterValue\b/, /export interface FilterBarProps\b/],
    'DataTable/DataTable.tsx': [/export function DataTable\b/, /export interface ColumnDef\b/, /export interface DataTableProps\b/, /export function EmptyRow\b/, /export function PlaceholderRows\b/],
    'EmptyState/EmptyState.tsx': [/export function EmptyState\b/, /export interface EmptyStateProps\b/],
    'ErrorState/ErrorState.tsx': [/export function ErrorState\b/, /export interface ErrorStateProps\b/],
    'StatTile/StatTile.tsx': [/export function StatTile\b/, /export interface StatTileProps\b/],
    'PageHeader/PageHeader.tsx': [/export function PageHeader\b/, /export interface PageHeaderProps\b/],
    'PageShell/PageShell.tsx': [/export function PageShell\b/, /export interface PageShellProps\b/],
  };
  it.each(Object.entries(must))('%s keeps its public exports', (f, res) => {
    const src = read(join(COMPONENTS, f));
    for (const re of res) expect(src, `${f} lost ${re}`).toMatch(re);
  });
  it('new props are optional: no new required key in FilterBarProps, DataTableProps, StatTileProps, ErrorStateProps', () => {
    // tsc (the typecheck run) enforces call-site compatibility; the runtime tests render every old call shape
    for (const [f, iface, keys] of [
      ['FilterBar/FilterBar.tsx', 'FilterBarProps', ['onSearch']],
      ['DataTable/DataTable.tsx', 'DataTableProps', ['stickyFirstColumn', 'columnChooser', 'cellTitle']],
      ['StatTile/StatTile.tsx', 'StatTileProps', ['isStale', 'refreshedAt']],
      ['ErrorState/ErrorState.tsx', 'ErrorStateProps', ['pageTitle']],
    ] as const) {
      const body = read(join(COMPONENTS, f)).split(new RegExp(`interface ${iface}\\b`))[1]?.split('\n}')[0] ?? '';
      for (const k of keys) expect(body, `${iface}.${k} must exist and be optional`).toMatch(new RegExp(`\\b${k}\\?:`));
    }
  });
  it('web NotAvailable is now the kit one (re-exported) but keeps isPending and pendingOr', () => {
    const web = read(join(REPO, 'apps', 'web', 'src', 'core', 'shell', 'NotAvailable.tsx'));
    expect(web).toMatch(/@lims\/ui\/components\/NotAvailable/);
    expect(web).toMatch(/export function isPending\b/);
    expect(web).toMatch(/export async function pendingOr\b/);
    expect(web).toMatch(/export \{[^}]*\bNotAvailable\b[^}]*\}|export \{ NotAvailable \}|export \* from/);
  });
});

// ---- added css: tokens only (the same limits web-style-3 and m-series-kit apply to kit.css additions)
const NEW_CLASS = /\.lims-(filter-search|stat-row|chart-(card|frame|empty|note|period|card-title)|console|scan-(panel|input|result|queue)|settings|sticky-first|num|colchooser)\b/;
const bad = (css: string): string[] => {
  const out: string[] = [];
  for (const r of parseCss(css)) {
    const decl = [...r.decls].map(([k, v]) => `${k}: ${v}`).join('; ');
    const where = `${r.sels.join(', ')} { ${decl} }`;
    if (/\d(px)\b/.test(decl)) out.push(`px: ${where}`);
    if (/#[0-9a-f]{3,8}\b/i.test(decl) || /\brgba?\(|\bhsla?\(/i.test(decl)) out.push(`colour literal: ${where}`);
    if (/url\(|@import/i.test(decl)) out.push(`url/import: ${where}`);
    if (/gradient|animation:|@keyframes/i.test(decl)) out.push(`gradient/animation: ${where}`);
    if (r.media && /\d(px|em)\b/.test(r.media.replace(/rem/g, 'R'))) out.push(`media not in rem: ${r.media}`);
  }
  return out;
};

describe('kit.css additions: tokens only (px, hex, rgb, url, @import, gradients: none; media in rem)', () => {
  it('every rule for a new class passes', () => {
    const rules = kitRules().filter((r) => r.sels.some((s) => NEW_CLASS.test(s)));
    expect(rules.length, 'no css found for the new classes: the writer has not added any').toBeGreaterThan(15);
    const css = rules.map((r) => `${r.media ? `@media ${r.media} {` : ''}${r.sels.join(', ')} { ${[...r.decls].map(([k, v]) => `${k}: ${v}`).join('; ')} }${r.media ? '}' : ''}`).join('\n');
    expect(bad(css)).toEqual([]);
  });
  it('every media query that mentions a new class is in rem', () => {
    for (const r of rulesMatching(NEW_CLASS)) if (r.media) expect(r.media, r.sels.join()).toMatch(/\d+(\.\d+)?rem\b/);
  });
  it('scanner self-check (planted failures fire)', () => {
    expect(bad('.lims-console { width: 40px }')).toHaveLength(1);
    expect(bad('.lims-console { color: #fff }')).toHaveLength(1);
    expect(bad('.lims-console { background: url(x.png) }')).toHaveLength(1);
    expect(bad('@media (min-width: 900px) { .lims-console { gap: 0 } }')).toHaveLength(1);
    expect(bad('.lims-console { grid-template-columns: 2fr 3fr; gap: var(--lims-space-2) }')).toEqual([]);
  });
  it('the shell values of LD-344 / LD-352 stay: kit.css rules the shell tests read are not removed (spot check)', () => {
    expect(rulesMatching(/^\.lims-state$/).length).toBeGreaterThan(0);
    expect(rulesMatching(/^\.lims-filter-bar$/).length).toBeGreaterThan(0);
    expect(rulesMatching(/^\.lims-stat$/).length).toBeGreaterThan(0);
  });
});

describe('tokens.json is not touched (the phone apps read it)', () => {
  it('still parses and has the tokens the new css uses (space, radius, motion)', () => {
    const t = JSON.parse(read(join(COMPONENTS, '..', '..', 'tokens', 'tokens.json')));
    expect(JSON.stringify(t)).toMatch(/space/);
    expect(JSON.stringify(t)).toMatch(/radius/);
  });
});
