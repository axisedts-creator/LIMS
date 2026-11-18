// T0D-OFFLINE-1 (LD-322 decision 4; offline design section 6): encrypted local store on raw IndexedDB + WebCrypto.
// Every record is AES-GCM 256 with a fresh random IV, bound to (store, key) as additional data, under a NON-extractable
// data key. The data key is wrapped (AES-KW) by a key derived from the PIN with PBKDF2-SHA256 at 600000 iterations.
// 10 wrong PINs wipe the store; the failure counter is persisted and charged BEFORE the PIN is checked, so parallel
// tabs or a reload never earn extra guesses. Retention: unlock is refused 14 days after the last online sign in.

export const PBKDF2_ITERATIONS = 600_000;
export const MAX_PIN_FAILURES = 10;
export const RETENTION_DAYS = 14;
const DAY_MS = 86_400_000;
const DB_VERSION = 1;

export type DataStoreName = 'refdata' | 'counters' | 'meta';
export type StoreName = DataStoreName | 'outbox' | 'attention' | 'conflicts' | 'mappings';
const SEALED: StoreName[] = ['refdata', 'counters', 'meta', 'outbox', 'attention', 'conflicts', 'mappings'];
const ALL = [...SEALED, 'keyring', 'state'];

export type StoreState = 'empty' | 'locked' | 'unlocked' | 'wiped' | 'revoked';
export type UnlockResult =
  | { ok: true }
  | { ok: false; reason: 'wrong_pin'; attemptsLeft: number }
  | { ok: false; reason: 'wiped' | 'revoked' | 'expired' | 'not_setup' };

/** A record as it sits in IndexedDB: only the key and the ciphertext. */
export interface SealedRecord { k: string; iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer; [extra: string]: unknown }
interface StateRecord { k: 'state'; status: 'set' | 'wiped' | 'revoked'; failed: number; signedInAt?: number; userId?: string }
interface KeyringRecord { k: 'keyring'; salt: Uint8Array<ArrayBuffer>; wrapped: ArrayBuffer; iterations: number }

export class OfflineError extends Error {
  constructor(public code: string, message = code) { super(message); this.name = 'OfflineError'; }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function openDb(name: string): Promise<IDBDatabase> {
  const r = indexedDB.open(name, DB_VERSION);
  r.onupgradeneeded = () => { for (const s of ALL) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'k' }); };
  return req(r);
}

export interface OpenOptions { dbName?: string; now?: () => number; retentionDays?: number; maxPinFailures?: number }

export async function openOfflineStore(o: OpenOptions = {}) {
  const db = await openDb(o.dbName ?? 'lims-offline');
  const now = o.now ?? Date.now;
  const retentionMs = (o.retentionDays ?? RETENTION_DAYS) * DAY_MS;
  const maxFailures = o.maxPinFailures ?? MAX_PIN_FAILURES;
  let key: CryptoKey | null = null;

  /** One transaction; `fn` must only queue requests (no awaits on non-IDB work). A throw aborts every write in it. */
  function transact<T>(stores: string[], mode: IDBTransactionMode, fn: (s: (name: string) => IDBObjectStore) => T | Promise<T>): Promise<T> {
    return new Promise<T>((res, rej) => {
      const t = db.transaction(stores, mode);
      let out: T;
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error ?? new OfflineError('offline.aborted'));
      Promise.resolve().then(() => fn((n) => t.objectStore(n))).then((v) => { out = v; }, (e) => { try { t.abort(); } catch { /* already finished */ } rej(e); });
    });
  }
  const readState = () => transact(['state'], 'readonly', (s) => req(s('state').get('state'))) as Promise<StateRecord | undefined>;
  const writeState = (st: StateRecord) => transact(['state'], 'readwrite', (s) => { s('state').put(st); });

  function needKey(): CryptoKey { if (!key) throw new OfflineError('offline.locked'); return key; }
  const aad = (store: string, k: string) => enc.encode(store + '\u0000' + k);

  async function encryptRecord(store: StoreName, k: string, value: unknown, extra: Record<string, unknown> = {}): Promise<SealedRecord> {
    const ck = needKey();
    const json = JSON.stringify(value); // throws on BigInt / cycles before anything is written
    if (json === undefined) throw new OfflineError('offline.unserialisable');
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(store, k) }, ck, enc.encode(json));
    return { ...extra, k, iv, ct };
  }
  async function decryptRecord<T>(store: StoreName, r: SealedRecord): Promise<T> {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: r.iv, additionalData: aad(store, r.k) }, needKey(), r.ct);
    return JSON.parse(dec.decode(pt)) as T;
  }

  async function kek(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
    const base = await subtle().importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  }

  async function wipe(reason: 'wiped' | 'revoked' | string = 'wiped') {
    key = null;
    const status = reason === 'revoked' ? 'revoked' : 'wiped';
    await transact(ALL, 'readwrite', (s) => {
      for (const n of [...SEALED, 'keyring']) s(n).clear();
      s('state').put({ k: 'state', status, failed: 0 } satisfies StateRecord);
    });
  }

  const expired = (st: StateRecord) => st.signedInAt === undefined || now() - st.signedInAt >= retentionMs;

  /** One PIN attempt (unlock and changePin): charged first (atomic read-modify-write), then the data key is unwrapped. */
  async function attempt(pin: string, extractable: boolean): Promise<{ ok: true; dataKey: CryptoKey } | Exclude<UnlockResult, { ok: true }>> {
    const st = await readState();
    if (!st) return { ok: false, reason: 'not_setup' };
    if (st.status === 'wiped' || st.status === 'revoked') return { ok: false, reason: st.status };
    if (expired(st)) return { ok: false, reason: 'expired' };
    const failed = await transact(['state'], 'readwrite', async (s) => {
      const cur = (await req(s('state').get('state'))) as StateRecord;
      const f = cur.failed + 1;
      s('state').put({ ...cur, failed: f });
      return f;
    });
    // limit already reached by an earlier attempt interrupted before its wipe (reload mid derive): wipe now, never check the PIN
    if (failed > maxFailures) { await wipe('wiped'); return { ok: false, reason: 'wiped' }; }
    const kr = (await transact(['keyring'], 'readonly', (s) => req(s('keyring').get('keyring')))) as KeyringRecord | undefined;
    let dataKey: CryptoKey | null = null;
    if (kr) {
      try {
        dataKey = await subtle().unwrapKey('raw', kr.wrapped, await kek(String(pin), kr.salt, kr.iterations), 'AES-KW', { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
      } catch { dataKey = null; }
    }
    if (dataKey) {
      await transact(['state'], 'readwrite', async (s) => { const cur = (await req(s('state').get('state'))) as StateRecord; s('state').put({ ...cur, failed: 0 }); });
      return { ok: true, dataKey };
    }
    if (failed >= maxFailures || !kr) { await wipe('wiped'); return { ok: false, reason: 'wiped' }; }
    return { ok: false, reason: 'wrong_pin', attemptsLeft: maxFailures - failed };
  }

  const store = {
    /** Online sign in: set the PIN of a fresh (empty or wiped) store. A set-up store keeps its key: use markOnlineSignIn. */
    async setupPin(pin: string, ctx: { userId: string }) {
      if (typeof pin !== 'string' || pin.length === 0) throw new OfflineError('offline.pin_required');
      const st = await readState();
      if (st?.status === 'revoked') throw new OfflineError('offline.revoked');
      if (st?.status === 'set') throw new OfflineError('offline.already_setup');
      const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const dataKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const wrapped = await subtle().wrapKey('raw', dataKey, await kek(pin, salt, PBKDF2_ITERATIONS), 'AES-KW');
      key = null;
      await transact(ALL, 'readwrite', (s) => {
        for (const n of SEALED) s(n).clear();
        s('keyring').put({ k: 'keyring', salt, wrapped, iterations: PBKDF2_ITERATIONS } satisfies KeyringRecord);
        s('state').put({ k: 'state', status: 'set', failed: 0, signedInAt: now(), userId: ctx.userId } satisfies StateRecord);
      });
    },
    async markOnlineSignIn() {
      const st = await readState();
      if (st?.status !== 'set') throw new OfflineError('offline.not_setup');
      await writeState({ ...st, signedInAt: now() });
    },
    async unlock(pin: string): Promise<UnlockResult> {
      const r = await attempt(pin, false);
      if (!r.ok) return r;
      key = r.dataKey;
      return { ok: true };
    },
    /** T0D-OFFLINE-2: an attempt like unlock (a wrong old PIN is charged); on success the SAME data key is wrapped again under
     *  the new PIN with a new salt, so no record is re-encrypted. Works locked or unlocked; the lock state does not change. */
    async changePin(oldPin: string, newPin: string): Promise<UnlockResult> {
      if (typeof newPin !== 'string' || newPin.length === 0) throw new OfflineError('offline.pin_required');
      const r = await attempt(oldPin, true);
      if (!r.ok) return r;
      const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const wrapped = await subtle().wrapKey('raw', r.dataKey, await kek(newPin, salt, PBKDF2_ITERATIONS), 'AES-KW');
      await transact(['keyring'], 'readwrite', (s) => { s('keyring').put({ k: 'keyring', salt, wrapped, iterations: PBKDF2_ITERATIONS } satisfies KeyringRecord); });
      return { ok: true };
    },
    lock() { key = null; },
    isUnlocked: () => key !== null,
    async status(): Promise<{ state: StoreState; failedAttempts: number }> {
      const st = await readState();
      if (!st) return { state: 'empty', failedAttempts: 0 };
      if (st.status !== 'set') return { state: st.status, failedAttempts: 0 };
      return { state: key ? 'unlocked' : 'locked', failedAttempts: st.failed };
    },
    async userId() { return (await readState())?.userId; },
    async put(name: DataStoreName, k: string, value: unknown) {
      const rec = await encryptRecord(name, k, value);
      await transact([name], 'readwrite', (s) => { s(name).put(rec); });
    },
    async get<T = unknown>(name: DataStoreName, k: string): Promise<T | undefined> {
      needKey();
      const rec = (await transact([name], 'readonly', (s) => req(s(name).get(k)))) as SealedRecord | undefined;
      return rec ? decryptRecord<T>(name, rec) : undefined;
    },
    async remove(name: DataStoreName, k: string) {
      needKey();
      await transact([name], 'readwrite', (s) => { s(name).delete(k); });
    },
    async keys(name: DataStoreName): Promise<string[]> {
      needKey();
      return (await transact([name], 'readonly', (s) => req(s(name).getAllKeys()))) as string[];
    },
    wipe,
    markRevoked: () => wipe('revoked'),
    /** Wipes when the retention window has passed; true when it wiped. */
    async purgeExpired(): Promise<boolean> {
      const st = await readState();
      if (st?.status !== 'set' || !expired(st)) return false;
      await wipe('wiped');
      return true;
    },
    close() { key = null; db.close(); },
    // used by outbox.ts only: one transaction for an operation and the local change it belongs to
    encryptRecord, decryptRecord, transact,
  };
  return store;
}

export type OfflineStore = Awaited<ReturnType<typeof openOfflineStore>>;
