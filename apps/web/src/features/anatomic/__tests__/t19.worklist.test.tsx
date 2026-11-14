// @vitest-environment jsdom
// C11.T-19 — Worklist screen (04-UI-UX §2 scanner, §3 shortcuts, §4.1; 03-APP-FLOW §4.1; AC-13.1, AC-13.4; REQ-SEC-098 label never in a URL / log).
// LD-140 (2026-11-13): kit components only, one primary button per page, every status shows tone + icon + word. Worklist has no page actions -> zero primary buttons.
// ASSUMED seams: see t19.harness.tsx header. Tab / pagination changes navigate with router.push('/anatomic?queue=…[&cursor=…]'); lookup runs through a server action that POSTs /v1/anatomic/cases/lookup.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_READ, api, flags, hit, hits, problem, resetHits, router, summary } from './t19.harness';

vi.mock('next/navigation', async () => (await import('./t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); });
afterEach(() => { cleanup(); api.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => api.close());

type Q = 'to_accession' | 'grossing' | 'bench' | 'reporting' | 'awaiting_lab' | 'signed_out' | 'cancelled' | 'all';
const mount = async (cases: unknown[] = [summary(1)], queue: Q = 'to_accession', extra: Record<string, unknown> = {}) => {
  const { WorklistScreen } = await import('../components/WorklistScreen');
  return render(<ToastProvider><WorklistScreen queue={queue} cases={cases as never} permissions={PERM_READ} {...extra} /></ToastProvider>);
};
const lookup = () => screen.getByRole('textbox', { name: /scan or type an accession, block or slide label/i });
const pushed = () => router.push.mock.calls.map((c) => String(c[0]));

describe('layout (§4.1)', () => {
  it('h1 "Pathology cases", the lookup field, then the eight queue tabs in order', async () => {
    await mount();
    expect(screen.getByRole('heading', { level: 1, name: /^pathology cases$/i })).toBeTruthy();
    expect(lookup().getAttribute('name')).toBe('label');
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, '').trim())).toEqual(
      ['To accession', 'Grossing', 'Bench', 'Reporting', 'Awaiting lab approval', 'Signed out', 'Cancelled', 'All']);
  });

  it.each([
    ['to_accession', 'To accession'], ['grossing', 'Grossing'], ['bench', 'Bench'], ['reporting', 'Reporting'],
    ['awaiting_lab', 'Awaiting lab approval'], ['signed_out', 'Signed out'], ['cancelled', 'Cancelled'], ['all', 'All'],
  ] as const)('queue %s selects the "%s" tab', async (queue, label) => {
    await mount([summary(1)], queue);
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain(label);
  });

  it('clicking a tab navigates by queue id only (no labels / patient data in the URL)', async () => {
    await mount();
    await userEvent.click(screen.getByRole('tab', { name: /^grossing/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(pushed()[0]).toMatch(/^\/anatomic\?(.*&)?queue=grossing(&|$)/);
  });

  it('tab badge = row count of the current tab only (no extra count calls, 02-CV §4.3)', async () => {
    await mount([summary(1), summary(2)], 'grossing');
    expect(screen.getByRole('tab', { name: /^grossing/i }).textContent).toMatch(/2/);
    expect(screen.getByRole('tab', { name: /^bench/i }).textContent).not.toMatch(/\d/);
    expect(hits).toHaveLength(0);
  });

  it('FilterBar exposes case kind, centre, priority, pathologist and received controls', async () => {
    await mount();
    for (const re of [/case kind/i, /centre/i, /priority/i, /pathologist/i, /received/i]) expect(screen.getAllByText(re).length, String(re)).toBeGreaterThan(0);
  });

  it('there is no primary button on the page (header actions: none)', async () => {
    await mount();
    expect(document.querySelectorAll('button.lims-btn-primary')).toHaveLength(0);
  });
});

describe('table (§4.1) and AC-13.1 presentation', () => {
  it('columns: Accession, Patient, Kind, Tests, Parts, Received, Priority, Status, Pathologist; caption "Pathology cases"', async () => {
    await mount();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Accession', 'Patient', 'Kind', 'Tests', 'Parts', 'Received', 'Priority', 'Status', 'Pathologist']) expect(headers, h).toContain(h);
    expect(screen.getByRole('grid', { name: /pathology cases/i })).toBeTruthy(); // LD-140 kit DataTable: role=grid, aria-label=caption
  });

  it('rows keep the API order (server sorts urgent first, then oldest — the UI must not re-sort)', async () => {
    const rows = [summary(3, { priority: 'urgent', received_at: '2026-11-09T01:00:00.000Z' }), summary(1, { received_at: '2026-11-08T01:00:00.000Z' }), summary(2, { received_at: '2026-11-10T01:00:00.000Z' })];
    await mount(rows);
    const order = screen.getAllByRole('link', { name: /^SP26-/ }).map((l) => l.textContent);
    expect(order).toEqual(['SP26-000003', 'SP26-000001', 'SP26-000002']);
  });

  it('urgent shows the word "Urgent" (danger tone), routine shows no badge', async () => {
    await mount([summary(1, { priority: 'urgent' }), summary(2)]);
    const badge = within(screen.getByRole('grid')).getByText('Urgent', { selector: '*' });
    expect(badge.closest('[data-tone]')?.getAttribute('data-tone') ?? badge.className).toMatch(/danger/);
    expect(within(screen.getByRole('grid')).getAllByText('Urgent')).toHaveLength(1); // the priority filter option "Urgent" is outside the grid
  });

  it('accession is a link to /anatomic/cases/<uuid> (REQ-SEC-026/027); un-accessioned case reads "Not accessioned"', async () => {
    await mount([summary(1), summary(2, { accession_no: undefined })]);
    const link = screen.getByRole('link', { name: 'SP26-000001' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/anatomic/cases/${ID(1)}`);
    expect(screen.getByText('Not accessioned')).toBeTruthy();
  });

  it('patient cell: name, then age/sex and patient code; "—" pathologist when none, name when assigned', async () => {
    await mount([summary(1, { assigned_pathologist: { membership_id: ID(5), display_name: 'Synthetic Doctor' } }), summary(2)]);
    expect(screen.getByText('Synthetic Patient 1')).toBeTruthy();
    expect(document.body.textContent).toContain('41 y');
    expect(document.body.textContent).toContain('PC-1');
    expect(screen.getByText('Synthetic Doctor')).toBeTruthy();
    expect(document.body.textContent).toContain('—');
  });

  it('patient block is omitted gracefully when the API omits `patient` (no frontdesk.patient.read)', async () => {
    await mount([summary(1, { patient: undefined })]);
    expect(screen.getByRole('link', { name: 'SP26-000001' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/undefined|null/);
  });

  it.each([
    ['received', 'Received', 'neutral'], ['accessioned', 'Accessioned', 'info'], ['in_processing', 'In processing', 'info'],
    ['ready_for_reporting', 'Ready for reporting', 'warning'], ['signed_out', 'Signed out', 'success'], ['cancelled', 'Cancelled', 'neutral'],
  ])('status %s -> chip "%s", tone %s, with an icon (LD-140, §2)', async (status, label, tone) => {
    await mount([summary(1, { status })], 'all');
    const chip = within(screen.getByRole('grid')).getAllByText(label, { selector: '*' }).map((e) => e.closest('[data-tone]')).find(Boolean) as HTMLElement | undefined;
    expect(chip, 'StatusChip').toBeTruthy();
    expect(chip!.getAttribute('data-tone')).toBe(tone);
    expect(chip!.querySelector('svg,[data-icon],[aria-hidden=true]'), 'icon').toBeTruthy();
  });

  it('flags carry words: Profile missing, Specimen rejected, Change open, Stains pending 2', async () => {
    await mount([summary(1, { flags: flags({ profile_missing: true, specimen_rejected: true, open_change: true, pending_stain_orders: 2 }) })]);
    const text = document.body.textContent ?? '';
    const labels = Array.from(document.querySelectorAll('[aria-label],[title]')).map((e) => `${e.getAttribute('aria-label')} ${e.getAttribute('title')}`).join(' ');
    for (const re of [/profile missing/i, /specimen rejected/i, /change open/i, /stains pending 2/i]) expect(re.test(text) || re.test(labels), String(re)).toBe(true);
  });

  it('free text from the server (patient, tests) renders as text, never HTML (REQ-SEC-088)', async () => {
    await mount([summary(1, { patient: { display_name: '<img src=x onerror=alert(1)>', sex: 'F', age_text: '1 y', patient_code: 'PC' }, test_names: ['<script>alert(2)</script>'] })]);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('Next page control appears only with a cursor and navigates with the opaque cursor', async () => {
    const { unmount } = await mount([summary(1)]);
    expect(screen.queryByRole('button', { name: /next|more/i })).toBeNull();
    unmount();
    await mount([summary(1)], 'to_accession', { nextCursor: 'abc_DEF-123' });
    await userEvent.click(screen.getByRole('button', { name: /next|more/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(pushed()[0]).toMatch(/cursor=abc_DEF-123/);
  });
});

describe('empty states (§4.1)', () => {
  it.each([
    ['to_accession', 'Nothing to accession', 'New cases appear here when the lab receives a histology, cytology or molecular specimen.'],
    ['grossing', 'No cases waiting for gross description.', ''],
    ['bench', 'No slides or stain orders pending.', ''],
    ['reporting', 'No cases ready for reporting.', ''],
  ] as const)('%s', async (queue, head, body) => {
    await mount([], queue);
    expect(document.body.textContent).toContain(head);
    if (body) expect(document.body.textContent).toContain(body);
    expect(screen.queryByRole('button', { name: /reset filters/i })).toBeNull();
  });

  it.each(['signed_out', 'cancelled', 'all'] as const)('%s: "No cases match these filters." with [Reset filters] that clears filter params', async (queue) => {
    await mount([], queue);
    expect(document.body.textContent).toContain('No cases match these filters.');
    await userEvent.click(screen.getByRole('button', { name: /^reset filters$/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(pushed()[0]).toMatch(new RegExp(`^/anatomic\\?queue=${queue}$`));
  });
});

describe('lookup / scanner (§2, 03-APP-FLOW §4.1.3; AC-13.4)', () => {
  const scan = async (value: string, key = '{Enter}') => { await userEvent.type(lookup(), `${value}${key}`); };

  it('AC-13.4: scanning an accession number (Enter) POSTs {label} to /cases/lookup and opens the case', async () => {
    await mount();
    await scan('SP26-000123');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/anatomic/cases/${ID(1)}`));
    const [h, ...rest] = hit('POST', /\/v1\/anatomic\/cases\/lookup$/);
    expect(rest).toHaveLength(0);
    expect(h!.json).toEqual({ label: 'SP26-000123' });
    expect(h!.search).toBe('');
  });

  it('Tab also submits (submitKeys Enter + Tab); the field is cleared after a scan', async () => {
    await mount();
    await scan('SP26-000124', '{Tab}');
    await waitFor(() => expect(hit('POST', /lookup$/)).toHaveLength(1));
    expect((lookup() as HTMLInputElement).value).toBe('');
  });

  it('hyphenated labels are valid (pattern /^[A-Z0-9-]{1,32}$/, not the C5 default); lower-case typing is upper-cased', async () => {
    await mount();
    await scan('sp26-000123');
    await waitFor(() => expect(hit('POST', /lookup$/)).toHaveLength(1));
    expect(hit('POST', /lookup$/)[0]!.json).toEqual({ label: 'SP26-000123' });
  });

  it('manual typing is allowed (allowManual) — a person can type a label and press Enter', async () => {
    await mount();
    const input = lookup();
    await userEvent.type(input, 'SP26-000125', { delay: 40 });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(hit('POST', /lookup$/)).toHaveLength(1));
  });

  it.each([
    ['block', { object_kind: 'block', case_id: ID(1), block_id: ID(7) }, `/anatomic/cases/${ID(1)}?block=${ID(7)}`],
    ['slide', { object_kind: 'slide', case_id: ID(1), slide_id: ID(8) }, `/anatomic/cases/${ID(1)}?slide=${ID(8)}`],
  ])('a %s label opens its case with that object highlighted by id (never by label)', async (_k, body, url) => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, () => HttpResponse.json(body)));
    await mount();
    await scan('SP26-000123-A1');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(url));
  });

  it('REQ-SEC-098: the scanned value is never in a URL, a query string, router calls or the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await mount();
    await scan('SP26-SECRET1');
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(pushed().join(' ')).not.toContain('SECRET1');
    for (const h of hits) { expect(h.path + h.search).not.toContain('SECRET1'); }
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain('SECRET1');
    expect(window.location.href).not.toContain('SECRET1');
  });

  it('not found: inline "No case, block or slide with this label." and no navigation', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, () => problem('common.not_found', 404)));
    await mount();
    await scan('SP26-999999');
    expect(await screen.findByText('No case, block or slide with this label.')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('This is a sample barcode');
  });

  it('a 404 for a value that matches the C5 specimen-barcode charset shows the sample-barcode hint (anatomic.scan.specimen_barcode)', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, () => problem('common.not_found', 404)));
    await mount();
    await scan('ABC12345');
    expect(await screen.findByText(/This is a sample barcode\. Receive samples in Lab → Specimens; pathology cases appear here after receipt\./)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('a value outside the label pattern is rejected in the browser: no request is sent', async () => {
    await mount();
    await scan('sp 26*!');
    expect(hit('POST', /lookup$/)).toHaveLength(0);
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: /scan or type/i }).getAttribute('aria-invalid')).toBe('true');
  });

  it('the same scan repeated within 1.5 s is sent once (kit duplicate guard is kept)', async () => {
    await mount();
    await scan('SP26-000130');
    await scan('SP26-000130');
    await waitFor(() => expect(hit('POST', /lookup$/).length).toBeGreaterThan(0));
    expect(hit('POST', /lookup$/)).toHaveLength(1);
  });

  it('403 / 5xx from lookup do not navigate and do not leak the raw problem body', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, () => problem('common.internal', 500, { detail: 'stack: secret-internal' })));
    await mount();
    await scan('SP26-000131');
    await waitFor(() => expect(hit('POST', /lookup$/)).toHaveLength(1));
    expect(router.push).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('secret-internal');
  });
});

describe('keyboard (§3) — walk-through', () => {
  it('Alt+F is registered on staff.anatomic.worklist, described, and moves focus to the lookup field', async () => {
    const { shortcuts } = await import('@/core/shortcuts/registry');
    await mount();
    const s = shortcuts.list('staff.anatomic.worklist').find((x) => /^alt\+f$/i.test(x.key));
    expect(s, 'Alt+F registered').toBeTruthy();
    expect(s!.description).toMatch(/lookup|scan|find/i);
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => s!.run());
    expect(document.activeElement).toBe(lookup());
  });

  it('only Alt+<letter> page keys; none of the global keys (Alt+N/M/H, ?, Escape) and no Alt+<digit>, `/` or Ctrl+S (§3)', async () => {
    const { shortcuts } = await import('@/core/shortcuts/registry');
    await mount();
    for (const s of shortcuts.list('staff.anatomic.worklist')) expect(s.key).toMatch(/^Alt\+[A-Z]$/);
    expect(shortcuts.list('staff.anatomic.worklist').map((s) => s.key)).not.toEqual(expect.arrayContaining(['Alt+N']));
  });

  it('shortcut is unregistered on unmount', async () => {
    const { shortcuts } = await import('@/core/shortcuts/registry');
    const { unmount } = await mount();
    expect(shortcuts.list('staff.anatomic.worklist').length).toBeGreaterThan(0);
    unmount();
    expect(shortcuts.list('staff.anatomic.worklist')).toHaveLength(0);
  });

  it('Tabs use the arrow-key model: ArrowRight from the selected tab moves focus to the next tab', async () => {
    await mount();
    const first = screen.getByRole('tab', { name: /^to accession/i });
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^grossing/i }));
  });

  it('Tab order: lookup field comes before the tabs, tabs before the table rows', async () => {
    await mount();
    const order = [lookup(), screen.getAllByRole('tab')[0]!, screen.getByRole('link', { name: 'SP26-000001' })];
    for (let i = 0; i < order.length - 1; i++) expect(order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
  });
});

describe('accessibility (axe)', () => {
  const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations;
  it('populated', async () => {
    await mount([summary(1, { priority: 'urgent', flags: flags({ open_change: true, pending_stain_orders: 1 }) }), summary(2, { accession_no: undefined })], 'all');
    expect((await run()).map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
  it.each(['to_accession', 'all'] as const)('empty (%s)', async (queue) => {
    await mount([], queue);
    expect((await run()).map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
