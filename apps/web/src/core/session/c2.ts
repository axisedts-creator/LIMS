// Production session path (08 R10, 02-TRD §12.1): forward the opaque __Host-lims_sid cookie to C2 resolveSession
// with the BFF's own X-Lims-Bff-Key. C2 decides idle/absolute expiry and refreshes tokens server-side;
// its 401 auth.session_expired is relayed unchanged.
import { readFileSync } from 'node:fs';
import { SESSION_COOKIE } from './cookie';
import { problem, type Problem, type Resolution, type SessionResolver } from './types';

export const RESOLVE_SESSION_PATH = '/v1/identity/auth/session/resolve';
const TIMEOUT_MS = 5_000;

let cachedKey: string | undefined;
function bffKey(): string {
  if (cachedKey) return cachedKey;
  const file = process.env.LIMS_WEB_BFF_KEY_FILE;
  if (!file) throw new Error('LIMS_WEB_BFF_KEY_FILE is not set');
  const key = readFileSync(file, 'utf8').trim();
  if (!key) throw new Error('LIMS_WEB_BFF_KEY_FILE is empty');
  return (cachedKey = key);
}

const unavailable = () => ({ ok: false, status: 503, problem: problem('common.dependency_unavailable', 'Dependency unavailable', 503) }) as const;

interface C2Resolved {
  access_token: string;
  session: {
    session_id: string; kind: string; aal: string; idle_expires_at: string; absolute_expires_at: string;
    actor: { display_name: string; tenant_code: string; roles?: string[]; permissions?: string[]; membership_id?: string };
  };
}

export const c2Resolver: SessionResolver = {
  async resolve(sessionId, { touch }): Promise<Resolution> {
    const origin = process.env.LIMS_ORIGIN_API;
    if (!origin) throw new Error('LIMS_ORIGIN_API is not set');
    let res: Response;
    try {
      res = await fetch(new URL(RESOLVE_SESSION_PATH, origin), {
        method: 'POST',
        headers: {
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
    } catch {
      return unavailable();
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
    return {
      ok: true,
      accessToken: r.access_token,
      session: {
        sessionId: s.session_id, kind: s.kind, aal: s.aal,
        idleExpiresAt: s.idle_expires_at, absoluteExpiresAt: s.absolute_expires_at,
        actor: {
          displayName: s.actor.display_name, tenantCode: s.actor.tenant_code,
          roles: s.actor.roles ?? [], permissions: Array.isArray(s.actor.permissions) ? s.actor.permissions : [],
          ...(typeof s.actor.membership_id === 'string' ? { membershipId: s.actor.membership_id } : {}), // LD-89
        },
      },
    };
  },
};
