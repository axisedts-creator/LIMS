// @vitest-environment jsdom
// RS-C8 — Owner dashboard (app/(staff)/analytics/page.tsx) rearranged per 10-DESIGN-SYSTEM s3/s4 ("Today" row) and s6 (LD-140): appearance and arrangement only.
// Reads the page the way an-t18 does (MSW plays the API; API shapes unchanged). The chunk's own an-t18 tests keep covering behaviour.
//
// RE-PINNED by T0D-UIDASH-2 (review item 1; LD-436 mock + LD-437 exact match override the older spec layout for this task). What changed against the first RS-C8 contract:
//   1. Pipeline: Card "Where the samples are" holding the kit StatusStepper (ONE `.lims-stepper`) with SIX stages in the mock order Registered, Collected, Received, In testing,
//      Verified, Released (was seven: Draft ... Released). The mock stepper has no links, so the "each count is a link" pin is gone. NO NEW DATA (LD-140) stays: a number in the
//      stepper must be a value the API sent in `tiles` (In testing = pending_tests, Verified = results_approved, "n overdue" = pending_overdue); a stage without a source tile
//      shows no number (never an invented 0).
//   2. "Needs you": Card "Needs you" with ONE kit ActionList (`ul.lims-action-list`), rows are links to existing analytics pages built from existing tiles only
//      (pending_overdue "Overdue", reports_ready_unreleased "Ready, not released", reports_pending "Reports pending"), Overdue first; a tile the API did not send gives NO row
//      and no invented 0; nothing actionable: "Nothing needs you right now." (a sentence, no list).
//   3. Money: Card "Money, <period A.D.>" present ONLY when the API sent a paisa tile; four StatTile cells Billed (invoiced) and Collected (net collected) in Rs. through MoneyText,
//      Outstanding and Cash in drawer "Not available yet". Pipeline and needs-you carry no money. (Net sales and credit notes are no longer drawn as cells: not in the mock.)
//   4. Arrangement: no `.lims-grid`; every `.lims-stat` lives inside the Money card in ONE container; pipeline stages and needs-you rows are never `.lims-stat`; one h1.
//   5. DOM order: pipeline card, then needs you, then money. Reading and Tab order = importance.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => resetApi());
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const STAGES = ['Registered', 'Collected', 'Received', 'In testing', 'Verified', 'Released'];
const ANALYTICS_PAGE = /^\/analytics(?:\/(?:collections|exports|schedules|referral-incentive|reports(?:\/[a-z][a-z-]*)?))?(?:\?[^#]*)?$/;
const FORMATTED_TILE_NUMBERS = new Set(['12', '4', '13', '31', '28', '5', '2', '9', '1']); // en-IN of the FULL count tiles
// the kit Card that holds a title (Card: h2.lims-card-title inside .lims-card)
const cardOf = (title: RegExp | string): HTMLElement | null => {
  const h = [...document.querySelectorAll('.lims-card-title')].find((e) => (typeof title === 'string' ? norm(e.textContent) === title : title.test(norm(e.textContent))));
  return (h?.closest('.lims-card') as HTMLElement | null) ?? null;
};
const pipelineCard = () => cardOf('Where the samples are')!;
const pipeline = () => pipelineCard().querySelector('.lims-stepper') as HTMLElement;
const stageItems = () => [...pipeline().querySelectorAll<HTMLElement>('li.lims-step')];
// stepper text without the stage-state words
const pipelineText = () => norm(pipeline().textContent);
const needsYou = () => cardOf('Needs you')!;
const needsRows = () => [...needsYou().querySelectorAll<HTMLAnchorElement>('ul.lims-action-list a.lims-action-row')];
const moneyStrip = () => cardOf(/^Money\b/);
const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('RS-C8 dashboard — one pipeline stepper (LD-436 mock, Card "Where the samples are")', () => {
  it('is one StatusStepper of the 6 stages in the mock order', async () => {
    await open(FULL);
    expect(pipelineCard()).not.toBeNull();
    expect(stageItems().map((li) => norm(li.querySelector('.lims-step-label')?.textContent))).toEqual(STAGES);
    expect(document.querySelectorAll('.lims-stepper')).toHaveLength(1);
  });

  it('the mock stepper carries no links (a count is a figure, not a filter)', async () => {
    await open(FULL);
    expect(pipeline().querySelectorAll('a[href]')).toHaveLength(0);
  });

  it('shows no number the API did not send, and no money (LD-140: no new data; a stage without a source tile has no count)', async () => {
    await open(FULL);
    const text = pipelineText();
    expect(text).not.toMatch(/Rs\./);
    for (const n of text.match(/\d[\d,]*/g) ?? []) expect(FORMATTED_TILE_NUMBERS.has(n), `"${n}" in the pipeline is not a tile value`).toBe(true);
    expect(norm(stageItems()[3]!.textContent)).toMatch(/\b9\b/); // In testing = pending_tests
    expect(norm(stageItems()[4]!.textContent)).toMatch(/\b28\b/); // Verified = results_approved
    // stages shown as 6 even when the API sends none of the lab tiles: counts vanish, they do not turn into 0
    cleanup();
    await open(without('results_approved', 'pending_tests', 'reports_pending', 'reports_ready_unreleased', 'pending_overdue'));
    expect(stageItems()).toHaveLength(6);
    expect(pipelineText()).not.toMatch(/\b0\b/);
  });
});

describe('RS-C8 dashboard — "needs you" ActionList (LD-436 mock)', () => {
  it('lists the actionable items from existing tiles, linked, Overdue first', async () => {
    await open(FULL);
    const rows = needsRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const row = (r: Element) => ({ title: norm(r.querySelector('.lims-action-title')?.textContent), count: norm(r.querySelector('.lims-chip')?.textContent) });
    expect(row(rows[0]!)).toEqual({ title: 'Overdue', count: '1' });
    expect(rows.map(row)).toContainEqual({ title: 'Ready, not released', count: '2' });
    for (const a of rows) expect(a.getAttribute('href') ?? '').toMatch(ANALYTICS_PAGE);
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
    expect(needsYou().querySelectorAll('a[href]')).toHaveLength(0);
  });
});

describe('RS-C8 dashboard — Money card only where the API sent money, with currency and period (LD-436 mock)', () => {
  it('shows Billed and Collected in Rs. with the period; Outstanding and Cash in drawer are "Not available yet"', async () => {
    await open(FULL);
    const strip = moneyStrip();
    expect(strip).not.toBeNull();
    const text = norm(strip!.textContent);
    for (const v of ['2,30,000.00', '1,90,000.00']) expect(text, v).toContain(`Rs. ${v}`);
    expect(text).toContain(PERIOD.label_ad);
    expect(text).toMatch(/outstanding.*not available yet/i);
    expect(text).toMatch(/cash in drawer.*not available yet/i);
    expect(text).not.toMatch(/patient visits|pending tests/i);
  });

  it('no paisa tile from the API (a role without money access): no card, no money label, no "Rs." figure outside charts', async () => {
    const { container } = await open(without(...MONEY_KEYS));
    expect(moneyStrip()).toBeNull();
    expect(screen.queryByText(/^(income \(net sales\)|cash collected \(net\)|billed)$/i)).toBeNull();
    expect(norm(container.textContent)).not.toMatch(/Rs\. [\d,]+\.\d\d/);
  });

  it('keeps the money out of the pipeline and the needs-you list', async () => {
    await open(FULL);
    expect(norm(pipelineCard().textContent)).not.toMatch(/Rs\./);
    expect(norm(needsYou().textContent)).not.toMatch(/Rs\./);
  });
});

describe('RS-C8 dashboard — arrangement (every block a kit Card, one container level)', () => {
  it('no .lims-grid; every .lims-stat sits in the Money card in one container that holds only tiles; pipeline stages and needs-you rows are not tiles; one h1', async () => {
    const { container } = await open(FULL);
    const stats = Array.from(container.querySelectorAll('.lims-stat'));
    expect(container.querySelector('.lims-grid'), 'a .lims-grid on the page').toBeNull();
    expect(stats.length).toBeGreaterThan(0);
    for (const s of stats) expect(moneyStrip()!.contains(s), 'a tile outside the Money card').toBe(true);
    const parents = new Set(stats.map((e) => e.parentElement));
    expect(parents.size, 'tiles are spread over several containers').toBe(1);
    expect([...[...parents][0]!.children].every((c) => stats.includes(c)), 'the tile container holds only tiles').toBe(true);
    expect(pipeline().querySelectorAll('.lims-stat'), 'pipeline stage as a tile').toHaveLength(0);
    for (const li of [...stageItems(), ...needsYou().querySelectorAll('li')]) {
      expect(li.matches('.lims-stat') || li.querySelector('.lims-stat'), 'a list item that is a tile').toBeFalsy();
    }
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('DOM order = importance: pipeline, then needs you, then money', async () => {
    await open(FULL);
    expect(before(pipelineCard(), needsYou())).toBe(true);
    expect(before(needsYou(), moneyStrip()!)).toBe(true);
  });

  it('keeps what the mock still shows: both period labels, the billed definition note, the two chart frames and the refresh button', async () => {
    const { container } = await open(FULL);
    expect(norm(container.textContent)).toContain('15 Jan 2026');
    expect(norm(container.textContent)).toContain('2082-10-01');
    expect(screen.getByText(/billed = invoices issued/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeTruthy();
    expect(screen.getAllByText('Billed per day').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tests by department').length).toBeGreaterThan(0);
  });
});

describe('RS-C8 dashboard — keyboard-only path (task "tests")', () => {
  // the kit PeriodPicker (react-aria Select) always draws a hidden native <select> (aria-hidden, tabindex -1, see the T0D-UIDASH-2 ruling): not a Tab target
  const focusables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter((e) => e.getAttribute('tabindex') !== '-1' && !e.closest('[aria-hidden="true"]'));

  it('Tab reaches the needs-you links, then the money card; nothing needs a positive tabindex; Tab does not trap', async () => {
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
    const n = idx(needsYou());
    expect(n, 'a needs-you link takes focus').toBeGreaterThanOrEqual(0);
    const strip = moneyStrip();
    if (focusables(strip as HTMLElement).length > 0) expect(idx(strip!)).toBeGreaterThan(n);
    // every focusable control on the page is reachable by Tab alone
    const reached = new Set(order);
    const missed = focusables(container).filter((e) => !reached.has(e)).map((e) => norm(e.textContent) || e.outerHTML.slice(0, 60));
    expect(missed).toEqual([]);
  });

  it('a needs-you row is a native link (Enter activates it) with a visible text name', async () => {
    const user = userEvent.setup({ delay: null });
    await open(FULL);
    const a = needsRows()[0]!;
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
