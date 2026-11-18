// @vitest-environment jsdom
// T0D-UNSLOP-1 (C) — calm dashboard /analytics (LD-344 evidence; LD-353 rules 5 and 8: "one freshness note per page", "no stale badge unless the data is stale").
// Founder review: status tiles of unequal size in several rows, and a "Data may be out of date" badge on every tile.
// Contract: (1) with 4 stale families the page shows ONE freshness note (the page header status), none inside a tile cell;
//           (2) every status tile (`.lims-stat`) sits in ONE row: all tiles share the same parent element, and that parent holds nothing but tiles
//               (no sub-value paragraphs or badges beside a tile: they make the cells unequal); the sub-values may move into the tile or be dropped;
//           (3) fresh data: no stale wording anywhere (the page header still says when it was updated).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/analytics' }));

import { DashboardView } from '@/features/analytics/components/DashboardView';

const tile = (value: number, unit = 'count', extra: Record<string, unknown> = {}) => ({ value, unit, ...extra });
const fam = (family: string, stale: boolean) => ({ family, refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: stale, ...(stale ? { stale_reason: 'refresh_lagging' } : {}), live: false });
const dto = (stale: boolean) => ({
  report_code: 'dashboard',
  period: { business_date_from: '2026-01-15', business_date_to: '2026-01-16', days: 1, label_ad: '15 Jan 2026', label_bs: '2082-10-01', timezone: 'Asia/Kathmandu' },
  scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] },
  freshness: ['orders', 'income', 'results', 'collections'].map((f) => fam(f, stale)),
  generated_at: '2026-01-15T04:30:00.000Z',
  tiles: {
    patient_visits: tile(12, 'count', { previous: 10, delta: 2, delta_bp: 2000 }), new_patients: tile(4), tests_ordered: tile(31),
    net_sales_paisa: tile(22500000, 'paisa', { previous: 20810000, delta: 1690000, delta_bp: 812 }), invoiced_paisa: tile(23000000, 'paisa'), credit_notes_paisa: tile(500000, 'paisa'),
    net_collected_paisa: tile(21000000, 'paisa'), results_approved: tile(28, 'count', { previous: 26, delta: 2, delta_bp: 769 }), reports_pending: tile(5), pending_tests: tile(9),
  },
  series: { days: [{ business_date: '2026-01-15', net_sales_paisa: 22500000, patient_visits: 12, net_orders: 13 }] },
  department_top: [],
});
const mount = (stale: boolean) => render(<ToastProvider><DashboardView dto={dto(stale) as never} query="" /></ToastProvider>);
afterEach(cleanup);

describe('/analytics is calm', () => {
  it('one freshness note for the whole page when data is stale, not one badge per tile', () => {
    const { container } = mount(true);
    const notes = [...container.querySelectorAll('*')].filter((e) => e.children.length === 0 && /data may be out of date/i.test(e.textContent ?? ''));
    expect(notes, 'exactly one "Data may be out of date"').toHaveLength(1);
    expect(notes[0]!.closest('.lims-stat'), 'not inside a tile').toBeNull();
    for (const stat of container.querySelectorAll('.lims-stat')) expect(stat.parentElement!.textContent).not.toMatch(/data may be out of date/i);
  });

  it('every status tile is in one row of equal cells (same parent, nothing but tiles in it)', () => {
    const { container } = mount(true);
    const tiles = [...container.querySelectorAll<HTMLElement>('.lims-stat')];
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    const parents = new Set(tiles.map((x) => x.parentElement));
    expect(parents.size, 'tiles are spread over several containers').toBe(1);
    const row = [...parents][0]!;
    expect([...row.children].every((c) => tiles.includes(c as HTMLElement)), 'the row holds only tiles').toBe(true);
  });

  it('fresh data: no stale wording at all', () => {
    const { container } = mount(false);
    expect(container.textContent).not.toMatch(/out of date|stale/i);
  });
});
