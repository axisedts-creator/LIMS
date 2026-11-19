// T0D-OFFLINE-2 done_when 2, 3, 4 (logic under the screens): the controller that the status chip, the Offline panel, the conflict inbox and the unlock overlay use,
// and the PIN change of the encrypted store. Real store, outbox and engine on fake-indexeddb; a recording fetch double speaks the real sync operations.
// CONTRACT (writer):
//   store.ts   store.changePin(oldPin, newPin) -> { ok: true } | { ok: false, reason: 'wrong_pin', attemptsLeft } | { ok: false, reason: 'wiped'|'revoked'|'expired'|'not_setup' }
//              Works while locked or unlocked. It is an attempt like unlock (a wrong old PIN is charged, 10 wipe). On success the SAME data key is wrapped again under the
//              new PIN (new salt): no record is re-encrypted, nothing is lost, the old PIN stops working. An empty new PIN rejects with OfflineError code 'offline.pin_required'.
//   controller.ts  createOfflineController({ store, outbox, engine, connectivity, fetch, deviceId, userId, baseUrl?, now?, permissions, signedInUsers? }) -> controller (see offline2.fixtures.tsx)
//     every action (retry, discard, resolveConflict, unlock, setupPin, syncNow) refreshes the snapshot before its promise resolves.
//     refresh(): Promise<void>      recomputes the snapshot from the store (never throws, also while locked: lists are empty and storeState says 'locked')
//     getSnapshot() fields          conn (connectivity.state(), no network call), storeState, pending, attention, conflicts (decrypted rows), permissions, now, signedInUsers
//     syncNow()                     connectivity.check() first; only when online engine.drain(); then refresh. Offline: no POST to /v1/core/sync/batches.
//     retry(opId)                   moves a needs-attention operation back to the outbox with the SAME op_id (the server idempotency key); { ok: true }
//     discard(opId, reason)         rejects { code: 'offline.reason_required' } on a blank reason; otherwise removes the item from needs-attention and appends ONE audited discard
//                                   operation (op_type matching /discard/) whose payload names the discarded op_id, its op_type, the trimmed reason and NO copy of the original payload
//                                   (no personal data in the audit record). It is sent like any operation at the next sync. NOTE: the closed op catalogue of core.yaml has no discard type yet (CR).
//     loadConflict(id)              GET /v1/core/sync/conflicts/{id} -> { local_payload, server_payload } | null (any failure)
//     resolveConflict(id, { resolution, reason, merged_payload? })
//                                   POST /v1/core/sync/conflicts/{id}/resolve with an Idempotency-Key header, body exactly { resolution, reason[, merged_payload] }.
//                                   Rejects before any request: blank reason 'offline.reason_required'; merge without merged_payload 'offline.merged_payload_required';
//                                   merged_payload on keep_server / apply_local 'offline.merged_payload_not_allowed'. 200: the conflict leaves the local list, { ok: true }.
//                                   409 sync.entity_changed: { ok: false, code: 'sync.entity_changed' }, the conflict stays. Network failure: { ok: false }, the conflict stays.
//     unlock(pin)                   store.unlock; on { ok: true } storeState is 'unlocked' and the lists are filled.
//     setupPin(pin)                 store.setupPin(pin, { userId }) then unlock with it (the user carries on) -> { ok: true }.   changePin(old, next) = store.changePin.
import { describe, expect, it } from 'vitest';
import {
  DEVICE, PIN, USER, fakeServer, newEngine, newStore, orderOp, rawDump, unlockedStore,
} from '@/core/offline/__tests__/offline1.helpers';

const CID = '0192f0d6-0000-7000-8000-00000000c001';
const PERMS = ['sync.use', 'sync.conflict.resolve'];
const SECRET = 'Asha Verma';
const withPatient = (i: number) => ({ op_type: 'registration.create_order', payload: { patient: { full_name: SECRET, phone: '9800000000', patient_id: `p-${i}` } } });

async function build(over: { routes?: Parameters<typeof fakeServer>[0]; unlocked?: boolean } = {}) {
  const env = await unlockedStore();
  const server = fakeServer(over.routes ?? {});
  const { engine, outbox } = await newEngine(env, server);
  const { createConnectivity } = await import('@/core/offline/connectivity');
  const connectivity = createConnectivity({ fetch: server.fetch, now: env.c.now, deviceId: DEVICE });
  const { createOfflineController } = await import('@/core/offline/controller');
  const controller = createOfflineController({ store: env.store, outbox, engine, connectivity, fetch: server.fetch, deviceId: DEVICE, userId: USER, now: env.c.now, permissions: PERMS } as never);
  return { env, server, engine, outbox, connectivity, controller };
}
type Built = Awaited<ReturnType<typeof build>>;
const posts = (b: Built, path: RegExp) => b.server.calls.filter((c) => c.method === 'POST' && path.test(c.path));
const BATCH = /\/v1\/core\/sync\/batches$/;
const RESOLVE = /\/conflicts\/[^/]+\/resolve$/;
const attentionOp = async (b: Built, i = 1, code = 'sync.result_locked') => { const o = await b.outbox.append(withPatient(i)); await b.outbox.moveToAttention(o.op_id, code); return o; };
const conflictOp = async (b: Built, i = 1) => { const o = await b.outbox.append(withPatient(i)); await b.outbox.moveToConflicts(o.op_id, CID, 'sync.base_version_stale'); return o; };

describe('snapshot', () => {
  it('lists pending, needs-attention and conflicts decrypted, with the connection state and permissions', async () => {
    const b = await build();
    const p = await b.outbox.append(orderOp(1));
    const a = await attentionOp(b, 2);
    const c = await conflictOp(b, 3);
    await b.controller.refresh();
    const s = b.controller.getSnapshot();
    expect(s.pending.map((o: { op_id: string }) => o.op_id)).toEqual([p.op_id]);
    expect(s.attention.map((o: { op_id: string }) => o.op_id)).toEqual([a.op_id]);
    expect(s.attention[0]!.code).toBe('sync.result_locked');
    expect(s.conflicts.map((o: { op_id: string }) => o.op_id)).toEqual([c.op_id]);
    expect(s.conflicts[0]!.conflict_id).toBe(CID);
    expect(s.permissions).toEqual(PERMS);
    expect(s.storeState).toBe('unlocked');
    expect(s.conn).toBe('offline'); // nothing has asked the server yet; refresh makes no network call
    expect(b.server.calls).toHaveLength(0);
  });
  it('is the same object until something changes, and subscribers hear about a change', async () => {
    const b = await build();
    await b.controller.refresh();
    const first = b.controller.getSnapshot();
    expect(b.controller.getSnapshot()).toBe(first);
    let heard = 0;
    const off = b.controller.subscribe(() => { heard++; });
    await b.outbox.append(orderOp(1));
    await b.controller.refresh();
    expect(heard).toBeGreaterThan(0);
    expect(b.controller.getSnapshot()).not.toBe(first);
    off();
    const n = heard;
    await b.controller.refresh();
    expect(heard).toBe(n);
  });
  it('a locked store gives empty lists and storeState "locked", and nothing throws', async () => {
    const b = await build();
    await b.outbox.append(orderOp(1));
    b.env.store.lock();
    await expect(b.controller.refresh()).resolves.toBeUndefined();
    const s = b.controller.getSnapshot();
    expect(s.storeState).toBe('locked');
    expect(s.pending).toEqual([]);
    expect(s.attention).toEqual([]);
    expect(s.conflicts).toEqual([]);
  });
  it('actions on a locked store reject with offline.locked', async () => {
    const b = await build();
    const a = await attentionOp(b);
    b.env.store.lock();
    await expect(b.controller.discard(a.op_id, 'why')).rejects.toMatchObject({ code: 'offline.locked' });
    await expect(b.controller.retry(a.op_id)).rejects.toMatchObject({ code: 'offline.locked' });
  });
});

describe('Sync now', () => {
  it('online: checks the server, drains the outbox and the snapshot is empty afterwards', async () => {
    const b = await build();
    for (let i = 0; i < 3; i++) await b.outbox.append(orderOp(i));
    await b.controller.refresh();
    expect(b.controller.getSnapshot().pending).toHaveLength(3);
    await b.controller.syncNow();
    expect(posts(b, BATCH)).toHaveLength(1);
    expect(b.controller.getSnapshot().pending).toEqual([]);
    expect(b.controller.getSnapshot().conn).toBe('online');
  });
  it('offline: no batch is sent, the operations stay, the state says offline', async () => {
    const b = await build({ routes: { 'GET /v1/core/health/live': () => 'throw' } });
    for (let i = 0; i < 3; i++) await b.outbox.append(orderOp(i));
    await expect(b.controller.syncNow()).resolves.toBeUndefined();
    expect(posts(b, BATCH)).toHaveLength(0);
    expect(b.controller.getSnapshot().pending).toHaveLength(3);
    expect(b.controller.getSnapshot().conn).toBe('offline');
  });
  it('rejected and conflicting operations land in the right list after a sync', async () => {
    const b = await build({
      routes: {
        'POST /v1/core/sync/batches': ({ body }) => ({
          status: 200,
          body: { results: body.operations.map((o: { op_id: string }, i: number) => (i === 0 ? { op_id: o.op_id, status: 'rejected', error_code: 'sync.result_locked' } : i === 1 ? { op_id: o.op_id, status: 'conflict', conflict_id: CID, error_code: 'sync.base_version_stale' } : { op_id: o.op_id, status: 'accepted' })) },
        }),
      },
    });
    for (let i = 0; i < 3; i++) await b.outbox.append(orderOp(i));
    await b.controller.syncNow();
    const s = b.controller.getSnapshot();
    expect(s.pending).toEqual([]);
    expect(s.attention).toHaveLength(1);
    expect(s.conflicts).toHaveLength(1);
  });
});

describe('Retry', () => {
  it('puts the operation back in the outbox with the same op_id and the next sync sends it', async () => {
    const b = await build();
    const a = await attentionOp(b);
    await b.controller.refresh();
    expect(await b.controller.retry(a.op_id)).toMatchObject({ ok: true });
    const s = b.controller.getSnapshot();
    expect(s.attention).toEqual([]);
    expect(s.pending.map((o: { op_id: string }) => o.op_id)).toEqual([a.op_id]);
    await b.controller.syncNow();
    expect(b.server.batches.at(-1)!.ids).toEqual([a.op_id]);
    expect(b.controller.getSnapshot().pending).toEqual([]);
  });
  it('an unknown op id answers ok:false and changes nothing', async () => {
    const b = await build();
    const a = await attentionOp(b);
    expect(await b.controller.retry('0192f0d6-0000-7000-8000-00000000ffff')).toMatchObject({ ok: false });
    await b.controller.refresh();
    expect(b.controller.getSnapshot().attention).toHaveLength(1);
    expect(a.op_id).toBeTruthy();
  });
});

describe('Discard (an audited operation sent at the next sync)', () => {
  it('rejects a blank reason before changing anything', async () => {
    const b = await build();
    const a = await attentionOp(b);
    for (const r of ['', '   ', '\n\t']) await expect(b.controller.discard(a.op_id, r)).rejects.toMatchObject({ code: 'offline.reason_required' });
    await b.controller.refresh();
    expect(b.controller.getSnapshot().attention).toHaveLength(1);
    expect(b.controller.getSnapshot().pending).toEqual([]);
  });
  it('removes the item from needs-attention and queues one discard operation naming it, with the trimmed reason', async () => {
    const b = await build();
    const a = await attentionOp(b, 1, 'sync.clock_skew_too_large');
    expect(await b.controller.discard(a.op_id, '  Entered twice by mistake ')).toMatchObject({ ok: true });
    const s = b.controller.getSnapshot();
    expect(s.attention).toEqual([]);
    expect(s.pending).toHaveLength(1);
    const d = s.pending[0]!;
    expect(d.op_type).toMatch(/discard/);
    expect(d.op_id).not.toBe(a.op_id);
    const body = JSON.stringify(d.payload);
    expect(body).toContain(a.op_id);
    expect(body).toContain('registration.create_order');
    expect(body).toContain('Entered twice by mistake');
    expect(body).not.toContain('  Entered');
  });
  it('the discard record carries no copy of the discarded payload: no personal data in the audit trail', async () => {
    const b = await build();
    const a = await attentionOp(b);
    await b.controller.discard(a.op_id, 'duplicate');
    const d = b.controller.getSnapshot().pending[0];
    for (const secret of [SECRET, 'Asha', '9800000000']) expect(JSON.stringify(d), secret).not.toContain(secret);
  });
  it('it travels in the next batch like any operation, once, and leaves the outbox when accepted', async () => {
    const b = await build();
    const a = await attentionOp(b);
    await b.controller.discard(a.op_id, 'duplicate');
    await b.controller.syncNow();
    const sent = b.server.batches.flatMap((x) => x.body.operations);
    expect(sent).toHaveLength(1);
    expect(sent[0].op_type).toMatch(/discard/);
    expect(JSON.stringify(sent[0].payload)).toContain(a.op_id);
    expect(b.controller.getSnapshot().pending).toEqual([]);
    await b.controller.syncNow();
    expect(b.server.batches).toHaveLength(1);
  });
  it('discarding while offline works and keeps the operation queued', async () => {
    const b = await build({ routes: { 'GET /v1/core/health/live': () => 'throw' } });
    const a = await attentionOp(b);
    await b.controller.discard(a.op_id, 'duplicate');
    await b.controller.syncNow();
    expect(posts(b, BATCH)).toHaveLength(0);
    expect(b.controller.getSnapshot().pending).toHaveLength(1);
  });
  it('the discard record is stored encrypted like every other operation', async () => {
    const b = await build();
    const a = await attentionOp(b);
    await b.controller.discard(a.op_id, 'Unique reason text 7731');
    expect(await rawDump(b.env.dbName)).not.toContain('Unique reason text 7731');
  });
  it('an unknown op id answers ok:false and queues nothing', async () => {
    const b = await build();
    expect(await b.controller.discard('0192f0d6-0000-7000-8000-00000000ffff', 'x')).toMatchObject({ ok: false });
    await b.controller.refresh();
    expect(b.controller.getSnapshot().pending).toEqual([]);
  });
});

describe('conflicts: load and resolve through the same resolve operation', () => {
  it('loadConflict reads both versions', async () => {
    const b = await build({ routes: { [`GET /v1/core/sync/conflicts/${CID}`]: () => ({ status: 200, body: { id: CID, local_payload: { phone: '1' }, server_payload: { phone: '2' }, status: 'open' } }) } });
    expect(await b.controller.loadConflict(CID)).toMatchObject({ local_payload: { phone: '1' }, server_payload: { phone: '2' } });
  });
  it('loadConflict is null on 404, a server error and a network failure', async () => {
    for (const r of [{ status: 404, body: { code: 'common.not_found' } }, { status: 500, body: {} }, 'throw' as const]) {
      const b = await build({ routes: { [`GET /v1/core/sync/conflicts/${CID}`]: () => r } });
      expect(await b.controller.loadConflict(CID)).toBeNull();
    }
  });
  it('resolve sends the documented request with an Idempotency-Key, and the conflict leaves the local list on success', async () => {
    const b = await build({ routes: { [`POST /v1/core/sync/conflicts/${CID}/resolve`]: () => ({ status: 200, body: { id: CID, status: 'resolved', resolution: 'keep_server' } }) } });
    await conflictOp(b);
    await b.controller.refresh();
    expect(b.controller.getSnapshot().conflicts).toHaveLength(1);
    const r = await b.controller.resolveConflict(CID, { resolution: 'keep_server', reason: 'Server copy is newer' });
    expect(r).toMatchObject({ ok: true });
    const [call] = posts(b, RESOLVE);
    expect(call!.path).toBe(`/v1/core/sync/conflicts/${CID}/resolve`);
    expect(call!.body).toEqual({ resolution: 'keep_server', reason: 'Server copy is newer' });
    expect(call!.headers['idempotency-key']).toBeTruthy();
    expect(call!.headers['idempotency-key']!.length).toBeGreaterThanOrEqual(16);
    expect(b.controller.getSnapshot().conflicts).toEqual([]);
    expect(await b.outbox.conflicts()).toEqual([]);
  });
  it('merge sends merged_payload as is', async () => {
    const b = await build({ routes: { [`POST /v1/core/sync/conflicts/${CID}/resolve`]: () => ({ status: 200, body: { id: CID, status: 'resolved' } }) } });
    await conflictOp(b);
    await b.controller.resolveConflict(CID, { resolution: 'merge', reason: 'Phone from device', merged_payload: { phone: '1', city: 'Pune' } });
    expect(posts(b, RESOLVE)[0]!.body).toEqual({ resolution: 'merge', reason: 'Phone from device', merged_payload: { phone: '1', city: 'Pune' } });
  });
  it('refuses wrong input before any request', async () => {
    const b = await build();
    await conflictOp(b);
    await expect(b.controller.resolveConflict(CID, { resolution: 'keep_server', reason: '  ' })).rejects.toMatchObject({ code: 'offline.reason_required' });
    await expect(b.controller.resolveConflict(CID, { resolution: 'merge', reason: 'x' })).rejects.toMatchObject({ code: 'offline.merged_payload_required' });
    await expect(b.controller.resolveConflict(CID, { resolution: 'apply_local', reason: 'x', merged_payload: { a: 1 } })).rejects.toMatchObject({ code: 'offline.merged_payload_not_allowed' });
    await expect(b.controller.resolveConflict(CID, { resolution: 'keep_server', reason: 'x'.repeat(1001) })).rejects.toBeTruthy();
    expect(posts(b, RESOLVE)).toHaveLength(0);
  });
  it('sync.entity_changed (409) is reported with its code and the conflict stays', async () => {
    const b = await build({ routes: { [`POST /v1/core/sync/conflicts/${CID}/resolve`]: () => ({ status: 409, body: { code: 'sync.entity_changed' } }) } });
    await conflictOp(b);
    const r = await b.controller.resolveConflict(CID, { resolution: 'keep_server', reason: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'sync.entity_changed' });
    expect(await b.outbox.conflicts()).toHaveLength(1);
  });
  it('a network failure or a server error is ok:false and the conflict stays', async () => {
    for (const r of ['throw' as const, { status: 500, body: { code: 'common.internal' } }]) {
      const b = await build({ routes: { [`POST /v1/core/sync/conflicts/${CID}/resolve`]: () => r } });
      await conflictOp(b);
      expect(await b.controller.resolveConflict(CID, { resolution: 'keep_server', reason: 'x' })).toMatchObject({ ok: false });
      expect(await b.outbox.conflicts()).toHaveLength(1);
    }
  });
  it('a second resolution of an already resolved conflict (common.immutable_record) is reported with its code', async () => {
    const b = await build({ routes: { [`POST /v1/core/sync/conflicts/${CID}/resolve`]: () => ({ status: 409, body: { code: 'common.immutable_record' } }) } });
    await conflictOp(b);
    const r = await b.controller.resolveConflict(CID, { resolution: 'keep_server', reason: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'common.immutable_record' });
  });
});

describe('unlock, set up and change of the PIN through the controller', () => {
  it('unlock: wrong PIN reports the attempts left, the right one unlocks and fills the lists', async () => {
    const b = await build();
    await b.outbox.append(orderOp(1));
    b.env.store.lock();
    await b.controller.refresh();
    expect(b.controller.getSnapshot().storeState).toBe('locked');
    expect(await b.controller.unlock('000000')).toMatchObject({ ok: false, reason: 'wrong_pin', attemptsLeft: 9 });
    expect(b.controller.getSnapshot().storeState).toBe('locked');
    expect(await b.controller.unlock(PIN)).toMatchObject({ ok: true });
    expect(b.controller.getSnapshot().storeState).toBe('unlocked');
    expect(b.controller.getSnapshot().pending).toHaveLength(1);
  });
  it('setupPin on an empty store sets the PIN and leaves the user unlocked', async () => {
    const env = await newStore();
    const server = fakeServer();
    const { engine, outbox } = await newEngine(env as never, server);
    const { createConnectivity } = await import('@/core/offline/connectivity');
    const connectivity = createConnectivity({ fetch: server.fetch, now: env.c.now, deviceId: DEVICE });
    const { createOfflineController } = await import('@/core/offline/controller');
    const controller = createOfflineController({ store: env.store, outbox, engine, connectivity, fetch: server.fetch, deviceId: DEVICE, userId: USER, now: env.c.now, permissions: PERMS } as never);
    await controller.refresh();
    expect(controller.getSnapshot().storeState).toBe('empty');
    expect(await controller.setupPin('2468')).toMatchObject({ ok: true });
    expect(env.store.isUnlocked()).toBe(true);
    expect(controller.getSnapshot().storeState).toBe('unlocked');
    env.store.lock();
    expect(await env.store.unlock('2468')).toEqual({ ok: true });
  });
  it('changePin through the controller swaps the PIN', async () => {
    const b = await build();
    expect(await b.controller.changePin(PIN, '2468')).toMatchObject({ ok: true });
    b.env.store.lock();
    expect(await b.env.store.unlock(PIN)).toMatchObject({ ok: false, reason: 'wrong_pin' });
    expect(await b.env.store.unlock('2468')).toMatchObject({ ok: true });
  });
});

describe('store.changePin', () => {
  it('re-wraps the same data key: records written before still open with the new PIN; the old PIN stops working', async () => {
    const env = await unlockedStore();
    await env.store.put('meta', 'k1', { hello: 'world' });
    const r = await env.store.changePin(PIN, '2468');
    expect(r).toEqual({ ok: true });
    env.store.lock();
    expect(await env.store.unlock(PIN)).toMatchObject({ ok: false, reason: 'wrong_pin' });
    expect(await env.store.unlock('2468')).toEqual({ ok: true });
    expect(await env.store.get('meta', 'k1')).toEqual({ hello: 'world' });
  });
  it('works while the store is locked; survives a reopen', async () => {
    const env = await unlockedStore();
    await env.store.put('meta', 'k1', { n: 1 });
    env.store.lock();
    expect(await env.store.changePin(PIN, '2468')).toEqual({ ok: true });
    env.store.close();
    const again = await env.reopen();
    expect(await again.unlock('2468')).toEqual({ ok: true });
    expect(await again.get('meta', 'k1')).toEqual({ n: 1 });
  });
  it('a wrong old PIN changes nothing, reports the attempts left and counts as an attempt', async () => {
    const env = await unlockedStore();
    const r = await env.store.changePin('000000', '2468');
    expect(r).toMatchObject({ ok: false, reason: 'wrong_pin', attemptsLeft: 9 });
    env.store.lock();
    expect(await env.store.unlock(PIN)).toEqual({ ok: true });
  });
  it('wrong old PINs count towards the wipe limit', async () => {
    const env = await unlockedStore({ maxPinFailures: 3 });
    await env.store.put('meta', 'k1', { n: 1 });
    expect(await env.store.changePin('1', '2468')).toMatchObject({ ok: false, reason: 'wrong_pin' });
    expect(await env.store.changePin('2', '2468')).toMatchObject({ ok: false, reason: 'wrong_pin' });
    expect(await env.store.changePin('3', '2468')).toMatchObject({ ok: false, reason: 'wiped' });
    expect((await env.store.status()).state).toBe('wiped');
  });
  it('an empty new PIN is refused and the old one still works', async () => {
    const env = await unlockedStore();
    await expect(env.store.changePin(PIN, '')).rejects.toMatchObject({ code: 'offline.pin_required' });
    env.store.lock();
    expect(await env.store.unlock(PIN)).toEqual({ ok: true });
  });
  it('an empty or wiped store has nothing to change', async () => {
    const empty = await newStore();
    expect(await empty.store.changePin(PIN, '2468')).toMatchObject({ ok: false, reason: 'not_setup' });
    const wiped = await unlockedStore();
    await wiped.store.wipe();
    expect(await wiped.store.changePin(PIN, '2468')).toMatchObject({ ok: false, reason: 'wiped' });
  });
  it('the PIN is not stored anywhere readable', async () => {
    const env = await unlockedStore();
    await env.store.changePin(PIN, '97531864');
    const dump = await rawDump(env.dbName);
    expect(dump).not.toContain('97531864');
    expect(dump).not.toContain(PIN);
  });
});

