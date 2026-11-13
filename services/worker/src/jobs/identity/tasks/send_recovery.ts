// identity.send_recovery (02-TRD §10 row; 03-APP-FLOW §3.7; 01-PRD AC-A7.1; 07-SECURITY AU-T5; 08 A25 D-219).
// Platform task, payload { email_norm }. Sends GoTrue's recovery mail ONLY to an existing active account (tenant user: one active membership,
// not locked, tenant active; platform staff: active). Every other case stops silently: same resolved result, nothing written or logged with
// the e-mail. The link TTL is GoTrue's (D-219). A GoTrue outage is rethrown so the queue retries; a bad payload is skipped.
import type { TaskHandler } from '../../../core/manifest.js';
// [CONV] relative import of the api GoTrue seam (same pattern as build_audit_export's shared-ts import)
import { gotrueGatewayFromEnv } from '../../../../../api/src/modules/identity/gotrue/gateway.http.js';
import type { GoTrueGateway } from '../../../../../api/src/modules/identity/gotrue/gateway.js';

export const SEND_RECOVERY = 'identity.send_recovery';

type Row = Record<string, unknown>;
export interface SendRecoveryDeps {
  gotrue: Pick<GoTrueGateway, 'adminFindUserByEmail' | 'sendRecovery'>;
  repo: { loginContext(tx: unknown, sub: string): Promise<Row | undefined> };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

function active(r: Row | undefined): boolean {
  if (!r) return false;
  if (r['platform_staff_id'] && !r['tenant_id']) return r['platform_active'] === true;
  return Number(r['membership_count']) === 1 && r['tenant_status'] === 'active' && r['membership_status'] === 'active' && r['membership_locked'] === false;
}

export function createSendRecovery(deps: SendRecoveryDeps): TaskHandler {
  return async (payload, ctx) => {
    const p = payload as Row | undefined;
    const email = p?.['email_norm'];
    if (!p || Object.keys(p).length !== 1 || typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) {
      ctx.log?.warn?.({ event: 'send_recovery_skipped', reason: 'bad_payload' });
      return;
    }
    const user = await deps.gotrue.adminFindUserByEmail(email);
    if (!user) return;
    if (!active(await deps.repo.loginContext(ctx.tx, user.userId))) return;
    await deps.gotrue.sendRecovery(email, '/auth/confirm');
  };
}

// ---------- default wiring ----------
const LOGIN_CONTEXT_SQL = `SELECT platform_staff_id, platform_active, membership_count, tenant_id, tenant_status, membership_status, membership_locked
  FROM app.identity_login_context($1::uuid)`;
let gateway: GoTrueGateway | undefined;
const gw = () => (gateway ??= gotrueGatewayFromEnv());
export const sendRecovery: TaskHandler = createSendRecovery({
  gotrue: { adminFindUserByEmail: (e) => gw().adminFindUserByEmail(e), sendRecovery: (e, r) => gw().sendRecovery(e, r) },
  repo: { loginContext: async (tx, sub) => (await (tx as { query(t: string, v: unknown[]): Promise<{ rows: Row[] }> }).query(LOGIN_CONTEXT_SQL, [sub])).rows[0] },
});
