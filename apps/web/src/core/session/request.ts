// Middleware → server components hand-off. middleware.ts resolves the session once per request and forwards
// it as INTERNAL request headers (never response headers). Inbound copies are always stripped first, so a
// browser cannot forge them.
import type { ShellSession } from './types';

export const H_SESSION = 'x-lims-internal-session';
export const H_ACCESS_TOKEN = 'x-lims-internal-access-token';
export const H_PATHNAME = 'x-lims-internal-pathname';
export const H_NONCE = 'x-lims-internal-nonce';
/** X-Lims-Background: sent by @lims/ui polling/SSE helpers; BFF maps it to resolveSession touch:false (08 A25 D-206). */
export const BACKGROUND_HEADER = 'x-lims-background';
export const INTERNAL_HEADERS = [H_SESSION, H_ACCESS_TOKEN, H_PATHNAME, H_NONCE] as const;

export const encodeSession = (s: ShellSession) => Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');

export function decodeSession(v: string | null): ShellSession | undefined {
  if (!v) return undefined;
  try { return JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as ShellSession; } catch { return undefined; }
}
