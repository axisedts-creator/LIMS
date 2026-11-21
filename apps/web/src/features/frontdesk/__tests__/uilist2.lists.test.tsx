// @vitest-environment jsdom
// T0D-UILIST-2 (LD-353 template 1 LIST, rules 3, 5, 6, 8; done_when 6 and 7) — front desk: /frontdesk/worklist and /frontdesk/discount-approvals.
// Pinned: PageHeader title = menu label; header row inside the scroll box also when empty with ONE EmptyState in the body; the two screens show the SAME empty table look (same structure, same
// four inert placeholder rows, same one hint line); a failed list keeps the title and the header row and shows an ErrorState in the table body (no banner instead of the table); 501 operation_pending
// = NotAvailable; discount approvals: Gross and Discount (NPR) right aligned with two decimals. Not pinned (notes): MFA banner (unchanged), /frontdesk/settings (T0D-PRINTCFG-1).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectEmptyState, expectErrorState, expectHeader, expectMoneyColumn, expectNotAvailable, expectTable, menuLabel, page, problem, props, U, npr } from '@/__tests__/uilist2.helpers';

const ORIGIN = 'http://api.test';
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
  getShellSession: async () => ({ actor: { permissions: ['frontdesk.registration.create', 'frontdesk.order.edit', 'frontdesk.discount.approve', 'frontdesk.patient.read'], displayName: 'Synthetic Receptionist', membershipId: '01a1a98a-ac40-7000-8000-000000000090', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/frontdesk/worklist',
}));

const W = '/frontdesk/worklist', D = '/frontdesk/discount-approvals';
const flag = { id: U(20), order_id: U(1), kind: 'recollection_required', status: 'open', created_at: '2026-11-07T04:00:00.000Z', version: 1 };
const order = { id: U(1), registration_no: 'R-2083-000001', patient_id: U(2), patient_display: 'Synthetic Patient One', centre_id: U(3), status: 'registered', billing_mode: 'cash', source: 'walk_in', registered_at: '2026-11-07T04:00:00.000Z', item_count: 3, has_open_flag: true, version: 1 };
const approval = { id: U(30), status: 'pending', centre_id: U(3), patient_code: 'P-000123', requested_by: { membership_id: U(91), display_name: 'Synthetic Receptionist' }, discounts: [{ scope: 'bill', kind: 'percent', percent_bp: 3000, reason_code: 'staff_relative' }], computed_discount: npr(45000), gross: npr(150000), percent_of_gross_bp: 3000, reason_code: 'staff_relative', expires_at: '2099-11-07T04:15:00.000Z', version: 7 };

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());
const serveWork = (o: { flags?: () => Response; orders?: () => Response } = {}) => api.use(
  http.get(`${ORIGIN}/v1/frontdesk/order-flags`, o.flags ?? (() => page([]))),
  http.get(`${ORIGIN}/v1/frontdesk/orders`, o.orders ?? (() => page([]))),
  http.get(`${ORIGIN}/v1/frontdesk/patients/possible-duplicates`, () => page([])),
  http.all(`${ORIGIN}/v1/*`, () => page([])),
);
const serveDisc = (list: () => Response) => api.use(http.get(`${ORIGIN}/v1/frontdesk/discount-approvals`, list), http.all(`${ORIGIN}/v1/*`, () => page([])));
async function show(file: string) {
  const mod = await import(/* @vite-ignore */ `../../../app/(staff)/frontdesk/${file}.tsx`);
  const tree = await (mod.default as (p: never) => Promise<never>)(props).catch((e: unknown) => { throw new Error(`the page threw to the error page instead of keeping its title with an ErrorState: ${String(e)}`); });
  return render(<ToastProvider>{tree}</ToastProvider>);
}
/** The structure of the empty table: scroll box, table classes, header cell classes, state children, placeholder rows, hint lines, buttons. Text is not part of it. */
function look(root: ParentNode) {
  const table = root.querySelector('table')!;
  const state = root.querySelector('.lims-state')!;
  return {
    box: table.closest('.lims-table-scroll')?.className,
    table: table.className.replace(/\s+/g, ' ').trim(),
    th: [...table.querySelectorAll('thead th, [role="columnheader"]')].map((h) => h.className.replace(/\s*lims-align-\w+|\s*lims-num/g, '').trim()).filter((v, i, a) => a.indexOf(v) === i),
    placeholders: root.querySelectorAll('.lims-row-placeholder').length,
    state: [...state.children].map((c) => `${c.tagName}.${c.className}`),
    inBody: !!state.closest('tbody, [role="rowgroup"]'),
  };
}

describe(W, () => {
  it('no rows: menu title, header row in the scroll box, one EmptyState in the body', async () => {
    serveWork();
    const { container } = await show('worklist/page');
    await screen.findByText(/nothing pending/i);
    expectHeader(container, W);
    // re-pinned by T0D-UIDASH-2 (LD-436 worklist mock): Accession no., Patient, Tests, Registered, Time elapsed, Status, then the row menu column
    expectTable(container, W, { min: 4, headers: ['Accession no.', 'Patient', 'Tests', 'Registered', 'Time elapsed', 'Status', 'Actions'] });
    expectEmptyState(container, W);
  });

  it('one open flag: the row sits under the header, no EmptyState', async () => {
    serveWork({ flags: () => page([flag]), orders: () => page([order]) });
    const { container } = await show('worklist/page');
    await screen.findByText('R-2083-000001');
    expectHeader(container, W);
    expectTable(container, W, { min: 4 });
    expect(container.querySelectorAll('.lims-state').length).toBe(0);
  });

  it('flag list failed (500): the title and the header row stay, the ErrorState sits in the table body with Retry; no banner instead of the table', async () => {
    serveWork({ flags: () => problem(500, 'common.internal') });
    const { container } = await show('worklist/page');
    expect([...container.querySelectorAll('h1')].map((h) => h.textContent)).toEqual([menuLabel(W)]);
    expectTable(container, W, { min: 4 });
    const err = container.querySelector('.lims-state.lims-tone-danger');
    expect(err, 'ErrorState drawn').not.toBeNull();
    expect(err!.closest('tbody, [role="rowgroup"]'), 'ErrorState in the table body').not.toBeNull();
    expect([...err!.querySelectorAll('button')].map((b) => b.textContent)).toContain('Retry');
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });

  it('flag list 501 operation_pending: NotAvailable keeps the title and the header row', async () => {
    serveWork({ flags: () => problem(501, 'operation_pending') });
    const { container } = await show('worklist/page');
    expectNotAvailable(container, W, { table: true });
  });
});

describe(D, () => {
  it('no rows: menu title, header row in the scroll box, one EmptyState in the body', async () => {
    serveDisc(() => page([]));
    const { container } = await show('discount-approvals/page');
    await screen.findByText(/no pending approvals/i);
    expectHeader(container, D);
    expectTable(container, D, { min: 8, headers: ['Requested', 'Centre', 'Requested by', /^Gross\b/i, 'Reason', 'Status', 'Actions'] });
    expectEmptyState(container, D);
  });

  it('one approval: Gross and Discount (NPR) right aligned, NPR in the header, two decimals', async () => {
    serveDisc(() => page([approval]));
    const { container } = await show('discount-approvals/page');
    await screen.findByText('Synthetic Receptionist');
    expectHeader(container, D);
    expectMoneyColumn(container, D, /^Gross\b/i);
    expectMoneyColumn(container, D, /^Discount\b.*\bNPR\b/i);
    expect(container.querySelectorAll('.lims-state').length).toBe(0);
  });

  it('API 500: the title stays, ErrorState with reference and Retry (not the error page)', async () => {
    serveDisc(() => problem(500, 'common.internal'));
    const { container } = await show('discount-approvals/page');
    expectErrorState(container, D);
    expectTable(container, D, { min: 8 });
  });

  it('API 501 operation_pending: NotAvailable keeps the title and the header row', async () => {
    serveDisc(() => problem(501, 'operation_pending'));
    const { container } = await show('discount-approvals/page');
    expectNotAvailable(container, D, { table: true });
  });
});

describe('same empty table look', () => {
  it('worklist and discount approvals draw the empty table with the same structure', async () => {
    serveWork();
    const a = await show('worklist/page');
    await screen.findByText(/nothing pending/i);
    const w = look(a.container);
    a.unmount();
    serveDisc(() => page([]));
    const b = await show('discount-approvals/page');
    await screen.findByText(/no pending approvals/i);
    const d = look(b.container);
    expect(w.inBody && d.inBody, 'both put the EmptyState in the table body').toBe(true);
    expect(w.placeholders, 'the same inert placeholder rows').toBe(d.placeholders);
    expect(w.placeholders).toBeGreaterThan(0);
    expect(w.box).toBe(d.box);
    expect(w.table).toBe(d.table);
    expect(w.state, 'EmptyState children: title, the same hint lines').toEqual(d.state);
    // T0D-UIDASH-2: the worklist now also draws the two kit columns of the mock (StatusChip column, row menu column); the data header cells are drawn the same way
    expect(w.th.filter((c) => c !== 'lims-col lims-col-status' && c !== 'lims-col-actions'), 'header cells drawn the same way').toEqual(d.th);
  });
});
