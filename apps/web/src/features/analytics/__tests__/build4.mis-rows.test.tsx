// @vitest-environment jsdom
// T0D-BUILD-4 (LD-447; founder order 2026-11-22 13:36 NPT; closes CR item 8 of notes/T0D-MISREPORTS-1-cr-needed.md): Bill of the Day (/billing/bill-of-the-day) and the other MIS screens
// (/analytics/reports/[reportCode]) READ their rows through the new operation getMisReportPage = GET /v1/analytics/mis-reports/{report_code} and show: the result table with money from paisa,
// a totals row, cursor paging, the existing filters, export and print. Reached through the PAGE default exports with the misreports1 harness (MSW stand-in for the API, mocks from
// catalog/__tests__/testmgmt1.setup.ts). Synthetic data only.
// PINNED PICKS (the brief leaves them open; the writer may dispute through the reviewer, then the tests change with the ruling):
//   * API body = { columns: [{ key, label, kind: text|count|paisa|bp }], rows: [object keyed by column key], totals: { <key>: integer }, next_cursor? } (as runMisReport returns it).
//   * request = the dates (inclusive; Bill of the Day: both equal), centre_id as ONE comma list (form, explode false), the active definition filters by their export names, limit <= 200, cursor.
//   * headers = the contract titles of the definition without the *_id columns (as before: the header row is drawn even for an empty result); cells are keyed by the response row.
//   * money cell = lakh grouping with two decimals through the existing formatter (12,34,567.89), "NPR" in the cell or in the header; count = plain integer; bp = percent (1000 -> 10%); date and
//     datetime = DD/MM/YYYY (+ time, Asia/Kathmandu); ids never printed. No ISO date in the visible text.
//   * totals row = a row whose first cell is "Total" / "Totals", values from the RESPONSE totals (the whole filtered set, not the page); no total for text, date or bp columns.
//   * Bill of the Day tiles Gross, Net, Paid, Due show the response totals; an empty result keeps "—" and the empty state (no totals row).
//   * paging = a "Next" button when next_cursor is set (router.push to the same URL with cursor=<value>); the page reads ?cursor= and forwards it only when it is base64url (<= 200 chars).
//   * the A39 gate of the two money reports comes from the new read itself: 403 common.feature_disabled / auth.mfa_required on getMisReportPage closes the screen.
//   * payment mode totals of Bill of the Day: bill_of_the_day has no payment mode column, so the block stays "Not available yet" with no number, and the gap is written to
//     .orchestra/notes/T0D-BUILD-4-left.md (LD-436: no invented values).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { t } from '@/core/i18n/messages';
import { API, BOTD_PAGE, CENTRE_A, MONEY_WORDS, ORIGIN, PARTY_A, PERM, ROOT, TM, api, def, norm, openPage, openReport, prob } from './misreports1.harness';

const KIND: Record<string, string> = { string: 'text', date: 'text', datetime: 'text', integer: 'count', integer_paisa: 'paisa', basis_points: 'bp' };
type Body = { columns: { key: string; label: string; kind: string }[]; rows: Record<string, string | number>[]; totals: Record<string, number>; next_cursor?: string };
const body = (code: string, rows: Body['rows'], totals: Body['totals'], next_cursor?: string): Body => ({
  columns: def(code).columns.map((c) => ({ key: c.name, label: c.title, kind: KIND[c.type]! })), rows, totals, ...(next_cursor ? { next_cursor } : {}),
});
const fill = (code: string, v: Record<string, string | number>) => Object.fromEntries(def(code).columns.map((c) => [c.name, v[c.name] ?? (['string', 'date', 'datetime'].includes(c.type) ? '' : 0)]));

const INVOICE_ID = '01a1a98a-ac40-7000-8000-0000000b0001';
const botdRow = (n: number, gross: number, disc: number, paid: number, at = '2026-11-17T06:00:00.000Z') =>
  fill('bill_of_the_day', { invoice_id: n === 1 ? INVOICE_ID : `01a1a98a-ac40-7000-8000-0000000b000${n}`, invoice_number: `INV-${n}`, billed_at: at, business_date: '2026-11-17', centre_id: CENTRE_A, gross_paisa: gross, discount_paisa: disc, net_paisa: gross - disc, paid_paisa: paid, due_paisa: gross - disc - paid });
// page 1 of 2 rows; the totals cover the WHOLE day (4 bills): gross 123711789, discount 5000, net 123706789, paid 100210000, due 23496789
const BOTD_P1 = body('bill_of_the_day', [botdRow(1, 150_000, 5_000, 145_000), botdRow(3, 123_456_789, 0, 100_000_000, '2026-11-17T08:30:00.000Z')],
  { gross_paisa: 123_711_789, discount_paisa: 5_000, net_paisa: 123_706_789, paid_paisa: 100_210_000, due_paisa: 23_496_789 }, 'Y3Vyc29yMQ');
const BOTD_EMPTY = body('bill_of_the_day', [], { gross_paisa: 0, discount_paisa: 0, net_paisa: 0, paid_paisa: 0, due_paisa: 0 });

const MIS: { reply: (code: string, url: URL) => Response | Body } = { reply: (code) => (code === 'bill_of_the_day' ? BOTD_P1 : body(code, [], {})) };

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  API.reset(); TM.push.mockClear(); TM.replace.mockClear();
  MIS.reply = (code) => (code === 'bill_of_the_day' ? BOTD_P1 : body(code, [], {}));
  api.use(http.get(`${ORIGIN}/v1/analytics/mis-reports/:code`, ({ request, params }) => {
    const u = new URL(request.url);
    API.calls.push({ method: 'GET', path: u.pathname, search: u.searchParams, headers: request.headers });
    const r = MIS.reply(String(params['code']), u);
    return r instanceof Response ? r : HttpResponse.json(r);
  }));
});
afterEach(() => { cleanup(); api.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => api.close());

const reads = (code?: string) => API.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/v1/analytics/mis-reports/') && (!code || c.path === `/v1/analytics/mis-reports/${code}`));
const rowsOf = (root: ParentNode) => [...root.querySelectorAll('tr, [role="row"]')].filter((r) => !r.querySelector('th[scope="col"], [role="columnheader"]'));
const rowText = (r: Element) => norm(r.textContent);
const BOTD_SEARCH = 'business_date_from=2026-11-17';
const openBotd = (perms = [PERM.collections, PERM.export], search = BOTD_SEARCH) => openPage(BOTD_PAGE, { perms, search });
const ISO = /\d{4}-\d{2}-\d{2}/;
const money = (s: string) => new RegExp(`(NPR\\s?)?${s.replace(/\./g, '\\.')}`);

describe('Bill of the Day reads the day through getMisReportPage and shows the bills', () => {
  it('calls GET /v1/analytics/mis-reports/bill_of_the_day with both ends of the one business day and a limit of at most 200', async () => {
    await openBotd();
    const [r] = reads('bill_of_the_day');
    expect(r, 'the screen reads the MIS page').toBeDefined();
    expect(r!.search.get('business_date_from')).toBe('2026-11-17');
    expect(r!.search.get('business_date_to')).toBe('2026-11-17');
    if (r!.search.has('limit')) { const l = Number(r!.search.get('limit')); expect(l).toBeGreaterThanOrEqual(1); expect(l).toBeLessThanOrEqual(200); }
    expect(r!.search.has('cursor')).toBe(false);
  });

  it('one row per bill of the page: invoice number, centre label never an id; the raw invoice id is never printed', async () => {
    const { container } = await openBotd();
    await screen.findByText('INV-1');
    expect(rowsOf(container).filter((r) => /INV-\d/.test(rowText(r)))).toHaveLength(2);
    expect(norm(container.textContent)).not.toContain(INVOICE_ID);
    expect(norm(container.textContent)).not.toContain(CENTRE_A);
  });

  it('money columns come from paisa: lakh grouping, two decimals, NPR; the raw paisa number is never shown', async () => {
    const { container } = await openBotd();
    await screen.findByText('INV-3');
    const row = rowsOf(container).find((r) => rowText(r).includes('INV-3'))!;
    for (const s of ['12,34,567.89', '10,00,000.00']) expect(rowText(row), s).toMatch(money(s));
    const first = rowsOf(container).find((r) => rowText(r).includes('INV-1'))!;
    for (const s of ['1,500.00', '50.00', '1,450.00']) expect(rowText(first), s).toMatch(money(s));
    expect(norm(container.textContent)).not.toMatch(/123456789|1234567\.89/);
    const heads = norm(container.textContent);
    expect(heads.includes('NPR') || /NPR/.test(heads), 'NPR is named in a header or a cell').toBe(true);
  });

  it('dates are DD/MM/YYYY (the business day, the bill time in Asia/Kathmandu) and no ISO date is printed', async () => {
    const { container } = await openBotd();
    await screen.findByText('INV-1');
    const first = rowsOf(container).find((r) => rowText(r).includes('INV-1'))!;
    expect(rowText(first)).toMatch(/17\/11\/2026/);
    expect(rowText(first), 'billed at 06:00Z = 11:45 in Kathmandu').toMatch(/11:45/);
    expect(norm(container.textContent)).not.toMatch(ISO);
  });

  it('a totals row shows the sums of the WHOLE day taken from the response (4 bills), not the sums of the 2 rows on the page', async () => {
    const { container } = await openBotd();
    await screen.findByText('INV-1');
    const total = rowsOf(container).find((r) => /^totals?\b/i.test(rowText(r)));
    expect(total, 'a row whose first cell is "Total"').toBeDefined();
    for (const s of ['12,37,117.89', '50.00', '12,37,067.89', '10,02,100.00', '2,34,967.89']) expect(rowText(total!), s).toMatch(money(s));
    expect(rowText(total!), 'page sum of gross (12,36,067.89 is not the total)').not.toMatch(/12,36,067\.89/);
  });

  it('the tiles Gross, Net, Paid, Due show the response totals', async () => {
    const { container } = await openBotd();
    await screen.findByText('INV-1');
    const tile = (label: string) => [...container.querySelectorAll<HTMLElement>('.lims-stat')].find((s) => norm(s.querySelector('.lims-stat-label')?.textContent) === label);
    for (const [label, v] of [['Gross', '12,37,117.89'], ['Net', '12,37,067.89'], ['Paid', '10,02,100.00'], ['Due', '2,34,967.89']] as const) {
      expect(tile(label), `${label} tile`).toBeDefined();
      expect(norm(tile(label)!.textContent), label).toMatch(money(v));
    }
  });

  it('payment mode totals: no payment mode column is returned, so the block stays "Not available yet" and shows no number (LD-436)', async () => {
    const { container } = await openBotd();
    await screen.findByText('INV-1');
    expect(screen.getAllByText(t('billing.botd.by_mode_empty')).length).toBeGreaterThan(0);
    const mode = [...container.querySelectorAll('table, [role="grid"]')].find((tb) => norm(tb.querySelector('caption')?.textContent ?? tb.getAttribute('aria-label')) === t('billing.botd.by_mode'));
    if (mode) expect(rowsOf(mode).map(rowText).join(' ')).not.toMatch(/\d/);
  });

  it('Print and Export stay; one FilterBar and one period control', async () => {
    const { container } = await openBotd();
    await screen.findByText('INV-1');
    const buttons = [...container.querySelectorAll('button')].map((b) => norm(b.textContent));
    expect(buttons).toEqual(expect.arrayContaining([t('analytics.mis.print'), t('analytics.mis.export')]));
    expect(container.querySelectorAll('.lims-filter-bar')).toHaveLength(1);
    expect(container.querySelectorAll('.lims-period')).toHaveLength(1);
  });

  it('the day shown above the table is DD/MM/YYYY', async () => {
    const { container } = await openBotd();
    await screen.findByText('INV-1');
    expect(norm(container.textContent)).toMatch(/17\/11\/2026/);
  });
});

describe('empty day', () => {
  it('rows [] -> the empty state, no totals row, the tiles keep "—" (no invented number), the header row stays, no alert', async () => {
    MIS.reply = () => BOTD_EMPTY;
    const { container } = await openBotd();
    await waitFor(() => expect(reads('bill_of_the_day').length).toBeGreaterThan(0));
    expect(await screen.findByText(t('analytics.mis.empty'))).toBeTruthy();
    expect(rowsOf(container).some((r) => /^totals?\b/i.test(rowText(r)))).toBe(false);
    const tiles = [...container.querySelectorAll('.lims-stat')];
    expect(tiles.length).toBe(4);
    for (const s of tiles) expect(norm(s.textContent).replace(norm(s.querySelector('.lims-stat-label')?.textContent), ''), 'tile value is not a number').not.toMatch(/\d/);
    expect(screen.queryAllByRole('columnheader').map((h) => norm(h.textContent))).toEqual(expect.arrayContaining(def('bill_of_the_day').columns.filter((c) => !c.name.endsWith('_id')).map((c) => c.title)));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('no Next button without next_cursor', async () => {
    MIS.reply = () => BOTD_EMPTY;
    await openBotd();
    await waitFor(() => expect(reads('bill_of_the_day').length).toBeGreaterThan(0));
    await screen.findByText(t('analytics.mis.empty'));
    const next = screen.queryByRole('button', { name: /next/i });
    expect(next === null || (next as HTMLButtonElement).disabled || next.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});

describe('paging', () => {
  it('next_cursor shows Next; pressing it pushes the same day with cursor=<value>', async () => {
    await openBotd();
    await screen.findByText('INV-1');
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    const url = String(TM.push.mock.calls.at(-1)?.[0] ?? '');
    expect(url).toContain('/billing/bill-of-the-day?');
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('cursor')).toBe('Y3Vyc29yMQ');
    expect(q.get('business_date_from')).toBe('2026-11-17');
    expect(q.get('business_date_to')).toBe('2026-11-17');
  });

  it('?cursor= of the URL is forwarded to the read', async () => {
    await openBotd([PERM.collections, PERM.export], `${BOTD_SEARCH}&cursor=Y3Vyc29yMQ`);
    await waitFor(() => expect(reads('bill_of_the_day').length).toBeGreaterThan(0));
    expect(reads('bill_of_the_day')[0]!.search.get('cursor')).toBe('Y3Vyc29yMQ');
  });

  it.each(['<script>alert(1)</script>', 'x'.repeat(300), 'a b', '../../etc'])('a hostile cursor %j is not forwarded to the API', async (cursor) => {
    await openBotd([PERM.collections, PERM.export], `${BOTD_SEARCH}&cursor=${encodeURIComponent(cursor)}`);
    await waitFor(() => expect(reads('bill_of_the_day').length).toBeGreaterThan(0));
    expect(reads('bill_of_the_day')[0]!.search.has('cursor')).toBe(false);
  });
});

describe('the other MIS screens', () => {
  const PB_ROWS = [
    fill('party_billing', { party_id: PARTY_A, party_name: 'Synthetic Party One', billing_mode: 'credit', orders_registered: 4, gross_paisa: 400_000, discount_paisa: 10_000, net_paisa: 390_000, paid_paisa: 100_000, outstanding_paisa: 290_000 }),
    fill('party_billing', { party_id: 'p2', party_name: 'Synthetic Party Two', billing_mode: 'cash', orders_registered: 6, gross_paisa: 600_000, discount_paisa: 0, net_paisa: 600_000, paid_paisa: 600_000, outstanding_paisa: 0 }),
  ];
  const PB_TOTALS = { orders_registered: 12, gross_paisa: 1_050_000, discount_paisa: 10_000, net_paisa: 1_040_000, paid_paisa: 700_000, outstanding_paisa: 340_000 };
  const SEARCH = `business_date_from=2026-11-01&business_date_to=2026-11-30&centre_id=${CENTRE_A}&party_id=${PARTY_A}`;

  it('party_billing: reads /mis-reports/party_billing with the dates, the centre list and the party filter', async () => {
    MIS.reply = (code) => body(code, PB_ROWS, PB_TOTALS);
    await openReport('party_billing', [PERM.collections], `?${SEARCH}`);
    await waitFor(() => expect(reads('party_billing').length).toBeGreaterThan(0));
    const s = reads('party_billing')[0]!.search;
    expect(s.get('business_date_from')).toBe('2026-11-01');
    expect(s.get('business_date_to')).toBe('2026-11-30');
    expect(s.get('centre_id')).toBe(CENTRE_A);
    expect(s.get('party_id')).toBe(PARTY_A);
  });

  it('party_billing: rows (names, integers plain, money lakh formatted), a totals row from the response, no id column', async () => {
    MIS.reply = (code) => body(code, PB_ROWS, PB_TOTALS);
    const { container } = await openReport('party_billing', [PERM.collections], `?${SEARCH}`);
    await screen.findByText('Synthetic Party One');
    const one = rowsOf(container).find((r) => rowText(r).includes('Synthetic Party One'))!;
    expect(rowText(one)).toMatch(money('4,000.00'));
    expect(rowText(one)).toMatch(/\b4\b/);
    const total = rowsOf(container).find((r) => /^totals?\b/i.test(rowText(r)));
    expect(total, 'totals row').toBeDefined();
    expect(rowText(total!)).toMatch(/\b12\b/);
    expect(rowText(total!)).toMatch(money('3,400.00'));
    expect(rowText(total!)).toMatch(money('10,400.00'));
    expect(screen.queryAllByRole('columnheader').map((h) => norm(h.textContent)).join('|')).not.toMatch(/\bid\b/i);
    expect(norm(container.textContent)).not.toContain(PARTY_A);
  });

  it('the period line is DD/MM/YYYY – DD/MM/YYYY; no ISO date is printed', async () => {
    MIS.reply = (code) => body(code, PB_ROWS, PB_TOTALS);
    const { container } = await openReport('party_billing', [PERM.collections], `?${SEARCH}`);
    await screen.findByText('Synthetic Party One');
    expect(norm(container.textContent)).toMatch(/01\/11\/2026\s*[–-]\s*30\/11\/2026/);
    expect(norm(container.textContent)).not.toMatch(ISO);
  });

  it('dates and datetimes of rows are DD/MM/YYYY (repeated_patient first/last visit)', async () => {
    MIS.reply = (code) => body(code, [fill('repeated_patient', { patient_id: 'x', patient_number: 'SYN-P000001', visit_count: 3, first_visit_date: '2026-10-02', last_visit_date: '2026-11-20', net_paisa: 250_000 })], { visit_count: 3, net_paisa: 250_000 });
    const { container } = await openReport('repeated_patient', [PERM.dashboard], '?business_date_from=2026-10-01&business_date_to=2026-11-30');
    await screen.findByText('SYN-P000001');
    const row = rowsOf(container).find((r) => rowText(r).includes('SYN-P000001'))!;
    expect(rowText(row)).toMatch(/02\/10\/2026/);
    expect(rowText(row)).toMatch(/20\/11\/2026/);
    expect(rowText(row)).toMatch(money('2,500.00'));
    expect(norm(container.textContent)).not.toMatch(ISO);
  });

  it('two_level_commission (gate open): rate in basis points shows as percent and is NOT totalled; money formatted; a totals row', async () => {
    MIS.reply = (code) => body(code, [
      fill(code, { parent_party_name: 'Synthetic Parent', party_name: 'Synthetic Sub', level: 1, orders_registered: 5, net_billed_paisa: 500_000, commission_bp: 1_000, commission_paisa: 50_000 }),
      fill(code, { parent_party_name: 'Synthetic Parent', party_name: 'Synthetic Sub Two', level: 2, orders_registered: 3, net_billed_paisa: 300_000, commission_bp: 1_500, commission_paisa: 45_000 })],
      { level: 3, orders_registered: 8, net_billed_paisa: 800_000, commission_paisa: 95_000 });
    const { container } = await openReport('two_level_commission', [PERM.referral], `?business_date_from=2026-11-01&business_date_to=2026-11-30`);
    await screen.findByText('Synthetic Sub');
    expect(reads('two_level_commission').length).toBeGreaterThan(0);
    const a = rowsOf(container).find((r) => rowText(r).includes('Synthetic Sub') && !rowText(r).includes('Two'))!;
    expect(rowText(a)).toMatch(/\b10(\.00)?\s?%/);
    expect(rowText(a)).toMatch(money('500.00'));
    const total = rowsOf(container).find((r) => /^totals?\b/i.test(rowText(r)))!;
    expect(rowText(total)).toMatch(money('950.00'));
    expect(rowText(total), 'no total of a rate').not.toMatch(/%/);
  });

  it('filters, Print and Export stay on a catalogue screen', async () => {
    MIS.reply = (code) => body(code, PB_ROWS, PB_TOTALS);
    const { container } = await openReport('party_billing', [PERM.collections, PERM.export], `?${SEARCH}`);
    await screen.findByText('Synthetic Party One');
    const buttons = [...container.querySelectorAll('button')].map((b) => norm(b.textContent));
    expect(buttons).toEqual(expect.arrayContaining([t('analytics.mis.print'), t('analytics.mis.export')]));
    expect(container.querySelectorAll('.lims-filter-bar')).toHaveLength(1);
  });

  it('next_cursor on a catalogue screen: Next pushes /analytics/reports/party-billing with cursor and the same filters', async () => {
    MIS.reply = (code) => body(code, PB_ROWS, PB_TOTALS, 'cGFnZTI');
    await openReport('party_billing', [PERM.collections], `?${SEARCH}`);
    await screen.findByText('Synthetic Party One');
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    const url = String(TM.push.mock.calls.at(-1)?.[0] ?? '');
    expect(url).toContain('/analytics/reports/party-billing?');
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('cursor')).toBe('cGFnZTI');
    expect(q.get('business_date_from')).toBe('2026-11-01');
    expect(q.get('party_id')).toBe(PARTY_A);
  });
});

describe('the A39 gate comes from the new read', () => {
  it.each([['common.feature_disabled', 'disabled'], ['auth.mfa_required', 'mfa']])('getMisReportPage 403 %s on a money report closes the screen: no column, no commission / TDS word', async (code) => {
    MIS.reply = () => prob(403, code) as unknown as Response;
    const { container } = await openReport('two_level_commission', [PERM.referral], '?business_date_from=2026-11-01&business_date_to=2026-11-30');
    await waitFor(() => expect(reads('two_level_commission').length).toBeGreaterThan(0));
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    expect(norm(container.textContent)).not.toMatch(MONEY_WORDS);
  });

  it('a plain report is not blocked by a money gate and no referral report is read for it', async () => {
    MIS.reply = (code) => body(code, [], {});
    await openReport('party_billing', [PERM.collections], '?business_date_from=2026-11-01&business_date_to=2026-11-30');
    await waitFor(() => expect(reads('party_billing').length).toBeGreaterThan(0));
    expect(API.calls.filter((c) => c.path.includes('/referral-incentive'))).toEqual([]);
  });
});

describe('permission and failure', () => {
  it('without the definition permission: 404 before any API call (unchanged)', async () => {
    await expect(openReport('party_billing', [PERM.dashboard], '?business_date_from=2026-11-01&business_date_to=2026-11-30')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(API.dataReads()).toEqual([]);
  });
});

describe('notes: the payment mode gap is written down', () => {
  it('.orchestra/notes/T0D-BUILD-4-left.md exists and names the payment mode totals gap (LD-436)', () => {
    const f = join(ROOT, '.orchestra', 'notes', 'T0D-BUILD-4-left.md');
    expect(existsSync(f), 'notes/T0D-BUILD-4-left.md').toBe(true);
    expect(readFileSync(f, 'utf8')).toMatch(/payment mode/i);
  });
});
