import 'server-only';

/**
 * CSRF guard for state-changing portal routes (REQ-SEC-091/092). Under Referrer-Policy: no-referrer browsers
 * send `Origin: null` on same-origin form posts; that is accepted only with the browser-set
 * Sec-Fetch-Site: same-origin, which a page cannot forge.
 */
export function originAllowed(req: Request): boolean {
  const portal = process.env.LIMS_ORIGIN_PORTAL;
  if (!portal) return false;
  const origin = req.headers.get('origin');
  if (origin === new URL(portal).origin) return true;
  return origin === 'null' && req.headers.get('sec-fetch-site') === 'same-origin';
}

export const forbidden = () => new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
