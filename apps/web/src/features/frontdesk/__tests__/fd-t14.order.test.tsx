// @vitest-environment jsdom
// FD-T14 — Order page (04-UI-UX §4; 03-APP-FLOW §4 states). ACs: US-FD-10.1-.3 (edit items), US-FD-11.1-.4 (cancel), PRD US-FD-09.2 (scan states on the Attachments tab).
// ASSUMED module/prop contract (spec fixes folders + kit components only; dispute via writer if wrong). Under apps/web/src/features/frontdesk/components/:
//   OrderView({order, billing, permissions, cancelReasons, removalReasons, catalogOptions})
//     order = OrderDto; billing = OrderBillingDto | null (null → no Billing tab); permissions: readonly string[];
//     cancelReasons / removalReasons = coded sets [{code, display, sort_order}] (F25); catalogOptions = [{id, code, name}] orderables the "Add tests" dialog offers.
//   Actions hit the BFF (MSW observes /v1/frontdesk/*) with Idempotency-Key and If-Match = `"<order.version>"` on versioned writes (OpenAPI IfMatch pattern ^"[1-9][0-9]*"$).
// Removed/cancelled lines are NOT removable (status text "Removed"/"Cancelled"). No `removable` flag exists in OrderDto, so the LabPort refusal (US-FD-10.3) arrives as 409.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, ORDER, ITEM_CBC, ITEM_LIPID, ITEM_TSH, U, RECEPTION, READ_ONLY, PERM, ME, attachment, billing, cancelReasons, order, removalReasons, npr } from './fd-t14.fixtures';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => `/frontdesk/orders/${ORDER}`,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Reception', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => `/frontdesk/orders/${ORDER}`,
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const catalogOptions = [{ id: U(103), code: 'TSH', name: 'Thyroid stimulating hormone' }];
const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string) => HttpResponse.json({ type: 'about:blank', title: code, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });
const api = setupServer(
  http.post(`${ORIGIN}/v1/frontdesk/orders/:id/cancel`, async ({ request }) => { await rec(request); return HttpResponse.json(order({ status: 'cancelled', requires_credit_note: true, cancel_reason_code: 'patient_left', version: 6 })); }),
  http.post(`${ORIGIN}/v1/frontdesk/orders/:id/items-changes/quote`, async ({ request }) => { await rec(request); return HttpResponse.json({ lines: [{ line_ref: 'a', orderable_kind: 'test', code: 'TSH', name: 'Thyroid stimulating hormone', priority: 'routine', kind: 'orderable', price_source: 'list', price_list_version: 1 }], totals: { gross: npr(45000), discount: npr(0), exempt: npr(0), taxable: npr(45000), vat: npr(5850), other_tax: npr(0), net: npr(50850) }, discount_evaluation: { within_limit: true, approval_required: false, limit_percent_bp: 1000, limit_paisa: 0 }, catalog_revision: 9, quote_fingerprint: 'fp-add-tsh', base_fingerprint: 'fp-base', fiscal_year_bs: '2083/84' }); }),
  http.post(`${ORIGIN}/v1/frontdesk/orders/:id/items-changes`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...order({ version: 6 }), credit_note_required: false }); }),
  http.post(`${ORIGIN}/v1/frontdesk/orders/:id/confirm`, async ({ request }) => { await rec(request); return HttpResponse.json(order({ status: 'registered', version: 6 })); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const mod = async <T,>(p: string) => (await import(/* @vite-ignore */ `../components/${p}`)) as T;
const load = async () => (await mod<{ OrderView: any }>('OrderView')).OrderView;
const view = (V: any, o: unknown = order(), perms: readonly string[] = RECEPTION, b: unknown = billing()) =>
  wrap(<V order={o as never} billing={b as never} permissions={perms} cancelReasons={cancelReasons} removalReasons={removalReasons} catalogOptions={catalogOptions} />);
const pickReason = async (dlg: HTMLElement, name: RegExp) => {
  await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
  await userEvent.click(await screen.findByRole('option', { name }));
};

describe('§4 header + Items tab', () => {
  it('header: registration no, status as text, patient code/name/sex/age, centre-visible fields, billing mode, flags chips', async () => {
    const V = await load();
    view(V, order({ flags: [{ id: U(20), order_id: ORDER, kind: 'recollection_required', status: 'open', created_at: '2026-11-07T04:00:00.000Z', version: 1 }] }));
    const t = document.body.textContent ?? '';
    expect(screen.getAllByText('R-0001-000001').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Registered$/).length).toBeGreaterThan(0);
    expect(t).toMatch(/P-000001/);
    expect(t).toMatch(/Demo Patient A/);
    expect(t).toMatch(/34 y/);
    expect(t).toMatch(/cash/i);
    expect(t).toMatch(/OPD/i);
    expect(t).toMatch(/recollection/i);
  });

  it('Items tab: code, name, priority, status, price (NPR) per line', async () => {
    const V = await load();
    view(V);
    for (const h of ['Code', 'Name', 'Priority', 'Status', 'Price']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const row = screen.getByText('Lipid profile').closest('tr')!;
    expect(within(row).getByText('LIPID')).toBeTruthy();
    expect(within(row).getByText('NPR 900.00')).toBeTruthy();
  });

  it('tabs are Items / Billing / Attachments (no History tab — review C4 #26)', async () => {
    const V = await load();
    view(V);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Items', 'Billing', 'Attachments']);
  });

  it('without billing data (no billing.invoice.read) the Billing tab is absent', async () => {
    const V = await load();
    view(V, order(), [PERM.orderRead], null);
    expect(screen.queryByRole('tab', { name: 'Billing' })).toBeNull();
  });
});

describe('US-FD-10 edit order items', () => {
  it('10.1 add TSH: mini quote (F8b) with the chosen orderable → shows the quote → F13 with that quote_fingerprint, Idempotency-Key and If-Match', async () => {
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('button', { name: /add tests/i }));
    const dlg = screen.getByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /test/i }));
    await userEvent.click(await screen.findByRole('option', { name: /TSH/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: /quote|price/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url.pathname).toBe(`/v1/frontdesk/orders/${ORDER}/items-changes/quote`);
    expect(calls[0]!.body.add).toEqual([expect.objectContaining({ orderable_id: U(103), priority: 'routine' })]);
    expect(await within(dlg).findByText('NPR 508.50')).toBeTruthy(); // net of the added tests only
    await userEvent.click(within(dlg).getByRole('button', { name: /^add( tests)?$|confirm/i }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]!.url.pathname).toBe(`/v1/frontdesk/orders/${ORDER}/items-changes`);
    expect(calls[1]!.body.quote_fingerprint).toBe('fp-add-tsh');
    expect(calls[1]!.body.add).toEqual([expect.objectContaining({ orderable_id: U(103) })]);
    expect(calls[1]!.headers.get('if-match')).toBe('"5"');
    expect(calls[1]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('10.2 remove with a coded reason: dialog needs the reason (no request without it); sends order_item_id + reason_code, If-Match, Idempotency-Key', async () => {
    const V = await load();
    view(V);
    const row = screen.getByText('Lipid profile').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: /remove/i }));
    const dlg = screen.getByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /remove|confirm/i }));
    expect(calls.length).toBe(0);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await pickReason(dlg, /patient request/i);
    await userEvent.click(within(dlg).getByRole('button', { name: /remove|confirm/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url.pathname).toBe(`/v1/frontdesk/orders/${ORDER}/items-changes`);
    expect(calls[0]!.body.remove).toEqual([{ order_item_id: ITEM_LIPID, reason_code: 'patient_request' }]);
    expect(calls[0]!.headers.get('if-match')).toBe('"5"');
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('10.2 an already removed/cancelled line shows its status and has no Remove button', async () => {
    const V = await load();
    view(V, order({ items: [{ ...order().items[0] }, { ...order().items[1], status: 'removed' }] }));
    const row = screen.getByText('Lipid profile').closest('tr')!;
    expect(within(row).getByText(/removed/i)).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /remove/i })).toBeNull();
    expect(within(screen.getByText('Complete blood count').closest('tr')!).getByRole('button', { name: /remove/i })).toBeTruthy();
  });

  it('10.3 409 frontdesk.order_not_editable → readable message in the dialog; other lines stay removable; Add tests stays available', async () => {
    api.use(http.post(`${ORIGIN}/v1/frontdesk/orders/:id/items-changes`, async ({ request }) => { await rec(request); return problem(409, 'frontdesk.order_not_editable'); }));
    const V = await load();
    view(V);
    await userEvent.click(within(screen.getByText('Lipid profile').closest('tr')!).getByRole('button', { name: /remove/i }));
    const dlg = screen.getByRole('dialog');
    await pickReason(dlg, /patient request/i);
    await userEvent.click(within(dlg).getByRole('button', { name: /remove|confirm/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(await screen.findByText(/already (in progress|processed)|can.?t be removed|not editable|no longer be removed/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/frontdesk\.order_not_editable/); // never raw codes
    expect(screen.getByRole('button', { name: /add tests/i })).toBeTruthy();
    expect(within(screen.getByText('Complete blood count').closest('tr')!).getByRole('button', { name: /remove/i })).toBeTruthy();
  });

  it('edit actions are gated by frontdesk.order.edit (read-only users see neither Add tests nor Remove)', async () => {
    const V = await load();
    view(V, order(), READ_ONLY, null);
    expect(screen.queryByRole('button', { name: /add tests|remove/i })).toBeNull();
  });

  it('a cancelled order cannot be edited or cancelled again (11.3 guard visible in UI)', async () => {
    const V = await load();
    view(V, order({ status: 'cancelled', requires_credit_note: true, cancel_reason_code: 'patient_left' }));
    expect(screen.getAllByText(/^Cancelled$/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /add tests|remove|cancel order/i })).toBeNull();
  });
});

describe('US-FD-11 cancel order', () => {
  it('11.1 ConfirmDialog with coded reason; paid > 0 shows "Finance must issue a credit note and refund NPR 1,000.00"; sends reason_code, If-Match, Idempotency-Key', async () => {
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('button', { name: /cancel order/i }));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByText(/Finance must issue a credit note and refund NPR 1,000\.00/)).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: /confirm|cancel order/i }));
    expect(calls.length).toBe(0); // reason required
    await pickReason(dlg, /patient left/i);
    await userEvent.click(within(dlg).getByRole('button', { name: /confirm|cancel order/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url.pathname).toBe(`/v1/frontdesk/orders/${ORDER}/cancel`);
    expect(calls[0]!.body.reason_code).toBe('patient_left');
    expect(calls[0]!.headers.get('if-match')).toBe('"5"');
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('11.1 nothing paid → no refund sentence', async () => {
    const V = await load();
    view(V, order(), RECEPTION, billing({ balance: { ...billing().balance, paid: npr(0), balance_due: npr(150000) }, ledger_entries: [] }));
    await userEvent.click(screen.getByRole('button', { name: /cancel order/i }));
    expect(within(screen.getByRole('dialog')).queryByText(/Finance must issue/)).toBeNull();
  });

  it('11.2 409 frontdesk.order_cancel_not_allowed → "approved results" message, dialog stays, no raw code', async () => {
    api.use(http.post(`${ORIGIN}/v1/frontdesk/orders/:id/cancel`, async ({ request }) => { await rec(request); return problem(409, 'frontdesk.order_cancel_not_allowed'); }));
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('button', { name: /cancel order/i }));
    const dlg = screen.getByRole('dialog');
    await pickReason(dlg, /patient left/i);
    await userEvent.click(within(dlg).getByRole('button', { name: /confirm|cancel order/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(await screen.findByText(/approved result/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/frontdesk\.order_cancel_not_allowed/);
  });

  it('11.3 409 frontdesk.order_already_cancelled → "already cancelled" message', async () => {
    api.use(http.post(`${ORIGIN}/v1/frontdesk/orders/:id/cancel`, async ({ request }) => { await rec(request); return problem(409, 'frontdesk.order_already_cancelled'); }));
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('button', { name: /cancel order/i }));
    const dlg = screen.getByRole('dialog');
    await pickReason(dlg, /patient left/i);
    await userEvent.click(within(dlg).getByRole('button', { name: /confirm|cancel order/i }));
    expect(await screen.findByText(/already cancelled/i)).toBeTruthy();
  });

  it('11.4 credit-mode order: no payment/refund sentence (charges are voided, requires_credit_note false)', async () => {
    const V = await load();
    view(V, order({ billing_mode: 'credit' }), RECEPTION, billing({ balance: { ...billing().balance, paid: npr(0), invoiced: npr(0), balance_due: npr(0) }, invoices: [], ledger_entries: [] }));
    await userEvent.click(screen.getByRole('button', { name: /cancel order/i }));
    expect(within(screen.getByRole('dialog')).queryByText(/Finance must issue/)).toBeNull();
  });

  it('cancelled order with requires_credit_note shows the open credit-note requirement (text, not colour)', async () => {
    const V = await load();
    view(V, order({ status: 'cancelled', requires_credit_note: true, cancel_reason_code: 'patient_left' }));
    expect(screen.getByText(/credit note (required|pending)|requires a credit note/i)).toBeTruthy();
  });

  it('Cancel order button needs frontdesk.order.cancel', async () => {
    const V = await load();
    view(V, order(), [PERM.orderRead, PERM.orderEdit], null);
    expect(screen.queryByRole('button', { name: /cancel order/i })).toBeNull();
  });
});

describe('Billing tab (B7 data) and Attachments tab', () => {
  it('Billing: invoice no with B.S. + A.D. dates, net, status, print count; ledger entry (kind, method, amount, by, receipt no); balance and eligibility basis', async () => {
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('tab', { name: 'Billing' }));
    const inv = screen.getByText('INV/2083-84/000042').closest('tr')!;
    expect(inv.textContent).toMatch(/2083-07-21/);
    expect(inv.textContent).toMatch(/07\/11\/2026/);
    expect(within(inv).getByText('NPR 1,500.00')).toBeTruthy();
    expect(within(inv).getByText(/issued/i)).toBeTruthy();
    expect(within(inv).getByText('2')).toBeTruthy();
    const led = screen.getByText('RC/2083-84/000009').closest('tr')!;
    expect(led.textContent).toMatch(/payment/i);
    expect(led.textContent).toMatch(/cash/i);
    expect(led.textContent).toMatch(/NPR 1,000\.00/);
    expect(led.textContent).toMatch(/Synthetic Cashier/);
    expect(document.body.textContent).toMatch(/NPR 500\.00/); // balance due
    expect(document.body.textContent).toMatch(/due outstanding|payment due/i); // eligibility basis in words
  });

  it('Billing actions: Record payment needs billing.payment.record; Print copy needs billing.invoice.reprint', async () => {
    const V = await load();
    view(V, order(), [PERM.orderRead, PERM.invRead]);
    await userEvent.click(screen.getByRole('tab', { name: 'Billing' }));
    expect(screen.queryByRole('button', { name: /record payment/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /print/i })).toBeNull();
    cleanup();
    view(V, order(), [PERM.orderRead, PERM.invRead, PERM.pay]);
    await userEvent.click(screen.getByRole('tab', { name: 'Billing' }));
    expect(screen.getByRole('button', { name: /record payment/i })).toBeTruthy();
  });

  it('Billing: open credit-note tasks, refund requests and finance review items are listed', async () => {
    const V = await load();
    view(V, order(), RECEPTION, billing({
      open_credit_note_tasks: [{ id: U(80), invoice_id: U(50), cause: 'item_removed', invoice_line_ids: [U(81)], status: 'open', created_at: '2026-11-07T04:00:00.000Z', version: 1 }],
      refund_requests: [{ id: U(82), order_id: ORDER, method_code: 'cash', refund_amount: npr(20000), reason_code: 'overpayment', status: 'pending', requested_by: { membership_id: ME, display_name: 'Me' }, requested_at: '2026-11-07T04:00:00.000Z', version: 1 }],
    }));
    await userEvent.click(screen.getByRole('tab', { name: 'Billing' }));
    expect(screen.getByText(/credit note/i)).toBeTruthy();
    expect(screen.getByText('NPR 200.00')).toBeTruthy();
    expect(screen.getByText(/pending/i)).toBeTruthy();
  });

  it('Attachments: scan state as text; preview only when clean and via the BFF content route (never a Storage URL); quarantined → "File rejected by security scan" (US-FD-09.2)', async () => {
    const V = await load();
    view(V, order({ trf_attachments: [attachment(), attachment({ id: U(41), scan_state: 'pending', original_filename: 'trf-2.jpg' }), attachment({ id: U(42), scan_state: 'quarantined', original_filename: 'trf-3.jpg' })] }));
    await userEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    const clean = screen.getByText('trf-1.jpg').closest('tr')!;
    const pending = screen.getByText('trf-2.jpg').closest('tr')!;
    const bad = screen.getByText('trf-3.jpg').closest('tr')!;
    expect(within(clean).getByText(/clean/i)).toBeTruthy();
    expect(within(pending).getByText(/pending|scanning/i)).toBeTruthy();
    expect(within(bad).getByText(/File rejected by security scan/)).toBeTruthy();
    const link = within(clean).getByRole('link', { name: /preview|view|open/i });
    expect(link.getAttribute('href')).toBe(`/frontdesk/trf-attachments/${U(40)}/content`);
    expect(within(pending).queryByRole('link', { name: /preview|view|open/i })).toBeNull();
    expect(within(bad).queryByRole('link', { name: /preview|view|open/i })).toBeNull();
    const hrefs = [...document.querySelectorAll('a[href],img[src],iframe[src]')].map((e) => e.getAttribute('href') ?? e.getAttribute('src') ?? '');
    for (const h of hrefs) expect(h).not.toMatch(/supabase|storage|\.s3\.|^https?:\/\//i);
  });

  it('Attachments: Upload button needs frontdesk.trf.upload', async () => {
    const V = await load();
    view(V, order(), [PERM.orderRead], null);
    await userEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    expect(screen.queryByRole('button', { name: /upload/i })).toBeNull();
    cleanup();
    view(V);
    await userEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    expect(screen.getByRole('button', { name: /upload/i })).toBeTruthy();
  });

  // Review item 2: TrfUploadForm (frontdesk.yaml ~L5289) has an optional order_id; without it the file is orphaned and never lands in this order's trf_attachments.
  it('Attachments: upload from the order page posts multipart F21 with centre_id AND this order\'s order_id + Idempotency-Key', async () => {
    // jsdom's FormData/File are not undici's, so a real multipart round-trip through MSW is not possible here: capture the outgoing fetch() instead.
    let form: FormData | undefined; let key: string | null = null; let hits = 0;
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const u = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (u.pathname !== '/v1/frontdesk/trf-attachments') return real(input, init);
      hits++; key = new Headers(init?.headers).get('idempotency-key'); form = init?.body as FormData;
      return new Response(JSON.stringify(attachment({ id: U(43), scan_state: 'pending' })), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    await userEvent.upload(screen.getByLabelText('TRF file'), new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'trf-new.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(hits).toBe(1));
    expect(form!.get('order_id')).toBe(ORDER);
    expect(form!.get('centre_id')).toBe(order().centre_id);
    expect((form!.get('file') as File).name).toBe('trf-new.pdf');
    expect(key).toBeTruthy();
  });
});

describe('pre-registered orders (US-FD-12.2 entry point on the order page)', () => {
  // Review item 3: ConfirmOrderRequest requires quote_fingerprint (frontdesk.yaml ~L5057), so a bare "Confirm & bill" can never succeed.
  // Until FD-T13's payment panel is shared the banner stays, but there is no inline confirm control and nothing is POSTed to /confirm.
  it('banner "Booked — confirm on arrival" stays; no "Confirm & bill" button; nothing posts to F12 /confirm', async () => {
    const V = await load();
    view(V, order({ status: 'pre_registered', source: 'engagement_booking' }));
    expect(screen.getByText(/Booked — confirm on arrival/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /confirm & bill/i })).toBeNull();
    expect(calls.filter((c) => c.url.pathname.endsWith('/confirm'))).toEqual([]);
  });

  it('a registered order has no banner/confirm button; without registration.create the confirm button is absent', async () => {
    const V = await load();
    view(V);
    expect(screen.queryByText(/confirm on arrival/i)).toBeNull();
    cleanup();
    view(V, order({ status: 'pre_registered' }), [PERM.orderRead], null);
    expect(screen.queryByRole('button', { name: /confirm & bill/i })).toBeNull();
  });
});

describe('privacy + a11y', () => {
  it('no PHI in browser storage after interacting; no raw HTML injection of patient text', async () => {
    const V = await load();
    view(V, order({ patient: { ...order().patient, full_name: '<img src=x onerror=alert(1)>Demo' } }));
    expect(document.querySelector('img[src="x"]')).toBeNull(); // React text node, not HTML (REQ-SEC-088)
    await userEvent.click(screen.getByRole('tab', { name: 'Billing' }));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('axe: header+items, billing tab, attachments tab, cancel dialog', async () => {
    const V = await load();
    view(V, order({ trf_attachments: [attachment()] }));
    await noAxeViolations();
    await userEvent.click(screen.getByRole('tab', { name: 'Billing' }));
    await noAxeViolations();
    await userEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    await noAxeViolations();
    await userEvent.click(screen.getByRole('button', { name: /cancel order/i }));
    await noAxeViolations();
  });

  it('the Items tab is the default and add/remove dialogs return focus to their trigger when closed', async () => {
    const V = await load();
    view(V);
    expect(screen.getByRole('tab', { name: 'Items' }).getAttribute('aria-selected')).toBe('true');
    const add = screen.getByRole('button', { name: /add tests/i });
    await userEvent.click(add);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(add);
  });
});

void ITEM_CBC; void ITEM_TSH;
