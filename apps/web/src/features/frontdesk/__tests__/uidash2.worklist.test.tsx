// @vitest-environment jsdom
// T0D-UIDASH-2 (2) Front-desk worklist rebuilt to the approved worklist mock (LD-436 look, LD-437 exact match; done_when (2) and (3)).
// Mock blocks in order: PageHeader (title, one caption line, primary New registration) / one Card holding Tabs with a count pill per tab, the FilterBar and the DataTable /
// DataTable columns Accession no., Patient, Tests, Registered, Time elapsed, Status (StatusChip word + dot), then the row menu; numbers right aligned; header row always drawn; a pager with the total.
// The contract (OrderSummary) returns no age, sex or assignee: nothing is invented for them. Sample data of the mock is never used: every value below is synthetic.
// Component contract unchanged: FrontdeskWorklist({flags, orders, preRegistered, duplicates, resolutions, permissions, failed}).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { columnCells, headerTexts, menuLabel, page, problem, props, bodyRows } from '@/__tests__/uilist2.helpers';
import { ORIGIN, PERM, RECEPTION, U, flag, flagResolutions, orderSummary, patientSummary } from './fd-t14.fixtures';

process.env['LIMS_ORIGIN_API'] = ORIGIN;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/frontdesk/worklist',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['frontdesk.registration.create', 'frontdesk.order.edit', 'frontdesk.patient.read'], displayName: 'Synthetic Receptionist', membershipId: U(90), tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/frontdesk/worklist',
}));

import { FrontdeskWorklist } from '@/features/frontdesk/components/FrontdeskWorklist';

const W = '/frontdesk/worklist';
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const NOW = '2026-11-07T06:30:00.000Z'; // 04:00Z registered => 2h 30m elapsed
const orders = [
  orderSummary({ item_count: 3 }),
  orderSummary({ id: U(6), registration_no: 'R-0001-000002', patient_display: 'Demo Patient C', item_count: 12, status: 'in_progress' }),
  orderSummary({ id: U(7), registration_no: 'R-0001-000003', patient_display: 'Demo Patient D', item_count: 1 }),
];
const flags = [
  flag(), // recollection, order 1
  flag({ id: U(21), order_id: U(6), specimen_id: U(71) }), // recollection, order 6
  flag({ id: U(22), order_id: U(7), kind: 'booking_cancelled_after_registration', specimen_id: undefined }),
  flag({ id: U(23), order_id: U(7), status: 'resolved', resolution_code: 'patient_recalled' }), // resolved: not counted
];
const pre = [orderSummary({ id: U(8), registration_no: 'R-0001-000004', patient_display: 'Demo Patient E', status: 'pre_registered', source: 'engagement_booking', has_open_flag: false })];
const dup = [{ patient: patientSummary({ id: U(9), patient_code: 'P-000009', full_name: 'Demo Patient F' }), candidates: [patientSummary({ id: U(10), patient_code: 'P-000003', full_name: 'Demo Patient F.' })] }];
const view = (o: Record<string, unknown> = {}) => render(<ToastProvider><FrontdeskWorklist flags={flags as never} orders={orders as never} preRegistered={pre as never} duplicates={dup as never} resolutions={flagResolutions} permissions={RECEPTION} {...o} /></ToastProvider>);

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const COLS = [/^Accession no\.?$/i, /^Patient$/i, /^Tests$/i, /^Registered$/i, /^Time elapsed$/i, /^Status$/i];

describe('worklist header and tabs (mock rows 1 and 2)', () => {
  it('PageHeader: one h1, a caption line, the primary "New registration" link to the registration screen', () => {
    const { container } = view();
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toMatch(/lims-page-title/);
    const head = h1s[0]!.closest('header, .lims-page-header') as HTMLElement | null;
    expect(head, 'kit PageHeader').not.toBeNull();
    expect(norm(head!.textContent).length, 'a caption line next to the title').toBeGreaterThan(norm(h1s[0]!.textContent).length);
    expect(within(head!).getByRole('link', { name: /new registration/i }).getAttribute('href')).toBe('/frontdesk/registrations/new');
  });

  it('tabs, a count pill on every tab (0 shown): Recollection 2, Booking cancelled 1 (open flags only), Pre-registered 1, Possible duplicates 1', () => {
    view();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => norm(t.childNodes[0]?.textContent))).toEqual(['Recollection needed', 'Booking cancelled after registration', 'Pre-registered today', 'Possible duplicates created today']);
    expect(tabs.map((t) => norm(t.querySelector('.lims-tab-badge')?.textContent))).toEqual(['2', '1', '1', '1']);
  });

  it('no flags and nothing pending: every tab still shows its count pill as 0', () => {
    view({ flags: [], preRegistered: [], duplicates: [] });
    expect(screen.getAllByRole('tab').map((t) => norm(t.querySelector('.lims-tab-badge')?.textContent))).toEqual(['0', '0', '0', '0']);
  });

  it('without frontdesk.registration.create the duplicates tab is not drawn (permission rule kept)', () => {
    view({ permissions: [PERM.orderRead, PERM.orderEdit] });
    expect(screen.queryByRole('tab', { name: /possible duplicates/i })).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('the tabs, the FilterBar and the table sit in ONE kit Card (mock: one bordered surface)', () => {
    const { container } = view();
    const card = container.querySelector('.lims-tablist')!.closest('.lims-card') as HTMLElement | null;
    expect(card, 'a Card around the tabs').not.toBeNull();
    expect(card!.querySelector('.lims-filter-bar'), 'FilterBar inside the same Card').not.toBeNull();
    expect(card!.querySelector('table, [role="grid"]'), 'table inside the same Card').not.toBeNull();
  });
});

describe('worklist FilterBar (mock row 2)', () => {
  it('a kit FilterBar with a text search and a Clear / Reset filters button', () => {
    const { container } = view();
    const bars = container.querySelectorAll('.lims-filter-bar');
    expect(bars).toHaveLength(1);
    expect(bars[0]!.querySelector('input[type="text"], input[type="search"], input:not([type])'), 'a text filter').not.toBeNull();
    expect(within(bars[0] as HTMLElement).getByRole('button', { name: /(clear|reset) filters/i })).toBeTruthy();
  });
});

describe('worklist DataTable (mock row 3)', () => {
  it('Recollection tab: header row Accession no., Patient, Tests, Registered, Time elapsed, Status, then the row menu column; one row per open flag', () => {
    const { container } = view();
    const heads = headerTexts(container);
    const first6 = heads.slice(0, 6);
    COLS.forEach((re, i) => expect(first6[i], `column ${i + 1} ${re}`).toMatch(re));
    const rows = bodyRows(container);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => norm(r.textContent)).join(' ')).toMatch(/R-0001-000001/);
    expect(rows.map((r) => norm(r.textContent)).join(' ')).toMatch(/R-0001-000002/);
  });

  it('Accession no. is a link to the order, in the monospace family class; Patient shows the name', () => {
    const { container } = view();
    const link = screen.getByRole('link', { name: 'R-0001-000001' });
    expect(link.getAttribute('href')).toBe(`/frontdesk/orders/${U(1)}`);
    const { cells } = columnCells(container, /^Accession no/i);
    expect(cells[0]!.querySelector('.lims-mono'), 'accession number in the mono family (lims-mono)').not.toBeNull();
    const row = link.closest('tr')!;
    expect(within(row).getByText('Demo Patient A')).toBeTruthy();
  });

  it('Tests (item_count) and Time elapsed are right aligned, header and cells; elapsed is hours and minutes since registration (2h 30m)', () => {
    const { container } = view();
    for (const re of [/^Tests$/i, /^Time elapsed$/i]) {
      const { head, cells } = columnCells(container, re);
      expect(head.className, `${re} header`).toMatch(/align-end/);
      for (const c of cells) expect(c.className, `${re} cell "${norm(c.textContent)}"`).toMatch(/align-end/);
    }
    expect(columnCells(container, /^Tests$/i).cells.map((c) => norm(c.textContent))).toEqual(['3', '12']);
    expect(columnCells(container, /^Time elapsed$/i).cells.map((c) => norm(c.textContent))).toEqual(['2h 30m', '2h 30m']);
  });

  it('Registered shows a clock time (hh:mm), not the raw ISO string', () => {
    const { container } = view();
    for (const c of columnCells(container, /^Registered$/i).cells) {
      expect(norm(c.textContent)).toMatch(/\b\d{1,2}:\d{2}\b/);
      expect(norm(c.textContent)).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('Status is a StatusChip: a word plus a dot or icon in a tone, never colour alone', () => {
    const { container } = view();
    const cells = columnCells(container, /^Status$/i).cells;
    expect(cells).toHaveLength(2);
    for (const c of cells) {
      const chip = c.querySelector('.lims-chip');
      expect(chip, 'StatusChip in the cell').not.toBeNull();
      expect(norm(chip!.textContent).length, 'a word').toBeGreaterThan(0);
      expect(chip!.getAttribute('data-tone')).toBeTruthy();
      expect(chip!.querySelector('svg, .lims-chip-dot'), 'dot or icon').not.toBeNull();
    }
  });

  it('every data row has a row menu button; Assigned to, if drawn, never shows invented people', () => {
    const { container } = view();
    for (const r of bodyRows(container)) expect(within(r as HTMLElement).getByRole('button', { name: /row actions|actions/i })).toBeTruthy();
    const heads = headerTexts(container);
    if (heads.some((h) => /^Assigned to$/i.test(h))) {
      for (const c of columnCells(container, /^Assigned to$/i).cells) expect(norm(c.textContent)).toMatch(/^(—|-|)$/);
    }
    expect(container.textContent).not.toMatch(/\b\d+ y, [MF]\b/); // age and sex are not in the contract: not invented
  });

  it('pager with the total: "of 2" under the two recollection rows, and the total follows the tab', async () => {
    const { container } = view();
    const pager = container.querySelector('.lims-pager') as HTMLElement | null;
    expect(pager, 'a pager').not.toBeNull();
    expect(norm(pager!.textContent)).toMatch(/\bof 2\b/);
    await userEvent.click(screen.getByRole('tab', { name: /pre-registered today/i }));
    expect(norm(container.querySelector('.lims-pager')?.textContent)).toMatch(/\bof 1\b/);
  });

  it('the other tabs keep the same columns and their rows (pre-registered, booking cancelled)', async () => {
    const { container } = view();
    await userEvent.click(screen.getByRole('tab', { name: /^Booking cancelled/i }));
    expect(headerTexts(container).slice(0, 6).map(norm)).toEqual(expect.arrayContaining([expect.stringMatching(/^Accession no/i), expect.stringMatching(/^Status$/i)]));
    expect(screen.getByRole('link', { name: 'R-0001-000003' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /pre-registered today/i }));
    expect(screen.getByRole('link', { name: 'R-0001-000004' })).toBeTruthy();
    expect(norm(columnCells(container, /^Status$/i).cells[0]!.textContent).length).toBeGreaterThan(0);
  });

  it('empty tab: the header row is drawn, the EmptyState sits in the table body, the count pill says 0', () => {
    const { container } = view({ flags: [] });
    expect(headerTexts(container).slice(0, 6).length).toBe(6);
    const st = container.querySelector('.lims-state')!;
    expect(st.closest('tbody, [role="rowgroup"]')).not.toBeNull();
    expect(norm(screen.getAllByRole('tab')[0]!.querySelector('.lims-tab-badge')?.textContent)).toBe('0');
  });

  it('failed list: the header row stays, the ErrorState with Retry is in the table body', () => {
    const { container } = view({ failed: ['flags'], flags: [] });
    expect(headerTexts(container).slice(0, 6).length).toBe(6);
    const err = container.querySelector('.lims-state.lims-tone-danger')!;
    expect(err.closest('tbody, [role="rowgroup"]')).not.toBeNull();
    expect([...err.querySelectorAll('button')].map((b) => b.textContent)).toContain('Retry');
  });
});

// page level (msw): the server page feeds the same screen; header names are the same on empty, failed and not-built states
const api = setupServer();
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => api.resetHandlers());
afterAll(() => api.close());
const serve = (o: { flags?: () => Response; orders?: () => Response } = {}) => api.use(
  http.get(`${ORIGIN}/v1/frontdesk/order-flags`, o.flags ?? (() => page([]))),
  http.get(`${ORIGIN}/v1/frontdesk/orders`, o.orders ?? (() => page([]))),
  http.get(`${ORIGIN}/v1/frontdesk/patients/possible-duplicates`, () => page([])),
  http.all(`${ORIGIN}/v1/*`, () => page([])),
);
const show = async (): Promise<ReactNode> => {
  const mod = await import(/* @vite-ignore */ '../../../app/(staff)/frontdesk/worklist/page.tsx');
  return (mod.default as (p: never) => Promise<ReactNode>)(props);
};

describe(`${W} page`, () => {
  it('no rows: the menu label is the h1 and the mock header row is drawn over the EmptyState', async () => {
    serve();
    vi.useRealTimers();
    const { container } = render(<ToastProvider>{await show()}</ToastProvider>);
    await screen.findByText(/nothing pending/i);
    expect([...container.querySelectorAll('h1')].map((h) => norm(h.textContent))).toEqual([menuLabel(W)]);
    COLS.forEach((re, i) => expect(headerTexts(container)[i], `column ${i + 1}`).toMatch(re));
  });

  it('flags API 501 operation_pending: NotAvailable keeps the title and the SAME header row as the live table', async () => {
    serve({ flags: () => problem(501, 'operation_pending') });
    vi.useRealTimers();
    const { container } = render(<ToastProvider>{await show()}</ToastProvider>);
    expect(norm(container.textContent)).toMatch(/not available yet/i);
    COLS.forEach((re, i) => expect(headerTexts(container)[i], `column ${i + 1}`).toMatch(re));
  });

  it('flags API 500: the title and the header row stay with an ErrorState and Retry in the body (not the error page)', async () => {
    serve({ flags: () => problem(500, 'common.internal') });
    vi.useRealTimers();
    const { container } = render(<ToastProvider>{await show()}</ToastProvider>);
    COLS.forEach((re, i) => expect(headerTexts(container)[i], `column ${i + 1}`).toMatch(re));
    expect(container.querySelector('.lims-state.lims-tone-danger')).not.toBeNull();
  });
});
