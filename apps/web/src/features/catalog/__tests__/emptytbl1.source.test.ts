// T0D-EMPTYTBL-1 — source scan (LD-310; founder 2026-11-17 04:49 NPT: "all other screens should contain the table whose column names are visible even without value").
// A list component under apps/web/src/features must NOT return/branch to an EmptyState (or the bare `lims-state` card) INSTEAD of the table when it
// has a table whose columns are known. The empty message belongs inside the table body (kit DataTable `emptyState`, MasterTable, SimpleTable).
// Allow list = screens that are not tables (scan screens, dialogs, dashboards, card grids) or are pinned by rs-c2.static (admin / platform: off limits to this task).
// Every allow-list entry must still exist AND still match the pattern (a stale entry fails), so the list cannot silently grow stale.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FEATURES = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/src/features/
const norm = (p: string) => p.split(sep).join('/');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' || n === 'node_modules' ? [] : walk(p);
    return /\.tsx$/.test(n) && !/\.(test|spec|stories)\.tsx$/.test(n) ? [p] : [];
  });
}

/** `rows.length === 0 ? <EmptyState` | `rows.length === 0 && <EmptyState` | `if (…length === 0) return <EmptyState` | `return <EmptyState` | the bare lims-state card. */
const EARLY = [
  /(?:length\s*===\s*0|!\s*[\w.?]+\.length|\.length\s*<\s*1)\s*\)?\s*(?:\?\s*\(?\s*|&&\s*)(?:<EmptyState|<div className="lims-state")/,
  /if\s*\([^)]*(?:length\s*===\s*0|!\s*[\w.?]+\.length)[^)]*\)\s*return\s*\(?\s*<EmptyState/,
  /^\s*return\s*\(?\s*<EmptyState/m,
];
const HAS_TABLE = /<table|<DataTable|<SimpleTable|<MasterTable/;

/** file (relative to features/) -> why it may keep an empty state instead of a table. Keep it SHORT; a list screen never belongs here. */
const DEFERRED = 'NOT named in the T0D-EMPTYTBL-1 brief (16 file cap); a list screen, so the lead should schedule a follow-up and delete this entry';
const ALLOW: Record<string, string> = {
  'lab/components/CollectDispatch.tsx': 'scan screens: "Scan a label to start" / "Scan collected specimens…" (no columns before a scan)',
  // (DepartmentIndex is a link picker and does not match the pattern, so it needs no entry)
  'anatomic/components/config/TemplatesTab.tsx': DEFERRED,
  'anatomic/components/config/TestProfilesTab.tsx': DEFERRED,
  'anatomic/components/molecular/BatchesScreen.tsx': DEFERRED,
  'anatomic/components/molecular/MolecularTab.tsx': DEFERRED,
  'catalog/components/SurchargeRulesScreen.tsx': DEFERRED,
  'catalog/components/TaxScreen.tsx': DEFERRED,
  'engagement/components/AppAccess.tsx': DEFERRED,
  'instruments/components/InstrumentMappings.tsx': DEFERRED,
  'lab/components/worksheets/WorksheetListPage.tsx': DEFERRED,
  'quality/components/LjView.tsx': DEFERRED,
  'smartreport/components/LibraryList.tsx': DEFERRED,
};
/** rs-c2.static pins these trees; this task may not touch them. */
const OFF_LIMITS = /^(admin|platform)\//;

const offenders = (): string[] =>
  walk(FEATURES)
    .map((f) => ({ rel: norm(relative(FEATURES, f)), src: readFileSync(f, 'utf8') }))
    .filter(({ rel, src }) => !OFF_LIMITS.test(rel) && HAS_TABLE.test(src) && EARLY.some((re) => re.test(src)))
    .map(({ rel }) => rel)
    .sort();

describe('T0D-EMPTYTBL-1 no list screen swaps its table for an empty-state card', () => {
  it('the scan itself works: it finds the files named in the brief on a broken tree (guards against a regex that matches nothing)', () => {
    // the pattern must be able to see the three shapes; checked on literals so it passes before and after the fix
    expect(EARLY.some((re) => re.test('{rows.length === 0 ? <EmptyState title="x" /> : (<table/>)}'))).toBe(true);
    expect(EARLY.some((re) => re.test('  if (rows.length === 0) return <EmptyState {...empty} />;'))).toBe(true);
    expect(EARLY.some((re) => re.test('{load.s === \'ok\' && rows.length === 0 ? <div className="lims-state"><p/></div> : null}'))).toBe(true);
    expect(EARLY.some((re) => re.test('<EmptyState title={empty} />'))).toBe(false); // inside a body cell is fine
  });

  it('no list component under features/ (except the allow list) returns an EmptyState / lims-state card before its table', () => {
    const bad = offenders().filter((rel) => !(rel in ALLOW));
    // the failure message lists every file still to fix
    expect(bad, `list screens that still hide their column headers when empty:\n${bad.join('\n')}`).toEqual([]);
  });

  it('every allow-list entry exists and still has the pattern (no stale entries)', () => {
    const live = new Set(offenders());
    const stale = Object.keys(ALLOW).filter((rel) => !live.has(rel));
    expect(stale, `stale allow-list entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('the screens named by the founder are NOT on the allow list', () => {
    const named = [
      'lab/components/CriticalValueList.tsx', 'lab/components/IngestExceptionList.tsx', 'lab/components/StatusBoard.tsx', 'lab/components/QueueScreen.tsx',
      'lab/components/worklists/WorklistPage.tsx', 'lab/components/pending/PendingPage.tsx', 'reporting/components/SimpleTable.tsx',
      'anatomic/components/tracking/TrackingScreen.tsx', 'catalog/components/PriceListsList.tsx', 'catalog/components/master-ui.tsx',
    ];
    expect(named.filter((n) => n in ALLOW)).toEqual([]);
  });

  it('does not scan or require anything under admin / platform (off limits, rs-c2.static)', () => {
    expect(OFF_LIMITS.test('admin/components/X.tsx')).toBe(true);
    expect(OFF_LIMITS.test('platform/TenantDetail.tsx')).toBe(true);
    expect(OFF_LIMITS.test('lab/components/X.tsx')).toBe(false);
  });
});
