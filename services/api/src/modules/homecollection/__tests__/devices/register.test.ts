// HC-T10 A1 registerPhleboDevice (POST /v1/homecollection/devices, `homecollection.sync.upload`, Idempotency-Key required). 02-TRD §5.2 A1 (`201 DeviceDto`, or `200` on replay / same device re-registered by
// the same membership; a device_id bound to ANOTHER membership -> `409 homecollection.device_not_registered`, review #12), §5 preamble (header X-Lims-Device-Id / X-Lims-App-Version must equal body device_id /
// app_version -> `400 common.id_mismatch`; `426 homecollection.app_version_unsupported` below min_app_version, REQ-SEC-113), §5.3 DeviceDto (display_name via ctx.core.memberships.list, P-17), 05-SCHEMA §4 devices
// (PK id, CHECKs -> a 400, never a 500), 03-APP-FLOW §1.4 (wipe_requested is never undone by A1), 07-SECURITY §3 AB1/AB16 + §5 probes 1 (cross-tenant) and 5 (privilege), §6 (no patient data in logs). AC US-13-2.
// Fails now: A1 is an HC-T01 stub (common.internal "not implemented").
import { describe, expect, it } from 'vitest';
import { DISPATCHER, MEMBER, MEMBER2, NOBODY, P, PHLEBO, PHLEBO2, T, TENANT_A, TENANT_B, as, deviceRow, deviceRows, frozen, hdr, regBody, register, registerFails, responseErrors, schemaErrors, seedDevice,
  setMinAppVersion, staffName, v7 } from './helpers.js';

const DTO_KEYS = ['id', 'version', 'membership_id', 'display_name', 'platform', 'os_version', 'app_version', 'model', 'status', 'registered_at', 'max_device_seq_received'];

describe('A1 register: success', () => {
  it('201 DeviceDto for a new device: bound to the CALLER membership (never a body field), status active, version 1, max_device_seq_received 0, display_name from core.memberships.list; schema-valid; exact keys', { timeout: T }, async () => {
    const id = v7();
    const r = await register(regBody(id));
    expect(r.status).toBe(201);
    expect(schemaErrors('DeviceDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id, version: 1, membership_id: MEMBER.a, display_name: staffName(MEMBER.a), platform: 'android', os_version: '14', app_version: '1.0.0', model: 'Synthetic Phone A',
      status: 'active', max_device_seq_received: 0 });
    expect(Object.keys(r.body).sort()).toEqual([...DTO_KEYS].sort());
    expect(r.probe.memberships.some((m: any) => (m.membershipIds ?? []).includes(MEMBER.a))).toBe(true);
    expect(r.probe.identity.calls.map((c) => c.permission)).toContain(P.sync);
    const row = await deviceRow(id);
    expect(row).toMatchObject({ tenant_id: TENANT_A, membership_id: MEMBER.a, status: 'active', platform: 'android', model: 'Synthetic Phone A', is_active: true, version: 1 });
    expect(Number(row.max_device_seq_received)).toBe(0);
    expect(row.registered_at).toBeTruthy();
    expect(row.signed_off_at).toBeNull();
    expect(row.wipe_requested_at).toBeNull();
    expect(row.wiped_at).toBeNull();
  });
  it('model is optional: absent in the body -> absent in the DTO (no null) and NULL in the row; ios accepted; boundary lengths (os 40, model 80, app 20) accepted', { timeout: T }, async () => {
    const id = v7();
    const r = await register(regBody(id, { model: undefined, platform: 'ios' }));
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty('model');
    expect(r.body.platform).toBe('ios');
    expect((await deviceRow(id)).model).toBeNull();
    const id2 = v7();
    const app = '1234.1234.1234';   // header pattern ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$
    const r2 = await register(regBody(id2, { os_version: 'x'.repeat(40), app_version: app, model: 'm'.repeat(80) }), PHLEBO, { headers: hdr(id2, app) });
    expect(r2.status).toBe(201);
    expect(schemaErrors('DeviceDto', r2.body)).toEqual([]);
  });
  it('mass-assignment: a body membership_id / tenant_id / status / version is an unknown field -> 400 common.validation_failed, no row', { timeout: T }, async () => {
    for (const extra of [{ membership_id: MEMBER2.a }, { tenant_id: TENANT_B }, { status: 'wiped' }, { version: 9 }]) {
      const id = v7();
      const e = await registerFails({ ...regBody(id), ...extra });
      expect(e.code, JSON.stringify(extra)).toBe('common.validation_failed');
      expect(e.statusCode).toBe(400);
      expect(await deviceRows(id)).toHaveLength(0);
    }
  });
});

describe('A1 register: replay / re-register by the same membership (200)', () => {
  it('the same device_id again by the same membership -> 200 with the same row: one row, version unchanged, registered_at unchanged', { timeout: T }, async () => {
    const id = v7();
    const first = await register(regBody(id));
    expect(first.status).toBe(201);
    const again = await register(regBody(id));
    expect(again.status).toBe(200);
    expect(responseErrors('registerPhleboDevice', again.body)).toEqual([]);
    expect(again.body.id).toBe(id);
    expect(again.body.membership_id).toBe(MEMBER.a);
    expect(again.body.registered_at).toBe(first.body.registered_at);
    expect(await deviceRows(id)).toHaveLength(1);
  });
  it('a seeded active device of the caller -> 200, row not duplicated, still bound to the caller', { timeout: T }, async () => {
    const d = await seedDevice('a');
    const r = await register(regBody(d.id));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: d.id, membership_id: MEMBER.a, status: 'active' });
    expect(await deviceRows(d.id)).toHaveLength(1);
  });
  it('re-registering a wipe_requested device (AB13) never un-requests the wipe: status stays wipe_requested, wipe fields untouched (the phone must still receive device_command wipe)', { timeout: T }, async () => {
    const d = await seedDevice('a', { status: 'wipe_requested', wipe_requested_at: '2026-11-10T05:00:00Z', wipe_requested_by: MEMBER2.a, wipe_reason_code: 'lost' });
    const r = await register(regBody(d.id));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('wipe_requested');
    const row = await deviceRow(d.id);
    expect(row.status).toBe('wipe_requested');
    expect(row.wipe_reason_code).toBe('lost');
    expect(row.wiped_at).toBeNull();
  });
  it('concurrent first registrations of the same device_id by the same membership: exactly one row, one 201 + the rest 200, never a 500 / unique-violation leak', { timeout: T }, async () => {
    const id = v7();
    const out = await Promise.allSettled([register(regBody(id)), register(regBody(id)), register(regBody(id))]);
    const rejected = out.filter((o) => o.status === 'rejected').map((o: any) => o.reason?.code ?? String(o.reason));
    expect(rejected).toEqual([]);
    const statuses = out.map((o: any) => o.value.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(await deviceRows(id)).toHaveLength(1);
  });
});

describe('A1 register: binding to another membership / tenant (review #12, AB1, AB16)', () => {
  it('a device_id already bound to ANOTHER membership of the same tenant -> 409 homecollection.device_not_registered; the row is untouched; nothing about the owner is returned', { timeout: T }, async () => {
    const d = await seedDevice('a', { membership_id: MEMBER.a });
    const before = frozen(await deviceRow(d.id));
    const e = await registerFails(regBody(d.id), PHLEBO2);
    expect(e.code).toBe('homecollection.device_not_registered');
    expect(e.statusCode).toBe(409);
    expect(JSON.stringify(e)).not.toContain(MEMBER.a);
    expect(frozen(await deviceRow(d.id))).toEqual(before);
    expect(await deviceRows(d.id)).toHaveLength(1);
  });
  it('also when the other membership signed off or was wiped (terminal rows are not adoptable by another user)', { timeout: T }, async () => {
    for (const status of ['signed_off', 'wiped']) {
      const d = await seedDevice('a', { membership_id: MEMBER.a, status, ...(status === 'signed_off' ? { signed_off_at: '2026-11-10T05:00:00Z' } : { wiped_at: '2026-11-10T05:00:00Z' }) });
      const e = await registerFails(regBody(d.id), PHLEBO2);
      expect(e.code, status).toBe('homecollection.device_not_registered');
      expect((await deviceRow(d.id)).membership_id, status).toBe(MEMBER.a);
    }
  });
  it('cross-tenant (probe 1): tenant A registers the device_id of a tenant-B device -> no tenant-B row changes, no leak (409 device_not_registered or 404 common.not_found, never 200/201/500), RLS on and bypassed', { timeout: T }, async () => {
    const d = await seedDevice('b');
    const before = frozen(await deviceRow(d.id));
    for (const bypassRls of [false, true]) {
      const e = await registerFails(regBody(d.id), PHLEBO, { bypassRls });
      expect(['homecollection.device_not_registered', 'common.not_found'], `bypassRls=${bypassRls}: ${e.code}`).toContain(e.code);
      expect([404, 409]).toContain(e.statusCode);
      expect(JSON.stringify(e)).not.toContain(TENANT_B);
    }
    expect(frozen(await deviceRow(d.id))).toEqual(before);
    expect(await deviceRows(d.id)).toHaveLength(1);
    expect((await deviceRow(d.id)).tenant_id).toBe(TENANT_B);
  });
});

describe('A1 register: validation and header rules (always 400, never a 500 from a DB CHECK)', () => {
  it('invalid bodies -> 400 common.validation_failed and no row: platform outside android|ios, os_version "" / 41 chars, model "" / 81 chars, missing fields, unknown field', { timeout: T }, async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['platform windows', { platform: 'windows' }], ['platform empty', { platform: '' }], ['os_version empty', { os_version: '' }], ['os_version 41', { os_version: 'x'.repeat(41) }],
      ['model empty', { model: '' }], ['model 81', { model: 'm'.repeat(81) }], ['platform missing', { platform: undefined }], ['os_version missing', { os_version: undefined }],
      ['app_version missing', { app_version: undefined }], ['extra field', { imei: '000000000000000' }],
    ];
    for (const [label, over] of cases) {
      const id = v7();
      const e = await registerFails(regBody(id, over), PHLEBO, { headers: hdr(id) });
      expect(e.code, label).toBe('common.validation_failed');
      expect(e.statusCode, label).toBe(400);
      expect(await deviceRows(id), label).toHaveLength(0);
    }
  });
  it('device_id that is not a UUIDv7 (v4, junk, SQL text) and app_version of 21 chars -> 400 common.validation_failed; no device table damage', { timeout: T }, async () => {
    for (const bad of ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', "x'; DROP TABLE homecollection.devices; --", '']) {
      const e = await registerFails(regBody(bad), PHLEBO, { headers: hdr(bad || v7()) });
      expect(e.code, bad).toBe('common.validation_failed');
    }
    const id = v7();
    const long = '1.2.3'.padEnd(21, '0');
    const e = await registerFails(regBody(id, { app_version: long }), PHLEBO, { headers: { 'x-lims-device-id': id, 'x-lims-app-version': long } });
    expect(e.code).toBe('common.validation_failed');
    expect(await deviceRows(id)).toHaveLength(0);
    expect((await register(regBody(v7()))).status).toBe(201);   // the table still works
  });
  it('body null / array / string / number -> 400 common.validation_failed', { timeout: T }, async () => {
    for (const b of [null, [], 'x', 7]) expect((await registerFails(b)).code, JSON.stringify(b)).toBe('common.validation_failed');
  });
  it('header X-Lims-Device-Id != body device_id -> 400 common.id_mismatch (TRD §5 preamble, review m#28); no row is created', { timeout: T }, async () => {
    const id = v7();
    const e = await registerFails(regBody(id), PHLEBO, { headers: hdr(v7()) });
    expect(e.code).toBe('common.id_mismatch');
    expect(e.statusCode).toBe(400);
    expect(await deviceRows(id)).toHaveLength(0);
  });
  it('body app_version != header X-Lims-App-Version -> 400 common.id_mismatch; no row is created', { timeout: T }, async () => {
    const id = v7();
    const e = await registerFails(regBody(id, { app_version: '1.0.1' }), PHLEBO, { headers: hdr(id, '1.0.0') });
    expect(e.code).toBe('common.id_mismatch');
    expect(e.statusCode).toBe(400);
    expect(await deviceRows(id)).toHaveLength(0);
  });
});

describe('A1 register: min_app_version (REQ-SEC-113, CR-C17-007)', () => {
  it('app_version below the tenant min_app_version -> 426 homecollection.app_version_unsupported and no row; at or above -> 201; compared numerically per part (1.10.0 >= 1.9.0)', { timeout: T }, async () => {
    await setMinAppVersion(TENANT_A, '1.9.0');
    try {
      const low = v7();
      const e = await registerFails(regBody(low, { app_version: '1.8.9' }), PHLEBO, { headers: hdr(low, '1.8.9') });
      expect(e.code).toBe('homecollection.app_version_unsupported');
      expect(e.statusCode).toBe(426);
      expect(await deviceRows(low)).toHaveLength(0);
      for (const ok of ['1.9.0', '1.10.0', '2.0.0']) {
        const id = v7();
        expect((await register(regBody(id, { app_version: ok }), PHLEBO, { headers: hdr(id, ok) })).status, ok).toBe(201);
      }
    } finally { await setMinAppVersion(TENANT_A, '1.0.0'); }
  });
});

describe('A1 register: privilege (probe 5) and logs', () => {
  it('no homecollection.sync.upload -> 403 auth.forbidden (dispatcher, read-only, no grants) and no row', { timeout: T }, async () => {
    for (const who of [DISPATCHER, NOBODY, as(PHLEBO, { grants: [P.read] })]) {
      const id = v7();
      const e = await registerFails(regBody(id), who);
      expect(e.code).toBe('auth.forbidden');
      expect(e.statusCode).toBe(403);
      expect(await deviceRows(id)).toHaveLength(0);
    }
  });
  it('REQ-SEC-081: neither the staff display name nor the request values are written to the logs', { timeout: T }, async () => {
    const id = v7();
    const r = await register(regBody(id, { model: 'SYNTHETIC-MODEL-CANARY' }));
    const all = r.probe.logs.join('\n');
    expect(all).not.toContain(staffName(MEMBER.a));
    expect(all).not.toContain('SYNTHETIC-MODEL-CANARY');
  });
});
