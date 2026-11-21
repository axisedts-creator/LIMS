// T0D-UIGUARD-1-INVENTORY (LD-353 rules 2 and 6, LD-436 R7, LD-439 a/b): the inventory area leaves the legacy baseline.
// (1) RulesView draws its filters with the kit FilterBar, not a hand-built role=search div (/inventory/reports, /rules, /unresolved);
// (2) ReportBody wraps every chart in ChartCard (/inventory/reports);
// (3) no inventory component file has a raw h1 to h4 or a raw ul/ol for page structure (rule 7), and none hides a table header when empty (rule 5);
// (4) the registry holds no INVENTORY line and no /inventory route (nobody re-adds one, LD-439 b).
// The registry lines were deleted in core/__tests__/uiguard1.exceptions.ts, so uiguard1.guard.test.ts goes red until the pages hold.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handBuiltFilterRow, hidesTableHeaderWhenEmpty, rawStructureViolations, unwrappedCharts } from '@/core/__tests__/uiguard1.helpers';

const DIR = join(__dirname, '..', 'components');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.tsx')).sort();
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

describe('rule 2: RulesView uses FilterBar', () => {
  it('imports and renders the kit FilterBar', () => {
    const src = read('RulesView.tsx');
    expect(src).toMatch(/from '@lims\/ui\/components\/FilterBar'/);
    expect(src).toMatch(/<FilterBar\b/);
  });
  it('has no hand-built filter row (guard detector rule 2)', () => expect(handBuiltFilterRow(read('RulesView.tsx'))).toBe(false));
  it('keeps the four filters and the history switch reachable by label', () => {
    const src = read('RulesView.tsx');
    for (const l of ['Kind filter', 'Test filter', 'Analyser filter', 'Item filter', 'Show history']) expect(src).toContain(l);
  });
});

describe('rule 6: ReportBody puts every chart in ChartCard', () => {
  it('draws the daily consumption BarChart inside a ChartCard', () => {
    const src = read('ReportBody.tsx');
    expect(src).toMatch(/from '@lims\/ui\/components\/ChartCard'/);
    expect(src).toMatch(/<ChartCard\b/);
    expect(unwrappedCharts(src)).toBe(0);
  });
});

describe('rule 7 + rule 5 over every inventory component file', () => {
  it('finds the component files', () => expect(FILES.length).toBeGreaterThan(30));
  it.each(FILES)('%s has no raw h1 to h4 and no raw ul or ol for page structure', (f) => expect(rawStructureViolations(read(f))).toEqual([]));
  it.each(FILES)('%s does not hide its table header when the list is empty', (f) => expect(hidesTableHeaderWhenEmpty(read(f))).toBe(false));
});

describe('registry', () => {
  it('uiguard1.exceptions.ts holds no INVENTORY line and nothing for /inventory routes', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', 'core', '__tests__', 'uiguard1.exceptions.ts'), 'utf8');
    expect(src).not.toMatch(/INVENTORY/);
    expect(src).not.toMatch(/'\/inventory\//);
  });
});
