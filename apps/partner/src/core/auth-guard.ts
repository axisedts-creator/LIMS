import 'server-only';
// Guard for every (app) route (03-APP-FLOW §6, US-03.5, US-02.7). Only an `active` partner session gets the access token;
// every other state is routed to its auth page, so no data page renders before MFA / TOTP enrolment / password setup.
import { redirect } from 'next/navigation';
import { resolvePartnerSession, shouldTouch, type PartnerSession } from './session';

export const LOGIN_SESSION_ENDED = '/auth/login?reason=session';
const STATE_ROUTE: Record<string, string> = {
  mfa_pending: '/auth/mfa',
  mfa_enrolment_required: '/auth/mfa/enrol',
  password_setup: '/auth/set-password',
};

export async function requirePartnerSession(): Promise<{ session: PartnerSession; accessToken: string }> {
  const r = await resolvePartnerSession({ touch: await shouldTouch() });
  if (!r.ok) {
    if (r.problem.code === 'auth.unauthenticated') redirect('/auth/login');
    if (r.status === 401) redirect(LOGIN_SESSION_ENDED);
    throw new Error(`partner session unavailable: ${r.problem.code}`); // 5xx must not look like a sign-out
  }
  const { session, accessToken } = r;
  if (session.kind !== 'partner') redirect(LOGIN_SESSION_ENDED); // AB13: staff session replayed through the partner BFF
  const to = STATE_ROUTE[session.state];
  if (to) redirect(to);
  if (session.state !== 'active') redirect(LOGIN_SESSION_ENDED);
  return { session, accessToken };
}
