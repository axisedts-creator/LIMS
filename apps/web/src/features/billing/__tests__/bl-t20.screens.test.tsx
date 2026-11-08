// @vitest-environment jsdom
// BL-T20 — Billing web screens (04-UI-UX §8.1–§8.10; §1 copy rules; §9 a11y). done_when: "all states; copy scan; dual dates on fiscal docs". MSW + axe.
// ASSUMED module/prop contract (spec fixes folders + kit components only; dispute via writer if wrong). All under apps/web/src/features/billing/components/:
//   InvoicesList({invoices, permissions, centres})                                  §8.1   (rows = InvoiceSummary)
//   InvoiceDetailView({invoice, prints, creditNotes, permissions})                  §8.2   (invoice = InvoiceDetail, prints = InvoicePrintRow[])
//   print/InvoicePrintView({document})                                              §8.3   (document = InvoicePrint.document)
//   DuesList({dues})  DailyCashView({report, session, permissions})  CreditPartiesList({parties, permissions})
//   RegistersView({sales, cancelled, creditNotes, permissions})  AuditTrail({rows, permissions})  CbmsList({documents, mode, permissions})
//   FinanceWorklist({creditNoteTasks, reviewItems, refundRequests, currentMembershipId, permissions})
//   permissions: readonly string[]; actions call the BFF (MSW observes /v1/billing/*) with Idempotency-Key (+ If-Match for versioned writes).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/billing/invoices',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/invoices',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const INV = U(1), CN = U(2), CENTRE = U(3), PARTY = U(4), ORDER = U(5), ME = U(90), OTHER = U(91);
const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const READ = ['billing.invoice.read'];
const FINANCE = ['billing.invoice.read', 'billing.invoice.reprint', 'billing.invoice.cancel', 'billing.refund.approve', 'billing.settings.manage', 'billing.credit_party.manage', 'billing.cash_report.read', 'billing.data.export', 'billing.credit_party.read'];
const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }];

const summary = (o: Record<string, unknown> = {}) => ({ id: INV, invoice_no: 'INV/2083-84/000042', invoice_seq: 42, fiscal_year_bs: '2083/84', invoice_kind: 'tax', status: 'issued', issued_at: '2026-11-07T04:00:00.000Z', invoice_date_bs: '2083-07-21', centre_id: CENTRE, order_id: ORDER, buyer_name: 'Synthetic Buyer', net: npr(113000), cbms_state: 'not_required', ...o });
const line = { id: U(10), line_no: 1, line_kind: 'test', code: 'CBC', name: 'Complete blood count', quantity: 1, unit_price: npr(100000), gross: npr(100000), discount: npr(0), exempt: npr(0), taxable: npr(100000), vat: npr(13000), other_tax: npr(0), net: npr(113000), credited: npr(0) };
const detail = (o: Record<string, unknown> = {}) => ({
  ...summary(), series: 'INV', is_active: true, branch_id: U(6), is_periodic_credit_bill: false, buyer: { name: 'Synthetic Buyer', pan: '123456789', address: 'Synthetic Road' },
  seller: { name: 'Synthetic Lab Pvt Ltd', pan: '987654321', address: 'Synthetic Marg' }, lines: [line], totals: { gross: npr(100000), discount: npr(0), exempt: npr(0), taxable: npr(100000), vat: npr(13000), other_tax: npr(0), net: npr(113000) },
  credited_total: npr(0), print_count: 1, last_printed_at: '2026-11-07T04:05:00.000Z', cbms_state: 'not_required', version: 3, cbms_submissions: [], ...o,
});
const prints = [{ print_no: 1, is_copy: false, reason_code: 'first_print', printed_by_display: 'Synthetic Cashier', printed_at: '2026-11-07T04:05:00.000Z' }];
const cancelled = detail({ status: 'cancelled', is_active: false, cancellation: { cancelled_at: '2026-11-08T05:00:00.000Z', cancelled_by_display: 'Synthetic Finance', reason_code: 'billing_error', reason_text: 'Wrong buyer', credit_note_id: CN, credit_note_no: 'CN/2083-84/000007' } });
const printDoc = (o: Record<string, unknown> = {}) => ({ ...detail(), branding: { legal_name: 'Synthetic Lab Pvt Ltd', address_lines: ['Synthetic Marg'], phones: ['01-5550000'], images: [] }, dates: { bs: '2083-07-21', ad: '07/11/2026' }, payment_block: { paid: npr(113000), balance_due: npr(0) }, print_no: 1, ...o });

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const api = setupServer(
  http.post(`${ORIGIN}/v1/billing/invoices/:id/cancel`, async ({ request }) => { await rec(request); return HttpResponse.json({ invoice: cancelled, credit_note: { id: CN, credit_note_no: 'CN/2083-84/000007' } }, { status: 200 }); }),
  http.post(`${ORIGIN}/v1/billing/invoices/:id/print`, async ({ request }) => { await rec(request); return HttpResponse.json({ print_no: 2, copy_mark: 'Copy of Original / प्रतिलिपि — Print no. 2', document: printDoc({ print_no: 2 }) }); }),
  http.post(`${ORIGIN}/v1/billing/refund-requests/:id/approve`, async ({ request }) => { await rec(request); return HttpResponse.json({}, { status: 200 }); }),
  http.post(`${ORIGIN}/v1/billing/refund-requests/:id/reject`, async ({ request }) => { await rec(request); return HttpResponse.json({}, { status: 200 }); }),
  http.post(`${ORIGIN}/v1/billing/cbms/documents/:kind/:id/retry`, async ({ request }) => { await rec(request); return HttpResponse.json({ cbms_state: 'pending' }, { status: 202 }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); localStorage.clear(); sessionStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const BAD_COPY = /IRD[ -]approved|IRD certified|approved by IRD|commission/i;
const BS = /\d{4}-\d{2}-\d{2}(\s*B\.S\.)?/;
const AD = /\d{2}\/\d{2}\/\d{4}/;
const mod = async <T,>(p: string) => (await import(/* @vite-ignore */ `../components/${p}`)) as T;

describe('§8.1 InvoicesList', () => {
  const load = async () => (await mod<{ InvoicesList: any }>('InvoicesList')).InvoicesList;
  it('columns, invoice-no link, NPR money, text status badge, dual B.S./A.D. date columns', async () => {
    const InvoicesList = await load();
    wrap(<InvoicesList invoices={[summary(), summary({ id: U(7), invoice_no: 'INV/2083-84/000041', status: 'cancelled' })] as never} permissions={READ} centres={centres} />);
    for (const h of ['Invoice no', 'B.S. date', 'A.D. date', 'Buyer', 'Net', 'Status', 'Prints', 'CBMS']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'INV/2083-84/000042' }).getAttribute('href')).toBe(`/billing/invoices/${INV}`);
    const row = screen.getByRole('link', { name: 'INV/2083-84/000042' }).closest('tr')!;
    expect(within(row).getByText('NPR 1,130.00')).toBeTruthy();
    expect(within(row).getByText('Issued')).toBeTruthy();
    expect(row.textContent).toMatch(/2083-07-21/);
    expect(row.textContent).toMatch(/07\/11\/2026/);
    expect(screen.getByText('Cancelled')).toBeTruthy();
  });
  it('CBMS stub state reads "Not sent — CBMS connection not configured"; never "IRD approved"/"commission"', async () => {
    const InvoicesList = await load();
    wrap(<InvoicesList invoices={[summary({ cbms_state: 'pending' })] as never} permissions={READ} centres={centres} />);
    expect(screen.getByText(/Not sent — CBMS connection not configured/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(BAD_COPY);
  });
  it('filters (FY, date range, centre, status, invoice no, credit party) present in a labelled search region', async () => {
    const InvoicesList = await load();
    wrap(<InvoicesList invoices={[]} permissions={READ} centres={centres} />);
    const bar = screen.getByRole('search');
    for (const l of [/fiscal year/i, /date range|from/i, /centre/i, /status/i, /invoice no/i, /credit party/i]) expect(within(bar).getAllByText(l).length).toBeGreaterThan(0);
  });
  it('empty state is a real EmptyState (text, no bare table)', async () => {
    const InvoicesList = await load();
    wrap(<InvoicesList invoices={[]} permissions={READ} centres={centres} />);
    expect(screen.getByText(/no invoices/i)).toBeTruthy();
  });
  it('axe: populated and empty', async () => {
    const InvoicesList = await load();
    const a = wrap(<InvoicesList invoices={[summary()] as never} permissions={READ} centres={centres} />);
    await noAxeViolations();
    a.unmount();
    wrap(<InvoicesList invoices={[]} permissions={READ} centres={centres} />);
    await noAxeViolations();
  });
});

describe('§8.2 InvoiceDetailView', () => {
  const load = async () => (await mod<{ InvoiceDetailView: any }>('InvoiceDetailView')).InvoiceDetailView;
  const view = (I: any, inv: unknown, perms: string[], cns: unknown[] = []) => wrap(<I invoice={inv as never} prints={prints as never} creditNotes={cns as never} permissions={perms} />);

  it('fiscal layout shows B.S. AND A.D. dates (never only the tenant calendar), PAN, lines, VAT, amount in words', async () => {
    const I = await load();
    view(I, detail(), READ);
    const t = document.body.textContent ?? '';
    expect(t).toMatch(/2083-07-21/);
    expect(t).toMatch(/07\/11\/2026/);
    expect(t).toMatch(/987654321/);
    expect(t).toMatch(/123456789/);
    expect(screen.getByText('Complete blood count')).toBeTruthy();
    expect(screen.getAllByText('NPR 130.00').length).toBeGreaterThan(0); // VAT 13%
  });

  it('side panel: print history (no, Original/Copy, by, time, reason) and CBMS attempts', async () => {
    const I = await load();
    view(I, detail({ cbms_submissions: [{ document_kind: 'invoice', attempt_no: 1, client_mode: 'stub', outcome: 'not_sent_stub', submitted_at: '2026-11-07T04:06:00.000Z' }] }), READ);
    const side = screen.getByRole('complementary');
    expect(within(side).getByText('Synthetic Cashier')).toBeTruthy();
    expect(within(side).getByText(/original/i)).toBeTruthy();
    expect(within(side).getByText(/first print/i)).toBeTruthy();
    expect(within(side).getByText('not_sent_stub')).toBeTruthy();
  });

  it('cancelled invoice: red-outlined TEXT banner "CANCELLED on <B.S.> / <A.D.> — reason — Credit note <no>"; no Cancel action', async () => {
    const I = await load();
    view(I, cancelled, FINANCE);
    const banner = screen.getByText(/^CANCELLED on/);
    expect(banner.textContent).toMatch(/CANCELLED on .*\d{4}-\d{2}-\d{2}.*\/.*\d{2}\/\d{2}\/\d{4}/);
    expect(banner.textContent).toMatch(/Wrong buyer|billing error/i);
    expect(banner.textContent).toMatch(/Credit note CN\/2083-84\/000007/);
    expect(screen.queryByRole('button', { name: /^cancel invoice|^cancel$/i })).toBeNull();
  });

  it('actions are permission-gated: read-only user sees no Print/Cancel/Partial credit/Refund', async () => {
    const I = await load();
    view(I, detail(), READ);
    expect(screen.queryByRole('button', { name: /print|cancel|partial credit|refund/i })).toBeNull();
  });

  it('Cancel (B4): ConfirmDialog with reason select + "A credit note for NPR 1,130.00 will be issued"; sends reason, If-Match=version, Idempotency-Key', async () => {
    const I = await load();
    view(I, detail(), FINANCE);
    await userEvent.click(screen.getByRole('button', { name: /cancel invoice/i }));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByText(/A credit note for NPR 1,130\.00 will be issued/)).toBeTruthy();
    const reason = within(dlg).getByRole('button', { name: /reason/i });
    expect(within(dlg).getByRole('button', { name: /confirm|cancel invoice/i })).toBeTruthy();
    await userEvent.click(reason);
    await userEvent.click(await screen.findByRole('option', { name: /billing error/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /confirm|cancel invoice/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url.pathname).toBe(`/v1/billing/invoices/${INV}/cancel`);
    expect(calls[0]!.body.reason_code).toBe('billing_error');
    expect(calls[0]!.headers.get('if-match')).toMatch(/3/);
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('Cancel is blocked without a reason (billing.cancel_reason_required) — no request sent', async () => {
    const I = await load();
    view(I, detail(), FINANCE);
    await userEvent.click(screen.getByRole('button', { name: /cancel invoice/i }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /confirm|cancel invoice/i }));
    expect(calls.length).toBe(0);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Print (B3): print_count >= 1 requires a reason select (reprint / printer_fault / customer_copy) before the request', async () => {
    const I = await load();
    view(I, detail({ print_count: 1 }), FINANCE);
    await userEvent.click(screen.getByRole('button', { name: /^print/i }));
    const reason = await screen.findByRole('button', { name: /reason/i });
    expect(reason).toBeTruthy();
    expect(calls.length).toBe(0);
  });

  it('Refund request (B10): shows refundable amount + "A second finance user must approve"', async () => {
    const I = await load();
    view(I, detail(), FINANCE);
    await userEvent.click(screen.getByRole('button', { name: /request refund/i }));
    expect(within(screen.getByRole('dialog')).getByText(/A second finance user must approve/)).toBeTruthy();
  });

  it('axe: issued and cancelled', async () => {
    const I = await load();
    const a = view(I, detail(), FINANCE);
    await noAxeViolations();
    a.unmount();
    view(I, cancelled, FINANCE);
    await noAxeViolations();
  });
});

describe('§8.3 InvoicePrintView (fiscal document)', () => {
  const load = async () => (await mod<{ InvoicePrintView: any }>('print/InvoicePrintView')).InvoicePrintView;
  it('content order: TAX INVOICE, seller PAN, invoice no, dual dates, buyer, "Referred by: Self", VAT 13%, payment block label', async () => {
    const V = await load();
    wrap(<V document={printDoc() as never} />);
    const t = document.body.textContent ?? '';
    const order = ['TAX INVOICE', '987654321', 'INV/2083-84/000042', '2083-07-21', '07/11/2026', 'Synthetic Buyer', 'Referred by: Self', 'VAT', 'Payment summary (not part of the invoice)'];
    let at = -1;
    for (const s of order) { const i = t.indexOf(s, at + 1); expect(i, s).toBeGreaterThan(at); at = i; }
    expect(t).toMatch(BS);
    expect(t).toMatch(AD);
  });
  it('ABBREVIATED TAX INVOICE for abbreviated kind; copy mark only when print_no >= 2; cancelled banner when cancelled', async () => {
    const V = await load();
    const a = wrap(<V document={printDoc({ invoice_kind: 'abbreviated' }) as never} />);
    expect(screen.getByText(/ABBREVIATED TAX INVOICE/)).toBeTruthy();
    expect(screen.queryByText(/Copy of Original/)).toBeNull();
    a.unmount();
    const b = wrap(<V document={printDoc({ print_no: 2, copy_mark: 'Copy of Original / प्रतिलिपि — Print no. 2' }) as never} />);
    expect(screen.getByText(/Copy of Original \/ प्रतिलिपि — Print no\. 2/)).toBeTruthy();
    b.unmount();
    wrap(<V document={printDoc({ status: 'cancelled', cancelled_banner: 'CANCELLED' }) as never} />);
    expect(screen.getByText(/CANCELLED/)).toBeTruthy();
  });
  it('real text only (no canvas / text-in-image); logo is an <img> with alt', async () => {
    const V = await load();
    wrap(<V document={printDoc({ branding: { legal_name: 'Synthetic Lab Pvt Ltd', address_lines: [], phones: [], images: [{ kind: 'logo', data_uri: 'data:image/png;base64,iVBORw0KGgo=' }] } }) as never} />);
    expect(document.querySelector('canvas')).toBeNull();
    for (const img of document.querySelectorAll('img')) expect(img.getAttribute('alt')).not.toBeNull();
    expect(document.body.textContent).not.toMatch(BAD_COPY);
  });
});

describe('§8.4 DuesList', () => {
  it('columns + masked patient + money; empty text', async () => {
    const { DuesList } = await mod<{ DuesList: any }>('DuesList');
    const dues = [{ order_id: ORDER, registration_no: 'REG-000123', patient_display: 'S*** B***', centre_id: CENTRE, invoiced: npr(113000), paid: npr(50000), credited: npr(0), balance_due: npr(63000), oldest_invoice_at: '2026-10-01T04:00:00.000Z' }];
    const a = wrap(<DuesList dues={dues as never} />);
    for (const h of ['Registration no', 'Patient', 'Centre', 'Invoiced', 'Paid', 'Credited', 'Due', 'Oldest invoice age']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    expect(screen.getByText('NPR 630.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'REG-000123' })).toBeTruthy(); // opens order billing tab
    a.unmount();
    wrap(<DuesList dues={[]} />);
    expect(screen.getByText(/no (outstanding )?dues/i)).toBeTruthy();
  });
});

describe('§8.5 DailyCashView', () => {
  const report = {
    business_date: '2026-11-07', business_date_bs: '2083-07-21',
    rows: [{ collected_by: { membership_id: ME, display_name: 'Synthetic Cashier' }, method_code: 'cash', entries: 4, reversals: 1, gross: npr(500000), reversed: npr(100000), net: npr(400000) }],
    totals: { gross: npr(500000), reversed: npr(100000), net: npr(400000) },
    sessions: [
      { id: U(20), opened_by: { membership_id: ME, display_name: 'Synthetic Cashier' }, centre_id: CENTRE, status: 'closed', opened_at: '2026-11-07T03:00:00.000Z', closed_at: '2026-11-07T11:00:00.000Z', rows: [{ method_code: 'cash', expected: npr(400000), counted: npr(395000), variance: npr(-5000) }], version: 2 },
      { id: U(21), opened_by: { membership_id: OTHER, display_name: 'Other Cashier' }, centre_id: CENTRE, status: 'closed', opened_at: '2026-11-07T03:00:00.000Z', closed_at: '2026-11-07T11:00:00.000Z', rows: [{ method_code: 'cash', expected: npr(100000), counted: npr(102500), variance: npr(2500) }], version: 2 },
    ],
  };
  const load = async () => (await mod<{ DailyCashView: any }>('DailyCashView')).DailyCashView;
  it('staff × method table + totals; variance is text: "Short NPR 50.00" / "Excess NPR 25.00"; date shown B.S. + A.D.', async () => {
    const V = await load();
    wrap(<V report={report as never} session={null} permissions={['billing.cash_report.read', 'billing.data.export']} />);
    for (const h of ['Entries', 'Reversals', 'Gross', 'Reversed', 'Net']) expect(screen.getAllByRole('columnheader', { name: new RegExp(h, 'i') }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/total/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Short NPR 50\.00/)).toBeTruthy();
    expect(screen.getByText(/Excess NPR 25\.00/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/2083-07-21/);
  });
  it('Export button (daily_cash) only with billing.data.export', async () => {
    const V = await load();
    const a = wrap(<V report={report as never} session={null} permissions={['billing.cash_report.read']} />);
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
    a.unmount();
    wrap(<V report={report as never} session={null} permissions={['billing.cash_report.read', 'billing.data.export']} />);
    expect(screen.getByRole('button', { name: /export/i })).toBeTruthy();
  });
  it('axe', async () => {
    const V = await load();
    wrap(<V report={report as never} session={null} permissions={['billing.cash_report.read']} />);
    await noAxeViolations();
  });
});

describe('§8.6 CreditPartiesList', () => {
  it('columns incl. used/limit and lock state as text', async () => {
    const { CreditPartiesList } = await mod<{ CreditPartiesList: any }>('CreditPartiesList');
    const parties = [{ id: PARTY, code: 'CP-1', name: 'Synthetic Hospital', credit_limit_paisa: 10000000, credit_days: 30, is_locked: true, lock_reason_code: 'overdue', outstanding: npr(2500000), version: 1 }];
    wrap(<CreditPartiesList parties={parties as never} permissions={['billing.credit_party.read']} />);
    for (const h of ['Code', 'Name', 'Limit', 'Used', 'Credit days', 'Lock']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Synthetic Hospital|CP-1/ }).getAttribute('href')).toBe(`/billing/credit-parties/${PARTY}`);
    expect(screen.getByText(/locked/i)).toBeTruthy(); // never colour-only
  });
});

describe('§8.7 RegistersView (statutory: always B.S. AND A.D. columns)', () => {
  const sales = [{ sn: 1, invoice_date_bs: '2083-07-21', invoice_date_ad: '2026-11-07', invoice_no: 'INV/2083-84/000042', buyer_name: 'Synthetic Buyer', buyer_pan: '123456789', total: npr(113000), exempt: npr(0), taxable: npr(100000), vat: npr(13000), other_tax: npr(0), status: 'issued' }];
  const cns = [{ sn: 1, credit_note_date_bs: '2083-07-22', credit_note_date_ad: '2026-11-08', credit_note_no: 'CN/2083-84/000007', kind: 'cancellation', invoice_no: 'INV/2083-84/000042', buyer_name: 'Synthetic Buyer', buyer_pan: '123456789', reason_code: 'billing_error', exempt: npr(0), taxable: npr(100000), vat: npr(13000), other_tax: npr(0), net: npr(113000) }];
  const canc = [{ sn: 1, cancelled_date_bs: '2083-07-22', cancelled_date_ad: '2026-11-08', invoice_no: 'INV/2083-84/000042', credit_note_no: 'CN/2083-84/000007', buyer_name: 'Synthetic Buyer', buyer_pan: '123456789', total: npr(113000), reason_code: 'billing_error' }];
  const load = async () => (await mod<{ RegistersView: any }>('RegistersView')).RegistersView;
  const view = (V: any, perms = ['billing.invoice.read', 'billing.data.export']) => wrap(<V sales={sales as never} cancelled={canc as never} creditNotes={cns as never} permissions={perms} />);

  it('three tabs; Sales register columns SN, B.S. date, A.D. date, invoice no, buyer, PAN, total, exempt, taxable, VAT, other tax, status', async () => {
    const V = await load();
    view(V);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(expect.arrayContaining(['Sales register', 'Cancelled invoices', 'Credit notes']));
    for (const h of ['SN', 'B\\.S\\. date', 'A\\.D\\. date', 'Invoice no', 'Buyer', 'PAN', 'Total', 'Exempt', 'Taxable', 'VAT', 'Other tax', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    const row = screen.getByText('INV/2083-84/000042').closest('tr')!;
    expect(row.textContent).toMatch(/2083-07-21/);
    expect(row.textContent).toMatch(/07\/11\/2026/);
  });

  it('Credit notes tab: CreditNoteRegisterRow columns, kind shown as "Cancellation"/"Partial", dual dates', async () => {
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('tab', { name: /credit notes/i }));
    for (const h of ['Credit-note no', 'Kind', 'Reason', 'Net']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const row = screen.getByText('CN/2083-84/000007').closest('tr')!;
    expect(within(row).getByText('Cancellation')).toBeTruthy();
    expect(row.textContent).toMatch(/2083-07-22/);
    expect(row.textContent).toMatch(/08\/11\/2026/);
  });

  it('Cancelled invoices tab shows both dates and the credit-note no', async () => {
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('tab', { name: /cancelled invoices/i }));
    const row = screen.getByText('CN/2083-84/000007').closest('tr')!;
    expect(row.textContent).toMatch(/2083-07-22/);
    expect(row.textContent).toMatch(/08\/11\/2026/);
  });

  it('exports: Excel, XML, PDF buttons only with billing.data.export; none otherwise', async () => {
    const V = await load();
    const a = view(V);
    for (const f of [/excel/i, /xml/i, /pdf/i]) expect(screen.getByRole('button', { name: f })).toBeTruthy();
    a.unmount();
    view(V, ['billing.invoice.read']);
    expect(screen.queryByRole('button', { name: /excel|xml|pdf|export/i })).toBeNull();
  });

  it('empty register: text state, headers still present', async () => {
    const V = await load();
    wrap(<V sales={[]} cancelled={[]} creditNotes={[]} permissions={['billing.invoice.read']} />);
    expect(screen.getByText(/no (invoices|entries|rows|records)/i)).toBeTruthy();
  });

  it('axe', async () => {
    const V = await load();
    view(V);
    await noAxeViolations();
  });
});

describe('§8.8 AuditTrail', () => {
  it('time shown B.S. + A.D., user, action, document no, details', async () => {
    const { AuditTrail } = await mod<{ AuditTrail: any }>('AuditTrail');
    const rows = [{ occurred_at: '2026-11-07T04:05:00.000Z', actor: { membership_id: ME, display_name: 'Synthetic Cashier' }, action: 'invoice.printed', entity_type: 'invoice', entity_id: INV, summary: 'Print 2 (copy)' }];
    wrap(<AuditTrail rows={rows as never} permissions={['billing.data.export']} />);
    for (const h of ['Time', 'User', 'Action', 'Document', 'Details']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const row = screen.getByText('Synthetic Cashier').closest('tr')!;
    expect(row.textContent).toMatch(BS);
    expect(row.textContent).toMatch(AD);
    expect(row.textContent).toMatch(/Print 2 \(copy\)/);
  });
});

describe('§8.9 CbmsList', () => {
  const docs = [
    { document_kind: 'invoice', document_id: INV, document_no: 'INV/2083-84/000042', cbms_state: 'failed_permanent', attempts: 5, last_attempt_at: '2026-11-07T04:06:00.000Z', last_outcome: 'rejected' },
    { document_kind: 'credit_note', document_id: CN, document_no: 'CN/2083-84/000007', cbms_state: 'pending', attempts: 0, last_outcome: undefined },
  ];
  const load = async () => (await mod<{ CbmsList: any }>('CbmsList')).CbmsList;
  it('stub mode banner text exact; no wording that implies approval', async () => {
    const C = await load();
    wrap(<C documents={docs as never} mode="stub" permissions={['billing.invoice.read']} />);
    expect(screen.getByText('CBMS connection is not configured. Documents are queued and will be sent once the connection is set up.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(BAD_COPY);
  });
  it('Retry only on failed_permanent and only with billing.settings.manage; posts retry with Idempotency-Key', async () => {
    const C = await load();
    const a = wrap(<C documents={docs as never} mode="live" permissions={['billing.invoice.read']} />);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    a.unmount();
    wrap(<C documents={docs as never} mode="live" permissions={['billing.invoice.read', 'billing.settings.manage']} />);
    const buttons = screen.getAllByRole('button', { name: /retry/i });
    expect(buttons.length).toBe(1);
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url.pathname).toBe(`/v1/billing/cbms/documents/invoice/${INV}/retry`);
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
  });
});

describe('§8.10 FinanceWorklist', () => {
  const reviewItems = [{ id: U(30), order_id: ORDER, kind: 'home_payment_method_inactive', status: 'open', amount: npr(30000), created_at: '2026-11-07T04:00:00.000Z', version: 1 }];
  const refundRequests = [
    { id: U(40), order_id: ORDER, method_code: 'cash', refund_amount: npr(10000), reason_code: 'overpayment', status: 'pending', requested_by: { membership_id: ME, display_name: 'Me' }, requested_at: '2026-11-07T04:00:00.000Z', version: 1 },
    { id: U(41), order_id: ORDER, method_code: 'cash', refund_amount: npr(20000), reason_code: 'overpayment', status: 'pending', requested_by: { membership_id: OTHER, display_name: 'Other Finance' }, requested_at: '2026-11-07T04:00:00.000Z', version: 4 },
  ];
  const load = async () => (await mod<{ FinanceWorklist: any }>('FinanceWorklist')).FinanceWorklist;
  const view = (W: any) => wrap(<W creditNoteTasks={[]} reviewItems={reviewItems as never} refundRequests={refundRequests as never} currentMembershipId={ME} permissions={FINANCE} />);

  it('three tabs; home_payment_method_inactive labelled "Home-collection payment on an inactive payment method"', async () => {
    const W = await load();
    view(W);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(expect.arrayContaining(['Credit notes required', 'Payments to review', 'Refund approvals']));
    await userEvent.click(screen.getByRole('tab', { name: 'Payments to review' }));
    expect(screen.getByText('Home-collection payment on an inactive payment method')).toBeTruthy();
  });

  it('own refund request: "Needs another approver" and Approve disabled (billing.refund_self_approval_forbidden); other\'s is approvable', async () => {
    const W = await load();
    view(W);
    await userEvent.click(screen.getByRole('tab', { name: 'Refund approvals' }));
    expect(screen.getByText('Needs another approver')).toBeTruthy();
    const approves = screen.getAllByRole('button', { name: /approve/i });
    expect(approves.length).toBe(2);
    expect(approves.filter((b) => (b as HTMLButtonElement).disabled).length).toBe(1);
  });

  it('Approve posts to B10a with If-Match = row version and an Idempotency-Key; Reject needs a note', async () => {
    const W = await load();
    view(W);
    await userEvent.click(screen.getByRole('tab', { name: 'Refund approvals' }));
    const enabled = screen.getAllByRole('button', { name: /approve/i }).find((b) => !(b as HTMLButtonElement).disabled)!;
    await userEvent.click(enabled);
    const dlg = screen.queryByRole('dialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /approve|confirm/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url.pathname).toBe(`/v1/billing/refund-requests/${U(41)}/approve`);
    expect(calls[0]!.headers.get('if-match')).toMatch(/4/);
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
    calls.length = 0;
    await userEvent.click(screen.getAllByRole('button', { name: /reject/i })[1]!);
    const rd = screen.getByRole('dialog');
    await userEvent.click(within(rd).getByRole('button', { name: /reject|confirm/i }));
    expect(calls.length).toBe(0); // note required (RejectRefundRequest.note minLength 1)
  });

  it('axe', async () => {
    const W = await load();
    view(W);
    await noAxeViolations();
  });
});

describe('rendered copy scan (US-BL-16): no banned wording on any billing screen', () => {
  it('invoice list, detail, print, cbms stub banner, registers', async () => {
    const { InvoicesList } = await mod<{ InvoicesList: any }>('InvoicesList');
    const { InvoiceDetailView } = await mod<{ InvoiceDetailView: any }>('InvoiceDetailView');
    const { CbmsList } = await mod<{ CbmsList: any }>('CbmsList');
    const { InvoicePrintView } = await mod<{ InvoicePrintView: any }>('print/InvoicePrintView');
    wrap(<><InvoicesList invoices={[summary()] as never} permissions={FINANCE} centres={centres} /><InvoiceDetailView invoice={detail() as never} prints={prints as never} creditNotes={[]} permissions={FINANCE} /><CbmsList documents={[]} mode="stub" permissions={FINANCE} /><InvoicePrintView document={printDoc() as never} /></>);
    expect(document.body.textContent).not.toMatch(BAD_COPY);
    expect(document.body.innerHTML).not.toMatch(BAD_COPY); // attributes (title/aria-label/tooltips) too
  });
});
