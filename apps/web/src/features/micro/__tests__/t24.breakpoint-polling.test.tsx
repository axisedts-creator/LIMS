// @vitest-environment jsdom
// C10.T-24 done_when "detail polling" (04-UI-UX §6.2: "While uploaded/validating: Spinner + 'Checking the file… this page updates automatically.'"; AC-12.2).
// Fake timers; the BFF reads are mocked at server/getBreakpointSet.server (+ listBreakpointImportIssues.server / listBreakpointRows.server), like catalog web-t35.polling.
// ASSUMED (spec gives no interval): poll every 2 s like C3 SCR-19; polling goes through a server action (never a client fetch with the JWT, REQ-SEC-068); the stop-after-15-min
// rule of C3 is NOT asserted here (not in the C10 spec). Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/micro/breakpoint-sets/x',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));
const bff = vi.hoisted(() => ({ getBreakpointSet: vi.fn(), listBreakpointImportIssues: vi.fn(), listBreakpointRows: vi.fn() }));
vi.mock('../server/getBreakpointSet.server', () => ({ getBreakpointSet: bff.getBreakpointSet }));
vi.mock('../server/listBreakpointImportIssues.server', () => ({ listBreakpointImportIssues: bff.listBreakpointImportIssues }));
vi.mock('../server/listBreakpointRows.server', () => ({ listBreakpointRows: bff.listBreakpointRows }));

const ID = '01a1a98a-ac40-7000-8000-0000000c0001';
const set = (o: Record<string, unknown> = {}) => ({ id: ID, version: 1, standard: 'CLSI', standard_version: '2099-test', title: 'Synthetic zone table', licence_attestation_text: 'Synthetic attestation: test data only, licensed for this laboratory.', status: 'uploaded', file_sha256: 'ab'.repeat(32), file_bytes: 2048, row_count: 0, band_count: 0, error_count: 0, warning_count: 0, imported_by_display: 'Synthetic Importer', created_at: '2026-11-10T04:00:00.000Z', ...o });
const TEXT = 'Checking the file… this page updates automatically.';

const show = async (status: string) => {
  const { BreakpointSetDetail } = await import('../components/breakpoints/BreakpointSetDetail');
  return render(<ToastProvider><BreakpointSetDetail set={set({ status }) as never} issues={[]} rows={[]} permissions={['micro.culture.read', 'micro.breakpoint.manage']} /></ToastProvider>);
};
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-13T04:00:00.000Z') });
  bff.getBreakpointSet.mockReset();
  bff.listBreakpointImportIssues.mockReset().mockResolvedValue({ data: [], page: { limit: 50 } });
  bff.listBreakpointRows.mockReset().mockResolvedValue({ data: [], page: { limit: 50 } });
  refresh.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('detail polling (done_when)', () => {
  it.each(['validated', 'invalid', 'active', 'retired', 'discarded'])('terminal status %s: no polling, no spinner text', async (status) => {
    await show(status);
    await tick(30_000);
    expect(bff.getBreakpointSet).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(TEXT);
  });

  it.each(['uploaded', 'validating'])('transient status %s: spinner + "Checking the file…" copy, first poll at 2 s (not before), then every 2 s', async (status) => {
    bff.getBreakpointSet.mockResolvedValue(set({ status }));
    await show(status);
    expect(document.body.textContent).toContain(TEXT);
    expect(document.querySelector('[role=progressbar],[role=status],.lims-spinner')).toBeTruthy();
    await tick(1_900);
    expect(bff.getBreakpointSet).not.toHaveBeenCalled();
    await tick(200);
    expect(bff.getBreakpointSet).toHaveBeenCalledTimes(1);
    expect(bff.getBreakpointSet).toHaveBeenCalledWith(ID);
    await tick(8_000);
    expect(bff.getBreakpointSet).toHaveBeenCalledTimes(5);
  });

  it('uploaded → validating → validated: UI follows, polling stops, issues and rows are loaded once, Activate appears', async () => {
    bff.getBreakpointSet
      .mockResolvedValueOnce(set({ status: 'validating', version: 2 }))
      .mockResolvedValue(set({ status: 'validated', version: 3, row_count: 2, band_count: 4 }));
    bff.listBreakpointImportIssues.mockResolvedValue({ data: [{ line_no: 2, severity: 'warning', code: 'row.band_gap', message: 'Gap between bands.' }], page: { limit: 50 } });
    await show('uploaded');
    expect(screen.queryByRole('button', { name: /^activate$/i })).toBeNull();
    await tick(2_100);
    expect(document.body.textContent).toContain('Checking');
    await tick(2_000);
    expect(document.body.textContent).toContain('Ready to activate');
    expect(document.body.textContent).not.toContain(TEXT);
    expect((screen.getByRole('button', { name: /^activate$/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(bff.listBreakpointImportIssues).toHaveBeenCalledTimes(1);
    expect(bff.listBreakpointRows).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Gap between bands.');
    const calls = bff.getBreakpointSet.mock.calls.length;
    await tick(20_000);
    expect(bff.getBreakpointSet.mock.calls.length).toBe(calls); // stopped
  });

  it('uploaded → validating → invalid: shows "Has errors" and the issues, polling stops', async () => {
    bff.getBreakpointSet.mockResolvedValue(set({ status: 'invalid', version: 2, error_count: 1 }));
    bff.listBreakpointImportIssues.mockResolvedValue({ data: [{ line_no: 5, severity: 'error', code: 'file.too_many_rows', message: 'Too many rows.' }], page: { limit: 50 } });
    await show('validating');
    await tick(2_100);
    expect(document.body.textContent).toContain('Has errors');
    expect(document.body.textContent).toContain('Too many rows.');
    expect(screen.queryByRole('button', { name: /^activate$/i })).toBeNull();
    const calls = bff.getBreakpointSet.mock.calls.length;
    await tick(10_000);
    expect(bff.getBreakpointSet.mock.calls.length).toBe(calls);
  });

  it('a failed poll keeps the page usable and tries again (dependency failure)', async () => {
    bff.getBreakpointSet.mockRejectedValueOnce(new Error('network down')).mockResolvedValue(set({ status: 'validated', version: 2 }));
    await show('validating');
    await tick(2_100);
    expect(document.body.textContent).toContain('Checking the file');
    await tick(2_100);
    expect(document.body.textContent).toContain('Ready to activate');
  });

  it('unmount stops polling (no leaked timers)', async () => {
    bff.getBreakpointSet.mockResolvedValue(set({ status: 'validating' }));
    const r = await show('validating');
    r.unmount();
    await tick(10_000);
    expect(bff.getBreakpointSet).not.toHaveBeenCalled();
  });
});
