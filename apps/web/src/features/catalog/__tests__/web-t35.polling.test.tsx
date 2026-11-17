// @vitest-environment jsdom
// C3.T-35 done_when: "Polling 2 s, stop at 15 min" (04-UI-UX SCR-19: "every 2 s while status ∈ {uploaded, scanning, validating, committing}; stop after 15 min with Banner
// 'This is taking longer than expected. You can leave this page; the import continues.'"; 03-APP-FLOW F-15 step 2 / F-16 step 2). Fake timers; the BFF reads are mocked
// at server/getImport.server + server/listImportIssues.server (whatever server-action wrapper the writer adds around them runs for real).
// ASSUMED: same ImportDetail({importRow, issues, priceList?, permissions}) contract as web-t35.components.test.tsx; polling goes through getImport(id) (#99) and,
// once the status is terminal, listImportIssues(id, …) (#100) — i.e. a server action, not a client fetch with the JWT (REQ-SEC-068). Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/catalog/imports/x',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));
const bff = vi.hoisted(() => ({ getImport: vi.fn(), listImportIssues: vi.fn() }));
const exportsMock = vi.hoisted(() => ({ getExport: vi.fn() }));
vi.mock('../server/getImport.server', () => ({ getImport: bff.getImport }));
vi.mock('../server/listImportIssues.server', () => ({ listImportIssues: bff.listImportIssues }));
vi.mock('../server/getExport.server', () => ({ getExport: exportsMock.getExport }));
vi.mock('../server/listExports.server', () => ({ listExports: vi.fn(async () => ({ data: [], page: { limit: 50 } })) }));

const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000d${String(n).padStart(4, '0')}`;
const imp = (o: Record<string, unknown> = {}) => ({ id: ID(1), kind: 'price_list', target_price_list_id: ID(60), base_version_no: 3, status: 'uploaded', file_name: 'prices.xlsx', file_sha256: 'ab'.repeat(32), summary: { rows: 0, added: 0, changed: 0, removed: 0, unchanged: 0, errors: 0, warnings: 0 }, deduplicated: false, expires_at: '2026-11-20T00:00:00.000Z', created_at: '2026-11-08T04:00:00.000Z', created_by: ID(70), version: 1, ...o });
const PL = { id: ID(60), code: 'PL-DRX', name: 'Synthetic default prices', owner_kind: 'default', falls_through: true, assignments: [], current_version: { id: ID(61), version_no: 3 }, is_active: true, version: 2 };
const PERM = ['catalog.test.read', 'catalog.price_list.read', 'catalog.price_list.manage'];
const MIN = 60_000;
const BANNER = 'This is taking longer than expected. You can leave this page; the import continues.';

const show = async (status: string, extra: Record<string, unknown> = {}) => {
  const { ImportDetail } = await import('../components/ImportDetail');
  const ui: ReactNode = <ToastProvider><ImportDetail importRow={imp({ status, ...extra }) as never} issues={[]} priceList={PL as never} permissions={PERM} /></ToastProvider>;
  return render(ui);
};
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const bannerShown = () => (document.body.textContent ?? '').includes(BANNER);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-09T04:00:00.000Z') });
  bff.getImport.mockReset();
  bff.listImportIssues.mockReset().mockResolvedValue({ data: [], page: { limit: 50 } });
  refresh.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('SCR-19 polling (done_when: 2 s, stop at 15 min)', () => {
  it.each(['validated', 'invalid', 'quarantined', 'committed', 'commit_failed', 'discarded', 'expired', 'failed'])('terminal status %s: no polling at all', async (status) => {
    bff.getImport.mockResolvedValue(imp({ status }));
    await show(status);
    await tick(30_000);
    expect(bff.getImport).not.toHaveBeenCalled();
  });

  it.each(['uploaded', 'scanning', 'validating', 'committing'])('transient status %s: first poll at 2 s (not before), then every 2 s', async (status) => {
    bff.getImport.mockResolvedValue(imp({ status }));
    await show(status);
    await tick(1_900);
    expect(bff.getImport).not.toHaveBeenCalled();
    await tick(200); // t = 2.1 s
    expect(bff.getImport).toHaveBeenCalledTimes(1);
    expect(bff.getImport).toHaveBeenCalledWith(ID(1));
    await tick(8_000); // t = 10.1 s
    expect(bff.getImport).toHaveBeenCalledTimes(5);
  });

  it('status change uploaded → validating → validated: UI follows, polling stops, issues are loaded once, Commit becomes available', async () => {
    bff.getImport
      .mockResolvedValueOnce(imp({ status: 'validating', version: 2 }))
      .mockResolvedValue(imp({ status: 'validated', version: 3, summary: { rows: 10, added: 1, changed: 2, removed: 0, unchanged: 7, errors: 0, warnings: 0 } }));
    await show('uploaded');
    expect(screen.queryByRole('button', { name: /^commit/i })).toBeNull();
    await tick(2_100);
    expect(document.body.textContent).toContain('Validating');
    await tick(2_000);
    expect(document.body.textContent).toContain('Ready to commit');
    expect((screen.getByRole('button', { name: /^commit/i }) as HTMLButtonElement).disabled).toBe(false);
    const n = bff.getImport.mock.calls.length;
    expect(n).toBe(2);
    await tick(20_000);
    expect(bff.getImport.mock.calls.length, 'no polling after a terminal status').toBe(n);
    expect(bff.listImportIssues).toHaveBeenCalled();
  });

  it('committing → committed: polling stops and the link to the new price-list version appears (F-15 step 6)', async () => {
    bff.getImport.mockResolvedValueOnce(imp({ status: 'committing' })).mockResolvedValue(imp({ status: 'committed', result_price_list_version_id: ID(64), version: 8 }));
    await show('committing');
    await tick(4_100);
    const href = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')).find((h) => h?.includes(ID(64)));
    expect(href).toBe(`/catalog/price-lists/${ID(60)}/versions/${ID(64)}`);
    const n = bff.getImport.mock.calls.length;
    await tick(10_000);
    expect(bff.getImport.mock.calls.length).toBe(n);
  });

  it('stops after 15 minutes with the exact banner; no banner before; no further requests afterwards', async () => {
    bff.getImport.mockResolvedValue(imp({ status: 'validating' }));
    await show('validating');
    await tick(14 * MIN + 50_000); // 14 min 50 s
    expect(bannerShown(), 'banner before 15 min').toBe(false);
    const before = bff.getImport.mock.calls.length;
    expect(before).toBeGreaterThanOrEqual(14 * 30); // 2 s cadence held for the whole period (14 min = 420 polls)
    await tick(15_000); // 15 min 5 s
    expect(bannerShown(), 'banner at 15 min').toBe(true);
    expect(bff.getImport.mock.calls.length).toBeLessThanOrEqual(15 * 30 + 1);
    const after = bff.getImport.mock.calls.length;
    await tick(5 * MIN);
    expect(bff.getImport.mock.calls.length, 'polling stopped at 15 min').toBe(after);
    expect(bannerShown()).toBe(true);
    expect(document.body.textContent).toContain('Validating'); // last known state stays visible
  });

  it('a transient poll failure (500 / network) does not crash the page or stop polling; no raw error text leaks', async () => {
    bff.getImport.mockRejectedValueOnce(new Error('boom: postgres://secret')).mockResolvedValue(imp({ status: 'validating' }));
    await show('validating');
    await tick(2_100);
    await tick(2_000);
    expect(bff.getImport.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).not.toMatch(/postgres:|boom/);
    expect(document.body.textContent).toContain('Validating');
  });

  it('unmount (leaving the page) stops polling — the import continues server-side', async () => {
    bff.getImport.mockResolvedValue(imp({ status: 'validating' }));
    const v = await show('validating');
    await tick(4_100);
    const n = bff.getImport.mock.calls.length;
    v.unmount();
    await tick(60_000);
    expect(bff.getImport.mock.calls.length).toBe(n);
  });

  it('no overlapping polls: a slow response (> 2 s) is awaited before the next tick fires', async () => {
    let resolve!: (v: unknown) => void;
    bff.getImport.mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockResolvedValue(imp({ status: 'validating' }));
    await show('validating');
    await tick(10_000);
    expect(bff.getImport, 'first poll still in flight').toHaveBeenCalledTimes(1);
    resolve(imp({ status: 'validating' }));
    await tick(2_100);
    expect(bff.getImport.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('SCR-18 exports polling (F-16 step 2: poll #105 every 2 s until ready, then Download)', () => {
  const exp = (o: Record<string, unknown> = {}) => ({ id: ID(90), kind: 'price_list', status: 'queued', version: 1, ...o });

  it('a queued export is polled every 2 s; at `ready` polling stops and "Download" → /catalog/exports/{id}/file is offered; `failed` stops with text', async () => {
    exportsMock.getExport.mockReset()
      .mockResolvedValueOnce(exp({ status: 'building' }))
      .mockResolvedValue(exp({ status: 'ready', file_name: 'price-list.xlsx', byte_size: 100, expires_at: '2026-11-15T00:00:00.000Z' }));
    const { ImportsScreen } = await import('../components/ImportsScreen');
    render(<ToastProvider><ImportsScreen imports={[]} exports={[exp() as never]} priceLists={[PL as never]} permissions={PERM} /></ToastProvider>);
    await tick(1_900);
    expect(exportsMock.getExport).not.toHaveBeenCalled();
    await tick(4_300);
    expect(exportsMock.getExport.mock.calls.length).toBe(2);
    const dl = [...document.querySelectorAll('a,button')].filter((e) => /^download$/i.test(e.textContent?.trim() ?? ''));
    expect(dl).toHaveLength(1);
    expect(dl[0]!.getAttribute('href')).toBe(`/catalog/exports/${ID(90)}/file`);
    await tick(20_000);
    expect(exportsMock.getExport.mock.calls.length, 'stopped at ready').toBe(2);
  });
});
