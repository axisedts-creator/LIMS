// T13 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute:
//
//   ../user.service.ts  exports `createUserService(deps?: { repo?: UserRepo; gotrue?: Pick<GoTrueGateway,'adminCreateUser'>; userExists?: (tx, userId) => Promise<boolean>;
//                       emailHmac?: (emailNormalized: string) => Buffer; clearAccountFailures?: (emailNormalized: string) => Promise<void>; newId?: () => string; events?: { recordTenant(tx, e: AuthEvent): Promise<void> } })` (events absent -> sign-out paths fail closed common.internal; revokeSessions returns the revoked rows [{id,user_id}], one session_revoked auth event is recorded per row)
//                       -> { listUsers, searchUsers, inviteUser, getUser, updateUser, setUserRoles, setUserCentreScope, lockUser, unlockUser, deactivateUser,
//                            reactivateUser, resendInvitation, resetUserMfa, revokeUserSessions, uploadUserSignature }, each `(ctx, input) => Promise<{ status, body, version? }>`.
//                       The DEFAULT repo (SQL on ctx.tx, explicit `tenant_id = $n` on every statement) lives in user.service.ts and repository/{invitations,assets}.repo.ts;
//                       tests inject FakeRepo below. `userExists` = DEFINER app.identity_user_exists (03-APP-FLOW 4.2 step 2). `clearAccountFailures` = the L2 failure counter.
//   ctx = { tenantId, actor{type,id,membershipId}, requestId, tx, now(), audit.access(entry), commitOnError(), uploads, files, storage, download, log } (as T16).
//   inputs (camelCase): listUsers{status?,isLocked?,roleId?,centreId?,mfaEnrolled?,sort?,cursor?,limit?} · searchUsers{query,limit?}
//        · inviteUser{email,displayName,phoneE164?,roleIds,allCentres,centreIds?,branchIds?} · getUser{membershipId}
//        · updateUser{membershipId,expectedVersion|undefined,displayName?,phoneE164?,signatoryTitle?,signatoryRegistrationNo?,unset?}
//        · setUserRoles{membershipId,expectedVersion|undefined,roleIds} · setUserCentreScope{membershipId,expectedVersion|undefined,allCentres,centreIds?,branchIds?}
//        · lockUser / deactivateUser{membershipId,expectedVersion|undefined,reasonCode,reasonText?} · unlockUser / reactivateUser{membershipId,expectedVersion|undefined}
//        · resetUserMfa{membershipId,expectedVersion|undefined,reasonText} · resendInvitation{membershipId} · revokeUserSessions{membershipId}
//        · uploadUserSignature{membershipId,file:{filename,mimeType,bytes}}
//   expectedVersion undefined -> 428 common.precondition_required; 0 / non-integer -> 400 common.validation_failed (/If-Match); stale -> 409 common.version_conflict.
//   bodies = User / UserPage / RevokedCount / Empty of contracts/openapi/identity.yaml (additionalProperties:false, absent optionals OMITTED, never null).
//   Every membership write goes through `repo.updateMembership(tx, tenantId, id, expectedVersion|undefined, set, actorId)`: `set` is a map of core.memberships COLUMN names,
//   the write always bumps `version`, `false` = version mismatch. core.users columns (display_name, phone_e164) go through `repo.updateUserProfile`.
//   Exactly ONE `updateMembership` call per request (each call bumps `version` by 1, so a successful versioned write returns old version + 1). uploadUserSignature calls it with expectedVersion undefined.
//   Last-admin: the service calls `listRoleManageHolders` BEFORE the first write and counts only actor_type 'user', status 'active', not locked, via an active role.
//   The users API addresses actor_type = 'user' memberships ONLY: a partner / patient membership id behaves as not found (404), as another tenant's id does.
import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { makeCtx as makeUploadCtx } from './settings.helpers.js';

export { png, EICAR, incoming } from './settings.helpers.js';
export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1);
export const USER = idN(0xd1), MEM = idN(0xd2), REQ_ID = idN(0xe1);
export const NOW = '2026-11-08T06:00:00.000Z';
export const MANAGE = 'identity.role.manage';
export const R_ADMIN = idN(0x101), R_ADMIN2 = idN(0x102), R_FD = idN(0x103), R_INACTIVE = idN(0x104), R_B = idN(0x1b1);
export const C1 = idN(0x201), C2 = idN(0x202), C_INACTIVE = idN(0x203), C_B = idN(0x2b1), B1 = idN(0x301), B_INACTIVE = idN(0x302);
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

export type Role = { id: string; code: string; name: string; is_active: boolean; permission_codes: string[] };
export interface Member {
  id: string; tenant_id: string; user_id: string; actor_type: 'user' | 'patient' | 'partner'; status: 'invited' | 'active' | 'deactivated';
  display_name: string; email_normalized: string; phone_e164: string | null; all_centres: boolean; version: number;
  invited_at: string | null; accepted_at: string | null; deactivated_at: string | null; deactivated_by: string | null; deactivation_reason_code: string | null;
  locked_at: string | null; locked_by: string | null; lock_reason_code: string | null; lock_reason_text: string | null; last_login_at: string | null;
  signatory_display_title: string | null; signatory_registration_no: string | null; signature_image_ref: string | null;
  role_ids: string[]; centre_ids: string[]; branch_ids: string[]; mfa_enrolled: boolean; signature_asset_id: string | null;
  invitation: { status: string; expires_at: string } | null;
}
let seq = 0x700;
export const member = (o: Partial<Member> & { id: string }): Member => ({
  tenant_id: TENANT_A, user_id: o.id.replace(/.$/, '9'), actor_type: 'user', status: 'active', display_name: 'Demo User', email_normalized: 'demo.user.0001@example.test',
  phone_e164: null, all_centres: false, version: 1, invited_at: '2026-10-01T00:00:00.000Z', accepted_at: '2026-10-02T00:00:00.000Z', deactivated_at: null, deactivated_by: null,
  deactivation_reason_code: null, locked_at: null, locked_by: null, lock_reason_code: null, lock_reason_text: null, last_login_at: null, signatory_display_title: null,
  signatory_registration_no: null, signature_image_ref: null, role_ids: [R_FD], centre_ids: [C1], branch_ids: [], mfa_enrolled: false, signature_asset_id: null, invitation: null, ...o,
});
export const role = (id: string, o: Partial<Role> = {}): Role => ({ id, code: `role_${id.slice(-3)}`, name: `Role ${id.slice(-3)}`, is_active: true, permission_codes: ['identity.self.manage'], ...o });
export const adminRole = (id: string, o: Partial<Role> = {}): Role => role(id, { permission_codes: [MANAGE, 'identity.user.manage'], ...o });
export const ADMIN = idN(0xd2);   // = ctx.actor.membershipId

export type MemberView = Member & { roles: Array<{ role_id: string; code: string; name: string }> };
export interface Holder { membershipId: string; userId: string; actorType: string; status: string; isLocked: boolean; roleId: string }
export interface UserRepo {
  listUsers(tx: unknown, tenantId: string, q: { status?: string; isLocked?: boolean; roleId?: string; centreId?: string; mfaEnrolled?: boolean; sort: string; cursor?: string; limit: number }): Promise<{ rows: MemberView[]; nextCursor?: string }>;
  searchUsers(tx: unknown, tenantId: string, q: { query: string; limit: number }): Promise<MemberView[]>;
  findMember(tx: unknown, tenantId: string, id: string): Promise<MemberView | undefined>;
  findRolesByIds(tx: unknown, tenantId: string, ids: string[]): Promise<Role[]>;
  findCentresByIds(tx: unknown, tenantId: string, ids: string[]): Promise<Array<{ id: string; is_active: boolean }>>;
  findBranchesByIds(tx: unknown, tenantId: string, ids: string[]): Promise<Array<{ id: string; is_active: boolean }>>;
  /** one row per (membership, ACTIVE role granting identity.role.manage) of ALL actor types/statuses; the SERVICE decides what counts as "another admin". Locks the role rows first (T14 convention). */
  listRoleManageHolders(tx: unknown, tenantId: string): Promise<Holder[]>;
  insertUser(tx: unknown, tenantId: string, u: { id: string; displayName: string; emailNormalized: string; emailHmac: Buffer; phoneE164?: string; actorId: string }): Promise<void>;
  insertMembership(tx: unknown, tenantId: string, m: { id: string; userId: string; allCentres: boolean; invitedAt: string; actorId: string }): Promise<void>;
  updateMembership(tx: unknown, tenantId: string, id: string, expectedVersion: number | undefined, set: Record<string, unknown>, actorId: string): Promise<boolean>;
  updateUserProfile(tx: unknown, tenantId: string, userId: string, set: { display_name?: string; phone_e164?: string | null }, actorId: string): Promise<void>;
  replaceRoles(tx: unknown, tenantId: string, membershipId: string, roleIds: string[], actorId: string): Promise<void>;
  replaceScope(tx: unknown, tenantId: string, membershipId: string, s: { centreIds: string[]; branchIds: string[] }, actorId: string): Promise<void>;
  insertInvitation(tx: unknown, tenantId: string, i: { id: string; membershipId: string; userId: string; email: string; expiresAt: Date; actorId: string }): Promise<void>;
  revokeOpenInvitations(tx: unknown, tenantId: string, membershipId: string, actorId: string): Promise<void>;
  revokeSessions(tx: unknown, tenantId: string, a: { membershipId: string; userId: string; reason: string; actorId: string }): Promise<Array<{ id: string; user_id: string }>>;
  removeMfaFactors(tx: unknown, tenantId: string, a: { userId: string; actorId: string }): Promise<number>;
  insertSignatureAsset(tx: unknown, tenantId: string, a: { id: string; membershipId: string; bucket: string; objectPath: string; contentType: string; sizeBytes: number; widthPx: number; heightPx: number; sha256: string; scanState: string; actorId: string }): Promise<void>;
  deactivateOtherSignatureAssets(tx: unknown, tenantId: string, membershipId: string, keepId: string, actorId: string): Promise<void>;
  enqueue(tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void>;
}

export interface Seed { members?: Member[]; roles?: Role[]; centres?: Array<{ id: string; tenant_id: string; is_active: boolean }>; branches?: Array<{ id: string; tenant_id: string; is_active: boolean }> }
export const defaultSeed = (): Seed => ({
  roles: [adminRole(R_ADMIN), adminRole(R_ADMIN2), role(R_FD), role(R_INACTIVE, { is_active: false }), adminRole(R_B)],
  members: [member({ id: ADMIN, user_id: USER, role_ids: [R_ADMIN], display_name: 'Demo Admin', email_normalized: 'demo.admin@example.test' })],
  centres: [{ id: C1, tenant_id: TENANT_A, is_active: true }, { id: C2, tenant_id: TENANT_A, is_active: true }, { id: C_INACTIVE, tenant_id: TENANT_A, is_active: false }, { id: C_B, tenant_id: TENANT_B, is_active: true }],
  branches: [{ id: B1, tenant_id: TENANT_A, is_active: true }, { id: B_INACTIVE, tenant_id: TENANT_A, is_active: false }],
});

export interface Job { identifier: string; payload: Record<string, any>; jobKey: string }
/** In-memory UserRepo. `calls` = every call (method, tx, tenantId, args) in order; `writes` = names of mutating calls in order. RLS is simulated: other tenants' rows are invisible. */
export function makeRepo(seed: Seed = defaultSeed(), tenantId = TENANT_A) {
  const st = {
    members: (seed.members ?? []).map((m) => ({ ...m, role_ids: [...m.role_ids], centre_ids: [...m.centre_ids], branch_ids: [...m.branch_ids] })),
    roles: (seed.roles ?? []).map((r) => ({ ...r, permission_codes: [...r.permission_codes] })),
    centres: seed.centres ?? [], branches: seed.branches ?? [],
    users: [] as Array<Record<string, any>>, invitations: [] as Array<Record<string, any>>, assets: [] as Array<Record<string, any>>,
    jobs: [] as Job[], sessionsRevoked: [] as Array<Record<string, any>>, mfaRemoved: [] as Array<Record<string, any>>, profileWrites: [] as Array<Record<string, any>>,
    membershipWrites: [] as Array<{ id: string; expectedVersion: number | undefined; set: Record<string, unknown>; actorId: string }>,
  };
  const calls: Array<{ m: string; tx: unknown; tenantId: string; args: unknown[] }> = [];
  const writes: string[] = [];
  const fail: Record<string, Error | undefined> = {};
  const rec = (m: string, tx: unknown, t: string, ...args: unknown[]) => { calls.push({ m, tx, tenantId: t, args }); if (fail[m]) throw fail[m]; };
  const w = (m: string) => writes.push(m);
  const mine = (t: string) => st.members.filter((m) => m.tenant_id === t && m.actor_type === 'user');
  const view = (m: Member | undefined): MemberView | undefined => m && { ...m, roles: m.role_ids.map((rid) => { const r = st.roles.find((x) => x.id === rid); return { role_id: rid, code: r?.code ?? 'unknown', name: r?.name ?? 'Unknown' }; }), role_ids: [...m.role_ids], centre_ids: [...m.centre_ids], branch_ids: [...m.branch_ids] };
  const repo: UserRepo & Record<string, any> = {
    async listUsers(tx, t, q) {
      rec('listUsers', tx, t, q);
      const rows = mine(t).filter((m) => (q.status === undefined || m.status === q.status) && (q.isLocked === undefined || (m.locked_at !== null) === q.isLocked)
        && (q.roleId === undefined || m.role_ids.includes(q.roleId)) && (q.centreId === undefined || m.centre_ids.includes(q.centreId)) && (q.mfaEnrolled === undefined || m.mfa_enrolled === q.mfaEnrolled));
      return { rows: rows.slice(0, q.limit).map((m) => view(m)!), ...(rows.length > q.limit ? { nextCursor: 'Y3Vyc29y' } : {}) };
    },
    async searchUsers(tx, t, q) { rec('searchUsers', tx, t, q); return mine(t).filter((m) => m.display_name.toLowerCase().includes(q.query.toLowerCase()) || m.email_normalized.startsWith(q.query.toLowerCase())).slice(0, q.limit).map((m) => view(m)!); },
    async findMember(tx, t, id) { rec('findMember', tx, t, id); return view(mine(t).find((m) => m.id === id)); },
    async findRolesByIds(tx, t, ids) { rec('findRolesByIds', tx, t, ids); return st.roles.filter((r) => ids.includes(r.id) && r.id !== R_B).map((r) => ({ ...r })); },
    async findCentresByIds(tx, t, ids) { rec('findCentresByIds', tx, t, ids); return st.centres.filter((c) => c.tenant_id === t && ids.includes(c.id)).map(({ id, is_active }) => ({ id, is_active })); },
    async findBranchesByIds(tx, t, ids) { rec('findBranchesByIds', tx, t, ids); return st.branches.filter((c) => c.tenant_id === t && ids.includes(c.id)).map(({ id, is_active }) => ({ id, is_active })); },
    async listRoleManageHolders(tx, t) {
      rec('listRoleManageHolders', tx, t);
      return st.members.filter((m) => m.tenant_id === t).flatMap((m) => m.role_ids.filter((rid) => { const r = st.roles.find((x) => x.id === rid); return !!r && r.is_active && r.permission_codes.includes(MANAGE); })
        .map((rid) => ({ membershipId: m.id, userId: m.user_id, actorType: m.actor_type, status: m.status, isLocked: m.locked_at !== null, roleId: rid })));
    },
    async insertUser(tx, t, u) { rec('insertUser', tx, t, u); w('insertUser'); st.users.push({ ...u, tenantId: t }); },
    async insertMembership(tx, t, m) {
      rec('insertMembership', tx, t, m); w('insertMembership');
      st.members.push(member({ id: m.id, tenant_id: t, user_id: m.userId, status: 'invited', all_centres: m.allCentres, invited_at: m.invitedAt, accepted_at: null, role_ids: [], centre_ids: [], display_name: st.users.find((u) => u.id === m.userId)?.displayName ?? 'x', email_normalized: st.users.find((u) => u.id === m.userId)?.emailNormalized ?? 'x@example.test' }));
    },
    async updateMembership(tx, t, id, v, set, actorId) {
      rec('updateMembership', tx, t, id, v, set, actorId); w('updateMembership');
      const m = mine(t).find((x) => x.id === id); if (!m || (v !== undefined && m.version !== v)) return false;
      Object.assign(m, set); m.version += 1; st.membershipWrites.push({ id, expectedVersion: v, set: { ...set }, actorId }); return true;
    },
    async updateUserProfile(tx, t, userId, set, actorId) {
      rec('updateUserProfile', tx, t, userId, set, actorId); w('updateUserProfile'); st.profileWrites.push({ userId, set: { ...set } });
      for (const m of st.members.filter((x) => x.tenant_id === t && x.user_id === userId)) { if (set.display_name !== undefined) m.display_name = set.display_name; if (set.phone_e164 !== undefined) m.phone_e164 = set.phone_e164; }
    },
    async replaceRoles(tx, t, id, roleIds, actorId) { rec('replaceRoles', tx, t, id, roleIds, actorId); w('replaceRoles'); const m = mine(t).find((x) => x.id === id); if (m) m.role_ids = [...roleIds]; },
    async replaceScope(tx, t, id, s, actorId) { rec('replaceScope', tx, t, id, s, actorId); w('replaceScope'); const m = mine(t).find((x) => x.id === id); if (m) { m.centre_ids = [...s.centreIds]; m.branch_ids = [...s.branchIds]; } },
    async insertInvitation(tx, t, i) {
      rec('insertInvitation', tx, t, i); w('insertInvitation'); st.invitations.push({ ...i, tenantId: t, status: 'pending' });
      const m = mine(t).find((x) => x.id === i.membershipId); if (m) m.invitation = { status: 'pending', expires_at: i.expiresAt.toISOString() };
    },
    async revokeOpenInvitations(tx, t, id, actorId) { rec('revokeOpenInvitations', tx, t, id, actorId); w('revokeOpenInvitations'); for (const i of st.invitations) if (i.membershipId === id && ['pending', 'sent'].includes(i.status)) i.status = 'revoked'; const m = mine(t).find((x) => x.id === id); if (m?.invitation) m.invitation = { ...m.invitation, status: 'revoked' }; },
    async revokeSessions(tx, t, a) { rec('revokeSessions', tx, t, a); w('revokeSessions'); st.sessionsRevoked.push({ ...a }); return [{ id: idN(0x5001), user_id: a.userId }, { id: idN(0x5002), user_id: a.userId }]; },   // RETURNING id, user_id: two live sessions
    async removeMfaFactors(tx, t, a) { rec('removeMfaFactors', tx, t, a); w('removeMfaFactors'); st.mfaRemoved.push({ ...a }); for (const m of st.members) if (m.user_id === a.userId) m.mfa_enrolled = false; return 1; },
    async insertSignatureAsset(tx, t, a) { rec('insertSignatureAsset', tx, t, a); w('insertSignatureAsset'); st.assets.push({ ...a, tenantId: t, is_active: true }); const m = mine(t).find((x) => x.id === a.membershipId); if (m) m.signature_asset_id = a.id; },
    async deactivateOtherSignatureAssets(tx, t, id, keep, actorId) { rec('deactivateOtherSignatureAssets', tx, t, id, keep, actorId); w('deactivateOtherSignatureAssets'); for (const a of st.assets) if (a.membershipId === id && a.id !== keep) a.is_active = false; },
    async enqueue(tx, identifier, payload, jobKey) { rec('enqueue', tx, '', identifier, payload, jobKey); w('enqueue'); st.jobs.push({ identifier, payload, jobKey }); },
  };
  return { repo, st, calls, writes, fail, tenantId, by: (m: string) => calls.filter((c) => c.m === m), row: (id: string) => st.members.find((m) => m.id === id)!, jobs: (id: string) => st.jobs.filter((j) => j.identifier === id) };
}
export type FakeRepo = ReturnType<typeof makeRepo>;

export function makeGotrue(o: { existing?: Set<string>; fail?: Error } = {}) {
  let n = 0; const created: Array<{ email: string; emailConfirm: boolean }> = [];
  const gotrue = { adminCreateUser: vi.fn(async (i: { email: string; emailConfirm: boolean }) => {
    if (o.fail) throw o.fail;
    if (o.existing?.has(i.email)) return { exists: true as const, userId: idN(0xa000 + 99) };
    created.push(i); return { userId: idN(0xa000 + ++n) };
  }) };
  return { gotrue, created };
}

/** Everything a service test needs; `svc` is built by the test (`createUserService(deps)`), deps are returned for assertions. */
export async function makeDeps(o: { seed?: Seed; gotrue?: Parameters<typeof makeGotrue>[0]; userExists?: boolean } = {}) {
  const fake = makeRepo(o.seed);
  const g = makeGotrue(o.gotrue);
  const userExists = vi.fn(async (_tx: unknown, _id: string) => o.userExists ?? false);
  const clearAccountFailures = vi.fn(async (_email: string) => undefined);
  const emailHmac = vi.fn((e: string) => Buffer.alloc(32, e.length));
  let n = 0x9000; const newId = () => idN(n++);
  const base = await makeUploadCtx({ tenantId: TENANT_A });
  const ctx: any = { ...base.ctx, actor: { type: 'user', id: USER, membershipId: ADMIN }, tx: { __tx: 'T13-request-tx', query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } };
  const authEvents: Array<Record<string, any>> = [];   // auth events recorded through deps.events.recordTenant (03-APP-FLOW 2.1 SS9: session_revoked per revoked session)
  const events = { recordTenant: vi.fn(async (_tx: unknown, e: Record<string, any>) => { authEvents.push(e); }) };
  const deps = { repo: fake.repo, gotrue: g.gotrue, userExists, emailHmac, clearAccountFailures, newId, events };
  return { fake, g, deps, ctx, events, authEvents, access: base.ctx.audit.access, userExists, clearAccountFailures, emailHmac, mode: base.mode, scan: base.scan, storageKeys: base.storageKeys, raw: base.raw };
}

// ---------------------------------------------------------------------------------------------- wire-shape check against contracts/openapi/identity.yaml
const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
export const schemaOf = (name: string): any => spec.components.schemas[name];
export function assertWire(body: any, name: 'User' | 'UserSummary'): void {
  const s = schemaOf(name); const keys = Object.keys(body);
  for (const k of s.required) if (!keys.includes(k)) throw new Error(`${name}: missing required ${k}`);
  for (const k of keys) { if (!(k in s.properties)) throw new Error(`${name}: unknown key ${k}`); if (body[k] === null) throw new Error(`${name}: null at ${k} (omit absent optionals)`); }
  if (!['invited', 'active', 'deactivated'].includes(body.status)) throw new Error(`${name}: bad status`);
}
export const nextSeq = () => seq++;
