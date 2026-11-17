// identity.gotrue_signout (02-TRD §10 row; 01-PRD AC-A1.3, AC-B4.1; 03-APP-FLOW §2.3, §4.3, §9.2; 08 A38-2).
// Payloads (the C2 enqueuers'): {user_id} platform | {user_id, tenant_id} | {user_id, tenant_id, session_id} | {tenant_id, user_ids<=200, reason}.
// One session -> signOut(token, 'local'); otherwise adminSignOutUser per user. Platform kind never reads a session row.
// GoTrue "already gone" (user_not_found / session_not_found) = success; anything else is rethrown (queue retries, max_attempts 10).
import type { TaskHandler } from '../../../core/manifest.js';
import { openerFromEnv } from '../../../../../api/src/modules/identity/repository/mfa.repo.js';
import type { GoTrueGateway } from '../../../../../api/src/modules/identity/gotrue/gateway.js';
import { coreErrors, gone, gotrue, isUuid, malformed, q, sameTenant, shapeOf } from './shared.js';

export const GOTRUE_SIGNOUT = 'identity.gotrue_signout';
const BATCH_MAX = 200;
const GONE = ['user_not_found', 'session_not_found'];

export interface GotrueSignoutDeps {
  gotrue: Pick<GoTrueGateway, 'adminSignOutUser' | 'signOut'>;
  repo: { sessionAccessToken(tx: unknown, tenantId: string, sessionId: string, userId: string): Promise<string | null> };
}

const SHAPES = {
  platform: ['user_id'], platformStray: ['user_id', 'session_id'],
  user: ['user_id', 'tenant_id'], session: ['user_id', 'tenant_id', 'session_id'], fanout: ['tenant_id', 'user_ids', 'reason'],
} as const;

export function createGotrueSignout(deps: GotrueSignoutDeps): TaskHandler {
  const signOutUser = (id: string) => deps.gotrue.adminSignOutUser(id).catch((e) => { if (!gone(e, GONE)) throw e; });
  return coreErrors(async (payload, ctx) => {
    const s = shapeOf(payload, SHAPES);
    if (!s || !sameTenant(s[1], ctx)) return malformed(GOTRUE_SIGNOUT);
    const [shape, p] = s;
    if (shape === 'fanout') {
      const ids = p['user_ids'];
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > BATCH_MAX || !ids.every(isUuid) || typeof p['reason'] !== 'string') return malformed(GOTRUE_SIGNOUT);
      // every user gets a try; the first failure is rethrown afterwards so the queue retries (already signed-out users are a no-op then)
      let first: unknown;
      for (const id of ids) await signOutUser(id).catch((e) => { first ??= e; });
      if (first !== undefined) throw first;
      return;
    }
    if (!isUuid(p['user_id']) || ('session_id' in p && !isUuid(p['session_id']))) return malformed(GOTRUE_SIGNOUT);
    if (shape !== 'session') return signOutUser(p['user_id']);           // platform kind: always the whole user (stray session_id ignored)
    const token = await deps.repo.sessionAccessToken(ctx.tx, ctx.tenantId!, p['session_id'] as string, p['user_id'] as string);
    if (token === null) return;                                         // row gone: nothing left to sign out
    await deps.gotrue.signOut(token, 'local').catch((e) => { if (!gone(e, GONE)) throw e; });
  });
}

// ---------- default wiring ----------
const TOKEN_SQL = 'SELECT access_token_enc, enc_key_id FROM identity.sessions WHERE tenant_id = $1 AND id = $2 AND user_id = $3';
const open = openerFromEnv();
export const gotrueSignout: TaskHandler = createGotrueSignout({
  gotrue: { adminSignOutUser: (id) => gotrue().adminSignOutUser(id), signOut: (t, sc) => gotrue().signOut(t, sc) },
  repo: {
    sessionAccessToken: async (tx, tenantId, sessionId, userId) => {
      const r = (await q(tx, TOKEN_SQL, [tenantId, sessionId, userId]))[0];
      return r?.['access_token_enc'] && r['enc_key_id'] ? open(r['access_token_enc'] as Buffer, String(r['enc_key_id'])) : null;
    },
  },
});
