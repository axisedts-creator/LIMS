// C13.T19 — PK-1 Pickups, PK-2 Request pickup, PP-1 Price list, PS-1 Statements, PS-2 Month (04-UI-UX §3), static-markup component tests (T05 harness).
// ACs: US-10.1 (request form fields/limits), US-10.2 (only own eligible manifests offered), US-10.3/10.5 (statuses shown with tone + word), US-11.1/11.2/11.5 (code, name, price, "Standard rate", urgent-surcharge note, list version),
//      US-12.1..12.4 (statement columns, outstanding tile, "not a tax invoice", empty month = empty state not error), 04-UI-UX §6 copy rules (never "invoice"/"commission", lakh money).
// SEAMS: pages (app)/pickups/page.tsx, (app)/pickups/new/page.tsx, (app)/price-list/page.tsx, (app)/statements/page.tsx, (app)/statements/[period_month]/page.tsx.
//  - PK-1: GET /v1/partners/pickup-requests. PK-2: GET /v1/partners/manifests?state=submitted,partially_received (eligible = no pickup_request_id) and prefills ?manifest_id={id} (from PM-3 "Request pickup").
//  - PP-1: GET /v1/partners/price-list with q (<= 64), kind, source, sort as page searchParams. PS-1: GET /v1/partners/statements. PS-2: GET /v1/partners/statements/{YYYY-MM}; a malformed month is a 404 without any API call.
import { createElement } from 'react';
import { AUTH } from '../t05/harness';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attempt, boot, calls, chipTone, failing, headers, helpKey, hrefs, id, mf, primaries, renderPage, resetApi, restoreFetch, seen, serve, title, urls } from './kit';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('../t05/harness')).headersMock);
vi.mock('next/navigation', async () => ({ ...(await import('../t05/harness')).navigationMock, useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => '/pickups', useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children?: unknown }) => createElement('a', { href, ...rest }, children as never) }));

beforeAll(boot);
afterAll(restoreFetch);
beforeEach(() => { resetApi(); urls.length = 0; });
const list = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ data: rows, page: { limit: 50 }, ...extra });
const pk = (n: number, o: Record<string, unknown> = {}) => ({ id: id(n, 400), state: 'requested', window_start: '2026-11-14T05:00:00.000Z', window_end: '2026-11-14T08:00:00.000Z', packages_count: 2, manifests: [{ id: id(1, 100), manifest_no: 'MF2600001' }, { id: id(2, 100), manifest_no: 'MF2600002' }], created_at: '2026-11-13T05:00:00.000Z', version: 1, ...o });
const noFailureLeak = (o: { html: string; err: unknown }) => {
  if (o.err) expect(String(o.err)).not.toMatch(/UPSTREAM-SECRET-DETAIL|eyJ/);
  else { expect(o.html).toContain('data-tone="danger"'); expect(o.html).not.toContain('UPSTREAM-SECRET-DETAIL'); }
};

describe('PK-1 Pickups (US-10.3/10.4/10.5)', () => {
  const STATES: [string, string, string][] = [['requested', 'Requested', 'info'], ['scheduled', 'Scheduled', 'info'], ['picked_up', 'Picked up', 'success'], ['cancelled', 'Cancelled', 'neutral'], ['rejected', 'Rejected', 'danger']];
  it('title, helpKey, specified columns, manifest count, and a link to PK-2', async () => {
    serve({ '/v1/partners/pickup-requests': list(STATES.map(([s], i) => pk(i + 1, { state: s, ...(s === 'scheduled' ? { scheduled_start: '2026-11-14T06:00:00.000Z', scheduled_end: '2026-11-14T07:00:00.000Z', assignee_text: 'Synthetic Rider' } : {}) }))) });
    const html = await renderPage('pickups');
    expect(title(html)).toBe('Pickups');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    for (const h of ['Requested', 'Window', 'Manifests', 'Packages', 'Status', 'Scheduled time', 'Assignee']) expect(headers(html), h).toContain(h);
    expect(html).toContain('Synthetic Rider');
    expect(hrefs(html)).toContain('/pickups/new');
  });
  it('every state shows its word and tone', async () => {
    serve({ '/v1/partners/pickup-requests': list(STATES.map(([s], i) => pk(i + 1, { state: s }))) });
    const html = await renderPage('pickups');
    // 'Requested' also heads a column; the chip is the element with a data-tone
    for (const [, word, tone] of STATES) expect(chipTone(html, word), word).toBe(tone);
  });
  it('empty -> EmptyState; failure -> ErrorState without upstream detail; the list is read-only', async () => {
    serve({ '/v1/partners/pickup-requests': list([]) });
    expect(await renderPage('pickups')).toContain('lims-state');
    serve({ '/v1/partners/pickup-requests': failing(500) });
    noFailureLeak(await attempt('pickups'));
    for (const s of seen.filter((s) => !s.path.startsWith(AUTH))) expect(s.method).toBe('GET');
  });
  it('contact details are escaped (ST16)', async () => {
    serve({ '/v1/partners/pickup-requests': list([pk(1, { notes: '<script>alert(1)</script>', contact_name: '<img src=x onerror=alert(2)>' })]) });
    const html = await renderPage('pickups');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
  });
});

describe('PK-2 Request pickup (US-10.1/10.2)', () => {
  const eligible = [mf(1, { state: 'submitted' }), mf(2, { state: 'partially_received' }), mf(3, { state: 'submitted', pickup_request_id: id(1, 400) }), mf(4, { state: 'draft' }), mf(5, { state: 'received' })];
  const go = (search: Record<string, string> = {}) => { serve({ '/v1/partners/manifests': { data: eligible, page: { limit: 200 } } }); return renderPage('pickups/new', {}, search); };
  it('fields and limits: window from/to, boxes (default 1), contact person <= 80, phone tel <= 16, notes <= 500', async () => {
    const html = await go();
    for (const l of ['Manifests', 'Pickup window from', 'Pickup window to', 'Number of boxes/bags', 'Contact person', 'Contact phone', 'Notes']) expect(html, l).toContain(l);
    expect(html).toMatch(/maxlength="80"/i);
    expect(html).toMatch(/maxlength="16"/i);
    expect(html).toMatch(/maxlength="500"/i);
    expect(html).toMatch(/type="tel"|inputmode="tel"/i);
    expect(html).toMatch(/value="1"/);
    expect(primaries(html)).toBe(1);
  });
  it('lists only eligible manifests (submitted / partly received, not already on an open pickup); requests the eligible states', async () => {
    const html = await go();
    expect(html).toContain('MF2600001');
    expect(html).toContain('MF2600002');
    for (const n of [3, 4, 5]) expect(html, `MF260000${n}`).not.toContain(`MF260000${n}`);
    expect(calls('/v1/partners/manifests')[0]!.searchParams.get('state')).toMatch(/submitted/);
  });
  it('prefills the manifest from ?manifest_id= (PM-3 "Request pickup"); an id that is not eligible is ignored', async () => {
    const html = await go({ manifest_id: id(2, 100) });
    const box = (h: string, n: number) => [...h.slice(0, h.indexOf(`MF260000${n}`)).matchAll(/<input[^>]*checkbox[^>]*>/g)].at(-1)?.[0] ?? ''; // the checkbox right before the manifest label
    expect(box(html, 2)).toMatch(/checked/);
    expect(box(html, 1)).not.toMatch(/checked/);
    const o = await go({ manifest_id: id(3, 100) });
    expect(o).not.toMatch(/checked=""/);
  });
  it('no write call while rendering; hostile query is not forwarded to the API', async () => {
    await go({ manifest_id: id(1, 100), evil: '<script>' });
    for (const s of seen.filter((s) => !s.path.startsWith(AUTH))) expect(s.method).toBe('GET');
    expect(urls.join(' ')).not.toMatch(/evil|<script>/);
  });
});

describe('PP-1 Price list (US-11.1/11.2/11.5)', () => {
  const item = (n: number, o: Record<string, unknown> = {}) => ({ orderable_id: id(n, 120), kind: 'test', code: `T${n}`, name: `Synthetic test ${n}`, department_name: 'Haematology', unit_price: { amount_paisa: 125000, currency: 'NPR' }, source: 'partner', price_list_version: 7, effective_from: '2026-10-01', ...o });
  const body = (rows: unknown[]) => ({ data: rows, page: { limit: 50 }, price_list_version: 7, synced_at: '2026-11-13T04:00:00.000Z' });
  it('title, search + filters, specified columns, lakh prices, kind words, "Standard rate" only on standard rows', async () => {
    serve({ '/v1/partners/price-list': body([item(1), item(2, { source: 'standard', kind: 'panel', unit_price: { amount_paisa: 12345678, currency: 'NPR' } })]) });
    const html = await renderPage('price-list');
    expect(title(html)).toBe('Price list');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    for (const l of ['Kind', 'Rate']) expect(html, l).toContain(l);
    for (const h of ['Code', 'Name', 'Kind', 'Department', 'Price', 'Rate', 'Valid from']) expect(headers(html), h).toContain(h);
    expect(html).toContain('1,250.00');
    expect(html).toContain('1,23,456.78');
    expect(html).toMatch(/>Test</);
    expect(html).toMatch(/>Package</);
    serve({ '/v1/partners/price-list': body([item(1), item(2)]) });
    const without = await renderPage('price-list'); // partner-rate rows only: no badge
    expect((html.match(/Standard rate/g) ?? []).length).toBeGreaterThan((without.match(/Standard rate/g) ?? []).length);
  });
  it('info banner: urgent surcharge sentence, "Prices updated {time}" and "Price list version {n}"', async () => {
    serve({ '/v1/partners/price-list': body([item(1)]) });
    const html = await renderPage('price-list');
    expect(html).toMatch(/data-tone="info"/);
    expect(html).toContain('Urgent tests may carry an extra charge. The amount on your statement is final.');
    expect(html).toContain('Prices updated');
    expect(html).toContain('Price list version 7');
  });
  it('empty: "No prices are set up for your organisation yet. Contact the lab."', async () => {
    serve({ '/v1/partners/price-list': body([]) });
    expect(await renderPage('price-list')).toContain('No prices are set up for your organisation yet. Contact the lab.');
  });
  it('forwards q (<= 64), kind, source, sort only; over-long q and unknown params are not sent as-is', async () => {
    serve({ '/v1/partners/price-list': body([]) });
    await renderPage('price-list', {}, { q: 'cbc', kind: 'panel', source: 'standard', sort: 'name', evil: '1' });
    let q = calls('/v1/partners/price-list')[0]!.searchParams;
    expect([q.get('q'), q.get('kind'), q.get('source'), q.get('sort'), q.has('evil')]).toEqual(['cbc', 'panel', 'standard', 'name', false]);
    urls.length = 0;
    await renderPage('price-list', {}, { q: 'x'.repeat(200), kind: 'bogus' });
    q = calls('/v1/partners/price-list')[0]!.searchParams;
    expect((q.get('q') ?? '').length).toBeLessThanOrEqual(64);
    expect(['test', 'panel', null]).toContain(q.get('kind'));
  });
  it('failure: ErrorState without upstream detail; names escaped', async () => {
    serve({ '/v1/partners/price-list': failing(500) });
    noFailureLeak(await attempt('price-list'));
    serve({ '/v1/partners/price-list': body([item(1, { name: '<img src=x onerror=alert(1)>' })]) });
    expect(await renderPage('price-list')).not.toContain('<img src=x');
  });
});

describe('PS-1 Statements / PS-2 Month (US-12.1..12.4)', () => {
  const row = (month: string, o: Record<string, unknown> = {}) => ({ period_month: month, fiscal_year_bs: '2083/84', invoiced: { amount_paisa: 12345678, currency: 'NPR' }, paid: { amount_paisa: 1000000, currency: 'NPR' }, credited: { amount_paisa: 50000, currency: 'NPR' }, closing_balance: { amount_paisa: 11295678, currency: 'NPR' }, synced_at: '2026-11-13T05:10:00.000Z', ...o });
  const S1 = { data: [row('2026-10'), row('2026-09')], page: { limit: 50 }, outstanding: { amount_paisa: 11295678, currency: 'NPR' }, outstanding_as_of: '2026-11-13T05:10:00.000Z' };
  const NOT_TAX = 'This statement is for information. It is not a tax invoice.';
  it('neutral information banner, Outstanding balance tile (lakh, as of), the specified columns, A.D. month + B.S. fiscal year, month links', async () => {
    serve({ '/v1/partners/statements': S1 });
    const html = await renderPage('statements');
    expect(title(html)).toBe('Statements');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    expect(html).toContain(NOT_TAX);
    expect(html).toMatch(/data-tone="neutral"[^]*This statement is for information/);
    expect(html).toContain('Outstanding balance');
    expect(html).toContain('1,12,956.78');
    expect(html).toMatch(/as of/i);
    for (const h of ['Month', 'Fiscal year', 'Billed', 'Paid', 'Credited', 'Closing balance']) expect(headers(html), h).toContain(h);
    expect(html).toMatch(/Oct(ober)?\s+2026/);
    expect(html).toContain('2083/84');
    expect(html).toContain('1,23,456.78');
    expect(hrefs(html)).toContain('/statements/2026-10');
  });
  it('copy rules: no "invoice" / "commission" on the partner screen (the one banner sentence aside)', async () => {
    serve({ '/v1/partners/statements': S1 });
    const html = (await renderPage('statements')).replace(NOT_TAX, '');
    expect(html).not.toMatch(/invoice|commission/i);
  });
  it('no data: the banner stays (always shown) and an EmptyState replaces the table; no Outstanding tile with made-up numbers', async () => {
    serve({ '/v1/partners/statements': { data: [], page: { limit: 50 } } });
    const html = await renderPage('statements');
    expect(html).toContain(NOT_TAX);
    expect(html).toContain('lims-state');
    expect(html).not.toMatch(/1,12,956/);
  });
  it('API failure: ErrorState without upstream detail', async () => {
    serve({ '/v1/partners/statements': failing(500) });
    noFailureLeak(await attempt('statements'));
  });
  it('PS-2: one row per fiscal year of that month (two when it straddles Shrawan 1); banner present', async () => {
    serve({ '/v1/partners/statements/2026-07': { period_month: '2026-07', rows: [row('2026-07', { fiscal_year_bs: '2082/83' }), row('2026-07', { fiscal_year_bs: '2083/84' })], synced_at: '2026-11-13T05:10:00.000Z' } });
    const html = await renderPage('statements/[period_month]', { period_month: '2026-07' });
    expect(html).toContain(NOT_TAX);
    expect(html).toContain('2082/83');
    expect(html).toContain('2083/84');
    expect(html).toMatch(/Jul(y)?\s+2026/);
  });
  it('US-12.4: a month without rows is an empty state, not an error', async () => {
    serve({ '/v1/partners/statements/2026-10': { period_month: '2026-10', rows: [], synced_at: '2026-11-13T05:10:00.000Z' } });
    const html = await renderPage('statements/[period_month]', { period_month: '2026-10' });
    expect(html).toContain('lims-state');
    expect(html).not.toContain('data-tone="danger"');
  });
  it('a malformed period_month is a 404 and never reaches the API', async () => {
    serve({});
    for (const bad of ['2026-13', '2026-1', '../x', '2026-10%2F..', 'abc']) {
      urls.length = 0;
      const o = await attempt('statements/[period_month]', { period_month: bad });
      expect(String(o.err), bad).toMatch(/NEXT_NOT_FOUND/);
      expect(urls.filter((u) => /\/v1\/partners\/statements/.test(u)), bad).toEqual([]);
    }
  });
  it('the page makes no write call', async () => {
    serve({ '/v1/partners/statements': S1 });
    await renderPage('statements');
    for (const s of seen.filter((s) => !s.path.startsWith(AUTH))) expect(s.method).toBe('GET');
  });
});
