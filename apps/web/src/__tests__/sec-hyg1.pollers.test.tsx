// @vitest-environment jsdom
// SEC-HYG-1 (LD-240; audit 11.3 poll part): the five long-running pollers that kept calling while the tab was hidden now pause while it is hidden,
// with their interval and error handling unchanged. Fake timers + a hidden document (same visibilityState getter as quality-t24.polling.test.tsx).
//   QueueConsole 5 s (listTokens)  DiscountApprovalsInbox 10 s (router.refresh)  CriticalAlertsPanel 30 s (listCriticalAlertsAction)
//   StatusBoard 30 s (getStatusBoardAction)  ManifestInbox 60 s (router.refresh)
// Per poller, same five checks: (1) visible: first call at the period, not before, then one per period; (2) hidden: zero calls for many periods;
// (3) visible again: polling resumes within one period; (4) a poll that fails keeps the screen and the NEXT call is exactly one period later (no back-off,
// no extra retry); (5) unmount stops it. Not covered: the other ~15 bounded job polls (exports/imports), which stop by themselves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  listTokens: vi.fn(),
  listCriticalAlertsAction: vi.fn(),
  getStatusBoardAction: vi.fn(),
  stub: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : async () => ({ ok: true, data: [] })) }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: h.refresh, back: vi.fn() }),
  usePathname: () => '/x',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/x' }));
vi.mock('@/features/lab/server/actions', () => ({ getStatusBoardAction: h.getStatusBoardAction }));
vi.mock('@/features/reporting/server/actions', () => ({ listCriticalAlertsAction: h.listCriticalAlertsAction }));
vi.mock('@/features/frontdesk/server/actions', () => h.stub());
vi.mock('@/features/partners/server/actions', () => h.stub());

let visible = true;
const setVisible = (v: boolean) => { visible = v; document.dispatchEvent(new Event('visibilitychange')); };
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const uuid = (n: number) => `01a1a98a-ac40-7000-8000-0000000${String(n).padStart(5, '0')}`;
const queue = { id: uuid(1), centre_id: uuid(2), code: 'Q1', display_name: 'Synthetic Queue', token_prefix: 'A', sort_order: 1, is_active: true, version: 1 };
const tok = (n: number) => ({ id: uuid(10 + n), queue_id: queue.id, token_label: `A-00${n}`, status: 'waiting' as const, priority: 'normal' as const, issued_at: '2026-11-19T05:00:00.000Z', call_count: 0, version: 1 });
const RANGE = { from: '2026-11-19T00:00:00.000Z', to: '2026-11-19T23:59:59.999Z' };
const sbRow = (n: number, s: string) => ({ order_id: uuid(100 + n), registration_no: `REG9${String(n).padStart(4, '0')}`, patient_display: { full_name: `Synthetic Patient ${n}`, age_sex: '34Y/F', patient_code: `P-SYN-${n}` }, centre_id: uuid(2), board_status: s, rejected_specimens: 0, priority: 'routine' });
const wrap = (el: ReactElement) => render(<ToastProvider>{el}</ToastProvider>);

interface Poller { name: string; period: number; mount: () => ReturnType<typeof render>; calls: () => number; fail?: () => void; stillShown?: () => void }
const POLLERS: Poller[] = [
  {
    name: 'QueueConsole', period: 5_000, calls: () => h.listTokens.mock.calls.length,
    mount: async () => {
      const { QueueConsole } = await import('@/features/engagement/components/QueueConsole');
      return wrap(<QueueConsole labName="Synthetic Lab" centreId={uuid(2)} queues={[queue]} counters={[]} tokens={[tok(1)]} actions={{ listTokens: h.listTokens } as never} />);
    },
    fail: () => h.listTokens.mockRejectedValueOnce(new Error('network')),
    stillShown: () => expect(screen.getByText('A-001')).toBeTruthy(),
  },
  {
    name: 'DiscountApprovalsInbox', period: 10_000, calls: () => h.refresh.mock.calls.length,
    mount: async () => {
      const { DiscountApprovalsInbox } = await import('@/features/frontdesk/components/DiscountApprovalsInbox');
      return wrap(<DiscountApprovalsInbox approvals={[]} permissions={['frontdesk.discount.approve']} currentMembershipId={uuid(9)} centres={[]} />);
    },
  },
  {
    name: 'CriticalAlertsPanel', period: 30_000, calls: () => h.listCriticalAlertsAction.mock.calls.length,
    mount: async () => {
      const { CriticalAlertsPanel } = await import('@/features/reporting/components/CriticalAlertsPanel');
      return wrap(<CriticalAlertsPanel alerts={[]} />);
    },
    fail: () => h.listCriticalAlertsAction.mockResolvedValueOnce({ ok: false, status: 500, code: 'common.internal', title: 'Something went wrong' }),
    stillShown: () => { expect(screen.getByText('Critical alerts')).toBeTruthy(); expect(screen.queryByText('Critical alerts could not be loaded')).toBeNull(); },
  },
  {
    name: 'StatusBoard', period: 30_000, calls: () => h.getStatusBoardAction.mock.calls.length,
    mount: async () => {
      const { StatusBoard } = await import('@/features/lab/components/StatusBoard');
      return wrap(<StatusBoard centres={[{ id: uuid(2), name: 'Synthetic Central Lab' }]} initialRows={[sbRow(1, 'in_lab')] as never} initialRange={RANGE} permissions={['lab.status_board.read']} />);
    },
    fail: () => h.getStatusBoardAction.mockResolvedValueOnce({ ok: false, status: 500, code: 'common.internal', title: 'Something went wrong' }),
    stillShown: () => expect(screen.getByText('REG90001')).toBeTruthy(),
  },
  {
    name: 'ManifestInbox', period: 60_000, calls: () => h.refresh.mock.calls.length,
    mount: async () => {
      const { ManifestInbox } = await import('@/features/partners/components/ManifestInbox');
      return wrap(<ManifestInbox rows={[]} failed={false} filters={{}} />);
    },
  },
];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-19T05:00:00.000Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  visible = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible });
  h.refresh.mockReset();
  h.listTokens.mockReset().mockResolvedValue([tok(1), tok(2)]);
  h.listCriticalAlertsAction.mockReset().mockResolvedValue({ ok: true, data: { data: [], page: {} } });
  h.getStatusBoardAction.mockReset().mockResolvedValue({ ok: true, data: { data: [sbRow(1, 'in_lab')], page: { limit: 50 } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe.each(POLLERS)('$name polls every $period ms, only while the tab is visible', (p) => {
  it('visible: no call before one period, then one per period (interval unchanged)', async () => {
    await p.mount();
    await tick(p.period - 1_000);
    expect(p.calls()).toBe(0);
    await tick(1_500);
    expect(p.calls()).toBe(1);
    await tick(p.period);
    expect(p.calls()).toBe(2);
    await tick(p.period);
    expect(p.calls()).toBe(3);
  });

  it('hidden tab: no request for ten periods', async () => {
    await p.mount();
    setVisible(false);
    await tick(p.period * 10 + 500);
    expect(p.calls()).toBe(0);
  });

  it('hidden after some polls: the count freezes; visible again: polling resumes within one period', async () => {
    await p.mount();
    await tick(p.period + 500);
    expect(p.calls()).toBe(1);
    setVisible(false);
    await tick(p.period * 6);
    expect(p.calls()).toBe(1);
    setVisible(true);
    await tick(p.period + 500);
    expect(p.calls()).toBeGreaterThanOrEqual(2);
    const resumed = p.calls();
    await tick(p.period);
    expect(p.calls()).toBeGreaterThan(resumed); // keeps going, not a one-off catch-up
  });

  it('a tab that is hidden for the whole time and closed is quiet (unmount while hidden stops everything)', async () => {
    const { unmount } = await p.mount();
    setVisible(false);
    await tick(p.period * 2);
    unmount();
    setVisible(true);
    await tick(p.period * 3);
    expect(p.calls()).toBe(0);
  });

  it('unmount stops the polling', async () => {
    const { unmount } = await p.mount();
    await tick(p.period + 500);
    const n = p.calls();
    expect(n).toBe(1);
    unmount();
    await tick(p.period * 4);
    expect(p.calls()).toBe(n);
  });

  (p.fail ? it : it.skip)('a failed poll keeps the screen on the last data; the next call comes exactly one period later (no back-off, no retry storm)', async () => {
    await p.mount();
    p.fail!();
    await tick(p.period + 500);
    expect(p.calls()).toBe(1);
    p.stillShown!();
    await tick(p.period - 1_500); // 1 s before the next period: still nothing
    expect(p.calls()).toBe(1);
    await tick(1_500);
    expect(p.calls()).toBe(2);
    p.stillShown!();
  });
});

describe('StatusBoard keeps its own pause toggle and request shape under the visibility rule', () => {
  it('still sends the screen range on a visible poll', async () => {
    await POLLERS[3]!.mount();
    await tick(30_500);
    expect(h.getStatusBoardAction.mock.calls[0]![0]).toMatchObject({ registered_at_from: RANGE.from, registered_at_to: RANGE.to });
  });
});
