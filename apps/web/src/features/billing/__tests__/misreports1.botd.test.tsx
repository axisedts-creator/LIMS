// @vitest-environment jsdom
// T0D-MISREPORTS-1 done_when 3: Bill of the Day, its own compact screen at /billing/bill-of-the-day (route staff.billing.bill_of_the_day, permission
// analytics.collections.read), definition `bill_of_the_day` of contracts/openapi/analytics.yaml. LD-353 rules (LIST template), LD-321.
// PINNED BY THESE TESTS (writer / lead may overrule in a ruling; then the tests change with it):
//   * page title Bill Of The Day (case free); closed (notFound before any API call) without analytics.collections.read, also with analytics.dashboard.read alone;
//   * a native day picker (<input type="date">) labelled "Day" or "Business date": it holds the business_date of the URL (business_date_from = business_date_to = the day,
//     both inclusive, like the contract example), defaults to a date when the URL has none, and changing it navigates with both params set to the new day;
//   * filters of the definition and no others: Centre and Party;
//   * the bill list header row is always drawn: Invoice number, Billed at, Gross, Discount, Net, Paid, Due in this order (the *_id columns are not printed), with an empty
//     state in the body; a second table "totals by payment mode" draws its header (Payment mode, Amount) even when empty;
//   * Print button -> window.print once (the print stylesheet is checked in misreports1.source); Export menu -> CSV -> existing ExportDialog -> POST /v1/analytics/exports
//     (report_code bill_of_the_day, csv, Idempotency-Key, the day, centre_id as an array); Export needs analytics.data.export; Schedule link to /analytics/schedules/new
//     needs analytics.schedule.manage.
// NOT TESTED (contract gap, notes/T0D-MISREPORTS-1-cr-needed.md): the rows, the amounts, the totals by payment mode (the definition has no payment mode column and no read
// operation exists), paging, one page print layout in a browser.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { API, BOTD_PAGE, CENTRE_A, PERM, TM, api, headers, isDisabled, norm, openPage } from '../../analytics/__tests__/misreports1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => api.close());

const DAY = '2026-11-17';
const SEARCH = `business_date_from=${DAY}&business_date_to=${DAY}`;
const open = (perms: string[], search = SEARCH) => openPage(BOTD_PAGE, { perms, search, path: '/billing/bill-of-the-day' });
const READ = [PERM.collections];
const title = () => screen.findByRole('heading', { name: /^bill of the day$/i });
const IDEM = /^[A-Za-z0-9_-]{1,64}$/;

describe('T0D-MISREPORTS-1 Bill of the Day: access', () => {
  it.each([[[]], [[PERM.dashboard]], [[PERM.export, PERM.schedule]]])('closed for %j: notFound before any API call', async (perms) => {
    await expect(open(perms)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(API.calls).toEqual([]);
  });
  it('opens for analytics.collections.read alone, titled Bill Of The Day', async () => {
    await open(READ);
    expect(await title()).toBeTruthy();
  });
});

describe('T0D-MISREPORTS-1 Bill of the Day: day picker and filters', () => {
  it('has a native date input labelled Day or Business date that holds the day of the URL', async () => {
    await open(READ);
    await title();
    const d = screen.getByLabelText(/^(Day|Business date)$/i) as HTMLInputElement;
    expect(d.tagName).toBe('INPUT');
    expect(d.type).toBe('date');
    expect(d.value).toBe(DAY);
  });
  it('without a day in the URL it still shows a day (today in Nepal), never an empty picker', async () => {
    await open(READ, '');
    await title();
    expect((screen.getByLabelText(/^(Day|Business date)$/i) as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('changing the day navigates with business_date_from and business_date_to both set to the new day (one day, inclusive)', async () => {
    await open(READ);
    await title();
    fireEvent.change(screen.getByLabelText(/^(Day|Business date)$/i), { target: { value: '2026-11-16' } });
    await waitFor(() => expect(TM.push.mock.calls.length + TM.replace.mock.calls.length).toBeGreaterThan(0));
    const u = new URL(String([...TM.push.mock.calls, ...TM.replace.mock.calls].at(-1)![0]), 'http://x');
    expect(u.pathname).toBe('/billing/bill-of-the-day');
    expect(u.searchParams.get('business_date_from')).toBe('2026-11-16');
    expect(u.searchParams.get('business_date_to')).toBe('2026-11-16');
  });
  it('filters: Centre and Party, nothing else (no Department, Representative, Consultant, Collector, Patient type)', async () => {
    await open(READ);
    await title();
    for (const l of [/^Centre$/, /^Party$/]) expect(screen.queryAllByLabelText(l).length + screen.queryAllByText(l).length, String(l)).toBeGreaterThan(0);
    for (const l of [/^Department$/, /^Representative$/, /^(Consultant|Referrer)$/, /^Collector$/, /^Patient type$/, /^Branch$/]) expect(screen.queryAllByLabelText(l), String(l)).toHaveLength(0);
  });
});

describe('T0D-MISREPORTS-1 Bill of the Day: tables draw their headers when empty (LD-353 rule 5)', () => {
  it('bill list header row: Invoice number, Billed at, Gross, Discount, Net, Paid, Due in order; no id column; an empty state in the body', async () => {
    await open(READ);
    await title();
    const h = headers();
    let at = 0;
    for (const t of ['Invoice number', 'Billed at', 'Gross', 'Discount', 'Net', 'Paid', 'Due']) { at = h.indexOf(t, at); expect(at, `"${t}" in ${JSON.stringify(h)}`).toBeGreaterThanOrEqual(0); at += 1; }
    expect(h.filter((x) => /\bid$/i.test(x))).toEqual([]);
    expect(norm(document.body.textContent)).toMatch(/no data|no results|no bills|no records|nothing to show/i);
  });
  it('the totals by payment mode table draws its header (Payment mode, Amount) with no data', async () => {
    await open(READ);
    await title();
    const h = headers();
    expect(h).toContain('Payment mode');
    expect(h.filter((x) => /^(amount|total|collected)$/i.test(x)).length).toBeGreaterThan(0);
  });
  it('no raw UUID is on the screen', async () => {
    await open(READ, `${SEARCH}&centre_id=${CENTRE_A}`);
    await title();
    expect(norm(document.body.textContent)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
  });
});

describe('T0D-MISREPORTS-1 Bill of the Day: print, CSV and schedule', () => {
  it('Print is a button that calls window.print once', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await open(READ);
    await userEvent.click(await screen.findByRole('button', { name: /^print/i }));
    expect(print).toHaveBeenCalledTimes(1);
  });
  it('CSV: Export menu -> CSV -> acknowledgement -> POST /v1/analytics/exports for bill_of_the_day with the day, the centre array and an Idempotency-Key', async () => {
    await open([...READ, PERM.export], `${SEARCH}&centre_id=${CENTRE_A}`);
    await userEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /csv/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /keep this file inside the lab/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(API.exports()).toHaveLength(1));
    const c = API.exports()[0]!;
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    expect(c.json.report_code).toBe('bill_of_the_day');
    expect(c.json.format).toBe('csv');
    expect(c.json.params).toMatchObject({ business_date_from: DAY, business_date_to: DAY });
    expect([c.json.params.centre_id].flat()).toEqual([CENTRE_A]);
  });
  it('a double click on the dialog Export sends one request', async () => {
    await open([...READ, PERM.export]);
    await userEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /csv/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /keep this file inside the lab/i }));
    const b = within(dlg).getByRole('button', { name: /^export$/i });
    await userEvent.dblClick(b);
    await waitFor(() => expect(API.exports().length).toBeGreaterThanOrEqual(1));
    expect(API.exports()).toHaveLength(1);
  });
  it('without analytics.data.export there is no usable Export; the Schedule link needs analytics.schedule.manage and goes to /analytics/schedules/new', async () => {
    await open(READ);
    await title();
    const b = screen.queryByRole('button', { name: /^export$/i });
    expect(!b || isDisabled(b)).toBe(true);
    expect(screen.queryByRole('link', { name: /schedule/i })).toBeNull();
    cleanup();
    await open([...READ, PERM.schedule]);
    expect((await screen.findByRole('link', { name: /schedule/i })).getAttribute('href') ?? '').toMatch(/^\/analytics\/schedules\/new/);
  });
});
