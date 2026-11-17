// HC-T10 A5 signOffPhleboDevice (POST /v1/homecollection/devices/{device_id}/sign-off, `homecollection.sync.upload`, body {last_device_seq: int >= 0}, `204` / `409 homecollection.unsynced_changes`).
// 01-PRD US-13-2 (sign-off only when the server has received `last_device_seq`; else 409 and sign-out is refused), 02-TRD §5.2 A5 + device-id binding (devices.membership_id = actor.membershipId and
// status in {active, wipe_requested}; A5 also `signed_off` -> no-op 204; else `409 homecollection.device_not_registered`), 03-APP-FLOW §1.4 (active -> signed_off; wipe_requested -> signed_off is NOT allowed:
// 409 unsynced_changes until the wipe is acknowledged; signed_off and wiped are terminal), 05-SCHEMA §4 devices, 07-SECURITY §3 AB1 / AB13 / AB16, §5 probes 1 and 5, §6. Fails now: A5 is an HC-T01 stub.
import { describe, expect, it } from 'vitest';
import { DISPATCHER, MEMBER, MEMBER2, NOBODY, P, PHLEBO, PHLEBO2, T, TENANT_A, as, deviceRow, frozen, hdr, signOff, signOffFails, seedDevice, superTx, v7 } from './helpers.js';

const unsynced = async (id: string, seq: unknown, who = PHLEBO, o = {}) => {
  const e = await signOffFails(id, { last_device_seq: seq }, who, o);
  expect(e.code).toBe('homecollection.unsynced_changes');
  expect(e.statusCode).toBe(409);
  return e;
};

describe('A5 sign-off: the server has (not) received the last seq (US-13-2)', () => {
  it('last_device_seq == max_device_seq_received -> 204 with no body; status signed_off, signed_off_at set, version + 1, updated_by = caller; the binding row (membership, registered_at) is unchanged', { timeout: T }, async () => {
    const d = await seedDevice('a', { max_device_seq_received: 7 });
    const before = await deviceRow(d.id);
    const r = await signOff(d.id, { last_device_seq: 7 });
    expect(r.status).toBe(204);
    expect(r.body ?? null).toBeNull();
    const row = await deviceRow(d.id);
    expect(row.status).toBe('signed_off');
    expect(row.signed_off_at).toBeTruthy();
    expect(row.version).toBe(before.version + 1);
    expect(row.membership_id).toBe(MEMBER.a);
    expect(row.registered_at).toEqual(before.registered_at);
    expect(Number(row.max_device_seq_received)).toBe(7);
    expect(row.wiped_at).toBeNull();
    expect(r.probe.identity.calls.map((c) => c.permission)).toContain(P.sync);
  });
  it('last_device_seq below what the server received (e.g. a later push already arrived) -> 204; and 0 with nothing ever pushed -> 204 (empty log)', { timeout: T }, async () => {
    const d = await seedDevice('a', { max_device_seq_received: 9 });
    expect((await signOff(d.id, { last_device_seq: 4 })).status).toBe(204);
    expect((await deviceRow(d.id)).status).toBe('signed_off');
    const e = await seedDevice('a');
    expect((await signOff(e.id, { last_device_seq: 0 })).status).toBe(204);
    expect((await deviceRow(e.id)).status).toBe('signed_off');
  });
  it('last_device_seq ahead of max_device_seq_received (the seq is missing on the server) -> 409 homecollection.unsynced_changes; nothing changes (status active, no signed_off_at, same version)', { timeout: T }, async () => {
    const d = await seedDevice('a', { max_device_seq_received: 7 });
    const before = frozen(await deviceRow(d.id));
    await unsynced(d.id, 8);
    await unsynced(d.id, 9007199254740991);
    expect(frozen(await deviceRow(d.id))).toEqual(before);
    expect((await deviceRow(d.id)).status).toBe('active');
    // once the server has it, the very same device can sign off
    await superTx(async (tx) => { await tx.query('UPDATE homecollection.devices SET max_device_seq_received = 8 WHERE id = $1', [d.id]); }, TENANT_A);
    expect((await signOff(d.id, { last_device_seq: 8 })).status).toBe(204);
  });
  it('a device that never pushed (max 0) but claims seq 1 -> 409 unsynced_changes', { timeout: T }, async () => {
    const d = await seedDevice('a');
    await unsynced(d.id, 1);
    expect((await deviceRow(d.id)).status).toBe('active');
  });
});

describe('A5 sign-off: wipe_requested -> 409 until the wipe is acknowledged (AB13)', () => {
  it('a wipe_requested device gets 409 homecollection.unsynced_changes whatever last_device_seq says (also 0 and == received); status stays wipe_requested, wipe fields and version untouched', { timeout: T }, async () => {
    const d = await seedDevice('a', { status: 'wipe_requested', max_device_seq_received: 5, wipe_requested_at: '2026-11-10T05:00:00Z', wipe_requested_by: MEMBER2.a, wipe_reason_code: 'stolen' });
    const before = frozen(await deviceRow(d.id));
    for (const seq of [0, 5, 3, 6]) await unsynced(d.id, seq);
    const row = await deviceRow(d.id);
    expect(frozen(row)).toEqual(before);
    expect(row.status).toBe('wipe_requested');
    expect(row.signed_off_at).toBeNull();
    expect(row.wipe_reason_code).toBe('stolen');
  });
  it('after the wipe is acknowledged (status wiped, terminal) the device is no longer signable: 409 homecollection.device_not_registered, row unchanged', { timeout: T }, async () => {
    const d = await seedDevice('a', { status: 'wiped', wiped_at: '2026-11-10T05:30:00Z', max_device_seq_received: 5 });
    const before = frozen(await deviceRow(d.id));
    const e = await signOffFails(d.id, { last_device_seq: 5 });
    expect(e.code).toBe('homecollection.device_not_registered');
    expect(e.statusCode).toBe(409);
    expect(frozen(await deviceRow(d.id))).toEqual(before);
  });
});

describe('A5 sign-off: idempotent retry and races', () => {
  it('an already signed_off device of the caller -> 204 no-op: signed_off_at and version stay as they were (a lost 204 can be retried)', { timeout: T }, async () => {
    const d = await seedDevice('a', { max_device_seq_received: 4 });
    expect((await signOff(d.id, { last_device_seq: 4 })).status).toBe(204);
    const once = await deviceRow(d.id);
    const again = await signOff(d.id, { last_device_seq: 4 });
    expect(again.status).toBe(204);
    const twice = await deviceRow(d.id);
    expect(twice.status).toBe('signed_off');
    expect(twice.signed_off_at).toEqual(once.signed_off_at);
    expect(twice.version).toBe(once.version);
  });
  it('concurrent sign-offs of the same device: all 204, exactly one transition (version + 1), never a 409 version_conflict / 500', { timeout: T }, async () => {
    const d = await seedDevice('a', { max_device_seq_received: 2 });
    const v0 = (await deviceRow(d.id)).version;
    const out = await Promise.allSettled([signOff(d.id, { last_device_seq: 2 }), signOff(d.id, { last_device_seq: 2 }), signOff(d.id, { last_device_seq: 2 })]);
    expect(out.filter((o) => o.status === 'rejected').map((o: any) => o.reason?.code ?? String(o.reason))).toEqual([]);
    expect(out.map((o: any) => o.value.status)).toEqual([204, 204, 204]);
    const row = await deviceRow(d.id);
    expect(row.status).toBe('signed_off');
    expect(row.version).toBe(v0 + 1);
  });
  it('a sign-off that races a wipe request (row turned wipe_requested between read and write) never ends signed_off: either 409 unsynced_changes, or the sign-off won first and the later state is signed_off with no wipe applied over it', { timeout: T }, async () => {
    const d = await seedDevice('a', { max_device_seq_received: 3 });
    const wipe = superTx(async (tx) => {
      await tx.query(`UPDATE homecollection.devices SET status = 'wipe_requested', wipe_requested_at = now(), wipe_requested_by = $2, wipe_reason_code = 'lost', version = version + 1
        WHERE id = $1 AND status = 'active'`, [d.id, MEMBER2.a]);
    }, TENANT_A);
    const out = await Promise.allSettled([signOff(d.id, { last_device_seq: 3 }), wipe]);
    const rejected = out[0]!.status === 'rejected' ? (out[0] as PromiseRejectedResult).reason : null;
    if (rejected) expect(['homecollection.unsynced_changes', 'common.version_conflict']).toContain(rejected.code);
    const row = await deviceRow(d.id);
    expect(['signed_off', 'wipe_requested']).toContain(row.status);
    if (row.status === 'wipe_requested') expect(row.signed_off_at).toBeNull();
    if (row.status === 'signed_off') expect(row.wiped_at).toBeNull();
  });
});

describe('A5 sign-off: binding (AB1, AB16) and probes', () => {
  it('another membership signs off MY device -> 409 homecollection.device_not_registered; row untouched (still active, same version)', { timeout: T }, async () => {
    const d = await seedDevice('a', { membership_id: MEMBER.a, max_device_seq_received: 2 });
    const before = frozen(await deviceRow(d.id));
    const e = await signOffFails(d.id, { last_device_seq: 2 }, PHLEBO2);
    expect(e.code).toBe('homecollection.device_not_registered');
    expect(e.statusCode).toBe(409);
    expect(frozen(await deviceRow(d.id))).toEqual(before);
  });
  it('the binding check wins over the seq check: another membership with an unreachable seq still gets device_not_registered (no hint whether the owner is behind)', { timeout: T }, async () => {
    const d = await seedDevice('a', { membership_id: MEMBER.a, max_device_seq_received: 2 });
    expect((await signOffFails(d.id, { last_device_seq: 500 }, PHLEBO2)).code).toBe('homecollection.device_not_registered');
  });
  it('unknown device id -> 409 homecollection.device_not_registered, nothing created', { timeout: T }, async () => {
    const id = v7();
    const e = await signOffFails(id, { last_device_seq: 0 });
    expect(e.code).toBe('homecollection.device_not_registered');
    expect(e.statusCode).toBe(409);
    expect(await deviceRow(id)).toBeUndefined();
  });
  it('cross-tenant (probe 1): tenant A signs off a tenant-B device -> not changed, no leak (409 device_not_registered or 404 common.not_found), RLS on and bypassed', { timeout: T }, async () => {
    const d = await seedDevice('b', { max_device_seq_received: 1 });
    const before = frozen(await deviceRow(d.id));
    for (const bypassRls of [false, true]) {
      const e = await signOffFails(d.id, { last_device_seq: 1 }, PHLEBO, { bypassRls });
      expect(['homecollection.device_not_registered', 'common.not_found'], `bypassRls=${bypassRls}: ${e.code}`).toContain(e.code);
      expect([404, 409]).toContain(e.statusCode);
    }
    expect(frozen(await deviceRow(d.id))).toEqual(before);
    expect((await deviceRow(d.id)).status).toBe('active');
  });
  it('no homecollection.sync.upload -> 403 auth.forbidden (dispatcher, read-only, no grants); the device is untouched', { timeout: T }, async () => {
    const d = await seedDevice('a', { max_device_seq_received: 1 });
    for (const who of [DISPATCHER, NOBODY, as(PHLEBO, { grants: [P.read] })]) {
      const e = await signOffFails(d.id, { last_device_seq: 1 }, who);
      expect(e.code).toBe('auth.forbidden');
      expect(e.statusCode).toBe(403);
    }
    expect((await deviceRow(d.id)).status).toBe('active');
  });
});

describe('A5 sign-off: validation and header rules', () => {
  it('invalid bodies -> 400 common.validation_failed and the device stays active: missing last_device_seq, negative, fraction, string, null, above 2^53-1, unknown field, non-object body', { timeout: T }, async () => {
    const d = await seedDevice('a', { max_device_seq_received: 5 });
    const bodies: unknown[] = [{}, { last_device_seq: -1 }, { last_device_seq: 1.5 }, { last_device_seq: '5' }, { last_device_seq: null }, { last_device_seq: 9007199254740992 }, { last_device_seq: 5, extra: 1 },
      null, [], 'x', 5];
    for (const b of bodies) {
      const e = await signOffFails(d.id, b);
      expect(e.code, JSON.stringify(b)).toBe('common.validation_failed');
      expect(e.statusCode).toBe(400);
    }
    expect((await deviceRow(d.id)).status).toBe('active');
  });
  it('a path device_id that is not a UUIDv7 (junk, SQL text) -> 400 common.validation_failed, never a 500', { timeout: T }, async () => {
    for (const bad of ['not-a-uuid', "1' OR '1'='1", '3f2504e0-4f89-41d3-9a0c-0305e82c3301']) {
      const e = await signOffFails(bad, { last_device_seq: 0 }, PHLEBO, { headers: hdr(v7()) });
      expect(['common.validation_failed', 'common.id_mismatch'], bad).toContain(e.code);
      expect(e.statusCode, bad).toBe(400);
    }
  });
  it('header X-Lims-Device-Id != path device_id -> 400 common.id_mismatch (TRD §5 preamble) before any other check; the device is untouched', { timeout: T }, async () => {
    const d = await seedDevice('a', { max_device_seq_received: 2 });
    const e = await signOffFails(d.id, { last_device_seq: 2 }, PHLEBO, { headers: hdr(v7()) });
    expect(e.code).toBe('common.id_mismatch');
    expect(e.statusCode).toBe(400);
    expect((await deviceRow(d.id)).status).toBe('active');
    // a header naming a different device of the same user must not let it sign off the path device either
    const other = await seedDevice('a', { max_device_seq_received: 2 });
    expect((await signOffFails(d.id, { last_device_seq: 2 }, PHLEBO, { headers: hdr(other.id) })).code).toBe('common.id_mismatch');
    expect((await deviceRow(d.id)).status).toBe('active');
    expect((await deviceRow(other.id)).status).toBe('active');
  });
});
