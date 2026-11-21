// @vitest-environment jsdom
// T0D-UIREPORT-2 (LD-353 template 5; done_when "the bill of the day"): /billing/bill-of-the-day (MisReportView, one-day). Reached through the page default export with the
// misreports1 harness (mocks from catalog/__tests__/testmgmt1.setup.ts). The MIS definitions have NO read operation yet (T0D-MISREPORTS-1-cr-needed.md), so the screen
// shows its layout without rows: h1 = the menu label, ONE PeriodPicker (the day; .lims-period), ONE FilterBar (today the day input sits in a second .lims-filter-bar
// wrapper around the kit FilterBar: that is the red), ONE StatTileRow of four tiles (Gross, Net, Paid, Due) whose values are NOT numbers while there is no data ("—" or
// Not available), TWO ChartCards whose frames draw and say "No data yet" (or Not available yet), the table with its header row and the payment mode table; Print and
// Export stay in the header.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { navEntries } from '@/core/nav/generated';
import { t } from '@/core/i18n/messages';
import { cardNotAvailable, cardTitle, cards, filterBars, frameDraws, frameSaysNoData, hasAlert, headerCells, norm, tileLabel, tileRows, tileValue, tiles, titles } from '@/__tests__/uidash1.helpers';
import { API, BOTD_PAGE, PERM, TM, api, def, openPage } from './misreports1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => api.close());

const menu = () => { const e = navEntries.find((x) => x.path === '/billing/bill-of-the-day'); if (!e) throw new Error('no nav entry for /billing/bill-of-the-day'); return t(e.label); };
const open = () => openPage(BOTD_PAGE, { perms: [PERM.collections, PERM.export] });

describe('Bill of the Day (template 5, no rows yet)', () => {
  it('h1 is the menu label, once', async () => {
    const { container } = await open();
    expect(titles(container)).toEqual([menu()]);
  });

  it('ONE PeriodPicker and ONE FilterBar (no second .lims-filter-bar wrapper)', async () => {
    const { container } = await open();
    expect(container.querySelectorAll('.lims-period'), 'one PeriodPicker').toHaveLength(1);
    expect(filterBars(container), 'exactly one FilterBar').toHaveLength(1);
  });

  it('ONE tile row: Gross, Net, Paid, Due; without data no tile shows a number', async () => {
    const { container } = await open();
    expect(tileRows(container)).toHaveLength(1);
    expect(tiles(container).map(tileLabel)).toEqual(['Gross', 'Net', 'Paid', 'Due']);
    for (const tile of tiles(container)) expect(tileValue(tile), `${tileLabel(tile)} is not a made-up number`).not.toMatch(/\d/);
  });

  it('two ChartCards in one row, both frames draw and say "No data yet" (or Not available yet), titles differ', async () => {
    const { container } = await open();
    const cs = cards(container);
    expect(cs).toHaveLength(2);
    expect(cs[0]!.parentElement).toBe(cs[1]!.parentElement);
    expect(cs[0]!.parentElement!.className).toMatch(/lims-[a-z-]*(charts|chart-row)/);
    expect(new Set(cs.map(cardTitle)).size).toBe(2);
    for (const c of cs) {
      if (cardNotAvailable(c)) continue;
      expect(frameDraws(c), `${cardTitle(c)} draws`).toBe(true);
      expect(frameSaysNoData(c), `${cardTitle(c)} says No data yet`).toBe(true);
    }
  });

  it('the table keeps its header row (every column of the definition without ids) and the payment mode table stays; no alert', async () => {
    const { container } = await open();
    const want = def('bill_of_the_day').columns.filter((c) => !c.name.endsWith('_id')).map((c) => c.title);
    expect(headerCells(container)).toEqual(expect.arrayContaining(want));
    expect(headerCells(container), 'the payment mode table header').toEqual(expect.arrayContaining([t('billing.botd.mode'), t('billing.botd.amount')]));
    expect(hasAlert(container)).toBe(false);
  });

  it('order: tiles, then charts, then the table; Print and Export stay', async () => {
    const { container } = await open();
    const [row] = tileRows(container);
    const [card] = cards(container);
    const table = container.querySelector('table, [role="grid"]')!;
    const after = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(row!, card!) && after(card!.parentElement!, table)).toBe(true);
    const buttons = [...container.querySelectorAll('button')].map((b) => norm(b.textContent));
    expect(buttons).toEqual(expect.arrayContaining([t('analytics.mis.print'), t('analytics.mis.export')]));
  });

  it('no colour literal and no inline gradient in the added chart cards', async () => {
    const { container } = await open();
    for (const c of cards(container)) expect(c.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(|gradient/i);
  });
});
