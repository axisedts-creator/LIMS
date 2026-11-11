// T5 shared helper (not a test). Synthetic data only.
// ASSUMED API (tester; implementer must match or raise a CR / ask the reviewer):
//   ports/IdentityPort.impl.ts   export function createIdentityPort(deps): IdentityPort & { invalidateTenantSettings(tenantId): void }
//     deps = { repo: CoreAdminRepo, systemActorPermissions(actorId): readonly string[]  (CR-C2-013 = ctx.core.systemActorPermissions),
//              nowMs?(): number (cache clock, default Date.now), settingsTtlMs? (default 30_000, 02-TRD s7.3),
//              metrics?: { authzDecision(outcome: 'allow'|'forbidden'|'mfa_required'|'locked'|'support_required', privileged: boolean): void } }
//   repository/core-admin.repo.ts export function createCoreAdminRepo(): CoreAdminRepo   (every method takes ctx; ctx.tx = the only db handle)
//   CoreAdminRepo = the FakeRepo below (method names + shapes). Impl must NOT memoise inside the repo; the repo is dumb SQL.
import { LimsError } from '../../../../core/errors.js';
import { TENANTS, actorIdFor, FIXED_NOW } from '../../../../../../../packages/fakes/src/base';
import { FIXED_ACTOR_PERMISSIONS, ROLE_GRANTS } from '../../../../../../../contracts/ports/generated/permissions';
import { DEFAULT_SETTINGS } from '../../../../../../../packages/fakes/src/IdentityPort.fake';

export { TENANTS, actorIdFor, FIXED_NOW, DEFAULT_SETTINGS, FIXED_ACTOR_PERMISSIONS };
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
export const SHA = 'a'.repeat(64);
export const SUPPORT_ID = '01900000-0000-7000-8000-0000000d0001';
export const STAFF_SUB = '01900000-0000-7000-8000-0000000d0002';

export interface MemberRow {
  membershipId: string; userId: string; tenantId: string; actorId: string; actorType: 'user' | 'partner' | 'patient';
  status: 'invited' | 'active' | 'deactivated'; lockedAt: string | null; displayName: string; email: string | null;
  roleCodes: string[]; permissions: string[]; allCentres: boolean; centreIds: string[]; branchIds: string[]; mfaEnrolled: boolean;
  signature?: { displayTitle: string; registrationNo?: string; imageRef?: string }; partnerRole?: 'partner_admin' | 'partner_member'; version: number;
}
export interface AssetRow { id: string; tenantId: string; kind: string; mimeType: string; sha256: string; base64: string; scanState: 'pending' | 'clean' | 'quarantined' }
export interface SigImageRow { tenantId: string; membershipId: string; mimeType: string; sha256: string; base64: string; scanState: 'pending' | 'clean' | 'quarantined' }
export interface SupportRow { tenantId: string; id: string; active: boolean; scope: 'read_only' | 'admin'; staffDisplayName: string }

/** In-memory CoreAdminRepo. `calls` counts every method; `claimsFor` decides the request.jwt.claims of a ctx. */
export function makeFakeRepo(init: {
  members?: MemberRow[]; assets?: AssetRow[]; sigImages?: SigImageRow[]; support?: SupportRow[];
  settings?: Record<string, unknown>; tenantStatus?: Record<string, string>;
} = {}) {
  const st = {
    members: init.members ?? [], assets: init.assets ?? [], sigImages: init.sigImages ?? [], support: init.support ?? [],
    settings: init.settings ?? ({} as Record<string, any>), tenantStatus: init.tenantStatus ?? ({} as Record<string, string>),
    claims: new Map<string, Record<string, unknown>>(),   // key: actor id -> claims override
    revoked: [] as { membershipId: string; reason: string }[], seq: 0x7000,
  };
  const calls: Record<string, number> = {};
  const hit = (n: string) => { calls[n] = (calls[n] ?? 0) + 1; };
  const tenantOf = (ctx: any): string => { if (!ctx?.tenantId) throw new LimsError('common.internal'); return ctx.tenantId; };
  const ownM = (ctx: any, id: unknown) => st.members.find((m) => m.tenantId === tenantOf(ctx) && m.membershipId === id);
  const copy = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const repo = {
    async claims(ctx: any): Promise<Record<string, unknown>> {
      hit('claims');
      const o = st.claims.get(ctx.actor.id);
      if (o) return copy(o);
      const m = st.members.find((x) => x.tenantId === ctx.tenantId && x.actorId === ctx.actor.id && x.actorType === ctx.actor.type);
      if (!m) return {};
      return { aal: m.mfaEnrolled ? 'aal2' : 'aal1', membership_id: m.membershipId, session_state: 'active', ...(m.partnerRole ? { partner_role: m.partnerRole } : {}) };
    },
    async membership(ctx: any, i: { membershipId: string }): Promise<MemberRow | undefined> { hit('membership'); return copy(ownM(ctx, i.membershipId)); },
    async lockMembership(ctx: any, i: { membershipId: string }): Promise<MemberRow | undefined> { hit('lockMembership'); return copy(ownM(ctx, i.membershipId)); },
    async supportSession(ctx: any, i: { supportSessionId: string }) {
      hit('supportSession');
      const s = st.support.find((x) => x.tenantId === tenantOf(ctx) && x.id === i.supportSessionId);
      return s ? { active: s.active, scope: s.scope, staffDisplayName: s.staffDisplayName } : undefined;
    },
    async tenantStatus(ctx: any): Promise<string> { hit('tenantStatus'); return st.tenantStatus[tenantOf(ctx)] ?? 'active'; },
    async tenantSettings(ctx: any) { hit('tenantSettings'); return copy(st.settings[tenantOf(ctx)] ?? DEFAULT_SETTINGS); },
    async signatories(ctx: any, i: { membershipIds: readonly string[] }) {
      hit('signatories');
      return i.membershipIds.map((id) => ownM(ctx, id)).filter((m): m is MemberRow => !!m && !!m.signature).map((m) => ({
        membershipId: m.membershipId, displayName: m.displayName, displayTitle: m.signature!.displayTitle, registrationNo: m.signature!.registrationNo,
        signatureAssetId: m.signature!.imageRef, signatureSha256: SHA, status: m.status,
      }));
    },
    async brandingAsset(ctx: any, i: { assetId: string }): Promise<AssetRow | undefined> {
      hit('brandingAsset'); return copy(st.assets.find((a) => a.tenantId === tenantOf(ctx) && a.id === i.assetId));   // ANY kind incl. 'signature': impl must filter (D-26)
    },
    async signatureImage(ctx: any, i: { membershipId: string }): Promise<SigImageRow | undefined> {
      hit('signatureImage'); return copy(st.sigImages.find((a) => a.tenantId === tenantOf(ctx) && a.membershipId === i.membershipId));
    },
    async emailExists(ctx: any, i: { email: string }): Promise<boolean> {
      hit('emailExists'); return st.members.some((m) => m.tenantId === tenantOf(ctx) && m.email === i.email);
    },
    async createPartnerMembership(ctx: any, i: { email: string; displayName: string; partnerRole: 'partner_admin' | 'partner_member' }) {
      hit('createPartnerMembership');
      const n = () => `01900000-0000-7000-8000-${(st.seq++).toString(16).padStart(12, '0')}`;
      const m: MemberRow = { membershipId: n(), userId: n(), tenantId: tenantOf(ctx), actorId: n(), actorType: 'partner', status: 'invited', lockedAt: null,
        displayName: i.displayName, email: i.email, roleCodes: [], permissions: [], allCentres: false, centreIds: [], branchIds: [], mfaEnrolled: false,
        partnerRole: i.partnerRole, version: 1 };
      st.members.push(m);
      return { membershipId: m.membershipId, userId: m.userId, invitationId: n() };
    },
    async applyPartnerAction(ctx: any, i: { membershipId: string; action: string; partnerRole?: 'partner_admin' | 'partner_member'; reasonCode?: string }) {
      hit('applyPartnerAction');
      const m = ownM(ctx, i.membershipId)!;
      if (i.action === 'deactivate') m.status = 'deactivated';
      else if (i.action === 'reactivate') m.status = 'active';
      else if (i.action === 'set_role') m.partnerRole = i.partnerRole;
      m.version += 1;
      return { status: m.status, version: m.version };
    },
    async revokeSessions(ctx: any, i: { membershipId: string; reason: string }): Promise<number> {
      hit('revokeSessions'); st.revoked.push({ membershipId: i.membershipId, reason: i.reason }); return 1;
    },
  };
  return { repo, st, calls };
}
export type FakeRepo = ReturnType<typeof makeFakeRepo>['repo'];

export const mid = (n: number) => `01900000-0000-7000-8000-0000000a${n.toString(16).padStart(4, '0')}`;
export const member = (tenant: 'A' | 'B', persona: string, n: number, o: Partial<MemberRow> = {}): MemberRow => {
  const roleCodes = o.roleCodes ?? ['lab_technologist'];
  const status = o.status ?? 'active';
  const type = o.actorType ?? 'user';
  return {
    membershipId: mid(n), userId: mid(n + 0x1000), tenantId: TENANTS[tenant], actorId: actorIdFor(tenant, type, persona), actorType: type,
    status, lockedAt: null, displayName: `Test User ${n}`, email: `user${n}@example.com`, roleCodes,
    permissions: status === 'active' ? [...new Set(roleCodes.flatMap((r) => ROLE_GRANTS[r] ?? []))] : [],
    allCentres: true, centreIds: [], branchIds: [], mfaEnrolled: true, version: 1, ...o,
  };
};

export function makeCtx(tenant: 'A' | 'B', type: string, persona = 'default', over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANTS[tenant], actor: { type, id: actorIdFor(tenant, type, persona) }, requestId: '01900000-0000-7000-8000-0000000000e1',
    tx: { __brand: 'DbTx', seq: Math.random() }, now: () => FIXED_NOW, ports: {}, ...over,
  } as any;
}
