// T14 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open — the writer must match them or raise a dispute:
//
//   ../role.service.ts   exports `createRoleService(deps?: { repo?: RoleRepo })` -> { listPermissions, listRoles, createRole, getRole, updateRole, deactivateRole },
//                        each `(ctx, input) => Promise<{ status, body, version? }>` (same convention as instruments agents.service). T14 owns no repository file, so the
//                        DEFAULT repo (SQL on ctx.tx, explicit `tenant_id = $n` on every statement) lives inside role.service.ts; tests inject FakeRepo below.
//   ctx = { tenantId, actor{type,id,membershipId}, requestId, tx, audit:{ access(entry) } }  — tenant and actor come ONLY from ctx, never from input.
//   inputs (camelCase): listPermissions{} · listRoles{isActive?} · createRole{code,name,description?,permissionCodes,mfaRequired}
//        · getRole{roleId} · updateRole{roleId,expectedVersion|undefined,name,description?,permissionCodes,mfaRequired} · deactivateRole{roleId,expectedVersion|undefined}
//   expectedVersion undefined -> 428 common.precondition_required; 0 / non-integer -> 400 common.validation_failed (/If-Match); stale -> 409 common.version_conflict.
//   body = the `Role` schema of contracts/openapi/identity.yaml (role_id, code, name, description?, is_default, mfa_required, permission_codes, member_count, is_active, version).
//   handlers: ../handlers/{listPermissions,listRoles,createRole,getRole,updateRole,deactivateRole}.ts wired into handlers/index.ts (ETag = `"<version>"`).
import { vi } from 'vitest';

export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1);
export const USER = idN(0xd1), MEM = idN(0xd2), REQ_ID = idN(0xe1);
export const R_ADMIN = idN(0x101), R_ADMIN2 = idN(0x102), R_FD = idN(0x103), R_B = idN(0x1b1), R_INACTIVE = idN(0x104);
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

export const MANAGE = 'identity.role.manage';
export type Row = {
  id: string; code: string; display_name: string; description: string | null; is_system_default: boolean; mfa_required: boolean;
  is_active: boolean; version: number; permission_codes: string[]; member_count: number;
};
export type Mem = { id: string; userId: string; actorType: 'user' | 'patient' | 'partner'; status: 'invited' | 'active' | 'deactivated'; locked: boolean; roleIds: string[] };
export interface Holder { membershipId: string; userId: string; actorType: string; status: string; isLocked: boolean; roleId: string }

/** RoleRepo seam. Every method takes (tx, tenantId, ...). The in-memory fake below records `calls` (method, tx, tenantId) and mutations in `writes`. */
export interface RoleRepo {
  listRoles(tx: unknown, tenantId: string, q: { isActive?: boolean }): Promise<Row[]>;
  /** RLS-invisible / other tenant -> undefined */
  findRole(tx: unknown, tenantId: string, roleId: string): Promise<Row | undefined>;
  /** duplicate (tenant_id, role_code) -> throws an error with `code: '23505'` */
  insertRole(tx: unknown, tenantId: string, r: { id: string; code: string; name: string; description?: string; mfaRequired: boolean; permissionCodes: string[]; actorId: string }): Promise<Row>;
  /** undefined = version mismatch */
  updateRole(tx: unknown, tenantId: string, roleId: string, expectedVersion: number, p: { name: string; description?: string; mfaRequired: boolean; permissionCodes: string[]; actorId: string }): Promise<Row | undefined>;
  deactivateRole(tx: unknown, tenantId: string, roleId: string, expectedVersion: number, o: { actorId: string }): Promise<Row | undefined>;
  /** one row per (user-type membership, ACTIVE role granting identity.role.manage); the SERVICE decides what counts as "another admin". */
  listRoleManageHolders(tx: unknown, tenantId: string): Promise<Holder[]>;
  /** memberships holding the role (any status) -> session fan-out targets */
  listRoleHolders(tx: unknown, tenantId: string, roleId: string): Promise<Array<{ membershipId: string; userId: string }>>;
  revokeSessions(tx: unknown, tenantId: string, membershipIds: string[], reason: string): Promise<number>;
  enqueueJob(tx: unknown, j: { taskIdentifier: string; payload: unknown; jobKey: string }): Promise<void>;
}

export const role = (o: Partial<Row> & { id: string; code: string }): Row => ({
  display_name: o.code, description: null, is_system_default: false, mfa_required: false, is_active: true, version: 1,
  permission_codes: ['identity.self.manage'], member_count: 0, ...o,
});
export const mem = (o: Partial<Mem> & { id: string }): Mem => ({ userId: o.id.replace(/.$/, '9'), actorType: 'user', status: 'active', locked: false, roleIds: [], ...o });

export function makeRepo(seed: { roles?: Record<string, Row[]>; mems?: Record<string, Mem[]> } = {}) {
  const state = {
    roles: new Map<string, Row[]>(Object.entries(seed.roles ?? { [TENANT_A]: [], [TENANT_B]: [] }).map(([k, v]) => [k, v.map((r) => ({ ...r, permission_codes: [...r.permission_codes] }))])),
    mems: new Map<string, Mem[]>(Object.entries(seed.mems ?? {}).map(([k, v]) => [k, v.map((m) => ({ ...m, roleIds: [...m.roleIds] }))])),
  };
  const calls: Array<{ m: string; tx: unknown; tenantId: string; args: unknown[] }> = [];
  const writes: string[] = [];
  const fail: Record<string, Error | undefined> = {};
  const rolesOf = (t: string) => state.roles.get(t) ?? [];
  const memsOf = (t: string) => state.mems.get(t) ?? [];
  const count = (t: string, id: string) => memsOf(t).filter((m) => m.status !== 'deactivated' && m.roleIds.includes(id)).length;
  const view = (t: string, r: Row): Row => ({ ...r, permission_codes: [...r.permission_codes], member_count: count(t, r.id) });
  const rec = (m: string, tx: unknown, tenantId: string, ...args: unknown[]) => { calls.push({ m, tx, tenantId, args }); if (fail[m]) throw fail[m]; };
  const w = (m: string) => writes.push(m);
  const repo: RoleRepo = {
    async listRoles(tx, t, q) { rec('listRoles', tx, t, q); return rolesOf(t).filter((r) => q.isActive === undefined || r.is_active === q.isActive).map((r) => view(t, r)); },
    async findRole(tx, t, id) { rec('findRole', tx, t, id); const r = rolesOf(t).find((x) => x.id === id); return r && view(t, r); },
    async insertRole(tx, t, r) {
      rec('insertRole', tx, t, r); w('insertRole');
      if (rolesOf(t).some((x) => x.code === r.code)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      const row = role({ id: r.id, code: r.code, display_name: r.name, description: r.description ?? null, mfa_required: r.mfaRequired, permission_codes: [...r.permissionCodes] });
      state.roles.set(t, [...rolesOf(t), row]); return view(t, row);
    },
    async updateRole(tx, t, id, v, p) {
      rec('updateRole', tx, t, id, v, p); w('updateRole');
      const r = rolesOf(t).find((x) => x.id === id); if (!r || r.version !== v) return undefined;
      Object.assign(r, { display_name: p.name, description: p.description ?? null, mfa_required: p.mfaRequired, permission_codes: [...p.permissionCodes], version: r.version + 1 }); return view(t, r);
    },
    async deactivateRole(tx, t, id, v, o) {
      rec('deactivateRole', tx, t, id, v, o); w('deactivateRole');
      const r = rolesOf(t).find((x) => x.id === id); if (!r || r.version !== v) return undefined;
      Object.assign(r, { is_active: false, version: r.version + 1 }); return view(t, r);
    },
    async listRoleManageHolders(tx, t) {
      rec('listRoleManageHolders', tx, t);
      return memsOf(t).filter((m) => m.actorType === 'user').flatMap((m) => m.roleIds
        .filter((rid) => { const r = rolesOf(t).find((x) => x.id === rid); return !!r && r.is_active && r.permission_codes.includes(MANAGE); })
        .map((rid) => ({ membershipId: m.id, userId: m.userId, actorType: m.actorType, status: m.status, isLocked: m.locked, roleId: rid })));
    },
    async listRoleHolders(tx, t, id) { rec('listRoleHolders', tx, t, id); return memsOf(t).filter((m) => m.roleIds.includes(id)).map((m) => ({ membershipId: m.id, userId: m.userId })); },
    async revokeSessions(tx, t, ids, reason) { rec('revokeSessions', tx, t, ids, reason); w('revokeSessions'); return ids.length; },
    async enqueueJob(tx, j) { rec('enqueueJob', tx, '', j); w('enqueueJob'); },
  };
  return { repo, state, calls, writes, fail, roleRow: (t: string, id: string) => rolesOf(t).find((r) => r.id === id) };
}

export function makeCtx(o: { tenantId?: string } = {}) {
  const access = vi.fn(async (_e: Record<string, unknown>) => undefined);
  const tx = { __tx: 'T14-request-tx', query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const ctx = { tenantId: o.tenantId ?? TENANT_A, actor: { type: 'user', id: USER, membershipId: MEM }, requestId: REQ_ID, tx, audit: { access } };
  return { ctx, access, tx };
}
