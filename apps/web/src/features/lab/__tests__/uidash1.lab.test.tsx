// @vitest-environment jsdom
// T0D-UIDASH-1 (2) status board and (3) pending tests — LD-353 template 5 REPORT (rules 5, 6, 8, 10). Each screen is rendered with no rows and with one row.
// Fails today because: the status board has five button toggles and no StatTile row / ChartCard / header-slot status; the pending screen has a bare checkbox,
// no tiles, no chart and its 501 / failure states hide the filter; neither table sits in the kit's .lims-table-scroll box.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { cardTitled, cards, filterBars, h1s, hasNotAvailable, headerCells, menuLabel, norm, oneTileRow, statLabels, statOf } from '@/features/analytics/__tests__/uidash1.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/lab' }));
const { board, pending } = vi.hoisted(() => ({ board: vi.fn(), pending: vi.fn() }));
vi.mock('@/features/lab/server/actions', () => ({ getStatusBoardAction: board }));
vi.mock('@/features/lab/server/worklist.actions', () => ({ listPendingAction: pending }));

import { StatusBoard } from '@/features/lab/components/StatusBoard';
import { PendingPage } from '@/features/lab/components/pending/PendingPage';

const wrap = (el: React.ReactElement) => render(<ToastProvider>{el}</ToastProvider>);
const RANGE = { from: '2026-01-15T00:00:00.000Z', to: '2026-01-15T23:59:59.999Z' };
const boardRow = (status: string, n = 1) => ({
  order_id: `01a1a98a-ac40-7000-8000-00000000b${String(n).padStart(3, '0')}`, registration_no: `REG-${n}`, centre_id: 'c1', patient_display: { full_name: `Synthetic Patient ${n}`, age_sex: '30 Y / F' },
  board_status: status, rejected_specimens: 0, priority: 'routine', last_released_at: undefined,
});
const pendRow = (n: number, over = false) => ({
  order_test_id: `01a1a98a-ac40-7000-8000-00000000c${String(n).padStart(3, '0')}`, registration_no: `REG-${n}`, patient_display: { full_name: `Synthetic Patient ${n}`, age_sex: '30 Y / F' },
  test_code: 'GLU', item_status: 'in_progress', priority: 'routine', age_anchor: 'received', age_seconds: 3600, tat_target_seconds: 7200, over_target: over,
});
beforeEach(() => {
  board.mockResolvedValue({ ok: true, data: { data: [], page: {} } });
  pending.mockResolvedValue({ ok: true, data: { data: [], page: {} } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const mountBoard = (rows: ReturnType<typeof boardRow>[]) =>
  wrap(<StatusBoard centres={[{ id: 'c1', name: 'Synthetic Centre' }]} initialRows={rows as never} initialRange={RANGE} permissions={['lab.status_board.read']} />);
const inTableBox = (root: ParentNode) => !!root.querySelector('.lims-data-table .lims-table-scroll table, .lims-table-scroll table');

describe.each([['no rows', [] as ReturnType<typeof boardRow>[]], ['one row', [boardRow('ready')]]])('lab status board — %s', (_n, rows) => {
  it('h1 is the menu label; exactly one FilterBar; table header always present inside the kit scroll box', () => {
    const { container } = mountBoard(rows);
    expect(h1s(container)).toEqual([menuLabel('/lab/status-board')]);
    expect(filterBars(container)).toHaveLength(1);
    expect(headerCells(container)).toEqual(expect.arrayContaining(['Reg no', 'Patient', 'Centre', 'Status', 'Released at']));
    expect(inTableBox(container), 'table inside .lims-table-scroll (header spans the full width)').toBe(true);
  });

  it('five StatTiles Waiting, Collected, In lab, Ready, Printed in ONE row; each is clickable', () => {
    const { container } = mountBoard(rows);
    expect(statLabels(container)).toEqual(['Waiting', 'Collected', 'In lab', 'Ready', 'Printed']);
    expect(oneTileRow(container)).toBe(true);
    for (const l of ['Waiting', 'Collected', 'In lab', 'Ready', 'Printed']) {
      const tile = statOf(container, l)!;
      expect(tile.matches('a,button,[role="button"]') || tile.closest('a,button,[role="button"]') || tile.querySelector('a,button,[role="button"]'), `${l} tile is interactive`).toBeTruthy();
    }
    const ready = norm(statOf(container, 'Ready')!.textContent);
    expect(ready).toMatch(rows.length ? /\b1\b/ : /\b0\b/);
  });

  it('one ChartCard "samples by status" with a bar chart; empty frames say "No data yet"', () => {
    const { container } = mountBoard(rows);
    const card = cards(container).find((c) => /by status/i.test(c.querySelector('.lims-chart-card-title')?.textContent ?? ''));
    expect(card, 'ChartCard with "by status" in its title').toBeTruthy();
    expect(cards(container)).toHaveLength(1);
    expect(card!.querySelector('svg'), 'frame draws the chart').toBeTruthy();
    expect(card!.querySelector('.lims-chart-empty') !== null).toBe(rows.length === 0);
  });

  it('Updated time and Pause updates sit in the page header slot', () => {
    const { container } = mountBoard(rows);
    const header = container.querySelector('.lims-page-header')!;
    expect(header.textContent).toMatch(/Updated/);
    expect(within(header as HTMLElement).getByRole('button', { name: 'Pause updates' })).toBeTruthy();
  });
});

describe('lab status board — tile click filters the table', () => {
  it('clicking the Waiting tile re-reads the board with board_status=waiting', async () => {
    const { container } = mountBoard([boardRow('ready')]);
    const tile = statOf(container, 'Waiting')!;
    fireEvent.click(tile.matches('a,button,[role="button"]') ? tile : (tile.closest('a,button,[role="button"]') ?? tile.querySelector('a,button,[role="button"]') ?? tile));
    await waitFor(() => expect(board).toHaveBeenCalled());
    expect(board.mock.calls.at(-1)![0]).toMatchObject({ board_status: 'waiting' });
  });
});

describe('lab status board — no access keeps its message', () => {
  it('without lab.status_board.read it shows the access message, no data', () => {
    const { container } = wrap(<StatusBoard centres={[]} initialRows={[boardRow('ready')] as never} initialRange={RANGE} permissions={[]} />);
    expect(container.textContent).toContain("You don't have access to this screen.");
    expect(container.querySelectorAll('.lims-stat')).toHaveLength(0);
  });
});

describe.each([['no rows', []], ['one row', [pendRow(1, true)]]])('lab pending tests — %s', (_n, rows) => {
  const mount = async () => {
    pending.mockResolvedValue({ ok: true, data: { data: rows, page: {} } });
    const r = wrap(<PendingPage permissions={['lab.worklist.read']} />);
    await waitFor(() => expect(r.container.querySelector('table')).toBeTruthy());
    return r;
  };

  it('h1 is the menu label; exactly one FilterBar; the table header is present and sits in the kit scroll box', async () => {
    const { container } = await mount();
    expect(h1s(container)).toEqual([menuLabel('/lab/pending')]);
    expect(filterBars(container)).toHaveLength(1);
    expect(headerCells(container)).toEqual(expect.arrayContaining(['Reg no', 'Patient', 'Test', 'Status', 'Priority', 'TAT target']));
    expect(inTableBox(container)).toBe(true);
    if (rows.length === 0) expect(container.textContent).toContain('Nothing pending.');
  });

  it('"Over target only" is a switch inside the FilterBar and nowhere else (no bare checkbox)', async () => {
    const { container } = await mount();
    const bar = filterBars(container)[0] as HTMLElement;
    expect(within(bar).getByRole('switch', { name: /over target only/i })).toBeTruthy();
    const loose = [...container.querySelectorAll('input[type="checkbox"]')].filter((i) => !bar.contains(i));
    expect(loose, 'checkbox outside the FilterBar').toHaveLength(0);
  });

  it('turning the switch on asks only for over-target rows', async () => {
    const { container } = await mount();
    fireEvent.click(within(filterBars(container)[0] as HTMLElement).getByRole('switch', { name: /over target only/i }));
    await waitFor(() => expect(pending.mock.calls.at(-1)![0]).toMatchObject({ overTarget: true }));
  });

  it('StatTiles Pending and Overdue in one row with the counts', async () => {
    const { container } = await mount();
    expect(statLabels(container)).toEqual(['Pending', 'Overdue']);
    expect(oneTileRow(container)).toBe(true);
    expect(norm(statOf(container, 'Pending')!.textContent)).toMatch(rows.length ? /\b1\b/ : /\b0\b/);
    expect(norm(statOf(container, 'Overdue')!.textContent)).toMatch(rows.length ? /\b1\b/ : /\b0\b/);
  });

  it('a ChartCard "pending by department" exists; the screen does not read getPendingTestsSummary today, so it shows NotAvailable inside the frame', async () => {
    const { container } = await mount();
    const card = cards(container).find((c) => /by department/i.test(c.querySelector('.lims-chart-card-title')?.textContent ?? ''));
    expect(card, 'ChartCard with "by department" in its title').toBeTruthy();
    expect(hasNotAvailable(card!), 'NotAvailable inside the card').toBe(true);
    expect(container.querySelectorAll('h1'), 'NotAvailable inside a card must not add a second h1').toHaveLength(1);
  });
});

describe('lab pending tests — failures keep the page', () => {
  it('a 500 keeps the title and the filter, shows message + Retry, and the Retry reads again', async () => {
    pending.mockResolvedValue({ ok: false, status: 500, code: 'common.internal', title: 'Something went wrong', requestId: 'req-synthetic-1' });
    const { container } = wrap(<PendingPage permissions={['lab.worklist.read']} />);
    await screen.findByRole('button', { name: /retry/i });
    expect(h1s(container)).toEqual([menuLabel('/lab/pending')]);
    expect(filterBars(container)).toHaveLength(1);
    pending.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(pending).toHaveBeenCalled());
  });

  it('a 501 operation_pending is the calm NotAvailable state: title and filter kept, no alert, no Retry', async () => {
    pending.mockResolvedValue({ ok: false, status: 501, code: 'common.operation_pending', title: 'Not built yet' });
    const { container } = wrap(<PendingPage permissions={['lab.worklist.read']} />);
    await waitFor(() => expect(hasNotAvailable(container)).toBe(true));
    expect(h1s(container)).toEqual([menuLabel('/lab/pending')]);
    expect(filterBars(container)).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
