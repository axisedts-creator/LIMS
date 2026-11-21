// SessionState.actor of every login / resolve 200 body (LD-208 SESSION-ACTOR-1; contracts/openapi/identity.yaml SessionState.actor).
// Source: app.identity_session_actor (display_name, role_codes, tenant_code). Only these fields ever leave; tenant_code only for a
// tenant session; never an e-mail, id or token; no support_session. No row (or a row without a usable display_name) => common.internal:
// never a 200 without actor.
// LD-222 AUTH-ACTOR-2: optional `permissions`, present ONLY when the session state is exactly 'active' (no pre-MFA session learns its set).
// Platform = permissionsOfRoles(actor roles); tenant = the membershipPermissions read (caller binds it to the tenant-bound tx).
// A failed / malformed read is common.internal, never []. The list and its codes are never logged.
import { LimsError } from '../../../core/errors.js';
import { permissionsOfRoles } from '../domain/permission-set.js';

export interface SessionActor { display_name: string; roles: string[]; tenant_code?: string; permissions?: string[] }
export interface ActorKey { userId: string; tenantId: string | null; membershipId: string | null }
export interface ActorPerms { state: string; tenantPermissions(membershipId: string): Promise<readonly string[]> }
interface Log { error(o: object, m?: string): void }

// identity.yaml SessionState.actor.permissions: maxItems 400, each <= 100 chars.
const MAX_PERMS = 400, MAX_CODE = 100;

export async function loadSessionActor(
  lookup: (key: ActorKey) => Promise<Record<string, unknown> | null | undefined>, key: ActorKey, log: Log | undefined, requestId: string,
  perms?: ActorPerms,
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
  if (perms?.state === 'active') actor.permissions = await readPermissions(key, actor.roles, perms, log, requestId);
  return actor;
}

async function readPermissions(key: ActorKey, roles: string[], perms: ActorPerms, log: Log | undefined, requestId: string): Promise<string[]> {
  const fail = (): never => {
    log?.error({ request_id: requestId }, 'identity: session actor read failed');
    throw new LimsError('common.internal', 'identity: session actor read failed');
  };
  let list: unknown;
  if (key.tenantId === null) list = permissionsOfRoles(roles);
  else {
    if (key.membershipId === null) return fail();
    try { list = await perms.tenantPermissions(key.membershipId); } catch { return fail(); }
  }
  if (!Array.isArray(list) || list.length > MAX_PERMS || !list.every((c) => typeof c === 'string' && c.length <= MAX_CODE)) return fail();
  return [...(list as string[])];
}
