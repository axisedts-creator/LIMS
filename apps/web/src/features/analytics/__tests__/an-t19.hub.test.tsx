// @vitest-environment jsdom
// AN-T19 — report hub (S2, reports/page.tsx), Collections history page (S2b, collections/page.tsx, route staff.analytics.collections, D-46),
// keyboard shortcuts (§2) and the finance-only user (US-08.3/.5/.6). ACs: US-08.1–.6 (UI), §4 tabs, §2 shortcuts.
// ASSUMED (same contract as an-t19.reports.test.tsx, plus):
//   * hub = reports/page.tsx with the kit `Tabs` (role=tablist) of the 12 report tabs in §4 order; tabs the session cannot use are not rendered
//     (Collections needs analytics.collections.read); selecting a tab navigates (router.push) to /analytics/reports/<code>, Collections → /analytics/collections.
//   * shortcuts register through core/shortcuts/registry under page id `staff.analytics.reports` (hub + all 11 report pages: Alt+P period, Alt+C centre,
//     Alt+E export menu (only with analytics.data.export); hub: Alt+1…Alt+9 = tab n) and `staff.analytics.collections` (Alt+P, Alt+C, Alt+E).
//   * collections page: permission analytics.collections.read ONLY (a finance user has no analytics.dashboard.read): it reads
//     GET /v1/analytics/reports/collections and filter options from GET /v1/analytics/filter-options/collections — never /v1/analytics/filter-options.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ALL, CENTRE_A, FILTER_OPTIONS, TOKEN, api, axeClean, bodies, bySlug, callsTo, calls, gridNamed, headersOf, lastRow, norm, pageText, problem, readCalls, resetApi, respond, router, rowTexts, session, shortcut, show, showOrRefuse,
} from './an-t19.harness';

vi.mock('next/navigation', async () => (await import('./an-t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi());
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const navigated = () => [...router.push.mock.calls, ...router.replace.mock.calls].map((c) => String(c[0]));
const REPORTS_PAGE = 'staff.analytics.reports';
const COLL_PAGE = 'staff.analytics.collections';
const FINANCE = ['analytics.collections.read'];
const TABS_ALL = ['Income', 'Departments', 'Collections', 'Volume', 'Referrers', 'Centres', 'Tests done', 'TAT', 'Pending tests', 'Quality', 'Delivery', 'Interfaces'];
const tabNames = () => within(screen.getByRole('tablist')).getAllByRole('tab').map((t) => norm(t.textContent));

describe('report hub — tabs (§4)', () => {
  it('renders the 12 tabs in §4 order for a user with dashboard + collections read', async () => {
    session.permissions = ['analytics.dashboard.read', 'analytics.collections.read'];
    await show('hub');
    expect(tabNames()).toEqual(TABS_ALL);
  });

  it('does not render the Collections tab without analytics.collections.read (US-08.3)', async () => {
    await show('hub');
    expect(tabNames()).toEqual(TABS_ALL.filter((t) => t !== 'Collections'));
  });

  it('a tab navigates to /analytics/reports/<code>; Collections goes to /analytics/collections (D-46)', async () => {
    session.permissions = ['analytics.dashboard.read', 'analytics.collections.read'];
    await show('hub');
    await userEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    await waitFor(() => expect(navigated()).toContain('/analytics/reports/volume'));
    await userEvent.click(screen.getByRole('tab', { name: 'Collections' }));
    await waitFor(() => expect(navigated()).toContain('/analytics/collections'));
    await userEvent.click(screen.getByRole('tab', { name: 'Quality' }));
    await waitFor(() => expect(navigated()).toContain('/analytics/reports/quality-indicators'));
  });

  it('every slug in §4 is the tab target (hyphenated report codes)', async () => {
    session.permissions = ['analytics.dashboard.read', 'analytics.collections.read'];
    await show('hub');
    const want: Record<string, string> = { Income: 'income', Departments: 'department-income', Referrers: 'top-referrers', Centres: 'top-centres', 'Tests done': 'tests-done', TAT: 'tat', 'Pending tests': 'pending-tests', Quality: 'quality-indicators', Delivery: 'delivery', Interfaces: 'interfaces' };
    for (const [tab, slug] of Object.entries(want)) {
      await userEvent.click(screen.getByRole('tab', { name: tab }));
      await waitFor(() => expect(navigated(), tab).toContain(`/analytics/reports/${slug}`));
    }
  });

  it('has no axe violations and no token in the DOM', async () => {
    const { container } = await show('hub');
    await axeClean();
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(container.innerHTML).not.toMatch(/commission/i);
  });

  it('Alt+1…Alt+9 switch to tab n (with Collections visible: 3 = Collections, 9 = Pending tests)', async () => {
    session.permissions = ['analytics.dashboard.read', 'analytics.collections.read'];
    await show('hub');
    for (let n = 1; n <= 9; n++) expect(await shortcut(REPORTS_PAGE, new RegExp(`^alt\\+${n}$`, 'i')), `Alt+${n}`).toBeTruthy();
    (await shortcut(REPORTS_PAGE, /^alt\+1$/i))!.run();
    (await shortcut(REPORTS_PAGE, /^alt\+3$/i))!.run();
    (await shortcut(REPORTS_PAGE, /^alt\+9$/i))!.run();
    expect(navigated()).toEqual(expect.arrayContaining(['/analytics/reports/income', '/analytics/collections', '/analytics/reports/pending-tests']));
  });

  it('Alt+n follows the tabs actually rendered (no Collections: 3 = Volume, 9 = Quality)', async () => {
    await show('hub');
    (await shortcut(REPORTS_PAGE, /^alt\+3$/i))!.run();
    (await shortcut(REPORTS_PAGE, /^alt\+9$/i))!.run();
    expect(navigated()).toEqual(expect.arrayContaining(['/analytics/reports/volume', '/analytics/reports/quality-indicators']));
    expect(navigated()).not.toContain('/analytics/collections');
  });

  it('shortcuts are unregistered when the page unmounts', async () => {
    await show('hub');
    expect(await shortcut(REPORTS_PAGE, /^alt\+1$/i)).toBeTruthy();
    cleanup();
    expect(await shortcut(REPORTS_PAGE, /^alt\+1$/i)).toBeUndefined();
  });
});

describe('report pages — shortcuts and filter frame (§2)', () => {
  it('Alt+P focuses the Period selector and Alt+C the Centre filter; neither clashes with a global key', async () => {
    await show('income');
    (await shortcut(REPORTS_PAGE, /^alt\+p$/i))!.run();
    expect(document.querySelector('.lims-period')!.contains(document.activeElement)).toBe(true);
    (await shortcut(REPORTS_PAGE, /^alt\+c$/i))!.run();
    expect(screen.getByRole('listbox', { name: /centre/i }).contains(document.activeElement)).toBe(true);
  });

  it('Alt+E opens the Export menu only for holders of analytics.data.export', async () => {
    await show('income');
    expect(await shortcut(REPORTS_PAGE, /^alt\+e$/i)).toBeUndefined();
    cleanup();
    session.permissions = ['analytics.dashboard.read', 'analytics.data.export'];
    await show('income');
    (await shortcut(REPORTS_PAGE, /^alt\+e$/i))!.run();
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /excel/i })).toBeTruthy());
  });

  it('Export menu offers Excel, CSV, PDF; PDF is disabled while the flag is off; choosing Excel opens the "Export report" dialog', async () => {
    session.permissions = ['analytics.dashboard.read', 'analytics.data.export'];
    await show('income');
    await userEvent.click(screen.getByRole('button', { name: /export/i }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => norm(i.textContent))).toEqual(expect.arrayContaining([expect.stringMatching(/excel/i), expect.stringMatching(/csv/i), expect.stringMatching(/pdf/i)]));
    expect(screen.getByRole('menuitem', { name: /pdf/i }).getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(screen.getByRole('menuitem', { name: /excel/i }));
    expect(await screen.findByRole('dialog', { name: 'Export report' })).toBeTruthy();
  });

  it('centre filter comes from filter-options, is capped to the caller scope, and is hidden when the user has exactly one centre', async () => {
    await show('volume');
    expect(callsTo('/v1/analytics/filter-options')).toHaveLength(1);
    expect(screen.getByRole('listbox', { name: /centre/i })).toBeTruthy();
    cleanup();
    bodies['/v1/analytics/filter-options'] = { ...FILTER_OPTIONS, centres: [FILTER_OPTIONS.centres[0]] };
    await show('volume');
    expect(screen.queryByRole('listbox', { name: /centre/i })).toBeNull();
  });

  it('choosing a centre re-queries the same page with centre_id', async () => {
    await show('volume');
    await userEvent.click(within(screen.getByRole('listbox', { name: /centre/i })).getByRole('option', { name: 'Synthetic Centre A' }));
    await waitFor(() => expect(navigated().some((u) => u.includes('/analytics/reports/volume') && u.includes(`centre_id=${CENTRE_A}`))).toBe(true));
  });
});

describe('Collections history page (S2b, US-08, D-46)', () => {
  const reader = ['analytics.collections.read'];
  const spec = bySlug('collections');

  it('finance user (collections.read only) gets the report: headers, rows, Total row, basis note', async () => {
    session.permissions = FINANCE;
    await show('collections');
    const g = gridNamed(/collection/i);
    expect(headersOf(g).slice(1)).toEqual(['Payments', 'Reversals', 'Collected', 'Reversed/refunded', 'Net collected']);
    expect(rowTexts(g)[0]).toContain('Cash');
    expect(rowTexts(g)[0]).toContain('45,000');
    expect(within(lastRow(g)).getAllByRole('rowheader').map((c) => norm(c.textContent))).toContain('Total');
    expect(norm(lastRow(g).textContent)).toContain('65,000');
    expect(pageText()).toContain('Cash basis — includes payments of earlier invoices; differs from income.');
  });

  it('uses getCollectionsFilterOptions (#30) and NEVER the dashboard filter-options (a finance user would get 403)', async () => {
    session.permissions = FINANCE;
    respond['/v1/analytics/filter-options'] = () => problem('auth.forbidden', 403);
    await show('collections');
    expect(callsTo('/v1/analytics/filter-options/collections')).toHaveLength(1);
    expect(callsTo('/v1/analytics/filter-options')).toHaveLength(0);
    expect(gridNamed(/collection/i)).toBeTruthy();
  });

  it('Method filter lists the payment methods in scope (multi-select)', async () => {
    session.permissions = FINANCE;
    await show('collections');
    const lb = screen.getByRole('listbox', { name: /method/i });
    expect(within(lb).getAllByRole('option').map((o) => norm(o.textContent))).toEqual(['Cash', 'eSewa']);
  });

  it('Group by RadioGroup [Method, Staff, Staff × method, Centre, Day, A.D. month, B.S. month]', async () => {
    session.permissions = FINANCE;
    await show('collections');
    const rg = screen.getByRole('radiogroup', { name: /group by/i });
    expect(within(rg).getAllByRole('radio').map((r) => norm(r.closest('label')?.textContent))).toEqual(['Method', 'Staff', 'Staff × method', 'Centre', 'Day', 'A.D. month', 'B.S. month']);
  });

  it('reads with the session Bearer token and only whitelisted params (group_by enum, payment_method_code list)', async () => {
    session.permissions = FINANCE;
    const { container } = await show('collections', { group_by: 'staff', payment_method_code: 'cash,esewa', evil: '1' });
    const u = readCalls()[0]!.url;
    expect(u.pathname).toBe('/v1/analytics/reports/collections');
    expect(u.searchParams.get('group_by')).toBe('staff');
    expect(u.searchParams.get('payment_method_code')).toBe('cash,esewa');
    expect(u.searchParams.has('evil')).toBe(false);
    expect(readCalls()[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it.each([['bs_month', '2083-07&centre_id=x'], ['group_by', 'evil;drop'], ['payment_method_code', 'cash;drop table'], ['centre_id', 'not-a-uuid'], ['business_date_from', '2026-1-5']])('does not forward a malformed %s (%s)', async (key, bad) => {
    session.permissions = FINANCE;
    await show('collections', { [key]: bad });
    for (const c of readCalls()) {
      expect(c.url.searchParams.get(key)).not.toBe(bad);
      expect(c.url.search).not.toMatch(/drop|centre_id=x/);
    }
  });

  it('a user WITHOUT analytics.collections.read (dashboard.read only) triggers no collections read and sees no figures (US-08.3)', async () => {
    session.permissions = ['analytics.dashboard.read'];
    const rendered = await showOrRefuse('collections');
    expect(readCalls()).toHaveLength(0);
    expect(callsTo('/v1/analytics/filter-options/collections')).toHaveLength(0);
    if (rendered) expect(pageText()).not.toMatch(/45,000|Cash basis/);
  });

  it('"Today\'s cash report and session close" links to staff.billing.daily_cash only when the user holds billing.cash_report.read (US-08.4)', async () => {
    session.permissions = [...reader, 'billing.cash_report.read'];
    bodies['/v1/analytics/reports/collections'] = { ...spec.body, daily_cash_route_id: 'staff.billing.daily_cash' };
    await show('collections');
    const link = screen.getByRole('link', { name: /Today's cash report and session close/ });
    expect(link.getAttribute('href')).toBe('/billing/daily-cash');
    cleanup();
    session.permissions = reader;
    bodies['/v1/analytics/reports/collections'] = spec.body;
    await show('collections');
    expect(screen.queryByRole('link', { name: /cash report and session close/i })).toBeNull();
    expect(pageText()).not.toContain('session close');
  });

  it('an inactive staff member keeps the name with "(inactive)" (US-08.2); labels are text, never HTML', async () => {
    session.permissions = FINANCE;
    const b = structuredClone(spec.body);
    b.rows = [{ ...b.rows[0], key: 's1', label: 'Synthetic Cashier', is_inactive: true }, { ...b.rows[0], key: 's2', label: '<img src=x onerror=alert(1)>' }];
    bodies['/v1/analytics/reports/collections'] = b;
    const { container } = await show('collections');
    expect(rowTexts(gridNamed(/collection/i))[0]).toContain('Synthetic Cashier (inactive)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('empty period: "No data for this period and filter"; 5xx rejects; 403 shows no figures', async () => {
    session.permissions = FINANCE;
    bodies['/v1/analytics/reports/collections'] = spec.empty;
    await show('collections');
    expect(pageText()).toContain('No data for this period and filter');
    cleanup();
    respond['/v1/analytics/reports/collections'] = () => problem('common.internal', 500);
    const p = show('collections');
    await expect(p).rejects.toBeTruthy();
    await expect(p).rejects.not.toThrow(/no page for report|Cannot find module/);
    respond['/v1/analytics/reports/collections'] = () => problem('auth.forbidden', 403);
    const rendered = await showOrRefuse('collections');
    if (rendered) expect(pageText()).not.toContain('45,000');
  });

  it('has no axe violations; Alt+P / Alt+C / Alt+E register under staff.analytics.collections (Alt+E only with analytics.data.export)', async () => {
    session.permissions = [...reader, 'analytics.data.export'];
    await show('collections');
    await axeClean();
    expect(await shortcut(COLL_PAGE, /^alt\+p$/i)).toBeTruthy();
    expect(await shortcut(COLL_PAGE, /^alt\+c$/i)).toBeTruthy();
    expect(await shortcut(COLL_PAGE, /^alt\+e$/i)).toBeTruthy();
    cleanup();
    session.permissions = reader;
    await show('collections');
    expect(await shortcut(COLL_PAGE, /^alt\+e$/i)).toBeUndefined();
  });
});

describe('finance-only user: only "Collections history" (US-08.6, D-46)', () => {
  // core/nav/generated.ts is gitignored (built by build-nav), so build the nav in-process with the same function and apply the shell's rule
  // (AppShell: entries filtered by permissions.includes(entry.permission); layout gate: matched route permission).
  const nav = async () => {
    const { buildNav } = await import('../../../core/nav/build-nav');
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');
    const r = await buildNav(join(root, 'apps', 'web', 'src', 'features'), readFileSync(join(root, 'contracts', 'routes.yaml'), 'utf8'));
    expect(r.errors.filter((e) => /analytics/.test(e))).toEqual([]); // other modules' manifest errors are not this task's
    return r;
  };
  const visible = (r: Awaited<ReturnType<typeof nav>>, perms: string[]) => r.entries.filter((e) => e.group === 'analytics' && perms.includes(e.permission));

  it('nav: the analytics group offers exactly Collections history → /analytics/collections', async () => {
    const v = visible(await nav(), FINANCE);
    expect(v.map((e) => e.id)).toEqual(['analytics.collections']);
    expect(v[0]!.path).toBe('/analytics/collections');
    expect(v[0]!.label).toBe('analytics.nav.collections');
  });

  it('a dashboard-only user does not get the Collections nav entry; an owner gets both', async () => {
    const r = await nav();
    expect(visible(r, ['analytics.dashboard.read']).map((e) => e.id)).not.toContain('analytics.collections');
    expect(visible(r, ALL).map((e) => e.id)).toEqual(expect.arrayContaining(['analytics.dashboard', 'analytics.reports', 'analytics.collections']));
  });

  it('the shell route gate: /analytics/collections requires analytics.collections.read, so the finance user passes and a dashboard-only user does not', async () => {
    const r = (await nav()).staff.find((x) => x.path === '/analytics/collections')!;
    expect(r.id).toBe('staff.analytics.collections');
    expect(FINANCE.includes(r.permission)).toBe(true);
    expect(['analytics.dashboard.read'].includes(r.permission)).toBe(false);
  });

  it('on the page itself, none of the other report tabs are offered to the finance user', async () => {
    session.permissions = FINANCE;
    await show('collections');
    expect(screen.queryByRole('tab', { name: 'Income' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^income$/i })).toBeNull();
    expect(calls.filter((c) => /\/reports\/(income|volume|top-)/.test(c.url.pathname))).toHaveLength(0);
  });
});
