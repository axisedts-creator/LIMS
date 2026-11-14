// P30 launch page (TRD §7.2.3): one POST form to the eSewa form URL with the signed hidden fields and a visible button. No JavaScript.
// CSP allows only form-action to the eSewa origin; Referrer-Policy no-referrer keeps the path token out of the eSewa Referer.
import { PUBLIC_HEADERS } from './resultPage.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderLaunchPage(action: { url: string; fields: Readonly<Record<string, string>> }): { status: 200; headers: Record<string, string>; body: string } {
  const inputs = Object.entries(action.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return {
    status: 200,
    headers: { ...PUBLIC_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; form-action ${new URL(action.url).origin}; style-src 'unsafe-inline'` },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Payment</title><style>body{font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}</style></head>`
      + `<body><p>You will now be sent to eSewa to complete your payment.</p><form method="post" action="${esc(action.url)}">${inputs}<button type="submit">Continue to eSewa</button></form></body></html>`,
  };
}
