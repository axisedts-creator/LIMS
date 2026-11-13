// Role packs (LD-141; spec/program/11-ROLE-MATRIX.md R6, §4 item 5): seed a pack's templates as CUSTOM roles (S9) of the ctx tenant.
// Re-apply is insert-only: a pack role that already exists (same code, active or not) is left exactly as the tenant edited it
// (R6 "editable afterwards"), so a re-apply never removes, renames or restores anything. Default roles are never read for writing.
// No HTTP operation here: it needs CR-C2-RM-001 to C0. Tenant and actor come from ctx only; every SQL statement names tenant_id.
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { loadRolePacks } from '../role-packs/loader.js';
import type { RoleCtx } from './role.service.js';

export type PackRoleRow = { id: string; code: string; is_system_default: boolean; is_active: boolean; mfa_required: boolean; permission_codes: string[] };
export interface RolePackRepo {
  listRoles(tx: unknown, tenantId: string): Promise<PackRoleRow[]>;
  insertRole(tx: unknown, tenantId: string, r: { id: string; code: string; name: string; mfaRequired: boolean; permissionCodes: string[]; actorId: string }): Promise<void>;
  addPermissions(tx: unknown, tenantId: string, roleId: string, codes: string[], actorId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

/** Default repo: SQL on the request tx; inserts only (no UPDATE / DELETE exists, so a re-apply cannot remove a tenant edit). */
export function createRolePackRepo(): RolePackRepo {
  const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Tx).query(sql, params)).rows;
  const grant = (tx: unknown, t: string, id: string, codes: string[], actorId: string) => q(tx, `INSERT INTO core.role_permissions (tenant_id, role_id, permission_code, created_by)
      SELECT $1, $2, c, $4 FROM unnest($3::text[]) AS c ON CONFLICT DO NOTHING`, [t, id, codes, actorId]);
  return {
    listRoles: (tx, t) => q(tx, `SELECT r.id, r.role_code AS code, r.is_system_default, r.is_active, r.mfa_required,
        COALESCE((SELECT array_agg(p.permission_code ORDER BY p.permission_code) FROM core.role_permissions p
                  WHERE p.tenant_id = r.tenant_id AND p.role_id = r.id), '{}'::text[]) AS permission_codes
      FROM core.roles r WHERE r.tenant_id = $1 ORDER BY r.role_code`, [t]),
    async insertRole(tx, t, r) {
      // is_system_default left to its column default (false): pack roles are custom roles (S9).
      await q(tx, `INSERT INTO core.roles (id, tenant_id, role_code, display_name, mfa_required, created_by, updated_by)
        VALUES ($2, $1, $3, $4, $5, $6, $6)`, [t, r.id, r.code, r.name, r.mfaRequired, r.actorId]);
      await grant(tx, t, r.id, r.permissionCodes, r.actorId);
    },
    async addPermissions(tx, t, id, codes, actorId) { await grant(tx, t, id, codes, actorId); },
  };
}

export function createRolePackService(deps: { repo?: RolePackRepo; newId?: () => string } = {}) {
  const repo = deps.repo ?? createRolePackRepo();
  const newId = deps.newId ?? uuidv7;
  const packs = loadRolePacks();   // validated against contracts/permissions.yaml (RM-T01); throws at startup if the data file is bad
  return {
    async applyRolePack(ctx: RoleCtx, input: { packCode?: unknown }) {
      if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
      if (typeof ctx.audit?.access !== 'function') throw new LimsError('common.internal');   // fail closed: no access log, no write
      const code = input?.packCode;
      const pack = typeof code === 'string' ? packs.packs.find((p) => p.code === code) : undefined;
      if (!pack) throw new LimsError('common.validation_failed');
      const t = ctx.tenantId, actorId = ctx.actor.id;
      const existing = new Set((await repo.listRoles(ctx.tx, t)).map((r) => r.code));
      const created: string[] = [], unchanged: string[] = [];
      for (const r of pack.roles) {
        if (existing.has(r.code)) { unchanged.push(r.code); continue; }   // tenant edits win (R6); never rewritten
        const id = newId();
        await repo.insertRole(ctx.tx, t, { id, code: r.code, name: r.name, mfaRequired: r.mfa_required, permissionCodes: [...new Set(r.permissions)].sort(), actorId });
        await ctx.audit.access({ action: 'role.change', entityType: 'role', entityId: id, outcome: 'allowed' });
        created.push(r.code);
      }
      return { status: 200 as const, body: { pack_code: pack.code, created, updated: [] as string[], unchanged } };
    },
  };
}
