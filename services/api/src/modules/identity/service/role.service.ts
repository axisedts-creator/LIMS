// Roles + permissions (02-TRD §5.4; 03-APP-FLOW §4.3; 01-PRD AC-B2.1-B2.4; 07-SECURITY A-4, A-17, P-2, E-2).
// Tenant and actor come from ctx only. Every SQL statement names tenant_id explicitly on top of RLS (REQ-SEC-040).
// A permission-set change revokes every holder's sessions (SS9 role_change) and fans out identity.gotrue_signout jobs of <= 200 users.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { REPO_ROOT } from '../../../core/module.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as instruments agents.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { DEFAULT_REGISTRY, isAssignable, validateRolePermissions } from '../domain/permission-set.js';

export interface RoleCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly requestId?: string;
  readonly tx: unknown;
  readonly audit?: { access(entry: Record<string, unknown>): Promise<unknown> };
}
export interface Result { status: number; body: any; version?: number }

export type Row = {
  id: string; code: string; display_name: string; description: string | null; is_system_default: boolean; mfa_required: boolean;
  is_active: boolean; version: number; permission_codes: string[]; member_count: number;
};
export interface Holder { membershipId: string; userId: string; actorType: string; status: string; isLocked: boolean; roleId: string }
type RoleFields = { name: string; description?: string; mfaRequired: boolean; permissionCodes: string[]; actorId: string };

export interface RoleRepo {
  listRoles(tx: unknown, tenantId: string, q: { isActive?: boolean }): Promise<Row[]>;
  findRole(tx: unknown, tenantId: string, roleId: string): Promise<Row | undefined>;
  insertRole(tx: unknown, tenantId: string, r: RoleFields & { id: string; code: string }): Promise<Row>;
  updateRole(tx: unknown, tenantId: string, roleId: string, expectedVersion: number, p: RoleFields): Promise<Row | undefined>;
  deactivateRole(tx: unknown, tenantId: string, roleId: string, expectedVersion: number, o: { actorId: string }): Promise<Row | undefined>;
  listRoleManageHolders(tx: unknown, tenantId: string): Promise<Holder[]>;
  listRoleHolders(tx: unknown, tenantId: string, roleId: string): Promise<Array<{ membershipId: string; userId: string }>>;
  revokeSessions(tx: unknown, tenantId: string, membershipIds: string[], reason: string, actorId?: string): Promise<number>;
  enqueueJob(tx: unknown, j: { taskIdentifier: string; payload: unknown; jobKey: string }): Promise<void>;
}

const MANAGE = 'identity.role.manage';
const REVOKE_REASON = 'role_change';
const SIGNOUT_TASK = 'identity.gotrue_signout';
const SIGNOUT_BATCH = 200;                                     // 03-APP-FLOW §4.3 / §9.2
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE_CODE = /^[a-z][a-z0-9_]{1,39}$/;
// [CONV] 300 = DB roles__text__ck (the contract says 500; a 301-500 description would otherwise be a 500 from the CHECK). CR: .orchestra/cr/T14.md (1).
const DESCRIPTION_MAX = 300;

type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

/** Default repo: SQL on the request tx. */
export function createRoleRepo(): RoleRepo {
  const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Tx).query(sql, params)).rows;
  const ROLE_SELECT = `SELECT r.id, r.role_code AS code, r.display_name, r.description, r.is_system_default, r.mfa_required, r.is_active, r.version,
      COALESCE((SELECT array_agg(p.permission_code ORDER BY p.permission_code) FROM core.role_permissions p
                WHERE p.tenant_id = r.tenant_id AND p.role_id = r.id), '{}'::text[]) AS permission_codes,
      (SELECT count(*)::int FROM core.membership_roles mr JOIN core.memberships m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id
        WHERE mr.tenant_id = r.tenant_id AND mr.role_id = r.id AND m.status <> 'deactivated') AS member_count
    FROM core.roles r WHERE r.tenant_id = $1 AND (r.id = $2::uuid OR $2::uuid IS NULL) AND (r.is_active = $3::boolean OR $3::boolean IS NULL)
    ORDER BY r.role_code`;
  const find = async (tx: unknown, t: string, id: string): Promise<Row | undefined> => (await q(tx, ROLE_SELECT, [t, id, null]))[0];
  const setPermissions = async (tx: unknown, t: string, id: string, codes: string[], actorId: string) => {
    await q(tx, `DELETE FROM core.role_permissions WHERE tenant_id = $1 AND role_id = $2`, [t, id]);
    await q(tx, `INSERT INTO core.role_permissions (tenant_id, role_id, permission_code, created_by)
      SELECT $1, $2, c, $4 FROM unnest($3::text[]) AS c`, [t, id, codes, actorId]);
  };
  return {
    listRoles: (tx, t, f) => q(tx, ROLE_SELECT, [t, null, f.isActive ?? null]),
    findRole: find,
    async insertRole(tx, t, r) {
      await q(tx, `INSERT INTO core.roles (id, tenant_id, role_code, display_name, description, mfa_required, created_by, updated_by)
        VALUES ($2, $1, $3, $4, $5, $6, $7, $7)`, [t, r.id, r.code, r.name, r.description ?? null, r.mfaRequired, r.actorId]);
      await setPermissions(tx, t, r.id, r.permissionCodes, r.actorId);
      return (await find(tx, t, r.id))!;
    },
    async updateRole(tx, t, id, v, p) {
      const hit = await q(tx, `UPDATE core.roles SET display_name = $4, description = $5, mfa_required = $6, version = version + 1, updated_at = now(), updated_by = $7
        WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`, [t, id, v, p.name, p.description ?? null, p.mfaRequired, p.actorId]);
      if (!hit.length) return undefined;
      await setPermissions(tx, t, id, p.permissionCodes, p.actorId);
      return find(tx, t, id);
    },
    async deactivateRole(tx, t, id, v, o) {
      const hit = await q(tx, `UPDATE core.roles SET is_active = false, version = version + 1, updated_at = now(), updated_by = $4
        WHERE tenant_id = $1 AND id = $2 AND version = $3 AND is_active RETURNING id`, [t, id, v, o.actorId]);
      return hit.length ? find(tx, t, id) : undefined;
    },
    async listRoleManageHolders(tx, t) {
      // ponytail: locks every active role row of the tenant so two concurrent "drop the other admin" changes serialise (A-17);
      // role edits are rare, a per-role lock set is the upgrade if this ever contends. The next statement takes a fresh snapshot.
      await q(tx, `SELECT id FROM core.roles WHERE tenant_id = $1 AND is_active ORDER BY id FOR UPDATE`, [t]);
      const rows = await q(tx, `SELECT m.id AS membership_id, m.user_id, m.actor_type, m.status, (m.locked_at IS NOT NULL) AS is_locked, mr.role_id
        FROM core.membership_roles mr
        JOIN core.memberships m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id
        JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
        JOIN core.role_permissions p ON p.tenant_id = mr.tenant_id AND p.role_id = mr.role_id AND p.permission_code = $2
        WHERE mr.tenant_id = $1 AND m.actor_type = 'user'`, [t, MANAGE]);
      return rows.map((x) => ({ membershipId: x.membership_id, userId: x.user_id, actorType: x.actor_type, status: x.status, isLocked: x.is_locked, roleId: x.role_id }));
    },
    async listRoleHolders(tx, t, id) {
      const rows = await q(tx, `SELECT m.id AS membership_id, m.user_id FROM core.membership_roles mr
        JOIN core.memberships m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id
        WHERE mr.tenant_id = $1 AND mr.role_id = $2`, [t, id]);
      return rows.map((x) => ({ membershipId: x.membership_id, userId: x.user_id }));
    },
    async revokeSessions(tx, t, ids, reason, actorId) {
      const rows = await q(tx, `UPDATE identity.sessions SET state = 'revoked', revoked_at = now(), revoked_by = $4, revoke_reason = $3,
          version = version + 1, updated_at = now(), updated_by = COALESCE($4, updated_by)
        WHERE tenant_id = $1 AND membership_id = ANY($2::uuid[]) AND state NOT IN ('revoked', 'expired') RETURNING id`, [t, ids, reason, actorId ?? null]);
      return rows.length;
    },
    async enqueueJob(tx, j) {
      await q(tx, 'SELECT app.enqueue_job($1, $2::jsonb, $3)', [j.taskIdentifier, JSON.stringify(j.payload), j.jobKey]);
    },
  };
}

// Permission phase is only in contracts/permissions.yaml (not in the generated constants); absent = "1".
let phases: ReadonlyMap<string, string> | undefined;
function phaseOf(code: string): string {
  phases ??= new Map(
    ((parse(readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8')) as { permissions?: Array<{ code: string; phase?: unknown }> }).permissions ?? [])
      .map((e) => [e.code, e.phase === undefined ? '1' : String(e.phase)]),
  );
  return phases.get(code) ?? '1';
}

const fail = (errors: Array<{ path: string; code?: string }>): never => {
  throw new LimsError('common.validation_failed', undefined, errors.map((e) => ({ path: e.path, code: e.code ?? 'common.field_invalid', message: 'Field invalid' }) satisfies FieldError));
};
const failAt = (path: string): never => fail([{ path }]);

function scope(ctx: RoleCtx, write = false) {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  if (write && typeof ctx.audit?.access !== 'function') throw new LimsError('common.internal');   // fail closed: no access log
  return { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
function expected(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) failAt('/If-Match');
  return v as number;
}
function roleIdOf(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new LimsError('common.not_found');
  return v;
}
/** Shared create/update field checks. Returns the stored permission set (de-duplicated) and the effective MFA flag (AC-B2.1). */
function fields(input: Record<string, unknown>) {
  const { name, description, mfaRequired, permissionCodes } = input;
  if (typeof name !== 'string' || name.length < 1 || name.length > 80) failAt('/name');
  if (description !== undefined && (typeof description !== 'string' || description.length > DESCRIPTION_MAX)) failAt('/description');
  if (typeof mfaRequired !== 'boolean') failAt('/mfa_required');
  if (!Array.isArray(permissionCodes) || permissionCodes.length < 1 || permissionCodes.length > 200) failAt('/permission_codes');
  const codes = permissionCodes as unknown[];
  const shape = codes.flatMap((c, i) => (typeof c === 'string' && c.length <= 100 ? [] : [{ path: `/permission_codes/${i}` }]));
  if (shape.length) fail(shape);
  const v = validateRolePermissions(codes as string[], mfaRequired as boolean);   // AC-B2.2 pointers /permissions/<i>
  if (!v.ok) return fail(v.errors.map((e) => ({ path: e.pointer, code: e.code })));
  return {
    name: name as string, ...(description === undefined ? {} : { description: description as string }),
    mfaRequired: v.mfaRequired, permissionCodes: [...new Set(codes as string[])],
  };
}
const toRole = (r: Row) => ({
  role_id: r.id, code: r.code, name: r.display_name, ...(r.description === null || r.description === undefined ? {} : { description: r.description }),
  is_default: r.is_system_default, mfa_required: r.mfa_required, permission_codes: [...r.permission_codes], member_count: r.member_count,
  is_active: r.is_active, version: r.version,
});
const sameSet = (a: readonly string[], b: readonly string[]) => { const s = new Set(a); const t = new Set(b); return s.size === t.size && [...s].every((x) => t.has(x)); };

export function createRoleService(deps: { repo?: RoleRepo } = {}) {
  const repo = deps.repo ?? createRoleRepo();

  async function load(s: ReturnType<typeof scope>, roleId: string): Promise<Row> {
    const row = await repo.findRole(s.tx, s.tenantId, roleId);
    if (!row) throw new LimsError('common.not_found');
    return row;
  }
  /** AC-B2.3: refuse when the change strips identity.role.manage from every remaining active, unlocked user membership. */
  async function guardLastAdmin(s: ReturnType<typeof scope>, roleId: string) {
    const admins = (await repo.listRoleManageHolders(s.tx, s.tenantId))
      .filter((h) => h.actorType === 'user' && h.status === 'active' && !h.isLocked);
    const losing = admins.some((h) => h.roleId === roleId);
    const remaining = admins.some((h) => h.roleId !== roleId);
    if (losing && !remaining) throw new LimsError('identity.last_admin_protected');
  }
  const logged = (ctx: RoleCtx, roleId: string) => ctx.audit!.access({ action: 'role.change', entityType: 'role', entityId: roleId, outcome: 'allowed' });

  return {
    async listPermissions(ctx: RoleCtx, _input: Record<string, unknown> = {}): Promise<Result> {
      scope(ctx);
      return {
        status: 200,
        body: { data: DEFAULT_REGISTRY.map((e) => ({ code: e.code, privileged: e.privileged, module: e.code.split('.')[0]!, phase: phaseOf(e.code), assignable: isAssignable(e.code) })) },
      };
    },

    async listRoles(ctx: RoleCtx, input: { isActive?: unknown } = {}): Promise<Result> {
      const s = scope(ctx);
      if (input?.isActive !== undefined && typeof input.isActive !== 'boolean') failAt('/is_active');
      const rows = await repo.listRoles(s.tx, s.tenantId, input?.isActive === undefined ? {} : { isActive: input.isActive as boolean });
      return { status: 200, body: { data: rows.map(toRole) } };
    },

    async getRole(ctx: RoleCtx, input: { roleId?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const row = await load(s, roleIdOf(input?.roleId));
      return { status: 200, body: toRole(row), version: row.version };
    },

    async createRole(ctx: RoleCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx, true);
      if (typeof input?.['code'] !== 'string' || !ROLE_CODE.test(input['code'])) failAt('/code');
      const f = fields(input);
      let row: Row;
      try {
        row = await repo.insertRole(s.tx, s.tenantId, { id: uuidv7(), code: input['code'] as string, ...f, actorId: s.actorId });
      } catch (e) {
        if ((e as { code?: unknown })?.code === '23505') throw new LimsError('identity.code_duplicate');
        throw e;
      }
      await logged(ctx, row.id);
      return { status: 201, body: toRole(row), version: row.version };
    },

    /** PUT semantics: name/description/permissions/mfa replaced (absent description clears it); code is immutable. */
    async updateRole(ctx: RoleCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx, true);
      const v = expected(input?.['expectedVersion']);
      const f = fields(input);
      const roleId = roleIdOf(input['roleId']);
      const cur = await load(s, roleId);
      if (cur.version !== v) throw new LimsError('common.version_conflict');
      if (cur.is_active && cur.permission_codes.includes(MANAGE) && !f.permissionCodes.includes(MANAGE)) await guardLastAdmin(s, roleId);
      const out = await repo.updateRole(s.tx, s.tenantId, roleId, v, { ...f, actorId: s.actorId });
      if (!out) throw new LimsError('common.version_conflict');
      if (!sameSet(cur.permission_codes, f.permissionCodes)) {
        // AC-B2.4 / SS9: revoke in this tx, then GoTrue sign-out jobs (batched) committed with it.
        const holders = await repo.listRoleHolders(s.tx, s.tenantId, roleId);
        if (holders.length) {
          await repo.revokeSessions(s.tx, s.tenantId, holders.map((h) => h.membershipId), REVOKE_REASON, s.actorId);
          const users = [...new Set(holders.map((h) => h.userId))];
          for (let i = 0; i < users.length; i += SIGNOUT_BATCH) {
            // [CONV] job_key signout:<role_id>.<version>.<batch>:role_change — one key per batch (02-TRD §10 names session/user ids for single sign-outs). CR: .orchestra/cr/T14.md (2).
            await repo.enqueueJob(s.tx, {
              taskIdentifier: SIGNOUT_TASK,
              payload: { tenant_id: s.tenantId, user_ids: users.slice(i, i + SIGNOUT_BATCH), reason: REVOKE_REASON },
              jobKey: `signout:${roleId}.${out.version}.${i / SIGNOUT_BATCH}:${REVOKE_REASON}`,
            });
          }
        }
      }
      await logged(ctx, roleId);
      return { status: 200, body: toRole(out), version: out.version };
    },

    async deactivateRole(ctx: RoleCtx, input: { roleId?: unknown; expectedVersion?: unknown }): Promise<Result> {
      const s = scope(ctx, true);
      const v = expected(input?.expectedVersion);
      const roleId = roleIdOf(input.roleId);
      const cur = await load(s, roleId);
      if (cur.version !== v) throw new LimsError('common.version_conflict');
      if (cur.is_system_default) throw new LimsError('common.version_conflict', 'default role');
      if (cur.is_active && cur.permission_codes.includes(MANAGE)) await guardLastAdmin(s, roleId);
      if (cur.member_count > 0) throw new LimsError('common.version_conflict', 'role has members');
      const out = await repo.deactivateRole(s.tx, s.tenantId, roleId, v, { actorId: s.actorId });
      if (!out) throw new LimsError('common.version_conflict');
      await logged(ctx, roleId);
      return { status: 200, body: toRole(out), version: out.version };
    },
  };
}
export type RoleService = ReturnType<typeof createRoleService>;
