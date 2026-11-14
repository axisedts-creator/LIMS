// partnerContext.require (02-TRD §4.8): resolves ctx.partner {partnerId, partnerUserId, role} for partner actors only.
// Fail closed: non-partner actor -> 403 auth.forbidden (no SQL); no visible row / deactivated user / non-active partner -> 403 partners.partner_inactive.
// The row is looked up by (tenant_id, membership_id) from the token, never by a request value (REQ-SEC-024, US-15.1). RLS hides the same rows
// (app.current_partner_id() NULL); the status checks below are defence in depth (07-SECURITY AB8/AB9).
// invited -> active: C13 flips its mirror on the user's first partner request (03-APP-FLOW §2.5), the one UPDATE guard_partner_users allows a member.
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext } from '../../../core/module.js';
import { partnerInactive } from './observability.js';

export interface PartnerRef { readonly partnerId: string; readonly partnerUserId: string; readonly role: 'partner_admin' | 'partner_member' }

/** Everything the A1 DTO needs from the single lookup. */
export interface PartnerContextRow {
  readonly partner_user_id: string; readonly partner_id: string; readonly partner_role: PartnerRef['role'];
  readonly user_status: string; readonly partner_status: string; readonly display_name: string;
  readonly partner_code: string; readonly partner_name: string; readonly conversion_mode: string;
  readonly access_slip_enabled: boolean | null; readonly include_default_price_list: boolean | null;
}

type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };

const LOOKUP_SQL = [
  'SELECT pu.id AS partner_user_id, pu.partner_id AS partner_id, pu.partner_role AS partner_role, pu.status AS user_status,',
  'p.status AS partner_status, pu.display_name AS display_name, p.partner_code AS partner_code, p.name AS partner_name,',
  'p.conversion_mode AS conversion_mode, s.access_slip_enabled AS access_slip_enabled, s.include_default_price_list AS include_default_price_list',
  'FROM partners.partner_users pu',
  'JOIN partners.partners p ON p.tenant_id = pu.tenant_id AND p.id = pu.partner_id',
  'LEFT JOIN partners.settings s ON s.tenant_id = pu.tenant_id',
  'WHERE pu.tenant_id = $1 AND pu.membership_id = $2',
].join(' ');

const FLIP_SQL = [
  "UPDATE partners.partner_users SET status = 'active', activated_at = $3, updated_at = $3, updated_by = $4, version = version + 1",
  "WHERE tenant_id = $1 AND id = $2 AND status = 'invited'",
].join(' ');

const inactive = () => new LimsError('partners.partner_inactive'); // generic: nothing about the partner or user
const resolved = new WeakMap<object, { ref: PartnerRef; row: PartnerContextRow }>();

/** Lookup + status gate + invited->active flip, memoised per request (ctx). */
async function resolve(ctx: HandlerContext): Promise<{ ref: PartnerRef; row: PartnerContextRow }> {
  const hit = resolved.get(ctx);
  if (hit) return hit;
  if (ctx.actor?.type !== 'partner') throw new LimsError('auth.forbidden'); // defence in depth: before any SQL
  const membershipId = ctx.actor.membershipId;
  if (!ctx.tenantId || !membershipId || !ctx.tx) throw new LimsError('auth.forbidden');

  const tx = ctx.tx as Q;
  const { rows } = await tx.query(LOOKUP_SQL, [ctx.tenantId, membershipId]);
  const row = rows[0] as PartnerContextRow | undefined;
  if (!row || row.partner_status !== 'active' || (row.user_status !== 'active' && row.user_status !== 'invited')) {
    partnerInactive(ctx); // T23: lims_partners_partner_inactive_rejections_total, once per 403 partners.partner_inactive
    throw inactive();
  }

  if (row.user_status === 'invited') {
    // 0 rows touched = a concurrent first request won; the user is active either way.
    await tx.query(FLIP_SQL, [ctx.tenantId, row.partner_user_id, ctx.now(), ctx.actor.id]);
  }
  const ref: PartnerRef = Object.freeze({ partnerId: row.partner_id, partnerUserId: row.partner_user_id, role: row.partner_role });
  const out = { ref, row };
  resolved.set(ctx, out);
  try { (ctx as { partner?: PartnerRef }).partner = ref; } catch { /* ctx frozen: callers use the return value */ }
  return out;
}

export const partnerContext = {
  async require(ctx: HandlerContext): Promise<PartnerRef> {
    return (await resolve(ctx)).ref;
  },
  /** For A1: the same memoised lookup, with the DTO columns. */
  async load(ctx: HandlerContext): Promise<PartnerContextRow> {
    return (await resolve(ctx)).row;
  },
};
