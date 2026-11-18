// @vitest-environment jsdom
// T0D-UILIST-3 (4) engagement server pages: queue, bookings, booking slots, bookable tests — LD-353 template 1 LIST (rules 5, 6, 8).
// The page LOADERS are rendered (features/engagement/server/*-pages.tsx) with only serverFetch faked, so the PageHeader the loader adds is under test.
// Each screen: no rows and one row -> h1 = menu label, exactly one FilterBar, table header present, kit scroll box, title on cut-off cells.
// States: API 501 operation_pending -> NotAvailable inside the page (title kept); any other API failure on queue and bookings -> ErrorState inside the page
// (title kept, message, "Reference: <request id>", Retry that refreshes) instead of the error.tsx page (today the loader rethrows).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectListScreen, h1s, menuLabel, norm, headerCells, hasNotAvailable } from '@/features/catalog/__tests__/uilist3.helpers';
import * as B from './t-b6.harness';
import * as Q from './t-q4.harness';

const { state, refresh } = vi.hoisted(() => ({
  refresh: vi.fn(),
  state: {
    fail: undefined as undefined | { match: RegExp; status: number; code: string; requestId?: string },
    queues: [] as unknown[], counters: [] as unknown[], tokens: [] as unknown[],
    bookings: [] as unknown[], templates: [] as unknown[], blackouts: [] as unknown[], items: [] as unknown[],
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/engagement/queue',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['engagement.queue.operate', 'engagement.queue.manage', 'engagement.booking.read', 'engagement.slot.manage', 'engagement.bookable_item.manage', 'frontdesk.patient.read', 'engagement.settings.manage'], displayName: 'Synthetic Front Desk', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/engagement/queue',
}));
vi.mock('@/core/api/server-fetch', () => {
  class ApiError extends Error {
    constructor(readonly status: number, readonly problem: { code: string; status: number; title: string; request_id?: string }) { super(`${problem.code} (${status})`); }
  }
  const serverFetch = async (path: string) => {
    const f = state.fail;
    if (f && f.match.test(path)) throw new ApiError(f.status, { code: f.code, status: f.status, title: 'Synthetic failure', ...(f.requestId ? { request_id: f.requestId } : {}) });
    if (/\/identity\/centres/.test(path)) return { data: [{ centre_id: '01950c16-0000-7000-8000-000000000001', name: 'Synthetic Centre A', kind: 'centre', is_active: true }] };
    if (/\/queue-counters|queue-setup\/counters/.test(path)) return { data: state.counters };
    if (/\/queue-tokens/.test(path)) return { data: state.tokens };
    if (/\/queues|queue-setup\/queues/.test(path)) return { data: state.queues };
    if (/\/engagement\/bookings\?/.test(path)) return { data: state.bookings };
    if (/slot-templates/.test(path)) return { data: state.templates };
    if (/slot-blackouts/.test(path)) return { data: state.blackouts };
    if (/bookable-items/.test(path)) return { data: state.items };
    if (/frontdesk\/patients\//.test(path)) return { full_name: 'Sunita Synthetic Longname Of A Patient' };
    return { data: [] };
  };
  return { ApiError, serverFetch };
});
const stub = vi.hoisted(() => () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }));
vi.mock('@/features/engagement/server/booking-actions', stub);
vi.mock('@/features/engagement/server/queue-actions', stub);

import { consolePage } from '@/features/engagement/server/queue-pages';
import { bookablePage, bookingsPage, slotsPage } from '@/features/engagement/server/booking-pages';

const SP = Promise.resolve({} as Record<string, string | string[] | undefined>);
const mount = async (page: (sp: typeof SP) => Promise<React.ReactNode> | React.ReactNode) => render(<>{await page(SP)}</>);
/** The cell that holds `text` carries a title attribute that repeats it (the cut-off rule, LD-353 rule 5). */
function expectTitled(root: HTMLElement, text: string) {
  const cells = [...root.querySelectorAll<HTMLElement>('td, [role="gridcell"]')].filter((c) => norm(c.textContent).includes(text));
  expect(cells.length, `a cell with "${text}"`).toBeGreaterThan(0);
  for (const c of cells) {
    const titled = [c, ...c.querySelectorAll<HTMLElement>('[title]')].some((e) => (e.getAttribute('title') ?? '').includes(text));
    expect(titled, `cell "${norm(c.textContent).slice(0, 40)}" has a title`).toBe(true);
  }
}

beforeEach(() => {
  state.fail = undefined;
  state.queues = Q.queues(); state.counters = Q.counters();
  state.tokens = []; state.bookings = []; state.templates = []; state.blackouts = []; state.items = [];
  refresh.mockClear();
});
afterEach(cleanup);

describe.each([['no rows', false], ['one row', true]])('queue (/engagement/queue) — %s', (_n, full) => {
  beforeEach(() => { state.tokens = full ? [Q.tok(1)] : []; });
  it('h1 is the menu label; at most one FilterBar; token table header present in the kit scroll box', async () => {
    const { container } = await mount(consolePage);
    expectListScreen(container, { path: '/engagement/queue', filterBar: 'optional' });
    if (full) expect(norm(container.textContent)).toContain('A-001');
  });
});

describe.each([['no rows', false], ['one row', true]])('bookings (/engagement/bookings) — %s', (_n, full) => {
  beforeEach(() => { state.bookings = full ? [B.booking(1)] : []; });
  it('h1 is the menu label; exactly one FilterBar; table header present in the kit scroll box', async () => {
    const { container } = await mount(bookingsPage);
    expectListScreen(container, { path: '/engagement/bookings', headers: ['Time', 'Patient', 'Status'] });
    if (!full) expect(norm(container.textContent)).toMatch(/No bookings|Nothing|No .*found/i);
  });
  if (full) {
    it('cut-off cells carry a title: patient name and the tests list', async () => {
      const { container } = await mount(bookingsPage);
      expectTitled(container, 'Sunita Synthetic Longname Of A Patient');
      expectTitled(container, 'Synthetic CBC');
    });
  }
});

describe.each([['no rows', false], ['one row', true]])('booking slots (/engagement/slots) — %s', (_n, full) => {
  beforeEach(() => { state.templates = full ? [B.templates()[0]] : []; state.blackouts = full ? [B.blackouts()[0]] : []; });
  it('h1 is the menu label; exactly one FilterBar; table header present in the kit scroll box', async () => {
    const { container } = await mount(slotsPage);
    expectListScreen(container, { path: '/engagement/slots' });
  });
  if (full) {
    it('cut-off cells carry a title: the blackout note', async () => {
      const { container } = await mount(slotsPage);
      expectTitled(container, 'Synthetic festival');
    });
  }
});

describe.each([['no rows', false], ['one row', true]])('bookable tests (/engagement/bookable-items) — %s', (_n, full) => {
  beforeEach(() => { state.items = full ? [B.bookableItems()[0]] : []; });
  it('h1 is the menu label; exactly one FilterBar; table header present in the kit scroll box', async () => {
    const { container } = await mount(() => bookablePage());
    expectListScreen(container, { path: '/engagement/bookable-items', headers: ['Code', 'Name'] });
  });
  if (full) {
    it('cut-off cells carry a title: the test name', async () => {
      const { container } = await mount(() => bookablePage());
      expectTitled(container, 'Synthetic CBC');
    });
  }
});

// ---------------------------------------------------------------- states inside the page (rule 6)
const PENDING = { status: 501, code: 'operation_pending' };
const pages: [string, string, (sp: typeof SP) => Promise<React.ReactNode> | React.ReactNode, RegExp][] = [
  ['queue', '/engagement/queue', consolePage, /queue-tokens/],
  ['bookings', '/engagement/bookings', bookingsPage, /\/engagement\/bookings\?/],
  ['booking slots', '/engagement/slots', slotsPage, /slot-templates/],
  ['bookable tests', '/engagement/bookable-items', () => bookablePage(), /bookable-items/],
];

describe.each(pages)('%s — API 501 operation_pending', (_n, path, page, match) => {
  it('shows the calm NotAvailable state inside the page: title kept, no alert, no Retry, no raw code', async () => {
    state.fail = { match, ...PENDING };
    const { container } = await mount(page);
    expect(h1s(container)).toEqual([menuLabel(path)]);
    expect(hasNotAvailable(container)).toBe(true);
    expect(container.querySelector('[role="alert"], .lims-tone-danger')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(norm(container.textContent)).not.toMatch(/operation_pending|501/);
  });
});

describe('bookings — NotAvailable keeps the table header row', () => {
  it('header row shown with the 501 state in the body', async () => {
    state.fail = { match: /\/engagement\/bookings\?/, ...PENDING };
    const { container } = await mount(bookingsPage);
    expect(headerCells(container)).toEqual(expect.arrayContaining(['Time', 'Patient', 'Status']));
  });
});

describe.each(pages.slice(0, 2))('%s — any other API failure', (_n, path, page, match) => {
  const REF = 'req-0a1b2c3d';
  beforeEach(() => { state.fail = { match, status: 500, code: 'common.internal_error', requestId: REF }; });

  it('does not throw to error.tsx: the loader returns the page with the title and an ErrorState (message, reference, Retry)', async () => {
    const { container } = await mount(page);
    expect(h1s(container)).toEqual([menuLabel(path)]);
    expect(container.querySelector('.lims-state.lims-tone-danger'), 'ErrorState').toBeTruthy();
    const text = norm(container.textContent);
    expect(text).toContain(`Reference: ${REF}`);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(text, 'no raw problem code or status').not.toMatch(/common\.internal_error|\(500\)/);
    expect(text).not.toMatch(/Something went wrong/i);
  });

  it('Retry reloads the page data (router.refresh)', async () => {
    await mount(page);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a failure without a request id still shows the title, a message and Retry (no "Reference: undefined")', async () => {
    state.fail = { match, status: 503, code: 'common.unavailable' };
    const { container } = await mount(page);
    expect(h1s(container)).toEqual([menuLabel(path)]);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(norm(container.textContent)).not.toMatch(/undefined|Reference: $/);
  });
});
