// T25 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute:
//
//   ../platform-staff.service.ts  exports `createPlatformStaffService(deps?: { repo?: PlatformStaffRepo; gotrue?: Pick<GoTrueGateway,'adminCreateUser'>;
//                                 platformEvents?: { insert(tx, e): Promise<void> }; newId?: () => string })` -> { listPlatformStaff, invitePlatformStaff,
//                                 updatePlatformStaff, deactivatePlatformStaff, resetPlatformStaffMfa, listPlatformSessions, revokePlatformSession,
//                                 listPlatformAuthEvents }, each `(ctx, input) => Promise<{ status, body, version? }>` (as support/dead-letter services).
//                                 Every operation calls PlatformAuthz.assertPlatform ITSELF before any repo/gotrue call: the first seven with
//                                 'platform.staff.manage' (superadmin only), listPlatformAuthEvents with 'platform.tenant.read' (02-TRD s5.10).
//   ctx (platform request context, as T21/T24) = { actor{type:'user',id}, platformRole, platformStaffId, platformSessionId, aal, requestId, tx, now(), clientIp?, log }.
//   inputs (camelCase): invitePlatformStaff{email,displayName,roleCode,allowedCidrs?} - updatePlatformStaff{platformStaffId,expectedVersion|undefined,displayName?,roleCode?,allowedCidrs?}
//        - deactivatePlatformStaff{platformStaffId,expectedVersion|undefined} - resetPlatformStaffMfa{platformStaffId} - revokePlatformSession{sessionId}
//        - listPlatformStaff{} - listPlatformSessions{} - listPlatformAuthEvents(RAW snake_case query, like audit-view.service: occurred_at_from/to, tenant_id?, event_type?, cursor?, limit?)
//   bodies = PlatformStaff / PlatformStaffList / SessionSummaryList / AuthEventPage of contracts/openapi/identity.yaml (additionalProperties:false, absent optionals OMITTED, never null).
//   repo seam (PlatformStaffRepo; no SQL in the service; every method takes the request tx first): see `PlatformStaffRepo` below.
//   Side effects are ONLY: repo writes, `repo.enqueue(tx, taskIdentifier, payload, jobKey)` (02-TRD s10) and `deps.platformEvents.insert(tx, event)` (default writer wired in
//   handlers/platform-staff.http.ts, NOT in the service, as T24). Event = { eventType, targetType, targetId, targetTenantId:null, detail, actorPlatformStaffId, actorId, requestId?, clientIp? }.
import { vi } from 'vitest';

export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const STAFF_USER = idN(0xd1), STAFF_ID = idN(0xd2), PSESSION = idN(0xe2), REQ_ID = idN(0xe1), TENANT_A = idN(0xa1);
export const NOW = new Date('2026-11-08T06:00:00.000Z');
export const SECRET = 'SECRET-SENTINEL-7f3a';
export const rejection = async (p: unknown): Promise<any> => { try { await (typeof p === 'function' ? (p as () => unknown)() : p); } catch (e) { return e; } throw new Error('expected rejection, got success'); };

export type Role = 'platform_superadmin' | 'platform_support';
export interface StaffRow {
  id: string; user_id: string; email_normalized: string; display_name: string; role_code: Role; allowed_cidrs: string[]; last_login_at: Date | null;
  is_active: boolean; version: number;
}
export const staffRow = (n: number, o: Partial<StaffRow> = {}): StaffRow => ({
  id: idN(0x5000 + n), user_id: idN(0x6000 + n), email_normalized: `staff${n}@example.test`, display_name: `Demo Staff ${n}`, role_code: 'platform_support',
  allowed_cidrs: [], last_login_at: null, is_active: true, version: 1, ...o,
});
/** The calling superadmin: row id = STAFF_ID, user id = STAFF_USER (ctx.actor.id). */
export const meRow = (o: Partial<StaffRow> = {}): StaffRow => staffRow(0, { id: STAFF_ID, user_id: STAFF_USER, email_normalized: 'me@example.test', display_name: 'Demo Me', role_code: 'platform_superadmin', ...o });

export interface SessRow {
  id: string; kind: string; user_id: string; platform_staff_id: string | null; display_name: string; state: string; aal: 'aal1' | 'aal2';
  created_at: Date; last_seen_at: Date; idle_expires_at: Date; absolute_expires_at: Date; client_ip: string | null; user_agent: string | null; support_session_id: string | null;
  // never on the wire:
  token_sha256?: string; refresh_token_enc?: string; access_token_enc?: string; enc_key_id?: string; gotrue_session_id?: string;
}
export const sessRow = (n: number, o: Partial<SessRow> = {}): SessRow => ({
  id: idN(0x7000 + n), kind: 'platform', user_id: idN(0x6000 + n), platform_staff_id: idN(0x5000 + n), display_name: `Demo Staff ${n}`, state: 'active', aal: 'aal2',
  created_at: NOW, last_seen_at: NOW, idle_expires_at: new Date(NOW.getTime() + 900_000), absolute_expires_at: new Date(NOW.getTime() + 28_800_000),
  client_ip: '203.0.113.9', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/130.0', support_session_id: null,
  token_sha256: SECRET, refresh_token_enc: SECRET, access_token_enc: SECRET, enc_key_id: SECRET, gotrue_session_id: idN(0x8000 + n), ...o,
});

export interface AuthRow {
  id: string; occurred_at: Date; cursor_at: string; tenant_id: string | null; user_id: string | null; membership_id: string | null; platform_staff_id: string | null;
  session_id: string | null; event_type: string; reason_code: string | null; client_ip: string | null; user_agent: string | null; request_id: string | null; email_hmac?: string;
}
export const authRow = (n: number, o: Partial<AuthRow> = {}): AuthRow => {
  const at = new Date(Date.UTC(2026, 10, 5, 4, n, 0));
  return { id: idN(0x9000 + n), occurred_at: at, cursor_at: at.toISOString(), tenant_id: null, user_id: null, membership_id: null, platform_staff_id: null, session_id: null,
    event_type: 'login_succeeded', reason_code: null, client_ip: '203.0.113.9', user_agent: 'Firefox', request_id: null, email_hmac: SECRET, ...o };
};

export interface EnqueueCall { identifier: string; payload: Record<string, unknown>; jobKey: string }
/** In-memory PlatformStaffRepo. `locked` records every lockActiveSuperadmins call (before-write ordering is asserted through `order`). */
export function makeRepo(seed: { staff?: StaffRow[]; sessions?: SessRow[]; auth?: AuthRow[]; mfa?: Array<{ user_id: string; status: string }> } = {}) {
  const mfa = (seed.mfa ?? []).map((r) => ({ ...r }));
  const staff = (seed.staff ?? [meRow()]).map((r) => ({ ...r, allowed_cidrs: [...r.allowed_cidrs] }));
  const sessions = (seed.sessions ?? []).map((r) => ({ ...r }));
  const auth = (seed.auth ?? []).map((r) => ({ ...r }));
  const invitations: Array<Record<string, any>> = [];
  const jobs: EnqueueCall[] = [];
  const order: string[] = [];
  const calls: Array<{ m: string; tx: unknown; args: unknown[] }> = [];
  const state = { fail: {} as Record<string, Error | undefined> };
  const rec = (m: string, tx: unknown, ...args: unknown[]) => { calls.push({ m, tx, args }); order.push(m); if (state.fail[m]) throw state.fail[m]; };
  const copy = (r: StaffRow): StaffRow => ({ ...r, allowed_cidrs: [...r.allowed_cidrs] });
  const repo = {
    async listStaff(tx: unknown) { rec('listStaff', tx); return staff.map(copy); },
    async findStaff(tx: unknown, id: string) { rec('findStaff', tx, id); const r = staff.find((x) => x.id === id); return r && copy(r); },
    async findStaffByEmail(tx: unknown, emailNormalized: string) { rec('findStaffByEmail', tx, emailNormalized); const r = staff.find((x) => x.email_normalized === emailNormalized); return r && copy(r); },
    async insertStaff(tx: unknown, a: { id: string; userId: string; emailNormalized: string; displayName: string; roleCode: Role; allowedCidrs: string[]; actorId: string }) {
      rec('insertStaff', tx, a);
      const r: StaffRow = { id: a.id, user_id: a.userId, email_normalized: a.emailNormalized, display_name: a.displayName, role_code: a.roleCode, allowed_cidrs: [...a.allowedCidrs], last_login_at: null, is_active: true, version: 1 };
      staff.push(r); return copy(r);
    },
    /** optimistic lock: undefined = version mismatch / row gone. Bumps version. */
    async updateStaff(tx: unknown, id: string, expectedVersion: number, p: { displayName?: string; roleCode?: Role; allowedCidrs?: string[]; isActive?: boolean; actorId: string }) {
      rec('updateStaff', tx, id, expectedVersion, p);
      const r = staff.find((x) => x.id === id); if (!r || r.version !== expectedVersion) return undefined;
      if (p.displayName !== undefined) r.display_name = p.displayName;
      if (p.roleCode !== undefined) r.role_code = p.roleCode;
      if (p.allowedCidrs !== undefined) r.allowed_cidrs = [...p.allowedCidrs];
      if (p.isActive !== undefined) r.is_active = p.isActive;
      r.version += 1; return copy(r);
    },
    /** bumps version without other change (reset-mfa; job key carries the version); undefined = row gone. */
    async touchStaff(tx: unknown, id: string, actorId: string) { rec('touchStaff', tx, id, actorId); const r = staff.find((x) => x.id === id); if (!r) return undefined; r.version += 1; return copy(r); },
    /** ids of the ACTIVE platform_superadmin rows, locked FOR UPDATE inside the request tx (serialises concurrent demote/deactivate). */
    async lockActiveSuperadmins(tx: unknown) { rec('lockActiveSuperadmins', tx); return staff.filter((r) => r.role_code === 'platform_superadmin' && r.is_active).map((r) => r.id); },
    async insertInvitation(tx: unknown, a: { id: string; userId: string; platformStaffId: string; email: string; expiresAt: Date; actorId: string }) { rec('insertInvitation', tx, a); invitations.push({ ...a }); },
    async enqueue(tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string) { rec('enqueue', tx, identifier, payload, jobKey); jobs.push({ identifier, payload, jobKey }); },
    async listPlatformSessions(tx: unknown) { rec('listPlatformSessions', tx); return sessions.map((r) => ({ ...r })); },
    async findSession(tx: unknown, id: string) { rec('findSession', tx, id); const r = sessions.find((x) => x.id === id); return r && { ...r }; },
    async revokeSession(tx: unknown, id: string, o: { at: Date; actorId: string }) { rec('revokeSession', tx, id, o); const r = sessions.find((x) => x.id === id); if (r) r.state = 'revoked'; },
    /** review item 1/2 seam: revokes every non-terminal kind='platform' session of the staff row (UPDATE identity.sessions ... state NOT IN ('revoked','expired')); returns the count. */
    async revokeStaffSessions(tx: unknown, o: { platformStaffId: string; reason: string; at: Date; actorId: string }) {
      rec('revokeStaffSessions', tx, o); let n = 0;
      for (const r of sessions) if (r.kind === 'platform' && r.platform_staff_id === o.platformStaffId && !['revoked', 'expired'].includes(r.state)) { r.state = 'revoked'; n += 1; }
      return n;
    },
    /** review item 2 seam: mirror rows -> status='removed', removal_reason='admin_reset' for the platform user (tenant_id IS NULL, status <> 'removed'); returns the count. */
    async removeStaffMfaFactors(tx: unknown, o: { userId: string; actorId: string }) {
      rec('removeStaffMfaFactors', tx, o); const n = mfa.filter((m) => m.user_id === o.userId && m.status !== 'removed').length;
      for (const m of mfa) if (m.user_id === o.userId) m.status = 'removed';
      return n;
    },
    async listAuthEvents(tx: unknown, p: { from: string; to: string; after: { at: string; id: string }; limit: number; f: { tenant_id?: string; event_type?: string } }) {
      rec('listAuthEvents', tx, p);
      return auth.filter((r) => {
        const t = r.occurred_at.getTime();
        return t >= Date.parse(p.from) && t <= Date.parse(p.to) && (t < Date.parse(p.after.at) || (t === Date.parse(p.after.at) && r.id < p.after.id))
          && (p.f.tenant_id === undefined || r.tenant_id === p.f.tenant_id) && (p.f.event_type === undefined || r.event_type === p.f.event_type);
      }).sort((a, b) => (a.occurred_at.getTime() === b.occurred_at.getTime() ? (a.id < b.id ? 1 : -1) : b.occurred_at.getTime() - a.occurred_at.getTime())).slice(0, p.limit).map((r) => ({ ...r }));
    },
  };
  return { repo, staff, sessions, auth, mfa, invitations, jobs, order, calls, state, by: (m: string) => calls.filter((c) => c.m === m), row: (id: string) => staff.find((r) => r.id === id)! };
}
export type FakeRepo = ReturnType<typeof makeRepo>;

export function makeGotrue(o: { existing?: Set<string> } = {}) {
  const created: Array<{ email: string; emailConfirm: boolean }> = [];
  let n = 0;
  const gotrue = {
    adminCreateUser: vi.fn(async (i: { email: string; emailConfirm: boolean }) => {
      if (o.existing?.has(i.email)) return { exists: true as const, userId: idN(0xa000 + 99) };
      created.push(i); return { userId: idN(0xa000 + ++n) };
    }),
  };
  return { gotrue, created };
}

export function makeCtx(o: Record<string, unknown> = {}) {
  const tx = { __tx: 1 };
  const events: any[] = [];
  const platformEvents = { insert: vi.fn(async (t: unknown, e: any) => { if (t !== tx) throw new Error('fake: platform event not on the request tx'); events.push(e); }) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: any = {
    actor: { type: 'user', id: STAFF_USER }, platformRole: 'platform_superadmin', platformStaffId: STAFF_ID, platformSessionId: PSESSION, aal: 'aal2',
    requestId: REQ_ID, clientIp: '203.0.113.9', tx, now: () => NOW, log, ...o,
  };
  return { ctx, tx, events, platformEvents, log };
}
export const SUPPORT = { platformRole: 'platform_support' };
let seq = 0xb000;
export const nextId = () => idN(seq++);
