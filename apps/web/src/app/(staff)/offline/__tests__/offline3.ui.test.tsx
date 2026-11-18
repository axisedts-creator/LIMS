// @vitest-environment jsdom
// T0D-OFFLINE-3 (LD-322; done_when 2, 3, 4, 5): the small screen parts the flows use. jsdom has no layout engine, so the contract is DOM + text.
// Parts live in apps/web/src/core/offline/ui/OfflineParts.tsx (PendingSyncBadge, DocNumber, IssuedOfflineWatermark, BlockWarning) and
// ui/OfflineProvider.tsx (flows prop, useOfflineFlows, useOnlineOnly); the pure online-only list lives in core/offline/guards.ts.
// The parts use ONLY: flows.display(number), flows.statusOf(id), flows.numbers.remaining(series), and the controller snapshot (conn, and a change of it re-resolves).
// Fails now because those modules and exports do not exist.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import { fakeController } from './offline2.fixtures';

afterEach(cleanup);
const OFF = 'OFF-0192F0D6-0192F0D6000070008000000000000001-INV';
const OFF_RC = 'OFF-0192F0D6-0192F0D6000070008000000000000001-RC';

const fakeFlows = (o: { map?: Record<string, string>; status?: Record<string, unknown>; remaining?: Record<string, unknown> } = {}) => ({
  display: vi.fn(async (n: string) => o.map?.[n] ?? n),
  statusOf: vi.fn(async (id: string) => o.status?.[id] ?? null),
  numbers: { remaining: vi.fn(async (s: string) => o.remaining?.[s] ?? { left: 200, size: 200, warn: false }) },
});
async function wrap(el: React.ReactElement, c = fakeController(), f: ReturnType<typeof fakeFlows> | null = fakeFlows()) {
  const { OfflineProvider } = await import('@/core/offline/ui/OfflineProvider');
  return { c, f, ui: <OfflineProvider controller={c as never} {...(f ? { flows: f as never } : {})}>{el}</OfflineProvider> };
}

describe('PendingSyncBadge: the mark on a record with a queued operation (done_when 3)', () => {
  it('shows "Pending sync" for a queued record, and the code of a conflict or a rejection; nothing for a clean record', async () => {
    const { PendingSyncBadge } = await import('@/core/offline/ui/OfflineParts');
    const a = render(<PendingSyncBadge status={{ state: 'pending' }} />);
    expect(a.container.textContent).toMatch(/pending sync/i);
    a.unmount();
    const b = render(<PendingSyncBadge status={{ state: 'conflict', code: 'frontdesk.patient_duplicate_suspected', conflict_id: 'c1' }} />);
    expect(b.container.textContent).toMatch(/conflict/i);
    expect(b.container.textContent).not.toMatch(/frontdesk\.patient_duplicate_suspected/); // a person reads words, not codes
    b.unmount();
    const c = render(<PendingSyncBadge status={{ state: 'rejected', code: 'auth.forbidden' }} />);
    expect(c.container.textContent).toMatch(/rejected/i);
    c.unmount();
    const d = render(<PendingSyncBadge status={null} />);
    expect(d.container.textContent).toBe('');
  });

  it('given an id it asks flows.statusOf and shows the answer', async () => {
    const { PendingSyncBadge } = await import('@/core/offline/ui/OfflineParts');
    const { ui, f } = await wrap(<PendingSyncBadge id="spec-1" />, fakeController(), fakeFlows({ status: { 'spec-1': { state: 'pending' } } }));
    render(ui);
    expect(await screen.findByText(/pending sync/i)).toBeTruthy();
    expect(f!.statusOf).toHaveBeenCalledWith('spec-1');
  });

  it('is exposed to assistive technology as a status', async () => {
    const { PendingSyncBadge } = await import('@/core/offline/ui/OfflineParts');
    render(<PendingSyncBadge status={{ state: 'pending' }} />);
    expect(screen.getByRole('status').textContent).toMatch(/pending sync/i);
  });
});

describe('DocNumber: the provisional number now, the final number after sync (done_when 2)', () => {
  it('without a provider (online, or a role with no offline layer) it prints the value as is', async () => {
    const { DocNumber } = await import('@/core/offline/ui/OfflineParts');
    render(<DocNumber value="INV/2083-84/000042" />);
    expect(screen.getByText('INV/2083-84/000042')).toBeTruthy();
  });

  it('shows the provisional number until the mapping arrives, then the final one, re-resolved when the controller changes', async () => {
    const { DocNumber } = await import('@/core/offline/ui/OfflineParts');
    const map: Record<string, string> = {};
    const { ui, c } = await wrap(<DocNumber value={OFF} />, fakeController(), fakeFlows({ map }));
    render(ui);
    expect(await screen.findByText(OFF)).toBeTruthy();
    map[OFF] = 'INV-000042';
    await act(async () => { c.set({ now: c.getSnapshot().now + 1000 }); });
    await waitFor(() => expect(screen.getByText('INV-000042')).toBeTruthy());
    expect(screen.queryByText(OFF)).toBeNull();
  });
});

describe('IssuedOfflineWatermark and the print views (done_when 2: receipt and bill print with a visible watermark)', () => {
  const receipt = (no: string) => ({ receipt_no: no, issued_at: '2026-11-18T06:00:00.000Z', invoice_nos: [OFF], method_code: 'cash', amount: { amount_paisa: 150000, currency: 'NPR' } });

  it('the watermark says issued offline, pending sync', async () => {
    const { IssuedOfflineWatermark } = await import('@/core/offline/ui/OfflineParts');
    render(<IssuedOfflineWatermark />);
    expect(screen.getByText(/issued offline/i).textContent).toMatch(/pending sync/i);
  });

  it('a receipt with a provisional number prints the number AND the watermark; a final number prints no watermark', async () => {
    const { ReceiptPrintView } = await import('@/features/billing/components/print/ReceiptPrintView');
    const a = render(<ReceiptPrintView receipt={receipt(OFF_RC) as never} />);
    expect(a.container.textContent).toContain(OFF_RC);
    expect(a.container.textContent).toMatch(/issued offline,? pending sync/i);
    a.unmount();
    const b = render(<ReceiptPrintView receipt={{ ...receipt('RC/2083-84/000009'), invoice_nos: ['INV/2083-84/000042'] } as never} />);
    expect(b.container.textContent).toContain('RC/2083-84/000009');
    expect(b.container.textContent).not.toMatch(/issued offline/i);
  });

  it('a reprint after sync shows the FINAL numbers and no watermark (mapping from the device)', async () => {
    const { ReceiptPrintView } = await import('@/features/billing/components/print/ReceiptPrintView');
    const { ui } = await wrap(<ReceiptPrintView receipt={receipt(OFF_RC) as never} />, fakeController(), fakeFlows({ map: { [OFF_RC]: 'RC-000007', [OFF]: 'INV-000042' } }));
    const r = render(ui);
    await waitFor(() => expect(r.container.textContent).toContain('RC-000007'));
    expect(r.container.textContent).toContain('INV-000042');
    expect(r.container.textContent).not.toContain(OFF_RC);
    expect(r.container.textContent).not.toMatch(/issued offline/i);
  });
});

describe('BlockWarning: early warning when a block runs low (done_when 5)', () => {
  it('warns with the series and the numbers left when remaining() says warn; says nothing otherwise', async () => {
    const { BlockWarning } = await import('@/core/offline/ui/OfflineParts');
    const low = await wrap(<BlockWarning series="lab_code" />, fakeController(), fakeFlows({ remaining: { lab_code: { left: 30, size: 200, warn: true } } }));
    const a = render(low.ui);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/lab codes?/i);
    expect(alert.textContent).toContain('30');
    expect(alert.textContent).toMatch(/pending/i); // says what happens next: provisional codes marked PENDING
    a.unmount();
    const fine = await wrap(<BlockWarning series="lab_code" />, fakeController(), fakeFlows());
    render(fine.ui);
    await waitFor(() => expect(fine.f!.numbers.remaining).toHaveBeenCalledWith('lab_code'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names patient ids for the other series, and renders nothing without a provider', async () => {
    const { BlockWarning } = await import('@/core/offline/ui/OfflineParts');
    const w = await wrap(<BlockWarning series="patient_id" />, fakeController(), fakeFlows({ remaining: { patient_id: { left: 0, size: 100, warn: true } } }));
    const a = render(w.ui);
    expect((await screen.findByRole('alert')).textContent).toMatch(/patient ids?/i);
    a.unmount();
    const b = render(<BlockWarning series="lab_code" />);
    expect(b.container.textContent).toBe('');
  });
});

describe('online only actions are disabled offline with a visible reason (done_when 4)', () => {
  it('the closed list names refund, cancel, online payment, SMS, WhatsApp, price list change and master change', async () => {
    const { ONLINE_ONLY_ACTIONS } = await import('@/core/offline/guards');
    expect([...ONLINE_ONLY_ACTIONS].sort()).toEqual(['master.change', 'message.sms', 'message.whatsapp', 'order.cancel', 'order.refund', 'payment.online', 'price_list.change']);
  });

  it('onlineOnlyReason is null online and a sentence offline, for every action', async () => {
    const { ONLINE_ONLY_ACTIONS, onlineOnlyReason } = await import('@/core/offline/guards');
    for (const a of ONLINE_ONLY_ACTIONS) {
      expect(onlineOnlyReason(a, true)).toBeNull();
      const why = onlineOnlyReason(a, false);
      expect(why, a).toMatch(/online|connection|internet/i);
      expect(why, a).not.toMatch(/^offline\./); // text from the message catalogue, never a raw key
    }
  });

  async function probe(action: string, conn: 'online' | 'offline' | 'degraded' | 'syncing') {
    const { useOnlineOnly } = await import('@/core/offline/ui/OfflineProvider');
    const Probe = () => {
      const g = useOnlineOnly(action as never);
      return <><button disabled={g.disabled} aria-describedby={g.reason ? 'why' : undefined}>Do it</button>{g.reason ? <span id="why">{g.reason}</span> : null}</>;
    };
    const w = await wrap(<Probe />, fakeController({ conn }));
    render(w.ui);
    return w.c;
  }

  it('offline: the button is disabled and a visible reason is attached to it; degraded counts as offline', async () => {
    for (const action of ['order.cancel', 'order.refund', 'payment.online', 'message.sms', 'message.whatsapp', 'price_list.change', 'master.change']) {
      for (const conn of ['offline', 'degraded'] as const) {
        await probe(action, conn);
        const b = screen.getByRole('button', { name: 'Do it' }) as HTMLButtonElement;
        expect(b.disabled, `${action} ${conn}`).toBe(true);
        expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent, `${action} ${conn}`).toMatch(/online|connection|internet/i);
        cleanup();
      }
    }
  });

  it('online and syncing: enabled, no reason; going offline disables it live', async () => {
    const c = await probe('order.refund', 'online');
    expect((screen.getByRole('button', { name: 'Do it' }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('why')).toBeNull();
    await act(async () => { c.set({ conn: 'syncing' }); });
    expect((screen.getByRole('button', { name: 'Do it' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { c.set({ conn: 'offline' }); });
    expect((screen.getByRole('button', { name: 'Do it' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById('why')!.textContent).toBeTruthy();
  });

  it('without a provider (the existing online screens) nothing is disabled', async () => {
    const { useOnlineOnly } = await import('@/core/offline/ui/OfflineProvider');
    const Probe = () => { const g = useOnlineOnly('order.cancel'); return <button disabled={g.disabled}>Do it</button>; };
    render(<Probe />);
    expect((screen.getByRole('button', { name: 'Do it' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('useOfflineFlows returns the flows handed to the provider, and null without one', async () => {
    const { useOfflineFlows } = await import('@/core/offline/ui/OfflineProvider');
    let seen: unknown = 'unset';
    const Probe = () => { seen = useOfflineFlows(); return null; };
    render(<Probe />);
    expect(seen).toBeNull();
    cleanup();
    const w = await wrap(<Probe />);
    render(w.ui);
    expect(seen).toBe(w.f);
  });
});
