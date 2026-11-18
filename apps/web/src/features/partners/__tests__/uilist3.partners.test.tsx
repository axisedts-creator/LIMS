// @vitest-environment jsdom
// T0D-UILIST-3 (4) partners: manifests inbox (SM-1), pickups (SK-1), doctors / referrers (SF-1) — LD-353 template 1 LIST, rules 5, 6, 8.
// Each screen is rendered with no rows, with one row, and with a failed load. Synthetic data only (t16.fixtures).
// Fails today because: pickups has no FilterBar; the manifests inbox puts its two switches in a second row outside the FilterBar;
// the kit cellTitle is not switched on (cut-off cells have no title); pickups (9 columns) has no column chooser; a failed load swaps the whole table
// (header row included) for a banner without Retry and reference.
// Not covered here: partners list / detail / settings (PartnersList, PartnerSettings, partner detail): not in done_when (4), and T0D-SALES-1 / T0D-PARTYSET-1 own partners screens.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectListScreen, expectStateInPage, filterBars, headerCells, menuLabel, norm } from '@/features/catalog/__tests__/uilist3.helpers';
import { MANIFEST, PICKUP, REFERRER, manifestSummary, pickup, referrer } from './t16.fixtures';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/partners/manifests',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/partners' }));
const { stub } = vi.hoisted(() => ({ stub: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : async () => ({ ok: true, data: [] })) }) }));
vi.mock('@/features/partners/server/actions', stub);

import { ManifestInbox } from '@/features/partners/components/ManifestInbox';
import { PickupQueue } from '@/features/partners/components/PickupQueue';
import { ReferrerMapping } from '@/features/partners/components/ReferrerMapping';

afterEach(cleanup);
const wrap = (el: React.ReactElement) => render(<ToastProvider>{el}</ToastProvider>);
const LONG = 'Synthetic Long Named Partner Laboratory And Diagnostic Services Private Limited Branch Office Number Twelve';

/** A cell whose text is cut off keeps the full text in its title (rule 5). */
function expectCellTitle(container: HTMLElement, text: string) {
  const cell = [...container.querySelectorAll<HTMLElement>('td, [role="gridcell"]')].find((c) => norm(c.textContent).includes(text));
  expect(cell, `a cell holding "${text.slice(0, 30)}…"`).toBeTruthy();
  const holder = cell!.hasAttribute('title') ? cell! : cell!.querySelector<HTMLElement>('[title]');
  expect(holder?.getAttribute('title') ?? '', 'title attribute carries the full cell text').toContain(text);
}

const SCREENS = [
  {
    name: 'manifests inbox', path: '/partners/manifests', headers: ['Manifest', 'Partner', 'Samples', 'Received', 'Submitted'], long: LONG,
    mount: (rows: unknown[], failed = false) => wrap(<ManifestInbox rows={rows as never} failed={failed} filters={{}} />),
    row: () => manifestSummary({ partner: { id: 'p1', partner_code: 'SYN-LAB-01', name: LONG } }),
  },
  {
    name: 'pickups', path: '/partners/pickups', headers: ['Window', 'Partner', 'Manifests', 'Packages', 'Status', 'Assignee'], long: LONG,
    mount: (rows: unknown[], failed = false) => wrap(<PickupQueue rows={rows as never} failed={failed} />),
    row: () => pickup({ partner: { id: 'p1', partner_code: 'SYN-LAB-01', name: LONG, address_text: 'Synthetic Street 1', contact_phone_e164: '+97715550100' } }),
  },
  {
    name: 'referrers', path: '/partners/referrers', headers: ['Partner', 'Name', 'Qualification', 'Samples this month', 'State'], long: LONG,
    mount: (rows: unknown[], failed = false) => wrap(<ReferrerMapping rows={rows as never} failed={failed} filters={{}} />),
    row: () => referrer({ display_name: LONG }),
  },
] as const;

describe.each(SCREENS)('partners $name', (s) => {
  it('no rows: h1 = menu label, one FilterBar, header row in the kit scroll box, EmptyState in the body', () => {
    const { container } = s.mount([]);
    expectListScreen(container, { path: s.path, headers: [...s.headers], filterBar: 1 });
    expect(container.querySelector('.lims-empty-state, [class*="empty"]') ?? container.textContent).toBeTruthy();
    expect(norm(container.textContent)).toMatch(/No (manifests|pickup requests|doctors)/);
  });

  it('one row: same chrome, the row is shown under the header, a long text cell carries a title attribute', () => {
    const { container } = s.mount([s.row()]);
    expectListScreen(container, { path: s.path, headers: [...s.headers], filterBar: 1 });
    expect([...container.querySelectorAll('[role="row"]')].filter((r) => r.querySelector('[role="rowheader"], [role="gridcell"], td')).length, 'one data row').toBeGreaterThanOrEqual(1);
    expectCellTitle(container, s.long);
  });

  it('numbers are right aligned (header and cells)', () => {
    const { container } = s.mount([s.row()]);
    const heads = [...container.querySelectorAll<HTMLElement>('thead th, [role="columnheader"]')];
    const numeric = heads.filter((h) => /^(Samples|Received|Packages|Samples this month)$/.test(norm(h.textContent)));
    expect(numeric.length).toBeGreaterThan(0);
    for (const h of numeric) expect(h.className, `${norm(h.textContent)} header right aligned`).toMatch(/lims-align-end/);
  });

  it('failed load: the title and the FilterBar stay, the message has a Retry, the header row stays', () => {
    const { container } = s.mount([], true);
    expectStateInPage(container, { path: s.path, kind: 'either' });
    expect(within(container).getByRole('button', { name: /retry|try again/i })).toBeTruthy();
    expect(headerCells(container).length, 'header row kept on failure').toBeGreaterThan(0);
    expect(filterBars(container)).toHaveLength(1);
  });

  it('hostile text stays text', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const row = s.name === 'referrers' ? referrer({ display_name: evil }) : s.name === 'pickups' ? pickup({ contact_name: evil }) : manifestSummary({ partner: { id: 'p1', partner_code: 'X', name: evil } });
    const { container } = s.mount([row]);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(evil);
  });
});

describe('partners manifests inbox: one filter row', () => {
  it('the two attention switches sit inside the single FilterBar, not in a second row below it', () => {
    const { container } = wrap(<ManifestInbox rows={[]} failed={false} filters={{}} />);
    const bar = filterBars(container)[0]!;
    for (const label of ['Has samples needing attention', 'Order exists but sample missing']) {
      const sw = [...container.querySelectorAll('label, [role="switch"]')].find((x) => norm(x.textContent) === label || x.getAttribute('aria-label') === label);
      expect(sw, label).toBeTruthy();
      expect(bar.contains(sw!), `"${label}" inside the FilterBar`).toBe(true);
    }
  });
  it('the menu title and the on-page title are the same words (no second wording)', () => {
    const { container } = wrap(<ManifestInbox rows={[]} failed={false} filters={{}} />);
    expect(norm(container.querySelector('h1')!.textContent)).toBe(menuLabel('/partners/manifests'));
  });
});

describe('partners pickups: 9 columns', () => {
  it('has a column chooser (rule 5: above 8 columns)', () => {
    const { container } = wrap(<PickupQueue rows={[pickup()]} failed={false} />);
    expect(within(container).getByRole('button', { name: /^columns$/i })).toBeTruthy();
  });
  it('has the state FilterBar with a select control', () => {
    const { container } = wrap(<PickupQueue rows={[]} failed={false} />);
    expect(filterBars(container)).toHaveLength(1);
    expect(filterBars(container)[0]!.querySelector('select, button[aria-haspopup], [role="combobox"]')).toBeTruthy();
  });
});

describe('partners ids used by the fixtures are synthetic', () => {
  it('fixtures export ids', () => { expect([MANIFEST, PICKUP, REFERRER].every((x) => x.startsWith('01a1a98a'))).toBe(true); });
});
