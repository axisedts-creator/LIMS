// In-memory GoTrueGateway for service tests. Passes the shared contract suite (__tests__/contract.suite.ts).
// Access tokens are unsigned JWT-shaped strings (claims sub, session_id, aal, role, aud, iat, exp). TOTP uses the real clock;
// link TTL (3600 s) and the refresh reuse interval (10 s) use the fake clock moved by advanceTime().
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { GoTrueError, type GoTrueGateway, type GoTrueTokens } from './gateway.js';

const LINK_TTL_S = 3600;        // GOTRUE_MAILER_OTP_EXP
const REUSE_INTERVAL_S = 10;    // GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL
const PASSWORD_MIN = 12;        // GOTRUE_PASSWORD_MIN_LENGTH
const JWT_EXP_S = 3600;         // GOTRUE_JWT_EXP
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

interface User { id: string; email: string; confirmed: boolean; passwordHash?: string; salt: string; factors: Factor[] }
interface Factor { id: string; secret: string; status: 'verified' | 'unverified'; friendlyName?: string }
interface Session { id: string; userId: string; aal: 'aal1' | 'aal2'; current: string }
interface Refresh { sessionId: string; parent?: string; revokedAt?: number }
interface Mail { email: string; type: 'invite' | 'recovery'; hash: string; at: number; used: boolean }

export interface FakeGoTrueGateway extends GoTrueGateway {
  readonly mailbox: { latestTokenHash(email: string, type: 'invite' | 'recovery'): string | undefined };
  advanceTime(seconds: number): void;
  readonly calls: ReadonlyArray<{ method: string }>;
  passwordHash(userId: string): string | undefined;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function b32(buf: Buffer): string {
  let bits = 0; let v = 0; let out = '';
  for (const byte of buf) { v = (v << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  return bits > 0 ? out + B32[(v << (5 - bits)) & 31] : out;
}
function b32decode(s: string): Buffer {
  let bits = 0; let v = 0; const out: number[] = [];
  for (const ch of s) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function totpAt(secret: string, counter: number): string {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).padStart(6, '0');
}

export function createFakeGoTrueGateway(): FakeGoTrueGateway {
  let offset = 0;
  const now = () => Math.floor(Date.now() / 1000) + offset;
  const users = new Map<string, User>();
  const sessions = new Map<string, Session>();
  const refreshTokens = new Map<string, Refresh>();
  const mails: Mail[] = [];
  const calls: Array<{ method: string }> = [];

  const byEmail = (email: string) => [...users.values()].find((u) => u.email === email.trim().toLowerCase());
  const hashPw = (u: User, pw: string) => `$2a$10$${createHash('sha256').update(u.salt + pw).digest('base64url')}`;
  const reject = (method: string, status: number, code: string): never => { throw new GoTrueError(method, status, code); };

  function issue(s: Session, parent?: string): GoTrueTokens {
    const rt = randomBytes(12).toString('base64url');
    refreshTokens.set(rt, { sessionId: s.id, ...(parent ? { parent } : {}) }); s.current = rt;
    const iat = now(); const exp = iat + JWT_EXP_S;
    const accessToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: s.userId, session_id: s.id, aal: s.aal, role: 'authenticated', aud: 'authenticated', iat, exp, jti: randomUUID() })}.fake`;
    return { accessToken, refreshToken: rt, expiresAt: exp, sessionId: s.id, userId: s.userId, aal: s.aal };
  }
  function newSession(userId: string): GoTrueTokens {
    const s: Session = { id: randomUUID(), userId, aal: 'aal1', current: '' };
    sessions.set(s.id, s);
    return issue(s);
  }
  function endSessions(pred: (s: Session) => boolean): void {
    for (const s of [...sessions.values()]) if (pred(s)) sessions.delete(s.id);
  }
  /** Access token -> live session + user, or GoTrue's 403. */
  function auth(method: string, token: string): { s: Session; u: User } {
    let c: Record<string, unknown> | undefined;
    try { c = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; } catch { c = undefined; }
    if (!c || typeof c['session_id'] !== 'string' || typeof c['exp'] !== 'number') return reject(method, 403, 'bad_jwt');
    if ((c['exp'] as number) < now()) return reject(method, 403, 'bad_jwt');
    const s = sessions.get(c['session_id']);
    const u = s && users.get(s.userId);
    if (!s || !u) return reject(method, 403, 'session_not_found');
    return { s, u };
  }
  function send(email: string, type: Mail['type']): void {
    mails.push({ email: email.trim().toLowerCase(), type, hash: randomBytes(28).toString('hex'), at: now(), used: false });
  }

  const gw: GoTrueGateway = {
    async signInWithPassword(email, password) {
      const u = byEmail(email);
      if (!u || !u.confirmed || !u.passwordHash || u.passwordHash !== hashPw(u, password)) return { ok: false };
      return { ok: true, tokens: newSession(u.id) };
    },

    async refresh(refreshToken) {
      const t = refreshTokens.get(refreshToken);
      if (!t) return { ok: false, reason: 'invalid' };
      const s = sessions.get(t.sessionId);
      if (!s) return { ok: false, reason: 'revoked' };
      if (t.revokedAt !== undefined) {
        // Like v2.197.0: inside the reuse interval, or when this is the parent of the active token, rotate from the active token.
        const active = refreshTokens.get(s.current);
        if (now() - t.revokedAt <= REUSE_INTERVAL_S || active?.parent === refreshToken) {
          if (active) active.revokedAt ??= now();
          return { ok: true, tokens: issue(s, s.current) };
        }
        sessions.delete(s.id);                                         // older token reused: fake kills the family (stricter than GoTrue, allowed by T1-ruling 6)
        return { ok: false, reason: 'reused' };
      }
      t.revokedAt = now();
      return { ok: true, tokens: issue(s, refreshToken) };
    },

    async signOut(accessToken, scope) {
      let a: { s: Session; u: User };
      try { a = auth('signOut', accessToken); } catch (e) { if (e instanceof GoTrueError && e.errorCode === 'session_not_found') return; throw e; }
      endSessions(scope === 'local' ? (s) => s.id === a.s.id : (s) => s.userId === a.u.id);
    },

    async adminCreateUser({ email, emailConfirm }) {
      if (!EMAIL.test(email.trim())) return reject('adminCreateUser', 400, 'validation_failed');
      const existing = byEmail(email);
      if (existing) return { exists: true, userId: existing.id };
      const u: User = { id: randomUUID(), email: email.trim().toLowerCase(), confirmed: emailConfirm, salt: randomBytes(8).toString('hex'), factors: [] };
      users.set(u.id, u);
      return { userId: u.id };
    },

    async adminUpdatePassword(userId, password) {
      const u = users.get(userId) ?? reject('adminUpdatePassword', 404, 'user_not_found');
      if (password.length < PASSWORD_MIN) reject('adminUpdatePassword', 422, 'weak_password');
      u.passwordHash = hashPw(u, password);
    },

    async adminSignOutUser(userId) {
      if (!users.has(userId)) reject('adminSignOutUser', 404, 'user_not_found');
      endSessions((s) => s.userId === userId);
    },

    async adminFindUserByEmail(email) {
      const u = byEmail(email);
      return u ? { userId: u.id } : null;
    },

    async adminDeleteFactor(userId, factorId) {
      const u = users.get(userId) ?? reject('adminDeleteFactor', 404, 'user_not_found');
      const i = u.factors.findIndex((f) => f.id === factorId);
      if (i < 0) reject('adminDeleteFactor', 404, 'mfa_factor_not_found');
      u.factors.splice(i, 1);
    },

    async sendInvite(email, _redirectPath) {
      if (!EMAIL.test(email.trim())) reject('sendInvite', 400, 'validation_failed');
      if (byEmail(email)) reject('sendInvite', 422, 'email_exists');
      const u: User = { id: randomUUID(), email: email.trim().toLowerCase(), confirmed: false, salt: randomBytes(8).toString('hex'), factors: [] };
      users.set(u.id, u);
      send(email, 'invite');
    },

    async sendRecovery(email, _redirectPath) {
      if (byEmail(email)) send(email, 'recovery');                    // unknown e-mail: silent, nothing sent
    },

    async verifyEmailToken(tokenHash, type) {
      const m = tokenHash ? mails.find((x) => x.hash === tokenHash && x.type === type) : undefined;
      if (!m || m.used || now() - m.at > LINK_TTL_S) return { ok: false };
      const u = byEmail(m.email);
      if (!u) return { ok: false };
      m.used = true; u.confirmed = true;
      return { ok: true, tokens: newSession(u.id) };
    },

    async mfaEnrollTotp(accessToken, friendlyName) {
      const { u } = auth('mfaEnrollTotp', accessToken);
      const f: Factor = { id: randomUUID(), secret: b32(randomBytes(20)), status: 'unverified', ...(friendlyName ? { friendlyName } : {}) };
      u.factors.push(f);
      return { factorId: f.id, secret: f.secret, otpauthUri: `otpauth://totp/LIMS:${encodeURIComponent(u.email)}?secret=${f.secret}&issuer=LIMS` };
    },

    async mfaChallengeAndVerify(accessToken, factorId, code) {
      const { s, u } = auth('mfaChallengeAndVerify', accessToken);
      const f = u.factors.find((x) => x.id === factorId);
      if (!f) return { ok: false };
      const step = Math.floor(Date.now() / 1000 / 30);
      if (![step - 1, step, step + 1].some((c) => totpAt(f.secret, c) === code)) return { ok: false };
      f.status = 'verified'; s.aal = 'aal2';
      return { ok: true, tokens: issue(s) };
    },

    async mfaListFactors(accessToken) {
      const { u } = auth('mfaListFactors', accessToken);
      return u.factors.map((f) => ({ factorId: f.id, type: 'totp' as const, status: f.status, ...(f.friendlyName ? { friendlyName: f.friendlyName } : {}) }));
    },
  };

  // Every gateway method is recorded by name before it runs (AU-T2/AU-T4 "GoTrue never called" assertions).
  const recorded = Object.fromEntries(
    Object.entries(gw).map(([name, fn]) => [name, (...args: unknown[]) => { calls.push({ method: name }); return (fn as (...a: unknown[]) => unknown)(...args); }]),
  ) as unknown as GoTrueGateway;

  return Object.assign(recorded, {
    mailbox: { latestTokenHash: (email: string, type: Mail['type']) => mails.filter((m) => m.email === email.trim().toLowerCase() && m.type === type).at(-1)?.hash },
    advanceTime: (seconds: number) => { offset += seconds; },
    calls,
    passwordHash: (userId: string) => users.get(userId)?.passwordHash,
  });
}
