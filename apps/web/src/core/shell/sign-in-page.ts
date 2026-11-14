// Minimal static sign-in prompt served by middleware with 401 when there is no valid session (AC-0D-7.2).
// No scripts, no remote assets. C2 owns the real login pages under /auth/… (01-CHUNK-MAP §3).
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function signInPageHtml(reason: 'expired' | 'missing'): string {
  const title = reason === 'expired' ? 'Session expired' : 'Sign in required';
  const text = reason === 'expired'
    ? 'Your session expired because of inactivity. Please sign in again.'
    : 'Please sign in to continue.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>`
    + `<body><main data-testid="sign-in-prompt"><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/auth/">Sign in</a></p></main></body></html>`;
}
