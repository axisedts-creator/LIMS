// HTTP GoTrueGateway for the pinned self-hosted GoTrue (v2.197.0). Paths/fields: ./mapping.md (verified live, T1).
// The service-role key lives only here (CR-C2-014, REQ-SEC-029/030) and is sent only on /admin/* and /invite.
// 3 s timeout per call; refresh gets 1 retry after 200 ms on a network error; 5 consecutive outages open a 30 s circuit (02-TRD §8).
import { LimsError } from '../../../core/errors.js';
import { GoTrueError, type GoTrueGateway, type GoTrueTokens } from './gateway.js';
import { idMetrics } from '../metrics.js';

export interface HttpGoTrueGatewayOptions {
  url: string;          // LIMS_IDENTITY_GOTRUE_URL (internal API-network URL)
  serviceKey: string;   // LIMS_IDENTITY_GOTRUE_SERVICE_KEY
  fetch?: typeof fetch;
  timeoutMs?: number;   // default 3000
}

const FAILS_TO_OPEN = 5;
const OPEN_MS = 30_000;
const RETRY_DELAY_MS = 200;

interface Res { status: number; body: Record<string, unknown> }
type Auth = { admin: true } | { bearer: string } | null;

const unavailable = () => new LimsError('common.dependency_unavailable');
const codeOf = (b: Record<string, unknown>): string => {
  const c = b['error_code'];
  return typeof c === 'string' && /^[a-z0-9_]{1,64}$/.test(c) ? c : 'unknown';
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function claimsOf(jwt: string): Record<string, unknown> | undefined {
  const p = jwt.split('.');
  if (p.length !== 3) return undefined;
  try { return JSON.parse(Buffer.from(p[1]!, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return undefined; }
}

/** Token response -> GoTrueTokens. A token without sub/session_id (08 R10.6) is a contract break, never returned. */
function toTokens(method: string, b: Record<string, unknown>): GoTrueTokens {
  const access = b['access_token']; const refresh = b['refresh_token'];
  const c = typeof access === 'string' ? claimsOf(access) : undefined;
  const sub = c?.['sub']; const sid = c?.['session_id']; const exp = c?.['exp'];
  if (typeof access !== 'string' || typeof refresh !== 'string' || !c || typeof sub !== 'string' || !UUID.test(sub)
    || typeof sid !== 'string' || !UUID.test(sid) || typeof exp !== 'number') throw new GoTrueError(method, 200, 'malformed_token_response');
  return { accessToken: access, refreshToken: refresh, expiresAt: exp, sessionId: sid, userId: sub, aal: c['aal'] === 'aal2' ? 'aal2' : 'aal1' };
}

/** The only reader of the service-key env var (CR-C2-014; CI job identity-service-key-grep). Every runtime caller builds its gateway here. */
export function gotrueGatewayFromEnv(): GoTrueGateway {
  return createHttpGoTrueGateway({
    url: process.env['LIMS_IDENTITY_GOTRUE_URL'] ?? '', serviceKey: process.env['LIMS_IDENTITY_GOTRUE_SERVICE_KEY'] ?? '',
  });
}

export function createHttpGoTrueGateway(opts: HttpGoTrueGatewayOptions): GoTrueGateway {
  const base = String(opts.url ?? '').replace(/\/+$/, '');   // validated by config at boot; tolerant here so env-gated suites can collect
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;
  let fails = 0; let openUntil = 0;

  const outage = (): never => { if (++fails >= FAILS_TO_OPEN) openUntil = Date.now() + OPEN_MS; throw unavailable(); };

  async function attempt(method: string, path: string, auth: Auth, body?: unknown): Promise<Res | 'network'> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && 'admin' in auth) headers['authorization'] = `Bearer ${opts.serviceKey}`;
    else if (auth) headers['authorization'] = `Bearer ${auth.bearer}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await doFetch(base + path, { method, headers, body: body === undefined ? null : JSON.stringify(body), signal: ctl.signal });
      const text = await r.text();
      let parsed: unknown = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
      return { status: r.status, body: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} };
    } catch {
      return 'network';            // includes timeout abort; the cause is dropped on purpose (may echo request data)
    } finally { clearTimeout(timer); }
  }

  /** One logical call: circuit check, optional single retry on network error, 5xx/network = outage, else the response. */
  async function call(method: string, path: string, auth: Auth, body?: unknown, retry = false): Promise<Res> {
    if (Date.now() < openUntil) throw unavailable();
    let r = await attempt(method, path, auth, body);
    if (r === 'network' && retry) {
      await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
      r = await attempt(method, path, auth, body);
    }
    if (r === 'network' || r.status >= 500) return outage();
    fails = 0;
    return r;
  }

  const ok2xx = (r: Res) => r.status >= 200 && r.status < 300;
  const fail = (op: string, r: Res): never => { throw new GoTrueError(op, r.status, codeOf(r.body)); };
  const admin = { admin: true } as const;
  const user = (t: string) => ({ bearer: t });

  async function getUser(op: string, userId: string): Promise<Record<string, unknown>> {
    const r = await call('GET', `/admin/users/${encodeURIComponent(userId)}`, admin);
    return ok2xx(r) ? r.body : fail(op, r);
  }

  const gw: GoTrueGateway = {
    async signInWithPassword(email, password) {
      const r = await call('POST', '/token?grant_type=password', null, { email, password });
      return ok2xx(r) ? { ok: true, tokens: toTokens('signInWithPassword', r.body) } : { ok: false };
    },

    async refresh(refreshToken) {
      const r = await call('POST', '/token?grant_type=refresh_token', null, { refresh_token: refreshToken }, true);
      if (ok2xx(r)) return { ok: true, tokens: toTokens('refresh', r.body) };
      const code = codeOf(r.body);
      if (code === 'refresh_token_already_used') return { ok: false, reason: 'reused' };
      if (code === 'session_not_found' || code === 'session_expired' || code === 'user_banned' || code === 'user_not_found') return { ok: false, reason: 'revoked' };
      return { ok: false, reason: 'invalid' };
    },

    async signOut(accessToken, scope) {
      const r = await call('POST', `/logout?scope=${scope}`, user(accessToken));
      if (ok2xx(r) || codeOf(r.body) === 'session_not_found') return;   // already gone = done (02-TRD §9 idempotent worker)
      fail('signOut', r);
    },

    async adminCreateUser({ email, emailConfirm }) {
      const r = await call('POST', '/admin/users', admin, { email, email_confirm: emailConfirm });
      if (ok2xx(r) && typeof r.body['id'] === 'string') return { userId: r.body['id'] };
      if (r.status === 422 && codeOf(r.body) === 'email_exists') {
        const found = await gw.adminFindUserByEmail(email);
        if (found) return { exists: true, userId: found.userId };
      }
      return fail('adminCreateUser', r);
    },

    async adminUpdatePassword(userId, password) {
      const r = await call('PUT', `/admin/users/${encodeURIComponent(userId)}`, admin, { password });
      if (!ok2xx(r)) fail('adminUpdatePassword', r);
    },

    // ponytail: v2.197.0 has no admin "sign out user" route (mapping.md ADMIN_SIGNOUT). Workaround: admin magic-link hash ->
    // /verify -> /logout?scope=global (models.Logout = every session of the user). Side effect: overwrites a pending recovery
    // link (magiclink reuses recovery_token). Replace when GoTrue ships an admin session-revoke endpoint.
    async adminSignOutUser(userId) {
      const u = await getUser('adminSignOutUser', userId);
      if (u['last_sign_in_at'] == null || typeof u['email'] !== 'string' || !u['email']) return;   // never signed in = no sessions
      const link = await call('POST', '/admin/generate_link', admin, { type: 'magiclink', email: u['email'] });
      const hash = link.body['hashed_token'];
      if (!ok2xx(link) || typeof hash !== 'string') return fail('adminSignOutUser', link);
      const v = await call('POST', '/verify', null, { type: 'magiclink', token_hash: hash });
      if (!ok2xx(v)) return fail('adminSignOutUser', v);
      const t = toTokens('adminSignOutUser', v.body);
      if (t.userId !== userId) throw new GoTrueError('adminSignOutUser', 200, 'user_mismatch');
      const out = await call('POST', '/logout?scope=global', user(t.accessToken));
      if (!ok2xx(out)) fail('adminSignOutUser', out);
    },

    async adminFindUserByEmail(email) {
      const want = email.trim().toLowerCase();
      const perPage = 100;
      // `filter` is a case-sensitive substring match on the stored (lower-case) e-mail; exact match is checked here.
      for (let page = 1; ; page++) {
        const r = await call('GET', `/admin/users?filter=${encodeURIComponent(want)}&page=${page}&per_page=${perPage}`, admin);
        if (!ok2xx(r)) return fail('adminFindUserByEmail', r);
        const users = Array.isArray(r.body['users']) ? (r.body['users'] as Array<Record<string, unknown>>) : [];
        const hit = users.find((x) => typeof x['email'] === 'string' && x['email'].toLowerCase() === want && typeof x['id'] === 'string');
        if (hit) return { userId: hit['id'] as string };
        if (users.length < perPage) return null;
      }
    },

    async adminDeleteFactor(userId, factorId) {
      const r = await call('DELETE', `/admin/users/${encodeURIComponent(userId)}/factors/${encodeURIComponent(factorId)}`, admin);
      if (!ok2xx(r)) fail('adminDeleteFactor', r);
    },

    // redirectPath: the link is built by the C1 mail template ({{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=…);
    // nothing is sent as redirect_to so no caller-chosen URL reaches the mail.
    async sendInvite(email, _redirectPath) {
      const r = await call('POST', '/invite', admin, { email });
      if (!ok2xx(r)) fail('sendInvite', r);
    },

    async sendRecovery(email, _redirectPath) {
      const r = await call('POST', '/recover', null, { email });   // unknown e-mail: 200, nothing sent
      if (!ok2xx(r)) fail('sendRecovery', r);
    },

    async verifyEmailToken(tokenHash, type) {
      if (!tokenHash) return { ok: false };
      const r = await call('POST', '/verify', null, { type, token_hash: tokenHash });
      return ok2xx(r) ? { ok: true, tokens: toTokens('verifyEmailToken', r.body) } : { ok: false };
    },

    async mfaEnrollTotp(accessToken, friendlyName) {
      const body: Record<string, string> = { factor_type: 'totp' };
      if (friendlyName !== undefined) body['friendly_name'] = friendlyName;
      const r = await call('POST', '/factors', user(accessToken), body);
      const totp = r.body['totp'] as Record<string, unknown> | undefined;
      if (!ok2xx(r) || typeof r.body['id'] !== 'string' || typeof totp?.['secret'] !== 'string' || typeof totp['uri'] !== 'string') return fail('mfaEnrollTotp', r);
      const qr = totp['qr_code'];
      return { factorId: r.body['id'], otpauthUri: totp['uri'], secret: totp['secret'], ...(typeof qr === 'string' ? { qrSvg: qr } : {}) };
    },

    async mfaChallengeAndVerify(accessToken, factorId, code) {
      const f = encodeURIComponent(factorId);
      const ch = await call('POST', `/factors/${f}/challenge`, user(accessToken), {});
      if (!ok2xx(ch) || typeof ch.body['id'] !== 'string') return { ok: false };
      const v = await call('POST', `/factors/${f}/verify`, user(accessToken), { challenge_id: ch.body['id'], code });
      return ok2xx(v) ? { ok: true, tokens: toTokens('mfaChallengeAndVerify', v.body) } : { ok: false };
    },

    async mfaListFactors(accessToken) {
      const r = await call('GET', '/user', user(accessToken));
      if (!ok2xx(r)) return fail('mfaListFactors', r);
      const factors = Array.isArray(r.body['factors']) ? (r.body['factors'] as Array<Record<string, unknown>>) : [];
      return factors
        .filter((x) => x['factor_type'] === 'totp' && typeof x['id'] === 'string')
        .map((x) => ({
          factorId: x['id'] as string, type: 'totp' as const, status: x['status'] === 'verified' ? 'verified' as const : 'unverified' as const,
          ...(typeof x['friendly_name'] === 'string' && x['friendly_name'] ? { friendlyName: x['friendly_name'] } : {}),
        }));
    },
  };
  return metered(gw);
}

/** T28 lims_identity_gotrue_requests_total / _duration_seconds{op, outcome} (02-TRD §13): op = gateway method; outcome ok, rejected
 *  (GoTrue answered no: wrong password / code, 4xx) or error (outage, open circuit, malformed answer) = IdentityGoTrueUnavailable input. */
function metered(gw: GoTrueGateway): GoTrueGateway {
  const out = {} as Record<string, unknown>;
  for (const [op, fn] of Object.entries(gw) as Array<[string, (...a: unknown[]) => Promise<unknown>]>) {
    out[op] = async (...a: unknown[]) => {
      const t0 = performance.now();
      const done = (o: 'ok' | 'rejected' | 'error') => idMetrics.gotrue(undefined, op, o, (performance.now() - t0) / 1000);
      try {
        const r = await fn(...a);
        done(r && typeof r === 'object' && (r as { ok?: unknown }).ok === false ? 'rejected' : 'ok');
        return r;
      } catch (e) {
        done(e instanceof GoTrueError && e.status >= 400 && e.status < 500 ? 'rejected' : 'error');
        throw e;
      }
    };
  }
  return out as unknown as GoTrueGateway;
}
