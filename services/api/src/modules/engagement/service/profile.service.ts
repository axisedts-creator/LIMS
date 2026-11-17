// E13 listMyProfiles, E18 updateMyProfile, E19 removeMyProfile (02-TRD §4.3 link status table "Patient removes profile", §5 E13/E18/E19; 05-SCHEMA account_patient_links + guard_patient_link_update;
// 07-SECURITY P-L2 / P-L9 / §6.1). Ruling T-SEC1 (IMPLEMENTATION_WRONG): these must be real handlers.
// Order: patient actor + own live account -> If-Match (428/400) -> id / body (400) -> the caller's ACTIVE link (404: unknown, suspended, revoked, other account / tenant) -> version (409) -> write.
// [CONV] Suspended links are counted (paused_count), never listed and never patient-writable (the guard forbids clearing suspend_*), so E18/E19 see them as 404.
// [CONV] pending = the caller's self-registrations still `queued`, or `failed` and not yet purged (expires_at > now), newest first, ≤ 10.
import { LimsError } from '../../../core/errors.js';
import { engagementMetrics } from '../metrics.js';
import { invalid, isUuid, parseIfMatch, type SlotCtx } from './slot.service.js';

export interface ProfileCtx extends SlotCtx { readonly audit?: { access(e: Record<string, unknown>): Promise<void> } }
type Row = Record<string, any>;
type Out = { status: number; body?: Record<string, unknown> };

const RELATIONSHIPS = ['self', 'child', 'parent', 'spouse', 'sibling', 'other'];
const COLS = 'id, display_name, relationship, method, status, visible_from, version';
const iso = (v: unknown): string => new Date(v as string).toISOString();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Profile wire shape (contracts Profile, additionalProperties false): no link / patient / account id beyond profile_id = link id. */
function toProfile(l: Row): Record<string, unknown> {
  return { profile_id: l['id'], display_name: String(l['display_name']).slice(0, 120), relationship: l['relationship'], method: l['method'], status: l['status'],
    ...(l['visible_from'] ? { history_from: iso(l['visible_from']) } : {}), version: l['version'] };
}
function mapDbError(e: unknown): never {
  if (e instanceof LimsError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '23505') throw new LimsError('engagement.link_limit_reached'); // account_patient_links__tenant_id_account_self__p_uq: one `self` per account
  if (code === '42501') throw new LimsError('common.not_found');             // RLS: not the caller's row
  throw new LimsError('common.internal');
}

export function createProfileService() {
  async function scope(ctx: ProfileCtx) {
    if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx || typeof ctx.now !== 'function') throw new LimsError('auth.unauthenticated');
    if (ctx.actor.type !== 'patient') throw new LimsError('auth.forbidden');
    const tx = ctx.tx as { query(t: string, v?: unknown[]): Promise<{ rows: Row[] }> };
    const { rows } = await tx.query("SELECT id FROM engagement.accounts WHERE tenant_id = $1 AND membership_id = $2 AND status = 'active'", [ctx.tenantId, ctx.actor.id]);
    if (!rows[0]) throw new LimsError('auth.forbidden');
    return { tx, tenantId: ctx.tenantId, accountId: rows[0]['id'] as string, userId: ctx.actor.id, now: iso(ctx.now()) };
  }
  /** The caller's own ACTIVE link, row-locked; anything else is the same 404. */
  async function mine(s: Awaited<ReturnType<typeof scope>>, id: unknown): Promise<Row> {
    if (!isUuid(id)) return invalid('/profile_id');
    const { rows } = await s.tx.query(
      `SELECT ${COLS} FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND id = $3 AND status = 'active' FOR UPDATE`, [s.tenantId, s.accountId, id]);
    if (!rows[0]) throw new LimsError('common.not_found');
    return rows[0];
  }

  return {
    async list(ctx: ProfileCtx): Promise<Out> {
      const s = await scope(ctx);
      try {
        const [links, paused, pending] = await Promise.all([
          s.tx.query(`SELECT ${COLS} FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND status = 'active' ORDER BY created_at, id LIMIT 10`, [s.tenantId, s.accountId]),
          s.tx.query(`SELECT count(*)::int AS n FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND status = 'suspended'`, [s.tenantId, s.accountId]),
          s.tx.query(`SELECT id, relationship, status, failure_code FROM engagement.self_registrations
             WHERE tenant_id = $1 AND account_id = $2 AND (status = 'queued' OR (status = 'failed' AND expires_at > $3)) ORDER BY created_at DESC, id LIMIT 10`, [s.tenantId, s.accountId, s.now]),
        ]);
        return { status: 200, body: {
          data: links.rows.map(toProfile),
          pending: pending.rows.map((r) => ({ id: r['id'], relationship: r['relationship'], status: r['status'], ...(r['status'] === 'failed' && r['failure_code'] ? { failure_code: r['failure_code'] } : {}) })),
          paused_count: Math.min(100, Number(paused.rows[0]?.['n'] ?? 0)),
        } };
      } catch (e) { return mapDbError(e); }
    },

    async update(ctx: ProfileCtx, a: { id: unknown; headers: unknown; body: unknown }): Promise<Out> {
      const s = await scope(ctx);
      const expected = parseIfMatch(a.headers);
      const b = a.body;
      if (!isObj(b)) return invalid('/');
      for (const k of Object.keys(b)) if (k !== 'relationship') invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
      if (typeof b['relationship'] !== 'string' || !RELATIONSHIPS.includes(b['relationship'])) invalid('/relationship', b['relationship'] === undefined ? 'common.field_required' : 'common.field_invalid');
      try {
        const cur = await mine(s, a.id);
        if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
        const { rows } = await s.tx.query(
          `UPDATE engagement.account_patient_links SET relationship = $5, version = version + 1, updated_at = $6, updated_by = $7
           WHERE tenant_id = $1 AND account_id = $2 AND id = $3 AND version = $4 RETURNING ${COLS}`, // row locked by mine(): still active
          [s.tenantId, s.accountId, cur['id'], expected, b['relationship'], s.now, s.userId]);
        if (!rows[0]) throw new LimsError('common.version_conflict');
        return { status: 200, body: toProfile(rows[0]) };
      } catch (e) { return mapDbError(e); }
    },

    /** TRD §4.3 link status table: patient removes profile -> `revoked`, revoked_by_kind 'account' (no reason code: the patient gives none). */
    async remove(ctx: ProfileCtx, a: { id: unknown; headers: unknown }): Promise<Out> {
      const s = await scope(ctx);
      const expected = parseIfMatch(a.headers);
      try {
        const cur = await mine(s, a.id);
        if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
        const { rows } = await s.tx.query(
          `UPDATE engagement.account_patient_links SET status = 'revoked', revoked_by_kind = 'account', revoked_at = $5, is_active = false, version = version + 1, updated_at = $5, updated_by = $6
           WHERE tenant_id = $1 AND account_id = $2 AND id = $3 AND version = $4 RETURNING id, method`, // row locked by mine(): still active
          [s.tenantId, s.accountId, cur['id'], expected, s.now, s.userId]);
        if (!rows[0]) throw new LimsError('common.version_conflict');
        await ctx.audit?.access({ action: 'app_link.revoke', entityType: 'app_link', entityId: rows[0]['id'], outcome: 'allowed' }); // 07-SECURITY §7 item 7
        engagementMetrics.linkEvent(ctx, String(rows[0]['method'] ?? 'link_code'), 'revoked');
        return { status: 204 };
      } catch (e) { return mapDbError(e); }
    },
  };
}
export type ProfileService = ReturnType<typeof createProfileService>;
