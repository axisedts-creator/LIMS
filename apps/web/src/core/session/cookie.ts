// Session cookie (REQ-SEC-068, 08 R10): opaque id only, never a token. `__Host-` prefix ⇒ Secure, Path=/, no Domain.
export const SESSION_COOKIE = '__Host-lims_sid';

export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const;

/** Reads the opaque session id from a Cookie header; other names (e.g. unprefixed `lims_sid`) are ignored. */
export function readSessionId(cookieHeader: string | null | undefined): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      const v = part.slice(eq + 1).trim();
      return v === '' ? undefined : v;
    }
  }
  return undefined;
}
