// @vitest-environment jsdom
// T0D-UIKIT-1 done_when (2) FilterBar and (3) DataTable (LD-353 rules 2 and 5). All new props are additive and optional.
// CONTRACT chosen here (writer: follow it, or file a dispute):
//   FilterBar:  `onSearch?: () => void`. When given, a `button` named "Search" is rendered INSIDE `div.lims-filter-search` right after the text field,
//               and that wrapper (the text filter + its button) is capped at max-width <= 24rem in kit.css. Reset ("Reset filters") is the LAST child of `.lims-filter-bar`.
//               One row: `.lims-filter-bar` is flex-wrap: nowrap, and wraps (flex-wrap: wrap) only inside `@media (max-width: 64rem)` (rem, never px).
//               Label above the control at 12px: `.lims-filter-bar .lims-field` is a column and `.lims-filter-bar .lims-label` uses var(--lims-font-size-xs-size).
//               Every control in the bar is a plain `.lims-input` or `.lims-btn` (never `.lims-btn-sm`), so the density rule gives all of them one height.
//   DataTable:  the table always sits in `div.lims-table-scroll` (inside `.lims-data-table`) that scrolls on its own (overflow auto, min-width 0).
//               `error` keeps the header row: the grid renders its columnheaders, the ErrorState (title, Reference, Retry) sits in the body.
//               `stickyFirstColumn?: boolean`  -> `lims-sticky-first` on the header cell and every body cell of the first DATA column; css: position sticky, inset-inline-start 0 (or left 0).
//               `columnChooser?: boolean`      -> a button named "Columns" above the grid; it opens a popover with one checkbox per column (label = header, all checked);
//                                                 unchecking one removes that column's header and cells. Off unless true.
//               `cellTitle?: boolean`          -> every body cell whose content is text gets title=<that text>; css: `.lims-cell` clips with text-overflow: ellipsis.
//               ColumnDef `numeric?: boolean`  -> header and cells get `lims-align-end` (right aligned in LTR) and `lims-num`; css tabular-nums on `.lims-num`.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type ColumnDef } from '../DataTable/DataTable';
import { FilterBar, type FilterDef } from '../FilterBar/FilterBar';
import { declared, rem, rulesMatching } from './uikit1-css';
import { user } from './helpers';

// ───────────────────────────── FilterBar ─────────────────────────────
const FILTERS: FilterDef[] = [
  { id: 'q', label: 'Search', kind: 'text', maxLength: 40 },
  { id: 'status', label: 'Status', kind: 'select', options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] },
  { id: 'range', label: 'Period', kind: 'date_range' },
];
function bar(extra: Partial<React.ComponentProps<typeof FilterBar>> = {}) {
  return render(
    <div data-density="compact">
      <FilterBar filters={FILTERS} value={{}} onChange={() => {}} onReset={() => {}} {...extra} />
    </div>,
  );
}

describe('FilterBar: one row, equal controls, label above, Reset last', () => {
  it('exactly one .lims-filter-bar, and Reset filters is its last child', () => {
    const { container } = bar();
    expect(container.querySelectorAll('.lims-filter-bar')).toHaveLength(1);
    const last = container.querySelector('.lims-filter-bar')!.lastElementChild as HTMLElement;
    expect(last.textContent).toBe('Reset filters');
    expect(last.tagName).toBe('BUTTON');
  });

  it('every filter keeps its label text above (before, in the DOM) its control', () => {
    const { container } = bar();
    for (const f of FILTERS) {
      const label = within(container).getAllByText(f.label, { selector: '.lims-label, label, span' })[0]!;
      expect(label, f.label).toBeTruthy();
    }
    for (const field of container.querySelectorAll('.lims-filter-bar .lims-field')) {
      const label = field.querySelector('.lims-label');
      const control = field.querySelector('input, button');
      if (label && control) expect(label.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING, 'label must come first').toBeTruthy();
    }
  });

  it('every control in the bar is a plain .lims-input or .lims-btn (never .lims-btn-sm), so one density rule sets one height', () => {
    const { container } = bar();
    const controls = [...container.querySelectorAll<HTMLElement>('.lims-filter-bar input:not([type=hidden]), .lims-filter-bar button')].filter((e) => !e.closest('[aria-hidden=true]'));
    expect(controls.length).toBeGreaterThanOrEqual(3);
    for (const c of controls) {
      expect(c.classList.contains('lims-input') || c.classList.contains('lims-btn') || c.closest('.lims-input') !== null, c.outerHTML.slice(0, 120)).toBe(true);
      expect(c.classList.contains('lims-btn-sm'), 'small button in a filter bar').toBe(false);
      expect(c.getAttribute('style') ?? '', 'inline size').not.toMatch(/height/);
    }
  });

  it('css: nowrap on one row; wraps only under 64rem (media in rem); label above at 12px', () => {
    expect(declared(/^\.lims-filter-bar$/, 'flex-wrap')).toBe('nowrap');
    expect(declared(/^\.lims-filter-bar$/, 'flex-wrap', '(max-width: 64rem)')).toBe('wrap');
    expect(declared(/^\.lims-filter-bar \.lims-field$/, 'flex-direction') ?? declared(/^\.lims-field$/, 'flex-direction')).toBe('column');
    expect(declared(/^\.lims-filter-bar \.lims-label$/, 'font-size')).toBe('var(--lims-font-size-xs-size)');
    expect(declared(/^\.lims-filter-bar$/, 'align-items')).toMatch(/^(flex-end|end|stretch)$/);
  });

  it('min-width 0 so the bar never pushes the page sideways', () => {
    expect(declared(/^\.lims-filter-bar$/, 'min-width')).toMatch(/^0(rem)?$/);
  });
});

describe('FilterBar: search = short label + control (<= 24rem) with the button next to it', () => {
  it('without onSearch there is no Search button (additive prop)', () => {
    const { container } = bar();
    expect(container.querySelector('.lims-filter-search')).toBeTruthy(); // the wrapper always marks the text filter
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
  });

  it('with onSearch the Search button follows the input inside .lims-filter-search, and pressing it calls onSearch', async () => {
    const onSearch = vi.fn();
    const { container } = bar({ onSearch });
    const wrap = container.querySelector('.lims-filter-search') as HTMLElement;
    const input = wrap.querySelector('input')!;
    const btn = within(wrap).getByRole('button', { name: 'Search' });
    expect(input.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user().click(btn);
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('css: .lims-filter-search is capped at <= 24rem (and keeps min-width 0)', () => {
    const w = declared(/^\.lims-filter-search$/, 'max-width');
    expect(rem(w), `max-width was ${w}`).toBeLessThanOrEqual(24);
    expect(rem(w)).toBeGreaterThan(0);
  });

  it('a hostile typed value stays in the input as text', async () => {
    const onChange = vi.fn();
    render(<FilterBar filters={[FILTERS[0]!]} value={{}} onChange={onChange} onReset={() => {}} />);
    await user().type(screen.getByRole('textbox'), '<b>');
    expect(onChange).toHaveBeenCalled();
    expect(document.querySelector('b')).toBeNull();
  });
});

// ───────────────────────────── DataTable ─────────────────────────────
type Row = { id: string; name: string; qty: number; note: string };
const ROWS: Row[] = [
  { id: 'r1', name: 'Alpha', qty: 3, note: 'A long note that will be cut off in a narrow column' },
  { id: 'r2', name: 'Bravo', qty: 12, note: 'Short' },
];
const COLS: ColumnDef<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, isRowHeader: true },
  { id: 'qty', header: 'Quantity', cell: (r) => String(r.qty), numeric: true },
  { id: 'note', header: 'Note', cell: (r) => r.note },
];
const EMPTY = { title: 'No rows yet', body: 'Rows appear here.' };
function table(props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  return render(<DataTable<Row> caption="Things" columns={COLS} rows={ROWS} getRowId={(r) => r.id} emptyState={EMPTY} {...props} />);
}
const headers = () => within(screen.getByRole('grid', { name: 'Things' })).getAllByRole('columnheader').map((h) => h.textContent?.trim());

describe('DataTable: the header row is always rendered', () => {
  it('with rows', () => {
    table();
    expect(headers()).toEqual(['Name', 'Quantity', 'Note']);
  });
  it('when empty (and the EmptyState is in the body)', () => {
    table({ rows: [] });
    expect(headers()).toEqual(['Name', 'Quantity', 'Note']);
    expect(screen.getByText('No rows yet')).toBeTruthy();
  });
  it('while loading, with no rows', () => {
    table({ rows: [], isLoading: true });
    expect(headers()).toEqual(['Name', 'Quantity', 'Note']);
    expect(document.querySelector('[aria-busy=true]')).toBeTruthy();
  });
  it('on error: header row stays, ErrorState shows title, Reference and Retry in the body', async () => {
    const onRetry = vi.fn();
    table({ rows: [], error: { title: 'Could not load things', requestId: 'req-99', onRetry } });
    expect(headers()).toEqual(['Name', 'Quantity', 'Note']);
    expect(screen.getByText('Could not load things')).toBeTruthy();
    expect(screen.getByText(/Reference: req-99/)).toBeTruthy();
    await user().click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it('the header row is the same markup in every state (same cells, same classes)', () => {
    const sig = () => [...screen.getAllByRole('columnheader')].map((h) => h.className).join('|');
    const a = table();
    const full = sig();
    a.unmount();
    const b = table({ rows: [] });
    expect(sig()).toBe(full);
    b.unmount();
    const c = table({ error: { title: 'x' } });
    expect(sig()).toBe(full);
    c.unmount();
  });
});

describe('DataTable: scrolls inside its own box, never the page', () => {
  it('the grid sits in div.lims-table-scroll inside .lims-data-table (also with few rows, not only when virtual)', () => {
    const { container } = table();
    const scroll = container.querySelector('.lims-data-table .lims-table-scroll');
    expect(scroll).toBeTruthy();
    expect(scroll!.contains(screen.getByRole('grid'))).toBe(true);
  });
  it('css: the scroll box scrolls sideways itself; both containers have min-width 0', () => {
    expect(declared(/^\.lims-table-scroll$/, 'overflow-x') ?? declared(/^\.lims-table-scroll$/, 'overflow')).toMatch(/auto|scroll/);
    expect(declared(/^\.lims-table-scroll$/, 'min-width')).toMatch(/^0(rem)?$/);
    expect(declared(/^\.lims-data-table$/, 'min-width')).toMatch(/^0(rem)?$/);
  });
  it('css: the table is full width (width 100%) so the header row fills the box', () => {
    expect(declared(/^\.lims-data-table \.lims-table$/, 'width')).toBe('100%');
  });
});

describe('DataTable: sticky first column option', () => {
  it('off by default: no lims-sticky-first anywhere', () => {
    const { container } = table();
    expect(container.querySelector('.lims-sticky-first')).toBeNull();
  });
  it('on: header cell and every body cell of the FIRST data column, and no other column', () => {
    const { container } = table({ stickyFirstColumn: true });
    const sticky = [...container.querySelectorAll('.lims-sticky-first')];
    expect(sticky).toHaveLength(1 + ROWS.length);
    expect(sticky.map((e) => e.textContent?.trim())).toEqual(['Name', 'Alpha', 'Bravo']);
  });
  it('css: position sticky at the start edge, with a background so scrolled cells do not show through', () => {
    expect(declared(/\.lims-sticky-first$/, 'position')).toBe('sticky');
    expect(declared(/\.lims-sticky-first$/, 'inset-inline-start') ?? declared(/\.lims-sticky-first$/, 'left')).toMatch(/^0(rem)?$/);
    expect(declared(/\.lims-sticky-first$/, 'background')).toBeTruthy();
  });
});

describe('DataTable: columnChooser option (tables over 8 columns)', () => {
  const WIDE: ColumnDef<Row>[] = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, header: `Col ${i}`, cell: (r: Row) => `${r.name}-${i}`, ...(i === 0 ? { isRowHeader: true } : {}) }));
  it('off unless asked: no Columns button even with 9 columns', () => {
    table({ columns: WIDE });
    expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull();
  });
  it('on: a Columns button opens a checkbox per column, all checked; unchecking hides that column header and cells', async () => {
    table({ columns: WIDE, columnChooser: true });
    expect(headers()).toHaveLength(9);
    await user().click(screen.getByRole('button', { name: 'Columns' }));
    const boxes = await screen.findAllByRole('checkbox', { name: /^Col \d$/ });
    expect(boxes).toHaveLength(9);
    for (const b of boxes) expect((b as HTMLInputElement).checked).toBe(true);
    await user().click(screen.getByRole('checkbox', { name: 'Col 4' }));
    expect(headers()).not.toContain('Col 4');
    expect(headers()).toHaveLength(8);
    expect(screen.queryByText('Alpha-4')).toBeNull();
    expect(screen.getByText('Alpha-5')).toBeTruthy();
  });
});

describe('DataTable: numeric columns and cellTitle', () => {
  it('numeric: header and every cell right aligned (lims-align-end) and tabular (lims-num)', () => {
    const { container } = table();
    const hdr = screen.getByRole('columnheader', { name: /Quantity/ });
    expect(hdr.classList.contains('lims-align-end')).toBe(true);
    expect(hdr.classList.contains('lims-num')).toBe(true);
    const cells = [...container.querySelectorAll('td, [role=gridcell]')].filter((c) => /^\d+$/.test(c.textContent?.trim() ?? ''));
    expect(cells).toHaveLength(2);
    for (const c of cells) {
      expect(c.classList.contains('lims-align-end')).toBe(true);
      expect(c.classList.contains('lims-num')).toBe(true);
    }
    expect(declared(/^\.lims-align-end$/, 'text-align')).toMatch(/^(end|right)$/);
    expect(declared(/\.lims-num$/, 'font-variant-numeric')).toBe('tabular-nums');
  });
  it('a text column stays start aligned', () => {
    table();
    expect(screen.getByRole('columnheader', { name: /Note/ }).classList.contains('lims-align-end')).toBe(false);
  });
  it('cellTitle: text cells carry title = the full text; off by default', () => {
    const { container, unmount } = table();
    expect(container.querySelector('[title]')).toBeNull();
    unmount();
    const t = table({ cellTitle: true });
    const cell = [...t.container.querySelectorAll('[role=gridcell], td')].find((c) => c.textContent === ROWS[0]!.note)!;
    expect(cell.getAttribute('title')).toBe(ROWS[0]!.note);
    const alpha = [...t.container.querySelectorAll('[role=rowheader], [role=gridcell], td, th')].find((c) => c.textContent === 'Alpha')!;
    expect(alpha.getAttribute('title')).toBe('Alpha');
  });
  it('cellTitle: a hostile cell text is only an attribute value, never markup', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const { container } = table({ cellTitle: true, rows: [{ id: 'x', name: 'N', qty: 1, note: evil }] });
    expect(container.querySelector('img')).toBeNull();
    expect([...container.querySelectorAll('[title]')].some((e) => e.getAttribute('title') === evil)).toBe(true);
  });
  it('css: cells clip with an ellipsis so the title is useful', () => {
    expect(declared(/^\.lims-cell$/, 'text-overflow') ?? declared(/\.lims-table td$/, 'text-overflow')).toBe('ellipsis');
    expect(rulesMatching(/\.lims-cell$/).some((r) => r.decls.get('overflow') === 'hidden' || r.decls.get('overflow-x') === 'hidden')).toBe(true);
  });
});

describe('DataTable: existing props are unchanged', () => {
  it('a plain call still renders the grid with rows, row headers and sort/selection disabled', () => {
    table();
    expect(within(screen.getByRole('grid', { name: 'Things' })).getAllByRole('row')).toHaveLength(1 + ROWS.length);
    expect(within(screen.getByRole('grid')).getAllByRole('rowheader').map((c) => c.textContent)).toEqual(['Alpha', 'Bravo']);
  });
});
