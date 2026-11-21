// SEC-AUTHZ-4 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1 approved design): behaviour matrix of the 53 identity operations that
// were `unguarded` in the classifier snapshot. Each handler is called directly (the central stage 8a is NOT in play), so what is
// proven here is the handler's OWN guard: IdentityPort.assertRole(ctx, { permission }) before any data is read or written.
// Synthetic data only. Pinned interface: the guard is `ctx.ports.IdentityPort.assertRole(ctx, { permission })` (the call
// audit-export.service.ts:121 and _audit-view.bind.ts already use); it throws LimsError auth.forbidden | auth.mfa_required |
// identity.support_session_required and the handler lets that error through unchanged (no new error code).
// Expected permission = the operation's contract x-permission, unless the operation is in
// services/api/src/core/pipeline/authz-exceptions.json (then its handlerPermission), or is listed in a SEC-AUTHZ-4 change request
// (.orchestra/cr/SEC-AUTHZ-4*.md: a wrong contract x-permission; then only "some permission is asked" is checked).
// Done_when named: inviteUser denied without identity.user.manage; approve/deny/revokeSupportSession denied without identity.settings.manage.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../core/errors.js';
import { handlers } from '../handlers/index.js';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const spec: any = parse(readFileSync(join(ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
const xPerm: Record<string, string> = {};
for (const item of Object.values<any>(spec.paths)) {
  for (const op of Object.values<any>(item)) if (op && typeof op === 'object' && op.operationId && op['x-permission']) xPerm[op.operationId] = op['x-permission'];
}
const exceptionsPath = join(ROOT, 'services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json');
const exceptions: Array<{ operationId: string; handlerPermission: string }> = existsSync(exceptionsPath) ? JSON.parse(readFileSync(exceptionsPath, 'utf8')) : [];
const crDir = join(ROOT, '.orchestra', 'cr');
const crText = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^SEC-AUTHZ-4.*\.md$/.test(f)).map((f) => readFileSync(join(crDir, f), 'utf8')).join('\n') : '';

// The 53 unguarded identity operations of the snapshot (module identity, bearerJwt, x-permission present, not platform.*).
export const UNGUARDED_IDENTITY = [
  'getMe', 'changeOwnPassword', 'listOwnSessions', 'revokeOwnSession', 'listOwnMfaFactors', 'removeOwnMfaFactor',
  'listUsers', 'inviteUser', 'searchUsers', 'getUser', 'updateUser', 'setUserRoles', 'setUserCentreScope', 'lockUser', 'unlockUser',
  'deactivateUser', 'reactivateUser', 'resendInvitation', 'resetUserMfa', 'revokeUserSessions', 'uploadUserSignature',
  'listPermissions', 'listRoles', 'createRole', 'getRole', 'updateRole', 'deactivateRole', 'applyRolePack',
  'listBranches', 'createBranch', 'updateBranch', 'deactivateBranch', 'reactivateBranch',
  'listCentres', 'createCentre', 'updateCentre', 'deactivateCentre', 'reactivateCentre',
  'getSettings', 'updateSettings', 'uploadBrandingAsset', 'getBrandingAssetContent', 'listFeatureFlags', 'setTenantFeatureFlag', 'listOwnIrdAnnexes',
  'listSessions', 'revokeSession', 'listTenantSupportSessions', 'approveSupportSession', 'denySupportSession', 'revokeSupportSession',
  'listAdminNotices', 'dismissAdminNotice',
] as const;

const expectedPermission = (op: string): string | undefined => {
  const ex = exceptions.find((e) => e.operationId === op);
  if (ex) return ex.handlerPermission;
  if (new RegExp(`\\b${op}\\b`).test(crText)) return undefined; // contract x-permission wrong: CR written, exactness not checked
  return xPerm[op];
};

const TENANT = '0190a000-0000-7000-8000-00000000aaaa';
const ACTOR = '0190a000-0000-7000-8000-000000004001';
const ID = '0190a000-0000-7000-8000-000000009001';
const req = {
  params: { membership_id: ID, role_id: ID, branch_id: ID, centre_id: ID, asset_id: ID, session_id: ID, support_session_id: ID, notice_id: ID, flag_code: 'x', factor_id: ID, user_id: ID },
  query: {}, headers: { 'if-match': '"1"' }, body: {},
};

function rig(actorType: string, assertRole: (ctx: any, r: { permission: string }) => Promise<unknown>) {
  const log: string[] = [];
  const query = vi.fn(async () => { log.push('data'); return { rows: [], rowCount: 0 }; });
  const asserted: string[] = [];
  const assert = vi.fn(async (ctx: any, r: { permission: string }) => { log.push('assert'); asserted.push(r.permission); return assertRole(ctx, r); });
  const side = { upload: vi.fn(), storeDelete: vi.fn(), stream: vi.fn() };
  const ctx: any = {
    tenantId: TENANT, actor: { type: actorType, id: ACTOR, membershipId: ID }, sessionId: ID, requestId: ID, now: () => new Date('2026-11-19T00:00:00Z'),
    tx: { query }, ports: { IdentityPort: { assertRole: assert } }, audit: { access: vi.fn(async () => undefined) },
    uploads: { accept: side.upload }, storage: { delete: side.storeDelete }, download: { stream: side.stream },
  };
  return { ctx, log, query, assert, asserted, side };
}
const run = async (op: string, ctx: any) => {
  try { await (handlers as Record<string, any>)[op](req, ctx); return undefined; } catch (e) { return e as any; }
};
const denyAll = (code = 'auth.forbidden') => async () => { throw new LimsError(code); };
const grantOnly = (granted: Set<string>) => async (_c: any, r: { permission: string }) => { if (!granted.has(r.permission)) throw new LimsError('auth.forbidden'); };
const noData = (r: ReturnType<typeof rig>) => {
  expect(r.query).not.toHaveBeenCalled();
  expect(r.side.upload).not.toHaveBeenCalled();
  expect(r.side.storeDelete).not.toHaveBeenCalled();
  expect(r.side.stream).not.toHaveBeenCalled();
};

describe('SEC-AUTHZ-4 identity: the snapshot list is real', () => {
  it('has 53 distinct operations, each with a handler and an x-permission that is not platform.*', () => {
    expect(new Set(UNGUARDED_IDENTITY).size).toBe(53);
    for (const op of UNGUARDED_IDENTITY) {
      expect(typeof (handlers as Record<string, unknown>)[op], op).toBe('function');
      expect(xPerm[op], op).toMatch(/^(identity|audit)\./);
    }
  });
});

describe('SEC-AUTHZ-4 identity: user without the permission is denied before any data is read or written', () => {
  it.each(UNGUARDED_IDENTITY)('%s: assertRole denies -> auth.forbidden, repository / upload / storage / download spies not called', async (op) => {
    const r = rig('user', denyAll());
    const err = await run(op, r.ctx);
    expect(err, `${op} must reject`).toBeInstanceOf(LimsError);
    expect(err.code).toBe('auth.forbidden');
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    noData(r);
  });

  it.each(['auth.mfa_required', 'identity.support_session_required'])('inviteUser and approveSupportSession pass %s through unchanged (no new error code)', async (code) => {
    for (const op of ['inviteUser', 'approveSupportSession']) {
      const r = rig('user', denyAll(code));
      const err = await run(op, r.ctx);
      expect(err?.code, op).toBe(code);
      noData(r);
    }
  });

  it('a user holding every identity permission EXCEPT the one needed is denied (no adjacent permission is enough)', async () => {
    const all = new Set(Object.values(xPerm));
    for (const op of UNGUARDED_IDENTITY) {
      const want = expectedPermission(op);
      if (!want) continue;
      const r = rig('user', grantOnly(new Set([...all, ...exceptions.map((e) => e.handlerPermission)].filter((p) => p !== want))));
      const err = await run(op, r.ctx);
      expect(err?.code, `${op} must be denied without ${want}`).toBe('auth.forbidden');
      noData(r);
    }
  });
});

describe('SEC-AUTHZ-4 identity: named done_when operations', () => {
  it.each([['inviteUser', 'identity.user.manage'], ['approveSupportSession', 'identity.settings.manage'], ['denySupportSession', 'identity.settings.manage'], ['revokeSupportSession', 'identity.settings.manage']])(
    '%s asks exactly %s and is denied without it', async (op, perm) => {
      const r = rig('user', grantOnly(new Set(['identity.user.read', 'identity.role.manage', 'identity.session.revoke', 'audit.log.read'])));
      const err = await run(op, r.ctx);
      expect(err?.code).toBe('auth.forbidden');
      expect(r.asserted).toContain(perm);
      expect(r.asserted.every((p) => p === perm), `${op} asked only ${perm}`).toBe(true);
      expect(r.log[0]).toBe('assert');
      noData(r);
    });
});

describe('SEC-AUTHZ-4 identity: user with exactly the permission reaches the handler', () => {
  it.each(UNGUARDED_IDENTITY)('%s: guard asks the declared permission first; with exactly that grant the guard does not deny', async (op) => {
    const want = expectedPermission(op);
    const r = rig('user', want ? grantOnly(new Set([want])) : async () => undefined);
    const err = await run(op, r.ctx);
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0], 'guard before any data access').toBe('assert');
    if (want) expect(new Set(r.asserted), `${op} asks exactly ${want}`).toEqual(new Set([want]));
    expect(err?.code, `${op} must not be denied by its own guard`).not.toBe('auth.forbidden');
  });
});

describe('SEC-AUTHZ-4 identity: patient, partner and portal actors are denied on staff operations', () => {
  // A realistic assertRole: only 'user' (staff) actors can hold a tenant permission. The handler must not read data either way.
  const staffOnly = async (ctx: any) => { if (ctx?.actor?.type !== 'user') throw new LimsError('auth.forbidden'); };
  const SELF = new Set(['getMe', 'changeOwnPassword', 'listOwnSessions', 'revokeOwnSession', 'listOwnMfaFactors', 'removeOwnMfaFactor']);
  for (const kind of ['patient', 'partner', 'portal']) {
    it.each(UNGUARDED_IDENTITY.filter((op) => !(kind === 'partner' && SELF.has(op))))(`${kind} actor: %s rejected, no data read`, async (op) => {
      const r = rig(kind, staffOnly);
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject a ${kind} actor`).toBeInstanceOf(LimsError);
      expect(['auth.forbidden', 'auth.unauthenticated']).toContain(err.code);
      noData(r);
    });
  }
});

describe('SEC-AUTHZ-4 identity: login, MFA, session, recovery and setup operations are not touched', () => {
  const PUBLIC_FLOW = ['loginStaff', 'verifyMfaChallenge', 'startMfaEnrolment', 'completeMfaEnrolment', 'resolveSession', 'logoutSession',
    'requestPasswordRecovery', 'confirmPasswordRecovery', 'confirmEmailToken', 'setInitialPassword'];
  it.each(PUBLIC_FLOW.filter((op) => op in handlers))('%s source does not call IdentityPort.assertRole', (op) => {
    const f = join(__dirname, '..', 'handlers', `${op}.ts`);
    if (!existsSync(f)) return;
    expect(readFileSync(f, 'utf8')).not.toMatch(/assertRole/);
  });
});
