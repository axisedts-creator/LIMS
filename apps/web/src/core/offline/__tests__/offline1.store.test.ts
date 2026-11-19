// T0D-OFFLINE-1 (LD-322; design file section 6): encrypted local store, PIN, wipe, retention, outbox atomicity.
import { describe, expect, it, vi } from 'vitest';
import { PIN, USER, days, newStore, unlockedStore, newOutbox, orderOp, rawDump, rawCounts } from './offline1.helpers';

const SECRET = 'PATIENT-SENTINEL-Sita-Rai-9841000000';

describe('encrypted store (AES-GCM 256, per-record IV, non-extractable key)', () => {
  it('round-trips records through every store and never writes plaintext to IndexedDB', async () => {
    const { store, dbName } = await unlockedStore();
    await store.put('refdata', 'patient:1', { name: SECRET, phone: '+9779841000000' });
    await store.put('counters', 'lab_code', { next: 42 });
    await store.put('meta', 'last_pull', { at: 'yesterday', who: SECRET });
    expect(await store.get('refdata', 'patient:1')).toEqual({ name: SECRET, phone: '+9779841000000' });
    expect(await store.get('counters', 'lab_code')).toEqual({ next: 42 });
    expect(await store.get('refdata', 'missing')).toBeUndefined();
    const dump = await rawDump(dbName);
    expect(dump).not.toContain('Sita');
    expect(dump).not.toContain('9841000000');
    expect(dump).not.toContain('lab_code":{"next"');
    expect(dump).not.toContain(PIN);
  });

  it('uses a random IV per record: the same value under two keys gives different stored bytes', async () => {
    const { store, dbName } = await unlockedStore();
    await store.put('refdata', 'a', { v: SECRET });
    const one = await rawDump(dbName);
    await store.put('refdata', 'b', { v: SECRET });
    const two = await rawDump(dbName);
    expect(two).not.toBe(one);
    // a re-put of the same key with the same value must also change the ciphertext (fresh IV every write)
    await store.put('refdata', 'a', { v: SECRET });
    expect(await rawDump(dbName)).not.toBe(two);
  });

  it('encrypts with AES-GCM 256 under a NON-extractable CryptoKey, derived with PBKDF2-SHA256 >= 600000 iterations', async () => {
    const encKeys: CryptoKey[] = [];
    const subtle = crypto.subtle;
    const realEncrypt = subtle.encrypt.bind(subtle);
    vi.spyOn(subtle, 'encrypt').mockImplementation(((alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => { encKeys.push(key); return realEncrypt(alg, key, data); }) as typeof subtle.encrypt);
    const pbkdf: Array<{ name: string; hash?: unknown; iterations?: number }> = [];
    const realDeriveKey = subtle.deriveKey.bind(subtle); const realDeriveBits = subtle.deriveBits.bind(subtle);
    vi.spyOn(subtle, 'deriveKey').mockImplementation(((alg: any, ...rest: any[]) => { pbkdf.push(alg); return (realDeriveKey as any)(alg, ...rest); }) as any);
    vi.spyOn(subtle, 'deriveBits').mockImplementation(((alg: any, ...rest: any[]) => { pbkdf.push(alg); return (realDeriveBits as any)(alg, ...rest); }) as any);
    const { store } = await unlockedStore();
    await store.put('refdata', 'k', { v: 1 });
    expect(encKeys.length).toBeGreaterThan(0);
    for (const k of encKeys) {
      expect(k.algorithm.name).toBe('AES-GCM');
      expect((k.algorithm as AesKeyAlgorithm).length).toBe(256);
      expect(k.extractable).toBe(false);
    }
    expect(pbkdf.length).toBeGreaterThan(0);
    for (const a of pbkdf) {
      expect(a.name).toBe('PBKDF2');
      expect(JSON.stringify(a.hash)).toContain('SHA-256');
      expect(a.iterations).toBeGreaterThanOrEqual(600_000);
    }
  });

  it('refuses reads and writes while locked, and a lock drops the in-memory key', async () => {
    const { store } = await unlockedStore();
    await store.put('refdata', 'k', { v: 1 });
    store.lock();
    expect(store.isUnlocked()).toBe(false);
    await expect(store.get('refdata', 'k')).rejects.toMatchObject({ code: 'offline.locked' });
    await expect(store.put('refdata', 'k2', { v: 2 })).rejects.toMatchObject({ code: 'offline.locked' });
    expect(await store.unlock(PIN)).toEqual({ ok: true });
    expect(await store.get('refdata', 'k')).toEqual({ v: 1 });
  });

  it('data survives a reload (second open of the same database) and unlocks with the same PIN', async () => {
    const { store, reopen } = await unlockedStore();
    await store.put('meta', 'device', { id: 'd1' });
    const again = await reopen();
    expect(again.isUnlocked()).toBe(false);
    expect(await again.unlock(PIN)).toEqual({ ok: true });
    expect(await again.get('meta', 'device')).toEqual({ id: 'd1' });
  });
});

describe('PIN failures wipe the store', () => {
  it('wrong PIN is refused with attemptsLeft counting down, the right PIN still works and resets the count', async () => {
    const { store } = await unlockedStore();
    store.lock();
    const r = await store.unlock('000000');
    expect(r).toMatchObject({ ok: false, reason: 'wrong_pin', attemptsLeft: 9 });
    expect(await store.unlock('111111')).toMatchObject({ ok: false, reason: 'wrong_pin', attemptsLeft: 8 });
    expect(await store.unlock(PIN)).toEqual({ ok: true });
    store.lock();
    expect(await store.unlock('222222')).toMatchObject({ reason: 'wrong_pin', attemptsLeft: 9 });
  });

  it('the failure counter is persisted: reloading the page does not give the attacker a fresh 10', async () => {
    const { store, reopen } = await unlockedStore();
    store.lock();
    for (let i = 0; i < 3; i++) await store.unlock('bad-pin-' + i);
    const again = await reopen();
    expect(await again.unlock('bad-pin-x')).toMatchObject({ reason: 'wrong_pin', attemptsLeft: 6 });
  });

  it('10 wrong PINs wipe every store (raw IndexedDB is empty) and the outbox is gone; the 11th attempt, even with the right PIN, is refused', async () => {
    const env = await unlockedStore();
    const { store, dbName } = env;
    await store.put('refdata', 'patient:1', { name: SECRET });
    const outbox = await newOutbox(env);
    await outbox.append(orderOp(1));
    store.lock();
    let last: any;
    for (let i = 0; i < 10; i++) last = await store.unlock('wrong-' + i);
    expect(last).toMatchObject({ ok: false, reason: 'wiped' });
    const counts = await rawCounts(dbName);
    const meaningful = Object.entries(counts).filter(([, c]) => c > 0).map(([name]) => name);
    expect(meaningful.every((n) => /^(tombstone|keyring|state)$/i.test(n)), 'only a tombstone/state marker may survive, found: ' + meaningful).toBe(true);
    const dump = await rawDump(dbName);
    expect(dump).not.toContain('Sita');
    expect(await store.unlock(PIN)).toMatchObject({ ok: false, reason: 'wiped' });
    expect((await store.status()).state).toBe('wiped');
  });

  it('a 10th attempt interrupted before its wipe (persisted counter already 10) cannot be used to keep guessing: the next unlock, even with the right PIN, wipes', async () => {
    const { store, dbName, reopen } = await unlockedStore();
    await store.put('refdata', 'patient:1', { name: SECRET });
    store.lock();
    for (let i = 0; i < 9; i++) await store.unlock('wrong-' + i);
    // simulate the page closing after the counter was charged to 10 but before the wipe ran
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open(dbName); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise<void>((res, rej) => {
      const t = db.transaction('state', 'readwrite');
      const os = t.objectStore('state');
      const g = os.get('state');
      g.onsuccess = () => { os.put({ ...g.result, failed: 10 }); };
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
    db.close();
    const again = await reopen();
    expect(await again.unlock(PIN)).toMatchObject({ ok: false, reason: 'wiped' });
    expect((await again.status()).state).toBe('wiped');
    expect(await rawDump(dbName)).not.toContain('Sita');
  });
});

describe('retention window (default 14 days since the last online sign in)', () => {
  it('unlock works inside the window; after 14 days it is refused with reason expired', async () => {
    const { store, c } = await unlockedStore();
    store.lock();
    c.advance(days(13));
    expect(await store.unlock(PIN)).toEqual({ ok: true });
    store.lock();
    c.advance(days(2)); // 15 days after the sign in
    expect(await store.unlock(PIN)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('purgeExpired wipes an expired store and leaves a fresh one alone; a new online sign in restarts the window', async () => {
    const env = await unlockedStore();
    const { store, c, dbName } = env;
    await store.put('refdata', 'patient:1', { name: SECRET });
    c.advance(days(10));
    expect(await store.purgeExpired()).toBe(false);
    expect(await store.get('refdata', 'patient:1')).toEqual({ name: SECRET });
    await store.markOnlineSignIn();
    c.advance(days(10)); // 20 days since setup but 10 since the last online sign in
    store.lock();
    expect(await store.unlock(PIN)).toEqual({ ok: true });
    c.advance(days(5)); // 15 days since the last online sign in
    expect(await store.purgeExpired()).toBe(true);
    expect(await rawDump(dbName)).not.toContain('Sita');
    expect((await store.status()).state).toBe('wiped');
  });

  it('a retention of 7 days configured at open time is honoured', async () => {
    const { store, c } = await unlockedStore({ retentionDays: 7 });
    store.lock();
    c.advance(days(8));
    expect(await store.unlock(PIN)).toMatchObject({ reason: 'expired' });
  });
});

describe('misc states', () => {
  it('an empty database reports empty and unlock gives not_setup; an empty PIN is refused (PIN length rules are a founder decision, not tested)', async () => {
    const { store } = await newStore();
    expect((await store.status()).state).toBe('empty');
    expect(await store.unlock(PIN)).toMatchObject({ ok: false, reason: 'not_setup' });
    await expect(store.setupPin('', { userId: USER })).rejects.toBeTruthy();
  });

  it('markRevoked wipes and every later unlock says revoked', async () => {
    const { store, dbName } = await unlockedStore();
    await store.put('refdata', 'patient:1', { name: SECRET });
    await store.markRevoked();
    expect(await store.unlock(PIN)).toMatchObject({ ok: false, reason: 'revoked' });
    expect((await store.status()).state).toBe('revoked');
    expect(await rawDump(dbName)).not.toContain('Sita');
  });
});

describe('outbox append is atomic with the local state change (one IndexedDB transaction)', () => {
  it('happy path: the operation and the local change are both there, written in exactly one readwrite transaction', async () => {
    const env = await unlockedStore();
    const outbox = await newOutbox(env);
    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const op = await outbox.append(orderOp(1), [{ store: 'refdata', key: 'order:1', value: { id: 'o1' } }]);
    const rw = txSpy.mock.calls.filter((c) => c[1] === 'readwrite');
    expect(rw.length).toBe(1);
    txSpy.mockRestore();
    expect((await outbox.pending()).map((o) => o.op_id)).toEqual([op.op_id]);
    expect(await env.store.get('refdata', 'order:1')).toEqual({ id: 'o1' });
  });

  it('crash between the two writes: neither the operation nor the local change survives', async () => {
    const env = await unlockedStore();
    const outbox = await newOutbox(env);
    let writes = 0;
    for (const m of ['put', 'add'] as const) {
      const real = IDBObjectStore.prototype[m];
      vi.spyOn(IDBObjectStore.prototype, m).mockImplementation(function (this: IDBObjectStore, ...a: any[]) {
        if (++writes === 2) throw new Error('simulated crash');
        return (real as any).apply(this, a);
      } as any);
    }
    await expect(outbox.append(orderOp(2), [{ store: 'refdata', key: 'order:2', value: { id: 'o2' } }])).rejects.toBeTruthy();
    vi.restoreAllMocks();
    expect(await outbox.pending()).toEqual([]);
    expect(await env.store.get('refdata', 'order:2')).toBeUndefined();
  });

  it('an unserialisable local change fails the whole append: no orphan operation', async () => {
    const env = await unlockedStore();
    const outbox = await newOutbox(env);
    await expect(outbox.append(orderOp(3), [{ store: 'refdata', key: 'bad', value: { n: 10n } as never }])).rejects.toBeTruthy();
    expect(await outbox.pending()).toEqual([]);
  });

  it('append refuses while the store is locked', async () => {
    const env = await unlockedStore();
    const outbox = await newOutbox(env);
    env.store.lock();
    await expect(outbox.append(orderOp(4))).rejects.toMatchObject({ code: 'offline.locked' });
  });
});

describe('operation shape', () => {
  it('op_id is a time ordered UUID (v7), strictly increasing even inside one millisecond; fields match the sync contract', async () => {
    const env = await unlockedStore();
    const outbox = await newOutbox(env);
    const ops = [];
    for (let i = 0; i < 6; i++) ops.push(await outbox.append({ ...orderOp(i), base_version: 3, entity_id: 'e' + i }));
    for (const o of ops) {
      expect(o.op_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(o).toMatchObject({ op_type: 'registration.create_order', base_version: 3, device_id: expect.any(String), user_id: USER });
      expect(o.device_created_at).toMatch(/^2026-11-18T06:00:00\.000Z$/);
    }
    const ids = ops.map((o) => o.op_id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(6);
    expect((await outbox.pending()).map((o) => o.op_id)).toEqual(ids);
    env.c.advance(1000);
    const later = await outbox.append(orderOp(9));
    expect(later.op_id > ids[5]!).toBe(true);
    expect(later.device_created_at).toBe('2026-11-18T06:00:01.000Z');
  });
});
