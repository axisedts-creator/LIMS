// BffSessionStore (02-TRD §12.1, CR-C0-003 → superseded by CR-C2-009 / 08 R10): shape of the DEV-ONLY in-memory provider.
// In staging/production the BFF holds only the opaque cookie and calls C2 resolveSession (core/session/c2.ts);
// this module refuses to load there, so a refresh token never exists on the BFF side outside dev.
import { randomBytes } from 'node:crypto';
import { expiryReason, sessionLimits } from './policy';
import { problem, type SessionResolver, type ShellSession } from './types';

type IsoUtc = string;
type Uuid = string;

export interface BffSession {
  readonly sessionId: string;             // opaque, 256-bit random
  readonly tenantId: Uuid; readonly membershipId: Uuid; readonly userId: Uuid;
  readonly accessToken: string; readonly accessTokenExp: IsoUtc; readonly refreshToken: string;
  readonly createdAt: IsoUtc; readonly lastSeenAt: IsoUtc;
  readonly idleTimeoutMinutes: number;    // snapshot of tenant setting at login, refreshed on token rotation
  readonly absoluteHours: number;
}
export interface BffSessionStore {
  get(sessionId: string): Promise<BffSession | undefined>;
  touch(sessionId: string, at: IsoUtc): Promise<void>;
  rotateTokens(sessionId: string, tokens: { accessToken: string; accessTokenExp: IsoUtc; refreshToken: string }): Promise<void>;
  destroy(sessionId: string): Promise<void>;
}

/** Dev actor shown by the shell; synthetic. */
export interface DevSessionSeed extends Omit<BffSession, 'sessionId' | 'createdAt' | 'lastSeenAt'> {
  readonly actor: ShellSession['actor'];
}

export function assertDevOnly(env = process.env.LIMS_CORE_ENV) {
  if (env === 'staging' || env === 'production')
    throw new Error(`BffSessionStore dev provider refuses to load when LIMS_CORE_ENV=${env} (08 R10)`);
}

export function createDevBffSessionStore() {
  assertDevOnly();
  const rows = new Map<string, BffSession & { actor: ShellSession['actor'] }>();
  const store = {
    async get(id: string) { return rows.get(id); },
    async touch(id: string, at: IsoUtc) { const r = rows.get(id); if (r) rows.set(id, { ...r, lastSeenAt: at }); },
    async rotateTokens(id: string, t: { accessToken: string; accessTokenExp: IsoUtc; refreshToken: string }) {
      const r = rows.get(id); if (r) rows.set(id, { ...r, ...t });
    },
    async destroy(id: string) { rows.delete(id); },
    /** Dev login hook (C2's dev pages call this); returns the opaque id to put in __Host-lims_sid. */
    create(seed: DevSessionSeed): string {
      const sessionId = randomBytes(32).toString('base64url');
      const now = new Date().toISOString();
      rows.set(sessionId, { ...seed, sessionId, createdAt: now, lastSeenAt: now });
      return sessionId;
    },
  } satisfies BffSessionStore & Record<string, unknown>;
  return store;
}

/** Mimics C2 resolveSession over the dev store: idle/absolute check, touch unless background. */
export function devResolver(store: ReturnType<typeof createDevBffSessionStore>): SessionResolver {
  return {
    async resolve(sid, { touch }) {
      const s = await store.get(sid);
      const now = Date.now();
      if (!s || expiryReason(s, now)) {
        if (s) await store.destroy(sid);
        return { ok: false, status: 401, problem: problem('auth.session_expired', 'Session expired', 401) };
      }
      if (touch) await store.touch(sid, new Date(now).toISOString());
      const lastSeen = touch ? now : Date.parse(s.lastSeenAt);
      const { idleMs, absoluteMs } = sessionLimits(s.idleTimeoutMinutes, s.absoluteHours);
      return {
        ok: true,
        accessToken: s.accessToken,
        session: {
          sessionId: sid, kind: 'tenant_staff', aal: 'aal2',
          idleExpiresAt: new Date(lastSeen + idleMs).toISOString(),
          absoluteExpiresAt: new Date(Date.parse(s.createdAt) + absoluteMs).toISOString(),
          actor: { ...s.actor, membershipId: s.membershipId }, // LD-89
        },
      };
    },
  };
}
