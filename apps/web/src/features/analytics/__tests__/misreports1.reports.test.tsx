// @vitest-environment jsdom
// T0D-MISREPORTS-1 - the ten catalogue reports on the EXISTING route /analytics/reports/[reportCode] (slug = code with - for _), the hub entries, permission and gate
// states, print, CSV export request, schedule option. Spec: LD-321, LD-342 / A39 (money reports gate), LD-353 rules, brief done_when (2), (4), (5).
// PINNED BY THESE TESTS (writer / lead may overrule in a ruling; then the tests change with it):
//   * slugs: sales-representative, consultant, collection-boy, repeated-patient, repeated-test, ipd-opd, party-billing, outsource, two-level-commission, tds;
//     the page is the existing reports/[reportCode]/page.tsx; unknown slug or missing permission = notFound() BEFORE any API call (sales rep ... outsource need the
//     definition permission; the two money reports need analytics.referral_report.read and NOT analytics.dashboard.read).
//   * page title = the definition title (case free); the table header row is ALWAYS drawn: every column of the definition except the *_id columns (ids are never
//     printed), titles exactly as the contract, same order; nothing else is a column header; an empty result shows an empty state text in the body (LD-353 rule 5, 6).
//   * filters: exactly the definition params, no more: centre_id Centre, party_id Party, representative_id Representative, referrer_id Consultant|Referrer,
//     department_id Department, collector_id Collector, min_repeat_count "Minimum visits|repeat ...", visit_type "Patient type"; dates = the "Period" picker.
//     A filter is drawn even when its option list is empty (search as you type or an empty select).
//   * Print = a button named Print that calls window.print once. Export = the existing menu (button Export -> menu item CSV (.csv)) opening the existing ExportDialog
//     (the acknowledgement checkbox, then Export) -> POST /v1/analytics/exports with an Idempotency-Key, report_code, format csv and the active filters as ExportParams
//     (dates verbatim, centre_id array, the other filters inside `filters`). Without analytics.data.export there is no usable Export.
//   * Schedule option = a link named Schedule to /analytics/schedules/new, only with analytics.schedule.manage (the editor itself is covered by misreports1.schedule).
//   * Money reports (A39): when the API answers 403 common.feature_disabled the screen shows an empty state and NO column header and NO commission / TDS wording
//     at all; auth.mfa_required shows the "Verify now" banner and the same silence.
//   * The hub /analytics/reports lists every report the session may open (title -> its slug route; Bill of the Day -> /billing/bill-of-the-day).
// NOT TESTED (contract gap, notes/T0D-MISREPORTS-1-cr-needed.md): rows, totals row, cursor paging, money / bp / date cell formats of the new reports.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  API, CATALOGUE, CENTRE_A, DATE_PARAMS, FILTER_LABEL, MONEY, MONEY_WORDS, PARTY_A, PERM, TM, api, def, headers, isDisabled, norm, nonMoney, openPage, openReport, shownTitles, slugOf,
} from './misreports1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => api.close());

const re = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
const IDEM = /^[A-Za-z0-9_-]{1,64}$/;
const NOT_FOUND = 'NEXT_NOT_FOUND';
const present = (label: RegExp) => screen.queryAllByLabelText(label).length > 0 || screen.queryAllByText(label).length > 0;
const permsFor = (code: string, extra: string[] = []) => [def(code).permission, ...extra];
const closed = async (code: string, perms: string[]) => { await expect(openReport(code, perms)).rejects.toThrow(NOT_FOUND); expect(API.dataReads(), 'no read before the permission check').toEqual([]); };

describe('T0D-MISREPORTS-1 harness guard (passes now): the existing Income page opens on the same route with the same harness', () => {
  it('income: title and a header row', async () => {
    await openPage('analytics/reports/[reportCode]', { perms: [PERM.dashboard], params: { reportCode: 'income' } });
    expect(await screen.findAllByRole('columnheader')).not.toHaveLength(0);
  });
  it('an unknown slug is a 404 before any API call', async () => {
    await expect(openPage('analytics/reports/[reportCode]', { perms: [PERM.dashboard], params: { reportCode: 'no-such-report' } })).rejects.toThrow(NOT_FOUND);
    expect(API.dataReads()).toEqual([]);
  });
});

describe.each(nonMoney.map((d) => [d.code, d] as const))('T0D-MISREPORTS-1 %s', (code, d) => {
  const perms = () => permsFor(code);

  it('opens for the definition permission and titles the page with the definition title', async () => {
    await openReport(code, perms());
    expect(await screen.findByRole('heading', { name: re(d.title) })).toBeTruthy();
  });

  it('draws the header row with the contract titles (no id columns, same order) and an empty state when the result is empty (done_when 2, LD-353 rule 5)', async () => {
    await openReport(code, perms());
    await screen.findByRole('heading', { name: re(d.title) });
    const h = headers();
    const all = new Set(d.columns.map((c) => c.title));
    expect(h.filter((x) => !all.has(x)), 'headers that are not contract titles').toEqual([]);
    let at = 0;
    for (const t of shownTitles(d)) { at = h.indexOf(t, at); expect(at, `header "${t}" missing or out of order in ${JSON.stringify(h)}`).toBeGreaterThanOrEqual(0); at += 1; }
    expect(norm(document.body.textContent)).toMatch(/no data|no results|no records|nothing to show/i);
  });

  it('has exactly the filters of its definition (and the period picker)', async () => {
    await openReport(code, perms());
    await screen.findByRole('heading', { name: re(d.title) });
    expect(present(/^Period$/i) || (present(/^From/i) && present(/^To/i)), 'period picker').toBe(true);
    for (const [param, label] of Object.entries(FILTER_LABEL)) {
      if (d.params.includes(param)) expect(present(label), `${code}: filter ${param} (${label})`).toBe(true);
      else expect(screen.queryAllByLabelText(label), `${code}: ${param} is not a param of the definition`).toHaveLength(0);
    }
    expect(d.params.filter((p) => !DATE_PARAMS.includes(p) && !(p in FILTER_LABEL)), 'the harness knows every param of the definition').toEqual([]);
  });

  it('is closed without its permission: notFound before any API call (a wrong permission is as good as none)', async () => {
    await closed(code, []);
    await closed(code, [PERM.export, PERM.schedule]);
    await closed(code, [d.permission === PERM.dashboard ? PERM.collections : PERM.dashboard]);
  });

  it('Print is a button that calls window.print once', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await openReport(code, perms());
    await userEvent.click(await screen.findByRole('button', { name: /^print/i }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('CSV export: Export menu -> CSV -> acknowledgement -> POST /v1/analytics/exports with the report code, csv, an Idempotency-Key and the active filters as ExportParams', async () => {
    const search = new URLSearchParams({ business_date_from: '2026-11-01', business_date_to: '2026-11-30', centre_id: CENTRE_A });
    const filters: Record<string, unknown> = {};
    for (const p of d.params) {
      if (p === 'visit_type') { search.set(p, 'ipd'); filters[p] = 'ipd'; }
      else if (p === 'min_repeat_count') { search.set(p, '3'); filters[p] = 3; }
      else if (['party_id', 'representative_id', 'collector_id', 'referrer_id', 'department_id'].includes(p)) { search.set(p, PARTY_A); filters[p] = [PARTY_A]; }
    }
    await openReport(code, [...perms(), PERM.export], search.toString());
    await userEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /csv/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /keep this file inside the lab/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(API.exports()).toHaveLength(1));
    const c = API.exports()[0]!;
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    expect(c.json.report_code).toBe(code);
    expect(c.json.format).toBe('csv');
    expect(c.json.params).toMatchObject({ business_date_from: '2026-11-01', business_date_to: '2026-11-30' });
    expect([c.json.params.centre_id].flat()).toEqual([CENTRE_A]);
    if (Object.keys(filters).length) expect({ ...c.json.params, ...(c.json.params.filters ?? {}) }).toMatchObject(filters);
    expect(JSON.stringify(c.json.params)).not.toMatch(/cursor/);
  });

  it('without analytics.data.export there is no usable Export; with analytics.schedule.manage there is a Schedule link, without it none', async () => {
    await openReport(code, perms());
    await screen.findByRole('heading', { name: re(d.title) });
    const b = screen.queryByRole('button', { name: /^export$/i });
    expect(!b || isDisabled(b), 'Export hidden or disabled').toBe(true);
    expect(screen.queryByRole('link', { name: /schedule/i })).toBeNull();
    cleanup();
    await openReport(code, [...perms(), PERM.schedule]);
    const l = await screen.findByRole('link', { name: /schedule/i });
    expect(l.getAttribute('href') ?? '').toMatch(/^\/analytics\/schedules\/new/);
  });
});

describe.each(MONEY.map((c) => [c, def(c)] as const))('T0D-MISREPORTS-1 %s (A39 / LD-342: reports only, behind the flag and analytics.referral_report.read)', (code, d) => {
  const perms = [PERM.referral];

  it('opens for analytics.referral_report.read alone and draws the contract header row', async () => {
    await openReport(code, perms);
    expect(await screen.findByRole('heading', { name: re(d.title) })).toBeTruthy();
    const h = headers();
    let at = 0;
    for (const t of shownTitles(d)) { at = h.indexOf(t, at); expect(at, `header "${t}" in ${JSON.stringify(h)}`).toBeGreaterThanOrEqual(0); at += 1; }
  });

  it('is closed for analytics.dashboard.read / collections.read / export / schedule without analytics.referral_report.read: notFound before any API call', async () => {
    await closed(code, [PERM.dashboard]);
    await closed(code, [PERM.dashboard, PERM.collections, PERM.export, PERM.schedule]);
    await closed(code, []);
  });

  it('flag off (403 common.feature_disabled): an empty state, no column header, and no commission / TDS wording anywhere on the screen', async () => {
    API.readFail = { status: 403, code: 'common.feature_disabled' };
    await openReport(code, perms);
    await waitFor(() => expect(screen.getAllByRole('heading').length).toBeGreaterThan(0));
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    expect(norm(document.body.textContent) + ' ' + [...document.body.querySelectorAll('[title],[aria-label]')].map((e) => e.getAttribute('title') ?? e.getAttribute('aria-label')).join(' ')).not.toMatch(MONEY_WORDS);
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
  });

  it('aal1 (403 auth.mfa_required): the "Verify now" banner, no column header, no commission / TDS wording', async () => {
    API.readFail = { status: 403, code: 'auth.mfa_required' };
    await openReport(code, perms);
    expect(await screen.findByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    expect(norm(document.body.textContent)).not.toMatch(MONEY_WORDS);
  });

  it('export and schedule need their own permission on top: with referral + export the CSV request names the code; with referral alone there is no usable Export and no Schedule link', async () => {
    await openReport(code, perms);
    await screen.findByRole('heading', { name: re(d.title) });
    const b = screen.queryByRole('button', { name: /^export$/i });
    expect(!b || isDisabled(b)).toBe(true);
    expect(screen.queryByRole('link', { name: /schedule/i })).toBeNull();
    cleanup();
    await openReport(code, [...perms, PERM.export, PERM.schedule], 'business_date_from=2026-11-01&business_date_to=2026-11-30');
    await userEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /csv/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /keep this file inside the lab/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(API.exports()).toHaveLength(1));
    expect(API.exports()[0]!.json.report_code).toBe(code);
    expect((await screen.findByRole('link', { name: /schedule/i })).getAttribute('href') ?? '').toMatch(/^\/analytics\/schedules\/new/);
  });

  it('an export refused by the gate (403 common.feature_disabled) shows a plain failure and no commission / TDS wording leaks into the dialog', async () => {
    await openReport(code, [...perms, PERM.export]);
    API.exportFail = { status: 403, code: 'common.feature_disabled' };
    await userEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /csv/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /keep this file inside the lab/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(API.exports()).toHaveLength(1));
    const after = norm((await screen.findByRole('dialog')).textContent);
    expect(after).toMatch(/failed|try again|not available|not enabled|no longer/i);
    expect(after).not.toMatch(MONEY_WORDS);
  });
});

describe('T0D-MISREPORTS-1 the hub /analytics/reports lists the new reports the session may open (done_when 2: from the existing catalogue)', () => {
  const HUB = 'analytics/reports';
  const hubSlug = (c: string) => (c === 'bill_of_the_day' ? '/billing/bill-of-the-day' : `/analytics/reports/${slugOf(c)}`);
  const target = async (title: string) => {
    const el = screen.getAllByText(re(title))[0]!;
    const href = el.closest('a')?.getAttribute('href');
    if (href) return href;
    TM.push.mockClear();
    await userEvent.click(el);
    return String(TM.push.mock.calls.at(-1)?.[0] ?? '');
  };

  it.each([...CATALOGUE.map((d) => [d.code, d] as const), ['bill_of_the_day', def('bill_of_the_day')] as const])('%s: listed for a session with its permission, and it opens its route', async (code, d) => {
    await openPage(HUB, { perms: [PERM.dashboard, PERM.collections, PERM.referral], path: '/analytics/reports' });
    await screen.findAllByRole('columnheader');
    expect(screen.queryAllByText(re(d.title)).length, `${d.title} is listed`).toBeGreaterThan(0);
    expect(await target(d.title)).toContain(hubSlug(code));
  });

  it('a session with only analytics.dashboard.read sees none of the collections or money reports; one with only collections.read sees no dashboard report', async () => {
    await openPage(HUB, { perms: [PERM.dashboard], path: '/analytics/reports' });
    await screen.findAllByRole('columnheader');
    for (const d of [...CATALOGUE, def('bill_of_the_day')].filter((x) => x.permission !== PERM.dashboard)) expect(screen.queryAllByText(re(d.title)), d.code).toHaveLength(0);
    for (const d of nonMoney.filter((x) => x.permission === PERM.dashboard)) expect(screen.queryAllByText(re(d.title)).length, d.code).toBeGreaterThan(0);
  });

  it('the 12 report tabs stay as they are (an-t19.hub pins the tablist): the new reports are listed OUTSIDE the tablist, as links', async () => {
    await openPage(HUB, { perms: [PERM.dashboard, PERM.collections, PERM.referral], path: '/analytics/reports' });
    await screen.findAllByRole('columnheader');
    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(12);
    for (const d of [...CATALOGUE, def('bill_of_the_day')]) {
      const l = screen.queryAllByRole('link', { name: re(d.title) });
      expect(l.length, `${d.title} link`).toBeGreaterThan(0);
      expect(l[0]!.getAttribute('href') ?? '').toContain(hubSlug(d.code));
    }
  });

  it('the hub never offers the money reports without analytics.referral_report.read, and the word commission is absent from the whole hub then', async () => {
    await openPage(HUB, { perms: [PERM.dashboard, PERM.collections, PERM.export], path: '/analytics/reports' });
    await screen.findAllByRole('columnheader');
    expect(norm(document.body.textContent)).not.toMatch(MONEY_WORDS);
  });
});

describe('T0D-MISREPORTS-1 ids never reach the screen', () => {
  it('no header or text on a catalogue report shows a raw UUID or an id column title', async () => {
    await openReport('sales_representative', [PERM.dashboard]);
    await screen.findByRole('heading', { name: /sales representative/i });
    expect(norm(document.body.textContent)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    expect(headers().filter((x) => /\bid$/i.test(x))).toEqual([]);
  });
});
