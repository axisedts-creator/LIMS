// HC-T15 H17 requestDeviceWipe (POST /devices/{device_id}/wipe; 02-TRD §5.3 H17, 03-APP-FLOW §1.4 + §2.4, US-13-5, 07-SECURITY §4 + AB13, 05-SCHEMA devices).
// done_when "wipe command delivered in snapshot": the snapshot (A2, HC-T11, still a stub) emits device_command = wipe iff devices.status = wipe_requested (TRD §6.2), and cursor.w = status. So here we prove the
// state it reads (row + DeviceDto), and its visible consequences through the REAL A1 / A5 / H16 handlers (wipe not undone by re-register, sign-off refused = AB13, listed as wipe_requested).
// Fails now: H17 is an HC-T01 stub (501 / common.internal). Reasons are the normative wipe_reasons set (seeded idempotently as in ../settings).
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, ADMIN_B, DISPATCHER, NOW, PHLEBO, SYS_ACTOR, MEMBER, MEMBER2, P, T, as, deviceRow, frozen, hdr, listDevices, regBody, register, rejection, schemaErrors, seedDevice, seedReasons, signOff,
  staffName, v7, wipe, wipeFails } from './helpers.js';

beforeAll(async () => { await seedReasons(); }, T);

const REASON = { reason_code: 'lost', reason_text: 'Synthetic: phone left in a synthetic taxi' };

describe('H17 privileged (07-SECURITY §4)', () => {
  it('no device.manage -> auth.forbidden (phlebotomist OWNER of the device, dispatcher, nobody); at aal1 -> auth.mfa_required; before any body / If-Match / device check; the row never moves', { timeout: T }, async () => {
    const d = await seedDevice('a'); const before = frozen(await deviceRow(d.id));
    for (const who of [PHLEBO, DISPATCHER, as(ADMIN, { grants: [] }), as(ADMIN, { grants: [P.sync, P.assign, P.settings] })]) {
      const e = await wipeFails(d.id, REASON, 1, who); expect(e.code).toBe('auth.forbidden'); expect(e.statusCode).toBe(403);
    }
    const e = await wipeFails(d.id, REASON, 1, as(ADMIN, { mfa: 'aal1' }));
    expect(e.code).toBe('auth.mfa_required'); expect(e.statusCode).toBe(403);
    expect(e.probe.identity).toEqual([{ permission: 'homecollection.device.manage' }]);
    for (const [body, im] of [[{ junk: 1 }, undefined], [undefined, 'garbage'], [REASON, 99]] as const) {   // aal1: the gate answers first, whatever else is wrong
      expect((await wipeFails(d.id, body, im, as(ADMIN, { mfa: 'aal1' }))).code).toBe('auth.mfa_required');
    }
    expect((await wipeFails(v7(), REASON, 1, as(ADMIN, { mfa: 'aal1' }))).code).toBe('auth.mfa_required');   // and no existence oracle
    expect(frozen(await deviceRow(d.id))).toEqual(before);
  });
});

describe('H17 happy path (US-13-5: wipe command stored for the next snapshot)', () => {
  it('active -> wipe_requested: 200 DeviceDto (version 2, wipe_requested_at = now), row holds the command (status, at, by, reason code + text); nothing else moves', { timeout: T }, async () => {
    const d = await seedDevice('a', { max_device_seq_received: 7 });
    const r = await wipe(d.id, REASON, 1);
    expect(r.status).toBe(200);
    expect(schemaErrors('DeviceDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: d.id, version: 2, status: 'wipe_requested', membership_id: MEMBER.a, display_name: staffName(MEMBER.a), max_device_seq_received: 7, wipe_requested_at: NOW.toISOString() });
    expect(r.body).not.toHaveProperty('wiped_at');
    for (const k of ['wipe_reason_code', 'wipe_reason_text', 'wipe_requested_by']) expect(r.body, k).not.toHaveProperty(k);
    const row = await deviceRow(d.id);
    expect(row).toMatchObject({ status: 'wipe_requested', version: 2, wipe_reason_code: 'lost', wipe_reason_text: REASON.reason_text, wiped_at: null, signed_off_at: null, membership_id: MEMBER.a,
      platform: 'android', app_version: '1.0.0', os_version: '14' });
    expect(Number(row.max_device_seq_received)).toBe(7);
    expect(new Date(row.wipe_requested_at).toISOString()).toBe(NOW.toISOString());
    expect([SYS_ACTOR, ADMIN.membershipId]).toContain(row.wipe_requested_by);   // the admin who asked (user id or membership id; spec: "wipe_requested_by uuid")
  });
  it('reason_text is optional; every normative wipe reason code is accepted (other needs text, see validation)', { timeout: T }, async () => {
    for (const code of ['lost', 'stolen', 'retired', 'reassigned']) {
      const d = await seedDevice('a'); const r = await wipe(d.id, { reason_code: code }, 1);
      expect(r.body.status, code).toBe('wipe_requested');
      expect(await deviceRow(d.id)).toMatchObject({ wipe_reason_code: code, wipe_reason_text: null });
    }
    const d = await seedDevice('a'); await wipe(d.id, { reason_code: 'other', reason_text: 'Synthetic other reason' }, 1);
    expect(await deviceRow(d.id)).toMatchObject({ wipe_reason_code: 'other', wipe_reason_text: 'Synthetic other reason' });
  });
  it('reason_text of exactly 500 characters is stored whole', { timeout: T }, async () => {
    const d = await seedDevice('a'); const text = 'é'.repeat(500);
    await wipe(d.id, { reason_code: 'retired', reason_text: text }, 1);
    expect((await deviceRow(d.id)).wipe_reason_text).toBe(text);
  });
  it('works for a device of any membership of the tenant (the admin is not the owner) and the DeviceDto display_name is the OWNER\'s name', { timeout: T }, async () => {
    const d = await seedDevice('a');
    expect(d.membership_id).not.toBe(ADMIN.membershipId);
    expect((await wipe(d.id, REASON, 1)).body.display_name).toBe(staffName(d.membership_id));
  });
  it('a failing staff-name lookup does not block the wipe (the command is stored; display_name is a placeholder)', { timeout: T }, async () => {
    const d = await seedDevice('a');
    const r = await wipe(d.id, REASON, 1, ADMIN, { coreFails: true });
    expect(r.status).toBe(200); expect(r.body.status).toBe('wipe_requested');
    expect(typeof r.body.display_name).toBe('string'); expect(r.body.display_name.length).toBeGreaterThan(0);
    expect((await deviceRow(d.id)).status).toBe('wipe_requested');
  });
  it('REQ-SEC-081: the reason text, staff name and device model are not logged', { timeout: T }, async () => {
    const d = await seedDevice('a', { model: 'Synthetic Phone Secret' });
    const r = await wipe(d.id, { reason_code: 'lost', reason_text: 'SYNTHETIC-TEXT-MARKER' }, 1);
    const log = r.probe.logs.join('\n');
    for (const s of ['SYNTHETIC-TEXT-MARKER', staffName(MEMBER.a), 'Synthetic Phone Secret']) expect(log).not.toContain(s);
  });
});

describe('H17 delivered to the phone (done_when; the snapshot reads status = wipe_requested)', () => {
  it('H16 now lists the device as wipe_requested with wipe_requested_at', { timeout: T }, async () => {
    const d = await seedDevice('a'); await wipe(d.id, REASON, 1);
    const row = (await listDevices({ status: 'wipe_requested', limit: 200 })).body.data.find((x: any) => x.id === d.id);
    expect(row).toMatchObject({ status: 'wipe_requested', version: 2, wipe_requested_at: NOW.toISOString() });
    expect((await listDevices({ status: 'active', limit: 200 })).body.data.map((x: any) => x.id)).not.toContain(d.id);
  });
  it('AB13: the owner signing off to dodge the wipe -> 409 homecollection.unsynced_changes, even with last_device_seq <= max_device_seq_received; the command stays', { timeout: T }, async () => {
    const d = await seedDevice('a'); await wipe(d.id, REASON, 1);
    const e = await rejection(signOff(d.id, { last_device_seq: 0 }, PHLEBO_AS_OWNER()));
    expect(e.code).toBe('homecollection.unsynced_changes'); expect(e.statusCode).toBe(409);
    expect(await deviceRow(d.id)).toMatchObject({ status: 'wipe_requested', signed_off_at: null, version: 2, wipe_reason_code: 'lost' });
  });
  it('the phone re-registering (A1) does not undo the command: 200 with status wipe_requested, row unchanged', { timeout: T }, async () => {
    const d = await seedDevice('a'); await wipe(d.id, REASON, 1);
    const before = frozen(await deviceRow(d.id));
    const r = await register(regBody(d.id), PHLEBO_AS_OWNER(), { headers: hdr(d.id) });
    expect(r.body.status).toBe('wipe_requested');
    expect(frozen(await deviceRow(d.id))).toMatchObject({ status: 'wipe_requested', wipe_requested_at: before.wipe_requested_at, wiped_at: null });
  });
  it('the command is per device: the same member\'s other devices and other members\' devices stay active', { timeout: T }, async () => {
    const d = await seedDevice('a'); const sibling = await seedDevice('a'); const stranger = await seedDevice('a', { membership_id: MEMBER2.a });
    await wipe(d.id, REASON, 1);
    expect((await deviceRow(sibling.id)).status).toBe('active'); expect((await deviceRow(stranger.id)).status).toBe('active');
  });
});

describe('H17 If-Match (02-CV §4.2) and state rules', () => {
  it('If-Match absent -> 428 common.precondition_required; malformed (no quotes, 0, negative, text, too big) -> 400 common.validation_failed; row unchanged', { timeout: T }, async () => {
    const d = await seedDevice('a'); const before = frozen(await deviceRow(d.id));
    const e = await wipeFails(d.id, REASON, undefined); expect(e.code).toBe('common.precondition_required'); expect(e.statusCode).toBe(428);
    for (const im of ['1', '"0"', '"-1"', '"abc"', '"1.5"', '"99999999999"', 'W/"1"', '']) {
      const x = await wipeFails(d.id, REASON, im); expect(x.code, im).toBe('common.validation_failed'); expect(x.statusCode).toBe(400);
    }
    expect(frozen(await deviceRow(d.id))).toEqual(before);
  });
  it('stale If-Match -> 409 common.version_conflict, row unchanged; the current one succeeds', { timeout: T }, async () => {
    const d = await seedDevice('a', { version: 3 });
    for (const v of [1, 2, 4]) { const e = await wipeFails(d.id, REASON, v); expect(e.code, String(v)).toBe('common.version_conflict'); expect(e.statusCode).toBe(409); }
    expect(await deviceRow(d.id)).toMatchObject({ status: 'active', version: 3, wipe_requested_at: null });
    expect((await wipe(d.id, REASON, 3)).body).toMatchObject({ status: 'wipe_requested', version: 4 });
  });
  it('already wiped / signed_off -> 409 common.version_conflict (TRD H17); the terminal row is untouched', { timeout: T }, async () => {
    const wiped = await seedDevice('a', { status: 'wiped', wiped_at: '2026-11-03T10:00:00Z', wipe_requested_at: '2026-11-02T10:00:00Z', wipe_reason_code: 'stolen' });
    const signed = await seedDevice('a', { status: 'signed_off', signed_off_at: '2026-11-01T10:00:00Z' });   // ASSUMED: same answer as wiped (terminal; nothing to wipe)
    for (const d of [wiped, signed]) {
      const before = frozen(await deviceRow(d.id));
      const e = await wipeFails(d.id, REASON, 1); expect(e.code, d.status).toBe('common.version_conflict'); expect(e.statusCode).toBe(409);
      expect(frozen(await deviceRow(d.id))).toEqual(before);
    }
    expect((await deviceRow(wiped.id)).wipe_reason_code).toBe('stolen');
  });
  it('a second request on a wipe_requested device never overwrites the first reason / time (200 no-op or 409 version_conflict, never a 5xx)', { timeout: T }, async () => {
    const d = await seedDevice('a'); await wipe(d.id, REASON, 1);
    const first = await deviceRow(d.id);
    const second = await wipe(d.id, { reason_code: 'stolen', reason_text: 'Synthetic second' }, 2, ADMIN).then((r) => ({ ok: r.status }), (e) => ({ code: e.code, status: e.statusCode }));
    if ('ok' in second) expect(second.ok).toBe(200); else expect(second).toEqual({ code: 'common.version_conflict', status: 409 });
    const after = await deviceRow(d.id);
    expect(after).toMatchObject({ status: 'wipe_requested', wipe_reason_code: 'lost', wipe_reason_text: REASON.reason_text });
    expect(new Date(after.wipe_requested_at).toISOString()).toBe(new Date(first.wipe_requested_at).toISOString());
  });
});

describe('H17 not found / tenant isolation', () => {
  it('unknown device -> 404 common.not_found', { timeout: T }, async () => {
    const e = await wipeFails(v7(), REASON, 1); expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
  });
  it('another tenant\'s device -> 404 common.not_found (RLS on and bypassed), nothing changes; tenant B cannot wipe tenant A either', { timeout: T }, async () => {
    const b = await seedDevice('b'); const a = await seedDevice('a');
    const beforeB = frozen(await deviceRow(b.id)); const beforeA = frozen(await deviceRow(a.id));
    for (const bypassRls of [false, true]) {
      const e = await wipeFails(b.id, REASON, 1, ADMIN, { bypassRls }); expect(e.code, `rls=${!bypassRls}`).toBe('common.not_found'); expect(e.statusCode).toBe(404);
      const e2 = await wipeFails(a.id, REASON, 1, ADMIN_B, { bypassRls }); expect(e2.code).toBe('common.not_found');
    }
    expect(frozen(await deviceRow(b.id))).toEqual(beforeB); expect(frozen(await deviceRow(a.id))).toEqual(beforeA);
  });
  it('404 for another tenant and for unknown are indistinguishable (same code, same message)', { timeout: T }, async () => {
    const b = await seedDevice('b');
    const e1 = await wipeFails(b.id, REASON, 1); const e2 = await wipeFails(v7(), REASON, 1);
    expect([e1.code, e1.statusCode, e1.message]).toEqual([e2.code, e2.statusCode, e2.message]);
  });
});

describe('H17 validation (400 common.validation_failed; never a 500; row untouched; submitted values not echoed)', () => {
  const bad: Array<[string, unknown]> = [
    ['body missing', undefined], ['body null', null], ['body array', []], ['body string', 'lost'], ['empty object', {}],
    ['reason_code missing', { reason_text: 'x' }], ['reason_code number', { reason_code: 1 }], ['reason_code empty', { reason_code: '' }],
    ['reason_code not in wipe_reasons', { reason_code: 'on_fire' }], ['reason_code of ANOTHER set (visit_cancel_reasons)', { reason_code: 'patient_request' }],
    ['reason_code wrong case', { reason_code: 'Lost' }], ['reason_code with spaces', { reason_code: 'lo st' }], ['reason_code > 64', { reason_code: 'a'.repeat(65) }],
    ['reason_text empty', { reason_code: 'lost', reason_text: '' }], ['reason_text 501 chars', { reason_code: 'lost', reason_text: 'x'.repeat(501) }],
    ['reason_text number', { reason_code: 'lost', reason_text: 5 }], ['reason_text NUL', { reason_code: 'lost', reason_text: 'a\u0000b' }],
    ['other without reason_text (wipe_reasons.other requires_text; ASSUMED)', { reason_code: 'other' }],
    ['unknown field', { reason_code: 'lost', wiped: true }], ['status smuggled in', { reason_code: 'lost', status: 'wiped' }],
    ['membership smuggled in', { reason_code: 'lost', membership_id: v7() }],
  ];
  it.each(bad)('%s', { timeout: T }, async (_n, body) => {
    const d = await seedDevice('a'); const before = frozen(await deviceRow(d.id));
    const e = await wipeFails(d.id, body, 1);
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    expect(frozen(await deviceRow(d.id))).toEqual(before);
  });
  it('device_id in the path must be a uuid: junk -> 400; and no submitted value is echoed in the error', { timeout: T }, async () => {
    for (const id of ['not-a-uuid', '', '1', 'x'.repeat(200)]) { const e = await wipeFails(id, REASON, 1); expect(e.code, id).toBe('common.validation_failed'); }
    const d = await seedDevice('a');
    const e = await wipeFails(d.id, { reason_code: 'SYNTHETIC-ECHO-MARKER' }, 1);
    expect(JSON.stringify([e.message, e.fields ?? e.errors ?? []])).not.toContain('SYNTHETIC-ECHO-MARKER');
  });
});

describe('H17 races (many admins at once; 07-SECURITY: race conditions)', () => {
  it('two wipe requests with the same If-Match: exactly one wins, the other is 409 common.version_conflict; version 2 exactly; first writer\'s reason kept', { timeout: T }, async () => {
    const d = await seedDevice('a');
    const out = await Promise.allSettled([wipe(d.id, { reason_code: 'lost' }, 1), wipe(d.id, { reason_code: 'stolen' }, 1)]);
    const ok = out.filter((o) => o.status === 'fulfilled'); const ko = out.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(ok).toHaveLength(1); expect(ko).toHaveLength(1);
    expect(ko[0]!.reason.code).toBe('common.version_conflict');
    const row = await deviceRow(d.id);
    expect(row).toMatchObject({ status: 'wipe_requested', version: 2 });
    expect(['lost', 'stolen']).toContain(row.wipe_reason_code);
    expect((ok[0] as PromiseFulfilledResult<any>).value.body.version).toBe(2);
  });
  it('wipe vs. sign-off at the same time: exactly one succeeds, the row is never both; a wipe that lost sees 409 version_conflict, a sign-off that lost sees 409 unsynced_changes', { timeout: T }, async () => {
    for (let i = 0; i < 4; i++) {
      const d = await seedDevice('a');
      const [w, s] = await Promise.allSettled([wipe(d.id, REASON, 1), signOff(d.id, { last_device_seq: 0 }, PHLEBO_AS_OWNER())]);
      const row = await deviceRow(d.id);
      if (w.status === 'fulfilled') {
        expect(s.status).toBe('rejected'); expect((s as PromiseRejectedResult).reason.code).toBe('homecollection.unsynced_changes');
        expect(row).toMatchObject({ status: 'wipe_requested', signed_off_at: null });
      } else {
        expect(s.status).toBe('fulfilled'); expect(w.reason.code).toBe('common.version_conflict');
        expect(row).toMatchObject({ status: 'signed_off', wipe_requested_at: null, wipe_reason_code: null });
      }
    }
  });
  it('ten concurrent wipe requests (same If-Match) leave one command: version 2, one success', { timeout: T }, async () => {
    const d = await seedDevice('a');
    const out = await Promise.allSettled(Array.from({ length: 10 }, () => wipe(d.id, { reason_code: 'retired' }, 1)));
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const o of out) if (o.status === 'rejected') expect(o.reason.code).toBe('common.version_conflict');
    expect(await deviceRow(d.id)).toMatchObject({ status: 'wipe_requested', version: 2 });
  });
});

// The owner of a seeded device (hc.device default membership = MEMBER.a) calling A1 / A5 with sync.upload only (as HC-T10's PHLEBO).
function PHLEBO_AS_OWNER() { return { tenant: PHLEBO.tenant, membershipId: MEMBER.a, grants: [P.read, P.sync] }; }
