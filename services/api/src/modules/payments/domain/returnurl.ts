// C15 return-URL allowlist (TRD §6.1 step 1, §9.1 RETURN_URL_ALLOWLIST; 07-SECURITY AB-11, ST-17). Fail closed; never echo the URL.
import { LimsError } from '../../../core/errors.js';

const MAX_LEN = 2000;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/; // no whitespace/control chars (URL parser would silently strip them) or non-ASCII

function parseHttps(s: string): URL | undefined {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

/** Entry path is a prefix on a segment boundary: `/a/b` matches `/a/b` and `/a/b/c`, not `/a/bc`; `/` matches all. */
const pathMatches = (entry: string, path: string): boolean =>
  path === entry || path.startsWith(entry.endsWith('/') ? entry : `${entry}/`);

export function assertReturnUrlAllowed(url: string, allowlist: readonly string[]): void {
  const u = typeof url === 'string' && url.length <= MAX_LEN && PRINTABLE_ASCII.test(url) && !url.includes('#') ? parseHttps(url) : undefined;
  const ok =
    u !== undefined && u.username === '' && u.password === '' &&
    allowlist.some((e) => {
      const a = typeof e === 'string' ? parseHttps(e) : undefined;
      return a !== undefined && a.origin === u.origin && pathMatches(a.pathname, u.pathname);
    });
  if (!ok) throw new LimsError('payments.return_url_not_allowed');
}
