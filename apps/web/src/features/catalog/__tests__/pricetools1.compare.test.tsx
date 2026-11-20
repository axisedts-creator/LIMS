// @vitest-environment jsdom
// T0D-PRICETOOLS-1 (LD-321 / LD-310 / LD-353): the Compare screen, "two pickers and a table Test, Price A, Price B, Difference, Percent, with print and CSV export".
// NO new route (the catalog route tree is pinned by testimport1.source: 26 files, and nav-complete.catalog pins 15 nav entries): the screen is the price list page
// with a view switch, /catalog/price-lists?view=compare&a=<version id>&b=<version id>. Rendered through the PAGE default export (async server component) with MSW.
// CONTRACT pinned here (tester wording; the writer may dispute through the ruling flow):
//   entry   : the price list screen's header holds the link "Compare price lists" -> /catalog/price-lists?view=compare (managers AND readers); an unknown ?view value falls back to the list.
//   pickers : two kit Selects named "Version A" and "Version B"; options "<code> · v<no> (current|scheduled)" or "<code> · draft" built from the price lists the page already loads (no N+1).
//             The choice lives in the URL: picking navigates (router.push or replace) to /catalog/price-lists?view=compare&a=..&b=.. ; the server page then fetches.
//   table   : columns Test, Price A (NPR), Price B (NPR), Difference (NPR), Percent (headers visible and four placeholder rows when nothing is compared yet, LD-336).
//             Test cell = code + name; money in rupees from paisa ("500.00"); a price absent from one version is "—", never 0.00; Difference = B - A ("-50.00", "-0.01"),
//             Percent = percent_bp / 100 with two decimals and a % sign ("10.00%", "-0.01%"), "—" when absent. The first request has version_a_id and version_b_id.
//   paging  : "Load more" while next_cursor exists (appends the rows).
//   same version / missing / malformed id: no request, headers stay, a message (role=status or alert) that says to pick two different versions.
//   print   : button "Print" calls window.print() once. CSV: button "Export CSV" walks ALL pages (cursor) and downloads price-list-comparison.csv (text/csv) with the header
//             Test code,Test name,Price A (NPR),Price B (NPR),Difference (NPR),Percent (%) ; rupees with 2 decimals; an absent value is an EMPTY cell; a text cell that starts
//             with = + - @ gets a leading ' (formula injection), and cells with , " or newline are quoted with "" doubled; numeric cells are never prefixed.
//   states  : 403 -> the no-access page; 404 from the API -> role=alert with the server detail verbatim; 500 -> ApiError thrown (error.tsx).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { HttpResponse } from 'msw';
import { ApiError } from '@/core/api/server-fetch';
import { expectEmptyTable, headersOf, tableOf } from './emptytbl2.helpers';
import { API, ID, MANAGE, READ, TM, api, blobText, blobs, captureDownloads, downloads, openLists } from './pricetools1.harness';

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { API.reset(); TM.session.permissions = MANAGE; TM.nav.search = ''; captureDownloads(); TM.navLog.length = 0; });
afterEach(() => { cleanup(); api.resetHandlers(); TM.push.mockClear(); TM.replace.mockClear(); });

const row = (id: number, code: string, name: string, o: Record<string, unknown> = {}) => ({ orderable_id: ID(id), test_code: code, test_name: name, ...o });
const PAGE1 = [
  row(101, 'CBC', 'Synthetic Complete Blood Count', { price_a_paisa: 50000, price_b_paisa: 55000, difference_paisa: 5000, percent_bp: 1000 }),
  row(105, 'TSH', 'Synthetic Thyroid Stimulating Hormone', { price_a_paisa: 80000 }),
  row(106, 'NEG', 'Synthetic one paisa cheaper', { price_a_paisa: 10000, price_b_paisa: 9999, difference_paisa: -1, percent_bp: -1 }),
];
const PAGE2 = [
  row(102, 'HB', 'Synthetic Hemoglobin', { price_b_paisa: 30000 }),
  row(103, 'FBS', 'Synthetic Fasting blood sugar', { price_a_paisa: 20000, price_b_paisa: 15000, difference_paisa: -5000, percent_bp: -2500 }),
  row(107, 'EVIL', '=HYPERLINK("http://evil.example","x"), "quoted"', { price_a_paisa: 10000, price_b_paisa: 10000, difference_paisa: 0, percent_bp: 0 }),
];
const twoPages = () => {
  API.compare[''] = () => HttpResponse.json({ data: PAGE1, page: { limit: 3, next_cursor: 'c2' } });
  API.compare['c2'] = () => HttpResponse.json({ data: PAGE2, page: { limit: 3 } });
};
const A = ID(70), B = ID(73);
const URLQ = `view=compare&a=${A}&b=${B}`;
const compares = () => API.find('GET', /price-list-comparisons$/);
const table = () => tableOf(document.body);
const bodyRows = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>('tbody tr, [role="rowgroup"] [role="row"]')].filter((r) => r.getAttribute('aria-hidden') !== 'true' && !r.closest('[aria-hidden="true"]') && !r.closest('thead') && !r.querySelector('th, [role="columnheader"]') && (r.textContent ?? '').trim() !== '');
const cells = (r: HTMLElement) => [...r.querySelectorAll('td, [role="cell"], [role="gridcell"]')].map((c) => (c.textContent ?? '').trim());
const byCode = (code: string) => { const r = bodyRows(table()).find((x) => (cells(x)[0] ?? '').includes(code)); if (!r) throw new Error(`no row for ${code}`); return cells(r); };
const noAxe = async () => { const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }); expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]); };
const settle = () => new Promise((r) => setTimeout(r, 80));
const choose = async (label: RegExp, option: string | RegExp) => { await userEvent.click(screen.getByLabelText(label)); await userEvent.click(await screen.findByRole('option', { name: option })); };
const NAV = () => [...TM.navLog];

// =============================================================================================================================== entry
describe('entry: no new route, a view of the price list page', () => {
  it('the price list screen links to the compare view for a manager and for a reader', async () => {
    for (const perms of [MANAGE, READ]) {
      cleanup();
      await openLists('', perms);
      const l = screen.getByRole('link', { name: /^compare price lists$/i });
      expect(l.getAttribute('href')).toBe('/catalog/price-lists?view=compare');
    }
  });
  it('an unknown ?view falls back to the price list view and never throws', async () => {
    await openLists('view=%3Cscript%3E');
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^export csv$/i })).toBeNull();
    expect(compares()).toHaveLength(0);
  });
  it('the compare view has ONE h1 and no in-page breadcrumb (one trail in the top bar)', async () => {
    await openLists(URLQ);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).toBeNull();
  });
});

// =============================================================================================================================== pickers
describe('the two pickers', () => {
  it('"Version A" and "Version B" exist and list current, scheduled and draft versions of the lists the page loaded', async () => {
    await openLists('view=compare');
    await userEvent.click(screen.getByLabelText(/^version a$/i));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(names.some((n) => /DEFAULT.*v2/.test(n))).toBe(true);
    expect(names.some((n) => /DEFAULT.*draft/i.test(n))).toBe(true);
    expect(names.some((n) => /HOSP_A.*v1/.test(n))).toBe(true);
    expect(names.some((n) => /DR_X.*v4/.test(n))).toBe(true);
    expect(compares()).toHaveLength(0);
    expect(API.find('GET', /\/price-lists\/[^/]+$/)).toHaveLength(0); // no N+1 detail calls
  });
  it('the picked versions of the URL are shown as selected', async () => {
    await openLists(URLQ);
    expect(screen.getByLabelText(/^version a$/i).textContent).toMatch(/DEFAULT.*v2/);
    expect(screen.getByLabelText(/^version b$/i).textContent).toMatch(/DEFAULT.*draft/i);
  });
  it('picking a version navigates to the same view with a= and b= in the URL (selection lives in the URL)', async () => {
    await openLists(`view=compare&a=${A}`);
    await choose(/^version b$/i, /DEFAULT.*draft/i);
    await waitFor(() => expect(NAV().length).toBeGreaterThan(0));
    const u = new URL(NAV().at(-1)!, 'http://x');
    expect(u.pathname).toBe('/catalog/price-lists');
    expect(u.searchParams.get('view')).toBe('compare');
    expect(u.searchParams.get('a')).toBe(A);
    expect(u.searchParams.get('b')).toBe(B);
  });
  it('the pickers are keyboard operable (focusable buttons with a label)', async () => {
    await openLists('view=compare');
    for (const n of [/^version a$/i, /^version b$/i]) { const el = screen.getByLabelText(n); el.focus(); expect(document.activeElement).toBe(el); }
  });
});

// =============================================================================================================================== the table
describe('the comparison table', () => {
  it('has the columns Test, Price A (NPR), Price B (NPR), Difference (NPR), Percent', async () => {
    twoPages();
    await openLists(URLQ);
    expect(headersOf(table()).slice(0, 5)).toEqual(['Test', 'Price A (NPR)', 'Price B (NPR)', 'Difference (NPR)', 'Percent']);
  });
  it('with nothing compared yet the headers stay, with a message row and four placeholder rows (no request)', async () => {
    await openLists('view=compare');
    expectEmptyTable(table(), null, ['Test', 'Price A (NPR)', 'Price B (NPR)', 'Difference (NPR)', 'Percent']);
    expect(compares()).toHaveLength(0);
  });
  it('asks the API with version_a_id and version_b_id of the URL, once, without a cursor', async () => {
    twoPages();
    await openLists(URLQ);
    expect(compares()).toHaveLength(1);
    expect(compares()[0]!.search.get('version_a_id')).toBe(A);
    expect(compares()[0]!.search.get('version_b_id')).toBe(B);
    expect(compares()[0]!.search.has('cursor')).toBe(false);
  });
  it('shows code + name, rupees from paisa, difference and percent', async () => {
    twoPages();
    await openLists(URLQ);
    const cbc = byCode('CBC');
    expect(cbc[0]).toContain('Synthetic Complete Blood Count');
    expect(cbc.slice(1, 5)).toEqual(['500.00', '550.00', '50.00', '10.00%']);
  });
  it('an absent price is "—", never 0.00; difference and percent are "—" when a side is absent', async () => {
    twoPages();
    await openLists(URLQ);
    expect(byCode('TSH').slice(1, 5)).toEqual(['800.00', '—', '—', '—']);
    await userEvent.click(screen.getByRole('button', { name: /^load more$/i }));
    await waitFor(() => expect(bodyRows(table()).length).toBe(6));
    expect(byCode('HB').slice(1, 5)).toEqual(['—', '300.00', '—', '—']);
  });
  it('negative and sub-rupee amounts are exact: -1 paisa -> -0.01 and -0.01 %', async () => {
    twoPages();
    await openLists(URLQ);
    const neg = byCode('NEG');
    expect(neg.slice(1, 5)).toEqual(['100.00', '99.99', expect.stringMatching(/^[-−]0\.01$/), expect.stringMatching(/^[-−]0\.01%$/)]);
  });
  it('"Load more" appears while a next cursor exists, requests it, appends the rows and then disappears', async () => {
    twoPages();
    await openLists(URLQ);
    expect(bodyRows(table())).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: /^load more$/i }));
    await waitFor(() => expect(bodyRows(table())).toHaveLength(6));
    expect(compares()[1]!.search.get('cursor')).toBe('c2');
    expect(compares()[1]!.search.get('version_a_id')).toBe(A);
    expect(screen.queryByRole('button', { name: /^load more$/i })).toBeNull();
    const fbs = byCode('FBS');
    expect(fbs.slice(1, 5)).toEqual(['200.00', '150.00', expect.stringMatching(/^[-−]50\.00$/), expect.stringMatching(/^[-−]25\.00%$/)]);
  });
  it('no cursor, no "Load more" button; the table scrolls inside its own box and is compact', async () => {
    API.compare[''] = () => HttpResponse.json({ data: PAGE1, page: { limit: 50 } });
    await openLists(URLQ);
    expect(screen.queryByRole('button', { name: /^load more$/i })).toBeNull();
    expect(table().closest('[class*="lims-table-scroll"]')).toBeTruthy();
    expect(table().className).toMatch(/lims-table-compact/);
  });
  it('identical versions: no request; the same pair empty result keeps the headers with a message', async () => {
    await openLists(`view=compare&a=${A}&b=${A}`);
    expect(compares()).toHaveLength(0);
    expect(document.body.textContent).toMatch(/two different versions/i);
    expect(headersOf(table()).length).toBeGreaterThanOrEqual(5);
    cleanup();
    API.compare[''] = () => HttpResponse.json({ data: [], page: { limit: 50 } });
    await openLists(URLQ);
    expect(headersOf(table()).length).toBeGreaterThanOrEqual(5);
    expect(compares()).toHaveLength(1);
  });
  it.each([[`view=compare&a=${A}`], [`view=compare&b=${B}`], ['view=compare&a=not-a-uuid&b=%3Cscript%3E'], [`view=compare&a=${A}&b=${B}x`]])('incomplete or malformed pair "%s": no request, no throw, headers visible', async (q) => {
    await openLists(q);
    expect(compares()).toHaveLength(0);
    expect(headersOf(table()).length).toBeGreaterThanOrEqual(5);
  });
  it('API text is rendered as text, never as HTML', async () => {
    API.compare[''] = () => HttpResponse.json({ data: [row(110, 'XSS', '<img src=x onerror=alert(1)>', { price_a_paisa: 100 })], page: { limit: 50 } });
    await openLists(URLQ);
    expect(table().querySelector('img')).toBeNull();
    expect(table().textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

// =============================================================================================================================== states
describe('states', () => {
  it('403 shows the no-access page; 404 shows the server detail in a role=alert and keeps the table headers; 500 throws', async () => {
    API.compareFail = 403;
    await openLists(URLQ);
    expect(screen.getByRole('heading', { name: /don.t have access to this part of the catalog/i })).toBeTruthy();
    cleanup();
    API.compareFail = 404;
    await openLists(URLQ);
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toContain('Synthetic: that version does not exist.');
    expect(headersOf(table()).length).toBeGreaterThanOrEqual(5);
    cleanup();
    API.compareFail = 500;
    await expect(openLists(URLQ)).rejects.toBeInstanceOf(ApiError);
  });
  it('a reader (catalog.price_list.read only) sees the table, Print and Export CSV (they are client side)', async () => {
    twoPages();
    await openLists(URLQ, READ);
    expect(bodyRows(table())).toHaveLength(3);
    for (const n of [/^print$/i, /^export csv$/i]) expect((screen.getByRole('button', { name: n }) as HTMLButtonElement).disabled, String(n)).toBe(false);
  });
});

// =============================================================================================================================== print and CSV
describe('print and CSV export', () => {
  it('Print calls window.print once; Export CSV and Print are disabled (with the table empty) until something is compared', async () => {
    const print = vi.fn();
    (window as unknown as { print: () => void }).print = print;
    twoPages();
    await openLists(URLQ);
    await userEvent.click(screen.getByRole('button', { name: /^print$/i }));
    expect(print).toHaveBeenCalledTimes(1);
    cleanup();
    await openLists('view=compare');
    expect((screen.getByRole('button', { name: /^export csv$/i }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('Export CSV walks ALL pages and downloads price-list-comparison.csv as text/csv', async () => {
    twoPages();
    await openLists(URLQ);
    await userEvent.click(screen.getByRole('button', { name: /^export csv$/i }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]!.name).toBe('price-list-comparison.csv');
    expect(blobs[0]!.type).toMatch(/^text\/csv/);
    expect(compares().map((c) => c.search.get('cursor'))).toEqual([null, 'c2']);
    const lines = (await blobText(blobs[0]!)).replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(7); // header + 6 rows from both pages
    expect(lines[0]).toBe('Test code,Test name,Price A (NPR),Price B (NPR),Difference (NPR),Percent (%)');
  });
  it('CSV cells: rupees with 2 decimals, absent = empty cell, negative numbers are never prefixed', async () => {
    twoPages();
    await openLists(URLQ);
    await userEvent.click(screen.getByRole('button', { name: /^export csv$/i }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const lines = (await blobText(blobs[0]!)).replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    expect(lines).toContain('CBC,Synthetic Complete Blood Count,500.00,550.00,50.00,10.00');
    expect(lines).toContain('TSH,Synthetic Thyroid Stimulating Hormone,800.00,,,');
    expect(lines).toContain('HB,Synthetic Hemoglobin,,300.00,,');
    expect(lines).toContain('FBS,Synthetic Fasting blood sugar,200.00,150.00,-50.00,-25.00');
    expect(lines).toContain('NEG,Synthetic one paisa cheaper,100.00,99.99,-0.01,-0.01');
  });
  it('CSV formula injection: a name starting with = gets a leading apostrophe and is quoted; quotes are doubled', async () => {
    twoPages();
    await openLists(URLQ);
    await userEvent.click(screen.getByRole('button', { name: /^export csv$/i }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobText(blobs[0]!);
    expect(text).toContain('EVIL,"\'=HYPERLINK(""http://evil.example"",""x""), ""quoted""",100.00,100.00,0.00,0.00');
    expect(text).not.toMatch(/(^|,|\n)=HYPERLINK/);
  });
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1'])('a test name "%s" is neutralised in the CSV', async (name) => {
    API.compare[''] = () => HttpResponse.json({ data: [row(120, 'INJ', name, { price_a_paisa: 100 })], page: { limit: 50 } });
    await openLists(URLQ);
    await userEvent.click(screen.getByRole('button', { name: /^export csv$/i }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const line = (await blobText(blobs[0]!)).replace(/^﻿/, '').split(/\r?\n/)[1]!;
    const field = /^INJ,("(?:[^"]|"")*"|[^,]*),/.exec(line)?.[1] ?? '';
    const inner = field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field;
    expect(inner.startsWith("'"), `"${name}" -> ${line}`).toBe(true);
  });
  it('a failing page during the CSV walk shows a role=alert and downloads NO partial file', async () => {
    API.compare[''] = () => HttpResponse.json({ data: PAGE1, page: { limit: 3, next_cursor: 'c2' } });
    API.compare['c2'] = () => HttpResponse.json({ type: 'urn:lims:error:common.internal', title: 'x', status: 500, code: 'common.internal' }, { status: 500, headers: { 'content-type': 'application/problem+json' } });
    await openLists(URLQ);
    await userEvent.click(screen.getByRole('button', { name: /^export csv$/i }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    await settle();
    expect(downloads).toHaveLength(0);
  });
  it('a double click on Export CSV downloads one file', async () => {
    twoPages();
    await openLists(URLQ);
    await userEvent.dblClick(screen.getByRole('button', { name: /^export csv$/i }));
    await waitFor(() => expect(downloads.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    expect(downloads).toHaveLength(1);
  });
});

// =============================================================================================================================== a11y
describe('accessibility', () => {
  it('axe: no violations with rows, and empty', async () => {
    twoPages();
    await openLists(URLQ);
    await noAxe();
    cleanup();
    await openLists('view=compare');
    await noAxe();
  });
  it('the table has a caption or accessible name', async () => {
    twoPages();
    await openLists(URLQ);
    expect(within(document.body).getByRole('table', { name: /.+/ }) ?? null).toBeTruthy();
  });
});
