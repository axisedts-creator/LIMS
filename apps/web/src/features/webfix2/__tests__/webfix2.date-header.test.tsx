// @vitest-environment jsdom
// T0D-WEBFIX-2 (3): the analytics period line shows "B.S." exactly once. The API already sends label_bs in display form
// ("2083-08-01 B.S.", shared-ts formatBs(.., 'display')); the web used to add a second " B.S.". The suffix must be applied once whichever form arrives.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach } from 'vitest';
import { DashboardView } from '@/features/analytics/components/DashboardView';
import { ReportRunView } from '@/features/analytics/components/ReportRunView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('server-only', () => ({}));
const g = globalThis as any;
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
g.matchMedia ??= (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
afterEach(cleanup);

const count = (s: string, needle: string) => s.split(needle).length - 1;
const dto = (label_bs: string) => ({
  report_code: 'dashboard',
  period: { business_date_from: '2026-11-17', business_date_to: '2026-11-18', days: 1, label_ad: '17/11/2026', label_bs, timezone: 'Asia/Kathmandu' },
  scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] },
  freshness: [{ family: 'orders', refreshed_at: '2026-11-17T04:30:00.000Z', is_stale: false, live: false }],
  generated_at: '2026-11-17T04:30:00.000Z',
  tiles: { patient_visits: { value: 3, unit: 'count' } },
  series: { days: [] },
  department_top: [],
}) as any;

describe('B.S. suffix appears once (T0D-WEBFIX-2 item 3)', () => {
  it('dashboard: API label_bs already ends in "B.S." -> the line shows it once', () => {
    const { container } = render(<DashboardView dto={dto('2083-08-01 B.S.')} query="" readOnly />);
    const text = container.textContent ?? '';
    expect(text).toContain('17/11/2026');
    expect(text).toContain('2083-08-01 B.S.');
    expect(count(text, 'B.S.'), `period line: ${text.match(/17\/11\/2026[^A-Z]*B\.S\.[ B.S.]*/)?.[0]}`).toBe(1);
  });

  it('dashboard: a bare label_bs still gets exactly one "B.S."', () => {
    const { container } = render(<DashboardView dto={dto('2083-08-01')} query="" readOnly />);
    const text = container.textContent ?? '';
    expect(text).toContain('2083-08-01 B.S.');
    expect(count(text, 'B.S.')).toBe(1);
  });

  it('report run header: display-form and bare periodBs both give one "B.S."', () => {
    for (const bs of ['2083-08-01 B.S.', '2083-08-01']) {
      const { container, unmount } = render(<ReportRunView scheduleName="Daily income" periodAd="17/11/2026" periodBs={bs} cards={[]} />);
      const text = container.textContent ?? '';
      expect(text, bs).toContain('Daily income — 17/11/2026 · 2083-08-01 B.S.');
      expect(count(text, 'B.S.'), bs).toBe(1);
      unmount();
    }
  });

  it('no analytics component appends a literal " B.S." after an interpolated value (ReportView, ScheduleEditor, DashboardView, ReportRunView)', () => {
    const dir = join(import.meta.dirname, '..', '..', 'analytics', 'components');
    const hits: string[] = [];
    for (const f of ['ReportView.tsx', 'ScheduleEditor.tsx', 'DashboardView.tsx', 'ReportRunView.tsx']) {
      readFileSync(join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return;
        if (/\}\s*B\.S\./.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
