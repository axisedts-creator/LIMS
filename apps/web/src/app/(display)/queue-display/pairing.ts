// Display pairing cookie (02-TRD §4.10, 07-SECURITY). Server-only: the token never reaches client code.
// [CONV] __Secure- prefix (a __Host- cookie must have Path=/); Path=/queue-display keeps it off every staff-web path.
import 'server-only';
import { cookies } from 'next/headers';

export const DISPLAY_COOKIE = '__Secure-lims_qdisp';
export const DISPLAY_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Called by the staff pairing action (W7) right after Q8 pairQueueDisplay returns display_token. */
export async function setDisplayCookie(token: string): Promise<void> {
  if (!DISPLAY_TOKEN_RE.test(token)) throw new Error('invalid display token');
  (await cookies()).set(DISPLAY_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/queue-display',
    maxAge: 31_536_000,
  });
}

export async function readDisplayToken(): Promise<string | undefined> {
  const v = (await cookies()).get(DISPLAY_COOKIE)?.value;
  return v && DISPLAY_TOKEN_RE.test(v) ? v : undefined;
}
