// HC-T15 H16 listPhleboDevices (GET /devices; 02-TRD §5.3 H16, 03-APP-FLOW §2.4 device table, 07-SECURITY §4 privilege escalation, REQ-SEC-081).
// Fails now: H16 is an HC-T01 stub (501 / common.internal), so every call below fails for the right reason. Committed rows are shared with other test files of the same DB: assertions are
// on the ids this file seeded (present / absent), never on totals.
import { describe, expect, it } from 'vitest';
import { ADMIN, ADMIN_B, DISPATCHER, MEMBER, MEMBER2, P, PHLEBO, T, allPages, as, listDevices, listFails, schemaErrors, seedDevice, staffName, v7 } from './helpers.js';

const seedMix = async () => {
  const active = await seedDevice('a', { model: 'Synthetic Phone Active' });
  const active2 = await seedDevice('a', { membership_id: MEMBER2.a, model: 'Synthetic Phone Active2' });
  const signed = await seedDevice('a', { status: 'signed_off', signed_off_at: '2026-11-01T10:00:00Z' });
  const wipeReq = await seedDevice('a', { status: 'wipe_requested', wipe_requested_at: '2026-11-02T10:00:00Z', wipe_reason_code: 'lost', wipe_reason_text: 'Synthetic reason text' });
  const wiped = await seedDevice('a', { membership_id: MEMBER2.a, status: 'wiped', wipe_requested_at: '2026-11-02T10:00:00Z', wiped_at: '2026-11-03T10:00:00Z', wipe_reason_code: 'stolen' });
  const other = await seedDevice('b', { model: 'Synthetic Phone Tenant B' });
  return { active, active2, signed, wipeReq, wiped, other, all: [active, active2, signed, wipeReq, wiped] };
};

describe('H16 privileged (07-SECURITY §4: phlebotomist/dispatcher -> 403 auth.forbidden; device.manage at aal1 -> 403 auth.mfa_required)', () => {
  it('no device.manage grant -> auth.forbidden (phlebotomist, dispatcher, nobody); device.manage at aal1 -> auth.mfa_required; the check is IdentityPort.assertRole(homecollection.device.manage) and runs before any validation', { timeout: T }, async () => {
    for (const who of [PHLEBO, DISPATCHER, as(ADMIN, { grants: [] }), as(ADMIN, { grants: [P.sync, P.assign, P.settings] })]) {
      const e = await listFails({}, who); expect(e.code).toBe('auth.forbidden'); expect(e.statusCode).toBe(403);
    }
    const e = await listFails({}, as(ADMIN, { mfa: 'aal1' }));
    expect(e.code).toBe('auth.mfa_required'); expect(e.statusCode).toBe(403);
    expect(e.probe.identity).toEqual([{ permission: 'homecollection.device.manage' }]);
    expect((await listFails({ status: 'nonsense', limit: 9999 }, as(ADMIN, { mfa: 'aal1' }))).code).toBe('auth.mfa_required');   // no validation oracle below the gate
    expect((await listFails({ status: 'nonsense' }, PHLEBO)).code).toBe('auth.forbidden');
  });
  it('a refused call touches no data: no memberships lookup', { timeout: T }, async () => {
    for (const who of [PHLEBO, as(ADMIN, { mfa: 'aal1' })]) expect((await listFails({}, who)).probe.memberships).toEqual([]);
  });
  it('device.manage at aal2 succeeds and re-validates through assertRole on every call', { timeout: T }, async () => {
    const a = await listDevices({}); const b = await listDevices({});
    expect(a.status).toBe(200); expect(a.probe.identity).toEqual([{ permission: 'homecollection.device.manage' }]); expect(b.probe.identity.length).toBe(1);
  });
});

describe('H16 content (DeviceDto page, display_name via core memberships.list)', () => {
  it('200 { data: DeviceDto[], page: { limit } } validated against the contract; every row has the tenant-A device it was seeded from', { timeout: T }, async () => {
    const s = await seedMix();
    const { ids } = await allPages({}, ADMIN, 200);
    for (const d of s.all) expect(ids.filter((i) => i === d.id), d.id).toHaveLength(1);
    const r = await listDevices({ limit: 200 });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['data', 'page']);
    expect(r.body.page.limit).toBe(200);
    expect(r.body.data.length).toBeLessThanOrEqual(200);
    for (const d of r.body.data) expect(schemaErrors('DeviceDto', d), d.id).toEqual([]);
  });
  it('default limit is 50 (02-CV §4.3): page.limit = 50 and at most 50 rows', { timeout: T }, async () => {
    await seedMix();
    const r = await listDevices({});
    expect(r.body.page.limit).toBe(50); expect(r.body.data.length).toBeLessThanOrEqual(50);
  });
  it('DeviceDto fields: the stored values, display_name = the staff name of the membership, optional fields absent (never null), no wipe reason / requested_by / signed_off_at in the DTO', { timeout: T }, async () => {
    const s = await seedMix();
    const { ids } = await allPages({}, ADMIN, 200);
    expect(ids).toContain(s.wipeReq.id);
    const byId = new Map((await listDevices({ status: 'wipe_requested', limit: 200 })).body.data.map((d: any) => [d.id, d]));
    const w: any = byId.get(s.wipeReq.id);
    expect(w).toMatchObject({ id: s.wipeReq.id, version: 1, membership_id: MEMBER.a, display_name: staffName(MEMBER.a), platform: 'android', os_version: '14', app_version: '1.0.0', status: 'wipe_requested', max_device_seq_received: 0 });
    expect(w.wipe_requested_at).toBe('2026-11-02T10:00:00.000Z');
    for (const k of ['wipe_reason_code', 'wipe_reason_text', 'wipe_requested_by', 'signed_off_at', 'tenant_id', 'is_active', 'created_by', 'updated_by']) expect(w, k).not.toHaveProperty(k);
    expect(w).not.toHaveProperty('wiped_at');
    for (const d of byId.values()) for (const [k, v] of Object.entries(d as object)) expect(v, `${k} is null`).not.toBeNull();
    const wiped: any = (await listDevices({ status: 'wiped', limit: 200 })).body.data.find((d: any) => d.id === s.wiped.id);
    expect(wiped.wiped_at).toBe('2026-11-03T10:00:00.000Z'); expect(wiped.display_name).toBe(staffName(MEMBER2.a));
  });
  it('display names are resolved in ONE memberships.list call per page (membershipIds filter, inactive staff included), not one per row', { timeout: T }, async () => {
    await seedMix();
    const r = await listDevices({ limit: 200 });
    expect(r.probe.memberships.length).toBe(1);
    expect(r.probe.memberships[0]).toMatchObject({ activeOnly: false });
    const asked = new Set<string>(r.probe.memberships[0]!['membershipIds'] as string[]);
    for (const d of r.body.data) expect(asked.has(d.membership_id), d.id).toBe(true);
    expect(r.probe.memberships[0]!['membershipIds'] as string[]).toHaveLength(asked.size);   // deduplicated
  });
  it('a failing staff-name lookup never fails the list: rows still come back with a non-empty display_name placeholder', { timeout: T }, async () => {
    const s = await seedMix();
    const r = await listDevices({ limit: 200 }, ADMIN, { coreFails: true });
    expect(r.status).toBe(200);
    const d = r.body.data.find((x: any) => x.id === s.active.id);
    expect(typeof d.display_name).toBe('string'); expect(d.display_name.length).toBeGreaterThan(0);
    expect(d.display_name).not.toBe(staffName(MEMBER.a));
  });
  it('REQ-SEC-081: nothing of the staff names / device model is logged', { timeout: T }, async () => {
    await seedMix();
    const r = await listDevices({ limit: 200 });
    const log = r.probe.logs.join('\n');
    expect(log).not.toContain(staffName(MEMBER.a)); expect(log).not.toContain('Synthetic Phone');
  });
});

describe('H16 filters (status, membership_id)', () => {
  it('status filter returns exactly the rows of that status, for each of the four statuses', { timeout: T }, async () => {
    const s = await seedMix();
    const want = { active: [s.active.id, s.active2.id], signed_off: [s.signed.id], wipe_requested: [s.wipeReq.id], wiped: [s.wiped.id] } as const;
    for (const [status, mine] of Object.entries(want)) {
      const { ids, pages } = await allPages({ status });
      for (const p of pages) for (const d of p.data) expect(d.status, `${status}: ${d.id}`).toBe(status);
      for (const id of mine) expect(ids, `${status} lists ${id}`).toContain(id);
      for (const d of s.all.filter((x) => !(mine as readonly string[]).includes(x.id))) expect(ids, `${status} must not list ${d.id}`).not.toContain(d.id);
    }
  });
  it('membership_id filter returns only that membership\'s devices; combined with status it is an AND', { timeout: T }, async () => {
    const s = await seedMix();
    const m2 = await allPages({ membership_id: MEMBER2.a });
    for (const p of m2.pages) for (const d of p.data) expect(d.membership_id).toBe(MEMBER2.a);
    expect(m2.ids).toContain(s.active2.id); expect(m2.ids).toContain(s.wiped.id); expect(m2.ids).not.toContain(s.active.id);
    const both = await allPages({ membership_id: MEMBER2.a, status: 'wiped' });
    expect(both.ids).toContain(s.wiped.id); expect(both.ids).not.toContain(s.active2.id);
  });
  it('a membership with no devices (and a membership id of another tenant) lists nothing', { timeout: T }, async () => {
    await seedMix();
    const r = await listDevices({ membership_id: v7() }); expect(r.body.data).toEqual([]); expect(r.body.page.next_cursor).toBeUndefined();
    const b = await listDevices({ membership_id: (await seedDevice('b')).membership_id }); expect(b.body.data).toEqual([]);   // tenant B's staff, asked by tenant A
  });
  it('validation: unknown status, status with junk, non-uuid membership_id, limit 0 / 201 / -1 / abc, oversize or malformed cursor -> 400 common.validation_failed (or common.invalid_cursor for a cursor)', { timeout: T }, async () => {
    for (const q of [{ status: 'bogus' }, { status: 'ACTIVE' }, { status: 'active,wiped' }, { membership_id: 'not-a-uuid' }, { limit: 0 }, { limit: 201 }, { limit: -1 }, { limit: 'abc' }, { limit: 1.5 }]) {
      const e = await listFails(q as object); expect(e.code, JSON.stringify(q)).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    }
    for (const cursor of ['!!!', 'not-a-cursor', 'eyJ2IjoxfQ', 'x'.repeat(513), Buffer.from('{"v":99}').toString('base64url')]) {
      const e = await listFails({ cursor }); expect(['common.invalid_cursor', 'common.validation_failed'], cursor.slice(0, 20)).toContain(e.code); expect(e.statusCode).toBe(400);
    }
  });
  it('error bodies never echo the submitted value', { timeout: T }, async () => {
    const e = await listFails({ status: 'SYNTHETIC-ECHO-MARKER' });
    expect(JSON.stringify([e.message, e.fields ?? e.errors ?? []])).not.toContain('SYNTHETIC-ECHO-MARKER');
  });
});

describe('H16 pagination (02-CV §4.3: opaque cursor, no gaps, no duplicates)', () => {
  it('walking with limit=2 yields every seeded row exactly once; every full page carries next_cursor; the last one does not', { timeout: T }, async () => {
    const s = await seedMix();
    const { ids, pages } = await allPages({}, ADMIN, 2);
    expect(new Set(ids).size).toBe(ids.length);   // no duplicates
    for (const d of s.all) expect(ids, d.id).toContain(d.id);
    for (const p of pages) { expect(p.page.limit).toBe(2); expect(p.data.length).toBeLessThanOrEqual(2); }
    for (const p of pages.slice(0, -1)) { expect(p.data).toHaveLength(2); expect(typeof p.page.next_cursor).toBe('string'); expect(p.page.next_cursor.length).toBeLessThanOrEqual(512); }
    expect(pages.at(-1).page.next_cursor).toBeUndefined();
    expect(pages.length).toBeGreaterThanOrEqual(3);   // >= 5 seeded rows at 2 per page
  });
  it('the order is stable: two walks return the same sequence of the seeded ids (HC-T15 arbiter ruling: filtered to this test\'s own rows; the DB is shared with parallel test files, so whole-tenant sequences legitimately differ)', { timeout: T }, async () => {
    const s = await seedMix();
    const mine = (ids: string[]) => ids.filter((i) => s.all.some((d) => d.id === i));
    const walkA = mine((await allPages({}, ADMIN, 3)).ids);
    const walkB = mine((await allPages({}, ADMIN, 3)).ids);
    const small = mine((await allPages({}, ADMIN, 2)).ids);
    const large = mine((await allPages({}, ADMIN, 200)).ids);
    for (const w of [walkA, walkB, small, large]) expect(w).toHaveLength(5);   // every seeded row present exactly once
    expect(walkA).toEqual(walkB);
    expect(small).toEqual(large);   // page size does not change the order
  });
  it('a cursor carries no authority: tenant B replaying tenant A\'s cursor sees nothing of tenant A', { timeout: T }, async () => {
    const s = await seedMix();
    const first = await listDevices({ limit: 1 });
    const cursor = first.body.page.next_cursor as string;
    expect(cursor).toBeDefined();
    const tryB = await listDevices({ cursor, limit: 200 }, ADMIN_B).then((r) => r.body.data.map((d: any) => d.id), (e) => (['common.invalid_cursor', 'common.validation_failed'].includes(e.code) ? [] : Promise.reject(e)));
    for (const d of s.all) expect(tryB).not.toContain(d.id);
  });
});

describe('H16 tenant isolation (RLS on and bypassed: the repo\'s own tenant_id filter)', () => {
  it('tenant A never sees tenant B\'s devices and vice versa', { timeout: T }, async () => {
    const s = await seedMix();
    for (const bypassRls of [false, true]) {
      const a = (await allPages({}, ADMIN, 200)).ids; const aBy = (await listDevices({ limit: 200 }, ADMIN, { bypassRls })).body.data.map((d: any) => d.id);
      expect(a, `rls=${!bypassRls}`).not.toContain(s.other.id); expect(aBy).not.toContain(s.other.id);
      const b = (await listDevices({ limit: 200 }, ADMIN_B, { bypassRls })).body.data.map((d: any) => d.id);
      expect(b).toContain(s.other.id);
      for (const d of s.all) expect(b, d.id).not.toContain(d.id);
    }
  });
});
