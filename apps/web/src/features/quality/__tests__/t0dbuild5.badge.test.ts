// T0D-BUILD-5 (founder order 2026-11-22 22:06 NPT; LD-455) done_when (1), unit part: getTatAlertBadge (features/quality/server/tat-badge.ts).
// C9 04-UI-UX §1.1: badge = open breached + escalated alerts, '50+' when the first page (limit 50) is full; none for 0, without quality.tat_alert.read
// (and then NO api call), or when the call fails (never raises, failure logged). One call per invocation. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ perms: [] as string[], fetch: vi.fn(), sessionFails: false }));

vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getRequestPathname: async () => '/quality',
  getShellSession: async () => {
    if (h.sessionFails) throw new Error('session store down');
    return { actor: { permissions: h.perms, displayName: 'Synthetic Reviewer', tenantCode: 'syn', roles: [] } };
  },
}));
vi.mock('@/core/api/server-fetch', () => ({
  serverFetch: (...a: unknown[]) => h.fetch(...a),
  ApiError: class ApiError extends Error {
    constructor(readonly status: number, readonly problem: { code: string }) { super(`${problem.code} (${status})`); }
  },
}));

import { getTatAlertBadge } from '../server/tat-badge';

const READ = 'quality.tat_alert.read';
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ tat_item_id: `01a1a98a-ac40-7000-8000-0000000d${String(i).padStart(4, '0')}`, alert_level: 'breached' }));
const page = (n: number) => ({ data: rows(n), page: { limit: 50 }, generated_at: '2026-11-22T10:00:00.000Z' });

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
const logged = () => errSpy.mock.calls.length + warnSpy.mock.calls.length;

beforeEach(() => {
  h.perms = [READ];
  h.sessionFails = false;
  h.fetch.mockReset();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('getTatAlertBadge: the number', () => {
  it.each([[1, '1'], [7, '7'], [49, '49'], [50, '50+']])('%i open alerts -> %s', async (n, text) => {
    h.fetch.mockResolvedValue(page(n));
    expect(await getTatAlertBadge()).toBe(text);
  });
  it('0 open alerts -> no badge (never "0")', async () => {
    h.fetch.mockResolvedValue(page(0));
    expect(await getTatAlertBadge()).toBeUndefined();
  });
  it('asks for open breached + escalated alerts, first page of 50, in ONE call', async () => {
    h.fetch.mockResolvedValue(page(2));
    await getTatAlertBadge();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String(h.fetch.mock.calls[0]![0]), 'http://api.test');
    expect(url.pathname).toBe('/v1/quality/tat-alerts');
    expect(url.searchParams.get('level')).toBe('breached,escalated');
    expect(url.searchParams.get('acknowledged')).toBe('false');
    expect(url.searchParams.get('limit')).toBe('50');
  });
  it.each([['no data key', {}], ['data is not an array', { data: 'x' }], ['null body', null]])('malformed answer (%s) -> no badge, no throw', async (_n, body) => {
    h.fetch.mockResolvedValue(body);
    expect(await getTatAlertBadge()).toBeUndefined();
  });
});

describe('getTatAlertBadge: permission and failure never break the nav', () => {
  it('without quality.tat_alert.read: no badge and NO api call', async () => {
    h.perms = ['quality.qc_run.read'];
    expect(await getTatAlertBadge()).toBeUndefined();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('no session at all: no badge, no api call', async () => {
    h.perms = [];
    expect(await getTatAlertBadge()).toBeUndefined();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['api 500', () => Promise.reject(Object.assign(new Error('common.internal (500)'), { status: 500 }))],
    ['api 503', () => Promise.reject(Object.assign(new Error('common.dependency_unavailable (503)'), { status: 503 }))],
    ['api 403', () => Promise.reject(Object.assign(new Error('auth.forbidden (403)'), { status: 403 }))],
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('%s: resolves undefined (never rejects) and the failure is logged', async (_n, fail) => {
    h.fetch.mockImplementation(fail);
    await expect(getTatAlertBadge()).resolves.toBeUndefined();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(logged(), 'a swallowed failure must be logged (founder: a failure nobody can see is a bug)').toBeGreaterThan(0);
  });
  it('the session lookup itself failing: resolves undefined, no api call', async () => {
    h.sessionFails = true;
    await expect(getTatAlertBadge()).resolves.toBeUndefined();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('a success and a "no permission" answer log nothing (the log is for failures only)', async () => {
    h.fetch.mockResolvedValue(page(3));
    await getTatAlertBadge();
    h.perms = [];
    await getTatAlertBadge();
    expect(logged()).toBe(0);
  });
});
