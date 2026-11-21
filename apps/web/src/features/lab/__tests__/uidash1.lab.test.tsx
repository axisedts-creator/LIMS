// @vitest-environment jsdom
// T0D-UIDASH-1 (2) lab status board and (3) lab pending tests (LD-353 rules 5, 6, 8, 10; templates 1 and 5). Each screen renders with fake data twice: no rows and one row.
// STATUS BOARD contract: h1 = t('lab.nav.status_board'); exactly one `.lims-filter-bar`; ONE `.lims-stat-row` of five tiles Waiting, Collected, In lab, Ready, Printed
//   (value = rows of the loaded page with that status); every tile is clickable: a <button aria-pressed> that is the tile or sits inside it, its name starts with the label,
//   pressing it calls getStatusBoardAction({ board_status }) (the old status chip buttons go away); one ChartCard "Samples by status" (frame always draws, "No data yet" when empty);
//   the page header holds "Updated {time}" and the "Pause updates" button; the table (5 header cells) sits in `.lims-table-scroll` and keeps its header when empty.
// PENDING contract: h1 = t('lab.nav.pending'); exactly one `.lims-filter-bar` holding the "Over target only" switch (role=switch; replaces the bare checkbox);
//   StatTiles "Pending" and "Overdue"; the table keeps its header when empty ("Nothing pending." as a body row); ChartCard "Pending by department" holding the NotAvailable
//   state (PendingItem has no department and the screen does not read getPendingTestsSummary: the missing aggregate goes into the notes); a failed read keeps h1 and the
//   filter bar and shows ErrorState with Retry; 501 operation_pending shows NotAvailable (no alert), never the red error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { cardByTitle, cardNotAvailable, dataTables, filterBars, frameDraws, frameSaysNoData, hasAlert, headerCells, norm, tileLabel, tileRows, tileValue, tiles, titles } from '@/__tests__/uidash1.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/status-board',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));
const bff = vi.hoisted(() => ({ getStatusBoardAction: vi.fn(), listPendingAction: vi.fn() }));
vi.mock('../server/actions', () => ({ getStatusBoardAction: bff.getStatusBoardAction }));
vi.mock('../server/worklist.actions', () => ({ listPendingAction: bff.listPendingAction }));

const uuid = (n: number) => `01a1a98a-ac40-7000-8000-0000000${String(n).padStart(5, '0')}`;
const CENTRES = [{ id: uuid(2), name: 'Synthetic Central Lab' }];
const RANGE = { from: '2026-11-11T00:00:00.000Z', to: '2026-11-11T23:59:59.999Z' };
const row = (n: number, o: Record<string, unknown> = {}) => ({ order_id: uuid(100 + n), registration_no: `REG90${String(n).padStart(4, '0')}`,
  patient_display: { full_name: `Synthetic Patient ${n}`, age_sex: '34Y/F', patient_code: `P-SYN-${n}` }, centre_id: CENTRES[0]!.id, board_status: 'waiting', rejected_specimens: 0, priority: 'routine', ...o });
const board = async (rows: unknown[]) => {
  const { StatusBoard } = await import('../components/StatusBoard');
  return render(<ToastProvider><StatusBoard centres={CENTRES} initialRows={rows as never} initialRange={RANGE} permissions={['lab.status_board.read']} /></ToastProvider>);
};
const pend = (n: number, o: Record<string, unknown> = {}) => ({ order_test_id: uuid(300 + n), order_id: uuid(400 + n), registration_no: `REG91${String(n).padStart(4, '0')}`,
  patient_display: { full_name: `Synthetic Patient ${n}`, age_sex: '40Y/M', patient_code: `P-SYN-${n}` }, test_code: 'GLU', item_status: 'received', priority: 'routine',
  age_seconds: 1800, age_anchor: 'received', tat_target_seconds: 3600, over_target: false, ...o });
const pending = async () => {
  const { PendingPage } = await import('../components/pending/PendingPage');
  return render(<ToastProvider><PendingPage permissions={['lab.worklist.read']} /></ToastProvider>);
};
const ok = (data: unknown[]) => ({ ok: true, data: { data, page: { limit: 50 } } });
const tileFor = (c: ParentNode, label: string) => tiles(c).find((x) => tileLabel(x) === label)!;
const buttonOf = (el: Element) => (el.closest('button') ?? el.querySelector('button')) as HTMLButtonElement | null;

beforeEach(() => { bff.getStatusBoardAction.mockReset().mockResolvedValue(ok([])); bff.listPendingAction.mockReset().mockResolvedValue(ok([])); });
afterEach(cleanup);

describe('/lab/status-board (template 5 REPORT)', () => {
  it.each([['no rows', () => []], ['one row', () => [row(1, { board_status: 'ready' })]]])('%s: the h1 is the menu label, one FilterBar, a full width table header', async (_n, rows) => {
    const { container } = await board(rows());
    expect(titles(container)).toEqual([t('lab.nav.status_board')]);
    expect(filterBars(container)).toHaveLength(1);
    expect(headerCells(container)).toEqual(['Reg no', 'Patient', 'Centre', 'Status', 'Released at']);
    const table = dataTables(container)[0]!;
    expect(table.closest('.lims-table-scroll'), 'the table scrolls inside its own box (rule 5)').not.toBeNull();
  });

  it('no rows: the body row says "No registrations in this period."; one row: the row is listed', async () => {
    const a = await board([]);
    expect(within(dataTables(a.container)[0]!).getByText('No registrations in this period.')).toBeTruthy();
    a.unmount();
    await board([row(1)]);
    expect(screen.getByText('REG900001')).toBeTruthy();
  });

  it('five equal StatTiles in ONE row: Waiting, Collected, In lab, Ready, Printed, counted from the rows', async () => {
    const { container } = await board([row(1), row(2), row(3, { board_status: 'ready' }), row(4, { board_status: 'printed' })]);
    expect(tileRows(container)).toHaveLength(1);
    expect(tiles(container).map(tileLabel)).toEqual(['Waiting', 'Collected', 'In lab', 'Ready', 'Printed']);
    expect(tiles(container).map(tileValue).map((v) => v.replace(/\D/g, ''))).toEqual(['2', '0', '0', '1', '1']);
    expect([...tileRows(container)[0]!.children].every((c) => c.classList.contains('lims-stat') || !!c.querySelector('.lims-stat'))).toBe(true);
  });

  it('no rows: the five tiles show 0 (they still draw)', async () => {
    const { container } = await board([]);
    expect(tiles(container).map(tileLabel)).toEqual(['Waiting', 'Collected', 'In lab', 'Ready', 'Printed']);
    expect(tiles(container).map(tileValue).map((v) => v.replace(/\D/g, ''))).toEqual(['0', '0', '0', '0', '0']);
  });

  it('every tile is a clickable filter: a toggle button named by its label; pressing it asks for that board_status and marks it pressed', async () => {
    const { container } = await board([row(1, { board_status: 'ready' })]);
    for (const t5 of tiles(container)) expect(buttonOf(t5), `${tileLabel(t5)} is clickable`).not.toBeNull();
    const ready = buttonOf(tileFor(container, 'Ready'))!;
    expect(norm(ready.textContent)).toMatch(/^Ready\b/);
    expect(ready.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { fireEvent.click(ready); });
    expect(bff.getStatusBoardAction.mock.calls.at(-1)![0]).toMatchObject({ board_status: 'ready', registered_at_from: RANGE.from, registered_at_to: RANGE.to });
    expect(buttonOf(tileFor(container, 'Ready'))!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { fireEvent.click(buttonOf(tileFor(container, 'Ready'))!); });
    expect(String(bff.getStatusBoardAction.mock.calls.at(-1)![0].board_status ?? '')).toBe('');
  });

  it('review item 1: with a status filter on, a tile outside the filter shows "—" (the server sent only the filtered rows), never a false 0', async () => {
    bff.getStatusBoardAction.mockResolvedValue(ok([row(2, { board_status: 'ready' })]));
    const { container } = await board([row(1), row(2, { board_status: 'ready' })]);
    await act(async () => { fireEvent.click(buttonOf(tileFor(container, 'Ready'))!); });
    expect(bff.getStatusBoardAction.mock.calls.at(-1)![0]).toMatchObject({ board_status: 'ready' });
    const byLabel = Object.fromEntries(tiles(container).map((x) => [tileLabel(x), norm(tileValue(x))]));
    expect(byLabel.Ready!.replace(/\D/g, '')).toBe('1');
    for (const s of ['Waiting', 'Collected', 'In lab', 'Printed']) expect(byLabel[s], `${s} is outside the filter`).toBe('—');
    for (const s of ['Waiting', 'Collected', 'In lab', 'Printed']) expect(buttonOf(tileFor(container, s))!.getAttribute('aria-label'), `${s} aria-label`).not.toMatch(/\b0\b/);
  });

  it('the old status chips are gone: only the five tiles carry the status names as buttons', async () => {
    await board([row(1)]);
    for (const name of ['Waiting', 'Collected', 'In lab', 'Ready', 'Printed']) expect(screen.getAllByRole('button', { name: new RegExp(`^${name}\\b`) }), name).toHaveLength(1);
  });

  it('one ChartCard "Samples by status": drawn with data and with none ("No data yet")', async () => {
    const a = await board([row(1), row(2, { board_status: 'in_lab' })]);
    const full = cardByTitle(a.container, 'Samples by status')!;
    expect(full).toBeTruthy();
    expect(frameDraws(full)).toBe(true);
    expect(frameSaysNoData(full)).toBe(false);
    a.unmount();
    const b = await board([]);
    const empty = cardByTitle(b.container, 'Samples by status')!;
    expect(frameDraws(empty)).toBe(true);
    expect(frameSaysNoData(empty)).toBe(true);
  });

  it('the page header holds the Updated time and the Pause updates control (header slot, not the filter row)', async () => {
    const { container } = await board([row(1)]);
    const header = container.querySelector('.lims-page-header')!;
    expect(norm(header.textContent)).toMatch(/Updated\s+\S+/);
    const pause = within(header as HTMLElement).getByRole('button', { name: /pause updates/i });
    fireEvent.click(pause);
    expect(within(header as HTMLElement).getByRole('button', { name: /resume updates/i })).toBeTruthy();
    expect(filterBars(container)[0]!.textContent).not.toMatch(/pause|updated/i);
  });

  it('a failed refresh keeps the title, the tiles, the filter bar and the table header, and shows an alert', async () => {
    bff.getStatusBoardAction.mockResolvedValueOnce({ ok: false, status: 500, code: 'common.internal', title: 'Something went wrong' });
    const { container } = await board([row(1, { board_status: 'ready' })]);
    await act(async () => { fireEvent.click(buttonOf(tileFor(container, 'Ready'))!); });
    expect(hasAlert(container)).toBe(true);
    expect(titles(container)).toEqual([t('lab.nav.status_board')]);
    expect(filterBars(container)).toHaveLength(1);
    expect(tiles(container)).toHaveLength(5);
    expect(headerCells(container)).toHaveLength(5);
  });

  it('copy: no development note, no exclamation mark', async () => {
    const { container } = await board([row(1)]);
    expect(container.textContent).not.toMatch(/!|\bTODO\b|not wired/i);
  });
});

describe('/lab/pending (template 5 REPORT)', () => {
  it.each([['no rows', () => []], ['one row', () => [pend(1)]]])('%s: h1 = menu label, one FilterBar with the Over target only switch, the table header row', async (_n, rows) => {
    bff.listPendingAction.mockResolvedValue(ok(rows()));
    const { container } = await pending();
    await waitFor(() => expect(dataTables(container)).toHaveLength(1));
    expect(titles(container)).toEqual([t('lab.nav.pending')]);
    expect(filterBars(container)).toHaveLength(1);
    const sw = within(filterBars(container)[0] as HTMLElement).getByRole('switch', { name: /over target only/i });
    expect(sw).toBeTruthy();
    expect(container.querySelector('input[type="checkbox"]'), 'no bare checkbox is left').toBeNull();
    expect(headerCells(container).length).toBeGreaterThanOrEqual(6);
    expect(headerCells(container)).toEqual(expect.arrayContaining(['Reg no', 'Patient', 'Test', 'Status', 'Priority', 'TAT target']));
  });

  it('no rows: "Nothing pending." sits in the body below the header; the tiles read 0', async () => {
    const { container } = await pending();
    await screen.findByText('Nothing pending.');
    expect(dataTables(container)[0]!.contains(screen.getByText('Nothing pending.'))).toBe(true);
    expect(tiles(container).map(tileLabel)).toEqual(['Pending', 'Overdue']);
    expect(tiles(container).map(tileValue).map((v) => v.replace(/\D/g, ''))).toEqual(['0', '0']);
  });

  it('one row of two: StatTiles Pending 2 and Overdue 1 in one row', async () => {
    bff.listPendingAction.mockResolvedValue(ok([pend(1), pend(2, { over_target: true, age_seconds: 7200 })]));
    const { container } = await pending();
    await screen.findByText('REG910001');
    expect(tileRows(container)).toHaveLength(1);
    expect(tiles(container).map(tileLabel)).toEqual(['Pending', 'Overdue']);
    expect(tiles(container).map(tileValue).map((v) => v.replace(/\D/g, ''))).toEqual(['2', '1']);
  });

  it('switching Over target only asks the API for overTarget', async () => {
    const { container } = await pending();
    await screen.findByText('Nothing pending.');
    fireEvent.click(within(filterBars(container)[0] as HTMLElement).getByRole('switch', { name: /over target only/i }));
    await waitFor(() => expect(bff.listPendingAction).toHaveBeenLastCalledWith({ overTarget: true }));
  });

  it('"Pending by department" is a ChartCard holding NotAvailable (no department on the rows, summary not read)', async () => {
    bff.listPendingAction.mockResolvedValue(ok([pend(1)]));
    const { container } = await pending();
    await screen.findByText('REG910001');
    const c = cardByTitle(container, 'Pending by department')!;
    expect(c).toBeTruthy();
    expect(cardNotAvailable(c)).toBe(true);
  });

  it('a failed read keeps the title and the filter bar and shows ErrorState with Retry; Retry reads again', async () => {
    bff.listPendingAction.mockResolvedValueOnce({ ok: false, status: 500, code: 'common.internal', requestId: 'req-syn-1' }).mockResolvedValue(ok([pend(1)]));
    const { container } = await pending();
    await screen.findByRole('button', { name: /retry/i });
    expect(titles(container)).toEqual([t('lab.nav.pending')]);
    expect(filterBars(container)).toHaveLength(1);
    expect(container.textContent).toContain('req-syn-1');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('REG910001');
  });

  it('501 operation_pending: calm NotAvailable, keeps the title, no alert (rule 6)', async () => {
    bff.listPendingAction.mockResolvedValue({ ok: false, status: 501, code: 'operation_pending' });
    const { container } = await pending();
    await screen.findByText(/not available yet/i);
    expect(titles(container)).toEqual([t('lab.nav.pending')]);
    expect(hasAlert(container)).toBe(false);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
