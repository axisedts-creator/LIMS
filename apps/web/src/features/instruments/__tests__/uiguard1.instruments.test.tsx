// @vitest-environment jsdom
// T0D-UIGUARD-1-INSTRUMENTS (LD-353 rule 5, LD-436 R7, LD-439 a/b): the instruments area leaves the legacy baseline.
// (1) ReprocessDialog's outcome table keeps its header row when the record list is empty (/instruments/messages/[instrument_message_id]);
// (2) no raw h1 to h4 and no raw ul/ol for page structure in any instruments component file, and the table-header guard (rule 5) finds nothing in them.
// The registry lines of INSTRUMENTS are deleted in core/__tests__/uiguard1.exceptions.ts, so uiguard1.guard.test.ts goes red until the same holds for the pages.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hidesTableHeaderWhenEmpty, rawStructureViolations } from '@/core/__tests__/uiguard1.helpers';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }), usePathname: () => '/instruments/messages/x', useSearchParams: () => new URLSearchParams() }));

afterEach(cleanup);

const DIR = join(__dirname, '..', 'components');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.tsx')).sort();

describe('T0D-UIGUARD-1-INSTRUMENTS rule 5: ReprocessDialog outcome table with no records', () => {
  it('keeps the header row (Barcode, Code, Outcome) and says in the body that no records were produced', async () => {
    const { OutcomeTable } = await import('../components/ReprocessDialog');
    render(<OutcomeTable records={[]} />);
    const table = screen.getByRole('grid');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Barcode', 'Code', 'Outcome']);
    expect(within(table).getByText(/no records were produced/i)).toBeTruthy();
  });

  it('with records it still draws one body row per record under the same header', async () => {
    const { OutcomeTable } = await import('../components/ReprocessDialog');
    render(<OutcomeTable records={[{ id: 'r1', sample_barcode: 'SYN-0001', instrument_analyte_code: 'GLU', port_outcome: null, port_reason_code: null } as never]} />);
    const table = screen.getByRole('grid');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
    expect(within(table).getByText('SYN-0001')).toBeTruthy();
    expect(within(table).queryByText(/no records were produced/i)).toBeNull();
  });

  it('the file no longer swaps the table for other markup when the list is empty (guard detector rule 5)', () => {
    expect(hidesTableHeaderWhenEmpty(readFileSync(join(DIR, 'ReprocessDialog.tsx'), 'utf8'))).toBe(false);
  });
});

describe('T0D-UIGUARD-1-INSTRUMENTS rule 7 + rule 5 over every instruments component file', () => {
  it('finds the component files', () => expect(FILES.length).toBeGreaterThan(10));
  it.each(FILES)('%s has no raw h1 to h4 and no raw ul or ol for page structure', (f) => {
    expect(rawStructureViolations(readFileSync(join(DIR, f), 'utf8'))).toEqual([]);
  });
  it.each(FILES)('%s does not hide its table header when the list is empty', (f) => {
    expect(hidesTableHeaderWhenEmpty(readFileSync(join(DIR, f), 'utf8'))).toBe(false);
  });
});

describe('T0D-UIGUARD-1-INSTRUMENTS registry', () => {
  it('uiguard1.exceptions.ts holds no INSTRUMENTS line and nothing for /instruments routes (LD-439 b: nobody re-adds one)', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', 'core', '__tests__', 'uiguard1.exceptions.ts'), 'utf8');
    expect(src).not.toMatch(/INSTRUMENTS/);
    expect(src).not.toMatch(/'\/instruments\//);
  });
});
