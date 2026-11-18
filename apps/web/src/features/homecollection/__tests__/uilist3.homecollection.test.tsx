// @vitest-environment jsdom
// T0D-UILIST-3 (4) home collection: dispatch, handovers, devices — LD-353 template 1 LIST (rules 5, 6, 8). Each screen is rendered with no rows and with one row.
// Fails today because: handovers and devices have no FilterBar and dispatch keeps Date and Centre in the page header and "Needs attention" next to (not in) its FilterBar;
// the kit cellTitle is not switched on (no title on cut-off text cells); the three error.tsx files do not keep the page title (ErrorState pageTitle).
// Not tested here (CSS or other tasks): equal control heights and column widths (no layout in jsdom), settings (a form: T0D-UISETTINGS-1), the visit detail page (not a list).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectListScreen, filterBars, h1s, menuLabel, norm } from '@/features/catalog/__tests__/uilist3.helpers';
import { A1, CENTRES, CODES, DATE, PERMS_DISPATCH, V1, V2, route } from './hc-t18.helpers';
import { D1, D2, HV1, HV2 } from './hc-t20.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/homecollection/dispatch',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/homecollection' }));
const { stub } = vi.hoisted(() => ({ stub: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }) }));
vi.mock('@/features/homecollection/server/actions', stub);

import { DispatchBoard } from '@/features/homecollection/components/DispatchBoard';
import { HandoversView } from '@/features/homecollection/components/HandoversView';
import { DevicesView } from '@/features/homecollection/components/DevicesView';
import DispatchError from '../../../app/(staff)/homecollection/dispatch/error';
import HandoversError from '../../../app/(staff)/homecollection/handovers/error';
import DevicesError from '../../../app/(staff)/homecollection/devices/error';

afterEach(cleanup);
const wrap = (el: React.ReactElement) => render(<ToastProvider>{el}</ToastProvider>);
const pageHeader = (c: HTMLElement) => c.querySelector<HTMLElement>('.lims-page-header')!;
/** Text cells (plain string) carry a title attribute with their full text (LD-353 rule 5, kit cellTitle). */
const titled = (c: HTMLElement, text: string) => [...c.querySelectorAll<HTMLElement>('td[title], [role="gridcell"][title]')].filter((x) => x.getAttribute('title') === text);
/** The label is one of the `.lims-label` elements inside the FilterBar (exact text): the kit puts the label above its control (LD-353 rule 2).
 *  A kit Switch carries its own label text instead of a `.lims-label`, so its `label` element counts too. */
const inBar = (c: HTMLElement, label: string) => [...(filterBars(c)[0]?.querySelectorAll('.lims-label, label') ?? [])].some((l) => norm(l.textContent) === label);
const noControlsInHeader = (c: HTMLElement) => expect(pageHeader(c).querySelectorAll('select, input, [role="combobox"], [role="switch"], [role="listbox"], button[aria-haspopup="listbox"]'), 'filters live in the FilterBar, not in the page header').toHaveLength(0);

const oneRoute = route(1, [A1.id]);
const DISPATCH_CASES: [string, typeof V2[], typeof oneRoute[]][] = [['no rows', [], []], ['one row', [V2, A1], [oneRoute]]];

describe.each(DISPATCH_CASES)('dispatch (Home visits) — %s', (name, visits, routes) => {
  const mount = () => wrap(<DispatchBoard date={DATE} centreId={CENTRES[0]!.id} centres={CENTRES} visits={visits as never} routes={routes as never} permissions={PERMS_DISPATCH} codes={CODES as never} />);
  const full = name === 'one row';

  it('h1 = menu label; exactly one FilterBar; table header present also when empty', () => {
    const { container } = mount();
    expectListScreen(container, { path: '/homecollection/dispatch', headers: ['Window', 'Patient', 'Area', 'Kind', 'Tubes', 'Flags'] });
  });

  it('one filter row: Date, Centre, Status, Kind and "Needs attention" are all inside the one FilterBar; none in the page header', () => {
    const { container } = mount();
    for (const l of ['Date', 'Centre', 'Status', 'Kind', 'Needs attention']) expect(inBar(container, l), `${l} in the FilterBar`).toBe(true);
    noControlsInHeader(container);
    expect(pageHeader(container).textContent).toMatch(/Refresh/);
  });

  it('cut-off text cells get a title attribute; the table has the kit title class', () => {
    const { container } = mount();
    expect(container.querySelector('.lims-cell-titles'), 'DataTable cellTitle on').toBeTruthy();
    if (full) {
      expect(titled(container, V2.patient_display_name).length, 'patient cell title').toBe(1);
      expect(titled(container, 'Baneshwor, Kathmandu').length, 'area cell title').toBe(1);
    }
  });

  it('empty state keeps one hint line; the route area stays when there is no route', () => {
    const { container } = mount();
    if (!full) {
      expect(norm(container.textContent)).toContain('No unassigned visits for this date.');
      expect(norm(container.textContent)).toContain('No routes for this date.');
    } else {
      expect(container.querySelector('[aria-label="Test Phlebo 01 route"], table[aria-label*="Test Phlebo 01"], [aria-label*="Test Phlebo 01 route"]')).toBeTruthy();
    }
  });
});

describe('dispatch — a visit with an unreadable patient name stays text', () => {
  it('a hostile patient label is text, not markup', () => {
    const { container } = wrap(<DispatchBoard date={DATE} centres={CENTRES} visits={[{ ...V1, patient_display_name: '<img src=x onerror=alert(1)>' }] as never} routes={[]} permissions={PERMS_DISPATCH} codes={CODES as never} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe.each([['no rows', []], ['one row', [HV1, HV2].slice(0, 1)]])('handovers (Tube handovers) — %s', (_name, rows) => {
  const mount = () => wrap(<HandoversView handovers={rows as never} centres={CENTRES} centreId={CENTRES[0]!.id} status="pending" permissions={['homecollection.handover.receive']} />);

  it('h1 = menu label; exactly one FilterBar; table header present also when empty', () => {
    const { container } = mount();
    expectListScreen(container, { path: '/homecollection/handovers', headers: ['Handed over at', 'From', 'Tubes', 'Status'] });
  });

  it('Status and Centre are in the FilterBar, not in the page header; Refresh stays in the header', () => {
    const { container } = mount();
    expect(inBar(container, 'Status')).toBe(true);
    expect(inBar(container, 'Centre')).toBe(true);
    noControlsInHeader(container);
    expect(pageHeader(container).textContent).toMatch(/Refresh/);
  });

  it('cut-off text cells get a title attribute; the Tubes column is right aligned', () => {
    const { container } = mount();
    expect(container.querySelector('.lims-cell-titles'), 'DataTable cellTitle on').toBeTruthy();
    if (rows.length) expect(titled(container, 'Test Phlebo 01').length, 'From cell title').toBe(1);
    const th = [...container.querySelectorAll('[role="columnheader"], th')].find((h) => norm(h.textContent) === 'Tubes')!;
    expect(th.className).toMatch(/lims-align-end/);
    if (!rows.length) expect(norm(container.textContent)).toContain('No handovers waiting at this centre.');
  });
});

describe.each([['no rows', []], ['rows', [D1, D2]]])('devices (Phlebotomy phones) — %s', (_name, rows) => {
  const mount = () => wrap(<DevicesView devices={rows as never} codes={{ wipe_reasons: [] }} minAppVersion="1.10.0" permissions={['homecollection.device.manage']} />);

  it('h1 = menu label; exactly one FilterBar; table header present also when empty', () => {
    const { container } = mount();
    expectListScreen(container, { path: '/homecollection/devices', headers: ['Phlebotomist', 'Model', 'App version', 'Status', 'Last seen', 'Last upload', 'Last route download'] });
  });

  it('Status is in the FilterBar (the page already accepts ?status); the page header keeps only Refresh', () => {
    const { container } = mount();
    expect(inBar(container, 'Status')).toBe(true);
    noControlsInHeader(container);
    expect(pageHeader(container).textContent).toMatch(/Refresh/);
  });

  it('cut-off text cells get a title attribute (phlebotomist, model, app version)', () => {
    const { container } = mount();
    expect(container.querySelector('.lims-cell-titles'), 'DataTable cellTitle on').toBeTruthy();
    if (rows.length) {
      expect(titled(container, 'Test Phlebo 01').length, 'phlebotomist title').toBe(1);
      expect(titled(container, 'Synthetic Phone 1 (Android)').length + titled(container, 'Synthetic Phone 1 (android)').length, 'model title').toBe(1);
    } else {
      expect(norm(container.textContent)).toContain('No phones registered yet.');
    }
  });
});

// LD-353 rule 6: ErrorState keeps the page title (a 5xx from the page reaches error.tsx; the title is the menu label, with the reference and Retry).
describe.each([
  ['dispatch', '/homecollection/dispatch', DispatchError],
  ['handovers', '/homecollection/handovers', HandoversError],
  ['devices', '/homecollection/devices', DevicesError],
] as const)('error.tsx %s keeps the page title', (_n, path, Err) => {
  it('h1 = menu label, reference and Retry shown, no message or stack', () => {
    const reset = vi.fn();
    const { container, getByRole } = render(<Err error={Object.assign(new Error('boom at /srv/api.ts:12'), { digest: 'ref-0190a1b2' })} reset={reset} />);
    expect(h1s(container)).toEqual([menuLabel(path)]);
    expect(container.textContent).toContain('ref-0190a1b2');
    expect(getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(container.textContent).not.toMatch(/boom|api\.ts/);
  });
});
