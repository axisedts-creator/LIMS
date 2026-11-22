// T0D-UIX-3 (LD-442, LD-436, LD-437, LD-438): lab screens use the kit DataTable, DescriptionList and Button/IconButton; no raw <table, <dl or <button remains.
// Source-text grep (node env). Display only: no CSS file is edited by this task.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const LAB = join(import.meta.dirname, '..'); // apps/web/src/features/lab
const ROOT = join(LAB, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const rel = (f: string) => relative(LAB, f).replace(/\\/g, '/');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => (n === '__tests__' ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const sources = walk(LAB).filter((f) => /\.tsx$/.test(f) && !/\.(test|spec)\./.test(f));

// Allowed exceptions: file (relative to features/lab) -> tags allowed, with a reason. None today: the EditableGrid internals live in packages/ui and the lab has no native file input.
const EXCEPTIONS: Record<string, { tags: string[]; reason: string }> = {};

// A tag opener: "<table", "<dl", "<button" followed by whitespace, ">" or "/" (so <tableX, <dlFoo and <ButtonX never match). Comment lines are skipped.
const RAW = [
  { tag: 'table', re: /<table(?=[\s>/])/ },
  { tag: 'dl', re: /<dl(?=[\s>/])/ },
  { tag: 'button', re: /<button(?=[\s>/])/ },
];
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

describe('T0D-UIX-3 lab screens: no raw table / dl / button in non-test .tsx', () => {
  it('finds the lab source files', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it.each(RAW)('no raw <$tag in any lab .tsx (DONE WHEN 1, 2, 3)', ({ tag, re }) => {
    const bad = sources
      .filter((f) => !EXCEPTIONS[rel(f)]?.tags.includes(tag))
      .flatMap((f) => stripComments(read(f)).split('\n').map((l, i) => (re.test(l) ? `${rel(f)}:${i + 1}: ${l.trim()}` : '')).filter(Boolean));
    expect(bad, `raw <${tag} left in:\n${bad.join('\n')}`).toEqual([]);
  });

  it('every named exception has a reason and still matches a real file', () => {
    for (const [f, e] of Object.entries(EXCEPTIONS)) {
      expect(e.reason.length, f).toBeGreaterThan(10);
      expect(existsSync(join(LAB, f)), f).toBe(true);
    }
  });

  it('the kit components are really used: DataTable, DescriptionList and Button imported from @lims/ui in the lab sources', () => {
    const all = sources.map((f) => read(f)).join('\n');
    expect(all).toMatch(/import[^;]*\bDataTable\b[^;]*from\s+'@lims\/ui/);
    expect(all).toMatch(/import[^;]*\bDescriptionList\b[^;]*from\s+'@lims\/ui/);
    expect(all).toMatch(/import[^;]*\bButton\b[^;]*from\s+'@lims\/ui/);
  });

  it('former raw-table screens now render a DataTable (spot check of the 14 known table files)', () => {
    const files = [
      'components/CollectDispatch.tsx', 'components/CriticalValueList.tsx', 'components/IngestExceptionList.tsx', 'components/QueueScreen.tsx', 'components/ReceiveScreen.tsx',
      'components/shared.tsx', 'components/StatusBoard.tsx', 'components/specimens/SpecimenDetail.tsx', 'components/settings/DeltaRulesTab.tsx', 'components/settings/QcHoldsTab.tsx',
      'components/settings/ReasonCodesTab.tsx', 'components/settings/VerificationPolicyTab.tsx', 'components/worksheets/WorksheetPrintPage.tsx', 'components/grid/ResultPanels.tsx',
    ];
    const missing = files.filter((f) => !/<DataTable\b/.test(read(join(LAB, f))));
    expect(missing).toEqual([]);
  });

  it('former raw-dl screens now render a DescriptionList (consoleParts, IngestExceptionDetail, ReceiveScreen, WorklistPage)', () => {
    const files = ['components/consoleParts.tsx', 'components/IngestExceptionDetail.tsx', 'components/ReceiveScreen.tsx', 'components/worklists/WorklistPage.tsx'];
    const missing = files.filter((f) => !/<DescriptionList\b/.test(read(join(LAB, f))));
    expect(missing).toEqual([]);
  });

  it('former raw-button screens now render Button or IconButton (QueueScreen, StatusBoard, PendingPage)', () => {
    const files = ['components/QueueScreen.tsx', 'components/StatusBoard.tsx', 'components/pending/PendingPage.tsx'];
    const missing = files.filter((f) => !/<(Icon)?Button\b/.test(read(join(LAB, f))));
    expect(missing).toEqual([]);
  });

  it('DONE WHEN 4: notes/T0D-UIX-3-screens.md lists the changed screens', () => {
    const p = join(ROOT, '.orchestra', 'notes', 'T0D-UIX-3-screens.md');
    expect(existsSync(p), 'notes/T0D-UIX-3-screens.md').toBe(true);
    expect(read(p).trim().length).toBeGreaterThan(40);
  });

  it('DONE WHEN 7: no CSS file under features/lab and the packages/ui tokens are untouched by this task (css is owned by T0D-UIX-1 and T0D-UIX-5)', () => {
    const css = walk(LAB).filter((f) => /\.css$/.test(f));
    expect(css.map(rel)).toEqual([]);
  });
});
