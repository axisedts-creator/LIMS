// @vitest-environment jsdom
// T0D-OFFLINE-4 (LD-322; done_when 4): what a printed offline report shows. ReportOfflineMarker (ui/OfflineParts.tsx) reads flows.reportStatus(reportVersionId):
// pending = the visible "issued offline, pending sync" watermark, confirmed or none = nothing, recall = an alert banner saying RECALL. The Offline panel lists a
// rejected sign off (result.verify + sync.verification_policy_failed) with the word recall. jsdom has no layout engine: the contract is DOM + text.
// Fails now because ReportOfflineMarker does not exist and the panel has no recall wording.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act, within } from '@testing-library/react';
import { attentionItem, fakeController, withProvider } from './offline2.fixtures';

afterEach(cleanup);
const flowsWith = (status: unknown) => ({
  display: vi.fn(async (n: string) => n), statusOf: vi.fn(async () => null), numbers: { remaining: vi.fn(async () => ({ left: 200, size: 200, warn: false })) },
  reportStatus: vi.fn(async () => status),
});
async function mount(status: unknown, c = fakeController()) {
  const { OfflineProvider } = await import('@/core/offline/ui/OfflineProvider');
  const { ReportOfflineMarker } = await import('@/core/offline/ui/OfflineParts');
  const f = flowsWith(status);
  render(<OfflineProvider controller={c as never} flows={f as never}><ReportOfflineMarker reportVersionId="rv-1" /></OfflineProvider>);
  return { f, c };
}

describe('ReportOfflineMarker', () => {
  it('pending: the visible issued offline, pending sync marker, asked for this report version', async () => {
    const { f } = await mount({ state: 'pending' });
    expect(await screen.findByText(/issued offline/i)).toBeTruthy();
    expect(document.body.textContent).toMatch(/pending sync/i);
    expect(f.reportStatus).toHaveBeenCalledWith('rv-1');
  });

  it('confirmed or none: nothing is drawn (the marker goes away after sync)', async () => {
    for (const state of ['confirmed', 'none']) {
      const { f } = await mount({ state });
      await waitFor(() => expect(f.reportStatus).toHaveBeenCalled());
      expect(document.body.textContent ?? '').not.toMatch(/issued offline|recall/i);
      cleanup();
    }
  });

  it('recall: an alert banner with the word recall and no raw code', async () => {
    await mount({ state: 'recall', code: 'sync.verification_policy_failed', result_ids: ['r-1'] });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/recall/i);
    expect(alert.textContent).not.toMatch(/sync\.verification_policy_failed/);
    expect(document.body.textContent).not.toMatch(/issued offline, pending sync/i); // a recalled report is not shown as merely pending
  });

  it('re-reads the status when the controller changes (a sync settled): pending then confirmed', async () => {
    const c = fakeController();
    const { OfflineProvider } = await import('@/core/offline/ui/OfflineProvider');
    const { ReportOfflineMarker } = await import('@/core/offline/ui/OfflineParts');
    const f = flowsWith({ state: 'pending' });
    render(<OfflineProvider controller={c as never} flows={f as never}><ReportOfflineMarker reportVersionId="rv-1" /></OfflineProvider>);
    expect(await screen.findByText(/issued offline/i)).toBeTruthy();
    f.reportStatus.mockImplementation(async () => ({ state: 'confirmed' }));
    await act(async () => { c.set({ now: Date.now() + 1000 }); });
    await waitFor(() => expect(screen.queryByText(/issued offline/i)).toBeNull());
  });

  it('without a provider (the online screen) it draws nothing', async () => {
    const { ReportOfflineMarker } = await import('@/core/offline/ui/OfflineParts');
    const { container } = render(<ReportOfflineMarker reportVersionId="rv-1" />);
    expect(container.textContent).toBe('');
  });
});

describe('the Offline panel shows the recall of a rejected sign off', () => {
  it('a needs-attention row of result.verify with sync.verification_policy_failed says recall, in words', async () => {
    const { OfflinePanel } = await import('@/core/offline/ui/OfflinePanel');
    const { createElement } = await import('react');
    const c = fakeController({ attention: [attentionItem(1, 'sync.verification_policy_failed', { op_type: 'result.verify', entity_id: 'r-1', payload: {} })] as never });
    render(await withProvider(c, createElement(OfflinePanel as never)));
    const table = (screen.queryByRole('grid', { name: /needs attention/i }) ?? screen.getByRole('table', { name: /needs attention/i })) as HTMLElement;
    const text = within(table).getAllByRole('row').map((r) => r.textContent).join(' ');
    expect(text).toMatch(/recall/i);
    expect(text).not.toMatch(/sync\.verification_policy_failed|result\.verify/); // words, not codes
  });
});
