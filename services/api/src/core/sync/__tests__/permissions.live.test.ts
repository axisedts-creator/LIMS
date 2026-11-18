// T0B-SYNC-1 done_when (5): permissions are checked PER OPERATION, by the handler itself. The central stage 8a defaults to shadow mode in every environment (LD-261,
// LIMS_CORE_AUTHZ_MODE), where it refuses nothing, so a handler that relied on it alone would leave sync.device.manage open to every staff user.
// Pinned: each handler calls ctx.ports.IdentityPort.assertRole(ctx, { permission }) with the operation's x-permission BEFORE it reads or writes anything; a refusal
// (auth.forbidden, auth.mfa_required) propagates unchanged and nothing is written. Only staff USER actors are served; every other actor type is auth.forbidden.
// NOTE FOR THE WRITER: 'core' is not listed in PORT_CONSUMERS for IdentityPort (contracts/ports/generated/port-consumers.ts, generated from the spec), so reading
// ctx.ports.IdentityPort in a core handler may be refused outside production (core/ports/registry.ts). If so, write a CR (template spec/program/04-CHANGE-REQUESTS.md);
// do not weaken these tests (arbiter decides).
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../errors.js';
import { A1, A2, AADM, USER, ack, codeOf, fire, list, newDevice, ok, ownerRows, req, reserve, reg, revoke, status, syncHandlers, uid, wipe, withCtx, type Who } from './helpers.js';

const T = 120_000;
const snapshot = async () => JSON.stringify([await ownerRows('SELECT id, status, version, user_id, wipe_acked_at FROM core.sync_device ORDER BY id'),
  await ownerRows('SELECT id, from_value, to_value, skipped_count FROM core.number_block ORDER BY id')]);

describe('every operation asserts its x-permission', () => {
  it.each([
    ['registerSyncDevice', 'sync.use'], ['getSyncStatus', 'sync.use'], ['reserveNumberBlock', 'sync.use'], ['ackDeviceWipe', 'sync.use'],
    ['listSyncDevices', 'sync.device.manage'], ['revokeSyncDevice', 'sync.device.manage'], ['requestSyncDeviceWipe', 'sync.device.manage'],
  ])('%s asks IdentityPort.assertRole for %s', async (op, perm) => {
    const d = await newDevice(A1);
    await fire('requestSyncDeviceWipe', req({ params: { device_id: d } }), AADM);   // make ack meaningful; result ignored
    const own = await newDevice(A1);
    const calls: Record<string, () => ReturnType<typeof fire>> = {
      registerSyncDevice: () => reg(A1, uid()), getSyncStatus: () => status(A1, own), reserveNumberBlock: () => reserve(A1, own, 'lab_code', 5),
      ackDeviceWipe: () => ack(A1, d), listSyncDevices: () => list(AADM), revokeSyncDevice: () => revoke(AADM, own), requestSyncDeviceWipe: () => wipe(AADM, own),
    };
    const o = await calls[op]!();
    expect(o.asserted, op).toContain(perm);
  }, T);

  it.each([
    ['registerSyncDevice', ['sync.device.manage']], ['getSyncStatus', []], ['reserveNumberBlock', ['sync.device.manage']], ['ackDeviceWipe', ['sync.device.manage']],
    ['listSyncDevices', ['sync.use']], ['revokeSyncDevice', ['sync.use']], ['requestSyncDeviceWipe', ['sync.use']],
  ])('%s with only %j granted is auth.forbidden and writes nothing', async (op, grants) => {
    const own = await newDevice(A1); const w = await newDevice(A1); ok(await wipe(AADM, w));
    const before = await snapshot();
    const calls: Record<string, () => ReturnType<typeof fire>> = {
      registerSyncDevice: () => reg(A1, uid(), {}, { grants }), getSyncStatus: () => status(A1, own, {}, { grants }), reserveNumberBlock: () => reserve(A1, own, 'lab_code', 5, {}, { grants }),
      ackDeviceWipe: () => ack(A1, w, { grants }), listSyncDevices: () => list(AADM, {}, { grants }), revokeSyncDevice: () => revoke(AADM, own, { grants }), requestSyncDeviceWipe: () => wipe(AADM, own, { grants }),
    };
    const o = await calls[op]!();
    expect(codeOf(o), op).toBe('auth.forbidden');
    expect(await snapshot()).toBe(before);
  }, T);

  it('an MFA step-up refusal from the IdentityPort (privileged sync.device.manage without aal2) propagates as auth.mfa_required and nothing changes', async () => {
    const own = await newDevice(A1);
    const before = await snapshot();
    const handler = syncHandlers.revokeSyncDevice!;
    const o = await withCtx(AADM, async (ctx) => handler(req({ params: { device_id: own } }), { ...ctx, ports: { IdentityPort: { async assertRole() { throw new LimsError('auth.mfa_required'); } } } }));
    expect(codeOf(o)).toBe('auth.mfa_required');
    expect(await snapshot()).toBe(before);
  }, T);
});

describe('only staff user actors are served', () => {
  const OPS: Array<[string, (who: Who, d: string) => ReturnType<typeof fire>]> = [
    ['registerSyncDevice', (w) => reg(w, uid())], ['getSyncStatus', (w, d) => status(w, d)], ['reserveNumberBlock', (w, d) => reserve(w, d, 'lab_code', 5)],
    ['ackDeviceWipe', (w, d) => ack(w, d)], ['listSyncDevices', (w) => list(w)], ['revokeSyncDevice', (w, d) => revoke(w, d)], ['requestSyncDeviceWipe', (w, d) => wipe(w, d)],
  ];
  it.each(['patient', 'portal', 'partner', 'system', 'device'])('actor type %s is auth.forbidden on all 7 operations and nothing changes', async (type) => {
    const d = await newDevice(A1);
    const before = await snapshot();
    for (const [op, call] of OPS) {
      const o = await call({ tenant: AADM.tenant, userId: USER.aadm, type }, d);
      expect(codeOf(o), `${type} ${op}`).toBe('auth.forbidden');
    }
    expect(await snapshot()).toBe(before);
  }, T);
});

describe('object level rules that no permission code can express', () => {
  it('a plain staff user can only act on his own device: another user\'s device is sync.device_unknown for status and block reservation (never its data)', async () => {
    const mine = await newDevice(A1);
    expect(codeOf(await status(A2, mine))).toBe('sync.device_unknown');
    expect(codeOf(await reserve(A2, mine, 'lab_code', 5))).toBe('sync.device_unknown');
  }, T);
});
