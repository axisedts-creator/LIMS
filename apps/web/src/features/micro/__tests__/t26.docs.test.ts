// C10.T-26 Help + manual — doc check. Spec: 04-UI-UX §11 ("features/micro/help/ contains one help page per screen key
// (micro.worklist, micro.culture, micro.instrument_records, micro.settings, micro.breakpoint_sets). docs/manual/micro/ pages:
// culture workflow, AST entry and categories (explains CLSI vs EUCAST "I"), breakpoint import (CSV format of 02-TRD §9.1,
// licence responsibility), instrument data matching, amendments"). Plan row T-26: "one help page per screen key; manual reviewed".
// ASSUMED naming (dispute if wrong; same convention as C5 lab/quality/admin help): help/<stem>.md with stem = helpKey minus the
// "micro." prefix, so micro.instrument_records -> instrument_records.md. Manual file names are chosen here (spec lists topics only).
// LD-140: help/manual are plain markdown, so no hex colours, pixel sizes or inline style objects.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const feature = join(root, 'apps/web/src/features/micro');
const helpDir = join(feature, 'help');
const manualDir = join(root, 'docs/manual/micro');
const read = (p: string) => readFileSync(p, 'utf8');
const mdIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : []);
const textOf = (d: string, n: string) => (existsSync(join(d, `${n}.md`)) ? read(join(d, `${n}.md`)) : '');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toRe = (f: string | RegExp) => (typeof f === 'string' ? new RegExp(esc(f)) : f);

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (n === '__tests__' || n === 'help') return [];
    return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(n) ? [p] : [];
  });
}
// Every helpKey a micro screen passes to PageHeader: a new screen without help fails here.
const helpKeys = [...new Set(walk(feature).flatMap((f) => [...read(f).matchAll(/helpKey=["']([a-z_.]+)["']/g)].map((m) => m[1]!)))].sort();
const stem = (k: string) => k.replace(/^micro\./, '').replace(/\./g, '_');

// stem -> route the help must name + screen-specific facts
const SCREENS: Record<string, { route: string; facts: (string | RegExp)[] }> = {
  worklist: { route: '/micro/worklist', facts: ['g u', /awaiting setup/i, /incubating/i, /amending/i] },
  culture: { route: '/micro/cultures/', facts: [/isolate/i, /AST/, /prelim/i, /amend/i] },
  instrument_records: { route: '/micro/instrument-records', facts: [/match/i, /ignore/i] },
  settings: { route: '/micro/settings', facts: ['micro.config.manage'] },
  breakpoint_sets: { route: '/micro/breakpoint-sets', facts: [/CSV/, /licen[cs]e/i, /import/i] },
};

describe('C10 T-26 in-app help: one page per screen key', () => {
  it('discovers the five screen keys (non-vacuous)', () => {
    expect(helpKeys).toEqual(['micro.breakpoint_sets', 'micro.culture', 'micro.instrument_records', 'micro.settings', 'micro.worklist']);
  });
  it('has exactly one help file per helpKey and no orphans', () => {
    expect(existsSync(helpDir), `missing ${helpDir}`).toBe(true);
    expect(mdIn(helpDir).map((n) => n.replace(/\.md$/, '')).sort()).toEqual(helpKeys.map(stem).sort());
  });
  describe.each(Object.keys(SCREENS))('help/%s.md', (s) => {
    const t = () => textOf(helpDir, s);
    it('exists, non-trivial, H1 title, Purpose and Steps sections', () => {
      expect(existsSync(join(helpDir, `${s}.md`)), `missing help/${s}.md`).toBe(true);
      expect(t().length).toBeGreaterThan(300);
      expect(t()).toMatch(/^#\s+\S/m);
      expect(t()).toMatch(/^#{2,3}\s+Purpose\b/im);
      expect(t()).toMatch(/^#{2,3}\s+Steps\b/im);
    });
    it('names its route and screen-specific facts', () => {
      expect(t()).toContain(SCREENS[s]!.route);
      for (const f of SCREENS[s]!.facts) expect(t(), `help/${s}.md must mention ${String(f)}`).toMatch(toRe(f));
    });
  });
  it('culture help explains that "I" differs between CLSI and EUCAST', () => {
    const t = textOf(helpDir, 'culture');
    expect(t).toMatch(/CLSI/);
    expect(t).toMatch(/EUCAST/);
    expect(t).toMatch(/increased exposure/i);
  });
});

// 04-UI-UX §11 — manual topics. File names are this task's choice (spec lists topics only).
const MANUAL: Record<string, (string | RegExp)[]> = {
  'culture-workflow': ['/micro/worklist', '/micro/cultures/', /set.?up/i, /plate/i, /isolate/i, /prelim/i, /final/i],
  'ast-entry-and-categories': [/CLSI/, /EUCAST/, /ECOFF/, /SDD/, /increased exposure/i, /colistin/i, /breakpoint standard/i, /version/i],
  'breakpoint-import': [
    '/micro/breakpoint-sets',
    'organism_scope,organism_code,antibiotic_code,method,specimen_site_code,qualifier_code,category_code,lower_value,lower_inclusive,upper_value,upper_inclusive,note',
    /licen[cs]/i,
    /UTF-8/i,
    'file.header_mismatch',
    'row.bands_overlap',
  ],
  'instrument-data-matching': ['/micro/instrument-records', /match/i, /ignore/i, /unmatched/i],
  amendments: [/amend/i, /reason/i, /reopen|re-open/i, /previous (report|version)/i],
};

describe('C10 T-26 manual pages (docs/manual/micro, 04-UI-UX §11)', () => {
  it('has exactly the five topic pages (plus an optional README)', () => {
    expect(existsSync(manualDir), `missing ${manualDir}`).toBe(true);
    expect(mdIn(manualDir).map((n) => n.replace(/\.md$/, '')).filter((n) => n.toLowerCase() !== 'readme').sort()).toEqual(Object.keys(MANUAL).sort());
  });
  describe.each(Object.keys(MANUAL))('%s.md', (n) => {
    const t = () => textOf(manualDir, n);
    it('exists, non-trivial, H1 title and at least two sections', () => {
      expect(existsSync(join(manualDir, `${n}.md`)), `missing ${n}.md`).toBe(true);
      expect(t().length).toBeGreaterThan(600);
      expect(t()).toMatch(/^#\s+\S/m);
      expect((t().match(/^##\s+\S/gm) ?? []).length).toBeGreaterThanOrEqual(2);
    });
    it('covers its topic facts', () => {
      for (const f of MANUAL[n]!) expect(t(), `${n}.md must mention ${String(f)}`).toMatch(toRe(f));
    });
    it('contains no real-looking identifiers or secrets (synthetic data only)', () => {
      expect(t()).not.toMatch(/\b\d{10,}\b/);
      expect(t()).not.toMatch(/[\w.+-]+@(?!example\.(com|org|test))[\w-]+\.[a-z]{2,}/i);
      expect(t()).not.toMatch(/(password|secret|api[_-]?key|token)\s*[:=]\s*\S+/i);
    });
  });
  it('breakpoint-import states the licence responsibility', () => {
    expect(textOf(manualDir, 'breakpoint-import')).toMatch(/only (contain )?(breakpoint )?data (your|the) (laboratory|lab) is licen[cs]ed to use/i);
  });
  it('no dead relative .md links in manual or help', () => {
    expect(existsSync(manualDir), `missing ${manualDir}`).toBe(true);
    for (const d of [manualDir, helpDir])
      for (const n of mdIn(d))
        for (const m of read(join(d, n)).matchAll(/\]\(((?!https?:|#)[^)\s#]+\.md)(?:#[^)]*)?\)/g)) expect(existsSync(join(d, m[1]!)), `${n}: dead link ${m[1]}`).toBe(true);
  });
  it('LD-140: help and manual carry no hex colours, pixel sizes or inline style objects', () => {
    const files = [...mdIn(helpDir).map((x) => join(helpDir, x)), ...mdIn(manualDir).map((x) => join(manualDir, x))];
    expect(files.length, 'no help/manual files to lint').toBeGreaterThan(0);
    for (const f of files) {
      const t = read(f);
      expect(t, `${f}: hex colour`).not.toMatch(/(^|[\s(])#[0-9a-f]{6}\b/i);
      expect(t, `${f}: px value`).not.toMatch(/\b\d+px\b/);
      expect(t, `${f}: inline style`).not.toMatch(/style\s*=\s*\{\{/);
    }
  });
});
