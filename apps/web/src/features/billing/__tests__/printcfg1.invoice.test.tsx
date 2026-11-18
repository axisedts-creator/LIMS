// @vitest-environment jsdom
// T0D-PRINTCFG-1 done_when (4): the invoice print dialog of InvoiceDetailView({invoice, prints, creditNotes, permissions}). ASSUMED contract (dispute if wrong):
//   The Print button always opens a dialog "Print invoice" (the first print too; nothing is sent before the dialog's Print button). Radios "Full bill" (default) and
//   "Plain black and white bill". The choice is remembered per browser (localStorage; only a valid style is ever read back, anything else reads Full bill).
//   First print: POST printInvoice { reason_code: 'first_print', style }. Reprint (print_count >= 1): the reason select stays (c.f. bl-t20), the dialog shows
//   "First printed as <Full bill | Plain black and white bill>" (from prints[0].style, rows without style read Full bill), that style is selected and the radios are locked (a
//   tax bill keeps its first style), and the POST carries that style. Print history table gets a "Style" column in plain words.
//   Plain black and white print: the printed document (hidden iframe of the kit PrintFrame) has no logo image and no phone line; it keeps lab name, address, seller PAN,
//   bill number and date. Full bill keeps the logo and phones.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { API, ORIGIN, PC, api, choose, frameSpy, prob } from '../../reporting/__tests__/printcfg1.harness';

const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const INV = U(1), CENTRE = U(3), ORDER = U(5);
const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const FINANCE = ['billing.invoice.read', 'billing.invoice.reprint'];
const summary = (o: Record<string, unknown> = {}) => ({ id: INV, invoice_no: 'INV/2083-84/000042', invoice_seq: 42, fiscal_year_bs: '2083/84', invoice_kind: 'tax', status: 'issued', issued_at: '2026-11-07T04:00:00.000Z', invoice_date_bs: '2083-07-21', centre_id: CENTRE, order_id: ORDER, buyer_name: 'Synthetic Buyer', net: npr(113000), cbms_state: 'not_required', ...o });
const line = { id: U(10), line_no: 1, line_kind: 'test', code: 'CBC', name: 'Complete blood count', quantity: 1, unit_price: npr(100000), gross: npr(100000), discount: npr(0), exempt: npr(0), taxable: npr(100000), vat: npr(13000), other_tax: npr(0), net: npr(113000), credited: npr(0) };
const detail = (o: Record<string, unknown> = {}) => ({
  ...summary(), series: 'INV', is_active: true, branch_id: U(6), is_periodic_credit_bill: false, buyer: { name: 'Synthetic Buyer', pan: '123456789', address: 'Synthetic Road' },
  seller: { name: 'Synthetic Lab Pvt Ltd', pan: '987654321', address: 'Synthetic Marg' }, lines: [line], totals: { gross: npr(100000), discount: npr(0), exempt: npr(0), taxable: npr(100000), vat: npr(13000), other_tax: npr(0), net: npr(113000) },
  credited_total: npr(0), print_count: 0, cbms_state: 'not_required', version: 3, cbms_submissions: [], ...o,
});
const printDoc = (o: Record<string, unknown> = {}) => ({
  ...detail(), branding: { legal_name: 'Synthetic Lab Pvt Ltd', address_lines: ['Synthetic Marg'], phones: ['01-5550000'], images: [{ kind: 'logo', data_uri: 'data:image/png;base64,iVBORw0KGgo=' }] },
  dates: { bs: '2083-07-21', ad: '07/11/2026' }, payment_block: { paid: npr(113000), balance_due: npr(0) }, print_no: 1, ...o,
});
const row = (o: Record<string, unknown> = {}) => ({ print_no: 1, is_copy: false, reason_code: 'first_print', printed_by_display: 'Synthetic Cashier', printed_at: '2026-11-07T04:05:00.000Z', ...o });

const posts: { json: any; headers: Headers }[] = [];
let printFail = false;
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  API.reset(); posts.length = 0; printFail = false; localStorage.clear(); PC.session.permissions = FINANCE;
  api.use(http.post(`${ORIGIN}/v1/billing/invoices/:id/print`, async ({ request }) => {
    const json = await request.json() as any;
    posts.push({ json, headers: request.headers });
    if (printFail) return prob(500, 'common.internal');
    return HttpResponse.json({ print_no: 1, style: json.style ?? 'full', document: printDoc() });
  }));
});
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function open(inv = detail(), prints: unknown[] = [], perms = FINANCE) {
  const { InvoiceDetailView } = await import('../components/InvoiceDetailView');
  const u = userEvent.setup();
  render(<ToastProvider><InvoiceDetailView invoice={inv as never} prints={prints as never} creditNotes={[]} permissions={perms} /></ToastProvider>);
  await u.click(screen.getByRole('button', { name: /^print/i }));
  return { u, dlg: await screen.findByRole('dialog') };
}
const radio = (d: HTMLElement, re: RegExp) => within(d).getByRole('radio', { name: re }) as HTMLInputElement;
const FULL = /full bill/i, PLAIN = /plain black and white bill/i;
const confirm = (d: HTMLElement) => within(d).getByRole('button', { name: /^print$/i });

describe('first print (done_when 4)', () => {
  it('Print opens a dialog; nothing is sent until its Print button; Full bill is the default', async () => {
    const { dlg } = await open();
    expect(within(dlg).getAllByRole('radio').length).toBe(2);
    expect(radio(dlg, FULL).checked).toBe(true);
    expect(radio(dlg, PLAIN).checked).toBe(false);
    expect(posts.length).toBe(0);
  });

  it('Full bill sends { reason_code: first_print, style: full } with an Idempotency-Key', async () => {
    const { u, dlg } = await open();
    await u.click(confirm(dlg));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]!.json).toEqual({ reason_code: 'first_print', style: 'full' });
    expect(posts[0]!.headers.get('idempotency-key')?.length).toBeGreaterThan(8);
  });

  it('Plain black and white bill sends style plain_bw', async () => {
    const { u, dlg } = await open();
    await u.click(radio(dlg, PLAIN));
    await u.click(confirm(dlg));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]!.json).toEqual({ reason_code: 'first_print', style: 'plain_bw' });
  });

  it('the last choice is remembered per browser: a later dialog (another invoice) opens on it', async () => {
    const a = await open();
    await a.u.click(radio(a.dlg, PLAIN));
    await a.u.click(confirm(a.dlg));
    await waitFor(() => expect(posts.length).toBe(1));
    cleanup();
    const b = await open(detail({ id: U(2), invoice_no: 'INV/2083-84/000043' }));
    expect(radio(b.dlg, PLAIN).checked).toBe(true);
  });

  it('a stored value that is not a known style reads Full bill (storage is untrusted)', async () => {
    for (const junk of ['evil', '{"style":"x"}', '<script>', 'plain_bw ']) {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(junk); // whatever key the screen reads answers junk
      const { dlg } = await open();
      expect(radio(dlg, FULL).checked).toBe(true);
      cleanup();
      spy.mockRestore();
    }
  });

  it('a failed print keeps the dialog open and shows the error (no print frame)', async () => {
    printFail = true;
    const { u, dlg } = await open();
    await u.click(confirm(dlg));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(await screen.findByText(/could not print the invoice/i)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a user without the reprint permission sees no Print button', async () => {
    const { InvoiceDetailView } = await import('../components/InvoiceDetailView');
    render(<ToastProvider><InvoiceDetailView invoice={detail() as never} prints={[]} creditNotes={[]} permissions={['billing.invoice.read']} /></ToastProvider>);
    expect(screen.queryByRole('button', { name: /^print/i })).toBeNull();
  });
});

describe('reprint (done_when 4)', () => {
  it('shows the style the bill was first printed in, selects it and locks the choice; the reason select stays', async () => {
    localStorage.clear();
    const { dlg } = await open(detail({ print_count: 1 }), [row({ style: 'plain_bw' })]);
    expect(within(dlg).getByText(/first printed as/i).textContent).toMatch(/plain black and white/i);
    expect(radio(dlg, PLAIN).checked).toBe(true);
    expect(radio(dlg, FULL).disabled).toBe(true);
    expect(radio(dlg, PLAIN).disabled).toBe(true);
    expect(within(dlg).getByRole('button', { name: /reason/i })).toBeTruthy();
    expect(posts.length).toBe(0);
  });

  it('the first style wins over a remembered choice, and the POST carries reason and that style', async () => {
    const first = await open();
    await first.u.click(radio(first.dlg, PLAIN)); // remember Plain
    await first.u.click(confirm(first.dlg));
    await waitFor(() => expect(posts.length).toBe(1));
    cleanup();
    const { u, dlg } = await open(detail({ print_count: 1 }), [row({ style: 'full' })]);
    expect(within(dlg).getByText(/first printed as/i).textContent).toMatch(/full bill/i);
    expect(radio(dlg, FULL).checked).toBe(true);
    await choose(u, /reason/i, /printer fault/i);
    await u.click(confirm(dlg));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[1]!.json).toEqual({ reason_code: 'printer_fault', style: 'full' });
  });

  it('old print rows without a style read Full bill', async () => {
    const { dlg } = await open(detail({ print_count: 2 }), [row({ print_no: 2, is_copy: true, reason_code: 'reprint' }), row()]);
    expect(within(dlg).getByText(/first printed as/i).textContent).toMatch(/full bill/i);
  });

  it('print history has a Style column in plain words', async () => {
    const { InvoiceDetailView } = await import('../components/InvoiceDetailView');
    render(<ToastProvider><InvoiceDetailView invoice={detail({ print_count: 2 }) as never} prints={[row({ print_no: 2, is_copy: true, reason_code: 'reprint', style: 'full' }), row({ style: 'plain_bw' })] as never} creditNotes={[]} permissions={FINANCE} /></ToastProvider>);
    const table = screen.getByRole('table', { name: /print history/i });
    expect(within(table).getByRole('columnheader', { name: /style/i })).toBeTruthy();
    expect(within(table).getByText(/plain black and white/i)).toBeTruthy();
    expect(within(table).getByText(/^full bill$/i)).toBeTruthy();
  });
});

describe('what is printed (done_when 4)', () => {
  it('Plain black and white: no logo, no phone line; keeps lab name, address, seller PAN, bill number and date', async () => {
    const spy = frameSpy();
    try {
      const { u, dlg } = await open();
      await u.click(radio(dlg, PLAIN));
      await u.click(confirm(dlg));
      await waitFor(() => expect(spy.seen.some((h) => h.includes('000042'))).toBe(true), { timeout: 4000 });
      const html = spy.seen.find((h) => h.includes('000042'))!;
      expect(html).not.toMatch(/<img/i);
      expect(html).not.toContain('01-5550000');
      for (const must of ['Synthetic Lab Pvt Ltd', 'Synthetic Marg', '987654321', 'INV/2083-84/000042', '2083-07-21']) expect(html).toContain(must);
    } finally { spy.stop(); }
  });

  it('Full bill keeps the logo and the phone line', async () => {
    const spy = frameSpy();
    try {
      const { u, dlg } = await open();
      await u.click(confirm(dlg));
      await waitFor(() => expect(spy.seen.some((h) => h.includes('000042'))).toBe(true), { timeout: 4000 });
      const html = spy.seen.find((h) => h.includes('000042'))!;
      expect(html).toMatch(/<img/i);
      expect(html).toContain('01-5550000');
    } finally { spy.stop(); }
  });
});
