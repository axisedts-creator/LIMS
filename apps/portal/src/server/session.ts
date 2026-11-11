import 'server-only';
// Portal session cookie __Host-lims_portal (02-TRD §3.5): the API session token lives only here,
// HttpOnly, never in JS-reachable state (REQ-SEC-068). The OTP challenge id rides in a second short cookie.
import { cookies } from 'next/headers';

const SESSION = '__Host-lims_portal';
const CHALLENGE = '__Host-lims_portal_ch';
const LINK = '__Host-lims_portal_lk';
const base = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

export async function getSession(): Promise<string | undefined> {
  return (await cookies()).get(SESSION)?.value || undefined;
}
export async function setSession(sessionToken: string, absoluteExpiresAt: string, linkToken?: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION, sessionToken, { ...base, expires: new Date(absoluteExpiresAt) });
  // [CONV] the gateway return page /r/payments/{id}/done carries no link token: remember it (same lifetime, HttpOnly) for its "Back to your report" link.
  if (linkToken) jar.set(LINK, linkToken, { ...base, expires: new Date(absoluteExpiresAt) });
}
export async function getLinkToken(): Promise<string | undefined> {
  return (await cookies()).get(LINK)?.value || undefined;
}
export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION, '', { ...base, maxAge: 0 });
  jar.set(LINK, '', { ...base, maxAge: 0 });
}

export async function getChallenge(): Promise<string | undefined> {
  return (await cookies()).get(CHALLENGE)?.value || undefined;
}
export async function setChallenge(challengeId: string): Promise<void> {
  (await cookies()).set(CHALLENGE, challengeId, { ...base, maxAge: 10 * 60 }); // OTP lives 10 minutes
}
export async function clearChallenge(): Promise<void> {
  (await cookies()).set(CHALLENGE, '', { ...base, maxAge: 0 });
}
