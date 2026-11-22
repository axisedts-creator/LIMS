// @vitest-environment jsdom
// T0D-DASHCARDS-1 (LD-447; founder order 2026-11-22 13:36 NPT: "dashboard cards yes, make the dashboard more attractive"; CR DEPLOY-AXIS-012) DashboardView on the Today screen.
// done_when (1) the two new tiles: Outstanding and Cash in drawer show the API figure through MoneyText (Rs. with thousands separators, two decimals; a real 0 shows Rs. 0.00); a tile the API
//   omitted (caller lacks the source permission) keeps the cell on "Not available yet", never a bare 0, never blank. The Money card shows when ANY money tile is present.
// done_when (3) charts: "Billed per day" draws one bar per series day (value = net_sales_paisa, dates DD/MM/YYYY, current day = the last day in accent via data-current) and "Tests by department"
//   draws one bar per department_top row (label, net_paisa as money; the legend says "Net sales" so the reader is not told these are test counts); empty series/departments while the
//   data is fresh say "No data yet"; empty while a family is stale says "Data is being prepared" + "Updated <time>" and offers the existing refresh action (refreshAction) in the card unless readOnly;
//   a role without money tiles keeps "Not available yet" and no amount or department name (LD-353, T0D-UIDASH-1 leak rule).
// done_when (4) look: skeleton while loading, rows fill the grid (a row with one card is single column), equal heights, tokens only, UIX-6 button roles in the header.
// PINS the writer may dispute (say so in the ruling): the class `lims-dash-row-single`; the legend text "Net sales"; the refresh button INSIDE the chart cards; the CSS rules named in the last block;
// the loading.tsx skeleton shape (>= 3 `.lims-skeleton` blocks). Synthetic data only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/analytics' }));
const refreshAction = vi.fn(async () => ({ ok: true as const, data: { nextAllowedAt: '2099-01-01T00:00:00.000Z' } }));
vi.mock('@/features/analytics/server/actions', () => ({ refreshAction: (...a: unknown[]) => (refreshAction as (...x: unknown[]) => unknown)(...a) }));

import { DashboardView } from '@/features/analytics/components/DashboardView';
import AnalyticsLoading from '@/app/(staff)/analytics/loading';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const tile = (value: number, unit = 'count', extra: Record<string, unknown> = {}) => ({ value, unit, ...extra });
const DEPT_A = 'Synthetic Biochemistry', DEPT_B = 'Synthetic Haematology';
const base = {
  report_code: 'dashboard',
  period: { business_date_from: '2026-01-15', business_date_to: '2026-01-16', days: 1, label_ad: '15 Jan 2026', label_bs: '2082-10-01', timezone: 'Asia/Kathmandu' },
  scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] },
  freshness: ['orders', 'income', 'results', 'collections'].map((family) => ({ family, refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false })),
  generated_at: '2026-01-15T04:30:00.000Z',
};
const withData = () => ({
  ...base,
  tiles: {
    patient_visits: tile(12), net_sales_paisa: tile(22500000, 'paisa'), invoiced_paisa: tile(23000000, 'paisa'), credit_notes_paisa: tile(500000, 'paisa'),
    net_collected_paisa: tile(21000000, 'paisa'), results_approved: tile(5), reports_pending: tile(3), pending_tests: tile(9), pending_overdue: tile(6), reports_ready_unreleased: tile(4),
    outstanding_paisa: tile(12345678, 'paisa'), // review item 2: the API does not emit cash_in_drawer_paisa for now (open session expected is NULL), so the realistic fixture has none
  } as Record<string, unknown>,
  series: { days: [{ business_date: '2026-01-14', net_sales_paisa: 20000000, patient_visits: 10, net_orders: 11 }, { business_date: '2026-01-15', net_sales_paisa: 22500000, patient_visits: 12, net_orders: 13 }] },
  department_top: [
    { department_id: 'd1', label: DEPT_A, net_paisa: 12345600, is_multiple: false, share_bp: 6000 },
    { department_id: 'd2', label: DEPT_B, net_paisa: 8000000, is_multiple: false, share_bp: 3000 },
    { label: 'Multiple departments', net_paisa: 1000000, is_multiple: true, share_bp: 1000 },
  ],
});
const noMoney = () => {
  const d = withData();
  for (const k of ['net_sales_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'net_collected_paisa', 'outstanding_paisa', 'cash_in_drawer_paisa']) delete d.tiles[k];
  return d;
};
const emptyFresh = () => ({ ...withData(), series: { days: [] }, department_top: [] });
const emptyStale = (reason = 'refresh_lagging') => ({
  ...emptyFresh(),
  freshness: base.freshness.map((f) => (f.family === 'income' ? { ...f, is_stale: true, stale_reason: reason } : f)),
});
const mount = (dto: unknown, readOnly = false) => render(<ToastProvider><DashboardView dto={dto as never} query="" readOnly={readOnly} /></ToastProvider>);
afterEach(() => { cleanup(); refreshAction.mockClear(); });

const cardOf = (root: ParentNode, title: RegExp | string): HTMLElement => {
  const h = [...root.querySelectorAll('.lims-card-title, .lims-chart-card-title')].find((e) => (typeof title === 'string' ? norm(e.textContent) === title : title.test(norm(e.textContent))));
  const c = h?.closest('.lims-card, .lims-chart-card') as HTMLElement | null;
  if (!c) throw new Error(`no card ${String(title)}`);
  return c;
};
const statOf = (card: ParentNode, label: RegExp) => [...card.querySelectorAll<HTMLElement>('.lims-stat')].find((s) => label.test(norm(s.querySelector('.lims-stat-label')?.textContent)));
const rows = (card: ParentNode) => new Map([...card.querySelectorAll('table tbody tr')].map((tr) => [norm(tr.querySelector('th')?.textContent), norm(tr.querySelector('td')?.textContent)] as const));
const bars = (card: ParentNode) => [...card.querySelectorAll('.lims-chart-bar')];

describe('Money card: Outstanding and Cash in drawer carry the API figure (done_when 1)', () => {
  it('Outstanding present: MoneyText, thousands separators, two decimals; Cash in drawer (no API tile yet) says "Not available yet"', () => {
    const { container } = mount(withData());
    const card = cardOf(container, /^Money\b/);
    expect(norm(statOf(card, /^Outstanding$/)!.querySelector('.lims-money')?.textContent)).toBe('Rs. 1,23,456.78');
    expect(norm(statOf(card, /^Outstanding$/)!.textContent)).not.toMatch(/not available/i);
    expect(norm(statOf(card, /^Cash in drawer/)!.textContent)).toMatch(/not available yet/i);
    expect(statOf(card, /^Cash in drawer/)!.querySelector('.lims-money')).toBeNull();
  });

  it('the optional cash_in_drawer_paisa field, should the API ever send it, is drawn through MoneyText', () => {
    const d = withData(); d.tiles.cash_in_drawer_paisa = tile(98765400, 'paisa');
    const card = cardOf(mount(d).container, /^Money\b/);
    expect(norm(statOf(card, /^Cash in drawer/)!.querySelector('.lims-money')?.textContent)).toBe('Rs. 9,87,654.00');
  });

  it('the four cells keep their order: Billed, Collected, Outstanding, Cash in drawer', () => {
    const { container } = mount(withData());
    const labels = [...cardOf(container, /^Money\b/).querySelectorAll('.lims-stat .lims-stat-label')].map((e) => norm(e.textContent));
    expect(labels).toHaveLength(4);
    expect(labels.map((l) => l.replace(/^(Cash in drawer).*/, '$1'))).toEqual(['Billed', 'Collected', 'Outstanding', 'Cash in drawer']);
  });

  it('a real 0 is shown as Rs. 0.00 (not "Not available yet", not blank)', () => {
    const d = withData(); d.tiles.outstanding_paisa = tile(0, 'paisa');
    const { container } = mount(d);
    const card = cardOf(container, /^Money\b/);
    expect(norm(statOf(card, /^Outstanding$/)!.querySelector('.lims-money')?.textContent)).toBe('Rs. 0.00');
  });

  it('a tile the API omitted (no source permission): that cell says "Not available yet", no amount, the other cell still shows', () => {
    const d = withData(); delete d.tiles.outstanding_paisa;
    const { container } = mount(d);
    const card = cardOf(container, /^Money\b/);
    expect(norm(statOf(card, /^Outstanding$/)!.textContent)).toMatch(/not available yet/i);
    expect(statOf(card, /^Outstanding$/)!.querySelector('.lims-money')).toBeNull();
    expect(norm(statOf(card, /^Cash in drawer/)!.textContent)).toMatch(/not available yet/i);
    expect(norm(statOf(card, /^Billed$/)!.querySelector('.lims-money')?.textContent)).toBe('Rs. 2,30,000.00');
  });

  it('only the new tiles present (no net money tile): the Money card still draws with the amounts', () => {
    const d = withData();
    for (const k of ['net_sales_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'net_collected_paisa']) delete d.tiles[k];
    const { container } = mount(d);
    expect(norm(statOf(cardOf(container, /^Money\b/), /^Outstanding$/)!.querySelector('.lims-money')?.textContent)).toBe('Rs. 1,23,456.78');
  });

  it('no money tile at all (a role without money): no Money card, no amount anywhere', () => {
    const { container } = mount(noMoney());
    expect([...container.querySelectorAll('.lims-card-title')].some((e) => /^Money\b/.test(norm(e.textContent)))).toBe(false);
    expect(container.textContent).not.toMatch(/Rs\.|NPR|1,23,456|9,87,654/);
  });

  it('a huge figure and the no-NaN rule: 9 007 199 254 740 991 paisa renders without NaN / Infinity / exponent', () => {
    const d = withData(); d.tiles.outstanding_paisa = tile(9007199254740991, 'paisa');
    const { container } = mount(d);
    expect(container.textContent).not.toMatch(/NaN|Infinity|e\+\d/);
  });
});

describe('Billed per day draws the series (done_when 3)', () => {
  it('one bar per series day, values as Rs. money, dates DD/MM/YYYY, the LAST day is the only accent (data-current)', () => {
    const { container } = mount(withData());
    const card = cardOf(container, 'Billed per day');
    expect(bars(card)).toHaveLength(2);
    expect(bars(card).map((b) => b.getAttribute('data-current'))).toEqual([null, 'true']);
    const r = rows(card);
    expect([...r.keys()]).toEqual(['14/01/2026', '15/01/2026']);
    expect(r.get('14/01/2026')).toMatch(/^Rs\. 2,?00,000\.00$/);
    expect(r.get('15/01/2026')).toMatch(/^Rs\. 2,?25,000\.00$/);
    expect(norm(card.querySelector('.lims-chart-period')?.textContent)).toBe('Last 2 days');
    expect(card.textContent).not.toMatch(/not available yet|no data yet|being prepared/i);
  });

  it('a single day draws one accent bar; zero is a real bar value, not a gap', () => {
    const d = withData(); d.series = { days: [{ business_date: '2026-01-15', net_sales_paisa: 0, patient_visits: 0, net_orders: 0 }] };
    const card = cardOf(mount(d).container, 'Billed per day');
    expect(bars(card)).toHaveLength(1);
    expect(bars(card)[0]!.getAttribute('data-current')).toBe('true');
    expect(rows(card).get('15/01/2026')).toMatch(/^Rs\. 0\.00$/);
  });

  it('a negative day (credit notes over sales) keeps its sign and never breaks the chart', () => {
    const d = withData(); d.series = { days: [{ business_date: '2026-01-14', net_sales_paisa: -50000, patient_visits: 1, net_orders: 1 }, { business_date: '2026-01-15', net_sales_paisa: 100000, patient_visits: 1, net_orders: 1 }] };
    const { container } = mount(d);
    expect(rows(cardOf(container, 'Billed per day')).get('14/01/2026')).toMatch(/-.*500\.00/);
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('fresh data and an empty series: the frame draws and says "No data yet" (no bar, no refresh offered)', () => {
    const card = cardOf(mount(emptyFresh()).container, 'Billed per day');
    expect(norm(card.textContent)).toMatch(/no data yet/i);
    expect(bars(card)).toHaveLength(0);
    expect(within(card).queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(card.textContent).not.toMatch(/being prepared/i);
  });

  it('a role without money tiles: "Not available yet", no bar, no amount (series is not drawn for them)', () => {
    const { container } = mount(noMoney());
    const card = cardOf(container, 'Billed per day');
    expect(norm(card.textContent)).toMatch(/not available yet/i);
    expect(bars(card)).toHaveLength(0);
    expect(card.textContent).not.toMatch(/Rs\.|NPR|2,?25,000/);
  });
});

describe('Tests by department draws the department data (done_when 3)', () => {
  it('one bar per department_top row in the given order, label and net amount as money; "Multiple departments" kept; legend says Net sales', () => {
    const { container } = mount(withData());
    const card = cardOf(container, 'Tests by department');
    expect(bars(card)).toHaveLength(3);
    const r = rows(card);
    expect([...r.keys()]).toEqual([DEPT_A, DEPT_B, 'Multiple departments']);
    expect(r.get(DEPT_A)).toMatch(/^Rs\. 1,?23,?456\.00$/);
    expect(r.get(DEPT_B)).toMatch(/^Rs\. 80,000\.00$/);
    expect(norm(card.querySelector('.lims-chart-legend')?.textContent)).toMatch(/net sales/i);
    expect(card.textContent).not.toMatch(/not available yet|no data yet|being prepared/i);
  });

  it('ten rows draw ten bars (the API cap), no more', () => {
    const d = withData();
    d.department_top = Array.from({ length: 10 }, (_, i) => ({ department_id: `d${i}`, label: `Synthetic Dept ${i}`, net_paisa: 1000 * (10 - i), is_multiple: false, share_bp: 1000 }));
    expect(bars(cardOf(mount(d).container, 'Tests by department'))).toHaveLength(10);
  });

  it('fresh data and no departments: "No data yet"', () => {
    const card = cardOf(mount(emptyFresh()).container, 'Tests by department');
    expect(norm(card.textContent)).toMatch(/no data yet/i);
    expect(bars(card)).toHaveLength(0);
  });

  it('a role without money tiles: no department name, no amount (leak rule), "Not available yet"', () => {
    const { container } = mount(noMoney());
    const card = cardOf(container, 'Tests by department');
    expect(norm(card.textContent)).toMatch(/not available yet/i);
    expect(container.textContent).not.toContain(DEPT_A);
    expect(container.textContent).not.toContain(DEPT_B);
    expect(container.textContent).not.toMatch(/Rs\.|NPR/);
  });

  it('a hostile department label is text, never markup', () => {
    const d = withData(); d.department_top = [{ department_id: 'x', label: '<img src=x onerror=alert(1)>', net_paisa: 100, is_multiple: false, share_bp: 10000 }];
    const { container } = mount(d);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('stale read model: the charts say why and offer the existing refresh (done_when 3)', () => {
  it.each(['refresh_lagging', 'never_refreshed', 'refresh_failed'])('empty series + a stale family (%s): both cards say "Data is being prepared" with the last updated time', (reason) => {
    const { container } = mount(emptyStale(reason));
    for (const title of ['Billed per day', 'Tests by department']) {
      const card = cardOf(container, title);
      expect(norm(card.textContent), title).toMatch(/data is being prepared/i);
      expect(bars(card), title).toHaveLength(0);
      expect(norm(card.textContent), title).not.toMatch(/no data yet|not available yet/i);
    }
    if (reason !== 'never_refreshed') expect(norm(cardOf(container, 'Billed per day').textContent)).toMatch(/updated .*10:15/i);
  });

  it('the card offers the Refresh button (the existing refreshAction) and pressing it calls the action once', async () => {
    const { container } = mount(emptyStale());
    const btn = within(cardOf(container, 'Billed per day')).getByRole('button', { name: /refresh/i });
    fireEvent.click(btn);
    await waitFor(() => expect(refreshAction).toHaveBeenCalledTimes(1));
  });

  it('embedded in a report run (readOnly): the message shows, no refresh button in the cards', () => {
    const { container } = mount(emptyStale(), true);
    const card = cardOf(container, 'Billed per day');
    expect(norm(card.textContent)).toMatch(/data is being prepared/i);
    expect(within(card).queryByRole('button', { name: /refresh/i })).toBeNull();
  });

  it('stale but the series has rows: the bars are drawn (last known values), no "being prepared" message', () => {
    const d = withData(); d.freshness = base.freshness.map((f) => ({ ...f, is_stale: true, stale_reason: 'refresh_lagging' })) as never;
    const card = cardOf(mount(d).container, 'Billed per day');
    expect(bars(card)).toHaveLength(2);
    expect(card.textContent).not.toMatch(/being prepared/i);
  });

  it('a role without money tiles never gets the "being prepared" text or a refresh in the chart cards (nothing to prepare for them)', () => {
    const d = noMoney(); d.series = { days: [] }; d.department_top = [];
    d.freshness = base.freshness.map((f) => ({ ...f, is_stale: true, stale_reason: 'refresh_lagging' })) as never;
    const card = cardOf(mount(d).container, 'Billed per day');
    expect(norm(card.textContent)).toMatch(/not available yet/i);
    expect(within(card).queryByRole('button', { name: /refresh/i })).toBeNull();
  });
});

describe('layout markup (done_when 4): rows fill the grid, header roles, tokens', () => {
  it('page order: stepper card, one row of two cards (Needs you + Money), one row of two chart cards; nothing else in the grid', () => {
    const { container } = mount(withData());
    const dash = container.querySelector('.lims-dash')!;
    const kids = [...dash.children];
    expect(kids).toHaveLength(3);
    expect(kids[0]!.classList.contains('lims-card')).toBe(true);
    expect([...kids[1]!.children].map((c) => c.className.split(' ')[0])).toEqual(['lims-card', 'lims-card']);
    expect([...kids[2]!.children].map((c) => c.className.split(' ')[0])).toEqual(['lims-chart-card', 'lims-chart-card']);
  });

  it('a role without money: the Needs you row has ONE card and it is the single-column row (no empty half)', () => {
    const { container } = mount(noMoney());
    const row = cardOf(container, 'Needs you').parentElement!;
    expect(row.children).toHaveLength(1);
    expect(row.classList.contains('lims-dash-row-single')).toBe(true);
  });

  it('with money the row is the normal two-card row', () => {
    const row = cardOf(mount(withData()).container, 'Needs you').parentElement!;
    expect(row.children).toHaveLength(2);
    expect(row.classList.contains('lims-dash-row-single')).toBe(false);
  });

  it('header roles (UIX-6): exactly one primary action, New registration; Refresh is secondary; every header button carries a role class', () => {
    const { container } = mount(withData());
    const head = container.querySelector('h1')!.closest('header, .lims-page-header') as HTMLElement;
    const primaries = [...head.querySelectorAll('.lims-btn-primary')];
    expect(primaries.map((e) => norm(e.textContent))).toEqual(['New registration']);
    expect(within(head).getByRole('button', { name: /^refresh$/i }).className).toMatch(/lims-btn-secondary/);
    for (const b of head.querySelectorAll('button')) expect(b.className, norm(b.textContent) || b.getAttribute('aria-label') || 'button').toMatch(/lims-btn-(primary|secondary|ghost|danger)/);
  });

  it('no inline colour, gradient or size literal and no raw table outside the kit chart tables', () => {
    const { container } = mount(withData());
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(|gradient/i);
    for (const el of container.querySelectorAll<HTMLElement>('[style]')) {
      if (/clip:\s*rect\(0/i.test(el.getAttribute('style') ?? '')) continue;
      expect(el.getAttribute('style'), `inline style on <${el.tagName.toLowerCase()}>`).not.toMatch(/font-weight|color|background|border|box-shadow|height|width/i);
    }
  });

  it('the loading skeleton is dashboard shaped: a busy status with several card blocks, no number and no text value', () => {
    const { container } = render(<AnalyticsLoading />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll('.lims-skeleton').length).toBeGreaterThanOrEqual(3);
    expect(container.textContent).not.toMatch(/\d|Rs\./);
  });
});

describe('stylesheet rules (apps/web/src/core/shell/shell.css), tokens only', () => {
  const css = readFileSync(join(process.cwd(), 'src/core/shell/shell.css'), 'utf8') /* vitest root = apps/web */.split(String.fromCharCode(13)).join('');
  const rule = (sel: string) => [...css.matchAll(/(^|\n)([^{}\n]*\{[^}]*\})/g)].map((m) => m[2]!).filter((r) => r.split('{')[0]!.split(',').some((s) => s.trim() === sel)).join('\n');

  it('tile values are large and aligned: the Money value uses a type-scale token and tabular numbers', () => {
    const r = rule('.lims-dash-money .lims-stat-value');
    expect(r).toMatch(/font-size:\s*var\(--lims-font-size-/);
    expect(r).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('equal heights per row: the money row and the chart row stretch their cards, and the single-card row is one column', () => {
    expect(rule('.lims-dash-row')).toMatch(/align-items:\s*stretch/);
    expect(rule('.lims-dash-charts')).toMatch(/align-items:\s*stretch/);
    expect(rule('.lims-dash-row-single')).toMatch(/grid-template-columns:\s*1fr/);
  });

  it('phone width: every dashboard grid collapses to one column at or below 64rem', () => {
    expect(css).toMatch(/@media \(max-width: 64rem\)\s*\{[^}]*\.lims-dash-row[^}]*\.lims-dash-charts[^}]*grid-template-columns:\s*1fr/);
  });

  it('every .lims-dash* rule uses tokens: no hex, rgb, hsl literal (AA contrast comes from the token pairs)', () => {
    const own = [...css.matchAll(/(^|\n)(\.lims-dash[^{}\n]*\{[^}]*\})/g)].map((m) => m[2]!);
    expect(own.length).toBeGreaterThan(4);
    for (const r of own) expect(r, r.slice(0, 60)).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(/i);
  });
});
