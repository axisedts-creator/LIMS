// @vitest-environment jsdom
// C5.T-27 — Status board screen `/lab/status-board` (04-UI-UX §3.11, 03-APP-FLOW §3.11 + §1.5; PRD AC-18.1). Component level; the BFF action is mocked, fake timers drive the 30 s poll.
// ASSUMED module/prop contract (spec fixes folders + copy + kit components only; raise a dispute to rename):
//   components/StatusBoard.tsx  export StatusBoard({ centres, initialRows, initialRange, permissions })
//        centres: {id, name}[] (centres in the actor's scope)   initialRows: StatusBoardRow[] (lab.yaml StatusBoardRow, as served by GET /v1/lab/status-board, already loaded by the page)
//        initialRange: { from: string; to: string } (ISO UTC, ≤ 7 days)   permissions: string[]
//   Polling and filter changes go through a SERVER ACTION, never a client fetch with the JWT (REQ-SEC-068): server/actions.ts exports
//        getStatusBoardAction({ registered_at_from, registered_at_to, centre_id?, board_status? (csv) }): Promise<ActionResult<{ data: StatusBoardRow[]; page: { limit: number; next_cursor?: string } }>>
//        with ActionResult = { ok: true, data } | { ok: false, status, code, title } (same as the T-11 actions).
//   Copy (04-UI-UX §3.11): StatusChip labels Waiting / Collected / In lab / Ready / Printed; badge text "Sample rejected"; urgent ★ (accessible name "Urgent"); "Updated {time}" text;
//        a pause toggle named /pause/i (button or switch; after pausing it is named /resume/i); status filter chips = buttons named by the label with aria-pressed; a "Centre" Select; empty "No registrations in this period."
// NOT tested (spec silent): the date-range pickers and their ≤ 7 days message, the "(partial)"/"(preliminary)" chip variants (lab.yaml StatusBoardRow has no release-kind field — see notes), column order.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/status-board',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));
const bff = vi.hoisted(() => ({ getStatusBoardAction: vi.fn() }));
vi.mock('../server/actions', () => ({ getStatusBoardAction: bff.getStatusBoardAction }));

const uuid = (n: number) => `01a1a98a-ac40-7000-8000-0000000${String(n).padStart(5, '0')}`;
const CENTRES = [{ id: uuid(2), name: 'Synthetic Central Lab' }, { id: uuid(3), name: 'Synthetic Satellite Lab' }];
const row = (n: number, o: Record<string, unknown> = {}) => ({ order_id: uuid(100 + n), registration_no: `REG27${String(n).padStart(4, '0')}`,
  patient_display: { full_name: `Synthetic Patient ${n}`, age_sex: '34Y/F', patient_code: `P-SYN-${n}` }, centre_id: CENTRES[0]!.id, board_status: 'collected', rejected_specimens: 0, priority: 'routine', ...o });
const RANGE = { from: '2026-11-11T00:00:00.000Z', to: '2026-11-11T23:59:59.999Z' };
const PERMS = ['lab.status_board.read'];
const page = (data: unknown[]) => ({ ok: true, data: { data, page: { limit: 50 } } });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const show = async (rows: unknown[], extra: Record<string, unknown> = {}) => {
  const { StatusBoard } = await import('../components/StatusBoard');
  const ui: ReactNode = <ToastProvider><StatusBoard centres={CENTRES} initialRows={rows as never} initialRange={RANGE} permissions={PERMS} {...extra} /></ToastProvider>;
  return render(ui);
};
const toggle = (name: RegExp) => [...screen.getAllByRole('button'), ...screen.queryAllByRole('switch')].find((e) => name.test(e.getAttribute('aria-label') ?? e.textContent ?? ''))!;
const rowEl = (reg: string) => screen.getByText(reg).closest('tr') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-11T05:00:00.000Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  bff.getStatusBoardAction.mockReset().mockResolvedValue(page([]));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('T-27 status board table (AC-18.1)', () => {
  it('shows one row per order with registration no, patient name and the StatusChip label of each board status', async () => {
    const rows = [row(1, { board_status: 'waiting' }), row(2, { board_status: 'collected' }), row(3, { board_status: 'in_lab' }), row(4, { board_status: 'ready' }), row(5, { board_status: 'printed', last_released_at: '2026-11-11T04:30:00.000Z' })];
    await show(rows);
    const labels = ['Waiting', 'Collected', 'In lab', 'Ready', 'Printed'];
    rows.forEach((r, i) => {
      const tr = rowEl(r.registration_no);
      expect(within(tr).getByText(r.patient_display.full_name)).toBeTruthy();
      expect(within(tr).getByText(labels[i]!, { exact: true }), `${r.board_status} chip`).toBeTruthy();
    });
  });

  it('the badge "Sample rejected" appears only on rows with rejected_specimens > 0 (text, not colour alone)', async () => {
    await show([row(1, { board_status: 'in_lab', rejected_specimens: 1 }), row(2, { board_status: 'in_lab', rejected_specimens: 0 })]);
    expect(within(rowEl('REG270001')).getByText('Sample rejected')).toBeTruthy();
    expect(within(rowEl('REG270002')).queryByText('Sample rejected')).toBeNull();
  });

  it('an urgent order carries an accessible "Urgent" star; a routine one does not', async () => {
    await show([row(1, { priority: 'urgent' }), row(2, { priority: 'routine' })]);
    expect(within(rowEl('REG270001')).getByLabelText(/urgent/i)).toBeTruthy();
    expect(within(rowEl('REG270002')).queryByLabelText(/urgent/i)).toBeNull();
  });

  it('empty result: "No registrations in this period."', async () => {
    await show([]);
    expect(screen.getByText('No registrations in this period.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows "Updated {time}" text and has no axe violations', async () => {
    const { container } = await show([row(1, { rejected_specimens: 1 }), row(2, { priority: 'urgent', board_status: 'printed', last_released_at: '2026-11-11T04:30:00.000Z' })]);
    expect(document.body.textContent).toMatch(/Updated\s+\S+/);
    vi.useRealTimers(); // ruling: axe.run uses setTimeout internally
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
  });
});

describe('T-27 auto-refresh every 30 s by polling, with a pause toggle (03-APP-FLOW §3.11)', () => {
  it('no request before 30 s; then one per 30 s with the range of the screen; rows follow the response', async () => {
    bff.getStatusBoardAction.mockResolvedValue(page([row(1, { board_status: 'ready' })]));
    await show([row(1, { board_status: 'in_lab' })]);
    await tick(29_000);
    expect(bff.getStatusBoardAction).not.toHaveBeenCalled();
    await tick(2_000);
    expect(bff.getStatusBoardAction).toHaveBeenCalledTimes(1);
    expect(bff.getStatusBoardAction.mock.calls[0]![0]).toMatchObject({ registered_at_from: RANGE.from, registered_at_to: RANGE.to });
    expect(within(rowEl('REG270001')).getByText('Ready', { exact: true })).toBeTruthy();
    await tick(30_000);
    expect(bff.getStatusBoardAction).toHaveBeenCalledTimes(2);
  });

  it('pause stops the polling, resume restarts it', async () => {
    await show([row(1)]);
    fireEvent.click(toggle(/pause/i));
    await tick(95_000);
    expect(bff.getStatusBoardAction).not.toHaveBeenCalled();
    fireEvent.click(toggle(/resume/i));
    await tick(31_000);
    expect(bff.getStatusBoardAction).toHaveBeenCalledTimes(1);
  });

  it('unmount stops the polling (no request after the screen is gone)', async () => {
    const { unmount } = await show([row(1)]);
    unmount();
    await tick(95_000);
    expect(bff.getStatusBoardAction).not.toHaveBeenCalled();
  });

  it('the poll goes through the server action, never a client fetch (REQ-SEC-068: the JWT stays on the server)', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    await show([row(1)]);
    await tick(61_000);
    expect(bff.getStatusBoardAction).toHaveBeenCalledTimes(2);
    expect(f).not.toHaveBeenCalled();
  });

  it('a failed refresh keeps the rows on screen and announces the error (role=alert); the next tick retries', async () => {
    bff.getStatusBoardAction.mockResolvedValueOnce({ ok: false, status: 500, code: 'common.internal', title: 'Something went wrong' }).mockResolvedValue(page([row(1, { board_status: 'ready' })]));
    await show([row(1, { board_status: 'in_lab' })]);
    await tick(31_000);
    expect(within(rowEl('REG270001')).getByText('In lab', { exact: true })).toBeTruthy();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    await tick(30_000);
    expect(within(rowEl('REG270001')).getByText('Ready', { exact: true })).toBeTruthy();
  });
});

// Review C5.T-27 (CHANGES 1): the board must not silently drop orders beyond the first API page (AC-18.1 "per order").
// ASSUMED contract (review fix a): a response with page.next_cursor shows a "Load more" button; pressing it calls the action again with { ..., cursor: next_cursor }
// and APPENDS the returned rows; the button is gone when the last page has no next_cursor. A poll / filter change resets to page 1.
describe('T-27 paging: page.next_cursor is not ignored (AC-18.1)', () => {
  const withCursor = (data: unknown[], next_cursor?: string) => ({ ok: true, data: { data, page: { limit: 50, ...(next_cursor ? { next_cursor } : {}) } } });
  const pickReady = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Ready$/ })); }); };

  it('shows "Load more" when the response has next_cursor and appends the next page with that cursor', async () => {
    bff.getStatusBoardAction.mockResolvedValueOnce(withCursor([row(1, { board_status: 'ready' })], 'cur-page-2'))
      .mockResolvedValueOnce(withCursor([row(2, { board_status: 'ready' })]));
    await show([row(1)]);
    await pickReady();
    expect(screen.getByText('REG270001')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /load more/i })); });
    expect(bff.getStatusBoardAction.mock.calls.at(-1)![0]).toMatchObject({ cursor: 'cur-page-2', board_status: 'ready' });
    expect(screen.getByText('REG270001')).toBeTruthy();
    expect(screen.getByText('REG270002')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('no "Load more" when the response has no next_cursor; the next poll starts again at page 1 (no cursor)', async () => {
    await show([row(1)]);
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    bff.getStatusBoardAction.mockResolvedValueOnce(withCursor([row(1)], 'cur-page-2')).mockResolvedValue(page([row(1)]));
    await tick(31_000);
    expect(screen.getByRole('button', { name: /load more/i })).toBeTruthy();
    await tick(30_000);
    expect(bff.getStatusBoardAction.mock.calls.at(-1)![0]).not.toHaveProperty('cursor');
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });
});

describe('T-27 filters: status chips and centre', () => {
  it('toggling status chips requests board_status as a csv of the chosen statuses (and none when cleared)', async () => {
    await show([row(1)]);
    const chip = (name: RegExp) => screen.getByRole('button', { name });
    await act(async () => { fireEvent.click(chip(/^Ready$/)); });
    await act(async () => { fireEvent.click(chip(/^Printed$/)); });
    const last = bff.getStatusBoardAction.mock.calls.at(-1)![0] as Record<string, string>;
    expect(String(last.board_status).split(',').sort()).toEqual(['printed', 'ready']);
    expect(chip(/^Ready$/).getAttribute('aria-pressed')).toBe('true');
    await act(async () => { fireEvent.click(chip(/^Ready$/)); });
    await act(async () => { fireEvent.click(chip(/^Printed$/)); });
    const cleared = bff.getStatusBoardAction.mock.calls.at(-1)![0] as Record<string, string>;
    expect(cleared.board_status ?? '').toBe('');
  });

  it('choosing a centre requests centre_id; the range of the screen is kept', async () => {
    await show([row(1)]);
    const sel = screen.getByLabelText(/centre/i) as HTMLSelectElement;
    await act(async () => { fireEvent.change(sel, { target: { value: CENTRES[1]!.id } }); });
    expect(bff.getStatusBoardAction).toHaveBeenCalled();
    expect(bff.getStatusBoardAction.mock.calls.at(-1)![0]).toMatchObject({ centre_id: CENTRES[1]!.id, registered_at_from: RANGE.from, registered_at_to: RANGE.to });
  });
});
