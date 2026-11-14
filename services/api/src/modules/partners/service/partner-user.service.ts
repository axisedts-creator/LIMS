// C13 T06 — partner users U1–U6 (partner admin) and SA8–SA10 (staff). 02-TRD §5.2/§5.3/§4.8, 03-APP-FLOW §2.5, 05-SCHEMA §3.2.
// Order: actor type -> IdentityPort.assertRole (privileged aal2 check lives behind it, error passed through) -> partnerContext.require
//   (partner callers; role must be partner_admin) -> body / If-Match validation -> lock row FOR UPDATE -> guards -> IdentityPort -> store.
// Provisioning runs in the request transaction (the port gets ctx itself): any throw rolls the membership and the mirror row back together.
// 08 A19 D-100: If-Match = partner_users.version; the row is locked FOR UPDATE; updatePartnerMembership is called WITHOUT expectedVersion; the returned
//   status is stored. D-103 (defence in depth): a partner_member never reaches an INSERT/UPDATE of partner_users (guard_partner_users would refuse it).
// The clear e-mail goes only to the port; partner_users keeps the masked form. SQL is parameterised; no value is logged or echoed in an error.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { maskEmail, toPartnerUserDto, type PartnerUserRow } from '../mappers/partner-user.dto.js';
import { assertTransition, PARTNER_USER_STATUSES, type PartnerUserStatus } from '../domain/partner-user.state.js';
import { partnerContext } from './partner-context.service.js';

type Who = 'partner' | 'staff';
type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
type Obj = Record<string, unknown>;
interface Scope { readonly partnerId?: string; readonly selfId?: string } // set for partner callers only
type PartnerRole = 'partner_admin' | 'partner_member';

const ROLES: readonly string[] = ['partner_admin', 'partner_member'];
const COLS = 'id, display_name, email_masked, partner_role, status, version';
const PERM = { partner: 'partners.partner_user.manage', staffManage: 'partners.partner.manage', staffRead: 'partners.partner.read' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/; // [CONV] shape only; the value set (partners.partner_user_deactivate_reasons) is enforced by C2

const PARTNER_SQL = 'SELECT id, status FROM partners.partners WHERE tenant_id = $1 AND id = $2';
const LIST_SQL = `SELECT ${COLS} FROM partners.partner_users WHERE tenant_id = $1 AND partner_id = $2 ORDER BY created_at, id LIMIT $3 OFFSET $4`;
const LIST_STATUS_SQL = `SELECT ${COLS} FROM partners.partner_users WHERE tenant_id = $1 AND partner_id = $2 AND status = $3 ORDER BY created_at, id LIMIT $4 OFFSET $5`;
const INSERT_SQL = 'INSERT INTO partners.partner_users (id, tenant_id, partner_id, membership_id, partner_role, status, display_name, email_masked, '
  + `invited_by_actor_type, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING ${COLS}`;
const LOCK_COLS = 'SELECT id, partner_id, membership_id, partner_role, status, version FROM partners.partner_users WHERE tenant_id = $1 AND id = $2';
const LOCK_SQL = `${LOCK_COLS} FOR UPDATE`;
const LOCK_PARTNER_SQL = `${LOCK_COLS} AND partner_id = $3 FOR UPDATE`;
// Last-admin decisions are serialised per partner: "A demotes B while B demotes A" must not leave 0 admins (tester-derived; lock taken after the row lock,
// never while waiting for a row lock, so no lock cycle). Advisory lock, not a partners row lock: partner callers have no UPDATE right on partners.partners.
const ADVISORY_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))';
const ADMINS_SQL = 'SELECT count(*)::int AS admins FROM partners.partner_users WHERE tenant_id = $1 AND partner_id = $2 '
  + "AND partner_role = 'partner_admin' AND status IN ('invited', 'active')";
const SET_ROLE_SQL = 'UPDATE partners.partner_users SET partner_role = $3, status = $4, updated_at = now(), updated_by = $5, version = version + 1 '
  + `WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`;
const DEACTIVATE_SQL = 'UPDATE partners.partner_users SET status = $3, deactivate_reason_code = $4, deactivated_at = $5, deactivated_by = $6, '
  + `updated_at = now(), updated_by = $6, version = version + 1 WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`;
const REACTIVATE_SQL = 'UPDATE partners.partner_users SET status = $3, deactivate_reason_code = NULL, deactivated_at = NULL, deactivated_by = NULL, '
  + `updated_at = now(), updated_by = $4, version = version + 1 WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`;

const forbidden = () => new LimsError('auth.forbidden');
const notFound = () => new LimsError('common.not_found');
export const bad = (...paths: string[]): LimsError => new LimsError('common.validation_failed', undefined,
  paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Closed object: unknown keys and missing required keys -> 400; values are never echoed. */
export function closed(v: unknown, keys: readonly string[]): Obj {
  if (!isObj(v)) throw bad('/body');
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw bad(`/${k}`);
  for (const k of keys) if (v[k] === undefined) throw bad(`/${k}`);
  return v;
}
export function uuidParam(params: unknown, name: string): string {
  const v = isObj(params) ? params[name] : undefined;
  if (typeof v !== 'string' || !UUID.test(v)) throw bad(`/${name}`);
  return v;
}
const role = (v: unknown): PartnerRole => {
  if (typeof v !== 'string' || !ROLES.includes(v)) throw bad('/partner_role');
  return v as PartnerRole;
};
/** If-Match: `"<version>"` (02-CV §4.2). Absent -> 428; malformed -> 400. */
export function ifMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) throw bad('/headers/if-match');
  return Number(m[1]);
}
export const encodeCursor = (offset: number): string => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
export function decodeCursor(v: unknown): number {
  try {
    const o = (JSON.parse(Buffer.from(String(v), 'base64url').toString('utf8')) as { o?: unknown } | null)?.o;
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0 && o <= 1_000_000) return o;
  } catch { /* fall through */ }
  throw new LimsError('common.invalid_cursor');
}

/** Actor type + permission + (partner callers) partnerContext. A member is refused here even if the permission check wrongly passed (D-103). */
async function gate(ctx: HandlerContext, who: Who, permission: string): Promise<Scope> {
  if (ctx.actor?.type !== (who === 'partner' ? 'partner' : 'user') || !ctx.tenantId || !ctx.tx || !ctx.actor.id) throw forbidden(); // before any SQL
  await ctx.ports.IdentityPort.assertRole(ctx, { permission } as never);
  if (who === 'staff') return {};
  const ref = await partnerContext.require(ctx);
  if (ref.role !== 'partner_admin') throw forbidden();
  return { partnerId: ref.partnerId, selfId: ref.partnerUserId };
}

async function assertPartnerVisible(ctx: HandlerContext, partnerId: string): Promise<void> {
  const { rows } = await (ctx.tx as Q).query(PARTNER_SQL, [ctx.tenantId, partnerId]);
  if (!rows[0]) throw notFound(); // unknown or other tenant: same answer
}

// ------------------------------------------------------------------ U1 / SA8
export async function listUsers(req: HandlerRequest, ctx: HandlerContext, who: Who): Promise<HandlerResult> {
  const scope = await gate(ctx, who, who === 'partner' ? PERM.partner : PERM.staffRead);
  const partnerId = scope.partnerId ?? uuidParam(req.params, 'partner_id');
  const q = isObj(req.query) ? req.query : {};
  for (const k of Object.keys(q)) if (!['status', 'cursor', 'limit'].includes(k)) throw bad(`/${k}`);
  const status = q['status'];
  if (status !== undefined && (typeof status !== 'string' || !(PARTNER_USER_STATUSES as readonly string[]).includes(status))) throw bad('/status');
  let limit = 50;
  if (q['limit'] !== undefined) {
    const raw = q['limit'], n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
    limit = n;
  }
  const offset = q['cursor'] === undefined ? 0 : decodeCursor(q['cursor']); // ponytail: offset cursor, keyset if a partner ever has thousands of users
  if (who === 'staff') await assertPartnerVisible(ctx, partnerId);
  const tx = ctx.tx as Q;
  const { rows } = status === undefined
    ? await tx.query(LIST_SQL, [ctx.tenantId, partnerId, limit + 1, offset])
    : await tx.query(LIST_STATUS_SQL, [ctx.tenantId, partnerId, status, limit + 1, offset]);
  return {
    status: 200,
    body: { data: rows.slice(0, limit).map((r: PartnerUserRow) => toPartnerUserDto(r)), page: { limit, ...(rows.length > limit ? { next_cursor: encodeCursor(offset + limit) } : {}) } },
  };
}

// ------------------------------------------------------------------ U2 / SA9
export async function invite(req: HandlerRequest, ctx: HandlerContext, who: Who): Promise<HandlerResult> {
  const scope = await gate(ctx, who, who === 'partner' ? PERM.partner : PERM.staffManage);
  const partnerId = scope.partnerId ?? uuidParam(req.params, 'partner_id'); // a partner_id in the body is an unknown key -> 400 (REQ-SEC-080)
  const b = closed(req.body, ['email', 'display_name', 'partner_role']);
  const email = typeof b['email'] === 'string' ? b['email'].trim() : '';
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) throw bad('/email');
  const displayName = typeof b['display_name'] === 'string' ? b['display_name'].trim() : '';
  if (displayName.length < 1 || displayName.length > 120) throw bad('/display_name');
  const partnerRole = role(b['partner_role']);
  if (who === 'staff') await assertPartnerVisible(ctx, partnerId);

  // Same transaction as the INSERT below (D-100 family): the port gets ctx itself. A throw here means no partner_users row; a failing INSERT rolls the membership back.
  const m = await ctx.ports.IdentityPort.provisionPartnerMembership(ctx, { email, displayName, partnerRole } as never);
  const { rows } = await (ctx.tx as Q).query(INSERT_SQL, [
    uuidv7(), ctx.tenantId, partnerId, m.membershipId, partnerRole, m.status, displayName, maskEmail(email), who === 'partner' ? 'partner' : 'user', ctx.actor!.id,
  ]);
  return { status: 201, body: toPartnerUserDto(rows[0] as PartnerUserRow) };
}

// ------------------------------------------------------------------ U3–U5 / SA10
interface Locked { id: string; partner_id: string; membership_id: string; partner_role: PartnerRole; status: PartnerUserStatus; version: number | string }

/** Row lookup + lock. Partner callers are pinned to their own partner (ST2): another partner's / tenant's row is "not found". */
async function lockUser(ctx: HandlerContext, scope: Scope, userId: string): Promise<Locked> {
  const tx = ctx.tx as Q;
  const { rows } = scope.partnerId === undefined
    ? await tx.query(LOCK_SQL, [ctx.tenantId, userId])
    : await tx.query(LOCK_PARTNER_SQL, [ctx.tenantId, userId, scope.partnerId]);
  if (!rows[0]) throw notFound();
  return rows[0] as Locked;
}

type Kind = 'set_role' | 'deactivate' | 'reactivate';

export async function change(req: HandlerRequest, ctx: HandlerContext, who: Who, kind: Kind): Promise<HandlerResult> {
  const scope = await gate(ctx, who, who === 'partner' ? PERM.partner : PERM.staffManage);
  const expected = ifMatch(req.headers);
  const userId = uuidParam(req.params, 'partner_user_id');
  let newRole: PartnerRole | undefined, reason: string | undefined;
  if (kind === 'set_role') newRole = role(closed(req.body, ['partner_role'])['partner_role']);
  else if (kind === 'deactivate') {
    const r = closed(req.body, ['reason_code'])['reason_code'];
    if (typeof r !== 'string' || !REASON.test(r)) throw bad('/reason_code');
    reason = r;
  }

  const row = await lockUser(ctx, scope, userId);
  if (Number(row.version) !== expected) throw new LimsError('common.version_conflict');
  if (kind === 'reactivate' && row.status !== 'deactivated') throw new LimsError('partners.partner_user_invalid_transition');
  if (kind !== 'reactivate') assertTransition(row.status, kind === 'deactivate' ? 'deactivated' : row.status); // role change needs invited|active
  if (scope.selfId === row.id && kind !== 'reactivate') throw new LimsError('partners.self_action_forbidden');

  const removesAdmin = row.partner_role === 'partner_admin' && (kind === 'deactivate' || (kind === 'set_role' && newRole === 'partner_member'));
  if (removesAdmin) {
    const tx = ctx.tx as Q;
    await tx.query(ADVISORY_SQL, [`partners.partner_users:${ctx.tenantId}:${row.partner_id}`]);
    const { rows: c } = await tx.query(ADMINS_SQL, [ctx.tenantId, row.partner_id]);
    if (Number(c[0]?.admins) <= 1) throw new LimsError('partners.last_partner_admin'); // staff override = promote another admin first (SA10)
  }

  // D-100: no expectedVersion — C13 holds the lock on its own row; C2 applies the action to the current membership row.
  const input = kind === 'set_role' ? { membershipId: row.membership_id, action: 'set_role', partnerRole: newRole }
    : kind === 'deactivate' ? { membershipId: row.membership_id, action: 'deactivate', reasonCode: reason }
      : { membershipId: row.membership_id, action: 'reactivate' };
  const out = await ctx.ports.IdentityPort.updatePartnerMembership(ctx, input as never);
  assertTransition(row.status, out.status); // the returned status is what C2 now holds; store it

  const tx = ctx.tx as Q, actorId = ctx.actor!.id;
  const { rows } = kind === 'set_role' ? await tx.query(SET_ROLE_SQL, [ctx.tenantId, row.id, newRole, out.status, actorId])
    : kind === 'deactivate'
      ? await tx.query(DEACTIVATE_SQL, [ctx.tenantId, row.id, out.status, out.status === 'deactivated' ? reason : null, out.status === 'deactivated' ? ctx.now() : null,
        out.status === 'deactivated' ? actorId : null])
      : await tx.query(REACTIVATE_SQL, [ctx.tenantId, row.id, out.status, actorId]);
  if (!rows[0]) throw new LimsError('common.version_conflict'); // row vanished between lock and update: cannot happen under the lock
  return { status: 200, body: toPartnerUserDto(rows[0] as PartnerUserRow) };
}

// ------------------------------------------------------------------ U6
export async function resend(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const scope = await gate(ctx, 'partner', PERM.partner);
  const userId = uuidParam(req.params, 'partner_user_id');
  const row = await lockUser(ctx, scope, userId);
  if (row.status !== 'invited') throw new LimsError('partners.partner_user_invalid_transition');
  await ctx.ports.IdentityPort.updatePartnerMembership(ctx, { membershipId: row.membership_id, action: 'resend_invitation' } as never);
  return { status: 202, body: {} };
}
