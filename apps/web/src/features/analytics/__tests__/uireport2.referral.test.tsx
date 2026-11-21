// @vitest-environment jsdom
// T0D-UIREPORT-2 (LD-353 template 5; done_when "referral incentive (behind its switch)"): /analytics/referral-incentive, the Referral business report.
// Same layout as uireport2.reports: h1 = the menu label (nav entry analytics.referral), ONE PeriodPicker, ONE FilterBar, ONE tile row (Orders, Patient visits,
// Tests ordered, Net billed), hero bar "Net billed by referrer" then side bar "Orders by referrer" (one row of two ChartCards), then the table. Frames always draw
// ("No data yet" when empty). 501 = NotAvailable, 5xx = ErrorState, both keep the title. BEHIND ITS SWITCH (A39, LD-342): when the API says
// common.feature_disabled or auth.mfa_required the screen draws NO tile, NO chart and no figure (the existing ReferralState stays; an-t20.referral keeps its copy).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { navEntries } from '@/core/nav/generated';
import { t } from '@/core/i18n/messages';
import { barValue, cardNotAvailable, cardTitle, cards, dataTables, filterBars, frameDraws, frameSaysNoData, hasAlert, headerCells, norm, tileLabel, tileRows, tileValue, tiles, titles } from '@/__tests__/uidash1.helpers';
import { FRESH, PERIOD, REF_1, REF_2, api, json, problem, resetApi, routes, show } from './an-t20.harness';

vi.mock('next/navigation', async () => (await import('./an-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t20.harness')).sessionMock);

const PAGE = 'referral-incentive/page';
const PATH = 'GET /v1/analytics/reports/referral-incentive';
const READ = ['analytics.referral_report.read'];
const RID = { request_id: '01933b6f-0a11-7e2b-8c55-1d2e3f405162' };
const menu = () => { const e = navEntries.find((x) => x.path === '/analytics/referral-incentive'); if (!e) throw new Error('no nav entry'); return t(e.label); };

const body = (over: Record<string, unknown> = {}) => ({
  report_code: 'referral_incentive', period: PERIOD, scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] }, freshness: FRESH, generated_at: '2026-01-15T04:30:00.000Z',
  rows: [
    { referrer_id: REF_1, label: 'Dr Synthetic Sharma', is_self: false, orders: 12, patient_visits: 10, tests_ordered: 30, net_billed_paisa: 123456780 },
    { referrer_id: REF_2, label: 'Dr Synthetic Rai', is_self: false, orders: 4, patient_visits: 4, tests_ordered: 9, net_billed_paisa: 50000 },
    { label: 'SELF (no referrer)', is_self: true, orders: 7, patient_visits: 7, tests_ordered: 15 },
  ],
  totals: { orders: 23, patient_visits: 21, tests_ordered: 54, net_billed_paisa: 123461780 },
  billed_note_key: 'analytics.referrers.billed_note', page: { limit: 50 }, ...over,
});
const EMPTY = body({ rows: [], totals: { orders: 0, patient_visits: 0, tests_ordered: 0, net_billed_paisa: 0 } });

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetApi(READ); routes[PATH] = json(body()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

describe('referral business report (template 5)', () => {
  it('one row of data: title, one PeriodPicker, one FilterBar, four tiles, hero and side bar with data, then the table', async () => {
    const { container } = await show(PAGE);
    expect(titles(container)).toEqual([menu()]);
    expect(container.querySelectorAll('.lims-period')).toHaveLength(1);
    expect(filterBars(container)).toHaveLength(1);
    const rows = tileRows(container);
    expect(rows).toHaveLength(1);
    expect(tiles(container).map(tileLabel)).toEqual(['Orders', 'Patient visits', 'Tests ordered', 'Net billed']);
    expect(tiles(container).map(tileValue).map((v, i) => [v, [/^23$/, /^21$/, /^54$/, /12,34,617/][i]!] as const).every(([v, re]) => re.test(v)), 'tile values').toBe(true);
    const cs = cards(container);
    expect(cs.map(cardTitle)).toEqual(['Net billed by referrer', 'Orders by referrer']);
    expect(cs[0]!.parentElement).toBe(cs[1]!.parentElement);
    expect(cs[0]!.parentElement!.className).toMatch(/lims-[a-z-]*(charts|chart-row)/);
    for (const c of cs) { expect(frameDraws(c)).toBe(true); expect(frameSaysNoData(c)).toBe(false); }
    expect(barValue(cs[0]!, 'Dr Synthetic Sharma')).toMatch(/12,34,567/);
    expect(barValue(cs[1]!, 'Dr Synthetic Sharma')).toMatch(/^12$/);
    expect(dataTables(container)[0], 'the table follows the charts').toBeTruthy();
    expect(!!(cs[0]!.parentElement!.compareDocumentPosition(dataTables(container)[0]!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(hasAlert(container)).toBe(false);
  });

  it('empty period: same layout, both frames say "No data yet", the header row stays', async () => {
    routes[PATH] = json(EMPTY);
    const { container } = await show(PAGE);
    expect(titles(container)).toEqual([menu()]);
    expect(tileRows(container)).toHaveLength(1);
    const cs = cards(container);
    expect(cs.map(cardTitle)).toEqual(['Net billed by referrer', 'Orders by referrer']);
    for (const c of cs) { expect(frameDraws(c)).toBe(true); expect(frameSaysNoData(c)).toBe(true); }
    expect(headerCells(container)).toEqual(expect.arrayContaining(['Referrer', 'Orders', 'Patient visits', 'Tests ordered', 'Net billed']));
    expect(filterBars(container)).toHaveLength(1);
  });

  it('501 operation_pending: title stays, Not available yet, no red alert', async () => {
    routes[PATH] = () => problem('operation_pending', 501);
    const { container } = await show(PAGE);
    expect(titles(container)).toEqual([menu()]);
    expect(norm(container.textContent)).toMatch(/not available yet/i);
    expect(hasAlert(container)).toBe(false);
    expect(container.querySelectorAll('.lims-tone-danger')).toHaveLength(0);
  });

  it.each([500, 503])('API %i: title stays, ErrorState with reference and Retry, no figures', async (status) => {
    routes[PATH] = () => problem(status === 500 ? 'common.internal' : 'common.dependency_unavailable', status, RID);
    const { container } = await show(PAGE);
    expect(titles(container)).toEqual([menu()]);
    const err = container.querySelectorAll('.lims-state.lims-tone-danger');
    expect(err).toHaveLength(1);
    expect(norm(err[0]!.querySelector('.lims-state-ref')?.textContent)).toMatch(/reference/i);
    expect([...err[0]!.querySelectorAll('button')].map((b) => norm(b.textContent))).toContain('Retry');
    expect(tiles(container)).toHaveLength(0);
    expect(cards(container)).toHaveLength(0);
  });

  it.each([['common.feature_disabled'], ['auth.mfa_required']])('switch closed (403 %s): no tile, no chart card, no figure, no commission or amount word', async (code) => {
    routes[PATH] = () => problem(code, 403);
    const { container } = await show(PAGE);
    expect(tiles(container)).toHaveLength(0);
    expect(tileRows(container)).toHaveLength(0);
    expect(cards(container)).toHaveLength(0);
    expect(norm(container.textContent)).not.toMatch(/Net billed|12,34,5|Dr Synthetic|Orders by referrer/);
    expect(cardNotAvailable(container)).toBe(false);
  });

  it('a hostile referrer label stays text in both charts', async () => {
    const b = body(); b.rows[0]!.label = '<img src=x onerror=alert(1)>';
    routes[PATH] = json(b);
    const { container } = await show(PAGE);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('[onerror]')).toHaveLength(0);
  });
});
