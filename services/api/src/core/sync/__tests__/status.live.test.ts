// T0B-SYNC-1 done_when (4) STATUS: getSyncStatus returns server time, the limits from settings, the device state and the minimum app version; the clock skew the device
// reports is stored (design section 5). Live PG17.
// Pinned: server_time = ctx.now() (transaction start). The device reports its clock in the optional request header `x-device-time` (ISO instant; the contract has no
// parameter for it, so it is a header, not a spec change); skew_ms = device time minus server time, stored in core.sync_device.last_clock_skew_ms. A missing or malformed
// header leaves the stored skew unchanged and the call still answers 200 (a client bug must not stop syncing).
// Settings injection: createSyncHandlers({ settings: { maxBatchOperations, maxBatchBytes, minAppVersion, offlineApprovalAllowed } }); defaults 50, 1048576, absent, false.
import { describe, expect, it } from 'vitest';
import { A1, A2, B1, AADM, TENANT_A, USER, codeOf, createSyncHandlers, fire, list, newDevice, ok, ownerRows, req, status, uid, wipe } from './helpers.js';

const T = 120_000;
const NOW = new Date('2026-11-17T10:15:00.000Z');
const skewOf = async (id: string) => (await ownerRows('SELECT last_clock_skew_ms, last_seen_at FROM core.sync_device WHERE id = $1', [id]))[0];

describe('getSyncStatus', () => {
  it('answers server time, device state, default limits (50 operations, 1 MB), retry hints (full jitter, cap 5 min) and offline approval default off', async () => {
    const id = await newDevice(A1);
    const r = await status(A1, id, {}, { now: NOW });
    expect(r.reply!.status).toBe(200);
    const b = r.reply!.body;
    expect(b.server_time).toBe(NOW.toISOString());
    expect(b.device_status).toBe('active');
    expect(b.limits).toEqual({ max_batch_operations: 50, max_batch_bytes: 1_048_576 });
    expect(b.retry).toMatchObject({ jitter: 'full', max_delay_ms: 300_000 });
    expect(b.retry.base_delay_ms).toBeGreaterThan(0);
    expect(b.offline_approval_allowed).toBe(false);
    if (b.min_app_version !== undefined) expect(b.min_app_version).toMatch(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/);
    for (const k of Object.keys(b)) expect(['server_time', 'device_status', 'min_app_version', 'limits', 'retry', 'offline_approval_allowed'], k).toContain(k);
  }, T);

  it('limits and the minimum app version come from the settings (injected here), not from constants in the handler', async () => {
    const id = await newDevice(A1);
    const handlers = createSyncHandlers({ settings: { maxBatchOperations: 25, maxBatchBytes: 524_288, minAppVersion: '2.0.1' } });
    const b = ok(await status(A1, id, {}, { handlers, now: NOW }));
    expect(b.limits).toEqual({ max_batch_operations: 25, max_batch_bytes: 524_288 });
    expect(b.min_app_version).toBe('2.0.1');
  }, T);

  it('stores the clock skew the device reports: device 90 s ahead -> +90000 ms; 1.2 s behind -> -1200 ms; visible in listSyncDevices', async () => {
    const id = await newDevice(A1);
    ok(await status(A1, id, { 'x-device-time': new Date(NOW.getTime() + 90_000).toISOString() }, { now: NOW }));
    expect(Number((await skewOf(id)).last_clock_skew_ms)).toBe(90_000);
    ok(await status(A1, id, { 'x-device-time': new Date(NOW.getTime() - 1_200).toISOString() }, { now: NOW }));
    expect(Number((await skewOf(id)).last_clock_skew_ms)).toBe(-1_200);
    const listed = ok(await list(AADM, { user_id: USER.a1, limit: 200 })).data.find((d: any) => d.id === id);
    expect(listed.last_clock_skew_ms).toBe(-1_200);
  }, T);

  it('a huge skew (device clock years off) is stored as is, never an overflow error', async () => {
    const id = await newDevice(A1);
    ok(await status(A1, id, { 'x-device-time': '2999-01-01T00:00:00.000Z' }, { now: NOW }));
    expect(Number((await skewOf(id)).last_clock_skew_ms)).toBe(new Date('2999-01-01T00:00:00.000Z').getTime() - NOW.getTime());
  }, T);

  it('no header or a malformed header leaves the stored skew unchanged and still answers 200', async () => {
    const id = await newDevice(A1);
    ok(await status(A1, id, { 'x-device-time': new Date(NOW.getTime() + 5_000).toISOString() }, { now: NOW }));
    for (const h of [{}, { 'x-device-time': 'yesterday' }, { 'x-device-time': '' }]) {
      const o = await status(A1, id, h, { now: NOW });
      expect(o.reply?.status).toBe(200);
      expect(Number((await skewOf(id)).last_clock_skew_ms)).toBe(5_000);
    }
  }, T);

  it('every contact moves last_seen_at to the server time', async () => {
    const id = await newDevice(A1);
    ok(await status(A1, id, {}, { now: NOW }));
    expect(new Date((await skewOf(id)).last_seen_at).getTime()).toBe(NOW.getTime());
  }, T);

  it('device ids that are not THIS user\'s device in THIS tenant answer sync.device_unknown (409): unknown id, another user\'s device, another tenant\'s device', async () => {
    const mineA2 = await newDevice(A2), tenantB = await newDevice(B1);
    for (const id of [uid(), mineA2, tenantB]) expect(codeOf(await status(A1, id)), id).toBe('sync.device_unknown');
    expect((await skewOf(mineA2)).last_clock_skew_ms).toBeNull();            // the failed probe did not touch the other device
    expect((await skewOf(tenantB)).last_clock_skew_ms).toBeNull();
  }, T);

  it('device_id is required and must be a uuid (common.validation_failed)', async () => {
    expect(codeOf(await fire('getSyncStatus', req({ query: {} }), A1))).toBe('common.validation_failed');
    expect(codeOf(await fire('getSyncStatus', req({ query: { device_id: 'x' } }), A1))).toBe('common.validation_failed');
  }, T);

  it('a pending wipe answers sync.wipe_required (409), not a 200 with device_status', async () => {
    const id = await newDevice(A1); ok(await wipe(AADM, id));
    const o = await status(A1, id);
    expect(codeOf(o)).toBe('sync.wipe_required');
  }, T);

  it('no personal data in logs', async () => {
    const id = await newDevice(A1, { device_label: 'Ram Thapa laptop (SYNTHETIC)' });
    const o = await status(A1, id);
    for (const l of o.logs) expect(l).not.toMatch(/Ram Thapa|device_label/);
  }, T);

  it('tenant of the claims decides: the same device id asked by tenant A (owner) works, the row is tenant A', async () => {
    const id = await newDevice(A1);
    ok(await status(A1, id));
    expect((await ownerRows('SELECT tenant_id FROM core.sync_device WHERE id = $1', [id]))[0].tenant_id).toBe(TENANT_A);
  }, T);
});
