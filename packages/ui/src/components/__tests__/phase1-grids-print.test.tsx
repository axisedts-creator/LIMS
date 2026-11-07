// @vitest-environment jsdom
// T0D-12b (04-UI-UX §2.8, Phase-1 set): EditableGrid (C3), PermissionMatrix (C2), PrintFrame (C4).
// ASSUMED API (writer must match or raise CR):
//   EditableGrid     { label; columns: {id, header, maxLength?, isReadOnly?}[]; rows: {id, values: Record<colId,string>, status?: 'saved'|'unsaved'|'error', statusText?, errors?: Record<colId,string>}[];
//                      onCellChange(rowId, colId, value); isReadOnly? }   ARIA grid, roving tabindex, aria-rowindex/colindex, aria-invalid on error cells,
//                      row status as text announced via aria-live=polite (C3 04-UI-UX:217). Enter/F2 edits, Esc cancels, arrows move.
//   PermissionMatrix { label; modules: {id,label}[]; permissions: {code, moduleId, resource, isPrivileged?, isAssignable?, unassignableReason?}[];
//                      value: string[]; onChange(codes: string[]) }   rows = modules, columns = codes grouped by resource (C2 04-UI-UX:57)
//   PrintFrame       { title: string; isOpen: boolean; onDone: () => void; children }  hidden iframe; children rendered inside it; fires print once, then onDone
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { EditableGrid } from '../EditableGrid/EditableGrid';
import { PermissionMatrix } from '../PermissionMatrix/PermissionMatrix';
import { PrintFrame } from '../PrintFrame/PrintFrame';
import { XSS, seriousViolations, user } from './helpers';

describe('EditableGrid (C3)', () => {
  const columns = [
    { id: 'code', header: 'Code', maxLength: 16 },
    { id: 'display', header: 'Display', maxLength: 40 },
    { id: 'order', header: 'Order', isReadOnly: true },
  ];
  const mkRows = () => [
    { id: 'r1', values: { code: 'POS', display: 'Positive', order: '1' }, status: 'saved' as const },
    { id: 'r2', values: { code: 'NEG', display: 'Negative', order: '2' }, status: 'error' as const, statusText: 'Code already exists', errors: { code: 'Code already exists' } },
    { id: 'r3', values: { code: 'IND', display: 'Indeterminate', order: '3' }, status: 'unsaved' as const },
  ];
  const Harness = ({ onCellChange = () => {}, isReadOnly = false }: { onCellChange?: (...a: any[]) => void; isReadOnly?: boolean }) => (
    <EditableGrid label="Values" columns={columns} rows={mkRows()} onCellChange={onCellChange} isReadOnly={isReadOnly} />
  );

  it('is an ARIA grid named by label with column headers and indexed rows/cells', () => {
    render(<Harness />);
    const grid = screen.getByRole('grid', { name: 'Values' });
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(expect.arrayContaining(['Code', 'Display', 'Order']));
    const rows = within(grid).getAllByRole('row');
    expect(rows.length).toBe(4); // header + 3
    for (const r of rows) expect(r.getAttribute('aria-rowindex')).toMatch(/^\d+$/);
    for (const c of within(grid).getAllByRole('gridcell')) expect(c.getAttribute('aria-colindex')).toMatch(/^\d+$/);
  });
  it('roving tabindex: exactly one cell is tabbable; Tab enters and leaves the grid in one stop', async () => {
    render(<Harness />);
    const cells = screen.getAllByRole('gridcell');
    expect(cells.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    expect(cells.filter((c) => c.tabIndex === -1).length).toBe(cells.length - 1);
    const u = user();
    await u.tab();
    expect(screen.getByRole('grid').contains(document.activeElement)).toBe(true);
    await u.tab();
    expect(screen.getByRole('grid').contains(document.activeElement)).toBe(false);
  });
  it('arrow keys move focus between cells; they stop at the edges', async () => {
    render(<Harness />);
    const u = user();
    await u.tab();
    const first = document.activeElement as HTMLElement;
    await u.keyboard('{ArrowRight}');
    expect(document.activeElement).not.toBe(first);
    await u.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(first);
    await u.keyboard('{ArrowLeft}{ArrowUp}');
    expect(document.activeElement).toBe(first);
    await u.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('row')[2].contains(document.activeElement)).toBe(true);
  });
  it('Enter starts editing (a textbox with the cell maxLength), typing + Enter commits via onCellChange, Esc cancels', async () => {
    const onCellChange = vi.fn();
    render(<Harness onCellChange={onCellChange} />);
    const u = user();
    await u.tab();
    await u.keyboard('{Enter}');
    const box = await screen.findByRole('textbox');
    expect(box.getAttribute('maxlength')).toBe('16');
    await u.clear(box);
    await u.type(box, 'POS2{Enter}');
    expect(onCellChange).toHaveBeenCalledWith('r1', 'code', 'POS2');
    onCellChange.mockClear();
    await u.keyboard('{ArrowRight}{Enter}');
    await u.type(await screen.findByRole('textbox'), 'zzz{Escape}');
    expect(onCellChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('read-only columns and isReadOnly grids never open an editor', async () => {
    const onCellChange = vi.fn();
    const { unmount } = render(<Harness onCellChange={onCellChange} />);
    const u = user();
    await u.tab();
    await u.keyboard('{ArrowRight}{ArrowRight}{Enter}');
    expect(screen.queryByRole('textbox')).toBeNull();
    unmount();
    render(<Harness onCellChange={onCellChange} isReadOnly />);
    await u.tab();
    await u.keyboard('{Enter}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onCellChange).not.toHaveBeenCalled();
  });
  it('cells with errors are aria-invalid and the error is text associated with the cell', () => {
    render(<Harness />);
    const bad = screen.getAllByRole('gridcell').filter((c) => c.getAttribute('aria-invalid') === 'true');
    expect(bad).toHaveLength(1);
    const ids = (bad[0].getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids.map((i) => document.getElementById(i)?.textContent).join(' ') + bad[0].textContent).toContain('Code already exists');
  });
  it('AC-0D-8.3 spirit: per-row status is text (saved / unsaved / error), not colour only', () => {
    render(<Harness />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0].textContent).toMatch(/saved/i);
    expect(rows[1].textContent).toMatch(/error|Code already exists/i);
    expect(rows[2].textContent).toMatch(/unsaved|changed|not saved/i);
  });
  it('row status changes are announced through an aria-live=polite region', () => {
    render(<Harness />);
    expect(document.querySelector('[aria-live="polite"], [role="status"]')).toBeTruthy();
  });
  it('REQ-SEC-088: cell values, headers and errors are text (XSS)', () => {
    (window as any).__xss = 0;
    const { container } = render(<EditableGrid label="Values" columns={[{ id: 'c', header: XSS[0] }]}
      rows={XSS.map((x, i) => ({ id: `r${i}`, values: { c: x }, status: 'error' as const, statusText: x, errors: { c: x } }))} onCellChange={() => {}} />);
    expect(container.querySelector('script, img, svg')).toBeNull();
    expect((window as any).__xss).toBe(0);
  });
  it('a controlled edit round-trips (parent state) and the new value is shown', async () => {
    const C = () => {
      const [rows, setRows] = useState(mkRows());
      return <EditableGrid label="Values" columns={columns} rows={rows} onCellChange={(rid: string, cid: string, v: string) =>
        setRows((rs) => rs.map((r) => (r.id === rid ? { ...r, values: { ...r.values, [cid]: v }, status: 'unsaved' as const } : r)))} />;
    };
    render(<C />);
    const u = user();
    await u.tab();
    await u.keyboard('{Enter}');
    const box = await screen.findByRole('textbox');
    await u.clear(box);
    await u.type(box, 'XYZ{Enter}');
    expect(within(screen.getByRole('grid')).getByText('XYZ')).toBeTruthy();
  });
  it('axe clean', async () => {
    render(<Harness />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('PermissionMatrix (C2 AD-5)', () => {
  const modules = [{ id: 'lab', label: 'Lab' }, { id: 'admin', label: 'Admin' }];
  const permissions = [
    { code: 'lab.result.enter', moduleId: 'lab', resource: 'result' },
    { code: 'lab.result.release', moduleId: 'lab', resource: 'result', isPrivileged: true },
    { code: 'admin.user.manage', moduleId: 'admin', resource: 'user', isPrivileged: true },
    { code: 'admin.tenant.own', moduleId: 'admin', resource: 'tenant', isAssignable: false, unassignableReason: 'Reserved for the platform owner' },
  ];
  const Harness = ({ onChange = () => {}, initial = [] as string[] }: { onChange?: (v: string[]) => void; initial?: string[] }) => {
    const [v, setV] = useState(initial);
    return <PermissionMatrix label="Permissions" modules={modules} permissions={permissions} value={v} onChange={(x: string[]) => { setV(x); onChange(x); }} />;
  };
  it('is a grid with one checkbox per permission code, named by the code, grouped by resource headers', () => {
    render(<Harness />);
    expect(screen.queryByRole('grid', { name: 'Permissions' })).toBeTruthy();
    for (const p of permissions) expect(screen.getByRole('checkbox', { name: new RegExp(p.code.replace(/\./g, '\\.')) })).toBeTruthy();
    for (const m of modules) expect(screen.getAllByText(m.label).length).toBeGreaterThan(0);
    for (const r of ['result', 'user', 'tenant']) expect(screen.getAllByText(new RegExp(`^${r}$`, 'i')).length).toBeGreaterThan(0);
  });
  it('privileged codes carry the text "privileged" (not colour only)', () => {
    render(<Harness />);
    expect(screen.getAllByText(/privileged/i).length).toBeGreaterThanOrEqual(2);
  });
  it('toggling a checkbox reports the new full selection; untoggling removes it', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const u = user();
    await u.click(screen.getByRole('checkbox', { name: /lab\.result\.enter/ }));
    expect(onChange).toHaveBeenLastCalledWith(['lab.result.enter']);
    await u.click(screen.getByRole('checkbox', { name: /admin\.user\.manage/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining(['lab.result.enter', 'admin.user.manage']));
    await u.click(screen.getByRole('checkbox', { name: /lab\.result\.enter/ }));
    expect(onChange).toHaveBeenLastCalledWith(['admin.user.manage']);
  });
  it('non-assignable codes are disabled, cannot be toggled, and a keyboard-reachable tooltip/hint explains why', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: /admin\.tenant\.own/ }) as HTMLInputElement;
    expect(box.disabled || box.getAttribute('aria-disabled') === 'true').toBe(true);
    await user().click(box);
    expect(onChange).not.toHaveBeenCalled();
    const hinted = box.getAttribute('aria-describedby') ?? '';
    const txt = hinted.split(' ').map((i) => document.getElementById(i)?.textContent ?? '').join(' ');
    expect(txt + (box.closest('[title]')?.getAttribute('title') ?? '')).toContain('Reserved for the platform owner');
  });
  it('a pre-selected non-assignable code is never added or removed by interaction (value passes through)', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial={['admin.tenant.own']} />);
    await user().click(screen.getByRole('checkbox', { name: /lab\.result\.enter/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining(['admin.tenant.own', 'lab.result.enter']));
  });
  it('keyboard grid navigation: one tab stop, arrows move between checkboxes, Space toggles', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const u = user();
    const tabbable = screen.getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).tabIndex === 0 && !(c as HTMLInputElement).disabled);
    expect(tabbable.length).toBe(1);
    await u.tab();
    const start = document.activeElement as HTMLElement;
    await u.keyboard('{ArrowRight}');
    expect(document.activeElement).not.toBe(start);
    await u.keyboard('{ }');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it('codes are text nodes (XSS)', () => {
    (window as any).__xss = 0;
    const { container } = render(<PermissionMatrix label="P" modules={[{ id: 'm', label: XSS[0] }]}
      permissions={[{ code: XSS[1], moduleId: 'm', resource: XSS[2] }]} value={[]} onChange={() => {}} />);
    expect(container.querySelector('script, img, svg')).toBeNull();
    expect((window as any).__xss).toBe(0);
  });
  it('axe clean', async () => {
    render(<Harness initial={['lab.result.enter']} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('PrintFrame (C4)', () => {
  const orig = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')!;
  afterEach(() => {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', orig);
    vi.restoreAllMocks();
  });
  function spyPrints() {
    const framePrint = vi.fn();
    const winPrint = vi.spyOn(window, 'print').mockImplementation(() => {});
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get() {
        const w = orig.get!.call(this);
        if (w) (w as any).print = framePrint;
        return w;
      },
    });
    return () => framePrint.mock.calls.length + winPrint.mock.calls.length;
  }

  it('renders nothing while closed', () => {
    const { container } = render(<PrintFrame title="Receipt" isOpen={false} onDone={() => {}}><p>x</p></PrintFrame>);
    expect(container.querySelector('iframe')).toBeNull();
  });
  it('open: a titled iframe hidden from sight and assistive tech, not navigable by keyboard', () => {
    render(<PrintFrame title="Receipt" isOpen onDone={() => {}}><p>Invoice INV-001</p></PrintFrame>);
    const f = document.querySelector('iframe')!;
    expect(f).toBeTruthy();
    expect(f.getAttribute('title')).toBe('Receipt');
    expect(f.getAttribute('aria-hidden')).toBe('true');
    expect(f.tabIndex).toBe(-1);
  });
  it('children are rendered inside the iframe document, not in the host page', async () => {
    render(<PrintFrame title="Receipt" isOpen onDone={() => {}}><p>Invoice INV-001</p></PrintFrame>);
    const f = document.querySelector('iframe')!;
    await waitFor(() => expect(f.contentDocument?.body.textContent).toContain('Invoice INV-001'));
    expect(document.body.textContent).not.toContain('Invoice INV-001');
  });
  it('fires print exactly once after content is in place, then calls onDone', async () => {
    const prints = spyPrints();
    const onDone = vi.fn();
    const { rerender } = render(<PrintFrame title="Receipt" isOpen onDone={onDone}><p>Invoice INV-001</p></PrintFrame>);
    await waitFor(() => expect(prints()).toBe(1));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    rerender(<PrintFrame title="Receipt" isOpen onDone={onDone}><p>Invoice INV-001</p></PrintFrame>);
    await new Promise((r) => setTimeout(r, 50));
    expect(prints()).toBe(1);
  });
  it('a failing print() does not leave the component stuck: onDone still runs and nothing throws', async () => {
    vi.spyOn(window, 'print').mockImplementation(() => { throw new Error('printer offline'); });
    const onDone = vi.fn();
    render(<PrintFrame title="Receipt" isOpen onDone={onDone}><p>x</p></PrintFrame>);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
  it('security: sandboxed so scripts in the frame cannot run; src never points off-origin; children XSS inert', async () => {
    (window as any).__xss = 0;
    render(<PrintFrame title="Receipt" isOpen onDone={() => {}}>{XSS.map((x, i) => <p key={i}>{x}</p>)}</PrintFrame>);
    const f = document.querySelector('iframe')!;
    expect(f.getAttribute('sandbox') ?? '').not.toMatch(/allow-scripts/);
    expect(f.getAttribute('src') ?? '').not.toMatch(/^(https?:)?\/\//i);
    await waitFor(() => expect(f.contentDocument?.body.textContent).toContain(XSS[0]));
    expect(f.contentDocument!.querySelector('script, img, svg')).toBeNull();
    expect((window as any).__xss).toBe(0);
  });
  it('closing removes the iframe (printed content does not linger in the DOM)', async () => {
    const { rerender } = render(<PrintFrame title="Receipt" isOpen onDone={() => {}}><p>Invoice INV-001</p></PrintFrame>);
    rerender(<PrintFrame title="Receipt" isOpen={false} onDone={() => {}}><p>Invoice INV-001</p></PrintFrame>);
    expect(document.querySelector('iframe')).toBeNull();
  });
  it('axe clean (host page)', async () => {
    render(<PrintFrame title="Receipt" isOpen onDone={() => {}}><p>x</p></PrintFrame>);
    expect(await seriousViolations()).toEqual([]);
  });
});
