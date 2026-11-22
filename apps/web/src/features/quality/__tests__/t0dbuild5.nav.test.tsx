// @vitest-environment jsdom
// T0D-BUILD-5 (founder order 2026-11-22 22:06 NPT; LD-455) done_when (1): the Quality entry of the nav rail shows the number of getTatAlertBadge.
// CONTRACT chosen by the tester (the spec names no seam; writer: follow it, or say why in .orchestra/notes/T0D-BUILD-5-left.md):
//   * The badge belongs to the manifest entry `quality.tat_alerts` ("TAT alerts", group Quality; 04-UI-UX §1.1 "nav badge of TAT alerts").
//   * <AppShell counts> (entry id -> badge) accepts a non-empty STRING as well as a finite number, so '50+' can be shown. The rail draws it in the existing slot span[data-badge].
//     An empty/blank string draws no badge. Numbers behave as before (m2.sidebar tests).
//   * app/(staff)/layout.tsx calls getTatAlertBadge() ONCE per render and passes { 'quality.tat_alerts': text } in `counts` only when it returned text. A failure (even a
//     rejection of getTatAlertBadge itself) never stops the page: no badge, children still render.
// The layout test runs the REAL layout, AppShell, Rail and getTatAlertBadge; only the session, the api fetch and the nav manifest are fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { session } from '../../../core/shell/__tests__/r04.harness';

const h = vi.hoisted(() => {
  const E = (id: string, label: string, permission: string, order: number, path: string) => ({ id, label, permission, group: 'quality', order, path, routeId: `staff.${id}`, module: 'quality' });
  const ENTRIES = [
    E('quality.status', 'quality.nav.status', 'quality.qc_run.read', 10, '/quality'),
    E('quality.runs', 'quality.nav.runs', 'quality.qc_run.read', 20, '/quality/runs'),
    E('quality.tat_alerts', 'quality.nav.tat_alerts', 'quality.tat_alert.read', 70, '/quality/tat-alerts'),
  ];
  return { ENTRIES, perms: [] as string[], fetch: vi.fn() };
});

vi.mock('next/navigation', async () => (await import('../../../core/shell/__tests__/r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('../../../core/shell/__tests__/r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/actions', async () => (await import('../../../core/shell/__tests__/r04.harness')).actionsMock);
vi.mock('@/core/session/server', async () => {
  const { session: s } = await import('../../../core/shell/__tests__/r04.harness');
  return { getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => s(h.perms), getRequestPathname: async () => '/quality' };
});
vi.mock('@/core/api/server-fetch', () => ({
  serverFetch: (...a: unknown[]) => h.fetch(...a),
  ApiError: class ApiError extends Error { constructor(readonly status: number, readonly problem: { code: string }) { super(problem.code); } },
}));
vi.mock('@/core/offline/ui/OfflineProvider', async (orig) => ({ ...(await orig<object>()), OfflineProvider: ({ children }: { children: unknown }) => children })); // no offline layer in this test; hooks keep their real defaults
vi.mock('@/core/nav/generated', () => ({
  navEntries: h.ENTRIES,
  staffRoutes: h.ENTRIES.map((e) => ({ id: e.routeId, path: e.path, permission: e.permission })),
}));

import { AppShell } from '../../../core/shell/AppShell';

const TAT = 'quality.tat_alerts';
const READ_ALL = ['quality.qc_run.read', 'quality.tat_alert.read'];
const li = (id: string) => document.querySelector<HTMLElement>(`li[data-entry-id="${id}"]`);
const badgeOf = (id: string) => li(id)?.querySelector('[data-badge]')?.textContent?.trim();
const allBadges = () => [...document.querySelectorAll('[data-badge]')].map((b) => b.textContent?.trim());
const alerts = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ tat_item_id: `01a1a98a-ac40-7000-8000-0000000e${String(i).padStart(4, '0')}`, alert_level: 'breached' })), page: { limit: 50 }, generated_at: '2026-11-22T10:00:00.000Z' });

beforeEach(() => { h.perms = READ_ALL; h.fetch.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => undefined); vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('<AppShell counts>: the badge slot takes the text from getTatAlertBadge', () => {
  const shell = (counts: Record<string, number | string>) =>
    render(<AppShell session={session(READ_ALL) as never} pathname="/quality" menu="elab" counts={counts}><p>page body</p></AppShell>);
  it("a string count draws in the slot: '50+'", () => {
    shell({ [TAT]: '50+' });
    expect(badgeOf(TAT)).toBe('50+');
  });
  it('a numeric count still draws as before', () => {
    shell({ [TAT]: 12 });
    expect(badgeOf(TAT)).toBe('12');
  });
  it.each([[''], ['   ']])('a blank string (%j) draws no badge', (blank) => {
    shell({ [TAT]: blank });
    expect(allBadges()).toEqual([]);
  });
  it('only the entry that is named gets a badge', () => {
    shell({ [TAT]: '3' });
    expect(allBadges()).toEqual(['3']);
    expect(badgeOf('quality.status')).toBeUndefined();
  });
  it("a count for an entry the user cannot see is not drawn anywhere (no 'view only' leak)", () => {
    render(<AppShell session={session(['quality.qc_run.read']) as never} pathname="/quality" menu="elab" counts={{ [TAT]: '9' }}><p>page body</p></AppShell>);
    expect(li(TAT)).toBeNull();
    expect(allBadges()).toEqual([]);
  });
});

describe('staff layout: one getTatAlertBadge per request, wired into the Quality entry', () => {
  const layout = async () => {
    const { default: StaffLayout } = await import('../../../app/(staff)/layout');
    return render(await StaffLayout({ children: <p>page body</p> }));
  };
  const tatCalls = () => h.fetch.mock.calls.filter((c) => String(c[0]).includes('/v1/quality/tat-alerts'));

  it('3 open alerts: the TAT alerts entry shows 3; the other Quality entries show nothing', async () => {
    h.fetch.mockResolvedValue(alerts(3));
    await layout();
    expect(badgeOf(TAT)).toBe('3');
    expect(allBadges()).toEqual(['3']);
  });
  it("a full first page (50): shows '50+'", async () => {
    h.fetch.mockResolvedValue(alerts(50));
    await layout();
    expect(badgeOf(TAT)).toBe('50+');
  });
  it('0 open alerts: no badge', async () => {
    h.fetch.mockResolvedValue(alerts(0));
    await layout();
    expect(li(TAT)).not.toBeNull();
    expect(allBadges()).toEqual([]);
  });
  it('one call per request: the alerts are fetched exactly once', async () => {
    h.fetch.mockResolvedValue(alerts(2));
    await layout();
    expect(tatCalls()).toHaveLength(1);
  });
  it('without quality.tat_alert.read: no entry, no badge and NO call to the alerts api', async () => {
    h.perms = ['quality.qc_run.read'];
    await layout();
    expect(li(TAT)).toBeNull();
    expect(allBadges()).toEqual([]);
    expect(tatCalls()).toHaveLength(0);
  });
  it('the api fails: no badge, the page and the rest of the nav still render, the failure is logged', async () => {
    h.fetch.mockRejectedValue(Object.assign(new Error('common.internal (500)'), { status: 500 }));
    const { container } = await layout();
    expect(container.textContent).toContain('page body');
    expect(li('quality.status')).not.toBeNull();
    expect(li(TAT)).not.toBeNull();
    expect(allBadges()).toEqual([]);
    const logged = (console.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length + (console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(logged).toBeGreaterThan(0);
  });
  it('malformed answer from the api: no badge, no crash', async () => {
    h.fetch.mockResolvedValue({ data: 'oops' });
    const { container } = await layout();
    expect(container.textContent).toContain('page body');
    expect(allBadges()).toEqual([]);
  });
  it('the badge text never carries markup or the token (plain text node)', async () => {
    h.fetch.mockResolvedValue(alerts(5));
    const { container } = await layout();
    expect(container.innerHTML).not.toContain('jwt-synthetic');
    expect(li(TAT)!.querySelector('[data-badge]')!.children).toHaveLength(0);
  });
});
