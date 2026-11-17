// @vitest-environment jsdom
// T0D-13 / 04-UI-UX §2.2 (Combobox), §2.5 (DataTable, FilterBar), §4 (table keyboard), §5 (a11y), REQ-SEC-081/088, AC-0D-8.6.
// ASSUMED (spec gives behaviour + props, not DOM): DataTable is a role=grid named by `caption` with columnheader/rowheader/row/gridcell; row selection uses one
//   role=checkbox per row; sort headers expose a button inside the columnheader and aria-sort; paging buttons are named /next/i and /previous/i; the loading text
//   "Loading results" sits in a role=status live region (§5.5); the error state reuses ErrorState ("Reference: <requestId>", button "Retry").
//   Keyboard tests focus a gridcell and send keys to document.activeElement. FilterBar select/coded use the same button+listbox pattern as <Select> (fields.test.tsx);
//   multi-select options are role=option|checkbox|menuitemcheckbox. Combobox = role=combobox + role=listbox/option (react-aria).
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DataTable } from '../DataTable/DataTable';
import { FilterBar } from '../FilterBar/FilterBar';
import { Combobox } from '../Combobox/Combobox';
import { DEVANAGARI, XSS, seriousViolations, user } from './helpers';

type Row = { id: string; name: string; qty: number; at: string };
const ROWS: Row[] = [
  { id: 'r1', name: 'Alpha', qty: 3, at: '2025-07-01' },
  { id: 'r2', name: 'Bravo', qty: 12, at: '2025-07-02' },
  { id: 'r3', name: 'Charlie', qty: 7, at: '2025-07-03' },
];
const COLUMNS = [
  { id: 'name', header: 'Name', cell: (r: Row) => r.name, sortKey: 'name', isRowHeader: true },
  { id: 'qty', header: 'Quantity', cell: (r: Row) => String(r.qty), align: 'end' as const },
  { id: 'at', header: 'Received', cell: (r: Row) => r.at, sortKey: 'received_at' },
];
const EMPTY = { title: 'No specimens yet', body: 'Receive a specimen to see it here', action: { label: 'Receive specimen', onPress: () => {} } };

type TableProps = Partial<React.ComponentProps<typeof DataTable<Row>>>;
function renderTable(props: TableProps = {}) {
  return render(<DataTable<Row> caption="Specimens" columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} emptyState={EMPTY} {...props} />);
}
const grid = () => screen.getByRole('grid', { name: 'Specimens' });
const dataRows = () => within(grid()).getAllByRole('row').slice(1);
const firstCell = (rowIdx: number, colIdx = 0) => Array.from(dataRows()[rowIdx]!.querySelectorAll('[role=gridcell],[role=rowheader]'))[colIdx]! as HTMLElement;
const rowOf = (el: Element | null) => el?.closest('[role=row]') ?? null;

describe('DataTable: structure and states (04-UI-UX §2.5)', () => {
  it('renders a grid named by caption with a column header per column and one row per row', () => {
    renderTable();
    expect(within(grid()).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Name'), expect.stringContaining('Quantity'), expect.stringContaining('Received')]));
    expect(dataRows()).toHaveLength(3);
    expect(within(grid()).getByText('Bravo')).toBeTruthy();
  });

  it('isRowHeader column is exposed as a rowheader', () => {
    renderTable();
    expect(within(grid()).getAllByRole('rowheader').map((c) => c.textContent)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('cell() output is rendered per row (React nodes allowed)', () => {
    renderTable({ columns: [{ id: 'n', header: 'Name', cell: (r) => <strong data-testid={`n-${r.id}`}>{r.name}</strong> }] });
    expect(screen.getByTestId('n-r2').textContent).toBe('Bravo');
  });

  it('isLoading: announces "Loading results" in a live region and marks the grid busy', () => {
    renderTable({ isLoading: true });
    expect(screen.getByText(/Loading results/)).toBeTruthy();
    expect(document.querySelector('[role=status],[aria-live]')?.textContent ?? '').toMatch(/Loading results/);
    expect(document.querySelector('[aria-busy=true]')).toBeTruthy();
  });

  it('error: title, "Reference: <requestId>" and a Retry button that calls onRetry', async () => {
    const onRetry = vi.fn();
    renderTable({ error: { title: 'Could not load specimens', requestId: 'req-7f3a9c21', onRetry } });
    expect(screen.getByText('Could not load specimens')).toBeTruthy();
    expect(screen.getByText(/Reference: req-7f3a9c21/)).toBeTruthy();
    await user().click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('empty rows -> the emptyState (title, body, action)', async () => {
    const onPress = vi.fn();
    renderTable({ rows: [], emptyState: { ...EMPTY, action: { label: 'Receive specimen', onPress } } });
    expect(screen.getByText('No specimens yet')).toBeTruthy();
    expect(screen.getByText('Receive a specimen to see it here')).toBeTruthy();
    await user().click(screen.getByRole('button', { name: 'Receive specimen' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('virtualize defaults on above 200 rows: not all 500 rows are in the DOM; the grid still reports its full size', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, name: `N${i}`, qty: i, at: '2025-07-01' }));
    renderTable({ rows: many });
    expect(within(grid()).queryAllByRole('row').length).toBeLessThan(500);
    expect(['500', '501']).toContain(grid().getAttribute('aria-rowcount'));
  });

  it('virtualize={false} renders every row', () => {
    const some = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, name: `N${i}`, qty: i, at: '2025-07-01' }));
    renderTable({ rows: some, virtualize: false });
    expect(dataRows()).toHaveLength(250);
  });
});

describe('DataTable: cursor pagination only (CV §4.3)', () => {
  it('Next / Previous call their handlers and are disabled when there is no page that way', async () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const { rerender } = renderTable({ page: { hasNext: true, hasPrevious: false, onNext, onPrevious, limit: 25 } });
    const next = screen.getByRole('button', { name: /next/i }) as HTMLButtonElement;
    const prev = screen.getByRole('button', { name: /previous/i }) as HTMLButtonElement;
    expect(prev.disabled || prev.getAttribute('aria-disabled') === 'true').toBe(true);
    await user().click(next);
    expect(onNext).toHaveBeenCalledTimes(1);
    await user().click(prev);
    expect(onPrevious).not.toHaveBeenCalled();
    rerender(<DataTable<Row> caption="Specimens" columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} emptyState={EMPTY} page={{ hasNext: false, hasPrevious: true, onNext, onPrevious, limit: 25 }} />);
    expect((screen.getByRole('button', { name: /next/i }) as HTMLButtonElement).disabled || screen.getByRole('button', { name: /next/i }).getAttribute('aria-disabled') === 'true').toBe(true);
    await user().click(screen.getByRole('button', { name: /previous/i }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('shows no page numbers or total counts (the API has no offset/total)', () => {
    renderTable({ page: { hasNext: true, hasPrevious: true, onNext: () => {}, onPrevious: () => {}, limit: 25 } });
    expect(screen.queryByText(/page \d+|of \d+ (pages|results|rows)/i)).toBeNull();
  });
});

describe('DataTable: sorting (sort.value "-field" = descending)', () => {
  const sortHeader = (name: RegExp) => {
    const h = within(grid()).getByRole('columnheader', { name });
    return { h, target: (within(h).queryByRole('button') ?? h) as HTMLElement };
  };

  it('aria-sort follows sort.value: "name" ascending, "-name" descending, other columns none', () => {
    const a = renderTable({ sort: { value: 'name', onChange: () => {} } });
    expect(sortHeader(/Name/).h.getAttribute('aria-sort')).toBe('ascending');
    expect(['none', null]).toContain(sortHeader(/Received/).h.getAttribute('aria-sort'));
    a.unmount();
    renderTable({ sort: { value: '-name', onChange: () => {} } });
    expect(sortHeader(/Name/).h.getAttribute('aria-sort')).toBe('descending');
  });

  it('click: other column -> ascending; same ascending -> descending; same descending -> ascending', async () => {
    const onChange = vi.fn();
    const a = renderTable({ sort: { value: 'name', onChange } });
    await user().click(sortHeader(/Received/).target);
    expect(onChange).toHaveBeenLastCalledWith('received_at');
    await user().click(sortHeader(/Name/).target);
    expect(onChange).toHaveBeenLastCalledWith('-name');
    a.unmount();
    renderTable({ sort: { value: '-name', onChange } });
    await user().click(sortHeader(/Name/).target);
    expect(onChange).toHaveBeenLastCalledWith('name');
  });

  it('a column without sortKey is not sortable', async () => {
    const onChange = vi.fn();
    renderTable({ sort: { value: 'name', onChange } });
    const { h, target } = sortHeader(/Quantity/);
    expect(h.getAttribute('aria-sort') === 'ascending' || h.getAttribute('aria-sort') === 'descending').toBe(false);
    await user().click(target);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DataTable: selection (multiple / single, max, Space, Shift+Space, Ctrl+A)', () => {
  function Sel(p: { mode: 'single' | 'multiple'; max?: number; spy: (ids: ReadonlySet<string>) => void; initial?: string[] }) {
    const [ids, setIds] = useState<ReadonlySet<string>>(new Set(p.initial ?? []));
    return (
      <DataTable<Row> caption="Specimens" columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} emptyState={EMPTY}
        selection={{ mode: p.mode, selectedIds: ids, max: p.max, onChange: (n) => { setIds(n); p.spy(n); } }} />
    );
  }
  const last = (spy: ReturnType<typeof vi.fn>) => [...(spy.mock.calls.at(-1)?.[0] as Set<string>)].sort();
  const boxes = () => within(grid()).getAllByRole('checkbox') as HTMLInputElement[];
  const rowBoxes = () => dataRows().map((r) => within(r).getByRole('checkbox') as HTMLInputElement);

  it('multiple: one checkbox per row; clicking toggles ids in a new Set', async () => {
    const spy = vi.fn();
    render(<Sel mode="multiple" spy={spy} />);
    const u = user();
    await u.click(rowBoxes()[0]!);
    await u.click(rowBoxes()[2]!);
    expect(last(spy)).toEqual(['r1', 'r3']);
    await u.click(rowBoxes()[0]!);
    expect(last(spy)).toEqual(['r3']);
    expect(rowBoxes()[2]!.checked).toBe(true);
  });

  it('single: choosing another row replaces the selection', async () => {
    const spy = vi.fn();
    render(<Sel mode="single" spy={spy} />);
    const u = user();
    const pick = async (i: number) => u.click((within(dataRows()[i]!).queryByRole('checkbox') ?? within(dataRows()[i]!).getByRole('radio')) as HTMLElement);
    await pick(0);
    expect(last(spy)).toEqual(['r1']);
    await pick(1);
    expect(last(spy)).toEqual(['r2']);
  });

  it('max: the selection never grows past max', async () => {
    const spy = vi.fn();
    render(<Sel mode="multiple" max={2} spy={spy} />);
    const u = user();
    await u.click(rowBoxes()[0]!);
    await u.click(rowBoxes()[1]!);
    await u.click(rowBoxes()[2]!);
    for (const c of spy.mock.calls) expect((c[0] as Set<string>).size).toBeLessThanOrEqual(2);
  });

  it('Space toggles the focused row', async () => {
    const spy = vi.fn();
    render(<Sel mode="multiple" spy={spy} />);
    firstCell(1).focus();
    await user().keyboard(' ');
    expect(last(spy)).toEqual(['r2']);
    await user().keyboard(' ');
    expect(last(spy)).toEqual([]);
  });

  it('Shift+Space extends the selection from the anchor to the focused row (anchor and target both selected)', async () => {
    const spy = vi.fn();
    render(<Sel mode="multiple" spy={spy} />);
    const u = user();
    firstCell(0).focus();
    await u.keyboard(' ');
    await u.keyboard('{ArrowDown}{ArrowDown}');
    await u.keyboard('{Shift>} {/Shift}');
    const ids = last(spy);
    expect(ids).toContain('r1');
    expect(ids).toContain('r3');
  });

  it('Ctrl+A selects the visible page in multiple mode', async () => {
    const spy = vi.fn();
    render(<Sel mode="multiple" spy={spy} />);
    firstCell(0).focus();
    await user().keyboard('{Control>}a{/Control}');
    expect(last(spy)).toEqual(['r1', 'r2', 'r3']);
  });

  it('Ctrl+A does nothing in single mode', async () => {
    const spy = vi.fn();
    render(<Sel mode="single" spy={spy} />);
    firstCell(0).focus();
    await user().keyboard('{Control>}a{/Control}');
    for (const c of spy.mock.calls) expect((c[0] as Set<string>).size).toBeLessThanOrEqual(1);
  });

  it('selection comes from selectedIds (controlled)', () => {
    render(<Sel mode="multiple" spy={() => {}} initial={['r2']} />);
    expect(rowBoxes().map((b) => b.checked)).toEqual([false, true, false]);
    expect(boxes().length).toBeGreaterThanOrEqual(3);
  });
});

describe('DataTable: keyboard (04-UI-UX §2.5 "Table keyboard")', () => {
  it('Tab enters the grid (focus lands inside it)', async () => {
    renderTable();
    await user().tab();
    expect(grid().contains(document.activeElement)).toBe(true);
  });

  it('ArrowDown moves to the next row, ArrowRight to the next cell, ArrowUp/Left back', async () => {
    renderTable();
    const u = user();
    firstCell(0).focus();
    await u.keyboard('{ArrowDown}');
    expect(rowOf(document.activeElement)).toBe(dataRows()[1]);
    await u.keyboard('{ArrowRight}');
    expect(rowOf(document.activeElement)).toBe(dataRows()[1]);
    expect(document.activeElement).not.toBe(firstCell(1, 0));
    await u.keyboard('{ArrowLeft}{ArrowUp}');
    expect(rowOf(document.activeElement)).toBe(dataRows()[0]);
  });

  it('Enter on a row calls onRowAction(row); a plain click does not; double-click does', async () => {
    const onRowAction = vi.fn();
    renderTable({ onRowAction });
    const u = user();
    await u.click(firstCell(0));
    expect(onRowAction).not.toHaveBeenCalled();
    firstCell(1).focus();
    await u.keyboard('{Enter}');
    expect(onRowAction).toHaveBeenCalledTimes(1);
    expect(onRowAction).toHaveBeenLastCalledWith(ROWS[1]);
    await u.dblClick(firstCell(2));
    expect(onRowAction).toHaveBeenLastCalledWith(ROWS[2]);
  });

  const actions = (r: Row) => [{ id: 'view', label: `View ${r.name}` }, { id: 'cancel', label: 'Cancel specimen', isDanger: true }];

  it('Shift+F10 opens the row actions menu; choosing an item calls onRowActionMenu(row, id)', async () => {
    const onRowActionMenu = vi.fn();
    renderTable({ rowActions: actions, onRowActionMenu });
    firstCell(1).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'F10', code: 'F10', shiftKey: true });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['View Bravo', 'Cancel specimen']);
    await user().click(within(menu).getByRole('menuitem', { name: 'Cancel specimen' }));
    expect(onRowActionMenu).toHaveBeenCalledWith(ROWS[1], 'cancel');
  });

  it('the context-menu key opens the same menu', async () => {
    renderTable({ rowActions: actions, onRowActionMenu: () => {} });
    firstCell(0).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ContextMenu', code: 'ContextMenu' });
    expect(await screen.findByRole('menu')).toBeTruthy();
  });

  it('Esc closes the menu without calling onRowActionMenu', async () => {
    const onRowActionMenu = vi.fn();
    renderTable({ rowActions: actions, onRowActionMenu });
    firstCell(0).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'F10', code: 'F10', shiftKey: true });
    await screen.findByRole('menu');
    await user().keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onRowActionMenu).not.toHaveBeenCalled();
  });
});

describe('DataTable: text only, no row serialisation (REQ-SEC-088, REQ-SEC-081)', () => {
  it.each(XSS)('cell, caption, error and empty-state text are text nodes: %s', (payload) => {
    const a = renderTable({ rows: [{ id: 'x', name: payload, qty: 1, at: payload }] });
    expect(within(grid()).getAllByText(payload).length).toBeGreaterThan(0);
    expect(document.querySelector('img[src=x],script,svg[onload]')).toBeNull();
    a.unmount();
    renderTable({ caption: payload, error: { title: payload } });
    expect(document.querySelector('img[src=x],script,svg[onload]')).toBeNull();
    expect((window as any).__xss).toBeUndefined();
  });

  it('Devanagari cell content is kept verbatim', () => {
    renderTable({ rows: [{ id: 'd', name: DEVANAGARI, qty: 1, at: '2025-07-01' }] });
    expect(within(grid()).getByText(DEVANAGARI)).toBeTruthy();
  });
});

describe('DataTable: axe (AC-0D-8.6)', () => {
  it('data + sort + multi-select + paging; loading; error; empty', async () => {
    const a = renderTable({
      sort: { value: '-name', onChange: () => {} },
      selection: { mode: 'multiple', selectedIds: new Set(['r1']), onChange: () => {} },
      page: { hasNext: true, hasPrevious: false, onNext: () => {}, onPrevious: () => {}, limit: 25 },
      rowActions: () => [{ id: 'a', label: 'Open' }], onRowActionMenu: () => {},
    });
    expect(await seriousViolations()).toEqual([]);
    a.unmount();
    const b = renderTable({ isLoading: true });
    expect(await seriousViolations()).toEqual([]);
    b.unmount();
    const c = renderTable({ error: { title: 'Could not load', requestId: 'abc12345', onRetry: () => {} } });
    expect(await seriousViolations()).toEqual([]);
    c.unmount();
    renderTable({ rows: [] });
    expect(await seriousViolations()).toEqual([]);
  });
});

// ───────────────────────────────────────── FilterBar ─────────────────────────────────────────

const FILTERS = [
  { id: 'status', label: 'Status', kind: 'select', options: [{ value: 'received', label: 'Received' }, { value: 'rejected', label: 'Rejected' }] },
  { id: 'tags', label: 'Tags', kind: 'select', multiple: true, options: [{ value: 'urgent', label: 'Urgent' }, { value: 'stat', label: 'STAT' }, { value: 'fasting', label: 'Fasting' }] },
  { id: 'q', label: 'Search', kind: 'text', maxLength: 40 },
  { id: 'period', label: 'Period', kind: 'date_range' },
  { id: 'dept', label: 'Department', kind: 'coded', codedSet: 'department', options: [{ code: 'HAEM', display: 'Haematology' }, { code: 'BIOC', display: 'Biochemistry' }] },
] as const;

function Bar(p: { initial?: Record<string, any>; spy?: (v: any) => void; onReset?: () => void; filters?: any }) {
  const [v, setV] = useState<Record<string, any>>(p.initial ?? {});
  return <FilterBar filters={p.filters ?? FILTERS} value={v} onChange={(n) => { setV(n); p.spy?.(n); }} onReset={() => { setV({}); p.onReset?.(); }} />;
}
const lastVal = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0];

describe('FilterBar (04-UI-UX §2.5)', () => {
  it('select: pick an option -> onChange({...value, status:"rejected"}) keeping other keys', async () => {
    const spy = vi.fn();
    render(<Bar spy={spy} initial={{ q: 'abc' }} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: /Status/ }));
    await u.click(screen.getByRole('option', { name: 'Rejected' }));
    expect(lastVal(spy)).toMatchObject({ q: 'abc', status: 'rejected' });
  });

  it('coded: shows the display text, emits the code', async () => {
    const spy = vi.fn();
    render(<Bar spy={spy} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: /Department/ }));
    await u.click(screen.getByRole('option', { name: 'Haematology' }));
    expect(lastVal(spy).dept).toBe('HAEM');
  });

  it('text: typing reports the string; maxLength is mirrored on the input', async () => {
    const spy = vi.fn();
    render(<Bar spy={spy} />);
    const box = screen.getByRole('textbox', { name: /Search/ }) as HTMLInputElement;
    expect(box.maxLength).toBe(40);
    await user().type(box, 'hb a1c');
    await waitFor(() => expect(lastVal(spy)?.q).toBe('hb a1c'));
  });

  it('multiple select: two picks give both values as an array', async () => {
    const spy = vi.fn();
    render(<Bar spy={spy} />);
    const u = user();
    const trigger = screen.queryByRole('button', { name: /Tags/ });
    if (trigger) await u.click(trigger);
    const pick = async (n: string) => u.click(Array.from(document.querySelectorAll('[role=option],[role=checkbox],[role=menuitemcheckbox]')).find((e) => e.textContent?.includes(n) || e.getAttribute('aria-label') === n)!);
    await pick('Urgent');
    await pick('STAT');
    expect([...lastVal(spy).tags].sort()).toEqual(['stat', 'urgent']);
  });

  it('date_range renders two date inputs inside a group named by its label', () => {
    render(<Bar />);
    expect(within(screen.getByRole('group', { name: /Period/ })).getAllByRole('textbox')).toHaveLength(2);
  });

  it('current value is shown (select label and text)', () => {
    render(<Bar initial={{ status: 'received', q: 'xyz' }} />);
    expect(screen.getByRole('button', { name: /Status/ }).textContent).toContain('Received');
    expect((screen.getByRole('textbox', { name: /Search/ }) as HTMLInputElement).value).toBe('xyz');
  });

  it('Reset button calls onReset', async () => {
    const onReset = vi.fn();
    render(<Bar initial={{ status: 'received' }} onReset={onReset} />);
    await user().click(screen.getByRole('button', { name: /reset|clear/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it.each(XSS)('labels and options are text: %s', (payload) => {
    render(<Bar filters={[{ id: 's', label: payload, kind: 'select', options: [{ value: 'a', label: payload }] }]} />);
    expect(document.querySelector('img[src=x],script,svg[onload]')).toBeNull();
    expect((window as any).__xss).toBeUndefined();
  });

  it('axe', async () => {
    render(<Bar initial={{ status: 'received', q: 'abc' }} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

// ───────────────────────────────────────── Combobox ─────────────────────────────────────────

type Doc = { id: string; name: string };
const DOCS: Doc[] = [{ id: 'd1', name: 'Dr Sharma' }, { id: 'd2', name: 'Dr Shrestha' }];
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
function Combo(p: Partial<React.ComponentProps<typeof Combobox<Doc>>> & { initial?: Doc; spy?: (v: Doc | undefined) => void }) {
  const { initial, spy, ...rest } = p;
  const [v, setV] = useState<Doc | undefined>(initial);
  return (
    <Combobox<Doc> label="Referring doctor" name="doctor" value={v} onChange={(x) => { setV(x); spy?.(x); }}
      loadOptions={async () => DOCS} getKey={(d) => d.id} renderOption={(d) => <span>{d.name}</span>} renderValue={(d) => d.name} {...rest} />
  );
}
const combo = () => screen.getByRole('combobox', { name: /referring doctor/i }) as HTMLInputElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Combobox (04-UI-UX §2.2)', () => {
  it('debounces (default 150 ms): typing "sha" quickly makes ONE loadOptions(query, signal) call', async () => {
    const loadOptions = vi.fn(async () => DOCS);
    render(<Combo loadOptions={loadOptions} />);
    await user().type(combo(), 'sha');
    await waitFor(() => expect(loadOptions).toHaveBeenCalled());
    await sleep(300);
    expect(loadOptions).toHaveBeenCalledTimes(1);
    expect(loadOptions.mock.calls[0]![0]).toBe('sha');
    expect(loadOptions.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  });

  it('debounceMs is configurable (0 = per keystroke is allowed, never more calls than keystrokes)', async () => {
    const loadOptions = vi.fn(async () => DOCS);
    render(<Combo loadOptions={loadOptions} debounceMs={0} />);
    await user().type(combo(), 'sha');
    await waitFor(() => expect(loadOptions.mock.calls.at(-1)?.[0]).toBe('sha'));
    expect(loadOptions.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('minChars (default 1): nothing is loaded for an empty query; minChars=3 waits for 3 characters', async () => {
    const loadOptions = vi.fn(async () => DOCS);
    render(<Combo loadOptions={loadOptions} minChars={3} />);
    const u = user();
    await u.type(combo(), 'sh');
    await sleep(350);
    expect(loadOptions).not.toHaveBeenCalled();
    await u.type(combo(), 'a');
    await waitFor(() => expect(loadOptions).toHaveBeenCalledTimes(1));
    expect(loadOptions.mock.calls[0]![0]).toBe('sha');
  });

  it('options render through renderOption; click selects: onChange(item) and the input shows renderValue(item)', async () => {
    const spy = vi.fn();
    render(<Combo spy={spy} />);
    const u = user();
    await u.type(combo(), 'sh');
    const opt = await screen.findByRole('option', { name: 'Dr Shrestha' });
    await u.click(opt);
    expect(spy).toHaveBeenLastCalledWith(DOCS[1]);
    expect(combo().value).toBe('Dr Shrestha');
  });

  it('keyboard: ArrowDown moves through options, Enter selects, Esc closes the list', async () => {
    const spy = vi.fn();
    render(<Combo spy={spy} />);
    const u = user();
    await u.type(combo(), 'sh');
    await screen.findByRole('option', { name: 'Dr Sharma' });
    await u.keyboard('{ArrowDown}{Enter}');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(['d1', 'd2']).toContain(spy.mock.calls[0]![0].id);
    await u.clear(combo());
    await u.type(combo(), 'sh');
    await screen.findByRole('option', { name: 'Dr Sharma' });
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a newer query aborts the older request and its late result is never shown', async () => {
    const d1 = deferred<Doc[]>();
    const d2 = deferred<Doc[]>();
    const signals: AbortSignal[] = [];
    const loadOptions = vi.fn((q: string, s: AbortSignal) => { signals.push(s); return q === 'a' ? d1.promise : d2.promise; });
    render(<Combo loadOptions={loadOptions} debounceMs={0} />);
    const u = user();
    await u.type(combo(), 'a');
    await waitFor(() => expect(loadOptions).toHaveBeenCalledTimes(1));
    await u.type(combo(), 'b');
    await waitFor(() => expect(loadOptions.mock.calls.some((c) => c[0] === 'ab')).toBe(true));
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => { d2.resolve([{ id: 'f', name: 'Fresh Result' }]); });
    await act(async () => { d1.resolve([{ id: 's', name: 'Stale Result' }]); });
    expect(await screen.findByRole('option', { name: 'Fresh Result' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Stale Result' })).toBeNull();
  });

  it('loadOptions failure: no crash, no unhandled rejection, the field stays usable', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const loadOptions = vi.fn(async () => { throw new Error('network down'); });
      render(<Combo loadOptions={loadOptions} debounceMs={0} />);
      await user().type(combo(), 'sh');
      await waitFor(() => expect(loadOptions).toHaveBeenCalled());
      await sleep(50);
      expect(combo().isConnected).toBe(true);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('allowCreate: shows the create entry (even with no matches); choosing it calls onCreate(query), not onChange', async () => {
    const onCreate = vi.fn();
    const spy = vi.fn();
    render(<Combo spy={spy} loadOptions={async () => []} allowCreate={{ label: 'Add new doctor', onCreate }} />);
    const u = user();
    await u.type(combo(), 'dr new');
    await u.click(await screen.findByRole('option', { name: /Add new doctor/ }));
    expect(onCreate).toHaveBeenCalledWith('dr new');
    expect(spy).not.toHaveBeenCalled();
  });

  it('without allowCreate there is no create entry', async () => {
    render(<Combo loadOptions={async () => []} />);
    await user().type(combo(), 'dr new');
    await sleep(350);
    expect(screen.queryByRole('option', { name: /add new/i })).toBeNull();
  });

  it('clearing the text of a selected value reports undefined', async () => {
    const spy = vi.fn();
    render(<Combo initial={DOCS[0]} spy={spy} />);
    expect(combo().value).toBe('Dr Sharma');
    await user().clear(combo());
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(undefined));
  });

  it('Devanagari (IME) query reaches loadOptions unchanged', async () => {
    const loadOptions = vi.fn(async () => DOCS);
    render(<Combo loadOptions={loadOptions} debounceMs={0} />);
    await user().type(combo(), 'सुनिता');
    await waitFor(() => expect(loadOptions.mock.calls.at(-1)?.[0]).toBe('सुनिता'));
  });

  it.each(XSS)('option content is text, not markup: %s', async (payload) => {
    render(<Combo loadOptions={async () => [{ id: 'x', name: payload }]} />);
    await user().type(combo(), 'x');
    await screen.findByRole('option');
    expect(document.querySelector('img[src=x],script,svg[onload]')).toBeNull();
    expect((window as any).__xss).toBeUndefined();
  });

  it('FieldBase: name on the input, error linked by aria-describedby, disabled honoured', () => {
    const { rerender } = render(<Combo error="Choose a doctor" />);
    expect(combo().getAttribute('aria-invalid')).toBe('true');
    const d = (combo().getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(d).toContain('Choose a doctor');
    rerender(<Combo isDisabled />);
    expect(combo().disabled).toBe(true);
  });

  it('axe: closed and open', async () => {
    render(<Combo />);
    expect(await seriousViolations()).toEqual([]);
    await user().type(combo(), 'sh');
    await screen.findByRole('option', { name: 'Dr Sharma' });
    expect(await seriousViolations()).toEqual([]);
  });
});
