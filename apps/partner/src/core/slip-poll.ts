// PR-2 slip polling (04-UI-UX PR-2; 08 A5.3 accepted values): one R5 read at once, then one per second while the slip is `requested`;
// stops on issued | failed | expired; gives up 30 s after the start and returns the last slip with timedOut = true (no fetch after that).
// Plain timers (setTimeout) so fake timers drive it. A throwing fetchSlip rejects: the page shows its generic error state.
export const SLIP_POLL_INTERVAL_MS = 1000;
export const SLIP_POLL_TIMEOUT_MS = 30000;

export interface PolledSlip { state: string }

export async function pollAccessSlip<T extends PolledSlip>(fetchSlip: () => Promise<T>): Promise<{ slip: T; timedOut: boolean }> {
  const start = Date.now();
  for (;;) {
    const slip = await fetchSlip();
    if (slip.state !== 'requested') return { slip, timedOut: false };
    const left = SLIP_POLL_TIMEOUT_MS - (Date.now() - start);
    if (left <= 0) return { slip, timedOut: true };
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(SLIP_POLL_INTERVAL_MS, left)));
    if (Date.now() - start >= SLIP_POLL_TIMEOUT_MS) return { slip, timedOut: true };
  }
}
