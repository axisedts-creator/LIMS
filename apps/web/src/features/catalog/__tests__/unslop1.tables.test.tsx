// @vitest-environment jsdom
// T0D-UNSLOP-1 (B) — table cells and filter bars (LD-344 / LD-353 rules 2, 3, 5; unslop guide rules the lead quoted):
//   cells: a text cell that can be cut off carries a `title` with the full value (on the <td> or on an element inside it); a column whose every value is a number has its
//          header AND its cells right aligned (class `lims-align-end`, the class the kit DataTable already uses); text columns stay left (no `lims-align-end`);
//   filter bars: ONE `.lims-filter-bar` row holds the search field and the radio groups (Doctors had two rows); the search input is directly followed by the Search button
//          (no far-right lone button); the stylesheet limits a search box in a filter bar to at most 24rem.
// Shared tables covered: catalog MasterTable and reporting SimpleTable (every catalog / reporting list uses one of them). Synthetic data only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/catalog/doctors',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/x' }));
const { stubModule } = vi.hoisted(() => ({
  stubModule: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }),
}));
vi.mock('@/features/catalog/server/actions', stubModule);
vi.mock('@/features/catalog/server/catalogActions', stubModule);
vi.mock('@/features/catalog/server/pricingActions', stubModule);

import { MasterTable } from '@/features/catalog/components/master-ui';
import { DoctorsList } from '@/features/catalog/components/DoctorsList';
import { SimpleTable } from '@/features/reporting/components/SimpleTable';

afterEach(cleanup);
const wrap = (el: ReactElement) => render(<ToastProvider>{el}</ToastProvider>);
const LONG = 'Synthetic long department name that will be cut off by the column width 0123456789';
const hasTitle = (td: Element, full: string) => td.getAttribute('title') === full || [...td.querySelectorAll('[title]')].some((e) => e.getAttribute('title') === full);
const cellsOf = (root: HTMLElement, col: number) => [...root.querySelectorAll('tbody tr.lims-row')].map((r) => r.children[col] as HTMLElement);

describe('MasterTable (catalog lists)', () => {
  const rows = [{ id: 'a', code: 'D1', name: LONG, sort: '12' }, { id: 'b', code: 'D2', name: 'Short', sort: '1,204.50' }];
  const cols = [{ header: 'Code', cell: (r: (typeof rows)[0]) => r.code }, { header: 'Name', cell: (r: (typeof rows)[0]) => r.name }, { header: 'Sort order', cell: (r: (typeof rows)[0]) => r.sort }];
  it('a long text cell has the full value as its title', () => {
    const { container } = render(<MasterTable caption="Things" cols={cols} rows={rows} empty="none" />);
    const [long, short] = cellsOf(container, 1);
    expect(hasTitle(long!, LONG)).toBe(true);
    expect(short!.textContent).toBe('Short'); // a short value needs no title
  });
  it('a numeric column is right aligned in header and cells; text columns are not', () => {
    const { container } = render(<MasterTable caption="Things" cols={cols} rows={rows} empty="none" />);
    const th = [...container.querySelectorAll('thead th')];
    expect(th[2]!.className).toMatch(/lims-align-end/);
    for (const td of cellsOf(container, 2)) expect(td.className).toMatch(/lims-align-end/);
    expect(th[1]!.className).not.toMatch(/lims-align-end/);
    for (const td of cellsOf(container, 1)) expect(td.className).not.toMatch(/lims-align-end/);
  });
});

describe('SimpleTable (reporting lists)', () => {
  const rows = [{ id: 'a', name: LONG, n: '7' }, { id: 'b', name: 'Short', n: '1,000' }];
  type R = (typeof rows)[0];
  const columns = [{ id: 'name', header: 'Report', cell: (r: R) => r.name }, { id: 'n', header: 'Count', cell: (r: R) => r.n }];
  it('a long text cell has the full value as its title', () => {
    const { container } = render(<SimpleTable columns={columns} rows={rows} getRowId={(r) => r.id} caption="Reports" empty={{ title: 'none' }} />);
    const first = [...container.querySelectorAll('tbody tr')].find((r) => (r.textContent ?? '').includes('Synthetic long'))!;
    expect(hasTitle(first.children[0]!, LONG)).toBe(true);
  });
  it('a numeric column is right aligned in header and cells', () => {
    const { container } = render(<SimpleTable columns={columns} rows={rows} getRowId={(r) => r.id} caption="Reports" empty={{ title: 'none' }} />);
    expect([...container.querySelectorAll('thead th')][1]!.className).toMatch(/lims-align-end/);
    const body = [...container.querySelectorAll('tbody tr')].filter((r) => r.children.length === 2);
    expect(body.length).toBe(2);
    for (const r of body) expect(r.children[1]!.className).toMatch(/lims-align-end/);
    expect([...container.querySelectorAll('thead th')][0]!.className).not.toMatch(/lims-align-end/);
  });
});

describe('Doctors filter bar: one row, search box next to its button', () => {
  // T0D-UIGUARD-1-CATALOG ruling: the kit FilterBar (search + selects) replaced the radio groups.
  it('the search field and the filter selects share ONE .lims-filter-bar', () => {
    const { container } = wrap(<DoctorsList doctors={[]} permissions={['catalog.referrer.read', 'catalog.referrer.manage']} />);
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const bar = input.closest('.lims-filter-bar')!;
    expect(bar).toBeTruthy();
    for (const label of [/^verified/i, /^status/i, /^source/i]) {
      expect(bar.contains(screen.getByLabelText(label)), `${label} select sits in the same filter row as the search`).toBe(true);
    }
    expect(container.querySelectorAll('.lims-filter-bar').length, 'no second filter row').toBe(1);
  });
  it('the Search button follows the search input directly (not a lone button at the far right)', () => {
    const { container } = wrap(<DoctorsList doctors={[]} permissions={['catalog.referrer.read']} />);
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const box = input.closest('.lims-filter-search')!;
    const button = within(box as HTMLElement).getByRole('button', { name: /^search$/i });
    expect(input.closest('.lims-field')!.nextElementSibling, 'element after the search field').toBe(button);
    expect(button.style.marginInlineStart + button.style.marginLeft).not.toMatch(/auto/);
  });
});

describe('stylesheet: a search box in a filter bar is at most 24rem', () => {
  const css = ['packages/ui/src/components/kit.css', 'apps/web/src/core/shell/shell.css']
    .map((f) => readFileSync(join(import.meta.dirname, '..', '..', '..', '..', '..', '..', f), 'utf8'))
    .join('\n');
  it('a rule for .lims-filter-bar + search input / .lims-search-box sets max-width <= 24rem', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => /filter-bar/.test(sel!) && /search/.test(sel!));
    const widths = rules.map(([, , body]) => /max-width:\s*([\d.]+)(rem|px)/.exec(body!)).filter(Boolean).map((m) => (m![2] === 'px' ? Number(m![1]) / 16 : Number(m![1])));
    expect(widths.length, 'no rule limits the search box width inside .lims-filter-bar').toBeGreaterThan(0);
    for (const w of widths) expect(w).toBeLessThanOrEqual(24);
  });
});
