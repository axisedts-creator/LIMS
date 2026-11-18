// @vitest-environment jsdom
// T0D-UICONSOLE-1 (1) critical values and (2) instrument (ingest) exceptions (LD-353 template 2 CONSOLE, rules 5, 6, 8). Each screen renders with fake data: no rows, one row, several rows.
// CRITICAL VALUES contract (CriticalValueList({ items, status?, nextCursor? }), route /lab/critical-values, menu lab.nav.critical_values):
//   list headers exactly Age since detected, Analyte, Direction, Status (Detected at moves to the detail); the analyte stays a link to /lab/critical-values/{id}; open rows first.
//   tiles Open (status open), Acknowledged (status notified), Oldest age (the oldest OPEN row, hh:mm, a dash when none). FilterBar holds a Status filter (the URL filter the page already reads).
//   detail: analyte, direction text, status text, Detected at, a "Time to acknowledge" note (hh:mm from detection to first_confirmed_notification_at when the API sent it), History
//   (Detected, Acknowledged when notified, Closed when closed). Bar: a link to /lab/critical-values/{id} whose label ends with the shortcut "(O)". NO new action (no acknowledge, resolve, close).
//   The result value is never printed (it is shown on the detail screen, which logs the access).
// INGEST EXCEPTIONS contract (IngestExceptionList({ items, permissions, status?, nextCursor? }), route /lab/ingest-exceptions, menu lab.nav.ingest_exceptions):
//   list headers exactly Age, Barcode, Reason, Instrument code, Status; the barcode stays the link to /lab/ingest-exceptions/{id}; API order. FilterBar: Reason and Status selects (kit Select), changing one still
//   calls router.push with reason= / status= and nothing patient-linked. Tiles Open, Resolved, Oldest age (oldest open row). Detail: reason text, status, barcode, instrument code, instrument, received; History
//   (Received, Resolved or Discarded). Bar: link to the detail route labelled "...(O)". NO Re-apply / Assign / Discard here and the raw value / flags are never printed (P3, REQ-SEC-028).
// PAGES: a 501 operation_pending shows NotAvailable (h1 = menu label, no alert, the list header row stays); a 500 still throws to error.tsx; every error.tsx keeps the h1, shows the reference and Retry.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { consoleContract } from '@/__tests__/uiconsole1.contract';
import { actionBar, barActions, filterBars, hasAge, historyLabels, norm, pickItem, shortcutOf, titles } from '@/__tests__/uiconsole1.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const push = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ perms: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/x',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Lab', tenantCode: 'syn', roles: [], membershipId: '01a1a98a-ac40-7000-8000-000000000090' } }),
  getRequestPathname: async () => '/lab/x',
}));

const NOW = Date.parse('2026-11-16T06:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); cleanup(); push.mockReset(); session.perms = []; });

// ───────────────────────── critical values
const CV = (n: number) => `0c1c1c1c-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const ev = (n: number, o: Record<string, unknown> = {}) => ({ id: CV(n), analyte_code: 'K', direction: 'high', status: 'open', detected_at: ago(90), value: `9.${n}1`, flag: 'HH', ...o });
const cvOpenOld = ev(2, { analyte_code: 'KPLASMA', detected_at: ago(90) });
const cvOpenNew = ev(4, { analyte_code: 'CALCIUMX', direction: 'low', detected_at: ago(10) });
const cvClosed = ev(1, { analyte_code: 'GLUCOSEX', direction: 'low', status: 'closed', detected_at: ago(180), closed_at: ago(120), first_confirmed_notification_at: ago(150) });
const cvNotified = ev(3, { analyte_code: 'SODIUMX', direction: 'low', status: 'notified', detected_at: ago(30), first_confirmed_notification_at: ago(20) });
const cvMany = [cvClosed, cvOpenOld, cvNotified, cvOpenNew]; // API order; open rows come first
const cvMount = async (rows: readonly unknown[]) => {
  const { CriticalValueList } = await import('../components/CriticalValueList');
  return render(<ToastProvider><CriticalValueList items={rows as never} /></ToastProvider>);
};

consoleContract({
  route: '/lab/critical-values', menuKey: 'lab.nav.critical_values', headers: ['Age since detected', 'Analyte', 'Direction', 'Status'], tileLabels: ['Open', 'Acknowledged', 'Oldest age'],
  emptyText: 'No critical values.', mount: cvMount, empty: [], one: [cvOpenOld], oneId: CV(2), many: cvMany, manyIds: [CV(2), CV(4), CV(1), CV(3)],
  tilesEmpty: { Open: '0', Acknowledged: '0', 'Oldest age': '—' }, tilesOne: { Open: '1', Acknowledged: '0', 'Oldest age': { ageMin: 90 } },
  // the closed event is older (3 h) but not open: the oldest age is the oldest OPEN row
  tilesMany: { Open: '2', Acknowledged: '1', 'Oldest age': { ageMin: 90 } },
  marker: (id) => ({ [CV(2)]: 'KPLASMA', [CV(4)]: 'CALCIUMX', [CV(1)]: 'GLUCOSEX', [CV(3)]: 'SODIUMX' })[id]!,
});

describe('/lab/critical-values detail, History, bar and security', () => {
  it('the FilterBar holds a Status filter', async () => {
    const { container } = await cvMount([cvOpenOld]);
    expect(norm(filterBars(container)[0]!.textContent)).toMatch(/status/i);
  });

  it('the Age since detected cell is live-formatted hh:mm and a closed event stops at closed_at', async () => {
    const { container } = await cvMount(cvMany);
    const rowText = (code: string) => norm([...container.querySelectorAll('.lims-console-list tr')].find((r) => r.textContent?.includes(code))?.textContent);
    expect(hasAge(rowText('KPLASMA'), 90)).toBe(true);
    expect(hasAge(rowText('GLUCOSEX'), 60)).toBe(true); // 180 - 120
  });

  it('open row: direction and status as text, Detected at, a Time to acknowledge note, History = Detected', async () => {
    const { container } = await cvMount(cvMany);
    const d = pickItem(container, CV(2));
    const text = norm(d.textContent);
    expect(text).toMatch(/critical high/i);
    expect(text).toMatch(/\bopen\b/i);
    expect(text).toContain('16 Nov 2026');
    expect(text).toMatch(/time to acknowledge/i);
    expect(historyLabels(d)).toEqual(['Detected']);
  });

  it('notified row: the time to acknowledge is the gap between detection and the first confirmed notification (10 min)', async () => {
    const { container } = await cvMount(cvMany);
    const d = pickItem(container, CV(3));
    expect(norm(d.textContent)).toMatch(/time to acknowledge/i);
    expect(hasAge(d.textContent ?? '', 10)).toBe(true);
    expect(historyLabels(d)).toEqual(['Acknowledged', 'Detected']);
  });

  it('closed row: History = Detected, Acknowledged, Closed', async () => {
    const { container } = await cvMount(cvMany);
    expect(historyLabels(pickItem(container, CV(1)))).toEqual(['Acknowledged', 'Closed', 'Detected']);
  });

  it('the row keeps its link to the detail route; the sticky bar offers the same link with a shortcut in its label', async () => {
    const { container } = await cvMount(cvMany);
    const row = [...container.querySelectorAll('.lims-console-list tr')].find((r) => r.textContent?.includes('KPLASMA'))!;
    expect(within(row as HTMLElement).getByRole('link').getAttribute('href')).toBe(`/lab/critical-values/${CV(2)}`);
    pickItem(container, CV(2));
    const link = barActions(container)[0]!;
    expect(link.getAttribute('href')).toBe(`/lab/critical-values/${CV(2)}`);
    expect(shortcutOf(link), `"${link.textContent}" ends with (X)`).toBeTruthy();
  });

  it('no new action: nothing to acknowledge, resolve or close here; the result value is never printed', async () => {
    const { container } = await cvMount(cvMany);
    for (const id of [CV(2), CV(3), CV(1)]) pickItem(container, id);
    expect(screen.queryByRole('button', { name: /acknowledge|resolve|close|log notification|notify/i })).toBeNull();
    for (const r of cvMany) expect(document.body.textContent).not.toContain(String(r.value));
  });

  it('XSS: an analyte code that is markup stays text', async () => {
    const { container } = await cvMount([ev(9, { analyte_code: '<img src=x onerror=alert(1)>' })]);
    pickItem(container, CV(9));
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});

// ───────────────────────── ingest exceptions
const EX = (n: number) => `01a1a98a-ac40-7000-8000-${String(n + 500).padStart(12, '0')}`;
const exc = (n: number, o: Record<string, unknown> = {}) => ({
  id: EX(n), status: 'open', reason: 'unmapped_code', result_key: `RK${n}`, created_at: ago(120), sample_barcode: `SN000${n}`, instrument_analyte_code: `HGB${n}`, instrument_id: `ANALYSER-${n}`,
  raw_value: '13.4', raw_flags: ['H'], unit_raw: 'g/dL', ...o,
});
const exOld = exc(1, { created_at: ago(180) });
const exNew = exc(2, { reason: 'unknown_barcode', created_at: ago(90) });
const exDone = exc(3, { status: 'resolved', resolution: 'applied', resolved_at: ago(60), created_at: ago(240) });
const exDiscarded = exc(4, { status: 'discarded', resolution: 'discarded', resolved_at: ago(30), created_at: ago(100) });
const exMount = async (rows: readonly unknown[]) => {
  const { IngestExceptionList } = await import('../components/IngestExceptionList');
  return render(<ToastProvider><IngestExceptionList items={rows as never} permissions={['lab.result.enter', 'lab.worklist.read']} /></ToastProvider>);
};

consoleContract({
  route: '/lab/ingest-exceptions', menuKey: 'lab.nav.ingest_exceptions', headers: ['Age', 'Barcode', 'Reason', 'Instrument code', 'Status'], tileLabels: ['Open', 'Resolved', 'Oldest age'],
  emptyText: 'No open instrument exceptions.', mount: exMount, empty: [], one: [exOld], oneId: EX(1), many: [exOld, exNew, exDone], manyIds: [EX(1), EX(2), EX(3)],
  tilesEmpty: { Open: '0', Resolved: '0', 'Oldest age': '—' }, tilesOne: { Open: '1', Resolved: '0', 'Oldest age': { ageMin: 180 } },
  // the resolved exception is older (4 h) but not open: the oldest age is the oldest OPEN row
  tilesMany: { Open: '2', Resolved: '1', 'Oldest age': { ageMin: 180 } },
  marker: (id) => ({ [EX(1)]: 'ANALYSER-1', [EX(2)]: 'ANALYSER-2', [EX(3)]: 'ANALYSER-3' })[id]!,
});

describe('/lab/ingest-exceptions detail, History, bar, filters and security', () => {
  it('FilterBar: Reason and Status; choosing one still pushes reason= / status= with no barcode or value in the URL (REQ-SEC-028)', async () => {
    const user = userEvent.setup();
    const { container } = await exMount([exOld]);
    const bar = filterBars(container)[0]!;
    expect(norm(bar.textContent)).toMatch(/reason/i);
    expect(norm(bar.textContent)).toMatch(/status/i);
    await user.click(within(bar).getByRole('button', { name: /^reason/i }));
    await user.click(await screen.findByRole('option', { name: 'Code not mapped' }));
    expect(String(push.mock.calls.at(-1)![0])).toMatch(/reason=unmapped_code/);
    await user.click(within(bar).getByRole('button', { name: /^status/i }));
    await user.click(await screen.findByRole('option', { name: /resolved/i }));
    const target = String(push.mock.calls.at(-1)![0]);
    expect(target).toMatch(/status=resolved/);
    expect(target).not.toMatch(/SN0001|13\.4|HGB/);
  });

  it('reason is text, never the code; the row keeps its link to the detail route', async () => {
    const { container } = await exMount([exOld, exNew]);
    const row = [...container.querySelectorAll('.lims-console-list tr')].find((r) => r.textContent?.includes('SN0001')) as HTMLElement;
    expect(within(row).getByText('Code not mapped')).toBeTruthy();
    expect(row.textContent).not.toContain('unmapped_code');
    expect(within(row).getByRole('link').getAttribute('href')).toBe(`/lab/ingest-exceptions/${EX(1)}`);
  });

  it('detail shows the facts of the list row (reason, status, barcode, instrument code, instrument, received) and History = Received', async () => {
    const { container } = await exMount([exOld]);
    const d = pickItem(container, EX(1));
    const text = norm(d.textContent);
    for (const s of ['Code not mapped', 'open', 'SN0001', 'HGB1', 'ANALYSER-1', '16 Nov 2026']) expect(text, s).toContain(s);
    expect(historyLabels(d)).toEqual(['Received']);
  });

  it.each([[exDone, 'Resolved'], [exDiscarded, 'Discarded']])('History of a closed exception ends with %s', async (row, label) => {
    const { container } = await exMount([row]);
    expect(historyLabels(pickItem(container, row.id))).toEqual([label, 'Received'].sort());
  });

  it('the bar links to the detail route with a shortcut in its label', async () => {
    const { container } = await exMount([exOld]);
    pickItem(container, EX(1));
    const first = barActions(container)[0]!;
    expect(first.getAttribute('href')).toBe(`/lab/ingest-exceptions/${EX(1)}`);
    expect(shortcutOf(first)).toBeTruthy();
  });

  it('read-only list: no Re-apply / Assign / Discard, and the raw value, flags and unit are never printed (P3)', async () => {
    const { container } = await exMount([exOld]);
    pickItem(container, EX(1));
    expect(screen.queryByRole('button', { name: /re-apply|assign|discard/i })).toBeNull();
    expect(document.body.textContent).not.toContain('13.4');
    expect(document.body.textContent).not.toContain('g/dL');
    expect(actionBar(container)?.querySelectorAll('button').length ?? 0).toBe(0);
  });

  it('XSS: a barcode that is markup stays text', async () => {
    const { container } = await exMount([exc(1, { sample_barcode: '<img src=x onerror=alert(1)>' })]);
    pickItem(container, EX(1));
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getAllByText('<img src=x onerror=alert(1)>').length).toBeGreaterThan(0);
  });
});

// ───────────────────────── pages: NotAvailable, errors
const pending = (status: number) => HttpResponse.json({ type: 'about:blank', title: 'x', status, code: status === 501 ? 'operation_pending' : 'common.internal', request_id: 'req-synthetic' }, { status, headers: { 'content-type': 'application/problem+json' } });
let answer = 501;
const api = setupServer(http.all(`${ORIGIN}/*`, () => pending(answer)));
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { answer = 501; });
afterAll(() => api.close());

const PAGES = [
  ['critical values', () => import('@/app/(staff)/lab/critical-values/page'), 'lab.nav.critical_values', ['Age since detected', 'Analyte', 'Direction', 'Status'], ['lab.critical_value.read']],
  ['instrument exceptions', () => import('@/app/(staff)/lab/ingest-exceptions/page'), 'lab.nav.ingest_exceptions', ['Age', 'Barcode', 'Reason', 'Instrument code', 'Status'], []],
] as const;

describe.each(PAGES)('%s page: pending operation and failures', (_n, load, key, headers, perms) => {
  it('501 operation_pending: NotAvailable under the menu title, the list header row stays, no red error', async () => {
    session.perms = [...perms];
    const mod = await load();
    const tree = await (mod.default as (p: never) => Promise<ReactNode>)({ searchParams: Promise.resolve({}) } as never);
    const { container } = render(<ToastProvider>{tree}</ToastProvider>);
    await screen.findByText(/not available yet/i);
    expect(titles(container)).toEqual([t(key)]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toMatch(/something went wrong/i);
    expect(listHeadersAnywhere(container)).toEqual([...headers]);
  });

  it('500 is still an error: the page throws to error.tsx', async () => {
    answer = 500;
    session.perms = [...perms];
    const mod = await load();
    await expect((mod.default as (p: never) => Promise<ReactNode>)({ searchParams: Promise.resolve({}) } as never)).rejects.toBeTruthy();
  });
});
const listHeadersAnywhere = (c: HTMLElement) => [...c.querySelectorAll('thead th, [role="columnheader"]')].map((h) => norm(h.textContent));

describe.each([
  ['critical values', () => import('@/app/(staff)/lab/critical-values/error'), 'lab.nav.critical_values'],
  ['instrument exceptions', () => import('@/app/(staff)/lab/ingest-exceptions/error'), 'lab.nav.ingest_exceptions'],
])('%s error.tsx (rule 6)', (_n, load, key) => {
  it('keeps the page title, shows the reference and Retry, never the message', async () => {
    const reset = vi.fn();
    const Boundary = (await load()).default as (p: { error: Error & { digest?: string }; reset: () => void }) => ReactNode;
    const { container } = render(<Boundary error={Object.assign(new Error('boom secret detail'), { digest: 'dig-123' })} reset={reset} />);
    expect(titles(container)).toEqual([t(key)]);
    expect(document.body.textContent).toContain('dig-123');
    expect(document.body.textContent).not.toContain('boom secret detail');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
