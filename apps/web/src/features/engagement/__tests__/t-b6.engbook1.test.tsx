// @vitest-environment jsdom
// T0D-ENGBOOK-1 — /engagement/bookings (and slots, bookable catalogue) must not end in "Something went wrong" when an engagement feature is
// switched off (API: 403 common.feature_disabled, contracts/errors.yaml) or the list is empty (API: 200 {data:[],page:{limit}}).
// Founder blanket authority LD-310 (2026-11-17): plain message + link to Engagement settings only for engagement.settings.manage;
// "No bookings yet" inside a table that still shows its headers when the feature is on and the list is empty. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import * as H from './t-b6.harness';
import { menuLabel } from '@/features/catalog/__tests__/uilist3.helpers';

const h = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(readonly status: number, readonly problem: { code: string; status: number; title: string; type: string; request_id?: string }) { super(`${problem.code} (${status})`); }
  }
  return { ApiError, perms: [] as string[], calls: [] as { path: string; method: string }[], route: (_p: string, _i?: RequestInit): unknown => undefined };
});
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/engagement/bookings', useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('@/core/session/server', () => ({ getShellSession: async () => ({ actor: { permissions: h.perms } }), getAccessToken: async () => 'tok' }));
vi.mock('@/core/api/server-fetch', () => ({
  ApiError: h.ApiError,
  serverFetch: async (path: string, init?: RequestInit) => { h.calls.push({ path, method: init?.method ?? 'GET' }); return h.route(path, init); },
}));
vi.mock('../server/booking-actions', () => new Proxy({}, { get: () => async () => ({ ok: true, data: [] }) }));

const featureOff = () => new h.ApiError(403, { type: 'urn:lims:error:common.feature_disabled', title: 'Feature disabled', status: 403, code: 'common.feature_disabled' });
const CENTRES = { data: [{ centre_id: H.CENTRE, name: 'Synthetic Centre A', kind: 'laboratory', is_active: true }] };
const EMPTY = { data: [], page: { limit: 100 } };
const SETTINGS_LINK = /engagement settings/i;

/** Every engagement call answers `engagement(path)`; identity centres always answer. */
const api = (engagement: (path: string) => unknown) => {
  h.route = (path) => {
    if (path.startsWith('/v1/identity/centres')) return CENTRES;
    if (path.startsWith('/v1/engagement')) return engagement(path);
    throw new Error(`unexpected call ${path}`);
  };
};
const loaders = async () => import('../server/booking-pages');
const show = async (page: Promise<unknown>) => render((await page) as React.ReactElement);

beforeEach(() => { h.perms = ['engagement.booking.read', 'engagement.slot.manage', 'engagement.bookable_item.manage']; h.calls = []; });
afterEach(cleanup);

describe('feature switched off (403 common.feature_disabled) — bookings', () => {
  it('shows "Bookings are switched off for this lab" and a link to Engagement settings for engagement.settings.manage', async () => {
    h.perms.push('engagement.settings.manage');
    api(() => { throw featureOff(); });
    const { bookingsPage } = await loaders();
    await show(bookingsPage(Promise.resolve({})));
    expect(H.pageText()).toContain('Bookings are switched off for this lab');
    const link = screen.getByRole('link', { name: SETTINGS_LINK });
    expect(link.getAttribute('href')).toBe('/engagement/settings');
    expect(H.pageText()).not.toMatch(/something went wrong|could not be loaded/i);
  });
  it('without engagement.settings.manage: same message, no settings link', async () => {
    api(() => { throw featureOff(); });
    const { bookingsPage } = await loaders();
    await show(bookingsPage(Promise.resolve({})));
    expect(H.pageText()).toContain('Bookings are switched off for this lab');
    expect(screen.queryByRole('link', { name: SETTINGS_LINK })).toBeNull();
    expect(document.querySelector('a[href="/engagement/settings"]')).toBeNull();
  });
  it('only the bookings list refused (side calls answer 200 and empty): still the plain message', async () => {
    api((p) => { if (p.startsWith('/v1/engagement/bookings')) throw featureOff(); return EMPTY; });
    const { bookingsPage } = await loaders();
    await show(bookingsPage(Promise.resolve({})));
    expect(H.pageText()).toContain('Bookings are switched off for this lab');
  });
  it('only a side call refused (cancel reasons, queues) while the list answers 200: the page still renders, no crash', async () => {
    api((p) => { if (p.startsWith('/v1/engagement/bookings')) return EMPTY; throw featureOff(); });
    const { bookingsPage } = await loaders();
    await show(bookingsPage(Promise.resolve({})));
    expect(H.pageText()).not.toMatch(/something went wrong|could not be loaded/i);
    expect(screen.getByRole('grid', { name: /booking/i })).toBeTruthy();
  });
  // T0D-UILIST-3 (LD-353 rule 6, done_when 4): a real fault is still shown, now as an ErrorState inside the page (title, message, reference, Retry), not as the error page.
  it('a real fault (500) is NOT hidden: the page shows its title and an ErrorState with the reference and Retry, no empty state, no raw code', async () => {
    api(() => { throw new h.ApiError(500, { type: 'urn:lims:error:common.internal', title: 'Internal error', status: 500, code: 'common.internal', request_id: 'req-0a1b2c3d' }); });
    const { bookingsPage } = await loaders();
    const { container } = await show(bookingsPage(Promise.resolve({})));
    expect(H.norm(container.querySelector('h1')?.textContent)).toBe(menuLabel('/engagement/bookings'));
    expect(container.querySelector('.lims-state.lims-tone-danger'), 'ErrorState').toBeTruthy();
    expect(H.pageText()).toContain('Reference: req-0a1b2c3d');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(H.pageText()).not.toMatch(/No bookings yet|switched off|common\.internal|\(500\)/);
  });
});

describe('feature switched off — slots and bookable items', () => {
  it('slots page: plain switched-off message instead of a crash (with the settings link for the settings manager)', async () => {
    h.perms.push('engagement.settings.manage');
    api(() => { throw featureOff(); });
    const { slotsPage } = await loaders();
    await show(slotsPage(Promise.resolve({})));
    expect(H.pageText()).toMatch(/switched off for this lab/i);
    expect(screen.getByRole('link', { name: SETTINGS_LINK }).getAttribute('href')).toBe('/engagement/settings');
    expect(H.pageText()).not.toMatch(/something went wrong|could not be loaded/i);
  });
  it('bookable catalogue page: plain switched-off message; no link without engagement.settings.manage', async () => {
    api(() => { throw featureOff(); });
    const { bookablePage } = await loaders();
    await show(bookablePage());
    expect(H.pageText()).toMatch(/switched off for this lab/i);
    expect(screen.queryByRole('link', { name: SETTINGS_LINK })).toBeNull();
  });
  it('new-booking page: bookable-items refused while the feature is off does not crash the page', async () => {
    api(() => { throw featureOff(); });
    const { bookingNewPage } = await loaders();
    await show(bookingNewPage(Promise.resolve({})));
    expect(H.pageText()).not.toMatch(/something went wrong|could not be loaded/i);
  });
});

describe('feature on, list empty (real response shape {data:[],page:{limit}})', () => {
  it('bookings page: table with column headers and "No bookings yet"; no switched-off message', async () => {
    api(() => EMPTY);
    const { bookingsPage } = await loaders();
    await show(bookingsPage(Promise.resolve({})));
    const grid = screen.getByRole('grid', { name: /booking/i });
    const heads = within(grid).getAllByRole('columnheader').map((c) => H.norm(c.textContent)).filter(Boolean);
    for (const c of [/^time/i, /booking no/i, /^patient/i, /^type/i, /^tests/i, /^source/i, /^status/i, /^order/i, /^actions/i]) expect(heads.some((x) => c.test(x)), String(c)).toBe(true);
    expect(H.pageText()).toContain('No bookings yet');
    expect(H.pageText()).not.toMatch(/switched off|something went wrong|could not be loaded/i);
  });
  it('bookings page: a body without data (200 {}) is an empty list, not a crash', async () => {
    api((p) => (p.startsWith('/v1/engagement/bookings') ? {} : EMPTY));
    const { bookingsPage } = await loaders();
    await show(bookingsPage(Promise.resolve({})));
    expect(H.pageText()).toContain('No bookings yet');
  });
});

describe('BookingsList component', () => {
  it('empty rows: headers stay visible and the empty message is "No bookings yet" (replaces "No bookings for this day.", LD-310 / done_when 2)', async () => {
    await H.showBookings(H.bookingsActions(), { rows: [] });
    const grid = screen.getByRole('grid', { name: /booking/i });
    expect(within(grid).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(8);
    expect(H.pageText()).toContain('No bookings yet');
  });
});

describe('no setting is changed (done_when 4)', () => {
  it('rendering any of the pages, off or on, only reads: every API call is a GET', async () => {
    h.perms.push('engagement.settings.manage');
    const { bookingsPage, slotsPage, bookablePage } = await loaders();
    for (const engagement of [() => { throw featureOff(); }, () => EMPTY]) {
      api(engagement);
      await show(bookingsPage(Promise.resolve({})));
      await show(slotsPage(Promise.resolve({})));
      await show(bookablePage());
    }
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(h.calls.filter((c) => /settings/.test(c.path))).toEqual([]);
  });
});
