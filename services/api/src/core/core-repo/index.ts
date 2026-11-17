// ctx.core: read-only core repository (02-TRD §6.8; 08 A17 D-47). REQ-SEC-024: every query binds tenant_id = ctx.tenantId
// explicitly in addition to RLS; the tenant never comes from caller input.
import { LimsError } from '../errors.js';
import { createDeadLetters, type DeadLetterDeps } from './dead-letters.js';

export type { DeadLetterRow } from './dead-letters.js';
export type CoreRepoDeps = DeadLetterDeps;

interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Ctx { readonly tenantId?: string; readonly actor: { readonly type: string; readonly id: string }; readonly tx: unknown }

export interface BranchRow { readonly id: string; readonly branchCode: string; readonly name: string; readonly addressText?: string;
  readonly phoneDisplay?: string; readonly isProcessingLab: boolean; readonly isActive: boolean }
export interface CentreRow { readonly id: string; readonly branchId: string; readonly centreCode: string; readonly name: string;
  readonly centreKind: 'own' | 'franchise' | 'home_collection'; readonly addressText?: string; readonly phoneDisplay?: string; readonly isActive: boolean }
export interface MembershipRow { readonly membershipId: string; readonly userId: string; readonly actorType: string; readonly displayName: string;
  readonly status: 'invited' | 'active' | 'deactivated'; readonly isActive: boolean; readonly lockedAt?: string;
  readonly allCentres: boolean; readonly centreIds: readonly string[]; readonly roleCodes: readonly string[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['own', 'franchise', 'home_collection'];
const invalid = (path: string) => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
const opt = <K extends string>(k: K, v: unknown): { [P in K]?: string } => (v === null || v === undefined ? {} : { [k]: String(v) } as { [P in K]: string });

function scope(ctx: Ctx): { tx: Tx; tenantId: string } {
  if (typeof ctx.tenantId !== 'string' || !UUID.test(ctx.tenantId)) throw new LimsError('common.internal');   // tenant reads need a tenant ctx
  return { tx: ctx.tx as Tx, tenantId: ctx.tenantId };
}
const one = <T>(rows: any[], map: (r: any) => T): T => {
  if (rows.length === 0) throw new LimsError('common.not_found');
  return map(rows[0]);
};
const id = (v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new LimsError('common.not_found');
  return v;
};

const branchRow = (r: any): BranchRow => ({
  id: r.id, branchCode: r.branch_code, name: r.name, ...opt('addressText', r.address_text), ...opt('phoneDisplay', r.phone_display),
  isProcessingLab: r.is_processing_lab, isActive: r.is_active,
});
const centreRow = (r: any): CentreRow => ({
  id: r.id, branchId: r.branch_id, centreCode: r.centre_code, name: r.name, centreKind: r.centre_kind,
  ...opt('addressText', r.address_text), ...opt('phoneDisplay', r.phone_display), isActive: r.is_active,
});
const BRANCH_COLS = 'id, branch_code, name, address_text, phone_display, is_processing_lab, is_active';
const CENTRE_COLS = 'id, branch_id, centre_code, name, centre_kind, address_text, phone_display, is_active';
const ROLE_CODES = `ARRAY(SELECT r.role_code FROM core.membership_roles mr
    JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
   WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id ORDER BY r.role_code) AS role_codes`;

export function createCoreRepo(deps: CoreRepoDeps) {
  return {
    async tenant(ctx: Ctx) {
      const { tx, tenantId } = scope(ctx);
      const { rows } = await tx.query('SELECT id, tenant_code, display_name, legal_name, status, timezone FROM core.tenants WHERE id = $1', [tenantId]);
      return one(rows, (r) => ({ id: r.id, tenantCode: r.tenant_code, displayName: r.display_name, legalName: r.legal_name, status: r.status, timezone: r.timezone }));
    },

    async branches(ctx: Ctx, input: { activeOnly?: boolean } = {}): Promise<readonly BranchRow[]> {
      const { tx, tenantId } = scope(ctx);
      const active = input?.activeOnly === true ? ' AND is_active' : '';
      const { rows } = await tx.query(`SELECT ${BRANCH_COLS} FROM core.branches WHERE tenant_id = $1${active} ORDER BY branch_code`, [tenantId]);
      return rows.map(branchRow);
    },

    async branch(ctx: Ctx, input: { branchId: string }): Promise<BranchRow> {
      const { tx, tenantId } = scope(ctx);
      const { rows } = await tx.query(`SELECT ${BRANCH_COLS} FROM core.branches WHERE tenant_id = $1 AND id = $2`, [tenantId, id(input?.branchId)]);
      return one(rows, branchRow);
    },

    async centres(ctx: Ctx, input: { branchId?: string; activeOnly?: boolean; kinds?: readonly string[] } = {}): Promise<readonly CentreRow[]> {
      const { tx, tenantId } = scope(ctx);
      const i = input ?? {};
      const values: unknown[] = [tenantId];
      const where = ['tenant_id = $1'];
      if (i.branchId !== undefined) {
        if (typeof i.branchId !== 'string' || !UUID.test(i.branchId)) throw invalid('/branchId');
        values.push(i.branchId); where.push(`branch_id = $${values.length}`);
      }
      if (i.kinds !== undefined) {
        if (!Array.isArray(i.kinds) || !i.kinds.every((k) => KINDS.includes(k))) throw invalid('/kinds');
        values.push([...i.kinds]); where.push(`centre_kind = ANY($${values.length}::text[])`);
      }
      if (i.activeOnly === true) where.push('is_active');
      const { rows } = await tx.query(`SELECT ${CENTRE_COLS} FROM core.collection_centres WHERE ${where.join(' AND ')} ORDER BY centre_code`, values);
      return rows.map(centreRow);
    },

    async centre(ctx: Ctx, input: { centreId: string }): Promise<CentreRow> {
      const { tx, tenantId } = scope(ctx);
      const { rows } = await tx.query(`SELECT ${CENTRE_COLS} FROM core.collection_centres WHERE tenant_id = $1 AND id = $2`, [tenantId, id(input?.centreId)]);
      return one(rows, centreRow);
    },

    async user(ctx: Ctx, input: { userId: string }) {
      const { tx, tenantId } = scope(ctx);
      const { rows } = await tx.query('SELECT id, display_name, is_active FROM core.users WHERE tenant_id = $1 AND id = $2', [tenantId, id(input?.userId)]);
      return one(rows, (r) => ({ id: r.id as string, displayName: r.display_name as string, isActive: r.is_active as boolean }));
    },

    async membership(ctx: Ctx, input: { membershipId: string }): Promise<MembershipRow> {
      const { tx, tenantId } = scope(ctx);
      const { rows } = await tx.query(
        `SELECT m.id AS membership_id, m.user_id, m.actor_type, u.display_name, m.status, m.is_active, m.locked_at, m.all_centres,
                ARRAY(SELECT mc.centre_id FROM core.membership_centres mc
                       WHERE mc.tenant_id = m.tenant_id AND mc.membership_id = m.id ORDER BY mc.centre_id) AS centre_ids,
                ${ROLE_CODES}
           FROM core.memberships m
           JOIN core.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.id = $2`, [tenantId, id(input?.membershipId)]);
      return one(rows, (r) => ({
        membershipId: r.membership_id, userId: r.user_id, actorType: r.actor_type, displayName: r.display_name, status: r.status,
        isActive: r.is_active,
        ...(r.locked_at === null || r.locked_at === undefined ? {} : { lockedAt: (r.locked_at instanceof Date ? r.locked_at : new Date(r.locked_at)).toISOString() }),
        allCentres: r.all_centres, centreIds: [...r.centre_ids], roleCodes: [...r.role_codes],
      }));
    },

    async membershipPermissions(ctx: Ctx, input: { membershipId: string }): Promise<readonly string[]> {
      const { tx, tenantId } = scope(ctx);
      const { rows } = await tx.query(
        `SELECT DISTINCT rp.permission_code FROM core.membership_roles mr
           JOIN core.role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
          WHERE mr.tenant_id = $1 AND mr.membership_id = $2 ORDER BY rp.permission_code`, [tenantId, id(input?.membershipId)]);
      return rows.map((r) => r.permission_code as string);
    },

    memberships: {
      async list(ctx: Ctx, input: { centreId?: string; roleCode?: string; permission?: string; membershipIds?: readonly string[];
        activeOnly?: boolean; limit?: number } = {}) {
        // 08 A17 D-47: staff or system callers only.
        if (ctx?.actor?.type !== 'user' && ctx?.actor?.type !== 'system') throw new LimsError('auth.forbidden');
        const i = input ?? {};
        const limit = i.limit ?? 200;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid('/limit');
        if (i.membershipIds !== undefined
          && (!Array.isArray(i.membershipIds) || i.membershipIds.length > 200 || !i.membershipIds.every((x) => typeof x === 'string' && UUID.test(x)))) {
          throw invalid('/membershipIds');
        }
        if (i.centreId !== undefined && !(typeof i.centreId === 'string' && UUID.test(i.centreId))) throw invalid('/centreId');
        if (i.roleCode !== undefined && typeof i.roleCode !== 'string') throw invalid('/roleCode');
        if (i.permission !== undefined && typeof i.permission !== 'string') throw invalid('/permission');
        const { tx, tenantId } = scope(ctx);

        const values: unknown[] = [tenantId];
        const where = ['m.tenant_id = $1', "m.actor_type = 'user'"];
        const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
        if (i.activeOnly !== false) where.push('m.is_active');
        if (i.centreId !== undefined) {
          where.push(`(m.all_centres OR EXISTS (SELECT 1 FROM core.membership_centres mc
            WHERE mc.tenant_id = m.tenant_id AND mc.membership_id = m.id AND mc.centre_id = ${bind(i.centreId)}))`);
        }
        if (i.roleCode !== undefined) {
          where.push(`EXISTS (SELECT 1 FROM core.membership_roles mr JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
            WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id AND r.role_code = ${bind(i.roleCode)})`);
        }
        if (i.permission !== undefined) {
          where.push(`EXISTS (SELECT 1 FROM core.membership_roles mr JOIN core.role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
            WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id AND rp.permission_code = ${bind(i.permission)})`);
        }
        if (i.membershipIds !== undefined) where.push(`m.id = ANY(${bind([...i.membershipIds])}::uuid[])`);
        const lim = bind(limit);
        // The SELECT list names is_active before the first WHERE (inside ROLE_CODES), the filter only appears in the outer WHERE.
        const { rows } = await tx.query(
          `SELECT m.id AS membership_id, u.display_name, m.all_centres, m.is_active, ${ROLE_CODES}
             FROM core.memberships m
             JOIN core.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id
            WHERE ${where.join(' AND ')}
            ORDER BY u.display_name, m.id
            LIMIT ${lim}`, values);
        return rows.map((r) => ({ membershipId: r.membership_id as string, displayName: r.display_name as string,
          roleCodes: [...r.role_codes] as string[], allCentres: r.all_centres as boolean, isActive: r.is_active as boolean }));
      },
    },

    deadLetters: createDeadLetters(deps),
  };
}
export type CoreRepository = ReturnType<typeof createCoreRepo>;
