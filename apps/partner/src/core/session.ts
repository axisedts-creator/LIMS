import 'server-only';
// Partner BFF session layer (02-TRD §3.6/§3.8, 08 R10). The browser holds only the opaque __Host-lims_psid cookie; the
// session kind is bound by the partner BFF key (X-Lims-Bff-Key from LIMS_PARTNER_BFF_KEY_FILE), never by a client header.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cookies, headers } from 'next/headers';

export const PARTNER_SESSION_COOKIE = '__Host-lims_psid'; // `__Host-` => Secure, Path=/, no Domain
// contracts/openapi/_common.yaml bffSession wire name (server-to-server only; browser cookie stays __Host-lims_psid). C13.T05 review #1.
const BFF_SESSION_COOKIE = '__Host-lims_sid';
export const partnerSessionCookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

const IDENTITY_BASE = '/v1/identity';
const TIMEOUT_MS = 5_000;

export interface Problem { type?: string; title?: string; status?: number; code: string; [k: string]: unknown }
export type ProblemResult = { ok: false; status: number; problem: Problem };
export interface PartnerSession {
  sessionId: string; kind: string; state: string; aal: string; idleExpiresAt: string; absoluteExpiresAt: string;
  actor: { displayName: string; tenantCode: string; roles: string[] };
}

export const problemOf = (code: string, status: number): ProblemResult => ({
  ok: false, status, problem: { type: `urn:lims:error:${code}`, title: code, status, code },
});
const unavailable = () => problemOf('common.dependency_unavailable', 503);

let cachedKey: string | undefined;
export function partnerBffKey(): string {
  if (cachedKey) return cachedKey;
  const file = process.env.LIMS_PARTNER_BFF_KEY_FILE;
  if (!file) throw new Error('LIMS_PARTNER_BFF_KEY_FILE is not set');
  const key = readFileSync(file, 'utf8').trim();
  if (!key) throw new Error('LIMS_PARTNER_BFF_KEY_FILE is empty');
  return (cachedKey = key);
}

export function partnerApiOrigin(): string {
  const o = process.env.LIMS_PARTNER_BFF_API_URL;
  if (!o) throw new Error('LIMS_PARTNER_BFF_API_URL is not set');
  return o;
}

/** Reads the opaque id from a Cookie header; other names (staff `__Host-lims_sid`, unprefixed, look-alikes) are ignored. */
export function readPartnerSessionId(cookieHeader: string | null | undefined): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === PARTNER_SESSION_COOKIE) {
      const v = part.slice(eq + 1).trim();
      return v === '' ? undefined : v;
    }
  }
  return undefined;
}

export async function currentPartnerSessionId(): Promise<string | undefined> {
  return (await cookies()).get(PARTNER_SESSION_COOKIE)?.value || undefined;
}

/** TRD §5.4: background polling must not extend the idle timeout. */
export async function shouldTouch(): Promise<boolean> {
  return (await headers()).get('x-lims-background') !== '1';
}

export type IdentityReply = { ok: true; status: number; body: any } | (ProblemResult & { retryAfterSeconds?: number });

/** POST /v1/identity{path} (path starts with /auth/) as the partner BFF. `sid` is forwarded as the bffSession cookie. Never throws for HTTP/network failures. */
export async function identityCall(path: string, body: unknown, sid?: string): Promise<IdentityReply> {
  const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', 'X-Lims-Bff-Key': partnerBffKey() };
  const fwd = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim();
  if (fwd) h['x-forwarded-for'] = fwd;
  if (sid) h.cookie = `${BFF_SESSION_COOKIE}=${encodeURIComponent(sid)}`;
  let res: Response;
  try {
    res = await fetch(new URL(IDENTITY_BASE + path, partnerApiOrigin()), {
      method: 'POST', headers: h, body: JSON.stringify(body ?? {}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return unavailable();
  }
  const json = (await res.json().catch(() => undefined)) as any;
  if (res.ok) return { ok: true, status: res.status, body: json };
  const code = typeof json?.code === 'string' ? json.code : res.status >= 500 ? 'common.dependency_unavailable' : 'common.internal';
  const ra = Number(res.headers.get('retry-after'));
  return { ...problemOf(code, res.status), ...(res.status === 429 && Number.isFinite(ra) && ra > 0 ? { retryAfterSeconds: ra } : {}) };
}

export type Resolution = { ok: true; session: PartnerSession; accessToken: string } | ProblemResult;

// ponytail: no in-process cache (LIMS_PARTNER_BFF_SESSION_CACHE_SECONDS unused); add one when resolve latency shows up.
export async function resolvePartnerSession({ touch }: { touch: boolean }): Promise<Resolution> {
  const sid = await currentPartnerSessionId();
  if (!sid) return problemOf('auth.unauthenticated', 401);
  let res: Response;
  try {
    res = await fetch(new URL(`${IDENTITY_BASE}/auth/session/resolve`, partnerApiOrigin()), {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json', 'X-Lims-Bff-Key': partnerBffKey(),
        cookie: `${BFF_SESSION_COOKIE}=${encodeURIComponent(sid)}`,
      },
      body: JSON.stringify({ touch }), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return unavailable();
  }
  const body = (await res.json().catch(() => undefined)) as any;
  if (res.status === 401) return body?.code ? { ok: false, status: 401, problem: body } : problemOf('auth.session_expired', 401);
  if (!res.ok) return body?.code && res.status < 500 ? { ok: false, status: res.status, problem: body } : unavailable();
  const s = body?.session;
  if (!s?.actor || typeof body.access_token !== 'string') return unavailable();
  return {
    ok: true,
    accessToken: body.access_token,
    session: {
      sessionId: s.session_id, kind: s.kind, state: s.state, aal: s.aal, idleExpiresAt: s.idle_expires_at, absoluteExpiresAt: s.absolute_expires_at,
      actor: { displayName: s.actor.display_name, tenantCode: s.actor.tenant_code, roles: s.actor.roles ?? [] },
    },
  };
}

/** Opaque 64-bit-ish hex for tracing ids. */
export const hex = (bytes: number) => randomBytes(bytes).toString('hex');
