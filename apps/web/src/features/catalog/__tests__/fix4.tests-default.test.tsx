// @vitest-environment jsdom
// T0D-FIX-4 (LD-446, CR DEPLOY-AXIS-012 item 7c) — Catalog > Tests: active only by default + "Show retired" kit Switch + retired count,
// and the Price column (right aligned, same money formatter as the invoice list: NPR 1,800.00). Synthetic data only.
// Rendered through the page's default export with MSW standing in for the API (same pattern as cattests1). Contract points:
//   * no address-bar state: the list shows ACTIVE tests only; the API is never asked for retired rows unless the switch is on;
//   * a switch named /show retired/i (role=switch); toggling navigates (router.push) to an address the page honours (name is the writer's);
//   * a text with the retired count, e.g. "2 retired"; the count is of the whole filtered catalog, not of the page.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

const navLog: string[] = [];
const push = vi.fn((u: string) => { navLog.push(String(u)); });
const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: push, refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/catalog/tests',
  useSearchParams: () => new URLSearchParams(nav.search),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['catalog.test.read', 'catalog.test.manage'], displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/catalog/tests',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000f${String(n).padStart(4, '0')}`;
const HAEM = { id: ID(1), code: 'HAEM', name: 'Hematology', report_order: 10, is_active: true, version: 1, created_at: '2026-11-05T04:15:00.000Z', updated_at: '2026-11-06T09:30:00.000Z' };
type T = { id: string; kind: 'test'; code: string; name: string; department_id: string; department_code: string; workflow_type: string; is_orderable: boolean; is_active: boolean; revision: number; default_price_paisa?: number };
const mk = (n: number, code: string, name: string, o: Partial<T> = {}): T => ({ id: ID(100 + n), kind: 'test', code, name, department_id: HAEM.id, department_code: HAEM.code, workflow_type: 'standard', is_orderable: true, is_active: true, revision: 1, ...o });
const SET = [
  mk(1, 'HB', 'Hemoglobin', { default_price_paisa: 180000 }),
  mk(2, 'CBC', 'Complete blood count', { default_price_paisa: 123456789 }),
  mk(3, 'GLU', 'Glucose fasting', { default_price_paisa: 0 }),
  mk(4, 'TSH', 'Thyroid stimulating hormone'), // no price joined
  mk(5, 'HB2', 'Hemoglobin (recoded)', { is_active: false, default_price_paisa: 99900 }),
  mk(6, 'GLU2', 'Glucose (recoded)', { is_active: false }),
];
let TESTS: T[] = SET;
const listCalls: URL[] = [];
const api = setupServer(
  http.get(`${ORIGIN}/v1/catalog/tests`, ({ request }) => {
    const u = new URL(request.url); listCalls.push(u);
    const ia = u.searchParams.get('is_active') ?? 'true'; // the API default is Active only
    const rows = TESTS.filter((t) => ia === 'all' || t.is_active === (ia === 'true')).sort((a, b) => a.code.localeCompare(b.code));
    return HttpResponse.json({ data: rows, page: { limit: 50 } });
  }),
  http.get(`${ORIGIN}/v1/catalog/departments`, () => HttpResponse.json({ data: [HAEM], page: { limit: 200 } })),
  http.get(`${ORIGIN}/v1/catalog/*`, () => HttpResponse.json({ data: [], page: { limit: 200 } })),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); listCalls.length = 0; navLog.length = 0; push.mockClear(); TESTS = SET; nav.search = ''; });
afterAll(() => api.close());
beforeEach(() => { document.body.innerHTML = ''; });

async function show(search = '') {
  nav.search = search.replace(/^\?/, '');
  const Page = (await import('@/app/(staff)/catalog/tests/page')).default as (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactNode>;
  const ui = await Page({ searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(nav.search))) });
  return render(<ToastProvider>{ui}</ToastProvider>);
}
const rows = () => [...screen.getByRole('grid').querySelectorAll<HTMLTableRowElement>('tbody tr')];
const codes = () => rows().map((r) => r.cells[0]!.textContent!.trim());
const rowOf = (code: string) => rows().find((r) => r.cells[0]!.textContent!.trim() === code)!;
const priceHead = () => within(screen.getByRole('grid')).getAllByRole('columnheader').find((h) => /^price/i.test(h.textContent!.trim()))!;
const priceCell = (code: string) => { const i = [...priceHead().parentElement!.children].indexOf(priceHead()); return rowOf(code).cells[i]!; };
const retiredSwitch = () => screen.getByRole('switch', { name: /show retired/i }) as HTMLInputElement;
async function toggled(): Promise<URL> {
  const before = navLog.length;
  await userEvent.click(retiredSwitch());
  await waitFor(() => expect(navLog.length).toBeGreaterThan(before), { timeout: 4000 });
  return new URL(navLog.at(-1)!, 'http://x.test');
}

describe('item 7c: active only by default, retired behind a switch', () => {
  it('default: only active tests are listed, and the API is not asked for retired rows', async () => {
    await show();
    expect(codes()).toEqual(['CBC', 'GLU', 'HB', 'TSH']);
    expect(listCalls.every((u) => u.searchParams.get('is_active') !== 'false')).toBe(true);
    expect(rows().every((r) => !/inactive|retired/i.test(r.textContent!))).toBe(true);
  });

  it('a kit Switch "Show retired" exists, is off by default, and a text says how many tests are retired', async () => {
    await show();
    const sw = retiredSwitch();
    expect(sw.getAttribute('role')).toBe('switch'); // the kit Switch, not a bare checkbox
    expect(sw.checked).toBe(false);
    expect(screen.getByText((_, el) => el?.children.length === 0 && /\b2\b.*\bretired\b/i.test(el.textContent ?? ''))).toBeTruthy();
  });

  it('the retired count follows the data (0 retired says so, 1 says 1)', async () => {
    TESTS = SET.filter((t) => t.code !== 'GLU2');
    await show();
    expect(screen.getByText((_, el) => el?.children.length === 0 && /\b1\b.*\bretired\b/i.test(el.textContent ?? ''))).toBeTruthy();
    cleanup();
    TESTS = SET.filter((t) => t.is_active);
    await show();
    expect(screen.getByText((_, el) => el?.children.length === 0 && /\b(0|no)\b.*\bretired\b/i.test(el.textContent ?? ''))).toBeTruthy();
  });

  it('turning the switch on navigates to an address that lists the retired tests too (still reachable), marked Inactive; switch shows on', async () => {
    await show();
    const target = await toggled();
    expect(target.pathname).toBe('/catalog/tests');
    cleanup();
    await show(target.search);
    expect(codes()).toEqual(['CBC', 'GLU', 'GLU2', 'HB', 'HB2', 'TSH']);
    expect(rowOf('HB2').textContent).toMatch(/inactive/i);
    expect(retiredSwitch().checked).toBe(true);
  });

  it('turning it off again returns to active only; the switch keeps q and department in the address', async () => {
    await show(`q=hem&department_id=${HAEM.id}`);
    const on = await toggled();
    expect(on.searchParams.get('q')).toBe('hem');
    expect(on.searchParams.get('department_id')).toBe(HAEM.id);
    cleanup();
    await show(on.search);
    expect(codes()).toEqual(['HB', 'HB2']); // q=hem matches name "Hemoglobin" and "Hemoglobin (recoded)"
    const off = await toggled();
    expect(off.searchParams.get('q')).toBe('hem');
    cleanup();
    await show(off.search);
    expect(codes()).toEqual(['HB']);
    expect(retiredSwitch().checked).toBe(false);
  });

  it('an explicit Status = Inactive address still works (is_active=false lists the retired ones only)', async () => {
    await show('is_active=false');
    expect(codes()).toEqual(['GLU2', 'HB2']);
  });

  it('with only retired tests the empty state is not a dead end: the switch and the count stay on the page', async () => {
    TESTS = SET.filter((t) => !t.is_active);
    await show();
    expect(retiredSwitch()).toBeTruthy();
    expect(screen.getByText((_, el) => el?.children.length === 0 && /\b2\b.*\bretired\b/i.test(el.textContent ?? ''))).toBeTruthy();
  });
});

describe('Price column (done_when 2): right aligned, NPR with thousands separators and two decimals, invoice-list formatter', () => {
  it('formats 180000 paisa as "NPR 1,800.00"; zero as "NPR 0.00"; the invoice formatter groups lakhs; no price = empty', async () => {
    await show();
    expect(priceCell('HB').textContent!.trim()).toBe('NPR 1,800.00');
    expect(priceCell('GLU').textContent!.trim()).toBe('NPR 0.00');
    expect(priceCell('CBC').textContent!.trim()).toBe('NPR 12,34,567.89'); // billing/components/format.tsx formatNpr (lakh grouping), not a new formatter
    expect(priceCell('TSH').textContent!.trim()).toBe('');
  });

  it('the header and every price cell are right aligned (kit numeric column)', async () => {
    await show();
    expect(priceHead().className).toMatch(/lims-align-end/);
    for (const c of ['HB', 'GLU', 'CBC', 'TSH']) expect(priceCell(c).className, c).toMatch(/lims-align-end/);
  });

  it('retired rows keep the same price format', async () => {
    await show('is_active=false');
    expect(priceCell('HB2').textContent!.trim()).toBe('NPR 999.00');
  });
});
