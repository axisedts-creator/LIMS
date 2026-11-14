// T21 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute:
//
//   ../../platform/authz.ts   exports `PlatformAuthz = { assertPlatform(ctx, permission): void | Promise<void> }` (02-TRD s5.10, 03-APP-FLOW s9; never IdentityPort).
//                             Pure: role -> permission from the generated registry (ROLE_GRANTS); `platform.*` only; privileged => ctx.aal must be 'aal2'.
//                             The IP allowlist is the claims resolver's (T4, identity.platform_ip_denied), NOT re-checked here.
//   ../support.service.ts     exports `createSupportService(deps?: { repo?: SupportRepo; newId?: () => string })` ->
//                             { openSupportSession, activateSupportSession, endSupportSession, listPlatformSupportSessions }, each `(ctx, input) => Promise<{ status, body, version? }>`
//                             (same convention as role/settings.service). The DEFAULT repo (SQL on ctx.tx, repository/support.repo.ts or inside the service) is the writer's call;
//                             tests inject the fake below. Every operation calls PlatformAuthz.assertPlatform ITSELF before any repo call.
//   ctx (PlatformRequestContext, 08 CR-C2-004) = { actor{type:'user',id}, platformRole, platformStaffId, platformSessionId, aal, requestId, tx, now(), db{withTenantScope(tx,tenantId,fn)}, log }
//        - NO tenantId. `platformSessionId` = claims lims_session_id (the identity.sessions row a support session binds to). `aal` = claims aal.
//        - while a support session is bound the same caller's claims are scope 'support' (actor.supportSessionId set): endSupportSession must still work then.
//   inputs (camelCase): openSupportSession{tenantId,scope,reasonText,ticketRef,durationMinutes} - activateSupportSession{supportSessionId,expectedVersion|undefined}
//        - endSupportSession{supportSessionId} - listPlatformSupportSessions{tenantId?,status?,platformStaffId?,cursor?,limit?}
//   bodies = `SupportSession` / `SupportSessionPage` of contracts/openapi/identity.yaml (additionalProperties:false, no nulls: absent optional fields are OMITTED).
import { vi } from 'vitest';

export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1), TENANT_C = idN(0xc1);
export const STAFF_USER = idN(0xd1), STAFF_ID = idN(0xd2), OTHER_STAFF_ID = idN(0xd3), PSESSION = idN(0xe2), REQ_ID = idN(0xe1), SYS = idN(0xf1);
export const NOW = new Date('2026-11-08T06:00:00.000Z');
export const mins = (n: number, from: Date = NOW) => new Date(from.getTime() + n * 60_000);
export const rejection = async (p: unknown): Promise<any> => { try { await (typeof p === 'function' ? (p as () => unknown)() : p); } catch (e) { return e; } throw new Error('expected rejection, got success'); };

export type Status = 'requested' | 'approved' | 'denied' | 'active' | 'ended' | 'expired' | 'revoked';
export interface SRow {
  id: string; tenant_id: string; platform_staff_id: string; platform_staff_display_name: string; scope: 'read_only' | 'admin'; reason_text: string; ticket_ref: string;
  duration_minutes: number; status: Status; requested_at: Date; decided_at: Date | null; decision_note: string | null; started_at: Date | null; expires_at: Date | null;
  ended_at: Date | null; ended_by: string | null; end_reason: string | null; version: number; platform_session_id: string | null;
}
export const srow = (o: Partial<SRow> & { id: string }): SRow => ({
  tenant_id: TENANT_A, platform_staff_id: STAFF_ID, platform_staff_display_name: 'Demo Support', scope: 'read_only', reason_text: 'Investigating a synthetic ticket', ticket_ref: 'SUP-1001',
  duration_minutes: 30, status: 'requested', requested_at: NOW, decided_at: null, decision_note: null, started_at: null, expires_at: null, ended_at: null, ended_by: null,
  end_reason: null, version: 1, platform_session_id: null, ...o,
});
export type TenantInfo = { id: string; status: 'provisioning' | 'active' | 'suspended' | 'offboarded'; supportAccessMode: 'notify' | 'approval_required' };
export const tenant = (id: string, o: Partial<TenantInfo> = {}): TenantInfo => ({ id, status: 'active', supportAccessMode: 'notify', ...o });

export interface InsertArg { id: string; tenantId: string; platformStaffId: string; platformSessionId: string; scope: 'read_only' | 'admin'; reasonText: string; ticketRef: string;
  durationMinutes: number; status: 'active' | 'requested'; startedAt?: Date; expiresAt?: Date; actorId: string }
export interface Patch { status: Status; startedAt?: Date; expiresAt?: Date; endedAt?: Date; endedBy?: string; endReason?: string; actorId: string }
/** SupportRepo seam. Every method takes the request tx first; none reads a tenant from anywhere but its argument. */
export interface SupportRepo {
  /** platform-visible tenant lookup incl. identity.tenant_settings.support_access_mode; unknown -> undefined */
  findTenant(tx: unknown, tenantId: string): Promise<TenantInfo | undefined>;
  /** SP: one active per platform session. Ends every `active` row bound to that platform session (end_reason 'superseded'), unbinds, returns the ended rows. */
  endActiveForPlatformSession(tx: unknown, platformSessionId: string, o: { endedBy: string; endedAt: Date; actorId: string }): Promise<SRow[]>;
  insert(tx: unknown, a: InsertArg): Promise<SRow>;
  find(tx: unknown, id: string): Promise<SRow | undefined>;
  /** optimistic lock; undefined = version mismatch / row gone. Bumps version. */
  update(tx: unknown, id: string, expectedVersion: number, p: Patch): Promise<SRow | undefined>;
  /** identity.sessions.support_session_id of the caller's platform session: set (id) or cleared (null) */
  bindPlatformSession(tx: unknown, platformSessionId: string, supportSessionId: string | null): Promise<void>;
  list(tx: unknown, f: { tenantId?: string; status?: string; platformStaffId?: string; cursor?: string; limit?: number }): Promise<SRow[]>;
  /** identity.access_log of the TARGET tenant. Requires an open withTenantScope(tenantId) window (fake throws otherwise, like RLS). */
  insertAccessLog(tx: unknown, tenantId: string, e: { action: string; entityType: string; entityId: string; outcome: 'allowed' | 'denied'; detail?: Record<string, string | number | boolean> }): Promise<void>;
  /** identity.admin_notices of the TARGET tenant. Same scope rule. */
  insertNotice(tx: unknown, tenantId: string, n: { kind: string; subjectType: string; subjectId: string }): Promise<void>;
}

export function makeRepo(seed: { tenants?: TenantInfo[]; rows?: SRow[] } = {}) {
  const tenants = new Map((seed.tenants ?? [tenant(TENANT_A), tenant(TENANT_B)]).map((t) => [t.id, t]));
  const rows: SRow[] = (seed.rows ?? []).map((r) => ({ ...r }));
  const binding = new Map<string, string | null>();           // platform session -> support session
  const calls: Array<{ m: string; tx: unknown; args: unknown[]; scope: string | null }> = [];
  const logs: Array<{ tenantId: string; action: string; entityType: string; entityId: string; outcome: string; detail?: Record<string, unknown> }> = [];
  const notices: Array<{ tenantId: string; kind: string; subjectType: string; subjectId: string }> = [];
  const state = { scope: null as string | null, fail: {} as Record<string, Error | undefined> };
  const rec = (m: string, tx: unknown, ...args: unknown[]) => { calls.push({ m, tx, args, scope: state.scope }); if (state.fail[m]) throw state.fail[m]; };
  const copy = (r: SRow): SRow => ({ ...r });
  const repo: SupportRepo = {
    async findTenant(tx, id) { rec('findTenant', tx, id); const t = tenants.get(id); return t && { ...t }; },
    async endActiveForPlatformSession(tx, ps, o) {
      rec('endActiveForPlatformSession', tx, ps, o);
      const out = rows.filter((r) => r.status === 'active' && r.platform_session_id === ps);
      for (const r of out) Object.assign(r, { status: 'ended', ended_at: o.endedAt, ended_by: o.endedBy, end_reason: 'superseded', platform_session_id: null, version: r.version + 1 });
      if (out.length) binding.set(ps, null);
      return out.map(copy);
    },
    async insert(tx, a) {
      rec('insert', tx, a);
      const r = srow({ id: a.id, tenant_id: a.tenantId, platform_staff_id: a.platformStaffId, scope: a.scope, reason_text: a.reasonText, ticket_ref: a.ticketRef,
        duration_minutes: a.durationMinutes, status: a.status, started_at: a.startedAt ?? null, expires_at: a.expiresAt ?? null,
        platform_session_id: a.status === 'active' ? a.platformSessionId : null });
      rows.push(r); return copy(r);
    },
    async find(tx, id) { rec('find', tx, id); const r = rows.find((x) => x.id === id); return r && copy(r); },
    async update(tx, id, v, p) {
      rec('update', tx, id, v, p);
      const r = rows.find((x) => x.id === id); if (!r || r.version !== v) return undefined;
      Object.assign(r, { status: p.status, version: r.version + 1, ...(p.startedAt ? { started_at: p.startedAt } : {}), ...(p.expiresAt ? { expires_at: p.expiresAt } : {}),
        ...(p.endedAt ? { ended_at: p.endedAt } : {}), ...(p.endedBy ? { ended_by: p.endedBy } : {}), ...(p.endReason ? { end_reason: p.endReason } : {}) });
      return copy(r);
    },
    async bindPlatformSession(tx, ps, sid) {
      rec('bindPlatformSession', tx, ps, sid); binding.set(ps, sid);
      if (sid) { const r = rows.find((x) => x.id === sid); if (r) r.platform_session_id = ps; } else for (const r of rows) if (r.platform_session_id === ps) r.platform_session_id = null;
    },
    async list(tx, f) {
      rec('list', tx, f);
      return rows.filter((r) => (!f.tenantId || r.tenant_id === f.tenantId) && (!f.status || r.status === f.status) && (!f.platformStaffId || r.platform_staff_id === f.platformStaffId)).map(copy);
    },
    async insertAccessLog(tx, tenantId, e) {
      rec('insertAccessLog', tx, tenantId, e);
      if (state.scope !== tenantId) throw new Error(`fake RLS: access_log write for ${tenantId} outside withTenantScope (scope=${state.scope})`);
      logs.push({ tenantId, ...e });
    },
    async insertNotice(tx, tenantId, n) {
      rec('insertNotice', tx, tenantId, n);
      if (state.scope !== tenantId) throw new Error(`fake RLS: notice write for ${tenantId} outside withTenantScope (scope=${state.scope})`);
      notices.push({ tenantId, ...n });
    },
  };
  return { repo, rows, tenants, binding, calls, logs, notices, state, by: (m: string) => calls.filter((c) => c.m === m) };
}
export type FakeRepo = ReturnType<typeof makeRepo>;

export function makeCtx(f: FakeRepo, o: Record<string, unknown> = {}) {
  const tx = { __tx: 1 };
  const scopes: string[] = [];
  const withTenantScope = vi.fn(async (t: unknown, tenantId: string, fn: () => Promise<unknown>) => {
    if (t !== tx) throw new Error('fake: withTenantScope must be given the request transaction');
    if (f.state.scope !== null) throw new Error('fake: nested withTenantScope');
    f.state.scope = tenantId; scopes.push(tenantId);
    try { return await fn(); } finally { f.state.scope = null; }
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: any = {
    actor: { type: 'user', id: STAFF_USER }, platformRole: 'platform_support', platformStaffId: STAFF_ID, platformSessionId: PSESSION, aal: 'aal2',
    requestId: REQ_ID, tx, now: () => NOW, db: { withTenantScope }, log, ...o,
  };
  return { ctx, tx, scopes, withTenantScope, log };
}

let seq = 0x9000;
export const nextId = () => idN(seq++);
export const OPEN = { tenantId: TENANT_A, scope: 'read_only', reasonText: 'Investigating a synthetic ticket', ticketRef: 'SUP-1001', durationMinutes: 30 };
export const SUPER = { platformRole: 'platform_superadmin' };
