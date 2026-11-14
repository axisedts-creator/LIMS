// @vitest-environment jsdom
// PG-T19 — Fonepay QR worksheet, route /payments/static-qr (04-UI-UX §2.5, §6, §7; 01-PRD US-PG-12 AC2–AC3; TRD §6.8, P17/P18/P19; 07-SECURITY). MSW plays the API.
// AC-PG-12.1 (createIntent fonepay ⇒ 503) is API-side (PG-T04/T13) and not a UI concern.
// ASSUMED contract (dispute via writer if wrong):
//   * features/payments/components/StaticQrView.tsx exports `StaticQrView({ worksheets, permissions, centres })`
//       worksheets = StaticQrReconDto[] (TRD §4: business_date, centre_id?, system_entries, system_total, statement_total, difference (Money), statement_reference, status, note?, reconciled_by, created_at);
//       centres = [{id,name}] ("Centre" select = those + "All centres", default All). PageHeader helpKey payments.static_qr.
//   * the system total is read from P18 GET /v1/payments/static-qr-reconciliations/preview?business_date=YYYY-MM-DD[&centre_id=] on mount and whenever date/centre change (through the BFF/server action).
//   * "Save worksheet" → P19 POST /v1/payments/static-qr-reconciliations {business_date, centre_id?, statement_total_paisa, statement_reference, note?} with an Idempotency-Key.
//   * app/(staff)/payments/static-qr/page.tsx = async `Page({ searchParams })`: GET P17.
// System clock is faked to 2026-11-12 06:00Z (= 12 Nov 11:45 Asia/Kathmandu) so "yesterday" is 11/11/2026 (DatePicker text is A.D. DD/MM/YYYY).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ORIGIN, U, axeClean, isEnabled, noRawCodes, npr, problem, recorder, wrap, type Call } from './pg-t19.helpers';

const refresh = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ current: ['payments.reconciliation.read'] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/payments/static-qr',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: perms.current, displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/payments/static-qr',
}));

const CENTRE = U(3), CENTRE_B = U(4);
const READ = ['payments.reconciliation.read'];
const RESOLVE = [...READ, 'payments.intent.resolve'];
const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }, { id: CENTRE_B, name: 'Synthetic Centre B2' }];
const sheet = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(700 + n), business_date: '2026-11-09', centre_id: CENTRE, system_entries: 3, system_total: npr(1234500), statement_total: npr(1234500), difference: npr(0),
  statement_reference: 'BANK-STMT-001', status: 'matched', reconciled_by: { membership_id: U(11), display_name: 'Synthetic Finance A' }, created_at: '2026-11-10T04:00:00.000Z', ...o,
});
const worksheets = [
  sheet(1),
  sheet(2, { business_date: '2026-11-08', centre_id: undefined, statement_total: npr(1200000), difference: npr(-34500), status: 'accepted_with_difference', statement_reference: 'BANK-STMT-002', note: 'Bank fee' }),
];

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let preview: (u: URL) => Response | Promise<Response>, save: R, listF: R;
const reset = () => {
  preview = (u) => HttpResponse.json({ business_date: u.searchParams.get('business_date'), ...(u.searchParams.get('centre_id') ? { centre_id: u.searchParams.get('centre_id') } : {}), system_entries: u.searchParams.get('centre_id') ? 1 : 3, system_total: npr(u.searchParams.get('centre_id') ? 400000 : 1234500) });
  save = () => HttpResponse.json(sheet(9), { status: 201 });
  listF = () => HttpResponse.json({ data: worksheets, page: { limit: 50 } });
};
reset();
const api = setupServer(
  http.get(`${ORIGIN}/v1/payments/static-qr-reconciliations/preview`, async ({ request }) => { await rec(request); return preview(new URL(request.url)); }),
  http.get(`${ORIGIN}/v1/payments/static-qr-reconciliations`, async ({ request }) => { await rec(request); return listF(); }),
  http.post(`${ORIGIN}/v1/payments/static-qr-reconciliations`, async ({ request }) => { await rec(request); return save(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-12T06:00:00Z')); });
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); perms.current = READ; reset(); });
afterAll(() => api.close());

const comp = async () => ((await import(/* @vite-ignore */ '../components/StaticQrView')) as { StaticQrView: (p: any) => any }).StaticQrView;
const view = async (permissions: readonly string[] = RESOLVE, data: unknown[] = worksheets) => {
  const V = await comp();
  return wrap(<V worksheets={data as never} permissions={permissions} centres={centres} />);
};
const previews = () => calls.filter((c) => c.method === 'GET' && c.url.pathname.endsWith('/preview'));
const saves = () => calls.filter((c) => c.method === 'POST');
const field = (name: RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const type = async (name: RegExp, v: string) => { const f = field(name); await userEvent.clear(f); if (v) await userEvent.type(f, v); };
const setDate = async (v: string) => { await type(/business date/i, v); await userEvent.tab(); };
const saveBtn = () => screen.queryByRole('button', { name: /save worksheet/i });
const fillOk = async (statement = '12,345.00') => { await type(/bank statement total/i, statement); await type(/statement reference/i, 'BANK-1'); };
const BANNER = 'Fonepay live payments are not available yet. Use this worksheet to compare Fonepay QR payments recorded at the counter with your bank statement.';

describe('AC-PG-12.3 copy — Fonepay is never presented as live or verified', () => {
  it('the info banner is always shown, with the exact spec text', async () => {
    await view();
    expect(screen.getByText(BANNER)).toBeTruthy();
    cleanup();
    await view(READ, []);
    expect(screen.getByText(BANNER)).toBeTruthy();
  });
  it('no "Fonepay verified", "Payment successful" or IRD claim anywhere on the screen', async () => {
    await view();
    expect(document.body.textContent).not.toMatch(/Fonepay[^.]{0,30}verified|verified[^.]{0,30}Fonepay|Payment successful|IRD[ -]approved|approved by IRD/i);
  });
});

describe('AC-PG-12.2 form (§2.5)', () => {
  it('fields: Business date (default yesterday), Centre (default "All centres"), read-only system total + entries, Bank statement total, Statement reference (≤100), Note (≤1000)', async () => {
    await view();
    expect(field(/business date/i).value).toBe('11/11/2026');
    const centre = screen.getByRole('button', { name: /centre/i });
    expect(centre.textContent).toMatch(/All centres/);
    await userEvent.click(centre);
    for (const n of ['All centres', 'Synthetic Centre A1', 'Synthetic Centre B2']) expect(await screen.findByRole('option', { name: n })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(field(/statement reference/i).maxLength).toBe(100);
    expect((screen.getByRole('textbox', { name: /note/i }) as HTMLTextAreaElement).maxLength).toBe(1000);
    expect(field(/bank statement total/i)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /^system total/i })).toBeNull(); // read-only text, not an input
  });

  it('loads the system total for the default date (P18, no centre_id for "All centres") and shows NPR + entry count', async () => {
    await view();
    await waitFor(() => expect(previews()).toHaveLength(1));
    expect(previews()[0]!.url.searchParams.get('business_date')).toBe('2026-11-11');
    expect(previews()[0]!.url.searchParams.has('centre_id')).toBe(false);
    expect(previews()[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect((await screen.findAllByText(/12,345\.00/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/3 entries/i)).toBeTruthy();
  });

  it('refreshes the system total when the date changes and when the centre changes', async () => {
    await view();
    await waitFor(() => expect(previews()).toHaveLength(1));
    await setDate('10/11/2026');
    await waitFor(() => expect(previews().some((c) => c.url.searchParams.get('business_date') === '2026-11-10')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: /centre/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Synthetic Centre A1' }));
    await waitFor(() => expect(previews().some((c) => c.url.searchParams.get('centre_id') === CENTRE)).toBe(true));
    expect((await screen.findAllByText(/4,000\.00/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 entr(y|ies)/i)).toBeTruthy();
  });

  it('Difference = statement − system, read-only, shown in text; equal totals ⇒ NPR 0.00', async () => {
    await view();
    await screen.findAllByText(/12,345\.00/);
    await type(/bank statement total/i, '12,000.00');
    await waitFor(() => expect(document.body.textContent).toMatch(/Difference[\s\S]{0,60}345\.00/));
    await type(/bank statement total/i, '12,345.00');
    await waitFor(() => expect(document.body.textContent).toMatch(/Difference[\s\S]{0,60}0\.00/));
    expect(screen.queryByRole('textbox', { name: /^difference/i })).toBeNull();
  });

  it('matching totals: saves with {business_date, statement_total_paisa, statement_reference} and NO centre_id / note; sends an Idempotency-Key and the Bearer token; refreshes', async () => {
    await view();
    await screen.findAllByText(/12,345\.00/);
    await fillOk();
    await userEvent.click(saveBtn()!);
    await waitFor(() => expect(saves()).toHaveLength(1));
    const c = saves()[0]!;
    expect(c.url.pathname).toBe('/v1/payments/static-qr-reconciliations');
    expect(c.body).toMatchObject({ business_date: '2026-11-11', statement_total_paisa: 1234500, statement_reference: 'BANK-1' });
    expect(Number.isInteger(c.body.statement_total_paisa)).toBe(true);
    expect(c.body.centre_id).toBeUndefined();
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a chosen centre is sent as centre_id', async () => {
    await view();
    await userEvent.click(screen.getByRole('button', { name: /centre/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Synthetic Centre A1' }));
    await screen.findAllByText(/4,000\.00/);
    await fillOk('4,000.00');
    await userEvent.click(saveBtn()!);
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]!.body.centre_id).toBe(CENTRE);
  });

  it('non-zero difference needs a note: nothing is sent without one, then the note is sent', async () => {
    await view();
    await screen.findAllByText(/12,345\.00/);
    await fillOk('12,000.00');
    await userEvent.click(saveBtn()!);
    expect(saves()).toHaveLength(0);
    expect(document.querySelector('[aria-invalid="true"]')).toBeTruthy();
    await userEvent.type(screen.getByRole('textbox', { name: /note/i }), 'Bank deducted a settlement fee');
    await userEvent.click(saveBtn()!);
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]!.body.note).toMatch(/settlement fee/);
    expect(saves()[0]!.body.statement_total_paisa).toBe(1200000);
  });

  it('validation: future business date, empty reference, empty statement total each send nothing', async () => {
    await view();
    await screen.findAllByText(/12,345\.00/);
    await fillOk();
    await setDate('13/11/2026'); // tomorrow
    await userEvent.click(saveBtn()!);
    expect(saves()).toHaveLength(0);
    await setDate('11/11/2026');
    await type(/statement reference/i, '');
    await userEvent.click(saveBtn()!);
    expect(saves()).toHaveLength(0);
    await type(/statement reference/i, 'BANK-1');
    await type(/bank statement total/i, '');
    await userEvent.click(saveBtn()!);
    expect(saves()).toHaveLength(0);
  });

  it('a negative or non-numeric statement total is never submitted (≥ 0, 2 decimals)', async () => {
    await view();
    await screen.findAllByText(/12,345\.00/);
    await type(/statement reference/i, 'BANK-1');
    await type(/bank statement total/i, '-5');
    await userEvent.click(saveBtn()!);
    await type(/bank statement total/i, 'abc');
    await userEvent.click(saveBtn()!);
    await type(/bank statement total/i, '1.234');
    await userEvent.click(saveBtn()!);
    expect(saves().filter((c) => c.body.statement_total_paisa < 0 || !Number.isInteger(c.body.statement_total_paisa))).toHaveLength(0);
  });

  it('409 payments.static_qr_already_reconciled ⇒ banner "This date and centre were already reconciled." (no raw code)', async () => {
    save = () => problem('payments.static_qr_already_reconciled', 409);
    await view();
    await screen.findAllByText(/12,345\.00/);
    await fillOk();
    await userEvent.click(saveBtn()!);
    expect(await screen.findByText('This date and centre were already reconciled.')).toBeTruthy();
    noRawCodes();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('400 common.validation_failed from the API ⇒ plain text, no raw code, the form keeps what was typed', async () => {
    save = () => problem('common.validation_failed', 400);
    await view();
    await screen.findAllByText(/12,345\.00/);
    await fillOk();
    await userEvent.click(saveBtn()!);
    await waitFor(() => expect(saves()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    noRawCodes();
    expect(field(/statement reference/i).value).toBe('BANK-1');
  });

  it('a double click on "Save worksheet" saves once (race / double submit)', async () => {
    save = async () => { await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json(sheet(9), { status: 201 }); };
    await view();
    await screen.findAllByText(/12,345\.00/);
    await fillOk();
    await userEvent.dblClick(saveBtn()!);
    await new Promise((r) => setTimeout(r, 250));
    expect(saves()).toHaveLength(1);
  });

  it('system total unavailable (P18 5xx) ⇒ the screen survives, shows plain text and never a raw code or a made-up total', async () => {
    preview = () => problem('common.dependency_unavailable', 503);
    await view(RESOLVE, []);
    await waitFor(() => expect(previews().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    noRawCodes();
    expect(document.body.textContent).not.toMatch(/12,345\.00|NaN|undefined/); // empty list ⇒ no amount may appear
    expect(screen.getByText(BANNER)).toBeTruthy();
  });

  it('without payments.intent.resolve the form is not submittable (Save absent or disabled) but the list is visible', async () => {
    await view(READ);
    expect(isEnabled(saveBtn())).toBe(false);
    expect(screen.getAllByText('BANK-STMT-001').length).toBeGreaterThan(0);
  });
});

describe('§2.5 worksheet list', () => {
  it('columns Date, Centre, System, Statement, Difference, Status, By', async () => {
    await view();
    const heads = screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim().toLowerCase());
    let at = -1;
    for (const w of ['date', 'centre', 'system', 'statement', 'difference', 'status', 'by']) {
      const i = heads.findIndex((h, k) => k > at && h.startsWith(w));
      expect(i, `column ${w} in ${heads.join('|')}`).toBeGreaterThan(at);
      at = i;
    }
  });

  it('rows: lakh money, centre name or "All centres", status text, names not ids', async () => {
    await view();
    const r1 = screen.getAllByRole('row').find((r) => /09\/11\/2026/.test(r.textContent ?? ''))!;
    expect(within(r1).getByText('Synthetic Centre A1')).toBeTruthy();
    expect(within(r1).getAllByText(/12,345\.00/).length).toBeGreaterThan(0);
    expect(within(r1).getByText(/Matched/i)).toBeTruthy();
    expect(r1.textContent).not.toContain(U(11));
    const r2 = screen.getAllByRole('row').find((r) => /08\/11\/2026/.test(r.textContent ?? ''))!;
    expect(within(r2).getByText(/All centres/)).toBeTruthy();
    expect(within(r2).getByText(/Accepted with difference/i)).toBeTruthy();
    expect(r2.textContent).toMatch(/345\.00/);
    expect(document.body.textContent).not.toMatch(/matched_with|accepted_with_difference/);
  });
});

describe('§6 a11y', () => {
  it('axe: no violations with rows, empty list, and with validation errors shown', async () => {
    await view();
    await screen.findAllByText(/12,345\.00/);
    await axeClean();
    await userEvent.click(saveBtn()!);
    await axeClean();
    cleanup();
    await view(RESOLVE, []);
    await axeClean();
  });
});

type SP = Record<string, string | string[] | undefined>;
const loadPage = async () => ((await import(/* @vite-ignore */ '../../../app/(staff)/payments/static-qr/page')) as { default: (p: { searchParams: Promise<SP> }) => Promise<any> }).default;
const show = async (sp: SP = {}) => { const Page = await loadPage(); return wrap(await Page({ searchParams: Promise.resolve(sp) })); };

describe('static-qr page.tsx — request (P17)', () => {
  it('no payments.reconciliation.read ⇒ not found and no API call at all', async () => {
    perms.current = [];
    await expect(show()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('GET /v1/payments/static-qr-reconciliations with the Bearer token from the session (never in the DOM); renders the banner and the list', async () => {
    perms.current = RESOLVE;
    const { container } = await show();
    const l = calls.find((c) => c.url.pathname === '/v1/payments/static-qr-reconciliations' && c.method === 'GET')!;
    expect(l).toBeTruthy();
    expect(l.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(container.innerHTML).not.toContain('jwt-synthetic');
    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(await screen.findAllByText('BANK-STMT-001')).toBeTruthy();
  });

  it('forwards only well-formed list filters (dates, centre uuid); drops tenant_id / evil / malformed', async () => {
    perms.current = RESOLVE;
    await show({ business_date_from: '2026-11-01', business_date_to: '2026-11-10', centre_id: CENTRE, evil: '1', tenant_id: 'other-tenant' });
    const q = calls.find((c) => c.url.pathname === '/v1/payments/static-qr-reconciliations' && c.method === 'GET')!.url.searchParams;
    expect(q.get('centre_id')).toBe(CENTRE);
    expect(q.has('evil')).toBe(false);
    expect(q.has('tenant_id')).toBe(false);
  });

  it.each([['business_date_from', '2026-11-1; drop'], ['business_date_to', 'yesterday'], ['centre_id', '../../etc/passwd'], ['centre_id', 'not-a-uuid']])('does not forward a malformed %s (%s)', async (key, bad) => {
    perms.current = RESOLVE;
    await show({ [key]: bad });
    for (const c of calls) { expect(c.url.searchParams.get(key)).not.toBe(bad); expect(c.url.search).not.toMatch(/drop|passwd/); }
  });

  it('API 403 shows no worksheet rows; API 5xx rejects so error.tsx renders', async () => {
    perms.current = RESOLVE;
    listF = () => problem('auth.forbidden', 403);
    try { await show(); } catch { /* may reject or render a denied state */ }
    expect(document.body.textContent).not.toMatch(/BANK-STMT-001/);
    cleanup();
    listF = () => problem('common.dependency_unavailable', 503);
    await expect(show()).rejects.toBeTruthy();
  });

  it('axe: page output has no violations', async () => { perms.current = RESOLVE; await show(); await axeClean(); });
});
