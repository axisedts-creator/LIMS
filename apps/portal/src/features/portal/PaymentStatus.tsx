import { Card } from '@lims/ui/components/Card';
import type { PortalPayment } from '@/server/api';

// Shared by /r/{token}/payments/{id} (status) and /r/payments/{id}/done (gateway return). Copy: 04-UI-UX §4, 03-APP-FLOW §2.7-2.8.
export const COUNTER_COPY = 'Please pay at the lab counter or in the app.';
export const MAX_REFRESHES = 15; // [CONV] meta refresh every 2 s for up to 30 s, then the page waits for a manual reload

/** `n` = how many refreshes this view has done (query `n`); the refresh stops at MAX_REFRESHES and on a finished request. */
export const refreshN = (raw: string | string[] | undefined): number => {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined) return 0; // first view
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_REFRESHES ? n : MAX_REFRESHES;
};
export const isOpen = (p: PortalPayment) => p.status === 'queued' || p.status === 'ready';

export function Refresh({ href, n }: { href: string; n: number }) {
  return n < MAX_REFRESHES ? <meta httpEquiv="refresh" content={`2;url=${href}?n=${n + 1}`} /> : null;
}

/** The outcome of a finished (or failed) request, shared by both pages. Never shows the gateway's own claim. */
export function Finished({ p, back }: { p: PortalPayment; back: React.ReactNode }) {
  if (p.status === 'completed') return <Card><p role="status">Payment received. Thank you.</p>{back}</Card>;
  if (p.status === 'failed' && p.failure_code === 'gateway_not_available') {
    return <Card><p role="status">Online payment is not available right now. {COUNTER_COPY}</p>{back}</Card>;
  }
  if (p.status === 'failed' && p.failure_code === 'nothing_due') return <Card><p role="status">Nothing is due on this report.</p>{back}</Card>;
  return <Card><p role="status">The payment was not completed.</p>{back}</Card>;
}
