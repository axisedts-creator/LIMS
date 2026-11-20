// @vitest-environment jsdom
// T0D-UIREPORT-2 (LD-353 template 5 REPORT; rules 3, 5, 6, 8, 10; done_when): the report screens income, department income, collections, volume, top referrers,
// top centres, tests done, TAT, delivery, interfaces, and the hub (/analytics/reports = the Income body under the menu title) show, top to bottom:
//   h1 (hub = menu label, collections = menu label, every other report keeps its report name) -> ONE PeriodPicker (.lims-period) and ONE FilterBar -> ONE StatTileRow
//   -> ONE row of exactly two ChartCards (hero first = two thirds, side second = one third) -> the table(s) (header row ALWAYS drawn) ; Export stays in the header.
// Fake data twice: an EMPTY period (every body empty) and one row of data (the an-t19 fixtures, synthetic). The chart frames ALWAYS draw and say "No data yet"
// when empty. 501 operation_pending = NotAvailable and any 5xx = ErrorState (reference + Retry), both KEEP the title; no red error page, no thrown page.
// JUDGEMENT CALLS (the lead may overrule in a ruling; the tests then change with it), see .orchestra/notes/T0D-UIREPORT-2-tests.md:
//   * tiles and chart titles below are my reading of "as listed in the plan"; they use ONLY fields of the existing report operations;
//   * income and department income read each other's operation (getIncomeReport / getDepartmentIncomeReport) for their second chart; a failing second read leaves the
//     page up and its chart says "No data yet" or "Not available yet";
//   * TAT has no department dimension in the contract (group_by: none, centre, processing_branch, priority, specimen_type, day, month): its bars are by SEGMENT;
//   * interfaces has no per-day numbers in the contract: its hero "Messages per day" shows NotAvailable inside the card (gap goes into the screens note).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { navEntries } from '@/core/nav/generated';
import { t } from '@/core/i18n/messages';
import { barValue, cardByTitle, cardNotAvailable, cardTitle, cards, dataTables, filterBars, frameDraws, frameSaysNoData, hasAlert, headerCells, norm, tileLabel, tileRows, tileValue, tiles, titles } from '@/__tests__/uidash1.helpers';
import { REPORTS, api, bodies, bySlug, resetApi, respond, session, show, ALL } from './an-t19.harness';

vi.mock('next/navigation', async () => (await import('./an-t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetApi(); session.permissions = [...ALL]; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const menuLabel = (path: string) => { const e = navEntries.find((x) => x.path === path); if (!e) throw new Error(`no nav entry for ${path}`); return t(e.label); };
const prob = (status: number, code: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'Synthetic failure', status, code, request_id: '01933b6f-0a11-7e2b-8c55-1d2e3f405162' }, { status });
const HOSTILE = '<img src=x onerror=alert(1)>';

type Rows = [category: string | RegExp, value: RegExp][];
interface Chart { title: string; kind: 'line' | 'bar' | 'na'; rows?: Rows }
interface Spec { slug: string; h1: () => string; tiles: [label: string, value: RegExp][]; hero: Chart; side: Chart; /** the other operation read for one of the two charts */ secondary?: string }

const DEPTS: Rows = [['Synthetic Biochemistry', /9,000/], ['Multiple departments', /6,000/]];
const SPECS: Spec[] = [
  { slug: 'income', h1: () => 'Income', secondary: '/v1/analytics/reports/department-income',
    tiles: [['Net sales', /4,50,000/], ['Invoiced', /4,60,000/], ['Credit notes', /10,000/], ['Invoices', /^6$/]],
    hero: { title: 'Net sales per day', kind: 'line' }, side: { title: 'Net sales by department', kind: 'bar', rows: DEPTS } },
  { slug: 'department-income', h1: () => 'Department income', secondary: '/v1/analytics/reports/income',
    tiles: [['Net sales', /15,000/], ['Gross', /16,000/], ['Discount', /1,000/], ['Billed lines', /^12$/]],
    hero: { title: 'Net sales by department', kind: 'bar', rows: DEPTS }, side: { title: 'Net sales per day', kind: 'line' } },
  { slug: 'collections', h1: () => menuLabel('/analytics/collections'),
    tiles: [['Net collected', /65,000/], ['Collected', /70,000/], ['Reversed/refunded', /5,000/], ['Payments', /^7$/]],
    hero: { title: 'Net collected per day', kind: 'line' }, side: { title: 'Net collected by method', kind: 'bar', rows: [['Cash', /45,000/]] } },
  { slug: 'volume', h1: () => 'Volume',
    tiles: [['Orders', /^28$/], ['Patient visits', /^24$/], ['New patients', /^8$/], ['Tests ordered', /^62$/]],
    hero: { title: 'Patient visits per day', kind: 'line' }, side: { title: 'Orders by type', kind: 'bar', rows: [['OPD', /^20$/], ['IPD', /^6$/], ['Urgent', /^4$/]] } },
  { slug: 'top-referrers', h1: () => 'Top referrers',
    tiles: [['Orders', /^7$/], ['Patient visits', /^7$/], ['Tests ordered', /^16$/]],
    hero: { title: 'Orders by referrer', kind: 'bar', rows: [['Dr Synthetic One', /^5$/], [/^SELF/, /^2$/]] }, side: { title: 'Tests ordered by referrer', kind: 'bar', rows: [['Dr Synthetic One', /^12$/]] } },
  { slug: 'top-centres', h1: () => 'Top centres',
    tiles: [['Orders', /^9$/], ['Patient visits', /^8$/], ['Tests ordered', /^20$/], ['Net sales', /1,25,000/]],
    hero: { title: 'Orders by centre', kind: 'bar', rows: [['Synthetic Centre A', /^9$/]] }, side: { title: 'Net sales by centre', kind: 'bar', rows: [['Synthetic Centre A', /1,25,000/]] } },
  { slug: 'tests-done', h1: () => 'Tests done',
    tiles: [['Resulted', /^80$/], ['Approved', /^72$/], ['Critical', /^6$/], ['Abnormal', /^22$/]],
    hero: { title: 'Tests completed by department', kind: 'bar', rows: [['Synthetic Biochemistry', /^30$/]] }, side: { title: 'Critical and abnormal by department', kind: 'bar', rows: [['Synthetic Biochemistry', /^3$/]] } },
  { slug: 'tat', h1: () => 'Turnaround time (TAT)',
    tiles: [['Samples', /^18$/], ['Excluded (anomalies)', /^1$/]],
    hero: { title: 'Median turnaround by segment', kind: 'bar', rows: [[/^Pre-analytical/, /\d/], [/^Within-lab/, /\d/]] }, side: { title: 'Samples by segment', kind: 'bar', rows: [[/^Pre-analytical/, /^10$/], [/^Within-lab/, /^8$/]] } },
  { slug: 'delivery', h1: () => 'Delivery',
    tiles: [['Sent', /^40$/], ['Delivered', /^36$/], ['Failed', /^4$/], ['Released', /^60$/]],
    hero: { title: 'Released per day', kind: 'line' }, side: { title: 'Sent and failed by channel', kind: 'bar', rows: [['email', /^20$/]] } },
  { slug: 'interfaces', h1: () => 'Instrument interfaces',
    tiles: [['Agents online', /^2$/], ['Agents offline', /^1$/], ['Messages', /^300$/], ['Unmatched', /^9$/]],
    hero: { title: 'Messages per day', kind: 'na' }, side: { title: 'Messages by instrument', kind: 'bar', rows: [[/^Synthetic Haematology Analyser/, /^100$/]] } },
];

const emptyAll = () => { for (const r of REPORTS) { bodies[r.paths[0]!] = r.empty; Object.assign(bodies, r.emptyExtra ?? {}); } };
const chartKind = (c: Element) => (c.querySelector('.lims-chart-series') ? 'line' : c.querySelector('.lims-chart-bar') ? 'bar' : 'none');
const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** The layout every report screen shares (template 5). `empty` = the period has no rows. */
function expectTemplate5(container: HTMLElement, s: Spec, h1: string, empty: boolean) {
  expect(titles(container), 'one h1').toEqual([h1]);
  expect(container.querySelectorAll('.lims-period'), 'one PeriodPicker').toHaveLength(1);
  expect(filterBars(container), 'exactly one FilterBar').toHaveLength(1);
  const rows = tileRows(container);
  expect(rows, 'one StatTileRow').toHaveLength(1);
  expect(tiles(container).map(tileLabel), 'tiles in order').toEqual(s.tiles.map(([l]) => l));
  expect([...rows[0]!.children].every((c) => c.classList.contains('lims-stat')), 'the row holds only tiles').toBe(true);
  if (!empty) s.tiles.forEach(([l, v], i) => expect(tileValue(tiles(container)[i]!), `tile ${l}`).toMatch(v));
  const cs = cards(container);
  expect(cs.map(cardTitle), 'hero then side').toEqual([s.hero.title, s.side.title]);
  expect(cs[0]!.parentElement, 'the two cards share one row').toBe(cs[1]!.parentElement);
  expect([...cs[0]!.parentElement!.children], 'nothing else in the chart row').toEqual(cs);
  expect(cs[0]!.parentElement!.className, 'a named row the stylesheet sizes 2:1').toMatch(/lims-[a-z-]*(charts|chart-row)/);
  const table = dataTables(container)[0]!;
  expect(table, 'a table').toBeTruthy();
  expect(before(rows[0]!, cs[0]!) && before(cs[0]!.parentElement!, table), 'order: tiles, charts, table').toBe(true);
  expect(headerCells(container).length, 'the table header row is drawn, also when empty').toBeGreaterThan(0);
  return cs;
}

function expectChart(card: HTMLElement, c: Chart, empty: boolean) {
  if (c.kind === 'na') { expect(cardNotAvailable(card), `${c.title}: Not available yet inside the card, no alert`).toBe(true); return; }
  expect(frameDraws(card), `${c.title}: the frame draws`).toBe(true);
  if (empty) { expect(frameSaysNoData(card), `${c.title}: No data yet`).toBe(true); return; }
  expect(frameSaysNoData(card), `${c.title}: has data`).toBe(false);
  expect(chartKind(card), `${c.title}: ${c.kind} chart`).toBe(c.kind);
  if (c.kind === 'line') expect(card.querySelectorAll('tbody tr').length, `${c.title}: points`).toBeGreaterThanOrEqual(1);
  for (const [cat, v] of c.rows ?? []) expect(barValue(card, cat), `${c.title}: ${String(cat)}`).toMatch(v);
  expect(card.outerHTML, `${c.title}: accent plus grey, no colour literal`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(|gradient/i);
}

describe.each(SPECS)('report $slug (template 5)', (s) => {
  const r = bySlug(s.slug);
  const main = r.paths[0]!;

  it('one row of data: title, period, one FilterBar, one tile row, hero and side chart with data, then the table', async () => {
    const { container } = await show(s.slug);
    const cs = expectTemplate5(container, s, s.h1(), false);
    expectChart(cs[0]!, s.hero, false);
    expectChart(cs[1]!, s.side, false);
    expect(hasAlert(container), 'no alert').toBe(false);
  });

  it('empty period: the same layout, both frames still draw and say "No data yet", the table keeps its header row and its empty state', async () => {
    emptyAll();
    const { container } = await show(s.slug);
    const cs = expectTemplate5(container, s, s.h1(), true);
    expectChart(cs[0]!, s.hero, true);
    expectChart(cs[1]!, s.side, true);
    expect(norm(container.textContent)).toContain('No data for this period and filter');
    for (const h of r.tables[0]!.headers) expect(headerCells(container), `column ${h}`).toContain(h);
  });

  it('501 operation_pending: the title stays, "Not available yet", no red alert, no danger tone, no thrown page', async () => {
    respond[main] = () => prob(501, 'operation_pending');
    const { container } = await show(s.slug);
    expect(titles(container)).toEqual([s.h1()]);
    expect(norm(container.textContent)).toMatch(/not available yet/i);
    expect(hasAlert(container)).toBe(false);
    expect(container.querySelectorAll('.lims-tone-danger')).toHaveLength(0);
    expect(norm(container.textContent)).not.toMatch(/something went wrong/i);
  });

  it.each([500, 503])('API %i: the title stays, ErrorState with reference and Retry, no figures, no thrown page', async (status) => {
    respond[main] = () => prob(status, status === 500 ? 'common.internal' : 'common.dependency_unavailable');
    const { container } = await show(s.slug);
    expect(titles(container)).toEqual([s.h1()]);
    const err = container.querySelectorAll('.lims-state.lims-tone-danger');
    expect(err, 'one ErrorState').toHaveLength(1);
    expect(norm(err[0]!.querySelector('.lims-state-ref')?.textContent)).toMatch(/reference/i);
    expect([...err[0]!.querySelectorAll('button')].map((b) => norm(b.textContent))).toContain('Retry');
    expect(tiles(container)).toHaveLength(0);
    expect(cards(container)).toHaveLength(0);
    expect(norm(container.textContent)).not.toMatch(/something went wrong/i);
  });

  it('a hostile label stays text in the chart and the page (REQ-SEC-088/089)', async () => {
    bodies[main] = r.hostile(r.body, HOSTILE);
    const { container } = await show(s.slug);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('[onerror]')).toHaveLength(0);
  });

  it.skipIf(!s.secondary)('the second read failing (503): the page stays up, the title stays, the chart that needed it says "No data yet" or "Not available yet"', async () => {
    respond[s.secondary!] = () => prob(503, 'common.dependency_unavailable');
    const { container } = await show(s.slug);
    expect(titles(container)).toEqual([s.h1()]);
    expect(hasAlert(container)).toBe(false);
    expect(tiles(container).map(tileLabel)).toEqual(s.tiles.map(([l]) => l));
    const card = cardByTitle(container, s.side.title)!; // both pairs (income, department income) take their SIDE chart from the other operation
    expect(frameSaysNoData(card) || cardNotAvailable(card), `${s.side.title} is calm`).toBe(true);
    expectChart(cardByTitle(container, s.hero.title)!, s.hero, false); // the hero (own operation) still draws its data
  });
});

describe('the menu pages keep the menu label as their title (LD-353 rule 8)', () => {
  it('the hub /analytics/reports: h1 = the menu label, the Income body (tiles, two cards, table) under it', async () => {
    const { container } = await show('hub');
    expect(titles(container)).toEqual([menuLabel('/analytics/reports')]);
    expect(tileRows(container)).toHaveLength(1);
    expect(cards(container).map(cardTitle)).toEqual(['Net sales per day', 'Net sales by department']);
    expect(filterBars(container)).toHaveLength(1);
    expect(container.querySelectorAll('.lims-period')).toHaveLength(1);
  });

  it('the hub, empty period: h1 and the frames stay', async () => {
    emptyAll();
    const { container } = await show('hub');
    expect(titles(container)).toEqual([menuLabel('/analytics/reports')]);
    for (const c of cards(container)) { expect(frameDraws(c)).toBe(true); expect(frameSaysNoData(c)).toBe(true); }
  });

  it('the hub on 501 and on 500 keeps the menu label as the title', async () => {
    respond['/v1/analytics/reports/income'] = () => prob(501, 'operation_pending');
    let { container } = await show('hub');
    expect(titles(container)).toEqual([menuLabel('/analytics/reports')]);
    expect(norm(container.textContent)).toMatch(/not available yet/i);
    cleanup();
    respond['/v1/analytics/reports/income'] = () => prob(500, 'common.internal');
    ({ container } = await show('hub'));
    expect(titles(container)).toEqual([menuLabel('/analytics/reports')]);
    expect(container.querySelectorAll('.lims-state.lims-tone-danger')).toHaveLength(1);
  });

  it('collections on 501 and on 500 keeps the menu label as the title', async () => {
    respond['/v1/analytics/reports/collections'] = () => prob(501, 'operation_pending');
    let { container } = await show('collections');
    expect(titles(container)).toEqual([menuLabel('/analytics/collections')]);
    expect(norm(container.textContent)).toMatch(/not available yet/i);
    cleanup();
    respond['/v1/analytics/reports/collections'] = () => prob(500, 'common.internal');
    ({ container } = await show('collections'));
    expect(titles(container)).toEqual([menuLabel('/analytics/collections')]);
    expect(container.querySelectorAll('.lims-state.lims-tone-danger')).toHaveLength(1);
  });
});
