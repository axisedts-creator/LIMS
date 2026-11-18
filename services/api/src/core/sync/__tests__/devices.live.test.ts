// T0B-SYNC-1 done_when (2) DEVICES + (5) audit / no personal data in logs: registerSyncDevice, listSyncDevices, revokeSyncDevice, requestSyncDeviceWipe, ackDeviceWipe.
// Live PG17 (RLS on). Contract: contracts/openapi/core.yaml (T0C-SYNC-1); design C:/LIMS-state/offline-design-20261117.md section 6.
// Pinned (see .orchestra/notes/T0B-SYNC-1-tests.md): another user registering a known device id -> auth.forbidden; unknown device on admin / ack operations -> sync.device_unknown;
// getSyncStatus / reserveNumberBlock / register on a revoked device -> sync.device_revoked, on a wipe_requested device -> sync.wipe_required (409), also after the ack.
import { describe, expect, it } from 'vitest';
import { A1, A2, AADM, B1, BADM, TENANT_A, TENANT_B, USER, ack, codeOf, fire, list, newDevice, ok, ownerRows, reg, req, reserve, revoke, status, uid, wipe } from './helpers.js';

const T = 120_000;
const dev = async (id: string) => (await ownerRows('SELECT * FROM core.sync_device WHERE id = $1', [id]))[0];
const audit = (id: string) => ownerRows(`SELECT action, changed_columns, new_values, actor_id, actor_type, request_id, tenant_id FROM audit.audit_log
  WHERE schema_name = 'core' AND table_name = 'sync_device' AND row_id = $1 ORDER BY occurred_at, id`, [id]);
const SYNC_DEVICE_KEYS = ['id', 'user_id', 'device_label', 'platform', 'app_version', 'status', 'first_seen_at', 'last_seen_at', 'last_sync_at', 'wipe_requested_at', 'wipe_acked_at',
  'last_clock_skew_ms', 'offline_retention_days', 'created_at', 'updated_at'];

describe('registerSyncDevice', () => {
  it('registers a new device for the signed in user: 200, status active, 14 days retention, response keys only from the SyncDevice schema', async () => {
    const id = uid();
    const r = await reg(A1, id, { device_label: 'Collection tablet 3 (SYNTHETIC)', platform: 'android', app_version: '1.3.2' });
    expect(r.error).toBeUndefined();
    expect(r.reply!.status).toBe(200);
    const b = r.reply!.body;
    expect(b).toMatchObject({ id, user_id: USER.a1, device_label: 'Collection tablet 3 (SYNTHETIC)', platform: 'android', app_version: '1.3.2', status: 'active', offline_retention_days: 14 });
    expect(b.first_seen_at).toBe(b.last_seen_at);
    expect(b.first_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    for (const k of Object.keys(b)) expect(SYNC_DEVICE_KEYS, k).toContain(k);
    expect(b).not.toHaveProperty('tenant_id'); expect(b).not.toHaveProperty('version');
    const row = await dev(id);
    expect(row.tenant_id).toBe(TENANT_A); expect(row.user_id).toBe(USER.a1); expect(row.created_by).toBe(USER.a1);
  }, T);

  it('idempotent per device id and user: the second call answers the SAME row (one row), refreshes label / app version, moves last_seen_at, keeps first_seen_at', async () => {
    const id = uid();
    const t0 = new Date('2026-11-17T04:00:00.000Z'), t1 = new Date('2026-11-17T05:30:00.000Z');
    const a = ok(await reg(A1, id, {}, { now: t0 }));
    const b = ok(await reg(A1, id, { device_label: 'Front desk PC 1 renamed (SYNTHETIC)', app_version: '1.5.0' }, { now: t1 }));
    expect(b.id).toBe(id);
    expect(b.first_seen_at).toBe(a.first_seen_at);
    expect(new Date(b.last_seen_at).getTime()).toBe(t1.getTime());
    expect(b).toMatchObject({ device_label: 'Front desk PC 1 renamed (SYNTHETIC)', app_version: '1.5.0', status: 'active' });
    expect(await ownerRows('SELECT 1 FROM core.sync_device WHERE id = $1', [id])).toHaveLength(1);
  }, T);

  it('20 simultaneous registrations of one new device id leave exactly ONE row and every call succeeds (no raw unique violation leaks)', async () => {
    const id = uid();
    const outs = await Promise.all(Array.from({ length: 20 }, () => reg(A1, id)));
    expect(outs.map((o) => o.error?.message ?? o.reply!.status)).toEqual(Array(20).fill(200));
    expect(await ownerRows('SELECT 1 FROM core.sync_device WHERE id = $1', [id])).toHaveLength(1);
  }, T);

  it('a device belongs to ONE user at a time: another user of the tenant registering the same id is refused (auth.forbidden) and the row does not move', async () => {
    const id = await newDevice(A1);
    const before = await dev(id);
    const o = await reg(A2, id, { device_label: 'Stolen (SYNTHETIC)' });
    expect(codeOf(o)).toBe('auth.forbidden');
    const after = await dev(id);
    expect(after.user_id).toBe(USER.a1);
    expect(after.device_label).toBe(before.device_label);
    expect(after.version).toBe(before.version);
  }, T);

  it('a device id owned by ANOTHER TENANT is refused as auth.forbidden, never a raw database error, and nothing of tenant A changes or leaks', async () => {
    const id = await newDevice(A1, { device_label: 'Tenant A secret label (SYNTHETIC)' });
    const o = await reg(B1, id, { device_label: 'Tenant B (SYNTHETIC)' });
    expect(codeOf(o)).toBe('auth.forbidden');
    expect(JSON.stringify(o.error?.message ?? '') + JSON.stringify(o.error?.detail ?? '')).not.toContain('Tenant A secret label');
    const rows = await ownerRows('SELECT tenant_id, user_id, device_label FROM core.sync_device WHERE id = $1', [id]);
    expect(rows).toEqual([{ tenant_id: TENANT_A, user_id: USER.a1, device_label: 'Tenant A secret label (SYNTHETIC)' }]);
  }, T);

  it('a revoked device cannot register again (sync.device_revoked, 403); a device with a pending wipe answers sync.wipe_required (409); neither changes the row', async () => {
    const r = await newDevice(A1), w = await newDevice(A1);
    ok(await revoke(AADM, r)); ok(await wipe(AADM, w));
    const br = await dev(r), bw = await dev(w);
    expect(codeOf(await reg(A1, r))).toBe('sync.device_revoked');
    expect(codeOf(await reg(A1, w))).toBe('sync.wipe_required');
    expect((await dev(r)).version).toBe(br.version); expect((await dev(w)).version).toBe(bw.version);
  }, T);

  it.each([
    ['platform outside web|android|ios', { platform: 'palm' }], ['empty label', { device_label: '' }], ['label of 121 chars', { device_label: 'x'.repeat(121) }],
    ['app_version with spaces', { app_version: '1 4 0' }], ['app_version of 41 chars', { app_version: '1'.repeat(41) }], ['id not a uuid', { id: 'not-a-uuid' }],
  ])('validation: %s -> common.validation_failed, no row', async (_n, patch) => {
    const id = uid();
    const o = await fire('registerSyncDevice', req({ body: { id, device_label: 'PC (SYNTHETIC)', platform: 'web', app_version: '1.0.0', ...patch } }), A1);
    expect(codeOf(o)).toBe('common.validation_failed');
    expect(await ownerRows('SELECT 1 FROM core.sync_device WHERE id = $1', [id])).toHaveLength(0);
  }, T);

  it('an unknown body field and a missing body are refused (common.validation_failed)', async () => {
    expect(codeOf(await fire('registerSyncDevice', req({ body: { id: uid(), device_label: 'PC', platform: 'web', app_version: '1.0.0', user_id: USER.a2 } }), A1))).toBe('common.validation_failed');
    expect(codeOf(await fire('registerSyncDevice', req({}), A1))).toBe('common.validation_failed');
  }, T);

  it('every change writes an audit event: INSERT row in audit.audit_log with the actor, the tenant and the request id; a pure refresh adds an UPDATE row', async () => {
    const id = uid(); const requestId = uid();
    ok(await reg(A1, id, {}, { requestId, now: new Date('2026-11-17T06:00:00.000Z') }));
    ok(await reg(A1, id, { app_version: '1.9.9' }, { now: new Date('2026-11-17T06:10:00.000Z') }));
    const rows = await audit(id);
    expect(rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE']);
    expect(rows[0]).toMatchObject({ actor_id: USER.a1, tenant_id: TENANT_A, request_id: requestId });
    expect(rows[1].changed_columns).toContain('app_version');
  }, T);

  it('no personal data in logs: no log line carries the device label or the request body', async () => {
    const o = await reg(A1, uid(), { device_label: 'Asha Karki phone (SYNTHETIC)' });
    expect(o.error).toBeUndefined();
    for (const l of o.logs) expect(l).not.toMatch(/Asha Karki|device_label/);
  }, T);
});

describe('revokeSyncDevice', () => {
  it('revokes: status revoked, the row is KEPT, and from the next contact status / reserve / register all answer sync.device_revoked (403)', async () => {
    const id = await newDevice(A1);
    const r = await revoke(AADM, id);
    expect(r.reply!.status).toBe(200);
    expect(r.reply!.body).toMatchObject({ id, status: 'revoked', user_id: USER.a1 });
    expect((await dev(id)).status).toBe('revoked');
    for (const o of [await status(A1, id), await reserve(A1, id, 'lab_code', 10), await reg(A1, id)]) expect(codeOf(o)).toBe('sync.device_revoked');
    expect(await ownerRows('SELECT 1 FROM core.sync_device WHERE id = $1', [id])).toHaveLength(1);
  }, T);

  it('revoking a revoked device answers the unchanged row and writes no second audit event', async () => {
    const id = await newDevice(A1);
    const a = ok(await revoke(AADM, id)); const n = (await audit(id)).length;
    const b = ok(await revoke(AADM, id));
    expect(b.status).toBe('revoked'); expect(b.updated_at).toBe(a.updated_at);
    expect(await audit(id)).toHaveLength(n);
  }, T);

  it('revoke is audited: an UPDATE row with status in changed_columns, the admin as actor, the request id', async () => {
    const id = await newDevice(A1); const requestId = uid();
    ok(await revoke(AADM, id, { requestId }));
    const last = (await audit(id)).pop()!;
    expect(last).toMatchObject({ action: 'UPDATE', actor_id: USER.aadm, request_id: requestId, tenant_id: TENANT_A });
    expect(last.changed_columns).toContain('status');
    expect(last.new_values.status).toBe('revoked');
  }, T);

  it('an unknown device id answers sync.device_unknown (409)', async () => { expect(codeOf(await revoke(AADM, uid()))).toBe('sync.device_unknown'); }, T);

  it('a device of ANOTHER tenant answers sync.device_unknown and stays active', async () => {
    const id = await newDevice(B1);
    expect(codeOf(await revoke(AADM, id))).toBe('sync.device_unknown');
    expect((await dev(id)).status).toBe('active');
  }, T);

  it('a revoked device stays revoked: a wipe request on it does not bring it back to wipe_requested', async () => {
    const id = await newDevice(A1); ok(await revoke(AADM, id));
    await wipe(AADM, id);
    expect((await dev(id)).status).toBe('revoked');
  }, T);
});

describe('requestSyncDeviceWipe + ackDeviceWipe', () => {
  it('wipe request: status wipe_requested with wipe_requested_at; the device learns it on the next contact (status, reserve, register -> sync.wipe_required, 409)', async () => {
    const id = await newDevice(A1);
    const w = ok(await wipe(AADM, id));
    expect(w).toMatchObject({ id, status: 'wipe_requested' }); expect(w.wipe_requested_at).toMatch(/^\d{4}-/);
    for (const o of [await status(A1, id), await reserve(A1, id, 'patient_id', 10), await reg(A1, id)]) expect(codeOf(o)).toBe('sync.wipe_required');
  }, T);

  it('requesting a wipe twice keeps the first wipe_requested_at and writes one audit event', async () => {
    const id = await newDevice(A1);
    const a = ok(await wipe(AADM, id)); const n = (await audit(id)).length;
    const b = ok(await wipe(AADM, id));
    expect(b.wipe_requested_at).toBe(a.wipe_requested_at);
    expect(await audit(id)).toHaveLength(n);
  }, T);

  it('wipe request is audited (UPDATE, status + wipe_requested_at changed, admin actor)', async () => {
    const id = await newDevice(A1);
    ok(await wipe(AADM, id));
    const last = (await audit(id)).pop()!;
    expect(last.actor_id).toBe(USER.aadm);
    expect(last.changed_columns).toEqual(expect.arrayContaining(['status', 'wipe_requested_at']));
  }, T);

  it('unknown / other tenant device: sync.device_unknown, other tenant row untouched', async () => {
    expect(codeOf(await wipe(AADM, uid()))).toBe('sync.device_unknown');
    const id = await newDevice(B1);
    expect(codeOf(await wipe(AADM, id))).toBe('sync.device_unknown');
    expect((await dev(id)).status).toBe('active');
  }, T);

  it('ack by the OWNER records wipe_acked_at; the status stays wipe_requested and the device stays unusable (sync.wipe_required) until an administrator decides otherwise', async () => {
    const id = await newDevice(A1); ok(await wipe(AADM, id));
    const a = ok(await ack(A1, id));
    expect(a.status).toBe('wipe_requested'); expect(a.wipe_acked_at).toMatch(/^\d{4}-/);
    expect(codeOf(await status(A1, id))).toBe('sync.wipe_required');
  }, T);

  it('ack is idempotent (second ack answers the same wipe_acked_at, no second audit event)', async () => {
    const id = await newDevice(A1); ok(await wipe(AADM, id));
    const a = ok(await ack(A1, id)); const n = (await audit(id)).length;
    const b = ok(await ack(A1, id));
    expect(b.wipe_acked_at).toBe(a.wipe_acked_at);
    expect(await audit(id)).toHaveLength(n);
  }, T);

  it('only the signed in OWNER may acknowledge: another user and even the administrator get auth.forbidden; nothing is recorded', async () => {
    const id = await newDevice(A1); ok(await wipe(AADM, id));
    expect(codeOf(await ack(A2, id))).toBe('auth.forbidden');
    expect(codeOf(await ack(AADM, id))).toBe('auth.forbidden');
    expect((await dev(id)).wipe_acked_at).toBeNull();
  }, T);

  it('ack: unknown id and other tenant device -> sync.device_unknown; revoked device -> sync.device_revoked', async () => {
    expect(codeOf(await ack(A1, uid()))).toBe('sync.device_unknown');
    expect(codeOf(await ack(A1, await newDevice(B1)))).toBe('sync.device_unknown');
    const id = await newDevice(A1); ok(await revoke(AADM, id));
    expect(codeOf(await ack(A1, id))).toBe('sync.device_revoked');
  }, T);
});

describe('listSyncDevices', () => {
  const page = async (who = AADM, q: Record<string, unknown> = {}) => { const o = await list(who, q); return ok(o); };
  const all = async (who = AADM, q: Record<string, unknown> = {}) => {
    const out: any[] = []; let cursor: string | undefined;
    for (let i = 0; i < 100; i++) { const b = await page(who, { limit: 7, ...q, ...(cursor ? { cursor } : {}) }); out.push(...b.data); cursor = b.page.next_cursor; if (!cursor) break; }
    return out;
  };

  it('lists exactly the tenant devices (revoked and wiped ones stay listed), newest page first walk covers every row once, tenant B never appears', async () => {
    const mine = await newDevice(A1); const revoked = await newDevice(A2); ok(await revoke(AADM, revoked)); await newDevice(B1);
    const got = await all();
    const truth = (await ownerRows('SELECT id FROM core.sync_device WHERE tenant_id = $1', [TENANT_A])).map((r) => r.id).sort();
    expect(got.map((d) => d.id).sort()).toEqual(truth);
    expect(new Set(got.map((d) => d.id)).size).toBe(got.length);
    expect(got.map((d) => d.id)).toEqual(expect.arrayContaining([mine, revoked]));
    expect(got.find((d) => d.id === revoked).status).toBe('revoked');
    for (const d of got) for (const k of Object.keys(d)) expect(SYNC_DEVICE_KEYS, k).toContain(k);
  }, T);

  it('filters: status, user_id, platform', async () => {
    const id = await newDevice(A2, { platform: 'ios' }); ok(await wipe(AADM, id));
    expect((await all(AADM, { status: 'wipe_requested' })).every((d) => d.status === 'wipe_requested')).toBe(true);
    expect((await all(AADM, { status: 'wipe_requested' })).map((d) => d.id)).toContain(id);
    expect((await all(AADM, { user_id: USER.a2 })).every((d) => d.user_id === USER.a2)).toBe(true);
    const ios = await all(AADM, { platform: 'ios' });
    expect(ios.length).toBeGreaterThan(0); expect(ios.every((d) => d.platform === 'ios')).toBe(true);
  }, T);

  it('page size is honoured and a foreign cursor is refused (common.invalid_cursor)', async () => {
    await newDevice(A1); await newDevice(A1); await newDevice(A1);
    const b = await page(AADM, { limit: 2 });
    expect(b.data).toHaveLength(2); expect(b.page.limit).toBe(2); expect(typeof b.page.next_cursor).toBe('string');
    expect(codeOf(await list(AADM, { cursor: 'not-a-cursor' }))).toBe('common.invalid_cursor');
  }, T);

  it('tenant B lists only tenant B devices', async () => {
    const mine = await newDevice(B1);
    const got = await all(BADM);
    expect(got.map((d) => d.id)).toContain(mine);
    const a = new Set((await ownerRows('SELECT id FROM core.sync_device WHERE tenant_id = $1', [TENANT_A])).map((r) => r.id));
    expect(got.filter((d) => a.has(d.id))).toEqual([]);
  }, T);
});
