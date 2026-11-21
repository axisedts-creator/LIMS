// T0D-UIGUARD-1-REPORTING (LD-436 look, LD-437 exact match, LD-439 a/b/e, LD-441): the reporting area leaves the rule 7 legacy baseline and is rebuilt on the kit parts.
// Source level (node, no render): (1) no reporting component file has a raw h1 to h4 or a raw ul/ol for page structure (rule 7) and none hides a table header when empty (rule 5);
// (2) ReportsWorklist is PageHeader + caption, Tabs, FilterBar (Clear filters), kit DataTable (no SimpleTable), StatusChip; (3) ReportDetailView uses Card title rows, Timeline, StatusChip;
// (4) display only: the default status tab, the permission codes and the server files are the ones in the spec (nothing renamed); (5) the registry holds no REPORTING line and no /reporting route (LD-439 b).
// The registry lines were deleted in core/__tests__/uiguard1.exceptions.ts, so uiguard1.guard.test.ts goes red until the pages hold.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hidesTableHeaderWhenEmpty, rawStructureViolations } from '@/core/__tests__/uiguard1.helpers';

const FEATURE = join(__dirname, '..');
const DIR = join(FEATURE, 'components');
const PAGES = join(FEATURE, '..', '..', 'app', '(staff)', 'reporting');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.tsx')).sort();
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const page = (rel: string) => readFileSync(join(PAGES, rel), 'utf8');

describe('rule 7 + rule 5 over every reporting component file (LD-439 a)', () => {
  it('finds the component files', () => expect(FILES.length).toBeGreaterThan(15));
  it.each(FILES)('%s has no raw h1 to h4 and no raw ul or ol for page structure', (f) => expect(rawStructureViolations(read(f))).toEqual([]));
  it.each(FILES)('%s does not hide its table header when the list is empty', (f) => expect(hidesTableHeaderWhenEmpty(read(f))).toBe(false));
});

describe('the ten reporting pages hold no raw structure either', () => {
  const PAGE_FILES = ['page.tsx', 'reports/[report_id]/page.tsx', 'deliveries/page.tsx', 'deliveries/[delivery_id]/page.tsx', 'messages/page.tsx', 'narratives/[narrative_id]/page.tsx', 'outsourced/page.tsx', 'settings/page.tsx', 'templates/page.tsx', 'templates/[template_id]/page.tsx'];
  it.each(PAGE_FILES)('%s', (f) => expect(rawStructureViolations(page(f))).toEqual([]));
});

describe('ReportsWorklist follows the Front-desk worklist mock (LD-436, LD-437)', () => {
  const src = read('ReportsWorklist.tsx');
  it('is built from PageHeader, Tabs, FilterBar and the kit DataTable, not the SimpleTable wrapper', () => {
    for (const part of ['PageHeader', 'Tabs', 'FilterBar', 'DataTable']) {
      expect(src, `${part} imported from the kit`).toMatch(new RegExp(`from '@lims/ui/components/${part}'`));
      expect(src, `${part} rendered`).toMatch(new RegExp(`<${part}\\b`));
    }
    expect(src).not.toMatch(/<SimpleTable\b/);
  });
  it('draws the status as a StatusChip (directly or through the shared Chip)', () => {
    expect(src).toMatch(/<StatusChip\b|<Chip\b/);
    expect(read('format.tsx')).toMatch(/<StatusChip\b/);
  });
  it('gives the FilterBar a "Clear filters" reset and a one line caption under the title (display text only)', () => {
    expect(src).toMatch(/resetLabel="Clear filters"/);
    expect(src, 'PageHeader gets a caption').toMatch(/<PageHeader\b[\s\S]*?\bcaption=/);
    expect(src).toMatch(/<PageHeader\b[\s\S]*?title="Reports"/);
  });
  it('keeps the six statuses and the lookup, centre, family, registered, review filters', () => {
    for (const k of ['awaiting_content', 'ready_to_release', 'held', 'render_failed', 'released_today', 'all']) expect(read('../server/types.ts')).toContain(`'${k}'`);
    for (const id of ["'lookup'", "'centre_id'", "'family'", "'registered'", "'review'"]) expect(src).toContain(id);
  });
  it('display only: default status tab, bulk release code and server actions are unchanged', () => {
    expect(readFileSync(join(FEATURE, 'server', 'read.server.ts'), 'utf8')).toMatch(/: 'ready_to_release'/);
    expect(src).toContain("'reporting.report.bulk_release'");
    expect(src).toContain("'lab.specimen.read'");
    expect(src).toMatch(/bulkReleaseAction\(/);
    expect(src).toMatch(/searchReportsAction\(/);
  });
});

describe('ReportDetailView uses Card title rows, Timeline and StatusChip (LD-436)', () => {
  const src = read('ReportDetailView.tsx');
  it('imports and renders Card (with title), Timeline', () => {
    expect(src).toMatch(/from '@lims\/ui\/components\/Card'/);
    expect(src).toMatch(/<Card\b[^>]*\btitle=/);
    expect(src).toMatch(/from '@lims\/ui\/components\/Timeline'/);
    expect(src).toMatch(/<Timeline\b/);
  });
  it('shows status through StatusChip and keeps the permission gated buttons', () => {
    expect(src).toMatch(/<StatusChip\b|<Chip\b/);
    for (const p of ['reporting.report.release', 'reporting.report.print', 'reporting.report.regenerate']) expect(src, p).toContain(`'${p}'`);
    for (const label of ['Download', 'Print', 'Release']) expect(src, label).toContain(label);
  });
});

describe('registry (LD-439 b, LD-441): nobody re-adds a REPORTING entry', () => {
  it('uiguard1.exceptions.ts holds no REPORTING line and nothing for /reporting routes', () => {
    const src = readFileSync(join(FEATURE, '..', '..', 'core', '__tests__', 'uiguard1.exceptions.ts'), 'utf8');
    expect(src).not.toMatch(/REPORTING/);
    expect(src).not.toMatch(/'\/reporting[/']/);
  });
});
