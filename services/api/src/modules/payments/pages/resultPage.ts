// P34 static result page (TRD §7.5) + the security headers shared by every public payments response (TRD §5.2, REQ-SEC-099).
// Fixed English text per outcome; nothing from the request is ever rendered (no amounts, names, ids).
export const OUTCOMES = ['settled', 'pending', 'failed', 'unknown'] as const;
export type Outcome = (typeof OUTCOMES)[number];

const MESSAGES: Readonly<Record<Outcome, string>> = {
  settled: 'Payment received. You can close this page.',
  pending: 'We are confirming your payment with the payment provider. You can close this page; the lab will see the result.',
  failed: 'The payment was not completed. No money was taken by this attempt. Please ask the lab for another way to pay.',
  unknown: 'We could not find this payment. Please contact the lab.',
};

export const PUBLIC_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

export const isOutcome = (v: unknown): v is Outcome => typeof v === 'string' && (OUTCOMES as readonly string[]).includes(v);

const STYLE = 'body{font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}';

export function renderResultPage(outcome: unknown): { status: 200; headers: Record<string, string>; body: string } {
  const message = MESSAGES[isOutcome(outcome) ? outcome : 'unknown']; // an unlisted value is never reflected
  return {
    status: 200,
    headers: { ...PUBLIC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Payment</title><style>${STYLE}</style></head><body><p>${message}</p></body></html>`,
  };
}
