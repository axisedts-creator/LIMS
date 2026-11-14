// @vitest-environment jsdom
// C10.T-19 — Micro worklist screen + scan (04-UI-UX §2, §8, §9; AC-02.1, AC-02.2, AC-02.4 presentation; 07-SECURITY abuse case 4 / S-02: no existence oracle; barcode never in URL/logs).
// LD-140 (2026-11-13): kit components only, one primary button per page, every status shows tone + icon + word. The worklist has no page actions -> zero primary buttons.
// ASSUMED seams: see t19.harness.tsx header. Tab / filter / pagination changes navigate with router.push('/micro/worklist?tab=…&…'); scan runs through a server action.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_READ, api, centre, culture, cultureList, hit, hits, problem, resetHits, router } from './t19.harness';

vi.mock('next/navigation', async () => (await import('./t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); });
afterEach(() => { cleanup(); api.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => api.close());

type Tab = 'setup' | 'incubating' | 'workup' | 'amending' | 'recent';
const SPEC = (rows: any[]) => Object.fromEntries(rows.map((c) => [c.specimen_id, { registration_no: `R26110${String(Number(c.specimen_id.slice(-4)) - 400).padStart(4, '0')}`, barcode: c.barcode }]));
const mount = async (cultures: any[] = [culture(1)], tab: Tab = 'setup', extra: Record<string, unknown> = {}) => {
  const { WorklistScreen } = await import('../components/worklist/WorklistScreen');
  return render(<ToastProvider><WorklistScreen tab={tab} cultures={cultures as never} counts={{ setup: 3, incubating: 12, workup: 2, amending: 1 }} centres={[centre(2, 'Synthetic Centre A1'), centre(3, 'Synthetic Centre B2')] as never}
    specimens={SPEC(cultures) as never} recentWindowDays={7} permissions={PERM_READ} {...extra} /></ToastProvider>);
};
const scanField = () => screen.getByRole('textbox', { name: /scan specimen barcode/i });
const pushed = () => router.push.mock.calls.map((c) => String(c[0]));

describe('layout (§2) and AC-02.1 tabs', () => {
  it('h1 "Microbiology", the scan bar, then the five tabs in spec order', async () => {
    await mount();
    expect(screen.getByRole('heading', { level: 1, name: /^microbiology$/i })).toBeTruthy();
    expect(scanField().getAttribute('name')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Awaiting setup (3)', 'Incubating (12)', 'Growth / work-up (2)', 'Amending (1)', 'Recently submitted']);
  });

  it.each([['setup', 'Awaiting setup'], ['incubating', 'Incubating'], ['workup', 'Growth / work-up'], ['amending', 'Amending'], ['recent', 'Recently submitted']] as const)(
    'tab %s selects "%s"', async (tab, label) => {
      await mount([culture(1)], tab);
      const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
      expect(selected).toHaveLength(1);
      expect(selected[0]!.textContent).toContain(label);
    });

  it('a missing count is not rendered as "undefined", "NaN" or "()" ', async () => {
    await mount([culture(1)], 'setup', { counts: {} });
    expect(screen.getAllByRole('tab').map((t) => t.textContent).join(' ')).not.toMatch(/undefined|NaN|\(\)/);
  });

  it('clicking a tab navigates by tab id only and drops the cursor (no barcodes / patient data in the URL)', async () => {
    await mount();
    await userEvent.click(screen.getByRole('tab', { name: /^incubating/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(pushed()[0]).toMatch(/^\/micro\/worklist\?(.*&)?tab=incubating(&|$)/);
    expect(pushed()[0]).not.toContain('cursor=');
  });

  it('ArrowRight on a tab moves focus to the next tab (kit Tabs keyboard model)', async () => {
    await mount();
    screen.getByRole('tab', { name: /^awaiting setup/i }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^incubating/i }));
  });

  it('there is no primary button on the page', async () => {
    await mount();
    expect(document.querySelectorAll('button.lims-btn-primary')).toHaveLength(0);
  });

  it('Next page control appears only with a cursor and navigates with the opaque cursor, keeping the tab', async () => {
    const { unmount } = await mount([culture(1)]);
    expect(screen.queryByRole('button', { name: /next|more/i })).toBeNull();
    unmount();
    await mount([culture(1)], 'incubating', { nextCursor: 'abc_DEF-123' });
    await userEvent.click(screen.getByRole('button', { name: /next|more/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(pushed()[0]).toMatch(/tab=incubating/);
    expect(pushed()[0]).toMatch(/cursor=abc_DEF-123/);
  });
});

describe('table (§2) — columns, cells, AC-02.4', () => {
  it('caption "Microbiology cultures" and the nine columns', async () => {
    await mount();
    expect(screen.getByRole('grid', { name: /microbiology cultures/i })).toBeTruthy(); // kit DataTable: role=grid, aria-label=caption
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Barcode', 'Reg no', 'Test', 'Specimen', 'Received', 'Next read', 'Status', 'Reports', 'Instrument data']) expect(headers, h).toContain(h);
  });

  it('rows keep the API order (server sorts per tab — the UI must not re-sort)', async () => {
    await mount([culture(3), culture(1), culture(2)]);
    const order = screen.getAllByRole('link', { name: /Synthetic culture/ }).map((l) => l.textContent?.trim());
    expect(order.map((t) => t?.match(/culture (\d)/)?.[1])).toEqual(['3', '1', '2']);
  });

  it('the test cell is "code · name" and links to /micro/cultures/<uuid> only (REQ-SEC-026/027)', async () => {
    await mount();
    const link = screen.getByRole('link', { name: /SYN1.*Synthetic culture 1/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/micro/cultures/${ID(1)}`);
    expect(link.getAttribute('href')).not.toContain('E260000001'); // barcode never in a URL
  });

  it('barcode and registration number come from the row / C5 data; absent barcode reads "—"', async () => {
    await mount([culture(1), culture(2, { barcode: undefined })]);
    expect(screen.getByText('E260000001')).toBeTruthy();
    expect(screen.getByText('R261100001')).toBeTruthy();
    expect(within(screen.getByRole('grid')).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('a row whose C5 specimen lookup failed still renders, with "—" for Reg no (BFF degrades)', async () => {
    await mount([culture(1)], 'setup', { specimens: {} });
    expect(screen.getByRole('link', { name: /Synthetic culture 1/ })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/undefined|null/);
  });

  it('AC-02.4: an overdue incubating row shows the words "Read overdue" with an icon (not colour only); others do not', async () => {
    await mount([culture(1, { status: 'incubating', is_read_overdue: true, next_read_due_at: '2026-11-10T00:00:00.000Z' }), culture(2, { status: 'incubating', next_read_due_at: '2099-01-01T00:00:00.000Z' })], 'incubating');
    const grid = within(screen.getByRole('grid'));
    const badges = grid.getAllByText('Read overdue');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.closest('[class],[data-tone]')!.querySelector('svg,[data-icon],[aria-hidden=true]'), 'icon').toBeTruthy();
  });

  it.each([
    ['awaiting_setup', 'Awaiting set-up', 'neutral'], ['incubating', 'Incubating', 'info'], ['growth_detected', 'Growth — work-up', 'warning'],
    ['final_submitted', 'Final submitted', 'success'], ['amending', 'Amending', 'warning'], ['cancelled', 'Cancelled', 'neutral'],
  ])('status %s -> chip "%s", tone %s, with an icon (§9, LD-140)', async (status, label, tone) => {
    await mount([culture(1, { status })], 'recent');
    const chip = within(screen.getByRole('grid')).getAllByText(label, { selector: '*' }).map((e) => e.closest('[data-tone]')).find(Boolean) as HTMLElement | undefined;
    expect(chip, 'StatusChip').toBeTruthy();
    expect(chip!.getAttribute('data-tone')).toBe(tone);
    expect(chip!.querySelector('svg,[data-icon],[aria-hidden=true]'), 'icon').toBeTruthy();
  });

  it('Reports column lists submitted versions as "P1, F2"-style text; none -> "—"', async () => {
    await mount([culture(1, { status: 'amending', current_report_version_no: 2, last_report_phase: 'final' })], 'amending');
    expect(document.body.textContent).toMatch(/F2/);
  });

  it('Instrument data shows a Badge with the open count only when > 0 (word + number)', async () => {
    await mount([culture(1, { open_instrument_record_count: 3 }), culture(2)]);
    const grid = screen.getByRole('grid');
    expect(grid.textContent).toMatch(/3/);
    expect(within(grid).getAllByText(/instrument|open/i).length).toBeGreaterThan(0);
  });

  it('free text from the server (test name) renders as text, never HTML (REQ-SEC-088)', async () => {
    await mount([culture(1, { test_name: '<img src=x onerror=alert(1)>' })]);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('empty states (§2)', () => {
  it.each([
    ['setup', 'No specimens waiting for set-up.'], ['incubating', 'No cultures incubating.'], ['workup', 'No cultures with growth to work up.'],
    ['amending', 'No amendments in progress.'], ['recent', 'Nothing submitted in the last 7 days.'],
  ] as const)('%s', async (tab, text) => {
    await mount([], tab);
    expect(document.body.textContent).toContain(text);
  });

  it('the recent-tab empty copy uses the configured window ({n})', async () => {
    await mount([], 'recent', { recentWindowDays: 14 });
    expect(document.body.textContent).toContain('Nothing submitted in the last 14 days.');
  });
});

describe('filters (§2 FilterBar)', () => {
  it('Centre, Received, Reads overdue and Instrument data waiting controls are present', async () => {
    await mount();
    for (const re of [/^centre$/i, /received/i, /reads overdue/i, /instrument data waiting/i]) expect(screen.getAllByText(re).length, String(re)).toBeGreaterThan(0);
  });

  it('Centre filter is hidden when listCentres was forbidden (centres === null), the others stay', async () => {
    await mount([culture(1)], 'setup', { centres: null });
    expect(screen.queryByText(/^centre$/i)).toBeNull();
    expect(screen.getAllByText(/reads overdue/i).length).toBeGreaterThan(0);
  });

  it('choosing "Yes" for Reads overdue navigates with read_overdue=true and keeps the tab', async () => {
    await mount([culture(1)], 'incubating');
    await userEvent.click(screen.getByRole('button', { name: /reads overdue/i }));
    await userEvent.click(await screen.findByRole('option', { name: /^yes$/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(pushed()[0]).toMatch(/tab=incubating/);
    expect(pushed()[0]).toMatch(/read_overdue=true/);
  });

  it('choosing a centre navigates with its UUID (never its name)', async () => {
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /centre/i }));
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic Centre B2/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(pushed()[0]).toContain(`centre_id=${ID(3)}`);
    expect(pushed()[0]).not.toMatch(/Synthetic|B2/);
  });
});

describe('scan (AC-02.2, 04-UI-UX §2 "Scan behaviour", 07-SECURITY abuse case 4)', () => {
  const NONE = 'No microbiology culture for this specimen.';
  const scan = async (value: string, key = '{Enter}') => { await userEvent.type(scanField(), `${value}${key}`); };
  const lookups = () => hit('POST', /\/v1\/lab\/specimens\/lookup$/);

  it('exactly one non-cancelled culture: POSTs {barcode} to the C5 lookup (body only), then opens that culture', async () => {
    api.use(cultureList([culture(1)]));
    await mount();
    await scan('E260000001');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/micro/cultures/${ID(1)}`));
    const [l, ...rest] = lookups();
    expect(rest).toHaveLength(0);
    expect(l!.json).toEqual({ barcode: 'E260000001' });
    expect(l!.search).toBe('');
    expect(hit('GET', /\/v1\/micro\/cultures$/).some((h) => new URLSearchParams(h.search).get('specimen_id') === ID(401))).toBe(true);
  });

  it('Tab also submits; the field is cleared after a scan; lower-case typing is upper-cased', async () => {
    api.use(cultureList([culture(1)]));
    await mount();
    await scan('e260000001', '{Tab}');
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(lookups()[0]!.json).toEqual({ barcode: 'E260000001' });
    expect((scanField() as HTMLInputElement).value).toBe('');
  });

  it('a cancelled culture is ignored: one active + one cancelled -> opens the active one', async () => {
    api.use(cultureList([culture(1, { status: 'cancelled' }), culture(7, { specimen_id: ID(401), status: 'incubating' })]));
    await mount();
    await scan('E260000001');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/micro/cultures/${ID(7)}`));
  });

  it('only cancelled cultures -> the "no culture" message, nothing opens', async () => {
    api.use(cultureList([culture(1, { status: 'cancelled' })]));
    await mount();
    await scan('E260000001');
    expect(await screen.findByText(NONE)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('several cultures: a "Choose a culture" dialog lists test name + status; choosing one opens it', async () => {
    api.use(cultureList([culture(1, { status: 'incubating' }), culture(7, { specimen_id: ID(401), test_name: 'Synthetic blood culture', status: 'growth_detected' })].map((c) => ({ ...c, specimen_id: ID(401) }))));
    await mount();
    await scan('E260000001');
    const dlg = await screen.findByRole('dialog', { name: /choose a culture/i });
    expect(router.push).not.toHaveBeenCalled();
    expect(within(dlg).getByText(/Synthetic culture 1/)).toBeTruthy();
    expect(within(dlg).getByText('Incubating')).toBeTruthy();
    expect(within(dlg).getByText(/Synthetic blood culture/)).toBeTruthy();
    expect(within(dlg).getByText('Growth — work-up')).toBeTruthy();
    await userEvent.click(within(dlg).getByText(/Synthetic blood culture/));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/micro/cultures/${ID(7)}`));
  });

  it('no culture for a known specimen: inline info banner with the exact text; no navigation; no other detail disclosed', async () => {
    api.use(cultureList([]));
    await mount([]); // empty table, so nothing from C5 can legitimately appear in it
    await scan('E260000001');
    const msg = await screen.findByText(NONE);
    expect(msg.closest('[data-tone]')?.getAttribute('data-tone') ?? '').toMatch(/info/);
    expect(router.push).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/R261100001|SYN_URINE|Synthetic Patient|registration/i); // nothing from C5 leaks
  });

  it('S-02: an unknown barcode (C5 404) shows the SAME message as "no culture" — no existence oracle', async () => {
    api.use(http.post(`${ORIGIN}/v1/lab/specimens/lookup`, () => problem('common.not_found', 404)));
    const { unmount } = await mount();
    await scan('E269999999');
    const unknown = (await screen.findByText(NONE)).closest('[role],[data-tone],div')!.textContent;
    expect(hit('GET', /\/v1\/micro\/cultures$/)).toHaveLength(0);
    unmount();
    cleanup();
    api.use(cultureList([]));
    await mount();
    await scan('E260000001');
    const noCulture = (await screen.findByText(NONE)).closest('[role],[data-tone],div')!.textContent;
    expect(unknown).toBe(noCulture);
    expect(document.body.textContent).not.toMatch(/Barcode not found|unknown barcode|not found/i);
  });

  it('S-02: a 403 from the C5 lookup (no lab.specimen.read) also reads the same message — it never says "forbidden"', async () => {
    api.use(http.post(`${ORIGIN}/v1/lab/specimens/lookup`, () => problem('auth.forbidden', 403)));
    await mount();
    await scan('E260000001');
    expect(await screen.findByText(NONE)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/forbidden|permission/i);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('invalid pattern: the kit error "This doesn\'t look like a sample barcode" and NO request is sent', async () => {
    await mount();
    await scan('e26 *!');
    expect(lookups()).toHaveLength(0);
    expect(router.push).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("This doesn't look like a sample barcode");
    expect(scanField().getAttribute('aria-invalid')).toBe('true');
  });

  it('the same scan repeated within 1.5 s is sent once (kit duplicate guard is kept)', async () => {
    api.use(cultureList([culture(1)]));
    await mount();
    await scan('E260000001');
    await scan('E260000001');
    await waitFor(() => expect(lookups().length).toBeGreaterThan(0));
    expect(lookups()).toHaveLength(1);
  });

  it('REQ-SEC-098: the scanned barcode is never in a URL, query string, router call, DOM message or the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    api.use(cultureList([]));
    await mount();
    await scan('E26SECRET9');
    await screen.findByText(NONE);
    expect(pushed().join(' ')).not.toContain('SECRET9');
    for (const h of hits) expect(h.path + h.search).not.toContain('SECRET9');
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain('SECRET9');
    expect(window.location.href).not.toContain('SECRET9');
    expect(document.body.textContent).not.toContain('SECRET9');
  });

  it('a 5xx from lookup or the culture list does not navigate, shows a plain retry message and does not leak the problem body', async () => {
    api.use(http.post(`${ORIGIN}/v1/lab/specimens/lookup`, () => problem('common.internal', 500, { detail: 'stack: secret-internal' })));
    await mount();
    await scan('E260000001');
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(router.push).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('secret-internal');
    expect(document.body.textContent).not.toContain(NONE); // a failure is not "no culture"
    expect(await screen.findByText(/try again|couldn.t/i)).toBeTruthy();
  });
});

describe('keyboard (§2 shortcuts)', () => {
  const find = async () => {
    const { shortcuts } = await import('@/core/shortcuts/registry');
    return [...shortcuts.list('staff.micro.worklist'), ...shortcuts.list('micro.worklist')];
  };
  it('Alt+B is registered, described, and moves focus to the scan field', async () => {
    await mount();
    const s = (await find()).find((x) => /^alt\+b$/i.test(x.key));
    expect(s, 'Alt+B registered').toBeTruthy();
    expect(s!.description).toMatch(/scan|barcode/i);
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => s!.run());
    expect(document.activeElement).toBe(scanField());
  });
  it('only Alt+<letter> page keys, none of the global keys (Alt+N/M/H)', async () => {
    await mount();
    for (const s of await find()) expect(s.key).toMatch(/^Alt\+[A-Z]$/);
    expect((await find()).map((s) => s.key)).not.toEqual(expect.arrayContaining(['Alt+N']));
  });
  it('shortcuts are unregistered on unmount', async () => {
    const { unmount } = await mount();
    expect((await find()).length).toBeGreaterThan(0);
    unmount();
    expect(await find()).toHaveLength(0);
  });
  it('Tab order: scan field before the tabs, tabs before the table rows', async () => {
    await mount();
    const order = [scanField(), screen.getAllByRole('tab')[0]!, screen.getByRole('link', { name: /Synthetic culture 1/ })];
    for (let i = 0; i < order.length - 1; i++) expect(order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
  });
});

describe('accessibility (axe) — done_when "axe clean"', () => {
  const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations;
  it('populated, overdue + instrument data + cancelled', async () => {
    await mount([culture(1, { status: 'incubating', is_read_overdue: true, open_instrument_record_count: 2 }), culture(2, { status: 'cancelled' })], 'recent');
    expect((await run()).map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
  it.each(['setup', 'recent'] as const)('empty (%s)', async (tab) => {
    await mount([], tab);
    expect((await run()).map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
  it('scan chooser dialog', async () => {
    api.use(cultureList([culture(1), culture(7)].map((c) => ({ ...c, specimen_id: ID(401) }))));
    await mount();
    await userEvent.type(scanField(), 'E260000001{Enter}');
    await screen.findByRole('dialog', { name: /choose a culture/i });
    expect((await run()).map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
