import 'server-only';
// Portal session cookie __Host-lims_portal (02-TRD §3.5): the API session token lives only here,
// HttpOnly, never in JS-reachable state (REQ-SEC-068). The OTP challenge id rides in a second short cookie.
import { cookies } from 'next/headers';

const SESSION = '__Host-lims_portal';
const CHALLENGE = '__Host-lims_portal_ch';
const base = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

export async function getSession(): Promise<string | undefined> {
  return (await cookies()).get(SESSION)?.value || undefined;
}
export async function setSession(sessionToken: string, absoluteExpiresAt: string): Promise<void> {
  (await cookies()).set(SESSION, sessionToken, { ...base, expires: new Date(absoluteExpiresAt) });
}
export async function clearSession(): Promise<void> {
  (await cookies()).set(SESSION, '', { ...base, maxAge: 0 });
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
