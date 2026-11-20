// T0B-CONTENT-1 done_when (4), (5), (6), (7): image attachment ownership for portal content, and profile images (listProfileImages, setProfileImage, clearProfileImage).
// "Images already accepted by the branding upload path" = a row of identity.branding_assets of the SAME tenant that is active, not quarantined and not a signature (a pathologist
// signature is a clinical secret, never a public picture). A refusal is 400 common.validation_failed on /image_attachment_id, and a foreign id answers exactly like a missing one.
import { afterAll, describe, expect, it } from 'vitest';
import { MEM, PERM, T, TENANT_A, TENANT_B, asset, auditRows, call, closePatientPool, expectCode, expectInvalid, fails, idem, im, imgRow, mine, mk, ownerRows, req, schemaErrors, uid } from './helpers.js';

afterAll(closePatientPool);
const set = (kind: string, id: string, image: unknown, o: { tenant?: string; grants?: readonly string[] } = {}) =>
  call('setProfileImage', req({ params: { profile_kind: kind, profile_id: id }, body: { image_attachment_id: image } }), o);
const clear = (kind: string, id: string, o: { tenant?: string; grants?: readonly string[] } = {}) => call('clearProfileImage', req({ params: { profile_kind: kind, profile_id: id } }), o);
const imgs = (query: object = {}, o: { tenant?: string; grants?: readonly string[] } = {}) => call('listProfileImages', req({ query: { limit: 200, ...query } }), o);

describe('T0B-CONTENT-1: image attachment ownership (portal content)', () => {
  it('accepts an active clean PNG and JPEG branding asset of the tenant, also still pending the scan', async () => {
    for (const over of [{}, { content_type: 'image/jpeg' }, { scan_state: 'pending' }, { kind: 'letterhead_header' }]) {
      const id = await asset(TENANT_A, over); expect((await mk({ kind: 'banner', image_attachment_id: id })).image_attachment_id, JSON.stringify(over)).toBe(id);
    }
  }, T);
  it('refuses another tenant asset, an unknown id, an inactive, a quarantined and a signature asset: 400 /image_attachment_id, nothing written, foreign = unknown', async () => {
    const foreign = await asset(TENANT_B); const inactive = await asset(TENANT_A, { is_active: false }); const quarantined = await asset(TENANT_A, { scan_state: 'quarantined' });
    const signature = await asset(TENANT_A, { kind: 'signature', membership_id: MEM.a });
    const seen: string[] = [];
    for (const [name, id] of [['foreign tenant', foreign], ['unknown', uid()], ['inactive', inactive], ['quarantined', quarantined], ['signature', signature]] as const) {
      await expectInvalid('createPortalContent', req({ headers: idem(), body: { kind: 'banner', title: `Own ${name}`, image_attachment_id: id } }), '/image_attachment_id');
      const e = await fails('createPortalContent', req({ headers: idem(), body: { kind: 'banner', title: `Own ${name}`, image_attachment_id: id } }));
      seen.push(JSON.stringify({ code: e.code, status: e.statusCode, paths: (e.errors ?? []).map((x: any) => x.path) }));
    }
    expect(new Set([seen[0], seen[1]]).size, 'a foreign asset must not be distinguishable from an unknown one (no enumeration)').toBe(1);
    expect((await ownerRows('engagement.portal_content', `title LIKE 'Own %' AND tenant_id = $1`, [TENANT_A]))).toEqual([]);
  }, T);
  it('the same rule holds on update, and a refused update leaves the stored image alone', async () => {
    const good = await asset(TENANT_A); const c = await mk({ kind: 'banner', image_attachment_id: good });
    for (const id of [await asset(TENANT_B), uid(), await asset(TENANT_A, { is_active: false }), await asset(TENANT_A, { scan_state: 'quarantined' })])
      await expectInvalid('updatePortalContent', req({ params: { content_id: c.id }, headers: im(c.version), body: { image_attachment_id: id } }), '/image_attachment_id');
    const r = await call('updatePortalContent', req({ params: { content_id: c.id }, headers: im(c.version), body: { image_attachment_id: await asset(TENANT_A) } })); expect(r.status).toBe(200);
  }, T);
  it('tenant B uses its own asset, and cannot use tenant A asset even by guessing its id', async () => {
    const a = await asset(TENANT_A); const b = await asset(TENANT_B);
    expect((await mk({ kind: 'banner', image_attachment_id: b }, { tenant: TENANT_B })).image_attachment_id).toBe(b);
    await expectInvalid('createPortalContent', req({ headers: idem(), body: { kind: 'banner', title: 'x', image_attachment_id: a } }), '/image_attachment_id', { tenant: TENANT_B });
  }, T);
  it('a patient sees the image id of an active item (the picture itself is served by the branding path, not here)', async () => {
    const id = await asset(TENANT_A); const c = await mk({ kind: 'banner', image_attachment_id: id });
    expect((await mine({ kind: 'banner' })).body.data.find((x: any) => x.id === c.id)?.image_attachment_id).toBe(id);
  }, T);
});

describe('T0B-CONTENT-1: setProfileImage / clearProfileImage / listProfileImages', () => {
  it('sets the image of a doctor, a centre and a staff profile: 200, contract shaped, permission manage, row audited', async () => {
    for (const kind of ['doctor', 'centre', 'staff']) {
      const pid = uid(); const img = await asset();
      const r = await set(kind, pid, img);
      expect(r.status, JSON.stringify(r.body)).toBe(200); expect(schemaErrors('ProfileImage', r.body)).toEqual([]);
      expect(r.body).toMatchObject({ profile_kind: kind, profile_id: pid, image_attachment_id: img, is_active: true }); expect(r.assertCalls).toEqual([PERM.manage]);
      const db = await imgRow(TENANT_A, kind, pid); expect(db).toMatchObject({ image_attachment_id: img, is_active: true });
      expect((await auditRows('profile_image', db.id)).map((x: any) => x.action)).toEqual(['INSERT']);
    }
  }, T);
  it('one image per profile: setting again replaces it on the SAME row (never a second row); audit INSERT then UPDATE', async () => {
    const pid = uid(); const one = await asset(); const two = await asset();
    await set('doctor', pid, one); const first = await imgRow(TENANT_A, 'doctor', pid);
    const r = await set('doctor', pid, two); expect(r.body.image_attachment_id).toBe(two);
    const all = await ownerRows('engagement.profile_image', 'tenant_id = $1 AND profile_kind = $2 AND profile_id = $3', [TENANT_A, 'doctor', pid]);
    expect(all).toHaveLength(1); expect(all[0].id).toBe(first.id); expect(all[0].image_attachment_id).toBe(two);
    expect((await auditRows('profile_image', first.id)).map((x: any) => x.action)).toEqual(['INSERT', 'UPDATE']);
  }, T);
  it('the same profile id of two kinds, or of two tenants, are independent profiles', async () => {
    const pid = uid(); await set('doctor', pid, await asset()); await set('staff', pid, await asset()); await set('doctor', pid, await asset(TENANT_B), { tenant: TENANT_B });
    expect(await ownerRows('engagement.profile_image', 'profile_id = $1', [pid])).toHaveLength(3);
  }, T);
  it('clear: 204, the row stays with is_active false (history kept), audit UPDATE; the same profile can be set again on the same row', async () => {
    const pid = uid(); const img = await asset(); await set('centre', pid, img); const row = await imgRow(TENANT_A, 'centre', pid);
    const c = await clear('centre', pid); expect(c.status).toBe(204); expect(c.assertCalls).toEqual([PERM.manage]); expect(c.body ?? null).toBeNull();
    expect(await imgRow(TENANT_A, 'centre', pid)).toMatchObject({ id: row.id, is_active: false });
    expect((await imgs({ profile_id: pid, is_active: true })).body.data).toEqual([]);
    expect((await imgs({ profile_id: pid, is_active: false })).body.data.map((x: any) => x.profile_id)).toEqual([pid]);
    const again = await set('centre', pid, await asset()); expect(again.body.is_active).toBe(true);
    expect((await imgRow(TENANT_A, 'centre', pid)).id, 'set after clear reuses the row').toBe(row.id);
    expect((await auditRows('profile_image', row.id)).map((x: any) => x.action)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
  }, T);
  it('clearing a profile that has no image is 404 common.not_found', async () => { expectCode(await fails('clearProfileImage', req({ params: { profile_kind: 'doctor', profile_id: uid() } })), 'common.not_found', 404); }, T);
  it('image ownership: another tenant asset, unknown, inactive, quarantined or signature asset is 400 /image_attachment_id and the existing image is kept', async () => {
    const pid = uid(); const good = await asset(); await set('staff', pid, good);
    for (const id of [await asset(TENANT_B), uid(), await asset(TENANT_A, { is_active: false }), await asset(TENANT_A, { scan_state: 'quarantined' }), await asset(TENANT_A, { kind: 'signature', membership_id: MEM.a })]) {
      let err: any; try { await set('staff', pid, id); } catch (e) { err = e; }
      expect(err?.code).toBe('common.validation_failed'); expect(err.statusCode).toBe(400); expect((err.errors ?? []).map((x: any) => x.path)).toContain('/image_attachment_id');
    }
    expect((await imgRow(TENANT_A, 'staff', pid)).image_attachment_id).toBe(good);
  }, T);
  it('bad input: kind outside doctor / centre / staff, a non uuid profile or image id, a missing or extra body field are 400 and write nothing', async () => {
    const img = await asset();
    await expectInvalid('setProfileImage', req({ params: { profile_kind: 'patient', profile_id: uid() }, body: { image_attachment_id: img } }), '/profile_kind');
    await expectInvalid('setProfileImage', req({ params: { profile_kind: 'doctor', profile_id: 'nope' }, body: { image_attachment_id: img } }), '/profile_id');
    await expectInvalid('setProfileImage', req({ params: { profile_kind: 'doctor', profile_id: uid() }, body: { image_attachment_id: 'nope' } }), '/image_attachment_id');
    await expectInvalid('setProfileImage', req({ params: { profile_kind: 'doctor', profile_id: uid() }, body: {} }), '/image_attachment_id');
    for (const body of [null, undefined, [], { image_attachment_id: img, is_active: false, created_by: uid() }]) {
      const e = await fails('setProfileImage', req({ params: { profile_kind: 'doctor', profile_id: uid() }, body })); expect(e.code, JSON.stringify(body)).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    }
    for (const k of ['x', 'DOCTOR', "doctor' OR 1=1"]) expect((await fails('clearProfileImage', req({ params: { profile_kind: k, profile_id: uid() } }))).statusCode, k).toBe(400);
  }, T);
  it('tenant isolation: tenant B cannot list, clear or overwrite a tenant A profile image (404 / not listed), tenant A row untouched', async () => {
    const pid = uid(); const img = await asset(); await set('doctor', pid, img);
    expect((await imgs({ profile_id: pid }, { tenant: TENANT_B })).body.data).toEqual([]);
    expectCode(await fails('clearProfileImage', req({ params: { profile_kind: 'doctor', profile_id: pid } }), { tenant: TENANT_B }), 'common.not_found', 404);
    const other = await set('doctor', pid, await asset(TENANT_B), { tenant: TENANT_B }); expect(other.status).toBe(200);
    expect(await imgRow(TENANT_A, 'doctor', pid)).toMatchObject({ image_attachment_id: img, is_active: true });
  }, T);
  it('list: filters profile_kind, profile_id, is_active; contract shaped; permission read; page limit', async () => {
    const d = uid(); const s = uid(); await set('doctor', d, await asset()); await set('staff', s, await asset()); await clear('staff', s);
    const all = await imgs(); expect(all.assertCalls).toEqual([PERM.read]); expect(schemaErrors('ProfileImagePage', all.body)).toEqual([]);
    expect((await imgs({ profile_kind: 'doctor' })).body.data.every((x: any) => x.profile_kind === 'doctor')).toBe(true);
    expect((await imgs({ profile_id: d })).body.data).toHaveLength(1);
    expect((await imgs({ profile_kind: 'staff', is_active: false })).body.data.map((x: any) => x.profile_id)).toContain(s);
    expect((await imgs({ profile_kind: 'staff', is_active: true })).body.data.map((x: any) => x.profile_id)).not.toContain(s);
    expect((await imgs({ limit: 1 })).body.data.length).toBeLessThanOrEqual(1);
    for (const q of [{ profile_kind: 'patient' }, { profile_id: 'x' }, { is_active: 'maybe' }]) expect((await fails('listProfileImages', req({ query: q }))).statusCode, JSON.stringify(q)).toBe(400);
  }, T);
  it('permissions: set / clear need manage, list needs read; the patient app grant is 403 on all three and nothing is written', async () => {
    const pid = uid(); const img = await asset(); await set('doctor', pid, img);
    for (const grants of [[PERM.read], [PERM.self], []]) {
      expectCode(await fails('setProfileImage', req({ params: { profile_kind: 'doctor', profile_id: pid }, body: { image_attachment_id: await asset() } }), { grants }), 'auth.forbidden', 403);
      expectCode(await fails('clearProfileImage', req({ params: { profile_kind: 'doctor', profile_id: pid } }), { grants }), 'auth.forbidden', 403);
    }
    for (const grants of [[PERM.manage], [PERM.self], []]) expectCode(await fails('listProfileImages', req({ query: {} }), { grants }), 'auth.forbidden', 403);
    expect(await imgRow(TENANT_A, 'doctor', pid)).toMatchObject({ image_attachment_id: img, is_active: true });
  }, T);
  it('race: 6 concurrent sets of the same profile leave exactly one row and no 500', async () => {
    const pid = uid(); const imgsIds = await Promise.all([1, 2, 3, 4, 5, 6].map(() => asset()));
    const rs = await Promise.allSettled(imgsIds.map((i) => set('centre', pid, i)));
    for (const r of rs) if (r.status === 'rejected') expect([409, 400], String((r.reason as any)?.code ?? r.reason)).toContain((r.reason as any).statusCode);
    expect(rs.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await ownerRows('engagement.profile_image', 'tenant_id = $1 AND profile_kind = $2 AND profile_id = $3', [TENANT_A, 'centre', pid])).toHaveLength(1);
  }, T);
});
