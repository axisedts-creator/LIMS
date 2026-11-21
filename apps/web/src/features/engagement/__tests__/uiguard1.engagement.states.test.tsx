// @vitest-environment jsdom
// T0D-UIGUARD-1-ENGAGEMENT (rule 4, LD-353 / LD-436 / LD-438 / LD-439): a failed read on /engagement/enquiries, /engagement/enquiries/[enquiry_id],
// /engagement/memberships and /engagement/reminders is answered INSIDE the page, never by the raw error page.
//  - API 501 operation_pending -> the calm NotAvailable state (title kept, no alert, no Retry, no raw code);
//  - API 500 -> ErrorState (title kept, message, "Reference: <request id>", Retry that refreshes);
//  - display only: a 404 on the thread is still notFound(), a missing permission is still notFound() and the API is never called without it.
// Pages are rendered whole, with only serverFetch faked. Fails today: the four pages rethrow (no loadOr / pendingOr / ErrorState / NotAvailable in them).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { hasErrorState, hasNotAvailable, h1s, norm } from '@/features/catalog/__tests__/uilist3.helpers';

const { state, refresh } = vi.hoisted(() => ({
  refresh: vi.fn(),
  state: {
    permissions: [] as string[],
    fail: undefined as undefined | { status: number; code: string; requestId?: string },
    calls: [] as string[],
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/engagement/reminders',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Front Desk', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/engagement',
}));
vi.mock('@/core/api/server-fetch', () => {
  class ApiError extends Error {
    constructor(readonly status: number, readonly problem: { code: string; status: number; title: string; request_id?: string }) { super(`${problem.code} (${status})`); }
  }
  const serverFetch = async (path: string) => {
    state.calls.push(path);
    const f = state.fail;
    if (f && /\/v1\/engagement\//.test(path)) throw new ApiError(f.status, { code: f.code, status: f.status, title: 'Synthetic failure', ...(f.requestId ? { request_id: f.requestId } : {}) });
    return { data: [] };
  };
  return { ApiError, serverFetch };
});
const stub = vi.hoisted(() => () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }));
vi.mock('@/app/(staff)/engagement/reminders/actions', stub);
vi.mock('@/app/(staff)/engagement/memberships/actions', stub);
vi.mock('@/app/(staff)/engagement/enquiries/actions', stub);

import EnquiriesPage from '@/app/(staff)/engagement/enquiries/page';
import EnquiryThreadPage from '@/app/(staff)/engagement/enquiries/[enquiry_id]/page';
import MembershipsPage from '@/app/(staff)/engagement/memberships/page';
import RemindersPage from '@/app/(staff)/engagement/reminders/page';

const ID = '01a1a98a-ac40-7000-8000-000000000021';
const REF = 'req_synthetic_0042';
const SP = Promise.resolve({} as Record<string, string | string[] | undefined>);
type Screen = { name: string; route: string; read: string; mount: () => Promise<React.ReactNode> };
const SCREENS: Screen[] = [
  { name: 'enquiries', route: '/engagement/enquiries', read: 'engagement.enquiry.read', mount: async () => EnquiriesPage({ searchParams: SP }) },
  { name: 'enquiry thread', route: '/engagement/enquiries/[enquiry_id]', read: 'engagement.enquiry.read', mount: async () => EnquiryThreadPage({ params: Promise.resolve({ enquiry_id: ID }) }) },
  { name: 'memberships', route: '/engagement/memberships', read: 'engagement.membership.read', mount: async () => MembershipsPage() },
  { name: 'reminders', route: '/engagement/reminders', read: 'engagement.reminder.read', mount: async () => RemindersPage({ searchParams: SP }) },
];

beforeEach(() => { state.permissions = []; state.fail = undefined; state.calls = []; refresh.mockClear(); });
afterEach(cleanup);
const draw = async (s: Screen) => { state.permissions = [s.read]; return render(<>{await s.mount()}</>); };

describe.each(SCREENS)('$name ($route): a failed read stays inside the page', (s) => {
  it('API 501 operation_pending -> NotAvailable with the page title kept; no alert, no Retry, no raw code', async () => {
    state.fail = { status: 501, code: 'operation_pending' };
    const { container } = await draw(s);
    expect(hasNotAvailable(container), 'NotAvailable state').toBe(true);
    expect(h1s(container), 'exactly one non-empty h1 (title kept)').toHaveLength(1);
    expect(h1s(container)[0]).not.toBe('');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(norm(container.textContent)).not.toMatch(/operation_pending|\b501\b/);
  });

  it('API 500 -> ErrorState in the page: title, message, "Reference: <request id>", Retry that refreshes', async () => {
    state.fail = { status: 500, code: 'internal_error', requestId: REF };
    const { container } = await draw(s);
    expect(hasErrorState(container), 'ErrorState').toBe(true);
    expect(h1s(container), 'exactly one non-empty h1 (title kept)').toHaveLength(1);
    expect(h1s(container)[0]).not.toBe('');
    const text = norm(container.textContent);
    expect(text).toContain(`Reference: ${REF}`);
    expect(text, 'no raw stack or status dump').not.toMatch(/Unhandled|at \w+ \(|internal_error|\b500\b/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('API 500 without a request id still shows the title, a message and Retry (no "Reference: undefined")', async () => {
    state.fail = { status: 500, code: 'internal_error' };
    const { container } = await draw(s);
    expect(h1s(container)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(norm(container.textContent)).not.toMatch(/undefined|Reference: $/);
  });

  it('display only: without the read permission the page is notFound() and the API is never called', async () => {
    state.fail = { status: 500, code: 'internal_error', requestId: REF };
    await expect(s.mount()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(state.calls).toEqual([]);
  });
});

describe('enquiry thread keeps its 4xx behaviour (display only, no contract change)', () => {
  const thread = SCREENS[1]!;
  it.each([404, 400])('API %i -> notFound()', async (status) => {
    state.permissions = [thread.read];
    state.fail = { status, code: 'not_found' };
    await expect(thread.mount()).rejects.toThrow('NEXT_NOT_FOUND');
  });
  it('a malformed id -> notFound() without an API call', async () => {
    state.permissions = [thread.read];
    await expect(EnquiryThreadPage({ params: Promise.resolve({ enquiry_id: 'not-a-uuid' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(state.calls).toEqual([]);
  });
  it('API 403 is not turned into an ErrorState: it still reaches error.tsx (rethrown)', async () => {
    state.permissions = [thread.read];
    state.fail = { status: 403, code: 'auth.forbidden' };
    await expect(thread.mount()).rejects.toThrow();
  });
});
