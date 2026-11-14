'use server';
// PA-1..PA-6 BFF server actions (C13 03-APP-FLOW §6, 04-UI-UX §2; mirrors C2.T12 for the staff BFF). The browser only ever
// holds the opaque __Host-lims_psid cookie; every call goes server-to-server to /v1/identity/auth/* with the partner BFF key
// (identityCall), which binds the session kind to `partner` (08 R10). The session token goes ONLY into the cookie.
import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { checkCsrf } from '@/core/csrf';
import { currentPartnerSessionId, identityCall, PARTNER_SESSION_COOKIE, partnerSessionCookieOptions, type IdentityReply } from '@/core/session';
import { LOGIN_SESSION_ENDED } from '@/core/auth-guard';
import type { ActionResult } from './messages';
import { safeNext } from './safe-next';

const CODE_RE = /^[0-9]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

type Fail = { ok: false; code: string; retryAfterSeconds?: number };
type Failed = Extract<IdentityReply, { ok: false }>;
interface SessionStateBody { state?: string; absolute_expires_at?: string }

const invalid = (): Fail => ({ ok: false, code: 'common.validation_failed' });
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};
/** Only the code (+ Retry-After) leaves the BFF: nothing from the API body that could hint at account existence. */
const fail = (r: Failed): Fail => ({ ok: false, code: r.problem.code, ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : {}) });

async function csrfOk(): Promise<boolean> {
  return checkCsrf({ method: 'POST', headers: await headers() }).ok; // REQ-SEC-091
}
const csrfFailed = (): Fail => ({ ok: false, code: 'auth.csrf_failed' });

async function setSession(token: string, absoluteExpiresAt: string | undefined) {
  const maxAge = Math.floor((Date.parse(absoluteExpiresAt ?? '') - Date.now()) / 1000);
  (await cookies()).set(PARTNER_SESSION_COOKIE, token, { ...partnerSessionCookieOptions, ...(maxAge > 0 ? { maxAge } : {}) });
}
async function clearSession() {
  (await cookies()).set(PARTNER_SESSION_COOKIE, '', { ...partnerSessionCookieOptions, maxAge: 0 });
}

function routeFor(state: string | undefined, next = '/'): string {
  switch (state) {
    case 'mfa_pending': return '/auth/mfa';
    case 'mfa_enrolment_required': return '/auth/mfa/enrol'; // US-02.7
    case 'password_setup': return '/auth/set-password';
    case 'active': return next;
    default: return LOGIN_SESSION_ENDED;
  }
}

/** Cookie-bound call: no cookie -> login; 401 auth.session_expired -> cookie cleared, "session ended" login (US-03.5). */
async function sessionCall(path: string, body: unknown): Promise<IdentityReply> {
  const sid = await currentPartnerSessionId();
  if (!sid) redirect('/auth/login');
  const r = await identityCall(path, body, sid);
  if (!r.ok && r.problem.code === 'auth.session_expired') {
    await clearSession();
    redirect(LOGIN_SESSION_ENDED);
  }
  return r;
}

export async function loginPartnerAction(fd: FormData): Promise<ActionResult> {
  if (!(await csrfOk())) return csrfFailed();
  const email = str(fd, 'email').trim();
  const password = str(fd, 'password');
  if (!email || email.length > 254 || !EMAIL_RE.test(email) || !password || password.length > 128) return invalid();
  const r = await identityCall('/auth/partner/login', { email, password });
  if (!r.ok) return fail(r);
  const b = r.body as { session_token?: unknown; session?: SessionStateBody } | undefined;
  if (typeof b?.session_token !== 'string' || !b.session_token) return { ok: false, code: 'common.dependency_unavailable' };
  await setSession(b.session_token, b.session?.absolute_expires_at);
  redirect(routeFor(b.session?.state, safeNext(str(fd, 'next'))));
}

export async function verifyMfaAction(fd: FormData): Promise<ActionResult> {
  if (!(await csrfOk())) return csrfFailed();
  const code = str(fd, 'code');
  if (!CODE_RE.test(code)) return invalid();
  const r = await sessionCall('/auth/mfa/verify', { code });
  if (r.ok) redirect(routeFor((r.body as SessionStateBody | undefined)?.state));
  if (r.problem.code === 'common.version_conflict') redirect('/'); // session not in mfa_pending: the guard re-routes by state
  return fail(r);
}

export async function startMfaEnrolmentAction(
  fd: FormData,
): Promise<{ ok: true; factor_id: string; otpauth_uri: string; qr_svg_base64?: string; secret_base32: string } | Fail> {
  if (!(await csrfOk())) return csrfFailed();
  const name = str(fd, 'friendly_name').trim();
  if (name.length > 40) return invalid();
  const r = await sessionCall('/auth/mfa/enrolment', name ? { friendly_name: name } : {});
  if (!r.ok) return fail(r);
  const b = (r.body ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  if (!UUID_RE.test(s('factor_id')) || !s('secret_base32')) return { ok: false, code: 'common.dependency_unavailable' };
  const qr = s('qr_svg_base64'); // optional per C2 02-TRD §5.1; the key is the fallback
  return { ok: true, factor_id: s('factor_id'), otpauth_uri: s('otpauth_uri'), ...(qr ? { qr_svg_base64: qr } : {}), secret_base32: s('secret_base32') };
}

export async function completeMfaEnrolmentAction(fd: FormData): Promise<ActionResult> {
  if (!(await csrfOk())) return csrfFailed();
  const factorId = str(fd, 'factor_id');
  const code = str(fd, 'code');
  if (!UUID_RE.test(factorId) || !CODE_RE.test(code)) return invalid(); // no path injection into the URL below
  const r = await sessionCall(`/auth/mfa/enrolment/${factorId}/verify`, { code });
  if (!r.ok) return fail(r);
  redirect(routeFor((r.body as SessionStateBody | undefined)?.state));
}

export async function requestRecoveryAction(fd: FormData): Promise<ActionResult> {
  if (!(await csrfOk())) return csrfFailed();
  const email = str(fd, 'email').trim();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return invalid();
  await identityCall('/auth/password/recover', { email }); // PA-4: outcome is never revealed (no existence / throttle oracle)
  return { ok: true };
}

export async function confirmTokenAction(a: { token_hash: string; type: 'recovery' | 'invite' }): Promise<ActionResult> {
  if (!(await csrfOk())) return csrfFailed();
  const tokenHash = typeof a?.token_hash === 'string' ? a.token_hash : '';
  const type = a?.type;
  if (!tokenHash || tokenHash.length > 256 || (type !== 'recovery' && type !== 'invite')) return invalid();
  const r = await identityCall('/auth/token/confirm', { token_hash: tokenHash, type });
  if (!r.ok) return fail(r);
  const b = r.body as { session_token?: unknown; session?: SessionStateBody } | undefined;
  if (typeof b?.session_token !== 'string' || !b.session_token) return { ok: false, code: 'common.dependency_unavailable' };
  await setSession(b.session_token, b.session?.absolute_expires_at);
  redirect(routeFor(b.session?.state)); // PA-5: clean URL, the link token never travels further
}

export async function setPasswordAction(fd: FormData): Promise<ActionResult> {
  if (!(await csrfOk())) return csrfFailed();
  const pw = str(fd, 'new_password');
  if (pw.length < 12 || pw.length > 128 || pw !== str(fd, 'confirm_password')) return invalid();
  const r = await sessionCall('/auth/password/set', { new_password: pw });
  if (!r.ok) return fail(r);
  redirect(routeFor((r.body as SessionStateBody | undefined)?.state));
}

export async function logoutAction(): Promise<ActionResult> {
  if (!(await csrfOk())) return csrfFailed();
  const sid = await currentPartnerSessionId();
  if (sid) await identityCall('/auth/logout', {}, sid); // best effort: the cookie is cleared whatever the API says
  await clearSession();
  redirect('/auth/login');
}
