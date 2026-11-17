// T13 HTTP wiring of the 15 §5.3 user operations (02-TRD 5.3; contracts/openapi/identity.yaml). The user SERVICE is mocked (behaviour: user.service.test.ts): these tests fix
// req -> service input mapping (snake_case -> camelCase), status codes, ETag / If-Match parsing, mass-assignment stripping, fail-closed behaviour and the contract facts the
// writer must not drift from (x-permission, x-idempotency, x-error-codes, phone pattern, additionalProperties:false). Schema validation, x-permission (+aal2 for privileged
// permissions, AC-B1.4) and Idempotency-Key replay (AC-B1.2) are the core pipeline's.
// ASSUMED: the multipart layer hands uploadUserSignature body = { file: { filename, mimeType, bytes } } (as uploadBrandingAsset, T16).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { TENANT_A, TENANT_B, idN, rejection, MEM, USER, REQ_ID } from './user.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['listUsers', 'searchUsers', 'inviteUser', 'getUser', 'updateUser', 'setUserRoles', 'setUserCentreScope', 'lockUser', 'unlockUser', 'deactivateUser', 'reactivateUser', 'resendInvitation', 'resetUserMfa', 'revokeUserSessions', 'uploadUserSignature'];
const VERSIONED = ['updateUser', 'setUserRoles', 'setUserCentreScope', 'lockUser', 'unlockUser', 'deactivateUser', 'reactivateUser', 'resetUserMfa'];
vi.mock('../user.service.js', () => ({ createUserService: () => svc }));
const { manifest } = await import('../../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];
const M = idN(0x401);

const noop = { info() {}, warn() {}, error() {} };
const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: noop, tenantId: TENANT_A, actor: { type: 'user', id: USER, membershipId: MEM }, requestId: REQ_ID, tx: { __tx: 1 } });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 })); });
const sent = (op: string) => svc[op]!.mock.calls[0]![1];

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s: no context -> auth.unauthenticated (the stub answers common.internal); service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: noop }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('service errors propagate unchanged (the core renders them)', async () => {
    svc['lockUser']!.mockRejectedValueOnce(new LimsError('identity.self_action_forbidden'));
    expect((await rejection(h('lockUser')(req({ params: { membership_id: M }, headers: { 'if-match': '"1"' }, body: { reason_code: 'other' } }), hctx('lockUser')))).code).toBe('identity.self_action_forbidden');
  });
  it('a failed call echoes no request input in code/message/detail', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['getUser']!.mockRejectedValueOnce(new LimsError('common.not_found'));
    const e = await rejection(h('getUser')(req({ params: { membership_id: planted }, headers: { authorization: planted } }), hctx('getUser')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
  it('the tenant given to the service is the context tenant, never one from params/query/body', async () => {
    await h('inviteUser')(req({ body: { tenant_id: TENANT_B, email: 'a@example.test', display_name: 'n', role_ids: [idN(1)], all_centres: true }, query: { tenant_id: TENANT_B } }), hctx('inviteUser'));
    expect(svc['inviteUser']!.mock.calls[0]![0].tenantId).toBe(TENANT_A);
  });
});

describe('request -> service mapping and responses', () => {
  it('listUsers: query snake_case -> camelCase; only known keys; 200 passthrough; no ETag', async () => {
    const r = await h('listUsers')(req({ query: { status: 'active', is_locked: false, role_id: idN(2), centre_id: idN(3), mfa_enrolled: true, sort: '-last_login_at', cursor: 'abc', limit: 20, tenant_id: TENANT_B, evil: 1 } }), hctx('listUsers'));
    expect(sent('listUsers')).toEqual({ status: 'active', isLocked: false, roleId: idN(2), centreId: idN(3), mfaEnrolled: true, sort: '-last_login_at', cursor: 'abc', limit: 20 });
    expect(r.status).toBe(200); expect(r.body).toEqual({ ok: 'listUsers' }); expect(r.headers?.etag).toBeUndefined();
  });
  it('listUsers: absent query keys stay absent (no undefined placeholders that could override defaults)', async () => {
    await h('listUsers')(req(), hctx('listUsers')); expect(Object.keys(sent('listUsers'))).toEqual([]);
  });
  it('searchUsers: body query/limit only; 200; no ETag', async () => {
    const r = await h('searchUsers')(req({ body: { query: 'demo', limit: 5, tenant_id: TENANT_B } }), hctx('searchUsers'));
    expect(sent('searchUsers')).toEqual({ query: 'demo', limit: 5 }); expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('inviteUser (AC-B1.5): snake_case body -> camelCase; tenant_id / permissions / status / version / membership_id are NOT forwarded; 201 + ETag of the new version', async () => {
    svc['inviteUser']!.mockResolvedValueOnce({ status: 201, body: { membership_id: M }, version: 1 });
    const body = { email: 'test.user.0042@example.test', display_name: 'Demo Lab Tech', phone_e164: '+9779841000000', role_ids: [idN(5)], all_centres: false, centre_ids: [idN(6)], branch_ids: [idN(7)],
      tenant_id: TENANT_B, permissions: ['platform.tenant.manage'], status: 'active', version: 9, membership_id: idN(8) };
    const r = await h('inviteUser')(req({ body, headers: { 'idempotency-key': 'k1' } }), hctx('inviteUser'));
    expect(sent('inviteUser')).toEqual({ email: 'test.user.0042@example.test', displayName: 'Demo Lab Tech', phoneE164: '+9779841000000', roleIds: [idN(5)], allCentres: false, centreIds: [idN(6)], branchIds: [idN(7)] });
    expect(Object.keys(sent('inviteUser')).sort()).toEqual(['allCentres', 'branchIds', 'centreIds', 'displayName', 'email', 'phoneE164', 'roleIds']); expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it('getUser: path membership_id -> membershipId; 200 + ETag "<version>"', async () => {
    const r = await h('getUser')(req({ params: { membership_id: M } }), hctx('getUser')); expect(svc['getUser']).toHaveBeenCalledWith(expect.anything(), { membershipId: M }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('updateUser: If-Match + body fields -> expectedVersion + camelCase; unknown keys (email, status, roles, tenant_id) dropped; 200 + ETag', async () => {
    const r = await h('updateUser')(req({ params: { membership_id: M }, headers: { 'if-match': '"2"' }, body: { display_name: 'N', phone_e164: '+9779841000000', signatory_title: 'MD', signatory_registration_no: 'R-1', unset: ['phone_e164'], email: 'x@example.test', status: 'deactivated', role_ids: [idN(1)], tenant_id: TENANT_B } }), hctx('updateUser'));
    expect(sent('updateUser')).toEqual({ membershipId: M, expectedVersion: 2, displayName: 'N', phoneE164: '+9779841000000', signatoryTitle: 'MD', signatoryRegistrationNo: 'R-1', unset: ['phone_e164'] });
    expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('setUserRoles / setUserCentreScope: only their own fields are forwarded', async () => {
    await h('setUserRoles')(req({ params: { membership_id: M }, headers: { 'if-match': '"4"' }, body: { role_ids: [idN(1)], permissions: ['x'], tenant_id: TENANT_B } }), hctx('setUserRoles'));
    expect(sent('setUserRoles')).toEqual({ membershipId: M, expectedVersion: 4, roleIds: [idN(1)] });
    await h('setUserCentreScope')(req({ params: { membership_id: M }, headers: { 'if-match': '"5"' }, body: { all_centres: false, centre_ids: [idN(2)], branch_ids: [idN(3)], role_ids: [idN(1)] } }), hctx('setUserCentreScope'));
    expect(sent('setUserCentreScope')).toEqual({ membershipId: M, expectedVersion: 5, allCentres: false, centreIds: [idN(2)], branchIds: [idN(3)] });
  });
  it.each(['lockUser', 'deactivateUser'])('%s: reason_code / reason_text + If-Match forwarded; nothing else; 200 + ETag', async (op) => {
    const r = await h(op)(req({ params: { membership_id: M }, headers: { 'if-match': '"6"' }, body: { reason_code: 'security_concern', reason_text: 'Synthetic', status: 'active', locked_at: 'x' } }), hctx(op));
    expect(sent(op)).toEqual({ membershipId: M, expectedVersion: 6, reasonCode: 'security_concern', reasonText: 'Synthetic' }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each(['lockUser', 'deactivateUser'])('%s: reason_text omitted stays omitted', async (op) => {
    await h(op)(req({ params: { membership_id: M }, headers: { 'if-match': '"6"' }, body: { reason_code: 'other' } }), hctx(op)); expect(Object.keys(sent(op)).sort()).toEqual(['expectedVersion', 'membershipId', 'reasonCode']);
  });
  it.each(['unlockUser', 'reactivateUser'])('%s: If-Match only; a body is ignored; 200 + ETag', async (op) => {
    const r = await h(op)(req({ params: { membership_id: M }, headers: { 'if-match': '"7"' }, body: { status: 'active' } }), hctx(op));
    expect(sent(op)).toEqual({ membershipId: M, expectedVersion: 7 }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('resetUserMfa: reason_text + If-Match; 200 + ETag', async () => {
    const r = await h('resetUserMfa')(req({ params: { membership_id: M }, headers: { 'if-match': '"8"' }, body: { reason_text: 'Lost device, synthetic', extra: 1 } }), hctx('resetUserMfa'));
    expect(sent('resetUserMfa')).toEqual({ membershipId: M, expectedVersion: 8, reasonText: 'Lost device, synthetic' }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('resendInvitation: 202 from the service, empty-object body, NO ETag, no If-Match involved', async () => {
    svc['resendInvitation']!.mockResolvedValueOnce({ status: 202, body: {} });
    const r = await h('resendInvitation')(req({ params: { membership_id: M }, headers: { 'if-match': '"1"' } }), hctx('resendInvitation'));
    expect(sent('resendInvitation')).toEqual({ membershipId: M }); expect(r.status).toBe(202); expect(r.body).toEqual({}); expect(r.headers?.etag).toBeUndefined();
  });
  it('revokeUserSessions: path id only; 200 {revoked}; no ETag', async () => {
    svc['revokeUserSessions']!.mockResolvedValueOnce({ status: 200, body: { revoked: 2 } });
    const r = await h('revokeUserSessions')(req({ params: { membership_id: M } }), hctx('revokeUserSessions')); expect(sent('revokeUserSessions')).toEqual({ membershipId: M }); expect(r.body).toEqual({ revoked: 2 }); expect(r.headers?.etag).toBeUndefined();
  });
  it('uploadUserSignature: path id + the multipart file only (membership_id / tenant_id / kind in the body are ignored); 200 + ETag', async () => {
    const file = { filename: 'sig.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
    const r = await h('uploadUserSignature')(req({ params: { membership_id: M }, body: { file, membership_id: idN(9), tenant_id: TENANT_B, kind: 'logo' }, headers: { 'idempotency-key': 'k' } }), hctx('uploadUserSignature'));
    expect(sent('uploadUserSignature')).toEqual({ membershipId: M, file }); expect(Object.keys(sent('uploadUserSignature')).sort()).toEqual(['file', 'membershipId']); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each(VERSIONED)('%s If-Match: absent -> expectedVersion undefined (service answers 428); malformed -> 0 or undefined (service answers 400), never a thrown crash', async (op) => {
    const body = { display_name: 'n', role_ids: [idN(1)], all_centres: true, reason_code: 'other', reason_text: 'x' };
    await h(op)(req({ params: { membership_id: M }, body }), hctx(op)); expect(sent(op).expectedVersion).toBeUndefined();
    for (const bad of ['2', 'W/"2"', '"0"', '"-1"', '"1.5"', '"abc"', '"99999999999"', '*', '']) {
      svc[op]!.mockClear(); await h(op)(req({ params: { membership_id: M }, headers: { 'if-match': bad }, body }), hctx(op)); expect([0, undefined]).toContain(svc[op]!.mock.calls[0]![1].expectedVersion);
    }
  });
});

describe('contract (contracts/openapi/identity.yaml) - paths, permissions, idempotency, error codes, schemas', () => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const ops: Record<string, any> = {}; const where: Record<string, string> = {};
  for (const [p, item] of Object.entries<any>(spec.paths)) for (const m of ['get', 'post', 'put', 'delete', 'patch']) if (item[m]?.operationId) { ops[item[m].operationId] = item[m]; where[item[m].operationId] = `${m.toUpperCase()} ${p}`; }
  it.each([
    ['listUsers', 'GET /v1/identity/users', 'identity.user.read', 'none', []],
    ['searchUsers', 'POST /v1/identity/users/search', 'identity.user.read', 'none', []],
    ['inviteUser', 'POST /v1/identity/users', 'identity.user.manage', 'required', ['identity.user_exists', 'identity.role_unknown', 'identity.centre_inactive', 'common.idempotency_key_reused']],
    ['getUser', 'GET /v1/identity/users/{membership_id}', 'identity.user.read', 'none', []],
    ['updateUser', 'PATCH /v1/identity/users/{membership_id}', 'identity.user.manage', 'optional', ['common.version_conflict', 'common.precondition_required']],
    ['setUserRoles', 'PUT /v1/identity/users/{membership_id}/roles', 'identity.role.manage', 'optional', ['identity.role_unknown', 'identity.last_admin_protected', 'common.version_conflict', 'common.precondition_required']],
    ['setUserCentreScope', 'PUT /v1/identity/users/{membership_id}/centre-scope', 'identity.user.manage', 'optional', ['identity.centre_inactive', 'common.version_conflict', 'common.precondition_required']],
    ['lockUser', 'POST /v1/identity/users/{membership_id}/lock', 'identity.user.manage', 'optional', ['identity.last_admin_protected', 'identity.self_action_forbidden', 'common.version_conflict', 'common.precondition_required']],
    ['unlockUser', 'POST /v1/identity/users/{membership_id}/unlock', 'identity.user.manage', 'optional', ['common.version_conflict', 'common.precondition_required']],
    ['deactivateUser', 'POST /v1/identity/users/{membership_id}/deactivate', 'identity.user.manage', 'optional', ['identity.last_admin_protected', 'identity.self_action_forbidden', 'common.version_conflict', 'common.precondition_required']],
    ['reactivateUser', 'POST /v1/identity/users/{membership_id}/reactivate', 'identity.user.manage', 'optional', ['common.version_conflict', 'common.precondition_required']],
    ['resendInvitation', 'POST /v1/identity/users/{membership_id}/resend-invitation', 'identity.user.manage', 'optional', ['common.version_conflict']],
    ['resetUserMfa', 'POST /v1/identity/users/{membership_id}/reset-mfa', 'identity.user.manage', 'optional', ['identity.self_action_forbidden', 'common.version_conflict', 'common.precondition_required']],
    ['revokeUserSessions', 'POST /v1/identity/users/{membership_id}/revoke-sessions', 'identity.session.revoke', 'optional', []],
    ['uploadUserSignature', 'POST /v1/identity/users/{membership_id}/signature', 'identity.user.manage', 'required', ['common.payload_too_large', 'common.unsupported_media_type', 'common.upload_quarantined', 'common.idempotency_key_reused']],
  ])('%s: %s, x-permission %s, x-idempotency %s, x-error-codes include %j', (op, route, perm, idem, codes) => {
    expect(where[op]).toBe(route); expect(ops[op]['x-permission']).toBe(perm); expect(ops[op]['x-idempotency']).toBe(idem); for (const c of codes) expect(ops[op]['x-error-codes']).toContain(c);
  });
  it('every versioned operation declares the IfMatch parameter; resend / revoke / invite / upload do not', () => {
    const has = (op: string) => JSON.stringify(ops[op].parameters ?? []).includes('IfMatch');
    for (const op of VERSIONED) expect(has(op)).toBe(true); for (const op of ['resendInvitation', 'revokeUserSessions', 'inviteUser', 'uploadUserSignature']) expect(has(op)).toBe(false);
  });
  it('AC-B1.5 UserInviteRequest rejects unknown fields and has no tenant_id / permissions property; every request schema is additionalProperties:false', () => {
    const s = spec.components.schemas;
    for (const n of ['UserInviteRequest', 'UserUpdateRequest', 'UserRolesRequest', 'UserCentreScopeRequest', 'MembershipReasonRequest', 'ReasonTextRequest', 'UserSearchRequest', 'FileUpload']) expect(s[n].additionalProperties).toBe(false);
    for (const k of ['tenant_id', 'permissions', 'status', 'membership_id']) expect(Object.keys(s['UserInviteRequest'].properties)).not.toContain(k);
  });
  it('D-T7 the phone pattern is exactly ^\\+[1-9][0-9]{7,14}$ on inviteUser and updateUser, and the same cases behave as the DB check', () => {
    const s = spec.components.schemas; for (const n of ['UserInviteRequest', 'UserUpdateRequest']) expect(s[n].properties.phone_e164.pattern).toBe('^\\+[1-9][0-9]{7,14}$');
    const re = new RegExp(s['UserInviteRequest'].properties.phone_e164.pattern);
    for (const ok of ['+9779841000000']) expect(re.test(ok)).toBe(true); for (const bad of ['9779841000000', '+0123456789', '+1234567']) expect(re.test(bad)).toBe(false);
  });
  it('request limits: invite roles 1-20, centres <=200, branches <=50; reason codes are the four lock/deactivate codes; unset is the three profile fields; reason_text required for reset-mfa', () => {
    const s = spec.components.schemas; const inv = s['UserInviteRequest'];
    expect([inv.properties.role_ids.minItems, inv.properties.role_ids.maxItems, inv.properties.centre_ids.maxItems, inv.properties.branch_ids.maxItems]).toEqual([1, 20, 200, 50]);
    expect(s['MembershipReasonRequest'].properties.reason_code.enum).toEqual(['left_organisation', 'security_concern', 'policy_violation', 'other']);
    expect(s['UserUpdateRequest'].properties.unset.items.enum).toEqual(['phone_e164', 'signatory_title', 'signatory_registration_no']); expect(s['ReasonTextRequest'].required).toEqual(['reason_text']);
  });
  it('the User / UserSummary responses never carry the raw e-mail, raw phone, user id or signature path', () => {
    for (const n of ['User', 'UserSummary']) for (const k of ['email', 'email_normalized', 'phone_e164', 'user_id', 'signature_image_ref', 'tenant_id']) expect(Object.keys(spec.components.schemas[n].properties)).not.toContain(k);
  });
});
