// T22 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute (same convention as support.helpers.ts):
//
//   ../tenant.service.ts   exports `createTenantService(deps?: { repo?: TenantRepo; gotrue?: Pick<GoTrueGateway,'adminCreateUser'>; emailHmac?: (e: string) => Buffer;
//                          userExists?: (tx, userId) => Promise<boolean>; newId?: () => string })` -> 12 ops `(ctx, input) => Promise<{ status, body, version? }>`:
//                          listTenants, provisionTenant, getTenant, updateTenant, activateTenant, suspendTenant, reactivateTenant, terminateTenant,
//                          getTenantSettingsAsPlatform, updateTenantSettingsAsPlatform, setFeatureFlagAsPlatform, inviteTenantAdmin.
//                          Every op calls PlatformAuthz.assertPlatform(ctx, 'platform.tenant.read' | 'platform.tenant.manage') ITSELF before any repo/gotrue call (T21 convention).
//   ctx (platform request ctx, 08 CR-C2-004) = { actor{type:'user',id}, platformRole, platformStaffId, platformSessionId, aal, requestId, clientIp, tx, now(), db{withTenantScope(tx,tenantId,fn)}, log }. NO tenantId.
//   inputs are camelCase; bodies are snake_case wire shapes of contracts/openapi/identity.yaml (additionalProperties:false, no nulls: absent optionals OMITTED).
//   ASSUMED wire/inputs for LD-26 / LD-29 (contract has none yet -> CR): provisionTenant input `trainingMode?: boolean` (wire training_mode) and
//   `contractAcceptance: { tos: Acc, dpa: Acc }` (wire contract_acceptance), Acc = { version<=32, acceptedByName 1-120, acceptedByTitle 1-80, acceptedAt ISO }.
//   TenantRepo (below) = the SQL seam. Platform-claims methods may run anywhere; SCOPED methods require an open ctx.db.withTenantScope(newOrTargetTenant) window (the fake throws, like RLS).
//   terminateTenant: `deactivateMemberships` must be given by = ctx.actor.id (the human platform staff user, claims sub) - NEVER the identity system actor that withTenantScope runs under (08 A9.5, D-T13).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';

export const idN = (n: number) => `0190b000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1), STAFF_USER = idN(0xd1), STAFF_ID = idN(0xd2), PSESSION = idN(0xe2), REQ_ID = idN(0xe1), SYS = idN(0xf1);
export const NOW = new Date('2026-11-11T06:00:00.000Z');
export const rejection = async (p: unknown): Promise<any> => { try { await (typeof p === 'function' ? (p as () => unknown)() : p); } catch (e) { return e; } throw new Error('expected rejection, got success'); };
export const ROLE_CODES: string[] = (parse(readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8')).roles as Array<{ code: string }>).map((r) => r.code);

export type Status = 'provisioning' | 'active' | 'suspended' | 'offboarded';
export interface TRow {
  id: string; code: string; legal_name: string; display_name: string; status: Status; timezone: string; status_reason: string | null; activated_at: Date | null;
  suspended_at: Date | null; offboarded_at: Date | null; billing_live_on: string | null; created_at: Date; version: number;
}
export const trow = (o: Partial<TRow> & { id: string }): TRow => ({
  code: 'synthetic_alpha', legal_name: 'Synthetic Alpha Lab Pvt. Ltd.', display_name: 'Synthetic Alpha', status: 'active', timezone: 'Asia/Kathmandu', status_reason: null,
  activated_at: NOW, suspended_at: null, offboarded_at: null, billing_live_on: null, created_at: NOW, version: 3, ...o,
});
export interface Member { id: string; user_id: string; status: 'invited' | 'active' | 'deactivated'; roles: string[]; deactivated_at: Date | null; deactivated_by: string | null; deactivation_reason_code: string | null; accepted: boolean }
export interface TenantData {
  branches: Array<{ id: string; code: string; active: boolean }>; centres: Array<{ id: string; code: string; active: boolean }>; roles: string[]; settings: Record<string, any> | null;
  flags: Array<{ code: string; requires_founder_approval: boolean; is_enabled: boolean; approval_ref: string | null }>; annexes: Array<{ annex_code: string; status: string }>;
  acceptances: Array<Record<string, any>>; members: Member[]; invitations: Array<Record<string, any>>; sessions: Array<{ id: string; user_id: string; state: string; revoke_reason?: string }>;
  accessLog: Array<Record<string, any>>;
}
const emptyData = (): TenantData => ({ branches: [], centres: [], roles: [], settings: null, flags: [], annexes: [], acceptances: [], members: [], invitations: [], sessions: [], accessLog: [] });
export const member = (o: Partial<Member> & { id: string }): Member => ({ user_id: idN(0x5000 + parseInt(o.id.slice(-4), 16)), status: 'active', roles: ['tenant_admin'], deactivated_at: null, deactivated_by: null, deactivation_reason_code: null, accepted: true, ...o });
export const FLAG_FOUNDER = 'synthetic_founder_flag', FLAG_PLAIN = 'synthetic_plain_flag';
/** tenant A with the minimum for activation (accepted admin, branch, centre) + two members + three sessions; tenant B with one active member. */
export function seedA(status: Status = 'active'): { tenant: TRow; data: TenantData } {
  const d = emptyData();
  d.branches.push({ id: idN(0x101), code: 'KTM-01', active: true }); d.centres.push({ id: idN(0x102), code: 'C000000001', active: true });
  d.members.push(member({ id: idN(0x201) }), member({ id: idN(0x202), roles: ['front_desk'] }), member({ id: idN(0x203), status: 'deactivated', deactivated_at: new Date('2026-10-01T00:00:00Z'), deactivated_by: idN(0x9001), deactivation_reason_code: 'security_concern' }));
  d.sessions.push({ id: idN(0x301), user_id: d.members[0]!.user_id, state: 'active' }, { id: idN(0x302), user_id: d.members[1]!.user_id, state: 'active' }, { id: idN(0x303), user_id: d.members[0]!.user_id, state: 'active' });
  d.settings = { timezone: 'Asia/Kathmandu', training_mode: false, version: 2, idle_timeout_minutes: 30 };
  d.flags.push({ code: FLAG_FOUNDER, requires_founder_approval: true, is_enabled: false, approval_ref: null }, { code: FLAG_PLAIN, requires_founder_approval: false, is_enabled: false, approval_ref: null });
  return { tenant: trow({ id: TENANT_A, status }), data: d };
}
export const seedB = () => { const d = emptyData(); d.members.push(member({ id: idN(0x401) })); d.sessions.push({ id: idN(0x402), user_id: d.members[0]!.user_id, state: 'active' }); d.branches.push({ id: idN(0x403), code: 'PKR-01', active: true }); d.centres.push({ id: idN(0x404), code: 'C000000009', active: true }); return { tenant: trow({ id: TENANT_B, code: 'synthetic_beta', status: 'active' }), data: d }; };

export interface Readiness { acceptedAdmins: number; activeBranches: number; activeCentres: number }
/** The SQL seam. `tx` first everywhere; scoped methods take tenantId second. */
export interface TenantRepo {
  findByCode(tx: unknown, code: string): Promise<TRow | undefined>;
  find(tx: unknown, id: string): Promise<TRow | undefined>;
  list(tx: unknown, f: { status?: string; sort?: string; cursor?: string; limit?: number }): Promise<TRow[]>;
  insert(tx: unknown, a: { id: string; code: string; legalName: string; displayName: string; pan?: string; timezone: string; actorId: string }): Promise<TRow>;
  update(tx: unknown, id: string, expectedVersion: number, p: { legalName?: string; displayName?: string; billingLiveOn?: string | null; actorId: string }): Promise<TRow | undefined>;
  setStatus(tx: unknown, id: string, expectedVersion: number, p: { status: Status; reason?: string; at: Date; actorId: string }): Promise<TRow | undefined>;
  detail(tx: unknown, id: string): Promise<{ counts: { users: number; branches: number; centres: number }; history: Array<{ from?: string; to: string; at: Date }>; annexReadiness: 'complete' | 'incomplete' }>;
  readiness(tx: unknown, id: string): Promise<Readiness>;
  // ---- SCOPED (inside ctx.db.withTenantScope(tenantId)) ----
  insertBranch(tx: unknown, t: string, b: { id: string; code: string; name: string; addressText?: string; actorId: string }): Promise<void>;
  insertCentre(tx: unknown, t: string, c: { id: string; code: string; name: string; kind: string; branchId: string; addressText?: string; actorId: string }): Promise<void>;
  seedRoles(tx: unknown, t: string, roleCodes: readonly string[], actorId: string): Promise<void>;
  insertSettings(tx: unknown, t: string, s: { timezone: string; calendarDisplay?: string; pan?: string; legalName: string; displayName: string; trainingMode: boolean; actorId: string }): Promise<void>;
  seedFlags(tx: unknown, t: string, actorId: string): Promise<void>;
  seedIrdAnnexes(tx: unknown, t: string, annexCodes: readonly string[], actorId: string): Promise<void>;
  insertAcceptances(tx: unknown, t: string, rows: Array<{ document: 'tos' | 'dpa'; version: string; acceptedByName: string; acceptedByTitle: string; acceptedAt: string; actorId: string }>): Promise<void>;
  insertAdmin(tx: unknown, t: string, a: { userId: string; membershipId: string; displayName: string; emailNormalized: string; emailHmac: Buffer; actorId: string }): Promise<void>;
  insertInvitation(tx: unknown, t: string, i: { id: string; membershipId: string; userId: string; email: string; expiresAt: Date; actorId: string }): Promise<void>;
  accessLog(tx: unknown, t: string, e: { action: string; entityType: string; entityId: string; outcome: 'allowed'; detail?: Record<string, string | number | boolean> }): Promise<void>;
  revokeTenantSessions(tx: unknown, t: string, o: { reason: string; actorId: string }): Promise<string[]>;           // -> distinct user ids whose sessions were revoked
  deactivateMemberships(tx: unknown, t: string, o: { at: Date; by: string; reasonCode: 'other'; actorId: string }): Promise<number>;   // every non-deactivated membership; status 'deactivated' only (never is_active)
  tenantUserIds(tx: unknown, t: string): Promise<string[]>;
  findSettings(tx: unknown, t: string): Promise<Record<string, any> | undefined>;
  updateSettings(tx: unknown, t: string, expectedVersion: number, set: Record<string, unknown>, unset: string[], actorId: string): Promise<Record<string, any> | undefined>;
  findFlag(tx: unknown, t: string, code: string): Promise<{ code: string; requires_founder_approval: boolean; is_enabled: boolean } | undefined>;
  updateFlag(tx: unknown, t: string, code: string, p: { isEnabled: boolean; approvalRef?: string; actorId: string }): Promise<void>;
  enqueue(tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void>;
}

export function makeRepo(seed: { tenants?: Array<{ tenant: TRow; data: TenantData }>; readiness?: Partial<Readiness> } = {}) {
  const world = new Map((seed.tenants ?? [seedA(), seedB()]).map((s) => [s.tenant.id, { tenant: { ...s.tenant }, data: s.data }]));
  const calls: Array<{ m: string; tx: unknown; args: unknown[]; scope: string | null }> = [];
  const order: string[] = [];
  const jobs: Array<{ identifier: string; payload: any; jobKey: string }> = [];
  const state = { scope: null as string | null, fail: {} as Record<string, Error | undefined>, readiness: seed.readiness };
  const rec = (m: string, tx: unknown, ...args: unknown[]) => { calls.push({ m, tx, args, scope: state.scope }); order.push(m); if (state.fail[m]) throw state.fail[m]; };
  const sc = (m: string, t: string) => { if (state.scope !== t) throw new Error(`fake RLS: ${m} for ${t} outside withTenantScope (scope=${state.scope})`); };
  const D = (t: string): TenantData => { let w = world.get(t); if (!w) { w = { tenant: undefined as never, data: emptyData() }; world.set(t, w); } return w.data; };
  const T = (id: string) => world.get(id)?.tenant;
  const cp = (r: TRow): TRow => ({ ...r });
  const repo: TenantRepo = {
    async findByCode(tx, code) { rec('findByCode', tx, code); const r = [...world.values()].find((w) => w.tenant?.code === code)?.tenant; return r && cp(r); },
    async find(tx, id) { rec('find', tx, id); const r = T(id); return r && cp(r); },
    async list(tx, f) { rec('list', tx, f); return [...world.values()].map((w) => w.tenant).filter((r) => r && (!f.status || r.status === f.status)).map(cp); },
    async insert(tx, a) {
      rec('insert', tx, a); if ([...world.values()].some((w) => w.tenant?.code === a.code)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      const r = trow({ id: a.id, code: a.code, legal_name: a.legalName, display_name: a.displayName, status: 'provisioning', timezone: a.timezone, activated_at: null, version: 1, created_at: NOW });
      world.set(a.id, { tenant: r, data: emptyData() }); return cp(r);
    },
    async update(tx, id, v, p) { rec('update', tx, id, v, p); const r = T(id); if (!r || r.version !== v) return undefined; Object.assign(r, { ...(p.legalName ? { legal_name: p.legalName } : {}), ...(p.displayName ? { display_name: p.displayName } : {}), ...('billingLiveOn' in p ? { billing_live_on: p.billingLiveOn ?? null } : {}), version: v + 1 }); return cp(r); },
    async setStatus(tx, id, v, p) {
      rec('setStatus', tx, id, v, p); const r = T(id); if (!r || r.version !== v) return undefined;
      Object.assign(r, { status: p.status, version: v + 1, ...(p.reason !== undefined ? { status_reason: p.reason } : {}),
        ...(p.status === 'active' && !r.activated_at ? { activated_at: p.at } : {}), ...(p.status === 'suspended' ? { suspended_at: p.at } : {}), ...(p.status === 'offboarded' ? { offboarded_at: p.at } : {}) }); return cp(r);
    },
    async detail(tx, id) { rec('detail', tx, id); const d = D(id); return { counts: { users: d.members.length, branches: d.branches.length, centres: d.centres.length }, history: [{ to: 'provisioning', at: NOW }], annexReadiness: 'incomplete' }; },
    async readiness(tx, id) {
      rec('readiness', tx, id); const d = D(id);
      return { acceptedAdmins: d.members.filter((m) => m.status === 'active' && m.accepted && m.roles.includes('tenant_admin')).length, activeBranches: d.branches.filter((b) => b.active).length,
        activeCentres: d.centres.filter((c) => c.active).length, ...state.readiness };
    },
    async insertBranch(tx, t, b) { rec('insertBranch', tx, t, b); sc('insertBranch', t); D(t).branches.push({ id: b.id, code: b.code, active: true }); },
    async insertCentre(tx, t, c) { rec('insertCentre', tx, t, c); sc('insertCentre', t); D(t).centres.push({ id: c.id, code: c.code, active: true }); },
    async seedRoles(tx, t, codes, a) { rec('seedRoles', tx, t, codes, a); sc('seedRoles', t); D(t).roles.push(...codes); },
    async insertSettings(tx, t, s) { rec('insertSettings', tx, t, s); sc('insertSettings', t); D(t).settings = { timezone: s.timezone, training_mode: s.trainingMode, version: 1 }; },
    async seedFlags(tx, t, a) { rec('seedFlags', tx, t, a); sc('seedFlags', t); D(t).flags.push({ code: FLAG_PLAIN, requires_founder_approval: false, is_enabled: false, approval_ref: null }); },
    async seedIrdAnnexes(tx, t, codes, a) { rec('seedIrdAnnexes', tx, t, codes, a); sc('seedIrdAnnexes', t); D(t).annexes.push(...codes.map((c) => ({ annex_code: c, status: 'not_started' }))); },
    async insertAcceptances(tx, t, rows) { rec('insertAcceptances', tx, t, rows); sc('insertAcceptances', t); D(t).acceptances.push(...rows); },
    async insertAdmin(tx, t, a) { rec('insertAdmin', tx, t, a); sc('insertAdmin', t); D(t).members.push(member({ id: a.membershipId, user_id: a.userId, status: 'invited', accepted: false })); },
    async insertInvitation(tx, t, i) { rec('insertInvitation', tx, t, i); sc('insertInvitation', t); D(t).invitations.push({ ...i }); },
    async accessLog(tx, t, e) { rec('accessLog', tx, t, e); sc('accessLog', t); D(t).accessLog.push({ ...e }); },
    async revokeTenantSessions(tx, t, o) {
      rec('revokeTenantSessions', tx, t, o); sc('revokeTenantSessions', t); const hit = D(t).sessions.filter((s) => s.state === 'active');
      for (const s of hit) Object.assign(s, { state: 'revoked', revoke_reason: o.reason }); return [...new Set(hit.map((s) => s.user_id))];
    },
    async deactivateMemberships(tx, t, o) {
      rec('deactivateMemberships', tx, t, o); sc('deactivateMemberships', t); const hit = D(t).members.filter((m) => m.status !== 'deactivated');
      for (const m of hit) Object.assign(m, { status: 'deactivated', deactivated_at: o.at, deactivated_by: o.by, deactivation_reason_code: o.reasonCode }); return hit.length;
    },
    async tenantUserIds(tx, t) { rec('tenantUserIds', tx, t); sc('tenantUserIds', t); return [...new Set(D(t).members.map((m) => m.user_id))]; },
    async findSettings(tx, t) { rec('findSettings', tx, t); return D(t).settings ? { ...D(t).settings } : undefined; },
    async updateSettings(tx, t, v, set, unset, a) {
      rec('updateSettings', tx, t, v, set, unset, a); sc('updateSettings', t); const s = D(t).settings; if (!s || s['version'] !== v) return undefined; Object.assign(s, set, { version: v + 1 }); return { ...s };
    },
    async findFlag(tx, t, code) { rec('findFlag', tx, t, code); const f = D(t).flags.find((x) => x.code === code); return f && { ...f }; },
    async updateFlag(tx, t, code, p) { rec('updateFlag', tx, t, code, p); sc('updateFlag', t); const f = D(t).flags.find((x) => x.code === code)!; f.is_enabled = p.isEnabled; f.approval_ref = p.approvalRef ?? null; },
    async enqueue(tx, identifier, payload, jobKey) { rec('enqueue', tx, identifier, payload, jobKey); jobs.push({ identifier, payload, jobKey }); },
  };
  return { repo, world, calls, order, jobs, state, data: (t: string) => D(t), tenant: (t: string) => T(t), by: (m: string) => calls.filter((c) => c.m === m),
    /** Probe: what claims for `asTenant` can see (RLS by construction: only its own rows). */
    visibleTo: (asTenant: string) => { const d = D(asTenant); return JSON.parse(JSON.stringify({ branches: d.branches, centres: d.centres, members: d.members, sessions: d.sessions })); },
    snapshot: (t: string) => JSON.stringify(D(t)) };
}
export type FakeRepo = ReturnType<typeof makeRepo>;

export function makeCtx(f: FakeRepo, o: Record<string, unknown> = {}) {
  const tx = { __tx: 1 }; const scopes: string[] = [];
  const withTenantScope = vi.fn(async (t: unknown, tenantId: string, fn: () => Promise<unknown>) => {
    if (t !== tx) throw new Error('fake: withTenantScope must be given the request transaction');
    if (f.state.scope !== null) throw new Error('fake: nested withTenantScope');
    f.state.scope = tenantId; scopes.push(tenantId); f.order.push(`scope:${tenantId}`);
    try { return await fn(); } finally { f.state.scope = null; f.order.push(`unscope:${tenantId}`); }
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: any = { actor: { type: 'user', id: STAFF_USER }, platformRole: 'platform_superadmin', platformStaffId: STAFF_ID, platformSessionId: PSESSION, aal: 'aal2',
    requestId: REQ_ID, clientIp: '203.0.113.9', tx, now: () => NOW, db: { withTenantScope }, log, ...o };
  return { ctx, tx, scopes, withTenantScope, log };
}

let seq = 0xa000; export const nextId = () => idN(seq++);
export function makeGotrue(f: FakeRepo, existing: Record<string, string> = {}) {
  const calls: Array<{ email: string; emailConfirm: boolean }> = [];
  return { calls, adminCreateUser: vi.fn(async (i: { email: string; emailConfirm: boolean }) => {
    f.order.push('gotrue'); calls.push(i); const u = existing[i.email]; return u ? { exists: true as const, userId: u } : { userId: nextId() };
  }) };
}
export const acc = (v = '2026-11') => ({ version: v, acceptedByName: 'Demo Owner', acceptedByTitle: 'Managing Director', acceptedAt: '2026-11-10T09:00:00.000Z' });
export const PROVISION = {
  code: 'synthetic_gamma', legalName: 'Synthetic Gamma Lab Pvt. Ltd.', displayName: 'Synthetic Gamma', timezone: 'Asia/Kathmandu', calendarDisplay: 'AD_BS',
  firstBranch: { code: 'KTM-01', name: 'Gamma main branch', addressText: 'Synthetic Road 1' }, firstCentre: { code: 'C000000010', name: 'Gamma collection centre', kind: 'own' },
  firstAdmin: { email: 'Admin@Gamma.Example.test', displayName: 'Gamma Admin' }, contractAcceptance: { tos: acc(), dpa: acc('2026-10') },
};
export interface World { f: FakeRepo; svc: any; ctxOf: (o?: Record<string, unknown>) => ReturnType<typeof makeCtx>; gotrue: ReturnType<typeof makeGotrue> }
export const WRITE_METHODS = ['insert', 'update', 'setStatus', 'insertBranch', 'insertCentre', 'seedRoles', 'insertSettings', 'seedFlags', 'seedIrdAnnexes', 'insertAcceptances', 'insertAdmin', 'insertInvitation',
  'accessLog', 'revokeTenantSessions', 'deactivateMemberships', 'updateSettings', 'updateFlag', 'enqueue'];
export const writes = (f: FakeRepo) => f.calls.filter((c) => WRITE_METHODS.includes(c.m));
