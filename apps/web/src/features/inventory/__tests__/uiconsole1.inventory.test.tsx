// @vitest-environment jsdom
// T0D-UICONSOLE-1 (5) unresolved stock = "Waiting consumption" (LD-353 template 2 CONSOLE, rules 5, 6, 8). Same shared contract as uiconsole1.lab.test.tsx (src/__tests__/uiconsole1.contract.tsx).
// UnresolvedView({ facts, nextCursor?, instruments, tests, stores, reasons, canManage }), route /inventory/unresolved, menu inventory.nav.unresolved ("Waiting consumption"):
//   list headers: Age first (live hh:mm since occurred_at), then at least Occurred, Kind, Analyser, Test (the Reason chip "No store found" may stay in the list or move to the detail).
//   Tiles Waiting (every row: the queue holds only unresolved facts), Analysers affected (distinct analysers; a manual QC fact without an analyser adds none), Oldest age (the oldest row, a dash when none).
//   NO FilterBar content is invented: the screen has no filters today, so the one FilterBar (kit part, rule 5 of the template) may hold only what the page already reads (nothing): it must exist exactly once.
//   Detail: occurred, kind text, analyser code, test "CODE · name", reason "No store found", never a raw id; History = Occurred. Bar (canManage only): "Post to store…" first with a shortcut "(P)", then Dismiss.
//   Both open the dialogs they open today ("Post to store", "Dismiss waiting record"). Without canManage the bar has no button. nextCursor keeps the "Load more" button.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@lims/ui/components/Toast';
import { consoleContract } from '@/__tests__/uiconsole1.contract';
import { consolePages } from '@/__tests__/uiconsole1.pages';
import { actionBar, barActions, hasAge, historyLabels, itemOf, norm, pickItem, shortcutOf } from '@/__tests__/uiconsole1.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const session = vi.hoisted(() => ({ perms: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/inventory/unresolved',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Lab Manager', tenantCode: 'syn', roles: [], membershipId: ID(900) } }),
  getRequestPathname: async () => '/inventory/unresolved',
}));

const ID = (n: number) => `01950c12-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-11-16T06:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); cleanup(); session.perms = []; });

const instruments = [{ id: ID(950), instrument_code: 'BIO-1', display_name: 'Synthetic chemistry analyser 1' }, { id: ID(951), instrument_code: 'BIO-2', display_name: 'Synthetic chemistry analyser 2' }];
const tests = [{ id: ID(70), code: 'GLU', name: 'Glucose' }, { id: ID(71), code: 'CREA', name: 'Creatinine' }];
const stores = [{ id: ID(301), branch_id: ID(401), branch_name: 'Synthetic Branch BR-1', store_code: 'BR1-ST1', name: 'Synthetic store 1', store_kind: 'main', is_default_consumption: true, is_active: true, version: 1 }];
const reasons = [{ code: 'not_consumed', display: 'Not consumed' }, { code: 'other', display: 'Other' }];
const fact = (n: number, o: Record<string, unknown> = {}) => ({
  id: ID(850 + n), fact_kind: 'test', source: 'event', status: 'unresolved', instrument_id: ID(950), test_id: ID(70), occurred_at: ago(300), business_date: '2026-11-16', multiplier: 1, rules_applied: 1, movements: [], version: 1, ...o,
});
const f1 = fact(1);
const f2 = fact(2, { fact_kind: 'qc', test_id: ID(71), instrument_id: undefined, occurred_at: ago(120) });
const f3 = fact(3, { fact_kind: 'rerun', instrument_id: ID(951), occurred_at: ago(60) });
const mount = async (rows: readonly unknown[], o: { canManage?: boolean; nextCursor?: string } = {}) => {
  const { UnresolvedView } = await import('../components/UnresolvedView');
  return render(
    <ToastProvider>
      <UnresolvedView facts={rows as never} instruments={instruments} tests={tests} stores={stores} reasons={reasons} canManage={o.canManage ?? true} {...(o.nextCursor ? { nextCursor: o.nextCursor } : {})} />
    </ToastProvider>,
  );
};

consoleContract({
  route: '/inventory/unresolved', menuKey: 'inventory.nav.unresolved', headers: ['Age', 'Occurred', 'Kind', 'Analyser', 'Test'], looseHeaders: true, tileLabels: ['Waiting', 'Analysers affected', 'Oldest age'],
  emptyText: 'Nothing waiting', mount: (rows) => mount(rows), empty: [], one: [f1], oneId: ID(851), many: [f1, f2, f3], manyIds: [ID(851), ID(852), ID(853)],
  tilesEmpty: { Waiting: '0', 'Analysers affected': '0', 'Oldest age': '—' }, tilesOne: { Waiting: '1', 'Analysers affected': '1', 'Oldest age': { ageMin: 300 } },
  // f2 is a manual QC fact with no analyser: it adds no analyser to the count
  tilesMany: { Waiting: '3', 'Analysers affected': '2', 'Oldest age': { ageMin: 300 } },
  marker: (id) => ({ [ID(851)]: 'BIO-1', [ID(852)]: 'CREA', [ID(853)]: 'BIO-2' })[id]!,
});

describe('/inventory/unresolved detail, History, bar, gates and security', () => {
  it('the Age cell is live-formatted hh:mm', async () => {
    const { container } = await mount([f1, f2]);
    expect(hasAge(itemOf(container, ID(851))!.closest('tr')!.textContent!, 300)).toBe(true);
    expect(hasAge(itemOf(container, ID(852))!.closest('tr')!.textContent!, 120)).toBe(true);
  });

  it('detail: kind and test as text, the reason "No store found", a dash for a missing analyser, never a raw id; History = Occurred', async () => {
    const { container } = await mount([f1, f2]);
    const d1 = pickItem(container, ID(851));
    const text = norm(d1.textContent);
    for (const s of ['Test result', 'BIO-1', 'GLU · Glucose', 'No store found']) expect(text, s).toContain(s);
    expect(text).not.toContain(ID(950));
    expect(text).not.toContain(ID(851));
    expect(historyLabels(d1)).toEqual(['Occurred']);
    const d2 = pickItem(container, ID(852));
    expect(norm(d2.textContent)).toContain('QC result');
    expect(norm(d2.textContent)).not.toMatch(/undefined|null/);
  });

  it('manager: the bar offers "Post to store…" first with a shortcut (P), then Dismiss', async () => {
    const { container } = await mount([f1]);
    pickItem(container, ID(851));
    const [first, second] = barActions(container);
    expect(first!.textContent).toMatch(/^post to store/i);
    expect(shortcutOf(first)).toBe('P');
    expect(second!.textContent).toMatch(/^dismiss/i);
  });

  it('the bar buttons open the dialogs the screen opens today', async () => {
    const user = userEvent.setup();
    const { container } = await mount([f1]);
    pickItem(container, ID(851));
    await user.click(within(actionBar(container)!).getByRole('button', { name: /^post to store/i }));
    expect(await screen.findByRole('dialog', { name: /post to store/i })).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(within(actionBar(container)!).getByRole('button', { name: /^dismiss/i }));
    expect(await screen.findByRole('dialog', { name: /dismiss waiting record/i })).toBeTruthy();
  });

  it('read-only (no inventory.master.manage): the queue and the detail show, the bar has no button', async () => {
    const { container } = await mount([f1], { canManage: false });
    pickItem(container, ID(851));
    expect(actionBar(container)?.querySelectorAll('button').length ?? 0).toBe(0);
    expect(screen.queryByRole('button', { name: /post to store|dismiss/i })).toBeNull();
  });

  it('nextCursor keeps the Load more button', async () => {
    await mount([f1], { nextCursor: 'cursor-2' });
    expect(screen.getByRole('button', { name: /load more/i })).toBeTruthy();
    cleanup();
    await mount([f1]);
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('XSS: an analyser code that is markup stays text', async () => {
    const { UnresolvedView } = await import('../components/UnresolvedView');
    const { container } = render(
      <ToastProvider>
        <UnresolvedView facts={[f1] as never} instruments={[{ id: ID(950), instrument_code: '<img src=x onerror=alert(1)>', display_name: 'x' }]} tests={tests} stores={stores} reasons={reasons} canManage />
      </ToastProvider>,
    );
    pickItem(container, ID(851));
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});

// ───────────────────────── pages: NotAvailable, errors
consolePages(
  ORIGIN, (p) => { session.perms = p; },
  [{ name: 'waiting consumption', load: () => import('@/app/(staff)/inventory/unresolved/page'), menuKey: 'inventory.nav.unresolved', perms: ['inventory.item.read'], on500: 'inline-alert' }],
  [{ name: 'waiting consumption', load: () => import('@/app/(staff)/inventory/unresolved/error'), menuKey: 'inventory.nav.unresolved' }],
);
