// @vitest-environment jsdom
// C5.T-11 — Collect & dispatch screen `/lab/collect` (04-UI-UX §3.2, 03-APP-FLOW §3.2). Plan T-11 done_when: keyboard-only flows pass; scanner simulation (fast keystrokes + Enter);
// registration-no lookup; UI kit defaults. ACs: AC-03.1 (collect), AC-03.3 (dispatch). Security: REQ-SEC-028/098, S-09 (no barcode / registration no in any URL or storage).
// Component tests + MSW (server actions run for real against MSW) + axe. Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + copy + kit components only; raise a dispute to rename):
//   components/CollectDispatch.tsx   export CollectDispatch({ permissions: readonly string[] })     — tabs "Collect" and "Dispatch" (role=tab); only the active panel's BarcodeInput is live
//   server/actions.ts                'use server' actions called by the component (BFF → /v1/lab): lookup POST /specimens/lookup, bulk-collect, bulk-dispatch — not imported by these tests
//   Collect tab:  BarcodeInput labelled "Scan barcode or enter registration number" (kit defaults, pattern widened to the registration_no charset ≤ 40); empty text "Scan a label to start.";
//                 `ordered` specimens of the looked-up order listed with a checkbox whose name contains the barcode; button "Collect selected"; success "Collected {n} specimens."
//   Dispatch tab: BarcodeInput (label contains "barcode"); a table row per scanned barcode; status ≠ collected → "Not ready to dispatch (status: {status})";
//                 button "Dispatch {n} specimens" (Ctrl+Enter; n = valid rows) and "Clear list"; max 200 rows.
//   No lab.specimen.collect in permissions → "You don't have access to this screen." and no request (page-level denial, 03-APP-FLOW §3).
// NOT tested (spec silent / needs layout): the 200-row cap UI, Toast copy for dispatch success, tab-switch animation, print/label buttons.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { BC, LAB, LONG_REG, ORDER, ORIGIN, REG, SP, bulkCollects, bulkDispatches, calls, lookups, problem, rec, specimen } from './lab-t11.fixtures';

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/lab/collect',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['lab.specimen.collect', 'lab.specimen.read'], displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/collect',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const COLLECT = ['lab.specimen.collect', 'lab.specimen.read'];
// order with 3 specimens: two `ordered`, one already `received` (must not be offered for collection)
const ORDERED_A = specimen(1);
const ORDERED_B = specimen(2);
const RECEIVED_C = specimen(3, { status: 'received' });
const byBarcode: Record<string, ReturnType<typeof specimen>> = { [BC(1)]: ORDERED_A, [BC(2)]: ORDERED_B, [BC(3)]: RECEIVED_C, [BC(4)]: specimen(4, { status: 'collected' }), [BC(5)]: specimen(5, { status: 'collected' }) };
const okRow = (s: ReturnType<typeof specimen>, status: string) => ({ id: s.id, outcome: 'ok', specimen: { ...s, version: s.version + 1, status } });

const api = setupServer(
  http.post(`${LAB}/specimens/lookup`, async ({ request }) => {
    await rec(request);
    const b = (await request.clone().json()) as { barcode?: string; registration_no?: string };
    if (b.barcode) return byBarcode[b.barcode] ? HttpResponse.json(byBarcode[b.barcode]) : problem(404, 'common.not_found', 'Not found');
    if (b.registration_no === LONG_REG || b.registration_no === REG) return HttpResponse.json({ data: [ORDERED_A, ORDERED_B, RECEIVED_C] });
    return HttpResponse.json({ data: [] });
  }),
  http.post(`${LAB}/specimens/bulk-collect`, async ({ request }) => {
    await rec(request);
    const { items } = (await request.clone().json()) as { items: { id: string }[] };
    return HttpResponse.json({ results: items.map((i) => okRow(i.id === SP(1) ? ORDERED_A : ORDERED_B, 'collected')) });
  }),
  http.post(`${LAB}/specimens/bulk-dispatch`, async ({ request }) => {
    await rec(request);
    const { items } = (await request.clone().json()) as { items: { id: string }[] };
    return HttpResponse.json({ results: items.map((i) => okRow(i.id === SP(4) ? byBarcode[BC(4)]! : byBarcode[BC(5)]!, 'in_transit')) });
  }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const show = async (permissions: readonly string[] = COLLECT) => {
  const { CollectDispatch } = await import('../components/CollectDispatch');
  return wrap(<CollectDispatch permissions={permissions} />);
};
const text = (root: HTMLElement = document.body) => root.textContent ?? '';
const bodyHas = (s: string | RegExp) => (typeof s === 'string' ? text().includes(s) : s.test(text()));
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const live = (el: Element) => !el.closest('[hidden],[aria-hidden="true"],[inert]');
/** The BarcodeInput of the active tab. */
const box = () => screen.getAllByLabelText(/barcode/i).filter(live)[0] as HTMLInputElement;
/** A scanner is fast keystrokes + Enter (kit default 30 ms max inter-key gap): delay:null types synchronously. */
const scan = async (value: string) => { await userEvent.setup({ delay: null }).type(box(), `${value}{Enter}`); };
const tab = (name: RegExp) => screen.getByRole('tab', { name });
const setChecked = async (bc: string, on: boolean) => {
  const cb = (await screen.findByRole('checkbox', { name: new RegExp(bc) })) as HTMLInputElement;
  if (cb.checked !== on) await userEvent.click(cb);
};
const urlsPushed = () => [...push.mock.calls, ...replace.mock.calls].map((c) => String(c[0]));

describe('permissions / empty state', () => {
  it('opens on the Collect tab with the empty text and a focused BarcodeInput labelled per spec (kit autofocus)', async () => {
    await show();
    expect(tab(/^collect\b/i).getAttribute('aria-selected')).toBe('true');
    expect(tab(/^dispatch\b/i)).toBeTruthy();
    expect(bodyHas('Scan a label to start.')).toBe(true);
    const input = screen.getByLabelText(/scan barcode or enter registration number/i);
    expect(document.activeElement).toBe(input);
    expect(calls).toHaveLength(0); // rendering alone calls nothing
  });

  it('without lab.specimen.collect → page-level denial, no BarcodeInput, no request', async () => {
    await show(['lab.specimen.read']);
    expect(bodyHas("You don't have access to this screen.")).toBe(true);
    expect(screen.queryByLabelText(/barcode/i)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('axe', async () => {
    await show();
    await noAxeViolations();
  });
});

describe('Collect tab — scanner simulation + lookup (AC-03.1; BarcodeInput kit defaults)', () => {
  it('fast keystrokes + Enter → ONE lookup, POST body {barcode}, no query string, bearer from the server session, never a URL', async () => {
    await show();
    await scan(BC(1));
    await waitFor(() => expect(lookups()).toHaveLength(1));
    const c = lookups()[0]!;
    expect(c.body).toEqual({ barcode: BC(1) });
    expect(c.url.search).toBe('');
    expect(c.url.pathname).not.toContain(BC(1));
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(await screen.findByRole('checkbox', { name: new RegExp(BC(1)) })).toBeTruthy();
  });

  it('kit defaults: a lower-case scan is upper-cased and trimmed before the lookup', async () => {
    await show();
    await userEvent.setup({ delay: null }).type(box(), `  ${BC(1).toLowerCase()}  {Enter}`);
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(lookups()[0]!.body).toEqual({ barcode: BC(1) });
  });

  it('kit defaults: the same barcode scanned twice within 1,500 ms is looked up once ("Duplicate scan ignored")', async () => {
    await show();
    await scan(BC(1));
    await scan(BC(1));
    await waitFor(() => expect(lookups()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(lookups()).toHaveLength(1);
  });

  it('kit defaults: a value outside the pattern shows the kit invalid message and calls nothing', async () => {
    await show();
    await userEvent.setup({ delay: null }).type(box(), 'bad code!{Enter}');
    expect(await screen.findByText("This doesn't look like a sample barcode")).toBeTruthy();
    expect(lookups()).toHaveLength(0);
  });

  it('scanner still captured when focus is not in the input (document-level capture, useScanCapture)', async () => {
    await show();
    (document.activeElement as HTMLElement | null)?.blur();
    for (const ch of BC(2)) fireEvent.keyDown(document.body, { key: ch });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(lookups()[0]!.body).toEqual({ barcode: BC(2) });
  });
});

describe('Collect tab — registration-no lookup + collect (AC-03.1)', () => {
  it('a value longer than the barcode charset limit is looked up as {registration_no}; only the order\'s `ordered` specimens are offered', async () => {
    await show();
    await scan(LONG_REG);
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(lookups()[0]!.body).toEqual({ registration_no: LONG_REG });
    expect(lookups()[0]!.url.search).toBe('');
    expect(await screen.findByRole('checkbox', { name: new RegExp(BC(1)) })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: new RegExp(BC(2)) })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: new RegExp(BC(3)) })).toBeNull(); // received → not collectable
  });

  it('a registration number typed by hand (slow keystrokes → source keyboard) is accepted too', async () => {
    await show();
    await userEvent.setup({ delay: 5 }).type(box(), `${LONG_REG}{Enter}`);
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(lookups()[0]!.body).toEqual({ registration_no: LONG_REG });
  });

  it('unknown registration number → `200 { data: [] }` shows the empty state again, nothing to collect', async () => {
    await show();
    await scan('NOSUCHREGNO2611059999');
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(bodyHas('Scan a label to start.')).toBe(true);
    expect(screen.queryByRole('button', { name: /collect selected/i })).toBeNull();
  });

  it('Collect selected → bulk-collect with exactly the selected {id, version} items, an Idempotency-Key, then "Collected 1 specimens."', async () => {
    await show();
    await scan(LONG_REG);
    await setChecked(BC(1), true);
    await setChecked(BC(2), false);
    await userEvent.click(screen.getByRole('button', { name: /collect selected/i }));
    await waitFor(() => expect(bulkCollects()).toHaveLength(1));
    const c = bulkCollects()[0]!;
    expect(c.body).toEqual({ items: [{ id: SP(1), version: 1 }] });
    expect((c.headers.get('idempotency-key') ?? '').length).toBeGreaterThanOrEqual(8);
    expect(c.url.search).toBe('');
    await waitFor(() => expect(bodyHas(/Collected 1 specimens?\./)).toBe(true));
  });

  it('per-id failure is shown on its own row; the other specimen is still reported collected', async () => {
    api.use(http.post(`${LAB}/specimens/bulk-collect`, async ({ request }) => {
      await rec(request);
      return HttpResponse.json({ results: [okRow(ORDERED_A, 'collected'), { id: SP(2), outcome: 'error', code: 'lab.specimen_invalid_transition' }] });
    }));
    await show();
    await scan(LONG_REG);
    await setChecked(BC(1), true);
    await setChecked(BC(2), true);
    await userEvent.click(screen.getByRole('button', { name: /collect selected/i }));
    await waitFor(() => expect(bodyHas(/Collected 1 specimens?\./)).toBe(true));
    const failed = screen.getByRole('checkbox', { name: new RegExp(BC(2)) }).closest('tr,li,div') as HTMLElement;
    expect(text(failed)).toMatch(/cannot move|invalid transition|not .*collect|already/i); // human text, not just the raw code
  });

  it('double activation while the request is in flight sends ONE bulk-collect (no double submit)', async () => {
    api.use(http.post(`${LAB}/specimens/bulk-collect`, async ({ request }) => {
      await rec(request);
      await delay(120);
      return HttpResponse.json({ results: [okRow(ORDERED_A, 'collected')] });
    }));
    await show();
    await scan(LONG_REG);
    await setChecked(BC(1), true);
    await setChecked(BC(2), false);
    const btn = screen.getByRole('button', { name: /collect selected/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(bulkCollects().length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(bulkCollects()).toHaveLength(1);
  });

  it('nothing selected → Collect selected is disabled and no request is sent', async () => {
    await show();
    await scan(LONG_REG);
    await setChecked(BC(1), false);
    await setChecked(BC(2), false);
    const btn = screen.getByRole('button', { name: /collect selected/i });
    expect((btn as HTMLButtonElement).disabled || btn.getAttribute('aria-disabled') === 'true').toBe(true);
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 50));
    expect(bulkCollects()).toHaveLength(0);
  });

  it('KEYBOARD ONLY: scan → Tab/Space through the list → Enter on "Collect selected" collects; no pointer event is used', async () => {
    await show();
    const kb = userEvent.setup({ delay: null });
    await kb.type(box(), `${LONG_REG}{Enter}`);
    await screen.findByRole('checkbox', { name: new RegExp(BC(1)) });
    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      await kb.tab();
      const el = document.activeElement as HTMLElement;
      if (el instanceof HTMLInputElement && el.type === 'checkbox' && !el.checked) await kb.keyboard(' ');
      else if (el.tagName === 'BUTTON' && /collect selected/i.test(el.textContent ?? '')) { await kb.keyboard('{Enter}'); done = true; }
    }
    expect(done).toBe(true);
    await waitFor(() => expect(bulkCollects()).toHaveLength(1));
    expect((bulkCollects()[0]!.body.items as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});

describe('Dispatch tab (AC-03.3)', () => {
  const dispatchTab = async () => { await userEvent.click(tab(/^dispatch\b/i)); await waitFor(() => expect(tab(/^dispatch\b/i).getAttribute('aria-selected')).toBe('true')); };

  it('each scan adds a row (barcode + status); a non-collected specimen gets "Not ready to dispatch (status: ordered)" and is not counted', async () => {
    await show();
    await dispatchTab();
    await scan(BC(4));
    const row4 = await screen.findByRole('row', { name: new RegExp(BC(4)) });
    expect(text(row4)).toMatch(/collected/i);
    await scan(BC(1)); // status ordered
    const row1 = await screen.findByRole('row', { name: new RegExp(BC(1)) });
    expect(text(row1)).toContain('Not ready to dispatch (status: ordered)');
    expect(lookups().map((c) => c.body)).toEqual([{ barcode: BC(4) }, { barcode: BC(1) }]);
    expect(screen.getByRole('button', { name: /^dispatch 1 specimens?$/i })).toBeTruthy();
  });

  it('"Dispatch 2 specimens" → bulk-dispatch with the valid rows only, Idempotency-Key, scan order kept; rows then show the outcome', async () => {
    await show();
    await dispatchTab();
    await scan(BC(4));
    await screen.findByRole('row', { name: new RegExp(BC(4)) });
    await scan(BC(1)); // invalid row — must not be sent
    await scan(BC(5));
    await screen.findByRole('row', { name: new RegExp(BC(5)) });
    await userEvent.click(screen.getByRole('button', { name: /^dispatch 2 specimens$/i }));
    await waitFor(() => expect(bulkDispatches()).toHaveLength(1));
    const c = bulkDispatches()[0]!;
    expect(c.body).toEqual({ items: [{ id: SP(4), version: 1 }, { id: SP(5), version: 1 }] });
    expect((c.headers.get('idempotency-key') ?? '').length).toBeGreaterThanOrEqual(8);
    await waitFor(() => expect(text(screen.getByRole('row', { name: new RegExp(BC(4)) }))).toMatch(/in transit|dispatched/i));
  });

  it('KEYBOARD ONLY: Ctrl+Enter dispatches the list', async () => {
    await show();
    await dispatchTab();
    await scan(BC(4));
    await screen.findByRole('row', { name: new RegExp(BC(4)) });
    await userEvent.setup({ delay: null }).keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(bulkDispatches()).toHaveLength(1));
    expect(bulkDispatches()[0]!.body).toEqual({ items: [{ id: SP(4), version: 1 }] });
  });

  it('"Clear list" empties the rows and removes the dispatch button', async () => {
    await show();
    await dispatchTab();
    await scan(BC(4));
    await screen.findByRole('row', { name: new RegExp(BC(4)) });
    await userEvent.click(screen.getByRole('button', { name: /clear list/i }));
    expect(screen.queryByRole('row', { name: new RegExp(BC(4)) })).toBeNull();
    expect(screen.queryByRole('button', { name: /^dispatch \d+ specimens?$/i })).toBeNull();
    expect(bulkDispatches()).toHaveLength(0);
  });

  it('unknown barcode on the dispatch tab → message, no row, no bulk call', async () => {
    await show();
    await dispatchTab();
    await scan('SYN9999999');
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(await screen.findByText('No specimen with this barcode in your lab.')).toBeTruthy();
    expect(screen.queryByRole('row', { name: /SYN9999999/ })).toBeNull();
  });
});

describe('SECURITY — barcode / registration no never leave the POST body (REQ-SEC-028, REQ-SEC-098, S-09)', () => {
  it('after collect + dispatch scans: no URL pushed, no history entry, no web storage holds a barcode or registration number, every API URL is query-free', async () => {
    await show();
    const hist = window.history.length;
    await scan(LONG_REG);
    await setChecked(BC(1), true);
    await userEvent.click(screen.getByRole('button', { name: /collect selected/i }));
    await waitFor(() => expect(bulkCollects()).toHaveLength(1));
    await userEvent.click(tab(/^dispatch\b/i));
    await scan(BC(4));
    await waitFor(() => expect(lookups()).toHaveLength(2));
    const secrets = [LONG_REG, REG, BC(1), BC(2), BC(4)];
    for (const u of urlsPushed()) for (const s of secrets) expect(u).not.toContain(s);
    expect(window.history.length).toBe(hist);
    expect(window.location.href).not.toMatch(new RegExp(secrets.join('|')));
    const stored = JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } });
    for (const s of secrets) expect(stored).not.toContain(s);
    for (const c of calls) { expect(c.url.search).toBe(''); for (const s of secrets) expect(c.url.href).not.toContain(s); }
    // bulk bodies carry ids + versions only
    expect(JSON.stringify(bulkCollects()[0]!.body)).not.toMatch(new RegExp(secrets.join('|')));
  });

  it('a hostile barcode-like value (markup/URL characters) is rejected by the kit pattern and never sent', async () => {
    await show();
    await userEvent.setup({ delay: null }).type(box(), '<img src=x onerror=alert(1)>{Enter}');
    await new Promise((r) => setTimeout(r, 30));
    expect(lookups()).toHaveLength(0);
    expect(document.body.innerHTML).not.toMatch(/<img[^>]*onerror/i);
  });

  it('API problem for a lookup shows its title only; the scanned barcode is not echoed into the page text', async () => {
    api.use(http.post(`${LAB}/specimens/lookup`, async ({ request }) => { await rec(request); return problem(404, 'common.not_found', 'Not found'); }));
    await show();
    await scan('SYN7777777');
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(await screen.findByText('No specimen with this barcode in your lab.')).toBeTruthy();
    expect(within(document.body).queryAllByText(/SYN7777777/)).toHaveLength(0);
  });
});
