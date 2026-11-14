// @vitest-environment jsdom
// PG-T18 — Payment review queue, route /payments/review (04-UI-UX §2.1, §6, §7; 01-PRD US-PG-07; 07-SECURITY). MSW plays the API.
// ASSUMED contract (spec fixes folders + kit components; dispute via writer if wrong):
//   * features/payments/components/ReviewQueue.tsx exports `ReviewQueue({ intents, permissions, centres, holdReasons })`
//       intents = PaymentIntentSummary[] (TRD §4 DTO, money as {amount_paisa,currency}); holdReasons = [{code,display}] (P24 `hold_reasons`);
//       it renders PageHeader(title "Payment review", helpKey payments.review), FilterBar + DataTable (caption "Payments needing review"); `useRouter().push` opens a row.
//   * app/(staff)/payments/review/page.tsx default export = async server component `Page({ searchParams: Promise<Record<string,string|string[]|undefined>> })`
//       fetching GET /v1/payments/intents (P1) and GET /v1/payments/coded-sets/hold_reasons (P24) itself with the session Bearer token. No searchParams ⇒ status=held_for_review,
//       sort=-created_at, limit=50, created_at_from/to = last 7 days. Only whitelisted, well-formed params are forwarded; everything else is dropped.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/payments/review',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['payments.reconciliation.read'], displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/payments/review',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const CENTRE = U(3), CENTRE_B = U(4);
const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const READ = ['payments.reconciliation.read'];
const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }, { id: CENTRE_B, name: 'Synthetic Centre B2' }];
const holdReasons = [
  { code: 'amount_mismatch', display: 'Amount does not match', requires_text: false, is_active: true },
  { code: 'exceeds_due', display: 'Payment exceeds the amount due', requires_text: false, is_active: true },
  { code: 'gateway_ambiguous', display: 'Provider answer unclear', requires_text: false, is_active: true },
];
const intent = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(100 + n), order_id: U(200 + n), centre_id: CENTRE, gateway: 'esewa', environment: 'production', status: 'held_for_review', amount: npr(12345600),
  hold_reason: 'amount_mismatch', created_at: '2026-11-10T04:00:00.000Z', expires_at: '2026-11-10T04:30:00.000Z', last_checked_at: '2026-11-10T04:20:00.000Z', version: 2, ...o,
});
const rows = [
  intent(1),
  intent(2, { gateway: 'khalti', status: 'pending', hold_reason: undefined, amount: npr(50000), last_checked_at: undefined }),
  intent(3, { status: 'failed', hold_reason: undefined, failure_reason: 'gateway_cancelled', amount: npr(100) }),
  intent(4, { status: 'settled', hold_reason: undefined, settled_at: '2026-11-10T04:10:00.000Z' }),
];

const calls: { url: URL; headers: Headers }[] = [];
let list: () => Response | Promise<Response> = () => HttpResponse.json({ data: rows, page: { limit: 50 } });
const problem = (code: string, status: number) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code }, { status });
const api = setupServer(
  http.get(`${ORIGIN}/v1/payments/intents`, ({ request }) => { calls.push({ url: new URL(request.url), headers: request.headers }); return list(); }),
  http.get(`${ORIGIN}/v1/payments/coded-sets/hold_reasons`, () => HttpResponse.json({ data: holdReasons })),
  http.get(`${ORIGIN}/v1/payments/*`, () => problem('common.dependency_unavailable', 503)),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); list = () => HttpResponse.json({ data: rows, page: { limit: 50 } }); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const comp = async () => ((await import(/* @vite-ignore */ '../components/ReviewQueue')) as { ReviewQueue: (p: any) => any }).ReviewQueue;
const view = async (intents: unknown[] = rows) => { const ReviewQueue = await comp(); return wrap(<ReviewQueue intents={intents as never} permissions={READ} centres={centres} holdReasons={holdReasons} />); };
const rowOf = (n: number) => document.querySelector(`a[href="/payments/intents/${U(100 + n)}"]`)!.closest('tr') as HTMLElement;

describe('§2.1 ReviewQueue — table', () => {
  it('title "Payment review", caption "Payments needing review", the eight columns in spec order, no header actions', async () => {
    await view();
    expect(screen.getByRole('heading', { name: 'Payment review' })).toBeTruthy();
    expect(screen.getByRole('grid', { name: /Payments needing review/ })).toBeTruthy();
    const heads = screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim().toLowerCase());
    const want = ['created', 'gateway', 'amount', 'status', 'reason', 'last checked', 'order', 'intent'];
    let at = -1;
    for (const w of want) { const i = heads.findIndex((h, k) => k > at && h.startsWith(w)); expect(i, `column ${w} in ${heads.join('|')}`).toBeGreaterThan(at); at = i; }
  });

  it('row shows gateway, lakh-grouped NPR amount, TEXT status chip with the C0 label, reason display (not the raw code), order + intent links', async () => {
    await view();
    const r1 = rowOf(1);
    expect(within(r1).getByText(/eSewa/)).toBeTruthy();
    expect(within(r1).getByText('NPR 1,23,456.00')).toBeTruthy();
    expect(within(r1).getByText('Under review')).toBeTruthy();
    expect(within(r1).getByText('Amount does not match')).toBeTruthy();
    expect(r1.textContent).not.toMatch(/amount_mismatch/);
    expect(r1.querySelector(`a[href="/frontdesk/orders/${U(201)}"]`)).toBeTruthy();
    const r2 = rowOf(2);
    expect(within(r2).getByText(/Khalti/)).toBeTruthy();
    expect(within(r2).getByText('NPR 500.00')).toBeTruthy();
    expect(within(r2).getByText(/Waiting for provider|Pending/i)).toBeTruthy();
    expect(within(rowOf(3)).getByText(/Failed/i)).toBeTruthy();
    expect(within(rowOf(4)).getByText('Paid')).toBeTruthy(); // settled → "Paid" only because the server says settled
  });

  it('shows failure reason in the Reason column for failed intents and never invents "Payment successful" for non-settled rows', async () => {
    await view();
    expect(rowOf(3).textContent).toMatch(/cancel/i);
    for (const n of [1, 2, 3]) expect(rowOf(n).textContent).not.toMatch(/Paid|successful/i);
    expect(document.body.textContent).not.toMatch(/Payment successful|Fonepay verified/);
  });

  it('dates render through the tenant calendar (B.S./A.D. via DateText, with time) — never a raw ISO string', async () => {
    await view();
    expect(rowOf(1).textContent).not.toMatch(/2026-11-10T04:00/);
    expect(rowOf(1).textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('empty state: title and body from the spec', async () => {
    await view([]);
    expect(screen.getByText('No payments need review.')).toBeTruthy();
    expect(screen.getByText('Held payments appear here when a provider answer needs a person.')).toBeTruthy();
  });

  it('never renders callback tokens, return URLs, raw provider payloads or secrets even if the API leaks them (07-SECURITY)', async () => {
    const leaky = intent(5, { callback_token: 'tok_SECRETSECRETSECRET1', return_url: 'https://portal.test/r/payments/x', raw_payload: '{"secret":"x"}', gateway_txn_ref: 'txn-leak-ref' });
    const { container } = await view([leaky]);
    expect(container.innerHTML).not.toMatch(/tok_SECRET|portal\.test|"secret"|jwt-synthetic/);
  });
});

describe('§2.1 ReviewQueue — filters', () => {
  it('FilterBar offers status, gateway, hold reason, created range and centre; default status is "Under review"', async () => {
    await view();
    for (const l of [/status/i, /gateway/i, /hold reason|reason/i, /created/i, /centre/i]) expect(screen.getAllByText(l).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Under review').length).toBeGreaterThan(0);
  });

  it('gateway filter lists eSewa, Khalti and a DISABLED "Fonepay — not available yet" entry', async () => {
    await view();
    await userEvent.click(screen.getByRole('button', { name: /gateway/i }));
    const fonepay = await screen.findByRole('option', { name: /Fonepay — not available yet/ });
    expect(fonepay.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: /eSewa/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Khalti/ })).toBeTruthy();
  });

  it('status filter offers the six spec options with spec labels', async () => {
    await view();
    // 04-UI-UX §2.1: status is "select multiple" → kit MultiSelect = always-visible listbox (no trigger button).
    const box = screen.getByRole('listbox', { name: /status/i });
    for (const l of ['Under review', 'Waiting for provider', 'Started', 'Failed', 'Expired', 'Paid']) expect(within(box).getByRole('option', { name: new RegExp(l, 'i') })).toBeTruthy();
    expect(box.getAttribute('aria-multiselectable')).toBe('true');
  });

  it('status filter is multi-select: a multi-value status selects every listed option', async () => {
    const ReviewQueue = await comp();
    wrap(<ReviewQueue intents={rows as never} permissions={READ} centres={centres} holdReasons={holdReasons} filter={{ status: ['held_for_review', 'pending'], created: ['', ''] }} />);
    const selected = within(screen.getByRole('listbox', { name: /status/i })).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected.map((o) => o.textContent).sort()).toEqual(['Under review', 'Waiting for provider']);
  });
});

describe('§2.1 ReviewQueue — keyboard script (02-CV §14: every action reachable by keyboard)', () => {
  it('Tab reaches a row; Enter on the row opens the intent detail', async () => {
    await view();
    const r = rowOf(1);
    r.focus();
    if (document.activeElement !== r) { const a = r.querySelector('a[href^="/payments/intents/"]') as HTMLElement; a.focus(); }
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      const opened = push.mock.calls.some((c) => c[0] === `/payments/intents/${U(101)}`);
      const navigated = (document.activeElement as HTMLAnchorElement | null)?.getAttribute?.('href') === `/payments/intents/${U(101)}`;
      expect(opened || navigated).toBe(true);
    });
  });

  it('the intent id and order id are real links (keyboard-focusable, no click-only handlers)', async () => {
    await view();
    const a = rowOf(1).querySelector(`a[href="/payments/intents/${U(101)}"]`) as HTMLAnchorElement;
    a.focus();
    expect(document.activeElement).toBe(a);
  });

  it('Alt+R moves focus to the filter reset control', async () => {
    await view();
    await userEvent.keyboard('{Alt>}r{/Alt}');
    const active = document.activeElement as HTMLElement;
    expect(active?.textContent ?? active?.getAttribute('aria-label') ?? '').toMatch(/reset/i);
  });
});

describe('§2.1 ReviewQueue — a11y', () => {
  it('axe: no violations with rows', async () => { await view(); await axeClean(); });
  it('axe: no violations when empty', async () => { await view([]); await axeClean(); });
});

type SP = Record<string, string | string[] | undefined>;
const loadPage = async () => ((await import(/* @vite-ignore */ '../../../app/(staff)/payments/review/page')) as { default: (p: { searchParams: Promise<SP> }) => Promise<any> }).default;
const show = async (sp: SP = {}) => { const Page = await loadPage(); return wrap(await Page({ searchParams: Promise.resolve(sp) })); };

describe('review page.tsx — request (P1/P24)', () => {
  it('defaults: status=held_for_review, sort=-created_at, limit=50, last-7-days window; Bearer from the session, never in the DOM', async () => {
    const { container } = await show();
    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0]!;
    expect(url.pathname).toBe('/v1/payments/intents');
    expect(url.searchParams.get('status')).toBe('held_for_review');
    expect(url.searchParams.get('sort')).toBe('-created_at');
    expect(url.searchParams.get('limit')).toBe('50');
    const from = Date.parse(url.searchParams.get('created_at_from') ?? ''), to = Date.parse(url.searchParams.get('created_at_to') ?? '');
    expect(Number.isNaN(from) || Number.isNaN(to)).toBe(false);
    expect((to - from) / 86_400_000).toBeGreaterThan(5.9);
    expect((to - from) / 86_400_000).toBeLessThan(8.1);
    expect(headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(container.innerHTML).not.toContain('jwt-synthetic');
    expect(await within(screen.getByRole('grid')).findByText('Amount does not match')).toBeTruthy();
  });

  it('forwards only whitelisted, well-formed params and drops everything else (tenant_id, evil, injected query)', async () => {
    await show({ status: 'held_for_review,pending', gateway: 'esewa,khalti', hold_reason: 'exceeds_due', centre_id: CENTRE, evil: '1', tenant_id: 'other-tenant' });
    const q = calls[0]!.url.searchParams;
    expect(q.get('status')).toBe('held_for_review,pending');
    expect(q.get('gateway')).toBe('esewa,khalti');
    expect(q.get('hold_reason')).toBe('exceeds_due');
    expect(q.get('centre_id')).toBe(CENTRE);
    expect(q.has('evil')).toBe(false);
    expect(q.has('tenant_id')).toBe(false);
  });

  it.each([
    ['status', 'settled&centre_id=x'],
    ['status', 'not_a_status'],
    ['gateway', 'fonepay;drop'],
    ['hold_reason', '../../etc/passwd'],
    ['centre_id', 'not-a-uuid'],
    ['created_at_from', '2026-11-1; drop'],
  ])('does not forward a malformed %s (%s)', async (key, bad) => {
    await show({ [key]: bad });
    for (const c of calls) {
      expect(c.url.searchParams.get(key)).not.toBe(bad);
      expect(c.url.search).not.toMatch(/drop|passwd/);
    }
  });

  it('API 403 shows no payment rows; API 5xx rejects so error.tsx renders', async () => {
    list = () => problem('auth.forbidden', 403);
    try { await show(); } catch { /* a 403 may reject or render an empty/denied state */ }
    expect(document.body.textContent).not.toMatch(/Amount does not match|NPR 1,23,456/);
    cleanup();
    list = () => problem('common.dependency_unavailable', 503);
    await expect(show()).rejects.toBeTruthy();
  });

  it('axe: page output has no violations', async () => { await show(); await axeClean(); });
});
