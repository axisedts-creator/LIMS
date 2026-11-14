'use server';
// AU-1..AU-7 BFF server actions (02-TRD §12.1, 03-APP-FLOW §3.1/§3.6/§3.7). The browser only ever holds the opaque
// __Host-lims_sid cookie; every call goes server-to-server to /v1/identity/auth/* with X-Lims-Bff-Key (REQ-SEC-068).
// CSRF (Origin / Sec-Fetch-Site) is enforced by core middleware on the server-action POST itself.
import 'server-only';
import { readBffKey } from '@/core/session/bff-key';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, sessionCookieOptions } from '@/core/session/cookie';
import { matchStaffRoute } from '@/core/permissions/routes';
import type { ActionResult } from './messages';

const AUTH = '/v1/identity/auth/';
const TIMEOUT_MS = 5_000;
const CODE_RE = /^[0-9]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

type Fail = { ok: false; code: string; retryAfterSeconds?: number };
type ApiReply = { ok: true; body: any } | Fail;
interface SessionStateBody { state?: string; absolute_expires_at?: string }

const invalid = (): Fail => ({ ok: false, code: 'common.validation_failed' });
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};

let cachedKey: string | undefined;
function bffKey(): string {
  if (cachedKey) return cachedKey;
  return (cachedKey = readBffKey()); // LD-174
}

async function clientIp(): Promise<string | undefined> {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip')?.trim() || undefined;
}

async function readSid(): Promise<string | undefined> {
  const v = (await cookies()).get(SESSION_COOKIE)?.value;
  return v ? v : undefined;
}

/** POST {AUTH}{path}. `sid` (when given) is forwarded as the bffSession cookie. Never throws for HTTP/network failures. */
async function call(path: string, body: unknown, sid?: string): Promise<ApiReply> {
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) throw new Error('LIMS_ORIGIN_API is not set');
  const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', 'X-Lims-Bff-Key': bffKey() };
  const ip = await clientIp();
  if (ip) h['x-forwarded-for'] = ip;
  if (sid) h.cookie = `${SESSION_COOKIE}=${encodeURIComponent(sid)}`;
  let res: Response;
  try {
    res = await fetch(new URL(AUTH + path, origin), {
      method: 'POST', headers: h, body: JSON.stringify(body ?? {}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'common.dependency_unavailable' };
  }
  const json = (await res.json().catch(() => undefined)) as any;
  if (res.ok) return { ok: true, body: json };
  const code = typeof json?.code === 'string' ? json.code : res.status >= 500 ? 'common.dependency_unavailable' : 'common.internal';
  const ra = Number(res.headers.get('retry-after'));
  return { ok: false, code, ...(res.status === 429 && Number.isFinite(ra) && ra > 0 ? { retryAfterSeconds: ra } : {}) };
}

async function setSession(token: string, absoluteExpiresAt: string | undefined) {
  const maxAge = Math.floor((Date.parse(absoluteExpiresAt ?? '') - Date.now()) / 1000);
  (await cookies()).set(SESSION_COOKIE, token, { ...sessionCookieOptions, ...(maxAge > 0 ? { maxAge } : {}) });
}

async function clearSession() {
  (await cookies()).set(SESSION_COOKIE, '', { ...sessionCookieOptions, maxAge: 0 });
}

/** 03-APP-FLOW §3.6: only a known staff route (routes.yaml) is honoured; anything else → '/'. */
function safeNext(raw: string): string {
  if (!/^\/[A-Za-z0-9\-._~/]*$/.test(raw) || raw.startsWith('//') || raw.split('/').some((s) => s === '..' || s === '.')) return '/';
  return matchStaffRoute(raw) ? raw : '/';
}

function routeFor(state: string | undefined, next = '/'): string {
  switch (state) {
    case 'mfa_pending': return '/auth/mfa';
    case 'mfa_enrolment_required': return '/auth/mfa/enrol';
    case 'password_setup': return '/auth/set-password';
    case 'active': return next;
    default: return '/auth/session-expired';
  }
}

/** Cookie-bound call: no cookie → login; 401 auth.session_expired → cookie cleared, AU-7 (or `expiredTo`). */
async function sessionCall(path: string, body: unknown, expiredTo = '/auth/session-expired'): Promise<ApiReply> {
  const sid = await readSid();
  if (!sid) redirect('/auth/login');
  const r = await call(path, body, sid);
  if (!r.ok && r.code === 'auth.session_expired') {
    await clearSession();
    redirect(expiredTo);
  }
  return r;
}

export async function loginStaffAction(fd: FormData): Promise<ActionResult> {
  const email = str(fd, 'email').trim();
  const password = str(fd, 'password');
  if (!email || email.length > 254 || !EMAIL_RE.test(email) || !password || password.length > 128) return invalid();
  const r = await call('login', { email, password });
  if (!r.ok) return r;
  const b = r.body as { session_token?: unknown; session?: SessionStateBody } | undefined;
  if (typeof b?.session_token !== 'string' || !b.session_token) return { ok: false, code: 'common.dependency_unavailable' };
  await setSession(b.session_token, b.session?.absolute_expires_at);
  redirect(routeFor(b.session?.state, safeNext(str(fd, 'next'))));
}

export async function verifyMfaAction(fd: FormData): Promise<ActionResult> {
  const code = str(fd, 'code');
  if (!CODE_RE.test(code)) return invalid();
  // AU-2: after the 5th failure the session is revoked → AU-1 with "Too many incorrect codes" banner.
  const r = await sessionCall('mfa/verify', { code }, '/auth/login?mfa_failed=1');
  if (!r.ok) return r;
  redirect(routeFor((r.body as SessionStateBody | undefined)?.state));
}

export async function startMfaEnrolmentAction(
  fd: FormData,
): Promise<{ ok: true; factor_id: string; otpauth_uri: string; qr_svg_base64?: string; secret_base32: string } | Fail> {
  const name = str(fd, 'friendly_name').trim();
  if (name.length > 40) return invalid();
  const r = await sessionCall('mfa/enrolment', name ? { friendly_name: name } : {});
  if (!r.ok) return r;
  const b = (r.body ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  if (!UUID_RE.test(s('factor_id')) || !s('secret_base32')) return { ok: false, code: 'common.dependency_unavailable' };
  const qr = s('qr_svg_base64'); // optional per 02-TRD §5.1; the key is the fallback
  return { ok: true, factor_id: s('factor_id'), otpauth_uri: s('otpauth_uri'), ...(qr ? { qr_svg_base64: qr } : {}), secret_base32: s('secret_base32') };
}

export async function completeMfaEnrolmentAction(fd: FormData): Promise<ActionResult> {
  const factorId = str(fd, 'factor_id');
  const code = str(fd, 'code');
  if (!UUID_RE.test(factorId) || !CODE_RE.test(code)) return invalid(); // no path injection into the URL below
  const r = await sessionCall(`mfa/enrolment/${factorId}/verify`, { code });
  return r.ok ? { ok: true } : r;
}

export async function requestRecoveryAction(fd: FormData): Promise<ActionResult> {
  const email = str(fd, 'email').trim();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return invalid();
  await call('password/recover', { email }); // AC-A7.1: outcome is never revealed (no existence / throttle oracle)
  return { ok: true };
}

export async function confirmTokenAction(a: { token_hash: string; type: 'recovery' | 'invite' }): Promise<ActionResult> {
  const tokenHash = typeof a?.token_hash === 'string' ? a.token_hash : '';
  const type = a?.type;
  if (!tokenHash || tokenHash.length > 256 || (type !== 'recovery' && type !== 'invite')) return invalid();
  const r = await call('token/confirm', { token_hash: tokenHash, type });
  if (!r.ok) return r;
  const b = r.body as { session_token?: unknown; session?: SessionStateBody } | undefined;
  if (typeof b?.session_token !== 'string' || !b.session_token) return { ok: false, code: 'common.dependency_unavailable' };
  await setSession(b.session_token, b.session?.absolute_expires_at);
  redirect(routeFor(b.session?.state)); // clean URL: the link token never travels further
}

export async function setPasswordAction(fd: FormData): Promise<ActionResult> {
  const pw = str(fd, 'new_password');
  if (pw.length < 12 || pw.length > 128 || pw !== str(fd, 'confirm_password')) return invalid();
  const r = await sessionCall('password/set', { new_password: pw });
  if (!r.ok) return r;
  redirect(routeFor((r.body as SessionStateBody | undefined)?.state));
}

export async function logoutAction(): Promise<void> {
  const sid = await readSid();
  if (sid) await call('logout', {}, sid); // best effort: the cookie is cleared whatever the API says
  await clearSession();
  redirect('/auth/login?logged_out=1');
}
