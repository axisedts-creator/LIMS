// @vitest-environment jsdom
// RS-C8 — Owner dashboard (app/(staff)/analytics/page.tsx) rearranged per 10-DESIGN-SYSTEM s3/s4 ("Today" row) and s6 (LD-140): appearance and arrangement only.
// Reads the page the way an-t18 does (MSW plays the API; API shapes unchanged). The chunk's own an-t18 tests keep covering behaviour and stay green.
//
// CONTRACT the writer must meet (the spec fixes the layout, not the markup; names below are the minimum that makes it testable and accessible):
//   1. Pipeline: ONE ordered list named /pipeline/i (`<ol aria-label="Sample pipeline">`) with exactly 7 items in this order:
//      Draft, To collect, To receive, In progress, To authorise, Authorised, Released. Each count is a FILTER = an `<a href>` (native Enter), whose
//      accessible name contains the stage label, and whose href is an existing analytics page (reports/<code> or collections; a query string is fine).
//      NO NEW DATA (LD-140): a number shown in the pipeline must be a value the API sent in `tiles` (formatted as before); a stage with no source tile
//      shows no number and no link (never an invented 0). At least 2 stages are linked (In progress = pending_tests, Authorised = results_approved are the natural sources).
//   2. "Needs you": a region named /needs you/i holding a list of actionable items built from the existing tiles only (pending_overdue "Overdue",
//      reports_ready_unreleased "Ready, not released", reports_pending "Reports pending"), each a link to an existing analytics page, most urgent first (Overdue first).
//      A tile the API did not send (the API scopes tiles by the caller's permission = "per role") gives NO item and no invented 0. When nothing is actionable the
//      region says "Nothing needs you" (a sentence, not an empty box).
//   3. Money strip: a region named /money/i, present ONLY when the API sent a paisa tile (it is the API that applies billing.cash_report.read / analytics scope;
//      permissions are not changed here), containing every sent money tile with the currency "Rs." and the period label (A.D.). Pipeline and needs-you carry no money.
//   4. No grid of equal KPI tiles (10-DESIGN-SYSTEM s4, s6): no `.lims-grid` of stat tiles; at most 3 per region and 2 outside (10-DESIGN-SYSTEM.md:101,125; RS-C8-ruling.md).
//   5. DOM order: pipeline, then needs you, then money (reading and Tab order = the order of importance). One h1.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@lims/ui/components/Toast';
import { api, axeClean, bodies, norm, resetApi, session } from './an-t19.harness';

vi.mock('next/navigation', async () => (await import('./an-t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t19.harness')).sessionMock);

const DEPT = '01a1a98a-ac40-7000-8000-000000000005';
const tile = (value: number, unit = 'count', extra: Record<string, unknown> = {}) => ({ value, unit, ...extra });
const FRESH = [{ family: 'orders', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false }, { family: 'income', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false }];
const PERIOD = { business_date_from: '2026-01-15', business_date_to: '2026-01-16', days: 1, label_ad: '15 Jan 2026', label_bs: '2082-10-01', timezone: 'Asia/Kathmandu' };
const FULL = {
  patient_visits: tile(12, 'count', { previous: 10, delta: 2, delta_bp: 2000 }),
  new_patients: tile(4),
  net_orders: tile(13),
  tests_ordered: tile(31),
  net_sales_paisa: tile(22500000, 'paisa', { previous: 20810000, delta: 1690000, delta_bp: 812 }),
  invoiced_paisa: tile(23000000, 'paisa'),
  credit_notes_paisa: tile(500000, 'paisa'),
  net_collected_paisa: tile(19000000, 'paisa'),
  results_approved: tile(28, 'count', { previous: 26, delta: 2, delta_bp: 769 }),
  reports_pending: tile(5),
  reports_ready_unreleased: tile(2),
  pending_tests: tile(9),
  pending_overdue: tile(1),
};
const dto = (tiles: Record<string, unknown>) => ({
  report_code: 'dashboard', period: PERIOD, scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] }, freshness: FRESH, generated_at: '2026-01-15T04:30:00.000Z',
  tiles,
  series: { days: [{ business_date: '2026-01-15', net_sales_paisa: 22500000, patient_visits: 12, net_orders: 13 }] },
  department_top: [{ department_id: DEPT, label: 'Synthetic Biochemistry', is_multiple: false, net_paisa: 900000, share_bp: 6294 }],
});
const without = (...keys: string[]) => Object.fromEntries(Object.entries(FULL).filter(([k]) => !keys.includes(k)));
const MONEY_KEYS = ['net_sales_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'net_collected_paisa'];
const QUIET = { ...FULL, pending_overdue: tile(0), reports_ready_unreleased: tile(0), reports_pending: tile(0) };

async function open(tiles: Record<string, unknown>) {
  bodies['/v1/analytics/dashboard'] = dto(tiles);
  session.permissions = ['analytics.dashboard.read', 'analytics.collections.read', 'billing.cash_report.read'];
  const mod = (await import('../../../app/(staff)/analytics/page')) as { default: (p: any) => Promise<any> };
  const el = await mod.default({ searchParams: Promise.resolve({}) });
  return render(<ToastProvider>{el}</ToastProvider>);
}

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi());
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const STAGES = ['Draft', 'To collect', 'To receive', 'In progress', 'To authorise', 'Authorised', 'Released'];
const STAGE_RE = STAGES.map((s) => new RegExp(`\\b${s}\\b`, 'i'));
const ANALYTICS_PAGE = /^\/analytics(?:\/(?:collections|exports|schedules|referral-incentive|reports(?:\/[a-z][a-z-]*)?))?(?:\?[^#]*)?$/;
const FORMATTED_TILE_NUMBERS = new Set(['12', '4', '13', '31', '28', '5', '2', '9', '1']); // en-IN of the FULL count tiles
const pipeline = () => screen.getByRole('list', { name: /pipeline/i });
// pipeline text without a tile's own delta caption (`delta` / `delta_bp` are API data that an-t18 requires inside the tile; RS-C8-ruling.md)
const pipelineText = () => { const c = pipeline().cloneNode(true) as HTMLElement; c.querySelectorAll('.lims-stat-delta').forEach((e) => e.remove()); return norm(c.textContent); };
const needsYou = () => screen.getByRole('region', { name: /needs you/i });
const moneyStrip = () => screen.queryByRole('region', { name: /money/i });
const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('RS-C8 dashboard — one pipeline stepper (10-DESIGN-SYSTEM s4 Today)', () => {
  it('is one ordered list of the 7 stages in the design order', async () => {
    await open(FULL);
    const items = within(pipeline()).getAllByRole('listitem');
    expect(items).toHaveLength(7);
    const found = items.map((li) => STAGE_RE.findIndex((re) => re.test(norm(li.textContent))));
    expect(found).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(screen.getAllByRole('list', { name: /pipeline/i })).toHaveLength(1);
  });

  it('each count is a filter: a real link named with its stage, to an existing analytics page; at least 2 stages are linked', async () => {
    await open(FULL);
    const links = within(pipeline()).getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const a of links) {
      expect(a.getAttribute('href') ?? '', norm(a.textContent)).toMatch(ANALYTICS_PAGE);
      const stage = within(pipeline()).getAllByRole('listitem').find((li) => li.contains(a))!;
      const label = STAGES[STAGE_RE.findIndex((re) => re.test(norm(stage.textContent)))]!;
      expect(norm(a.getAttribute('aria-label') ?? a.textContent), `link in "${label}"`).toMatch(new RegExp(`\\b${label}\\b`, 'i'));
    }
  });

  it('shows no number the API did not send, and no money (LD-140: no new data; a stage without a source tile has no count)', async () => {
    await open(FULL);
    const text = pipelineText();
    expect(text).not.toMatch(/Rs\./);
    for (const n of text.match(/\d[\d,]*/g) ?? []) expect(FORMATTED_TILE_NUMBERS.has(n), `"${n}" in the pipeline is not a tile value`).toBe(true);
    // stages shown as 7 even when the API sends none of the lab tiles: counts vanish, they do not turn into 0
    cleanup();
    await open(without('results_approved', 'pending_tests', 'reports_pending', 'reports_ready_unreleased', 'pending_overdue'));
    expect(within(pipeline()).getAllByRole('listitem')).toHaveLength(7);
    expect(pipelineText()).not.toMatch(/\b0\b/);
  });
});

describe('RS-C8 dashboard — "needs you" list (10-DESIGN-SYSTEM s4)', () => {
  it('lists the actionable items from existing tiles, linked, Overdue first', async () => {
    await open(FULL);
    const items = within(within(needsYou()).getByRole('list')).getAllByRole('listitem');
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(norm(items[0]!.textContent)).toMatch(/overdue/i);
    expect(norm(items[0]!.textContent)).toMatch(/\b1\b/);
    expect(items.map((i) => norm(i.textContent)).join(' | ')).toMatch(/ready, not released.*\b2\b|\b2\b.*ready, not released/i);
    for (const li of items) {
      const a = within(li).getByRole('link');
      expect(a.getAttribute('href') ?? '').toMatch(ANALYTICS_PAGE);
    }
  });

  it('role-scoped: a tile the API did not send gives no item and no invented 0', async () => {
    await open(without('pending_overdue', 'reports_ready_unreleased', ...MONEY_KEYS));
    const text = norm(needsYou().textContent);
    expect(text).not.toMatch(/overdue/i);
    expect(text).not.toMatch(/ready, not released/i);
    expect(text).not.toMatch(/\b0\b/);
    expect(text).toMatch(/reports pending/i);
  });

  it('nothing actionable: says so in a sentence', async () => {
    await open(QUIET);
    expect(norm(needsYou().textContent)).toMatch(/nothing needs you/i);
    expect(within(needsYou()).queryAllByRole('link')).toHaveLength(0);
  });
});

describe('RS-C8 dashboard — money strip only where the API sent money, with currency and period (s4, s6)', () => {
  it('shows a strip with every money tile in Rs. and the period', async () => {
    await open(FULL);
    const strip = moneyStrip();
    expect(strip).not.toBeNull();
    const text = norm(strip!.textContent);
    for (const v of ['2,25,000.00', '2,30,000.00', '5,000.00', '1,90,000.00']) expect(text, v).toContain(`Rs. ${v}`);
    expect(text).toContain(PERIOD.label_ad);
    expect(norm(strip!.textContent)).not.toMatch(/patient visits|pending tests/i);
  });

  it('no paisa tile from the API (a role without money access): no strip, no money label, no "Rs." figure outside charts', async () => {
    const { container } = await open(without(...MONEY_KEYS));
    expect(moneyStrip()).toBeNull();
    expect(screen.queryByText(/^(income \(net sales\)|cash collected \(net\))$/i)).toBeNull();
    expect(norm(container.textContent)).not.toMatch(/Rs\. [\d,]+\.\d\d/);
  });

  it('keeps the money out of the pipeline and the needs-you list', async () => {
    await open(FULL);
    expect(norm(pipeline().textContent)).not.toMatch(/Rs\./);
    expect(norm(needsYou().textContent)).not.toMatch(/Rs\./);
  });
});

describe('RS-C8 dashboard — arrangement (s6: no grid of equal KPI tiles, one container level)', () => {
  it('no grid of stat tiles (at most 3 per region, 2 outside them) and one h1', async () => {
    const { container } = await open(FULL);
    const stats = Array.from(container.querySelectorAll('.lims-stat'));
    for (const e of stats) expect(e.closest('.lims-grid'), 'a .lims-stat inside a .lims-grid').toBeNull();
    const regions = [pipeline(), needsYou(), moneyStrip()].filter((r): r is HTMLElement => r !== null);
    for (const r of regions) expect(r.querySelectorAll('.lims-stat').length).toBeLessThanOrEqual(3);
    expect(stats.filter((e) => !regions.some((r) => r.contains(e))).length).toBeLessThanOrEqual(2);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('DOM order = importance: pipeline, then needs you, then money', async () => {
    await open(FULL);
    expect(before(pipeline(), needsYou())).toBe(true);
    expect(before(needsYou(), moneyStrip()!)).toBe(true);
  });

  it('keeps what an-t18 pins: both period labels, the two definition notes, the charts and the refresh button', async () => {
    const { container } = await open(FULL);
    expect(norm(container.textContent)).toContain('15 Jan 2026');
    expect(norm(container.textContent)).toContain('2082-10-01');
    expect(screen.getByText(/counts each patient once per centre per day/i)).toBeTruthy();
    expect(screen.getByText(/income = invoices issued/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeTruthy();
    expect(screen.getAllByText('Net sales per day').length).toBeGreaterThan(0);
  });
});

describe('RS-C8 dashboard — keyboard-only path (task "tests")', () => {
  const focusables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')];

  it('Tab reaches pipeline links, then needs-you links, then the money strip; nothing needs a positive tabindex; Tab does not trap', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = await open(FULL);
    expect(container.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toHaveLength(0);
    const order: HTMLElement[] = [];
    for (let i = 0; i < 60; i++) {
      await user.tab();
      const el = document.activeElement as HTMLElement;
      if (!el || el === document.body) break;
      order.push(el);
    }
    const idx = (root: Element) => order.findIndex((e) => root.contains(e));
    const p = idx(pipeline());
    const n = idx(needsYou());
    expect(p, 'a pipeline link takes focus').toBeGreaterThanOrEqual(0);
    expect(n, 'a needs-you link takes focus').toBeGreaterThan(p);
    const strip = moneyStrip();
    if (focusables(strip as HTMLElement).length > 0) expect(idx(strip!)).toBeGreaterThan(n);
    // every focusable control on the page is reachable by Tab alone
    const reached = new Set(order);
    const missed = focusables(container).filter((e) => !reached.has(e)).map((e) => norm(e.textContent) || e.outerHTML.slice(0, 60));
    expect(missed).toEqual([]);
  });

  it('a pipeline filter is a native link (Enter activates it) with a visible text name', async () => {
    const user = userEvent.setup({ delay: null });
    await open(FULL);
    const a = within(pipeline()).getAllByRole('link')[0]!;
    await user.tab(); // focus enters the page
    a.focus();
    expect(document.activeElement).toBe(a);
    expect(a.tagName).toBe('A');
    expect(norm(a.textContent).length).toBeGreaterThan(0);
  });
});

describe('RS-C8 dashboard — accessibility (axe zero serious/critical; task "tests")', () => {
  it.each([
    ['populated', FULL],
    ['nothing actionable', QUIET],
    ['role without money', without(...MONEY_KEYS)],
    ['all zero (empty state)', Object.fromEntries(Object.entries(FULL).map(([k, v]) => [k, { ...v, value: 0, delta: undefined, delta_bp: undefined }]))],
  ])('%s variant is axe-clean', async (_name, tiles) => {
    await open(tiles as Record<string, unknown>);
    await axeClean();
  });
});
