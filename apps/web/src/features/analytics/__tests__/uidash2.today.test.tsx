// @vitest-environment jsdom
// T0D-UIDASH-2 (1) Today rebuilt on kit parts to the approved mock (LD-436 look, LD-437 exact match, LD-438 card surface; done_when (1) and (3)).
// Mock blocks in order: PageHeader (title, date line, PeriodPicker, New registration) / Card "Where the samples are" with the StatusStepper
// (Registered, Collected, Received, In testing, Verified, Released; ONE lime marker on the stage with the most waiting; overdue count in the danger tone) /
// Card "Needs you" (ActionList) beside Card "Money" (four StatTile cells through MoneyText + a collected of billed bar) /
// ChartCard "Billed per day" (bars, current day accent) beside ChartCard "Tests by department" (bars).
// The sample numbers of the mock are never used here: every value below is synthetic. Display only: no route, permission, contract or API change.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { cardNotAvailable } from '@/__tests__/uidash1.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/analytics' }));

import { DashboardView } from '@/features/analytics/components/DashboardView';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const tile = (value: number, unit = 'count', extra: Record<string, unknown> = {}) => ({ value, unit, ...extra });
const DEPT = 'Synthetic Biochemistry';
const base = {
  report_code: 'dashboard',
  period: { business_date_from: '2026-01-15', business_date_to: '2026-01-16', days: 1, label_ad: '15 Jan 2026', label_bs: '2082-10-01', timezone: 'Asia/Kathmandu' },
  scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] },
  freshness: ['orders', 'income', 'results', 'collections'].map((family) => ({ family, refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false })),
  generated_at: '2026-01-15T04:30:00.000Z',
};
// invoiced 2,30,000.00 and collected 2,10,000.00 (paisa x 100): collected of billed = 91 percent (rounded). results_approved < pending_tests so "In testing" has the most waiting.
const withData = () => ({
  ...base,
  tiles: {
    patient_visits: tile(12, 'count', { previous: 10, delta: 2, delta_bp: 2000 }), new_patients: tile(4), tests_ordered: tile(31),
    net_sales_paisa: tile(22500000, 'paisa'), invoiced_paisa: tile(23000000, 'paisa'), credit_notes_paisa: tile(500000, 'paisa'),
    net_collected_paisa: tile(21000000, 'paisa'), results_approved: tile(5), reports_pending: tile(3), pending_tests: tile(9),
    pending_overdue: tile(6), reports_ready_unreleased: tile(4),
  },
  series: { days: [{ business_date: '2026-01-14', net_sales_paisa: 20000000, patient_visits: 10, net_orders: 11 }, { business_date: '2026-01-15', net_sales_paisa: 22500000, patient_visits: 12, net_orders: 13 }] },
  department_top: [{ department_id: 'd1', label: DEPT, net_paisa: 12345600, is_multiple: false, share_bp: 5000 }],
});
const emptyPeriod = () => ({
  ...base,
  tiles: { patient_visits: tile(0), net_sales_paisa: tile(0, 'paisa'), net_collected_paisa: tile(0, 'paisa'), reports_pending: tile(0), results_approved: tile(0), pending_tests: tile(0) },
  series: { days: [] }, department_top: [],
});
const noMoney = () => {
  const d = withData();
  for (const k of ['net_sales_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'net_collected_paisa']) delete (d.tiles as Record<string, unknown>)[k];
  return d;
};
const mount = (dto: unknown, readOnly = false) => render(<ToastProvider><DashboardView dto={dto as never} query="" readOnly={readOnly} /></ToastProvider>);
afterEach(cleanup);

// the kit Card / ChartCard that holds a given title (Card: h2.lims-card-title inside .lims-card; ChartCard: h2.lims-chart-card-title inside section.lims-chart-card)
const cardOf = (root: ParentNode, title: RegExp | string): HTMLElement | undefined => {
  const h = [...root.querySelectorAll('.lims-card-title, .lims-chart-card-title')].find((e) => (typeof title === 'string' ? norm(e.textContent) === title : title.test(norm(e.textContent))));
  return (h?.closest('.lims-card, .lims-chart-card') as HTMLElement | null) ?? undefined;
};
const stages = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-stepper li.lims-step')];
const stageOf = (root: ParentNode, label: string) => stages(root).find((s) => norm(s.querySelector('.lims-step-label')?.textContent) === label);
const statOf = (card: ParentNode, label: RegExp) => [...card.querySelectorAll<HTMLElement>('.lims-stat')].find((s) => label.test(norm(s.querySelector('.lims-stat-label')?.textContent)));

describe('Today header (PageHeader, mock row 1)', () => {
  it('data: ONE h1 = the menu label, then the date line (A.D. and B.S.), the PeriodPicker and the primary "New registration" action, all in the page header', () => {
    const { container } = mount(withData());
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s.map((h) => norm(h.textContent))).toEqual([t('analytics.nav.dashboard')]);
    expect(h1s[0]!.className).toMatch(/lims-page-title/);
    const head = h1s[0]!.closest('header, .lims-page-header') as HTMLElement | null;
    expect(head, 'the h1 sits in the kit PageHeader').not.toBeNull();
    expect(norm(head!.textContent), 'date line in the header').toMatch(/15 Jan 2026/);
    expect(norm(head!.textContent)).toMatch(/2082-10-01 B\.S\./);
    expect(head!.querySelector('.lims-period'), 'PeriodPicker in the header').not.toBeNull();
    const act = within(head!).getByRole('link', { name: /new registration/i });
    expect(act.getAttribute('href')).toBe('/frontdesk/registrations/new');
  });

  it('empty period: the same header, the date line is not a bare <p> floating under it', () => {
    const { container } = mount(emptyPeriod());
    const head = container.querySelector('h1')!.closest('header, .lims-page-header') as HTMLElement;
    expect(head.querySelector('.lims-period')).not.toBeNull();
    expect(norm(head.textContent)).toMatch(/15 Jan 2026/);
  });

  it('embedded in a report run (readOnly): no page header, no period picker, no New registration', () => {
    const { container } = mount(withData(), true);
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('.lims-period')).toBeNull();
    expect(screen.queryByRole('link', { name: /new registration/i })).toBeNull();
  });
});

describe('Today pipeline (Card + StatusStepper, mock row 2)', () => {
  it('a Card "Where the samples are" holds the stepper with the six stages in order', () => {
    const { container } = mount(withData());
    const card = cardOf(container, 'Where the samples are');
    expect(card, 'Card titled "Where the samples are"').toBeDefined();
    expect(card!.classList.contains('lims-card')).toBe(true);
    expect(card!.querySelector('.lims-card-caption'), 'one short caption on the right of the title').not.toBeNull();
    const steps = [...card!.querySelectorAll('.lims-stepper li.lims-step')].map((s) => norm(s.querySelector('.lims-step-label')?.textContent));
    expect(steps).toEqual(['Registered', 'Collected', 'Received', 'In testing', 'Verified', 'Released']);
  });

  it('data: exactly ONE lime marker on the page, on "In testing" (the stage fed by pending_tests, the one with the most waiting)', () => {
    const { container } = mount(withData());
    expect(container.querySelectorAll('.lims-step-marker')).toHaveLength(1);
    expect(stageOf(container, 'In testing')!.querySelector('.lims-step-marker')).not.toBeNull();
  });

  it('data: In testing shows 9 and the overdue count 6 in the danger tone; Verified shows 5; stages no tile feeds show no number (no invented 0)', () => {
    const { container } = mount(withData());
    const testing = stageOf(container, 'In testing')!;
    expect(norm(testing.textContent)).toMatch(/\b9\b/);
    const overdue = [...testing.querySelectorAll('*')].find((e) => e.children.length === 0 && /\b6\b.*overdue|overdue.*\b6\b/i.test(norm(e.textContent)));
    expect(overdue, '"6 overdue" inside the In testing stage').toBeDefined();
    expect(overdue!.closest('[data-tone="danger"], .lims-tone-danger'), 'overdue is in the danger tone').not.toBeNull();
    expect(norm(stageOf(container, 'Verified')!.textContent)).toMatch(/\b5\b/);
    for (const s of ['Collected', 'Received']) expect(norm(stageOf(container, s)!.textContent.replace(s, '')), `${s}: no count`).not.toMatch(/\d/);
  });

  it('empty period: the stepper still draws all six stages, but nothing waits so there is no lime marker and no overdue note', () => {
    const { container } = mount(emptyPeriod());
    expect(stages(container)).toHaveLength(6);
    expect(container.querySelectorAll('.lims-step-marker')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/overdue/i);
  });

  it('no hand written step list: every li.lims-step lives inside the kit StatusStepper', () => {
    const { container } = mount(withData());
    for (const li of container.querySelectorAll('li.lims-step')) expect(li.closest('.lims-stepper'), 'li.lims-step outside .lims-stepper').not.toBeNull();
    expect(container.querySelectorAll('ol.lims-stepper-list').length, 'one stepper').toBe(1);
  });
});

describe('Today Needs you (Card + ActionList, mock row 3 left)', () => {
  it('data: a Card "Needs you" with ONE ActionList; rows are links, most urgent first (Overdue, Ready not released, Reports pending), each with a tone chip, title, detail line, count and chevron', () => {
    const { container } = mount(withData());
    const card = cardOf(container, 'Needs you');
    expect(card).toBeDefined();
    expect(card!.classList.contains('lims-card')).toBe(true);
    expect(card!.querySelector('.lims-card-caption'), 'caption such as "3 things waiting"').not.toBeNull();
    const lists = card!.querySelectorAll('ul.lims-action-list');
    expect(lists).toHaveLength(1);
    const rows = [...lists[0]!.querySelectorAll<HTMLAnchorElement>('a.lims-action-row')];
    expect(rows.map((r) => norm(r.querySelector('.lims-action-title')?.textContent).toLowerCase())).toEqual(['overdue', 'ready, not released', 'reports pending']);
    expect(rows.map((r) => r.getAttribute('href'))).toEqual(['/analytics/reports/pending-tests', '/analytics/reports/pending-tests', '/analytics/reports/pending-tests']);
    expect(rows.map((r) => norm(r.querySelector('.lims-chip')?.textContent))).toEqual(['6', '4', '3']);
    for (const r of rows) {
      expect(r.querySelector('.lims-action-chip'), 'tone icon chip').not.toBeNull();
      expect(norm(r.querySelector('.lims-action-detail')?.textContent).length, 'a detail line').toBeGreaterThan(0);
      expect(r.querySelector('.lims-action-chevron'), 'chevron').not.toBeNull();
    }
    expect(rows[0]!.querySelector('.lims-action-chip')!.getAttribute('data-tone'), 'overdue is the danger tone').toBe('danger');
  });

  it('a 0 or absent tile gives no row; nothing waiting: the Card says "Nothing needs you right now." with no list', () => {
    const { container } = mount(emptyPeriod());
    const card = cardOf(container, 'Needs you')!;
    expect(card).toBeDefined();
    expect(norm(card.textContent)).toMatch(/nothing needs you right now/i);
    expect(card.querySelector('ul')).toBeNull();
  });
});

describe('Today Money (Card + StatTile cells + MoneyText + collected of billed bar, mock row 3 right)', () => {
  it('data: Card "Money, <period>" with four cells Billed, Collected, Outstanding, Cash in drawer, in that order', () => {
    const { container } = mount(withData());
    const card = cardOf(container, /^Money, 15 Jan 2026$/);
    expect(card, 'Card titled "Money, 15 Jan 2026"').toBeDefined();
    expect(card!.querySelector('.lims-card-caption'), 'caption such as "Amounts in NPR"').not.toBeNull();
    const labels = [...card!.querySelectorAll('.lims-stat .lims-stat-label')].map((e) => norm(e.textContent));
    expect(labels).toHaveLength(4);
    expect(labels[0]).toBe('Billed');
    expect(labels[1]).toBe('Collected');
    expect(labels[2]).toBe('Outstanding');
    expect(labels[3]).toMatch(/^Cash in drawer/);
  });

  it('data: Billed (invoiced) and Collected go through MoneyText, lakh grouping, two decimals', () => {
    const { container } = mount(withData());
    const card = cardOf(container, /^Money\b/)!;
    expect(norm(statOf(card, /^Billed$/)!.querySelector('.lims-money')?.textContent)).toBe('Rs. 2,30,000.00');
    expect(norm(statOf(card, /^Collected$/)!.querySelector('.lims-money')?.textContent)).toBe('Rs. 2,10,000.00');
  });

  it('data: a dashboard without the outstanding_paisa / cash_in_drawer_paisa tiles (omitted by permission) keeps both cells on "Not available yet" and invents no amount; Outstanding is an amount or "Not available yet", never blank or a bare 0', () => {
    const { container } = mount(withData());
    const card = cardOf(container, /^Money\b/)!;
    expect(norm(statOf(card, /^Cash in drawer/)!.textContent)).toMatch(/not available yet/i);
    expect(statOf(card, /^Cash in drawer/)!.querySelector('.lims-money')).toBeNull();
    const out = statOf(card, /^Outstanding$/)!;
    expect(out.querySelector('.lims-money') !== null || /not available yet/i.test(norm(out.textContent)), 'Outstanding: MoneyText or NotAvailable').toBe(true);
  });

  it('data: the collected of billed bar reads 91 percent (collected / billed, rounded) as a progressbar or meter with the label "Collected of billed"', () => {
    const { container } = mount(withData());
    const card = cardOf(container, /^Money\b/)!;
    expect(norm(card.textContent)).toMatch(/collected of billed/i);
    expect(norm(card.textContent)).toMatch(/\b91%/);
    const bar = card.querySelector('[role="progressbar"], [role="meter"], progress, meter');
    expect(bar, 'a bar element with a value').not.toBeNull();
    expect(Number(bar!.getAttribute('aria-valuenow') ?? bar!.getAttribute('value'))).toBe(91);
  });

  it('a role that may not read money: no Money card, no amount anywhere (the API sent no money tile)', () => {
    const { container } = mount(noMoney());
    expect(cardOf(container, /^Money\b/)).toBeUndefined();
    expect(container.textContent).not.toMatch(/Rs\.|NPR|2,30,000|2,10,000/);
  });

  it('empty period: no division by zero, no NaN or Infinity on the page', () => {
    const { container } = mount(emptyPeriod());
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
  });
});

describe('Today charts (two ChartCards, mock row 4)', () => {
  it('data: "Billed per day" then "Tests by department", side by side in one row, both ChartCards; billed per day is bars with a caption', () => {
    const { container } = mount(withData());
    const a = cardOf(container, 'Billed per day')!;
    const b = cardOf(container, 'Tests by department')!;
    expect(a && b, 'both ChartCards').toBeTruthy();
    expect(a.classList.contains('lims-chart-card') && b.classList.contains('lims-chart-card')).toBe(true);
    expect(a.parentElement, 'same row').toBe(b.parentElement);
    expect(a.parentElement!.className).toMatch(/lims-[a-z-]*(charts|chart-row)/);
    expect(norm(a.querySelector('.lims-chart-period')?.textContent).length, 'caption such as "Last 14 days"').toBeGreaterThan(0);
  });

  // T0D-DASHCARDS-1 (LD-447; founder order 2026-11-22 supersedes the T0D-UIDASH-2 ruling "Not available yet"): the series and department_top are drawn. Details: dashcards1.dashboard.test.tsx.
  it('data: "Billed per day" draws one bar per series day (current day accent), no "Not available yet"', () => {
    const { container } = mount(withData());
    const a = cardOf(container, 'Billed per day')!;
    expect(cardNotAvailable(a)).toBe(false);
    expect(a.querySelectorAll('.lims-chart-bar').length, 'one bar per day').toBe(2);
    expect(a.querySelectorAll('[data-current="true"]')).toHaveLength(1);
  });

  it('data: "Tests by department" draws the department_top rows (label and net amount), no "Not available yet"', () => {
    const { container } = mount(withData());
    const b = cardOf(container, 'Tests by department')!;
    expect(norm(b.textContent)).not.toMatch(/not available yet/i);
    expect(b.textContent).toContain(DEPT);
    expect(b.querySelectorAll('.lims-chart-bar').length).toBe(1);
  });

  it('empty period and a role without money: both frames still draw ("No data yet" or "Not available yet"), no leak', () => {
    for (const make of [emptyPeriod, noMoney]) {
      const { container, unmount } = mount(make());
      for (const title of ['Billed per day', 'Tests by department']) {
        const c = cardOf(container, title)!;
        expect(c, `${title} draws`).toBeDefined();
        expect(norm(c.textContent), `${title} says why it is empty`).toMatch(/no data yet|not available yet/i);
      }
      expect(container.textContent).not.toContain(DEPT);
      unmount();
    }
  });
});

describe('Today structure and look rules (done_when (1), (3); LD-353 rules)', () => {
  it('no raw h1 to h4: every heading is the page title or a kit Card / ChartCard title', () => {
    const { container } = mount(withData());
    for (const h of container.querySelectorAll('h1, h2, h3, h4')) {
      expect(h.matches('.lims-page-title, .lims-card-title, .lims-chart-card-title'), `raw <${h.tagName.toLowerCase()}> "${norm(h.textContent)}"`).toBe(true);
    }
  });

  it('no raw ul or ol: lists are kit parts (ActionList, StatusStepper, chart legend)', () => {
    const { container } = mount(withData());
    for (const l of container.querySelectorAll('ul, ol')) {
      expect(l.matches('.lims-action-list, .lims-stepper-list, .lims-chart-legend') || l.closest('.lims-chart, .lims-chart-card') !== null, `raw <${l.tagName.toLowerCase()}> "${norm(l.textContent).slice(0, 50)}"`).toBe(true);
    }
  });

  it('every block is a kit Card or ChartCard: the page holds those and the header, no loose headings or tile rows outside them', () => {
    const { container } = mount(withData());
    const loose = [...container.querySelectorAll('.lims-stat')].filter((s) => !s.closest('.lims-card'));
    expect(loose, 'StatTile cells only inside the Money card').toHaveLength(0);
    expect(['Where the samples are', 'Needs you'].map((x) => !!cardOf(container, x))).toEqual([true, true]);
  });

  it('no inline colour, gradient or font-weight 600 in the page body (tokens only); the one ruled "600" is the kit page title and stat value', () => {
    const { container } = mount(withData());
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(|gradient/i);
    for (const el of container.querySelectorAll<HTMLElement>('[style]')) {
      const style = el.getAttribute('style') ?? '';
      if (/clip:\s*rect\(0/i.test(style)) continue; // ruling: react-aria visually hidden pattern (HiddenSelect) is exempt
      expect(style, `inline style on <${el.tagName.toLowerCase()}>`).not.toMatch(/font-weight|color|background|border|box-shadow|height|width/i);
    }
  });

  it('one freshness note for the page, none inside the cards (LD-353 rule 8 kept)', () => {
    const d = withData();
    d.freshness = d.freshness.map((f) => ({ ...f, is_stale: true, stale_reason: 'refresh_lagging' } as never));
    const { container } = mount(d);
    const notes = [...container.querySelectorAll('*')].filter((e) => e.children.length === 0 && /data may be out of date/i.test(e.textContent ?? ''));
    expect(notes).toHaveLength(1);
    for (const s of container.querySelectorAll('.lims-card .lims-stat')) expect(s.textContent).not.toMatch(/out of date/i);
  });

  it('empty period: EmptyState "No activity in this period" and "Show yesterday" are kept; the cards still draw', () => {
    const { container } = mount(emptyPeriod());
    expect(norm(container.textContent)).toMatch(/No activity in this period/);
    expect(screen.getByRole('button', { name: /show yesterday/i })).toBeTruthy();
    expect(cardOf(container, 'Where the samples are')).toBeDefined();
    expect(cardOf(container, 'Needs you')).toBeDefined();
  });
});
