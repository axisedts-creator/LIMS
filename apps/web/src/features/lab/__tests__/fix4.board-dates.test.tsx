// @vitest-environment jsdom
// T0D-FIX-4 (LD-446, CR DEPLOY-AXIS-012) done_when 3 — Lab status board: From date / To date use the kit date input (DD/MM/YYYY text field
// with calendar button, like every other screen), not the native <input type="date"> (US format picker). Synthetic data only.
// Behaviour that already exists must survive: the range goes to the BFF action as local-day ISO instants, a span over 7 days is refused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
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

const CENTRES = [{ id: '01a1a98a-ac40-7000-8000-000000000002', name: 'Synthetic Central Lab' }];
// local calendar days (the screen speaks local days), so the test does not depend on the machine time zone
const start = (y: number, m: number, d: number) => new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
const end = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
const RANGE = { from: start(2026, 11, 11), to: end(2026, 11, 11) };
const empty = { ok: true, data: { data: [], page: { limit: 50 } } };

const show = async () => {
  const { StatusBoard } = await import('../components/StatusBoard');
  return render(<ToastProvider><StatusBoard centres={CENTRES} initialRows={[]} initialRange={RANGE} permissions={['lab.status_board.read']} /></ToastProvider>);
};
const from = () => screen.getByLabelText(/^From date$/) as HTMLInputElement;
const to = () => screen.getByLabelText(/^To date$/) as HTMLInputElement;
const typeDate = async (el: HTMLInputElement, text: string) => { await userEvent.clear(el); await userEvent.type(el, `${text}{Enter}`); };

beforeEach(() => { bff.getStatusBoardAction.mockReset().mockResolvedValue(empty); });
afterEach(() => cleanup());

describe('status board date inputs', () => {
  it('no native date input is left: From date and To date are the kit date fields (text, DD/MM/YYYY placeholder)', async () => {
    const { container } = await show();
    expect(container.querySelector('input[type="date"]')).toBeNull();
    for (const el of [from(), to()]) {
      expect(el.type).toBe('text');
      expect(el.placeholder).toBe('DD/MM/YYYY');
    }
  });

  it('each field has the kit calendar button', async () => {
    await show();
    expect(screen.getByRole('button', { name: /open calendar for from date/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /open calendar for to date/i })).toBeTruthy();
  });

  it('the initial range shows as DD/MM/YYYY (11/11/2026), not the US or ISO form', async () => {
    await show();
    expect(from().value).toBe('11/11/2026');
    expect(to().value).toBe('11/11/2026');
  });

  it('typing a new To date (13/11/2026) requests the board with that local day end; From is kept', async () => {
    await show();
    await typeDate(to(), '13/11/2026');
    await waitFor(() => expect(bff.getStatusBoardAction).toHaveBeenCalled());
    expect(bff.getStatusBoardAction.mock.calls.at(-1)![0]).toMatchObject({ registered_at_from: RANGE.from, registered_at_to: end(2026, 11, 13) });
    expect(to().value).toBe('13/11/2026');
  });

  it('typing a new From date (10/11/2026) requests the board with that local day start; To is kept', async () => {
    await show();
    await typeDate(from(), '10/11/2026');
    await waitFor(() => expect(bff.getStatusBoardAction).toHaveBeenCalled());
    expect(bff.getStatusBoardAction.mock.calls.at(-1)![0]).toMatchObject({ registered_at_from: start(2026, 11, 10), registered_at_to: RANGE.to });
  });

  it('a period over 7 days is refused with the existing message and no request is sent', async () => {
    await show();
    await typeDate(to(), '25/11/2026');
    expect(await screen.findByText(/at most 7 days/i)).toBeTruthy();
    expect(bff.getStatusBoardAction).not.toHaveBeenCalled();
  });

  it('text that is not a date (US order 11/25/2026, letters) sends no request and does not change the range', async () => {
    await show();
    await typeDate(to(), '11/25/2026');
    await typeDate(from(), 'abc');
    expect(bff.getStatusBoardAction).not.toHaveBeenCalled();
  });

  it('axe: the date fields are labelled and the screen has no violations', async () => {
    const { container } = await show();
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
