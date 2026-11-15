// SessionState.actor of every login / resolve 200 body (LD-208 SESSION-ACTOR-1; contracts/openapi/identity.yaml SessionState.actor).
// Source: app.identity_session_actor (display_name, role_codes, tenant_code). Only these three fields ever leave; tenant_code only for a
// tenant session; never an e-mail, id or token; no support_session. No row (or a row without a usable display_name) => common.internal:
// never a 200 without actor.
import { LimsError } from '../../../core/errors.js';

export interface SessionActor { display_name: string; roles: string[]; tenant_code?: string }
export interface ActorKey { userId: string; tenantId: string | null; membershipId: string | null }
interface Log { error(o: object, m?: string): void }

export async function loadSessionActor(
  lookup: (key: ActorKey) => Promise<Record<string, unknown> | null | undefined>, key: ActorKey, log: Log | undefined, requestId: string,
): Promise<SessionActor> {
  const row = await lookup(key);
  const name = row?.['display_name'];
  if (typeof name !== 'string' || name.length < 1 || name.length > 120 || !Array.isArray(row?.['role_codes'])) {
    log?.error({ request_id: requestId }, 'identity: session actor missing (app.identity_session_actor returned no usable row)');
    throw new LimsError('common.internal', 'identity: session actor missing');
  }
  const actor: SessionActor = { display_name: name, roles: (row['role_codes'] as unknown[]).filter((r): r is string => typeof r === 'string').slice(0, 20) };
  const code = row['tenant_code'];
  if (key.tenantId !== null && typeof code === 'string' && code) actor.tenant_code = code;
  return actor;
}
