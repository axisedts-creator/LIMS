// Production session path (08 R10, 02-TRD §12.1): forward the opaque __Host-lims_sid cookie to C2 resolveSession
// with the BFF's own X-Lims-Bff-Key. C2 decides idle/absolute expiry and refreshes tokens server-side;
// its 401 auth.session_expired is relayed unchanged.
import { clientContextHeaders } from '../api/client-context';
import { readBffKey } from './bff-key';
import { SESSION_COOKIE } from './cookie';
import { problem, type Problem, type Resolution, type SessionResolver } from './types';

export const RESOLVE_SESSION_PATH = '/v1/identity/auth/session/resolve';
const TIMEOUT_MS = 5_000;

let cachedKey: string | undefined;
function bffKey(): string {
  if (cachedKey) return cachedKey;
  return (cachedKey = readBffKey()); // LD-174
}

const MAX_RETRY_WAIT_MS = 1_000; // T0D-FIX-12 (LD-455): wait at most 1 second
/** Retry-After in seconds (RFC 9110 delta-seconds); an HTTP date, junk or missing waits the cap. */
function retryDelayMs(v: string | null): number {
  const s = v?.trim() ?? '';
  return /^\d+$/.test(s) ? Math.min(Number(s) * 1000, MAX_RETRY_WAIT_MS) : MAX_RETRY_WAIT_MS;
}

const unavailable = () => ({ ok: false, status: 503, problem: problem('common.dependency_unavailable', 'Dependency unavailable', 503) }) as const;

interface C2Resolved {
  access_token: string;
  session: {
    session_id: string; kind: string; state?: string; aal: string; idle_expires_at: string; absolute_expires_at: string;
    actor: { display_name: string; tenant_code: string; roles?: string[]; permissions?: unknown; membership_id?: string };
  };
}

export const c2Resolver: SessionResolver = {
  async resolve(sessionId, { touch }): Promise<Resolution> {
    const origin = process.env.LIMS_ORIGIN_API;
    if (!origin) throw new Error('LIMS_ORIGIN_API is not set');
    const client = await clientContextHeaders(); // LD-296: real client address + browser user agent; {} outside a request scope
    const call = () => fetch(new URL(RESOLVE_SESSION_PATH, origin), {
      method: 'POST',
      headers: {
        ...client,
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Lims-Bff-Key': bffKey(),
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
      },
      body: JSON.stringify({ touch }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let res: Response;
    try {
      res = await call();
      // T0D-FIX-12 (LD-455): a 429 is retried ONCE after Retry-After (capped at 1 s; junk/missing = 1 s), same body and identity.
      // A second 429 is relayed below as the typed problem; the middleware fails the whole request with it (no partial data).
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        await new Promise((r) => setTimeout(r, retryDelayMs(res.headers.get('retry-after'))));
        res = await call();
      }
    } catch {
      // T0D-WAKE-1 (LD-277, RS-07): no answer (timeout / connection failure) = the API is likely waking up; HTTP answers never carry it.
      return { ...unavailable(), waking: true };
    }
    const body = (await res.json().catch(() => undefined)) as unknown;
    if (res.status === 401) {
      const p = body as Problem | undefined;
      // relay C2's problem unchanged; synthesize only if C2 sent no problem body
      return { ok: false, status: 401, problem: p?.code ? p : problem('auth.session_expired', 'Session expired', 401) };
    }
    if (!res.ok) {
      const p = body as Problem | undefined;
      return p?.code && res.status < 500 ? { ok: false, status: res.status, problem: p } : unavailable();
    }
    const r = body as C2Resolved;
    if (!r?.session?.actor || typeof r.access_token !== 'string') return unavailable();
    const s = r.session;
    // LD-222 AUTH-ACTOR-2: the API sends actor.permissions ONLY for an active session; the web never derives a set (no roles mapping, no default).
    // An active staff/platform session without a usable list is an explicit error state (500 common.internal), never [] and never a throw.
    const list = s.actor.permissions;
    const usable = Array.isArray(list) && list.every((c) => typeof c === 'string');
    if (s.state === 'active' && (s.kind === 'tenant_staff' || s.kind === 'platform') && !usable) {
      return { ok: false, status: 500, problem: problem('common.internal', 'Session permissions unavailable', 500) };
    }
    const permissions = s.state === 'active' && usable ? [...(list as string[])] : [];
    return {
      ok: true,
      accessToken: r.access_token,
      session: {
        sessionId: s.session_id, kind: s.kind, aal: s.aal,
        idleExpiresAt: s.idle_expires_at, absoluteExpiresAt: s.absolute_expires_at,
        actor: {
          displayName: s.actor.display_name, tenantCode: s.actor.tenant_code,
          roles: s.actor.roles ?? [], permissions,
          ...(typeof s.actor.membership_id === 'string' ? { membershipId: s.actor.membership_id } : {}), // LD-89
        },
      },
    };
  },
};
