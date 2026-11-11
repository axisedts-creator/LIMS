// identity.send_invitation (02-TRD §10 row; 05-SCHEMA §4.4 identity.invitations; 03-APP-FLOW §2.2).
// Payload {tenant_id, invitation_id} | {invitation_id} (platform staff). Sends only a live 'pending' invitation with an e-mail; anything
// else is a no-op (idempotent per invitation; a resend is a new row). GoTrue 4xx (not 429) = permanent -> row 'failed' + resolve;
// outage / 429 / 5xx rethrown (queue retries, max_attempts 8, then dead letter). The e-mail is never logged.
import type { TaskHandler } from '../../../core/manifest.js';
import type { GoTrueGateway } from '../../../../../api/src/modules/identity/gotrue/gateway.js';
import { coreErrors, gotrue, isUuid, malformed, permanent, platformUnwired, q, sameTenant, shapeOf } from './shared.js';

export const SEND_INVITATION = 'identity.send_invitation';

export interface InvitationRow { id: string; status: string; email: string | null; expires_at: Date | string }
export interface SendInvitationDeps {
  gotrue: Pick<GoTrueGateway, 'sendInvite'>;
  repo: {
    loadInvitation(tx: unknown, tenantId: string | undefined, invitationId: string): Promise<InvitationRow | undefined>;
    markSent(tx: unknown, a: { tenantId: string | undefined; invitationId: string; issuedAt: string }): Promise<void>;
    markFailed(tx: unknown, a: { tenantId: string | undefined; invitationId: string; errorCode: string }): Promise<void>;
  };
}

const SHAPES = { tenant: ['tenant_id', 'invitation_id'], platform: ['invitation_id'] } as const;

export function createSendInvitation(deps: SendInvitationDeps): TaskHandler {
  return coreErrors(async (payload, ctx) => {
    const s = shapeOf(payload, SHAPES);
    if (!s || !sameTenant(s[1], ctx) || !isUuid(s[1]['invitation_id'])) return malformed(SEND_INVITATION);
    const invitationId = s[1]['invitation_id'] as string; const tenantId = ctx.tenantId;
    const inv = await deps.repo.loadInvitation(ctx.tx, tenantId, invitationId);
    if (!inv || inv.status !== 'pending' || !inv.email || new Date(inv.expires_at).getTime() <= new Date(ctx.now()).getTime()) {
      ctx.log?.info?.({ event: 'send_invitation_skipped', invitation_id: invitationId, status: inv?.status ?? 'missing' });
      return;
    }
    try {
      await deps.gotrue.sendInvite(inv.email, '/auth/confirm');
    } catch (e) {
      if (!permanent(e)) throw e;
      await deps.repo.markFailed(ctx.tx, { tenantId, invitationId, errorCode: e.errorCode });
      ctx.log?.warn?.({ event: 'send_invitation_failed', invitation_id: invitationId, error_code: e.errorCode });
      return;
    }
    await deps.repo.markSent(ctx.tx, { tenantId, invitationId, issuedAt: ctx.now() });
  });
}

// ---------- default wiring (tenant rows; platform rows fail closed, see shared.platformUnwired) ----------
const LOAD_SQL = 'SELECT id, status, email, expires_at FROM identity.invitations WHERE tenant_id = $1 AND id = $2 FOR UPDATE';
const SENT_SQL = `UPDATE identity.invitations SET status = 'sent', issued_at = $3, last_error_code = NULL, updated_at = now(), updated_by = $4, version = version + 1
  WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`;
const FAILED_SQL = `UPDATE identity.invitations SET status = 'failed', last_error_code = $3, updated_at = now(), updated_by = $4, version = version + 1
  WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`;
const tenantOnly = (t: string | undefined) => t ?? platformUnwired('invitation');
export const sendInvitation: TaskHandler = (payload, ctx) => createSendInvitation({
  gotrue: { sendInvite: (e, r) => gotrue().sendInvite(e, r) },
  repo: {
    loadInvitation: async (tx, t, id) => (await q(tx, LOAD_SQL, [tenantOnly(t), id]))[0] as InvitationRow | undefined,
    markSent: async (tx, a) => { await q(tx, SENT_SQL, [tenantOnly(a.tenantId), a.invitationId, a.issuedAt, ctx.actor.id]); },
    markFailed: async (tx, a) => { await q(tx, FAILED_SQL, [tenantOnly(a.tenantId), a.invitationId, a.errorCode, ctx.actor.id]); },
  },
})(payload, ctx);
