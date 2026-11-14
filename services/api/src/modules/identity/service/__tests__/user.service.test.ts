// T13 Users API - service behaviour (02-TRD 5.3; 03-APP-FLOW 2.2, 4.1-4.5; 01-PRD AC-B1.1-5, AC-B2.3-4, AC-B3.3, AC-B4.1-4, US-B5, US-B6; 07-SECURITY D-T7, D-T8, D-T13).
// Seams: see user.helpers.ts header. Expected now: every test fails because ../user.service.js does not exist.
// ASSUMED (spec silent, decided by the tester): a repeat transition (lock a locked user, deactivate a deactivated one, reactivate an active one, unlock an unlocked one)
// answers 409 common.version_conflict (contract lists no other code); unknown/foreign centre or branch ids -> 400 common.validation_failed at /centre_ids/<i> | /branch_ids/<i>;
// an inactive branch -> 409 identity.centre_inactive (02-TRD 5.5); self-action is checked before last-admin; partner/patient membership ids -> 404.
import { describe, expect, it } from 'vitest';
import { createUserService } from '../user.service.js';
import {
  ADMIN, B1, B_INACTIVE, C1, C2, C_B, C_INACTIVE, NOW, R_ADMIN, R_ADMIN2, R_B, R_FD, R_INACTIVE, TENANT_A, TENANT_B, USER, adminRole, assertWire, defaultSeed, idN, makeDeps,
  member, png, EICAR, incoming, rejection, role, type Member,
} from './user.helpers.js';

const T1 = idN(0x401), ADM2 = idN(0x4a2), R_UM = idN(0x105), R_INACT_ADMIN = idN(0x106);
const mk = async (extra: Member[] = [], o: { roles?: any[]; actorRoles?: string[]; gotrue?: any; userExists?: boolean } = {}) => {
  const seed = defaultSeed();
  seed.roles = [...seed.roles!, role(R_UM, { permission_codes: ['identity.user.manage', 'identity.user.read'] }), adminRole(R_INACT_ADMIN, { is_active: false }), ...(o.roles ?? [])];
  seed.members = [member({ id: ADMIN, user_id: USER, role_ids: o.actorRoles ?? [R_ADMIN], display_name: 'Demo Admin', email_normalized: 'demo.admin@example.test' }), ...extra];
  const d = await makeDeps({ seed, ...(o.gotrue ? { gotrue: o.gotrue } : {}), ...(o.userExists !== undefined ? { userExists: o.userExists } : {}) });
  return { ...d, svc: createUserService(d.deps as any) as Record<string, (ctx: any, input: any) => Promise<any>> };
};
const target = (o: Partial<Member> = {}) => member({ id: T1, display_name: 'Demo Target', email_normalized: 'demo.target.0042@example.test', phone_e164: '+9779841000000', ...o });
const iso = (v: unknown) => new Date(v as any).toISOString();
const INVITE = { email: 'test.user.0042@example.test', displayName: 'Demo Lab Tech', roleIds: [R_FD], allCentres: false, centreIds: [C1] };
const writesOf = (f: { writes: string[] }) => f.writes.filter((w) => w !== 'updateMembership');

describe('AC-B1.1 inviteUser', () => {
  it('201 User in state invited, version 1; membership + roles + centres + invitation written on the request tx and tenant; job enqueued', async () => {
    const { svc, ctx, fake, g, deps } = await mk();
    const r = await svc['inviteUser']!(ctx, { ...INVITE, phoneE164: '+9779841000000' });
    expect(r.status).toBe(201); expect(r.version).toBe(1); assertWire(r.body, 'User');
    expect(r.body).toMatchObject({ status: 'invited', is_locked: false, all_centres: false, centre_ids: [C1], mfa_enrolled: false, version: 1, invitation: { status: 'pending' } });
    expect(r.body.roles.map((x: any) => x.role_id)).toEqual([R_FD]);
    expect(g.gotrue.adminCreateUser).toHaveBeenCalledWith({ email: 'test.user.0042@example.test', emailConfirm: false });
    const mem = fake.by('insertMembership')[0]!; expect((mem.args[0] as any).allCentres).toBe(false);
    expect(fake.by('replaceRoles')[0]!.args.slice(1, 2)).toEqual([[R_FD]]);
    expect(fake.by('replaceScope')[0]!.args[1]).toEqual({ centreIds: [C1], branchIds: [] });
    expect(fake.calls.filter((c) => c.m !== 'enqueue').every((c) => c.tx === ctx.tx && c.tenantId === TENANT_A)).toBe(true);
    expect(deps.emailHmac).toHaveBeenCalledWith('test.user.0042@example.test');
  });
  it('core.users id = the GoTrue user id; e-mail stored normalised (trim, NFC, lower-case) with a 32-byte HMAC; phone stored as given', async () => {
    const { svc, ctx, fake, g } = await mk();
    await svc['inviteUser']!(ctx, { ...INVITE, email: '  Test.User.0042@Example.TEST ', phoneE164: '+9779841000000' });
    expect(g.created[0]).toEqual({ email: 'test.user.0042@example.test', emailConfirm: false });
    const u = fake.by('insertUser')[0]!.args[0] as any;
    expect(u.emailNormalized).toBe('test.user.0042@example.test'); expect(u.emailHmac).toBeInstanceOf(Buffer); expect(u.emailHmac.length).toBe(32); expect(u.phoneE164).toBe('+9779841000000'); expect(u.actorId).toBe(USER);
    expect((fake.by('insertMembership')[0]!.args[0] as any).userId).toBe(u.id);
  });
  it('invitation pending, expires now()+72h, e-mail on the row; ONE identity.send_invitation job {tenant_id, invitation_id}, key invite:<invitation_id>:1, enqueued after the invitation row', async () => {
    const { svc, ctx, fake } = await mk();
    const r = await svc['inviteUser']!(ctx, INVITE);
    const inv = fake.st.invitations[0]!; expect(iso(inv.expiresAt)).toBe(iso(new Date(new Date(NOW).getTime() + 72 * 3_600_000))); expect(inv.email).toBe('test.user.0042@example.test');
    expect(iso(r.body.invitation.expires_at)).toBe(iso(inv.expiresAt));
    const jobs = fake.jobs('identity.send_invitation'); expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ tenant_id: TENANT_A, invitation_id: inv.id }); expect(jobs[0]!.jobKey).toBe(`invite:${inv.id}:1`);
    expect(fake.writes.indexOf('enqueue')).toBeGreaterThan(fake.writes.indexOf('insertInvitation'));
  });
  it('the e-mail never appears in the response, and the invitation is not a session: no revoke call', async () => {
    const { svc, ctx, fake } = await mk(); const r = await svc['inviteUser']!(ctx, { ...INVITE, phoneE164: '+9779841000000' });
    expect(JSON.stringify(r.body)).not.toContain('test.user.0042@example.test'); expect(JSON.stringify(r.body)).not.toContain('9779841000000'); expect(fake.writes).not.toContain('revokeSessions');
  });
  it('all_centres=true: centres stored empty (given ids ignored, even an inactive one); branch_ids kept', async () => {
    const { svc, ctx, fake } = await mk(); await svc['inviteUser']!(ctx, { ...INVITE, allCentres: true, centreIds: [C_INACTIVE, C1], branchIds: [B1] });
    expect((fake.by('insertMembership')[0]!.args[0] as any).allCentres).toBe(true); expect(fake.by('replaceScope')[0]!.args[1]).toEqual({ centreIds: [], branchIds: [B1] });
  });
  it('tenant and actor come from ctx only; input tenantId / permissions / status are ignored', async () => {
    const { svc, ctx, fake } = await mk(); await svc['inviteUser']!(ctx, { ...INVITE, tenantId: TENANT_B, permissions: ['platform.tenant.manage'], status: 'active', version: 9 });
    expect(fake.calls.filter((c) => c.m !== 'enqueue').every((c) => c.tenantId === TENANT_A)).toBe(true);
    expect(fake.jobs('identity.send_invitation')[0]!.payload['tenant_id']).toBe(TENANT_A);
  });
});

describe('inviteUser validation: nothing is written and GoTrue is not called', () => {
  it.each([
    ['e-mail without @', { email: 'not-an-email' }, '/email'], ['e-mail 255 chars', { email: `${'a'.repeat(246)}@example.test` }, '/email'], ['empty display name', { displayName: '' }, '/display_name'],
    ['display name 121 chars', { displayName: 'x'.repeat(121) }, '/display_name'], ['no roles', { roleIds: [] }, '/role_ids'], ['21 roles', { roleIds: Array.from({ length: 21 }, (_, i) => idN(0x800 + i)) }, '/role_ids'],
    ['role id not a uuid', { roleIds: ['nope'] }, '/role_ids/0'], ['all_centres false and no centres', { allCentres: false, centreIds: [] }, '/centre_ids'],
    ['all_centres false and centres omitted', { allCentres: false, centreIds: undefined }, '/centre_ids'], ['201 centres', { centreIds: Array.from({ length: 201 }, (_, i) => idN(0x900 + i)) }, '/centre_ids'],
    ['51 branches', { branchIds: Array.from({ length: 51 }, (_, i) => idN(0xa00 + i)) }, '/branch_ids'],
  ])('%s -> 400 common.validation_failed at %s', async (_n, patch, path) => {
    const { svc, ctx, fake, g } = await mk(); const e = await rejection(svc['inviteUser']!(ctx, { ...INVITE, ...patch }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toContain(path);
    expect(fake.writes).toEqual([]); expect(g.gotrue.adminCreateUser).not.toHaveBeenCalled();
  });
  it('unknown / inactive / foreign-tenant role -> 422 identity.role_unknown, before GoTrue', async () => {
    for (const bad of [idN(0xdead), R_INACTIVE, R_B]) {
      const { svc, ctx, fake, g } = await mk(); const e = await rejection(svc['inviteUser']!(ctx, { ...INVITE, roleIds: [R_FD, bad] }));
      expect(e.code).toBe('identity.role_unknown'); expect(fake.writes).toEqual([]); expect(g.gotrue.adminCreateUser).not.toHaveBeenCalled();
    }
  });
  it('AC-B3.3 inactive centre or inactive branch -> 409 identity.centre_inactive', async () => {
    for (const patch of [{ centreIds: [C1, C_INACTIVE] }, { branchIds: [B_INACTIVE] }]) {
      const { svc, ctx, fake, g } = await mk(); const e = await rejection(svc['inviteUser']!(ctx, { ...INVITE, ...patch }));
      expect(e.code).toBe('identity.centre_inactive'); expect(fake.writes).toEqual([]); expect(g.gotrue.adminCreateUser).not.toHaveBeenCalled();
    }
  });
  it('a centre of another tenant or a missing centre is not distinguishable from nothing: 400 at /centre_ids/<i> (no oracle on foreign ids)', async () => {
    for (const bad of [C_B, idN(0xdead)]) {
      const { svc, ctx, fake } = await mk(); const e = await rejection(svc['inviteUser']!(ctx, { ...INVITE, centreIds: [C1, bad] }));
      expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toEqual(['/centre_ids/1']); expect(fake.writes).toEqual([]);
    }
  });
});

describe('D-T7 phone_e164 ^\\+[1-9][0-9]{7,14}$ (08 A6.2) on inviteUser and updateUser', () => {
  const GOOD = ['+9779841000000', '+12345678', '+123456789012345'];
  const BAD = ['9779841000000', '+0123456789', '+1234567', '+1234567890123456', '+977 9841000000', '+9779841000000\n', '++9779841000000', '+97798410000a0', ''];
  it.each(GOOD)('inviteUser accepts %s', async (p) => { const { svc, ctx } = await mk(); expect((await svc['inviteUser']!(ctx, { ...INVITE, phoneE164: p })).status).toBe(201); });
  it.each(BAD)('inviteUser rejects %j -> 400 at /phone_e164, nothing written', async (p) => {
    const { svc, ctx, fake, g } = await mk(); const e = await rejection(svc['inviteUser']!(ctx, { ...INVITE, phoneE164: p }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toEqual(['/phone_e164']); expect(fake.writes).toEqual([]); expect(g.gotrue.adminCreateUser).not.toHaveBeenCalled();
  });
  it.each(GOOD)('updateUser accepts %s and writes it to core.users', async (p) => {
    const { svc, ctx, fake } = await mk([target()]); await svc['updateUser']!(ctx, { membershipId: T1, expectedVersion: 1, phoneE164: p });
    expect(fake.st.profileWrites[0]!.set).toEqual({ phone_e164: p });
  });
  it.each(BAD)('updateUser rejects %j -> 400 at /phone_e164, nothing written', async (p) => {
    const { svc, ctx, fake } = await mk([target()]); const e = await rejection(svc['updateUser']!(ctx, { membershipId: T1, expectedVersion: 1, phoneE164: p }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toEqual(['/phone_e164']); expect(fake.writes).toEqual([]);
  });
});

describe('AC-B1.3 e-mail already has an account', () => {
  it('GoTrue exists + core.users row (any tenant) -> 409 identity.user_exists, generic, no write, no job; DEFINER check gets the GoTrue user id', async () => {
    const { svc, ctx, fake, userExists } = await mk([], { gotrue: { existing: new Set(['test.user.0042@example.test']) }, userExists: true });
    const e = await rejection(svc['inviteUser']!(ctx, INVITE));
    expect(e.code).toBe('identity.user_exists'); expect(userExists).toHaveBeenCalledWith(ctx.tx, idN(0xa000 + 99));
    expect(JSON.stringify({ m: e.message, d: e.detail, e: e.errors })).not.toContain('test.user.0042'); expect(fake.writes).toEqual([]);
  });
  it('GoTrue exists but no core.users row (orphan of a rolled-back attempt) -> the GoTrue user is reused', async () => {
    const { svc, ctx, fake } = await mk([], { gotrue: { existing: new Set(['test.user.0042@example.test']) }, userExists: false });
    const r = await svc['inviteUser']!(ctx, INVITE); expect(r.status).toBe(201); expect((fake.by('insertUser')[0]!.args[0] as any).id).toBe(idN(0xa000 + 99));
  });
  it('GoTrue outage -> the error propagates, nothing written, never user_exists', async () => {
    const { svc, ctx, fake } = await mk([], { gotrue: { fail: new Error('gotrue down') } }); const e = await rejection(svc['inviteUser']!(ctx, INVITE));
    expect(e.code).not.toBe('identity.user_exists'); expect(fake.writes).toEqual([]);
  });
  it.each(['insertUser', 'insertMembership'])('race: unique violation (23505) from %s -> 409 identity.user_exists, no job', async (m) => {
    const { svc, ctx, fake } = await mk(); fake.fail[m] = Object.assign(new Error('duplicate key'), { code: '23505' });
    const e = await rejection(svc['inviteUser']!(ctx, INVITE)); expect(e.code).toBe('identity.user_exists'); expect(fake.jobs('identity.send_invitation')).toHaveLength(0);
  });
});

describe('reads: listUsers / searchUsers / getUser', () => {
  const people = () => [target({ mfa_enrolled: true, last_login_at: '2026-11-05T04:15:00.000Z', centre_ids: [C1, C2] }), member({ id: ADM2, role_ids: [R_ADMIN2], locked_at: NOW, locked_by: USER, status: 'active', display_name: 'Demo Two' })];
  it('listUsers: defaults sort display_name, limit 50; UserPage of UserSummary only (no email, phone, branch/centre ids, lock, signatory)', async () => {
    const { svc, ctx, fake } = await mk(people()); const r = await svc['listUsers']!(ctx, {});
    expect(fake.by('listUsers')[0]!.args[0]).toMatchObject({ sort: 'display_name', limit: 50 }); expect(r.status).toBe(200);
    expect(r.body.page).toEqual({ limit: 50 }); expect(r.body.data.length).toBe(3);
    for (const u of r.body.data) { assertWire(u, 'UserSummary'); expect(u.email_masked).not.toContain('example.test'); }
    const t = r.body.data.find((u: any) => u.membership_id === T1);
    expect(t).toMatchObject({ is_locked: false, centre_count: 2, all_centres: false, mfa_enrolled: true, last_login_at: '2026-11-05T04:15:00.000Z', version: 1, status: 'active' });
    expect(r.body.data.find((u: any) => u.membership_id === ADM2).is_locked).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/phone|signatory|centre_ids|branch_ids|email_normalized|9779841000000/);
  });
  it('listUsers: only actor_type user is listed (partner / patient memberships never appear)', async () => {
    const { svc, ctx } = await mk([member({ id: idN(0x411), actor_type: 'partner' }), member({ id: idN(0x412), actor_type: 'patient' })]); const r = await svc['listUsers']!(ctx, {});
    expect(r.body.data.map((u: any) => u.membership_id)).toEqual([ADMIN]);
  });
  it('listUsers: filters and sort are mapped to the repo; cursor passed through; next_cursor only when the repo has more', async () => {
    const { svc, ctx, fake } = await mk(people());
    await svc['listUsers']!(ctx, { status: 'active', isLocked: false, roleId: R_FD, centreId: C1, mfaEnrolled: true, sort: '-last_login_at', cursor: 'abc_-9', limit: 1 });
    expect(fake.by('listUsers')[0]!.args[0]).toEqual({ status: 'active', isLocked: false, roleId: R_FD, centreId: C1, mfaEnrolled: true, sort: '-last_login_at', cursor: 'abc_-9', limit: 1 });
    const r = await svc['listUsers']!(ctx, { limit: 1 }); expect(r.body.page).toEqual({ limit: 1, next_cursor: 'Y3Vyc29y' });
  });
  it.each([[{ limit: 0 }, '/limit'], [{ limit: 201 }, '/limit'], [{ limit: 1.5 }, '/limit'], [{ status: 'bogus' }, '/status'], [{ sort: 'password' }, '/sort'], [{ roleId: 'x' }, '/role_id'], [{ centreId: 'x' }, '/centre_id'], [{ isLocked: 'yes' }, '/is_locked']])('listUsers %j -> 400 at %s, repo untouched', async (input, path) => {
    const { svc, ctx, fake } = await mk(); const e = await rejection(svc['listUsers']!(ctx, input));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toContain(path); expect(fake.by('listUsers')).toHaveLength(0);
  });
  it('searchUsers: trimmed query 2-100 and limit forwarded; same page shape; no e-mail returned even when matched by e-mail prefix', async () => {
    const { svc, ctx, fake } = await mk(people()); const r = await svc['searchUsers']!(ctx, { query: '  demo.target  ', limit: 20 });
    expect(fake.by('searchUsers')[0]!.args[0]).toEqual({ query: 'demo.target', limit: 20 }); expect(r.body.data.map((u: any) => u.membership_id)).toEqual([T1]);
    assertWire(r.body.data[0], 'UserSummary'); expect(JSON.stringify(r.body)).not.toContain('demo.target.0042@example.test');
    await svc['searchUsers']!(ctx, { query: 'ab' }); expect(fake.by('searchUsers')[1]!.args[0]).toEqual({ query: 'ab', limit: 50 });
  });
  it.each([[{ query: 'a' }], [{ query: ' a ' }], [{ query: '' }], [{ query: 'x'.repeat(101) }], [{ query: 'ab', limit: 0 }], [{ query: 'ab', limit: 201 }], [{}], [{ query: 42 }]])('searchUsers %j -> 400, repo untouched', async (input) => {
    const { svc, ctx, fake } = await mk(); const e = await rejection(svc['searchUsers']!(ctx, input)); expect(e.code).toBe('common.validation_failed'); expect(fake.by('searchUsers')).toHaveLength(0);
  });
  it('searchUsers: LIKE metacharacters are data, not wildcards - the raw query reaches the repo untouched (the repo escapes; see user.static)', async () => {
    const { svc, ctx, fake } = await mk(people()); await svc['searchUsers']!(ctx, { query: '%_' }); expect(fake.by('searchUsers')[0]!.args[0]).toMatchObject({ query: '%_' });
  });
  it('getUser: full User - masked e-mail and phone, ids, signatory, lock and invitation sub-objects only when present; no nulls; never the raw e-mail, phone, signature path, version-less', async () => {
    const lockedInvited = target({ status: 'invited', locked_at: NOW, locked_by: USER, lock_reason_code: 'security_concern', lock_reason_text: 'secret reason', branch_ids: [B1], signatory_display_title: 'MD Pathology', signatory_registration_no: 'NMC-SYN-0001',
      signature_image_ref: `${TENANT_A}/signatures/${T1}/x.png`, signature_asset_id: idN(0x551), invitation: { status: 'sent', expires_at: '2026-11-11T06:00:00.000Z' }, version: 4 });
    const { svc, ctx } = await mk([lockedInvited]); const r = await svc['getUser']!(ctx, { membershipId: T1 });
    expect(r.status).toBe(200); expect(r.version).toBe(4); assertWire(r.body, 'User');
    expect(r.body).toMatchObject({ branch_ids: [B1], centre_ids: [C1], signatory: { display_title: 'MD Pathology', registration_no: 'NMC-SYN-0001', signature_asset_id: idN(0x551) }, lock: { locked_at: NOW, reason_code: 'security_concern' }, invitation: { status: 'sent' } });
    expect(r.body.phone_masked).not.toBe('+9779841000000'); expect(r.body.phone_masked.length).toBeLessThanOrEqual(20); expect(r.body.phone_masked.endsWith('0000')).toBe(true);
    const s = JSON.stringify(r.body); for (const leak of ['demo.target.0042@example.test', '+9779841000000', 'secret reason', '/signatures/', 'email_normalized', 'user_id']) expect(s).not.toContain(leak);
  });
  it('getUser: a plain user has no signatory / lock / invitation / phone_masked keys', async () => {
    const { svc, ctx } = await mk([target({ phone_e164: null })]); const r = await svc['getUser']!(ctx, { membershipId: T1 });
    for (const k of ['signatory', 'lock', 'invitation', 'phone_masked', 'last_login_at']) expect(r.body).not.toHaveProperty(k);
  });
  it('getUser: last_login_at is the per-tenant membership value (D-T8)', async () => {
    const { svc, ctx } = await mk([target({ last_login_at: '2026-11-05T04:15:00.000Z' })]); expect((await svc['getUser']!(ctx, { membershipId: T1 })).body.last_login_at).toBe('2026-11-05T04:15:00.000Z');
  });
  it.each([['unknown id', idN(0xdead)], ['not a uuid', 'abc'], ['partner membership', idN(0x411)], ['patient membership', idN(0x412)]])('getUser %s -> 404 common.not_found', async (_n, id) => {
    const { svc, ctx } = await mk([member({ id: idN(0x411), actor_type: 'partner' }), member({ id: idN(0x412), actor_type: 'patient' })]);
    expect((await rejection(svc['getUser']!(ctx, { membershipId: id }))).code).toBe('common.not_found');
  });
  it('getUser still finds a deactivated member (history stays visible)', async () => {
    const { svc, ctx } = await mk([member({ id: idN(0x413), status: 'deactivated' })]); expect((await svc['getUser']!(ctx, { membershipId: idN(0x413) })).body.status).toBe('deactivated');
  });
  it('tenant isolation: a membership of tenant B is 404 for a tenant-A context and the lookup carries the context tenant', async () => {
    const { svc, ctx, fake } = await mk([target({ tenant_id: TENANT_B })]); expect((await rejection(svc['getUser']!(ctx, { membershipId: T1 }))).code).toBe('common.not_found');
    expect(fake.by('findMember')[0]).toMatchObject({ tenantId: TENANT_A, tx: ctx.tx });
  });
});

describe('If-Match, stale versions and unknown targets (every versioned operation)', () => {
  const lockedT = { locked_at: NOW, locked_by: ADMIN }, deact = { status: 'deactivated' as const, deactivated_at: NOW, deactivated_by: USER, deactivation_reason_code: 'other' };
  const OPS: Array<[string, Partial<Member>, Record<string, unknown>]> = [
    ['updateUser', {}, { displayName: 'New Name' }], ['setUserRoles', {}, { roleIds: [R_FD] }], ['setUserCentreScope', {}, { allCentres: false, centreIds: [C1] }],
    ['lockUser', {}, { reasonCode: 'security_concern' }], ['unlockUser', lockedT, {}], ['deactivateUser', {}, { reasonCode: 'left_organisation' }], ['reactivateUser', deact, {}],
    ['resetUserMfa', { mfa_enrolled: true }, { reasonText: 'Lost device, synthetic' }],
  ];
  it.each(OPS)('%s: missing If-Match -> 428 common.precondition_required; no write at all', async (op, over, input) => {
    const { svc, ctx, fake } = await mk([target(over)]); const e = await rejection(svc[op]!(ctx, { membershipId: T1, expectedVersion: undefined, ...input }));
    expect(e.code).toBe('common.precondition_required'); expect(fake.writes).toEqual([]);
  });
  it.each(OPS)('%s: malformed If-Match (0, -1, 1.5, NaN, "1") -> 400 at /If-Match; no write', async (op, over, input) => {
    for (const bad of [0, -1, 1.5, Number.NaN, '1']) {
      const { svc, ctx, fake } = await mk([target(over)]); const e = await rejection(svc[op]!(ctx, { membershipId: T1, expectedVersion: bad, ...input }));
      expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toContain('/If-Match'); expect(fake.writes).toEqual([]);
    }
  });
  it.each(OPS)('%s: stale version -> 409 common.version_conflict and NO side effect beyond the failed guarded update (no scope/role/profile write, session revoke, MFA removal, job, access log, counter reset)', async (op, over, input) => {
    const { svc, ctx, fake, access, clearAccountFailures } = await mk([target({ ...over, version: 5 })]);
    const e = await rejection(svc[op]!(ctx, { membershipId: T1, expectedVersion: 4, ...input }));
    expect(e.code).toBe('common.version_conflict'); expect(writesOf(fake)).toEqual([]); expect(access).not.toHaveBeenCalled(); expect(clearAccountFailures).not.toHaveBeenCalled(); expect(fake.row(T1).version).toBe(5);
  });
  it.each(OPS)('%s: unknown, foreign-tenant and partner membership -> 404 common.not_found, nothing written', async (op, over, input) => {
    for (const [extra, id] of [[[], idN(0xdead)], [[target({ ...over, tenant_id: TENANT_B })], T1], [[target({ ...over, actor_type: 'partner' })], T1]] as Array<[Member[], string]>) {
      const { svc, ctx, fake } = await mk(extra); const e = await rejection(svc[op]!(ctx, { membershipId: id, expectedVersion: 1, ...input }));
      expect(e.code).toBe('common.not_found'); expect(fake.writes).toEqual([]);
    }
  });
  it('every successful versioned write returns the NEW version (old + 1) and the fresh body', async () => {
    for (const [op, over, input] of OPS) {
      const { svc, ctx } = await mk([target({ ...over, version: 7 })]); const r = await svc[op]!(ctx, { membershipId: T1, expectedVersion: 7, ...input });
      expect(r.status).toBe(200); expect(r.version).toBe(8); expect(r.body.version).toBe(8); assertWire(r.body, 'User');
    }
  });
});

describe('updateUser (US-B6 signatory profile)', () => {
  it('display_name and phone go to core.users; signatory fields to the membership columns the port reads; version bumped through the membership guard', async () => {
    const { svc, ctx, fake } = await mk([target()]);
    const r = await svc['updateUser']!(ctx, { membershipId: T1, expectedVersion: 1, displayName: 'New Name', phoneE164: '+9779841000001', signatoryTitle: 'MD Pathology', signatoryRegistrationNo: 'NMC-SYN-0001' });
    expect(fake.st.profileWrites[0]).toEqual({ userId: fake.row(T1).user_id, set: { display_name: 'New Name', phone_e164: '+9779841000001' } });
    expect(fake.st.membershipWrites[0]).toMatchObject({ id: T1, expectedVersion: 1, set: { signatory_display_title: 'MD Pathology', signatory_registration_no: 'NMC-SYN-0001' }, actorId: USER });
    expect(r.body.signatory).toMatchObject({ display_title: 'MD Pathology', registration_no: 'NMC-SYN-0001' }); expect(r.body.display_name).toBe('New Name');
  });
  it('unset[] nulls exactly the named fields; absent fields are untouched', async () => {
    const { svc, ctx, fake } = await mk([target({ signatory_display_title: 'T', signatory_registration_no: 'R' })]);
    await svc['updateUser']!(ctx, { membershipId: T1, expectedVersion: 1, unset: ['phone_e164', 'signatory_title'] });
    expect(fake.st.profileWrites[0]!.set).toEqual({ phone_e164: null }); expect(fake.st.membershipWrites[0]!.set).toEqual({ signatory_display_title: null });
  });
  it.each([
    ['empty display name', { displayName: '' }, '/display_name'], ['121-char display name', { displayName: 'x'.repeat(121) }, '/display_name'], ['title > 80', { signatoryTitle: 'x'.repeat(81) }, '/signatory_title'],
    ['empty title', { signatoryTitle: '' }, '/signatory_title'], ['registration no > 40', { signatoryRegistrationNo: 'x'.repeat(41) }, '/signatory_registration_no'],
    ['set and unset the same field', { phoneE164: '+9779841000000', unset: ['phone_e164'] }, '/unset'], ['unknown unset value', { unset: ['display_name'] }, '/unset/0'], ['4 unset entries', { unset: ['phone_e164', 'signatory_title', 'signatory_registration_no', 'phone_e164'] }, '/unset'],
  ])('%s -> 400 at %s, nothing written', async (_n, patch, path) => {
    const { svc, ctx, fake } = await mk([target()]); const e = await rejection(svc['updateUser']!(ctx, { membershipId: T1, expectedVersion: 1, ...patch }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toContain(path); expect(fake.writes).toEqual([]);
  });
  it('mass assignment: e-mail, status, roles, tenant, lock fields in the input are never written', async () => {
    const { svc, ctx, fake } = await mk([target()]);
    await svc['updateUser']!(ctx, { membershipId: T1, expectedVersion: 1, displayName: 'N', email: 'evil@example.test', status: 'deactivated', roleIds: [R_ADMIN], tenantId: TENANT_B, locked_at: NOW, signature_image_ref: 'x' });
    const cols = [...Object.keys(fake.st.membershipWrites[0]!.set), ...Object.keys(fake.st.profileWrites[0]!.set)]; expect(cols.sort()).toEqual(['display_name']);
    expect(fake.calls.every((c) => c.tenantId === TENANT_A || c.tenantId === '')).toBe(true);
  });
  it('a user can be updated in any membership status (invited, deactivated)', async () => {
    for (const status of ['invited', 'deactivated'] as const) { const { svc, ctx } = await mk([target({ status })]); expect((await svc['updateUser']!(ctx, { membershipId: T1, expectedVersion: 1, displayName: 'N' })).status).toBe(200); }
  });
});

describe('AC-B2.4 / AC-B2.3 setUserRoles', () => {
  it('replaces the role set, writes the role.change access log, revokes sessions with reason role_change and enqueues a sign-out; the actor id is the writer', async () => {
    const { svc, ctx, fake, access } = await mk([target()]);
    const r = await svc['setUserRoles']!(ctx, { membershipId: T1, expectedVersion: 1, roleIds: [R_FD, R_ADMIN2] });
    expect(r.status).toBe(200); expect(r.body.roles.map((x: any) => x.role_id).sort()).toEqual([R_FD, R_ADMIN2].sort());
    expect(fake.by('replaceRoles')[0]!.args).toEqual([T1, [R_FD, R_ADMIN2], USER]);
    expect(fake.st.sessionsRevoked).toEqual([{ membershipId: T1, userId: fake.row(T1).user_id, reason: 'role_change', actorId: USER }]);
    expect(fake.jobs('identity.gotrue_signout')).toHaveLength(1); expect(fake.jobs('identity.gotrue_signout')[0]!.payload).toMatchObject({ user_id: fake.row(T1).user_id, tenant_id: TENANT_A });
    expect(fake.jobs('identity.gotrue_signout')[0]!.jobKey).toContain('role_change');
    expect(access).toHaveBeenCalledWith(expect.objectContaining({ action: 'role.change', entityType: 'membership', entityId: T1, outcome: 'allowed' }));
  });
  it.each([['unknown', idN(0xdead)], ['inactive', R_INACTIVE], ['foreign tenant', R_B]])('a %s role -> 422 identity.role_unknown; nothing written, no session revoked', async (_n, bad) => {
    const { svc, ctx, fake, access } = await mk([target()]); const e = await rejection(svc['setUserRoles']!(ctx, { membershipId: T1, expectedVersion: 1, roleIds: [R_FD, bad] }));
    expect(e.code).toBe('identity.role_unknown'); expect(fake.writes).toEqual([]); expect(access).not.toHaveBeenCalled();
  });
  it.each([[[]], [Array.from({ length: 21 }, (_, i) => idN(0xb00 + i))], [['x']]])('role_ids %j -> 400 /role_ids', async (roleIds) => {
    const { svc, ctx, fake } = await mk([target()]); const e = await rejection(svc['setUserRoles']!(ctx, { membershipId: T1, expectedVersion: 1, roleIds }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors[0].path).toMatch(/^\/role_ids/); expect(fake.writes).toEqual([]);
  });
  it('AC-B2.3 removing identity.role.manage from the only active holder -> 409 identity.last_admin_protected; keeping another manage role is fine', async () => {
    const { svc, ctx, fake } = await mk([target({ role_ids: [R_ADMIN2] })], { actorRoles: [R_UM] });
    const e = await rejection(svc['setUserRoles']!(ctx, { membershipId: T1, expectedVersion: 1, roleIds: [R_FD] })); expect(e.code).toBe('identity.last_admin_protected'); expect(fake.writes).toEqual([]);
    const ok = await svc['setUserRoles']!(ctx, { membershipId: T1, expectedVersion: 1, roleIds: [R_FD, R_ADMIN] }); expect(ok.status).toBe(200);
  });
  it('removing role.manage from yourself when you are the only admin -> 409; with a second eligible admin it is allowed', async () => {
    const solo = await mk(); expect((await rejection(solo.svc['setUserRoles']!(solo.ctx, { membershipId: ADMIN, expectedVersion: 1, roleIds: [R_FD] }))).code).toBe('identity.last_admin_protected');
    const two = await mk([member({ id: ADM2, role_ids: [R_ADMIN2] })]); expect((await two.svc['setUserRoles']!(two.ctx, { membershipId: ADMIN, expectedVersion: 1, roleIds: [R_FD] })).status).toBe(200);
  });
  it('the last-admin read happens before the first write (race: the repo serialises it)', async () => {
    const { svc, ctx, fake } = await mk([target({ role_ids: [R_ADMIN2] })]); await svc['setUserRoles']!(ctx, { membershipId: T1, expectedVersion: 1, roleIds: [R_FD] });
    expect(fake.calls.findIndex((c) => c.m === 'listRoleManageHolders')).toBeGreaterThanOrEqual(0); expect(fake.calls.findIndex((c) => c.m === 'listRoleManageHolders')).toBeLessThan(fake.calls.findIndex((c) => c.m === 'updateMembership'));
  });
});

describe('AC-B3.3 setUserCentreScope', () => {
  it('all_centres=false: centres replaced, all_centres written false, sessions revoked (role_change) + sign-out job', async () => {
    const { svc, ctx, fake } = await mk([target({ all_centres: true, centre_ids: [] })]);
    const r = await svc['setUserCentreScope']!(ctx, { membershipId: T1, expectedVersion: 1, allCentres: false, centreIds: [C1, C2], branchIds: [B1] });
    expect(r.body).toMatchObject({ all_centres: false, centre_ids: [C1, C2], branch_ids: [B1], centre_count: 2 }); expect(fake.st.membershipWrites[0]!.set).toEqual({ all_centres: false });
    expect(fake.by('replaceScope')[0]!.args).toEqual([T1, { centreIds: [C1, C2], branchIds: [B1] }, USER]);
    expect(fake.st.sessionsRevoked[0]).toMatchObject({ membershipId: T1, reason: 'role_change' }); expect(fake.jobs('identity.gotrue_signout')).toHaveLength(1);
  });
  it('all_centres=true stores no centres even if some are given (inactive ones are not even checked)', async () => {
    const { svc, ctx, fake } = await mk([target()]); await svc['setUserCentreScope']!(ctx, { membershipId: T1, expectedVersion: 1, allCentres: true, centreIds: [C_INACTIVE] });
    expect(fake.st.membershipWrites[0]!.set).toEqual({ all_centres: true }); expect(fake.by('replaceScope')[0]!.args[1]).toEqual({ centreIds: [], branchIds: [] });
  });
  it('AC-B3.3 an inactive centre -> 409 identity.centre_inactive; an inactive branch too; nothing written', async () => {
    for (const input of [{ centreIds: [C1, C_INACTIVE] }, { centreIds: [C1], branchIds: [B_INACTIVE] }]) {
      const { svc, ctx, fake } = await mk([target()]); const e = await rejection(svc['setUserCentreScope']!(ctx, { membershipId: T1, expectedVersion: 1, allCentres: false, ...input }));
      expect(e.code).toBe('identity.centre_inactive'); expect(fake.writes).toEqual([]);
    }
  });
  it.each([[{ allCentres: false, centreIds: [] }, '/centre_ids'], [{ allCentres: false }, '/centre_ids'], [{ allCentres: false, centreIds: [C_B] }, '/centre_ids/0'], [{ allCentres: false, centreIds: [C1], branchIds: [idN(0xdead)] }, '/branch_ids/0'], [{ allCentres: 'yes', centreIds: [C1] }, '/all_centres']])('%j -> 400 at %s, nothing written', async (input, path) => {
    const { svc, ctx, fake } = await mk([target()]); const e = await rejection(svc['setUserCentreScope']!(ctx, { membershipId: T1, expectedVersion: 1, ...input }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toContain(path); expect(fake.writes).toEqual([]);
  });
});

describe('AC-B4.1 / B4.3 lockUser and last-admin / self guards', () => {
  it('locks with reason: locked_at/by + reason columns, sessions revoked (reason lock), sign-out job; body shows is_locked + lock', async () => {
    const { svc, ctx, fake } = await mk([target()]); const r = await svc['lockUser']!(ctx, { membershipId: T1, expectedVersion: 1, reasonCode: 'security_concern', reasonText: 'Synthetic reason' });
    const set = fake.st.membershipWrites[0]!.set as any; expect(iso(set.locked_at)).toBe(NOW); expect(set.locked_by).toBe(USER); expect(set.lock_reason_code).toBe('security_concern'); expect(set.lock_reason_text).toBe('Synthetic reason');
    expect(r.body.is_locked).toBe(true); expect(r.body.lock).toMatchObject({ reason_code: 'security_concern' });
    expect(fake.st.sessionsRevoked).toEqual([{ membershipId: T1, userId: fake.row(T1).user_id, reason: 'lock', actorId: USER }]);
    const j = fake.jobs('identity.gotrue_signout'); expect(j).toHaveLength(1); expect(j[0]!.payload).toEqual({ user_id: fake.row(T1).user_id, tenant_id: TENANT_A }); expect(j[0]!.jobKey).toMatch(/^signout:/); expect(j[0]!.jobKey).toContain(fake.row(T1).user_id); expect(j[0]!.jobKey).toContain('lock');
    expect(r.body).not.toHaveProperty('lock.reason_text');
  });
  it('reason_text is optional; reason_code is mandatory and one of the four codes; text 1-500', async () => {
    const ok = await mk([target()]); await ok.svc['lockUser']!(ok.ctx, { membershipId: T1, expectedVersion: 1, reasonCode: 'other' });
    for (const bad of [{ reasonCode: undefined }, { reasonCode: 'because' }, { reasonCode: 'other', reasonText: '' }, { reasonCode: 'other', reasonText: 'x'.repeat(501) }]) {
      const { svc, ctx, fake } = await mk([target()]); const e = await rejection(svc['lockUser']!(ctx, { membershipId: T1, expectedVersion: 1, ...bad })); expect(e.code).toBe('common.validation_failed'); expect(fake.writes).toEqual([]);
    }
  });
  it('AC-B4.3 locking yourself -> 409 identity.self_action_forbidden (checked before last-admin), nothing written', async () => {
    const { svc, ctx, fake } = await mk(); const e = await rejection(svc['lockUser']!(ctx, { membershipId: ADMIN, expectedVersion: 1, reasonCode: 'other' }));
    expect(e.code).toBe('identity.self_action_forbidden'); expect(fake.writes).toEqual([]);
  });
  it('AC-B2.3 locking the only eligible admin -> 409 identity.last_admin_protected; locking one of two is fine', async () => {
    const solo = await mk([target({ id: ADM2, role_ids: [R_ADMIN2] })], { actorRoles: [R_UM] });
    const e = await rejection(solo.svc['lockUser']!(solo.ctx, { membershipId: ADM2, expectedVersion: 1, reasonCode: 'other' })); expect(e.code).toBe('identity.last_admin_protected'); expect(solo.fake.writes).toEqual([]);
    const two = await mk([target({ id: ADM2, role_ids: [R_ADMIN2] })]); expect((await two.svc['lockUser']!(two.ctx, { membershipId: ADM2, expectedVersion: 1, reasonCode: 'other' })).status).toBe(200);
  });
  it('locking a non-admin never trips the last-admin rule, even in a tenant with no eligible admin', async () => {
    const { svc, ctx } = await mk([target()], { actorRoles: [R_UM] }); expect((await svc['lockUser']!(ctx, { membershipId: T1, expectedVersion: 1, reasonCode: 'other' })).status).toBe(200);
  });
  it('locking an already locked user -> 409 common.version_conflict, nothing written', async () => {
    const { svc, ctx, fake } = await mk([target({ locked_at: NOW, locked_by: USER })]); const e = await rejection(svc['lockUser']!(ctx, { membershipId: T1, expectedVersion: 1, reasonCode: 'other' }));
    expect(e.code).toBe('common.version_conflict'); expect(fake.writes).toEqual([]);
  });
});

describe('last-admin: who counts as "another admin" (lock and deactivate)', () => {
  // the only REAL admin is ADM2; the actor (R_UM) has user.manage but not role.manage; EXTRA is a would-be second admin that must NOT count
  const EXTRA = idN(0x4ee);
  const variants: Array<[string, Partial<Member>]> = [
    ['locked', { role_ids: [R_ADMIN], locked_at: NOW, locked_by: USER }], ['deactivated', { role_ids: [R_ADMIN], status: 'deactivated' }], ['invited (never accepted)', { role_ids: [R_ADMIN], status: 'invited', accepted_at: null }],
    ['holding the manage permission only via an inactive role', { role_ids: [R_INACT_ADMIN] }], ['a partner membership', { role_ids: [R_ADMIN], actor_type: 'partner' }], ['a patient membership', { role_ids: [R_ADMIN], actor_type: 'patient' }],
  ];
  it.each(variants)('%s does not count: lockUser and deactivateUser of the real admin stay 409', async (_n, over) => {
    for (const [op, input] of [['lockUser', { reasonCode: 'other' }], ['deactivateUser', { reasonCode: 'other' }]] as const) {
      const { svc, ctx, fake } = await mk([target({ id: ADM2, role_ids: [R_ADMIN2] }), member({ id: EXTRA, ...over })], { actorRoles: [R_UM] });
      const e = await rejection(svc[op]!(ctx, { membershipId: ADM2, expectedVersion: 1, ...input })); expect(e.code).toBe('identity.last_admin_protected'); expect(fake.writes).toEqual([]);
    }
  });
  it('an active, unlocked, accepted user-type admin through an active role DOES count', async () => {
    const { svc, ctx } = await mk([target({ id: ADM2, role_ids: [R_ADMIN2] }), member({ id: EXTRA, role_ids: [R_ADMIN] })], { actorRoles: [R_UM] });
    expect((await svc['deactivateUser']!(ctx, { membershipId: ADM2, expectedVersion: 1, reasonCode: 'other' })).status).toBe(200);
  });
  it('the check reads the holders before the first write', async () => {
    const { svc, ctx, fake } = await mk([target({ id: ADM2, role_ids: [R_ADMIN2] })]); await svc['lockUser']!(ctx, { membershipId: ADM2, expectedVersion: 1, reasonCode: 'other' });
    expect(fake.calls.findIndex((c) => c.m === 'listRoleManageHolders')).toBeLessThan(fake.calls.findIndex((c) => c.m === 'updateMembership'));
  });
});

describe('AC-B4.2 unlockUser', () => {
  it('clears locked_at/locked_by (and the reason columns), clears the account failure counter for the user e-mail, no session or sign-out work', async () => {
    const { svc, ctx, fake, clearAccountFailures } = await mk([target({ locked_at: NOW, locked_by: USER, lock_reason_code: 'other' })]);
    const r = await svc['unlockUser']!(ctx, { membershipId: T1, expectedVersion: 1 });
    const set = fake.st.membershipWrites[0]!.set as any; expect(set.locked_at).toBeNull(); expect(set.locked_by).toBeNull(); expect(set.lock_reason_code ?? null).toBeNull(); expect(set.lock_reason_text ?? null).toBeNull();
    expect(clearAccountFailures).toHaveBeenCalledWith('demo.target.0042@example.test'); expect(r.body.is_locked).toBe(false); expect(r.body).not.toHaveProperty('lock');
    expect(fake.writes).not.toContain('revokeSessions'); expect(fake.jobs('identity.gotrue_signout')).toHaveLength(0);
  });
  it('unlocking an unlocked user -> 409 common.version_conflict; the counter is not cleared', async () => {
    const { svc, ctx, clearAccountFailures } = await mk([target()]); expect((await rejection(svc['unlockUser']!(ctx, { membershipId: T1, expectedVersion: 1 }))).code).toBe('common.version_conflict'); expect(clearAccountFailures).not.toHaveBeenCalled();
  });
  it('a failed write leaves the failure counter alone (cleared only after the guarded update succeeded)', async () => {
    const { svc, ctx, fake, clearAccountFailures } = await mk([target({ locked_at: NOW, locked_by: USER })]); fake.fail['updateMembership'] = new Error('db down');
    await rejection(svc['unlockUser']!(ctx, { membershipId: T1, expectedVersion: 1 })); expect(clearAccountFailures).not.toHaveBeenCalled();
  });
});

describe('deactivateUser / reactivateUser (M3-M6, D-T8, D-T13, AC-B4.4)', () => {
  const DEACT = (o: Partial<Member> = {}) => target({ status: 'deactivated', deactivated_at: '2026-10-20T00:00:00.000Z', deactivated_by: USER, deactivation_reason_code: 'security_concern', ...o });
  it('M4 active -> deactivated: status, deactivated_at/by/reason code set; sessions revoked (reason deactivate) + sign-out job', async () => {
    const { svc, ctx, fake } = await mk([target()]); const r = await svc['deactivateUser']!(ctx, { membershipId: T1, expectedVersion: 1, reasonCode: 'security_concern', reasonText: 'x' });
    const set = fake.st.membershipWrites[0]!.set as any; expect(set.status).toBe('deactivated'); expect(iso(set.deactivated_at)).toBe(NOW); expect(set.deactivated_by).toBe(USER); expect(set.deactivation_reason_code).toBe('security_concern');
    expect(r.body.status).toBe('deactivated'); expect(fake.st.sessionsRevoked[0]).toMatchObject({ membershipId: T1, reason: 'deactivate' }); expect(fake.jobs('identity.gotrue_signout')).toHaveLength(1);
    expect(set).not.toHaveProperty('is_active');
  });
  it('M3 invited -> deactivated: the open invitation is revoked', async () => {
    const { svc, ctx, fake } = await mk([target({ status: 'invited', accepted_at: null, invitation: { status: 'sent', expires_at: NOW } })]);
    await svc['deactivateUser']!(ctx, { membershipId: T1, expectedVersion: 1, reasonCode: 'other' }); expect(fake.by('revokeOpenInvitations')[0]!.args).toEqual([T1, USER]);
  });
  it('AC-B4.3 deactivating yourself -> 409 identity.self_action_forbidden; an already deactivated member -> 409 common.version_conflict', async () => {
    const a = await mk(); expect((await rejection(a.svc['deactivateUser']!(a.ctx, { membershipId: ADMIN, expectedVersion: 1, reasonCode: 'other' }))).code).toBe('identity.self_action_forbidden'); expect(a.fake.writes).toEqual([]);
    const b = await mk([DEACT()]); expect((await rejection(b.svc['deactivateUser']!(b.ctx, { membershipId: T1, expectedVersion: 1, reasonCode: 'other' }))).code).toBe('common.version_conflict'); expect(b.fake.writes).toEqual([]);
  });
  it('D-T8 M5 reactivate an accepted member: status active and ALL THREE deactivated_* columns written NULL; no new invitation, no job', async () => {
    const { svc, ctx, fake } = await mk([DEACT()]); const r = await svc['reactivateUser']!(ctx, { membershipId: T1, expectedVersion: 1 });
    const set = fake.st.membershipWrites[0]!.set as any; expect(set).toMatchObject({ status: 'active', deactivated_at: null, deactivated_by: null, deactivation_reason_code: null });
    for (const k of ['deactivated_at', 'deactivated_by', 'deactivation_reason_code']) expect(Object.hasOwn(set, k) && set[k] === null).toBe(true);
    expect(r.body.status).toBe('active'); expect(fake.writes).not.toContain('insertInvitation'); expect(fake.jobs('identity.send_invitation')).toHaveLength(0);
  });
  it('D-T13 / 08 A8.2 M6 reactivate a never-accepted member: status invited, the same three columns NULL, a NEW pending invitation (now+72h) and an identity.send_invitation job', async () => {
    const { svc, ctx, fake } = await mk([DEACT({ accepted_at: null })]); const r = await svc['reactivateUser']!(ctx, { membershipId: T1, expectedVersion: 1 });
    const set = fake.st.membershipWrites[0]!.set as any; expect(set).toMatchObject({ status: 'invited', deactivated_at: null, deactivated_by: null, deactivation_reason_code: null });
    expect(r.body.status).toBe('invited'); expect(r.body.invitation.status).toBe('pending');
    const inv = fake.st.invitations[0]!; expect(inv).toMatchObject({ membershipId: T1, email: 'demo.target.0042@example.test' }); expect(iso(inv.expiresAt)).toBe(iso(new Date(new Date(NOW).getTime() + 72 * 3_600_000)));
    const j = fake.jobs('identity.send_invitation'); expect(j).toHaveLength(1); expect(j[0]!.payload).toEqual({ tenant_id: TENANT_A, invitation_id: inv.id }); expect(j[0]!.jobKey).toBe(`invite:${inv.id}:1`);
  });
  it('reactivating a member that is not deactivated -> 409 common.version_conflict, nothing written', async () => {
    const { svc, ctx, fake } = await mk([target()]); expect((await rejection(svc['reactivateUser']!(ctx, { membershipId: T1, expectedVersion: 1 }))).code).toBe('common.version_conflict'); expect(fake.writes).toEqual([]);
  });
  it('reactivate does not touch the lock: a locked + deactivated member stays locked', async () => {
    const { svc, ctx, fake } = await mk([DEACT({ locked_at: NOW, locked_by: USER })]); await svc['reactivateUser']!(ctx, { membershipId: T1, expectedVersion: 1 });
    expect(Object.keys(fake.st.membershipWrites[0]!.set)).not.toContain('locked_at');
  });
});

describe('resendInvitation', () => {
  it('invited member: 202 {}; previous open invitations revoked FIRST, a new pending invitation (now+72h) and a send job for the new row; no If-Match needed', async () => {
    const { svc, ctx, fake } = await mk([target({ status: 'invited', accepted_at: null, invitation: { status: 'sent', expires_at: NOW } })]);
    const r = await svc['resendInvitation']!(ctx, { membershipId: T1 }); expect(r.status).toBe(202); expect(r.body).toEqual({});
    expect(fake.writes.indexOf('revokeOpenInvitations')).toBeGreaterThanOrEqual(0); expect(fake.writes.indexOf('revokeOpenInvitations')).toBeLessThan(fake.writes.indexOf('insertInvitation'));
    const inv = fake.st.invitations[0]!; expect(iso(inv.expiresAt)).toBe(iso(new Date(new Date(NOW).getTime() + 72 * 3_600_000)));
    const j = fake.jobs('identity.send_invitation'); expect(j).toHaveLength(1); expect(j[0]!.payload).toEqual({ tenant_id: TENANT_A, invitation_id: inv.id }); expect(j[0]!.jobKey).toBe(`invite:${inv.id}:1`);
    expect(JSON.stringify(r.body)).not.toContain('example.test');
  });
  it.each(['active', 'deactivated'] as const)('a %s member -> 409 common.version_conflict, nothing written, no job', async (status) => {
    const { svc, ctx, fake } = await mk([target({ status })]); expect((await rejection(svc['resendInvitation']!(ctx, { membershipId: T1 }))).code).toBe('common.version_conflict'); expect(fake.writes).toEqual([]);
  });
  it.each([['unknown', idN(0xdead)], ['partner', idN(0x411)]])('%s membership -> 404', async (_n, id) => {
    const { svc, ctx } = await mk([member({ id: idN(0x411), actor_type: 'partner', status: 'invited' })]); expect((await rejection(svc['resendInvitation']!(ctx, { membershipId: id }))).code).toBe('common.not_found');
  });
});

describe('US-B5 resetUserMfa', () => {
  it('mirror rows removed at once, sessions revoked (mfa_reset), remove_mfa_factors job {tenant_id,user_id,membership_id} keyed mfa_reset:<membership>:<version>, sign-out job; User shows mfa_enrolled false', async () => {
    const { svc, ctx, fake } = await mk([target({ mfa_enrolled: true })]); const r = await svc['resetUserMfa']!(ctx, { membershipId: T1, expectedVersion: 1, reasonText: 'Lost device, synthetic' });
    expect(r.body.mfa_enrolled).toBe(false); expect(fake.st.mfaRemoved).toEqual([{ userId: fake.row(T1).user_id, actorId: USER }]);
    expect(fake.st.sessionsRevoked[0]).toMatchObject({ membershipId: T1, reason: 'mfa_reset' });
    const j = fake.jobs('identity.remove_mfa_factors'); expect(j).toHaveLength(1); expect(j[0]!.payload).toEqual({ tenant_id: TENANT_A, user_id: fake.row(T1).user_id, membership_id: T1 }); expect(j[0]!.jobKey).toMatch(new RegExp(`^mfa_reset:${T1}:\\d+$`));
    expect(fake.jobs('identity.gotrue_signout')).toHaveLength(1);
  });
  it('the reason text is not stored in jobs or access logs (it is free text of the admin; audit trigger only)', async () => {
    const { svc, ctx, fake, access } = await mk([target({ mfa_enrolled: true })]); await svc['resetUserMfa']!(ctx, { membershipId: T1, expectedVersion: 1, reasonText: 'PLANTED-REASON-77' });
    expect(JSON.stringify(fake.st.jobs)).not.toContain('PLANTED-REASON-77'); expect(JSON.stringify(access.mock.calls)).not.toContain('PLANTED-REASON-77');
  });
  it('resetting your own MFA -> 409 identity.self_action_forbidden, nothing removed', async () => {
    const { svc, ctx, fake } = await mk(); expect((await rejection(svc['resetUserMfa']!(ctx, { membershipId: ADMIN, expectedVersion: 1, reasonText: 'x' }))).code).toBe('identity.self_action_forbidden'); expect(fake.writes).toEqual([]);
  });
  it.each([[undefined], [''], ['x'.repeat(501)], [42]])('reason_text %j -> 400 /reason_text, nothing written', async (reasonText) => {
    const { svc, ctx, fake } = await mk([target()]); const e = await rejection(svc['resetUserMfa']!(ctx, { membershipId: T1, expectedVersion: 1, reasonText }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toContain('/reason_text'); expect(fake.writes).toEqual([]);
  });
});

describe('revokeUserSessions', () => {
  it('revokes the user sessions (reason admin_revoke), enqueues a sign-out, writes session.revoke to the access log, returns {revoked: n}; no If-Match; self allowed', async () => {
    const { svc, ctx, fake, access } = await mk([target()]);
    const r = await svc['revokeUserSessions']!(ctx, { membershipId: T1 }); expect(r.status).toBe(200); expect(r.body).toEqual({ revoked: 2 });
    expect(fake.st.sessionsRevoked[0]).toMatchObject({ membershipId: T1, userId: fake.row(T1).user_id, reason: 'admin_revoke', actorId: USER });
    expect(fake.jobs('identity.gotrue_signout')).toHaveLength(1); expect(access).toHaveBeenCalledWith(expect.objectContaining({ action: 'session.revoke', entityType: 'session', outcome: 'allowed' }));
    expect((await svc['revokeUserSessions']!(ctx, { membershipId: ADMIN })).status).toBe(200);
  });
  it.each([['unknown', idN(0xdead)], ['non-uuid id', 'abc'], ['partner', idN(0x411)]])('%s -> 404, no revoke, no access log', async (_n, id) => {
    const { svc, ctx, fake, access } = await mk([member({ id: idN(0x411), actor_type: 'partner' })]); expect((await rejection(svc['revokeUserSessions']!(ctx, { membershipId: id }))).code).toBe('common.not_found');
    expect(fake.writes).toEqual([]); expect(access).not.toHaveBeenCalled();
  });
});

describe('US-B6 uploadUserSignature', () => {
  const sig = (bytes = png(8, 4), name = 'sig.png', mime = 'image/png') => ({ membershipId: T1, file: incoming(bytes, name, mime) });
  it('PNG: 200 User; private object under {tenant}/signatures/{membership}/…; asset row (bucket, type, size <= 1 MB, clean); membership.signature_image_ref = the path; the path is not in the body', async () => {
    const { svc, ctx, fake, storageKeys } = await mk([target()]); const r = await svc['uploadUserSignature']!(ctx, sig());
    expect(r.status).toBe(200); assertWire(r.body, 'User'); const a = fake.st.assets[0]!;
    expect(a).toMatchObject({ membershipId: T1, bucket: 'identity-assets', contentType: 'image/png', scanState: 'clean', tenantId: TENANT_A, actorId: USER }); expect(a.sizeBytes).toBeGreaterThan(0); expect(a.sizeBytes).toBeLessThanOrEqual(1_048_576);
    expect(a.objectPath.startsWith(`${TENANT_A}/signatures/${T1}/`)).toBe(true); expect(a.objectPath).toMatch(/\.png$/); expect(a.sha256).toMatch(/^[0-9a-f]{64}$/); expect(a.widthPx).toBe(8); expect(a.heightPx).toBe(4);
    expect(storageKeys().some((k) => k.includes(a.objectPath))).toBe(true);
    expect(fake.st.membershipWrites.some((w) => w.set['signature_image_ref'] === a.objectPath && w.expectedVersion === undefined)).toBe(true);
    expect(r.body.signatory.signature_asset_id).toBe(a.id); expect(JSON.stringify(r.body)).not.toContain('/signatures/');
  });
  it('a second upload keeps the old asset row but inactive; only the newest is active and referenced', async () => {
    const { svc, ctx, fake } = await mk([target()]); await svc['uploadUserSignature']!(ctx, sig()); await svc['uploadUserSignature']!(ctx, sig(png(9, 5)));
    expect(fake.st.assets.map((a) => a.is_active)).toEqual([false, true]); expect(fake.row(T1).signature_image_ref).toBe(fake.st.assets[1]!.objectPath);
  });
  it('SVG (even named .png, even typed image/png) -> 415 common.unsupported_media_type; nothing stored, no row, no job', async () => {
    for (const [bytes, name, mime] of [[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'sig.svg', 'image/svg+xml'], [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'sig.png', 'image/png'], [Buffer.from('hello'), 'sig.png', 'image/png']] as const) {
      const { svc, ctx, fake, storageKeys } = await mk([target()]); const e = await rejection(svc['uploadUserSignature']!(ctx, sig(bytes, name, mime)));
      expect(e.code).toBe('common.unsupported_media_type'); expect(storageKeys()).toEqual([]); expect(fake.writes).toEqual([]);
    }
  });
  it('larger than 1 MB (but under the 2 MB branding limit) -> 413 common.payload_too_large; nothing stored', async () => {
    const { svc, ctx, fake, storageKeys } = await mk([target()]); const big = png(4, 3, 'x'.repeat(1_200_000)); expect(big.length).toBeGreaterThan(1_048_576); expect(big.length).toBeLessThan(2 * 1_048_576);
    const e = await rejection(svc['uploadUserSignature']!(ctx, sig(big))); expect(e.code).toBe('common.payload_too_large'); expect(storageKeys()).toEqual([]); expect(fake.writes).toEqual([]);
  });
  it('infected (EICAR) -> 422 common.upload_quarantined; nothing stored, nothing written', async () => {
    const { svc, ctx, fake, storageKeys } = await mk([target()]); const e = await rejection(svc['uploadUserSignature']!(ctx, sig(png(4, 3, EICAR))));
    expect(e.code).toBe('common.upload_quarantined'); expect(storageKeys()).toEqual([]); expect(fake.writes).toEqual([]);
  });
  it('scanner unavailable (P-19): stored as pending + identity.rescan_upload job for the asset; still 200', async () => {
    const { svc, ctx, fake, mode } = await mk([target()]); mode.v = 'unavailable'; const r = await svc['uploadUserSignature']!(ctx, sig());
    expect(r.status).toBe(200); expect(fake.st.assets[0]!.scanState).toBe('pending'); const j = fake.jobs('identity.rescan_upload'); expect(j).toHaveLength(1); expect(j[0]!.payload).toMatchObject({ tenant_id: TENANT_A, asset_id: fake.st.assets[0]!.id });
  });
  it('the client file name never reaches the key', async () => {
    const { svc, ctx, fake } = await mk([target()]); await svc['uploadUserSignature']!(ctx, sig(png(), '../../etc/passwd.png')); expect(fake.st.assets[0]!.objectPath).not.toMatch(/etc|passwd|\.\./);
  });
  it('unknown / foreign / partner membership -> 404 BEFORE anything is stored', async () => {
    for (const [extra, id] of [[[], idN(0xdead)], [[target({ tenant_id: TENANT_B })], T1], [[target({ actor_type: 'partner' })], T1]] as Array<[Member[], string]>) {
      const { svc, ctx, fake, storageKeys } = await mk(extra); const e = await rejection(svc['uploadUserSignature']!(ctx, { membershipId: id, file: incoming(png()) }));
      expect(e.code).toBe('common.not_found'); expect(storageKeys()).toEqual([]); expect(fake.writes).toEqual([]);
    }
  });
  it('missing file -> 400 at /file', async () => {
    const { svc, ctx } = await mk([target()]); const e = await rejection(svc['uploadUserSignature']!(ctx, { membershipId: T1, file: undefined })); expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toContain('/file');
  });
  it('a failing row write leaves no orphan object in storage', async () => {
    const { svc, ctx, fake, storageKeys } = await mk([target()]); fake.fail['insertSignatureAsset'] = new Error('db down'); await rejection(svc['uploadUserSignature']!(ctx, sig())); expect(storageKeys()).toEqual([]);
  });
});

describe('cross-cutting', () => {
  const ALL: Array<[string, Record<string, unknown>]> = [
    ['listUsers', {}], ['searchUsers', { query: 'demo' }], ['inviteUser', INVITE], ['getUser', { membershipId: T1 }], ['updateUser', { membershipId: T1, expectedVersion: 1, displayName: 'N' }],
    ['setUserRoles', { membershipId: T1, expectedVersion: 1, roleIds: [R_FD] }], ['setUserCentreScope', { membershipId: T1, expectedVersion: 1, allCentres: true }], ['lockUser', { membershipId: T1, expectedVersion: 1, reasonCode: 'other' }],
    ['unlockUser', { membershipId: T1, expectedVersion: 1 }], ['deactivateUser', { membershipId: T1, expectedVersion: 1, reasonCode: 'other' }], ['reactivateUser', { membershipId: T1, expectedVersion: 1 }],
    ['resendInvitation', { membershipId: T1 }], ['resetUserMfa', { membershipId: T1, expectedVersion: 1, reasonText: 'x' }], ['revokeUserSessions', { membershipId: T1 }], ['uploadUserSignature', { membershipId: T1, file: incoming(png()) }],
  ];
  it.each(ALL)('%s: no tenant / actor / transaction in the context -> auth.unauthenticated, repo and GoTrue untouched', async (op, input) => {
    for (const broken of [{ tenantId: undefined }, { actor: undefined }, { tx: undefined }, { tenantId: 'not-a-uuid' }]) {
      const { svc, ctx, fake, g } = await mk([target()]); const e = await rejection(svc[op]!({ ...ctx, ...broken }, input)); expect(e.code).toBe('auth.unauthenticated'); expect(fake.calls).toEqual([]); expect(g.gotrue.adminCreateUser).not.toHaveBeenCalled();
    }
  });
  it.each(['setUserRoles', 'revokeUserSessions'])('%s writes an access-log row: no ctx.audit.access -> fails closed (common.internal), nothing written', async (op) => {
    const { svc, ctx, fake } = await mk([target()]); const input = ALL.find(([o]) => o === op)![1];
    const e = await rejection(svc[op]!({ ...ctx, audit: undefined }, input)); expect(e.code).toBe('common.internal'); expect(fake.writes).toEqual([]);
  });
  it('a repo failure mid-way propagates unchanged (the request tx rolls back; the core renders it)', async () => {
    const { svc, ctx, fake } = await mk([target()]); fake.fail['revokeSessions'] = new Error('db down');
    expect((await rejection(svc['lockUser']!(ctx, { membershipId: T1, expectedVersion: 1, reasonCode: 'other' }))).message).toBe('db down');
  });
  it('errors never echo submitted data (e-mail, reason text, names) in code / message / detail', async () => {
    const planted = 'PLANTED-9f3a@example.test'; const { svc, ctx } = await mk([target()]);
    for (const p of [svc['inviteUser']!(ctx, { ...INVITE, email: planted, roleIds: [idN(0xdead)] }), svc['lockUser']!(ctx, { membershipId: T1, expectedVersion: 99, reasonCode: 'other', reasonText: planted }), svc['updateUser']!(ctx, { membershipId: T1, expectedVersion: 1, displayName: planted + 'x'.repeat(200) })]) {
      const e = await rejection(p); expect(JSON.stringify({ c: e.code, m: e.message, d: e.detail, e: e.errors })).not.toContain('PLANTED-9f3a');
    }
  });
  it('concurrent requests on one membership with the same If-Match: exactly one wins, the other gets 409 (optimistic lock)', async () => {
    const { svc, ctx } = await mk([target()]); const calls = [svc['lockUser']!(ctx, { membershipId: T1, expectedVersion: 1, reasonCode: 'other' }), svc['deactivateUser']!(ctx, { membershipId: T1, expectedVersion: 1, reasonCode: 'other' })];
    const res = await Promise.allSettled(calls); expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1); const bad = res.find((r) => r.status === 'rejected') as PromiseRejectedResult; expect(bad.reason.code).toBe('common.version_conflict');
  });
  it('another tenant context sees and touches nothing of tenant A (ctx tenant B)', async () => {
    const { svc, ctx, fake } = await mk([target()]); const e = await rejection(svc['lockUser']!({ ...ctx, tenantId: TENANT_B }, { membershipId: T1, expectedVersion: 1, reasonCode: 'other' }));
    expect(e.code).toBe('common.not_found'); expect(fake.writes).toEqual([]); expect(fake.row(T1).locked_at).toBeNull();
  });
});

// 03-APP-FLOW 2.1 SS9: admin revoke, lock, deactivate, role/centre change and MFA reset each record auth event `session_revoked` (reason) per revoked session.
describe('session_revoked auth events (one per live session; none on conflict)', () => {
  const S = [idN(0x5001), idN(0x5002)];
  const CALLERS: Array<[string, string, Record<string, unknown>]> = [
    ['setUserRoles', 'role_change', { roleIds: [R_FD, R_ADMIN2] }],
    ['setUserCentreScope', 'role_change', { allCentres: false, centreIds: [C1, C2] }],
    ['lockUser', 'lock', { reasonCode: 'security_concern' }],
    ['deactivateUser', 'deactivate', { reasonCode: 'security_concern' }],
    ['resetUserMfa', 'mfa_reset', { reasonText: 'Synthetic' }],
    ['revokeUserSessions', 'admin_revoke', {}],
  ];
  it.each(CALLERS)('%s -> two session_revoked events, reasonCode %s', async (op, reason, extra) => {
    const { svc, ctx, fake, authEvents, events } = await mk([target({ mfa_enrolled: true })]);
    await svc[op]!(ctx, op === 'revokeUserSessions' ? { membershipId: T1 } : { membershipId: T1, expectedVersion: 1, ...extra });
    expect(authEvents).toHaveLength(2); expect(events.recordTenant).toHaveBeenCalledTimes(2); expect(events.recordTenant.mock.calls.every((c) => c[0] === ctx.tx)).toBe(true);
    expect(authEvents.map((e) => e['sessionId']).sort()).toEqual(S);
    for (const e of authEvents) expect(e).toMatchObject({ eventType: 'session_revoked', reasonCode: reason, tenantId: TENANT_A, userId: fake.row(T1).user_id, membershipId: T1, actorId: USER });
    expect(typeof authEvents[0]!['id']).toBe('string'); expect(authEvents[0]!['id']).not.toBe(authEvents[1]!['id']);
  });
  it.each(CALLERS.filter(([op]) => op !== 'revokeUserSessions'))('%s with a stale version -> 409, no session_revoked event', async (op, _reason, extra) => {
    const { svc, ctx, authEvents } = await mk([target({ mfa_enrolled: true })]);
    expect((await rejection(svc[op]!(ctx, { membershipId: T1, expectedVersion: 99, ...extra }))).code).toBe('common.version_conflict'); expect(authEvents).toEqual([]);
  });
  it('no events dep -> the sign-out path fails closed with common.internal', async () => {
    const d = await mk([target()]); const svc = createUserService({ ...(d.deps as any), events: undefined }) as Record<string, (ctx: any, input: any) => Promise<any>>;
    expect((await rejection(svc['revokeUserSessions']!(d.ctx, { membershipId: T1 }))).code).toBe('common.internal');
  });
});
