// @vitest-environment jsdom
// T0D-UIGUARD-1-HOMECOLLECTION (tester-owned). LD-353 rule 2 (FilterBar) and rule 5 (header row kept when empty) on /homecollection/dispatch; LD-436 look: one filter row, tables keep their header.
// Display only: the filter row keeps every control, URL write and permission of hc-t18.board.test.tsx. Fixtures come from hc-t18.helpers.tsx (synthetic).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { A1, A2, A3, B1, CENTRE, CENTRES, CODES, DATE, PERMS_DISPATCH, ROUTES, VISITS, userEvent, wrap } from './hc-t18.helpers';

const push = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/homecollection/dispatch',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
afterEach(() => { cleanup(); push.mockReset(); replace.mockReset(); });

const SRC = readFileSync(join(process.cwd(), 'src/features/homecollection/components/DispatchBoard.tsx'), 'utf8'); // vitest root = apps/web
const view = async (o: { visits?: unknown[]; routes?: unknown[] } = {}) => {
  const path = '../components/DispatchBoard'; // variable path: a missing file fails each test, not the whole suite
  const { DispatchBoard } = (await import(/* @vite-ignore */ path)) as { DispatchBoard: (p: any) => any };
  return wrap(<DispatchBoard date={DATE} centreId={CENTRE} centres={CENTRES} visits={(o.visits ?? VISITS) as never} routes={(o.routes ?? ROUTES) as never} permissions={PERMS_DISPATCH} codes={CODES} />);
};
const headers = (grid: HTMLElement) => within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());

describe('rule 2: the filter row is the kit FilterBar', () => {
  it('source renders <FilterBar and no hand built lims-filter-bar row', () => {
    expect(/<FilterBar\b/.test(SRC), 'DispatchBoard.tsx renders <FilterBar').toBe(true);
    expect(/import\s*\{[^}]*\bFilterBar\b[^}]*\}\s*from\s*'@lims\/ui\/components\/FilterBar'/.test(SRC), 'FilterBar value import').toBe(true);
    expect(/className=["'{`][^>]*lims-filter-?bar/.test(SRC), 'no hand built lims-filter-bar row').toBe(false);
  });
  it('exactly one search landmark holds Date, Centre, Status, Kind, Needs attention and the reset button, in that order', async () => {
    await view();
    const bars = screen.getAllByRole('search');
    expect(bars).toHaveLength(1);
    const bar = bars[0]!;
    expect(within(bar).getByRole('textbox', { name: /^date/i })).toBeTruthy();
    const order = [/centre/i, /status/i, /kind/i].map((n) => within(bar).getByRole('button', { name: n }));
    expect(within(bar).getByRole('switch', { name: /needs attention/i })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: /reset filters/i })).toBeTruthy();
    // document order: date field, then centre, status, kind
    const all = Array.from(bar.querySelectorAll('input[name="date"], button'));
    const at = (el: Element) => all.indexOf(el);
    expect(at(order[0]!)).toBeLessThan(at(order[1]!));
    expect(at(order[1]!)).toBeLessThan(at(order[2]!));
    // the row is above both tables
    for (const g of screen.getAllByRole('grid')) expect(bar.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('the Refresh button stays in the page header, not in the filter row', async () => {
    await view();
    expect(within(screen.getByRole('search')).queryByRole('button', { name: /^refresh$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^refresh$/i })).toBeTruthy();
  });
  it('Reset filters clears status, kind and needs-attention but keeps date and centre in the URL', async () => {
    await view();
    await userEvent.click(within(screen.getByRole('search')).getByRole('switch', { name: /needs attention/i }));
    replace.mockReset();
    await userEvent.click(within(screen.getByRole('search')).getByRole('button', { name: /reset filters/i }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const url = String(replace.mock.calls.at(-1)![0]);
    expect(url).toMatch(/^\/homecollection\/dispatch\?/);
    expect(url).toContain(`date=${DATE}`);
    expect(url).toContain(`centre_id=${CENTRE}`);
    expect(url).not.toMatch(/status=|kind=|has_open_flags/);
  });
  it('status choice writes ?status= (the filter still drives the URL after the move to FilterBar)', async () => {
    await view();
    await userEvent.click(within(screen.getByRole('search')).getByRole('button', { name: /status/i }));
    await userEvent.click(await screen.findByRole('option', { name: /^assigned$/i }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(String(replace.mock.calls.at(-1)![0])).toMatch(/status=assigned/);
  });
});

describe('rule 5: tables keep their header row when empty', () => {
  it('source has no "empty ? <EmptyState/> : <table>" swap for the routes', () => {
    expect(/visibleRoutes\.length\s*\?\s*\(?\s*[\s\S]{0,400}?<EmptyState\b[\s\S]{0,200}No routes for this date/.test(SRC), 'routes ternary swaps the table for an EmptyState').toBe(false);
  });
  it('no unassigned visits: the Unassigned grid keeps its column headers and the empty text', async () => {
    await view({ visits: [A1, A2, A3, B1] });
    const g = screen.getByRole('grid', { name: /unassigned/i });
    expect(headers(g)).toEqual(expect.arrayContaining(['Window', 'Patient', 'Area', 'Kind', 'Tubes', 'Flags']));
    expect(screen.getByText('No unassigned visits for this date.')).toBeTruthy();
  });
  it('no routes at all: a routes grid with column headers is still drawn, and "No routes for this date." is still said', async () => {
    await view({ visits: [], routes: [] });
    const grids = screen.getAllByRole('grid');
    expect(grids.length).toBeGreaterThanOrEqual(2);
    for (const g of grids) expect(within(g).getAllByRole('columnheader').length).toBeGreaterThan(0);
    expect(screen.getByText('No routes for this date.')).toBeTruthy();
    expect(screen.getByText('No unassigned visits for this date.')).toBeTruthy();
  });
  it('nothing to show and no write rights: still one filter row, both headers, no dialog', async () => {
    await view({ visits: [], routes: [] });
    expect(screen.getAllByRole('search')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: /^home visits$/i })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('regression (green now, must stay): routes with visits still render one card per phlebotomist', () => {
  it('Test Phlebo 01 and 02 cards each hold a grid with headers', async () => {
    await view();
    for (const n of [/test phlebo 01/i, /test phlebo 02/i]) {
      const card = screen.getByRole('heading', { name: n }).closest('.lims-card') as HTMLElement;
      expect(headers(within(card).getByRole('grid')).length).toBeGreaterThan(0);
    }
  });
});
