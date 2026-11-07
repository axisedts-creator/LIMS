// Request guard (02-TRD §5.1 "Network", REQ-SEC-086, AC-03.8): every request from a render context is
// intercepted; only data: URLs pass, everything else is aborted and counted.
import type { BrowserContext, Page } from 'playwright';

export const isAllowedUrl = (url: string): boolean => url.startsWith('data:');

/** Installs the guard on a fresh context before any page exists. `onBlocked` feeds lims_renderer_blocked_requests_total. */
export async function guardContext(ctx: BrowserContext, onBlocked: (url: string) => void): Promise<void> {
  await ctx.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    if (isAllowedUrl(url)) return route.continue();
    onBlocked(url);
    // A navigation (meta refresh, link target) answered 204 is cancelled and the rendered document stays;
    // aborting it would replace the page with Chromium's error page.
    if (req.isNavigationRequest()) return route.fulfill({ status: 204 });
    return route.abort('blockedbyclient');
  });
  // WebSockets are not covered by route(); JS is off so none can open, but close them too.
  await ctx.routeWebSocket(/.*/, (ws) => {
    onBlocked(ws.url());
    return ws.close();
  });
}

/** file: subresources never reach route(): Blink refuses them itself and logs this; count them too. */
export function countLocalResourceRefusals(page: Page, onBlocked: (url: string) => void): void {
  page.on('console', (msg) => {
    const m = /^Not allowed to load local resource: (\S+)/.exec(msg.text());
    if (m) onBlocked(m[1]!);
  });
}

/** Chromium flags: no DNS for any host name, no background traffic (defence in depth behind route()). */
export const CHROMIUM_ARGS = ['--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-networking', '--no-pings'];
