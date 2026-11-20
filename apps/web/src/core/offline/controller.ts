// T0D-OFFLINE-2 (LD-322; offline design sections 4, 6, 8): the one controller behind the status chip, the Offline panel, the conflict
// inbox and the unlock overlay. Screens read getSnapshot() through useSyncExternalStore; every action refreshes it before it resolves.
// Discard is an audited operation sent at the next sync (CR: the closed op catalogue of core.yaml has no discard type yet).
import { createConnectivity, timedFetch, type Connectivity, type ConnState } from './connectivity';
import { pollDeviceStatus, registerDevice } from './device';
import { createSyncEngine, type SyncEngine } from './engine';
import { createOutbox, type AttentionItem, type ConflictItem, type Operation, type Outbox } from './outbox';
import { createPrefetcher, DEFAULT_CACHE_CAP_BYTES, type Prefetcher } from './prefetch';
import { OfflineError, openOfflineStore, type OfflineStore, type StoreState, type UnlockResult } from './store';
import { createOfflineFlows, type OfflineFlows } from './flows';
import { createNumbers, type BlockSeries, type Numbers } from './numbers';
import { createLabFlows } from './labflows';
import { createCashFlows } from './cashflows';

export const DISCARD_OP_TYPE = 'sync.discard';
export const MAX_REASON = 1000;
const RESOLUTIONS = ['keep_server', 'apply_local', 'merge'];

export interface OfflineSnapshot {
  conn: ConnState; storeState: StoreState; pending: Operation[]; attention: AttentionItem[]; conflicts: ConflictItem[];
  prefetch: { ready: boolean; fetchedAt: number | null; bytes: number; capBytes: number };
  skewFlag: boolean; now: number; permissions: readonly string[]; signedInUsers: number;
}
export interface ResolveBody { resolution: string; reason: string; merged_payload?: unknown }
interface Parts { outbox: Outbox; engine: SyncEngine; prefetcher?: Prefetcher | undefined; connectivity?: Connectivity; deviceId?: string | undefined; numbers?: Numbers; flows?: OfflineFlows }

export interface ControllerOptions {
  store: OfflineStore; connectivity: Connectivity; fetch?: typeof fetch; userId: string; permissions: readonly string[];
  outbox?: Outbox; engine?: SyncEngine; prefetcher?: Prefetcher; deviceId?: string; baseUrl?: string; now?: () => number; signedInUsers?: number;
  /** live wiring: builds outbox and engine once the store is open and the device id is known */
  attach?: () => Promise<Parts | null>;
}

const reject = (code: string) => Promise.reject(new OfflineError(code));

export function createOfflineController(o: ControllerOptions) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const now = o.now ?? Date.now;
  const base = o.baseUrl ?? '';
  let parts: Parts | null = o.outbox && o.engine ? { outbox: o.outbox, engine: o.engine, prefetcher: o.prefetcher, deviceId: o.deviceId } : null;
  const conn = () => parts?.connectivity ?? o.connectivity;
  const subs = new Set<() => void>();
  let snap: OfflineSnapshot = {
    conn: conn().state(), storeState: 'locked', pending: [], attention: [], conflicts: [],
    prefetch: { ready: false, fetchedAt: null, bytes: 0, capBytes: DEFAULT_CACHE_CAP_BYTES },
    skewFlag: false, now: now(), permissions: o.permissions, signedInUsers: o.signedInUsers ?? 1,
  };
  let seen = '';
  const publish = (next: OfflineSnapshot) => {
    const key = JSON.stringify(next);
    if (key === seen) return; // same object until something changes
    seen = key; snap = next;
    subs.forEach((l) => l());
  };
  const ready = () => { if (!parts || !o.store.isUnlocked()) throw new OfflineError('offline.locked'); return parts; };

  async function refresh(): Promise<void> {
    try {
      if (!parts && o.attach && o.store.isUnlocked()) parts = await o.attach().catch(() => null);
      const storeState = (await o.store.status()).state;
      const open = storeState === 'unlocked' && parts;
      const [pending, attention, conflicts, pf, usage] = open
        ? await Promise.all([parts!.outbox.pending(), parts!.outbox.needsAttention(), parts!.outbox.conflicts(),
          parts!.prefetcher?.status(), parts!.prefetcher?.usage()])
        : [[], [], [], undefined, undefined];
      publish({
        ...snap, conn: conn().state(), storeState, pending, attention, conflicts, now: now(), skewFlag: conn().skewFlag(),
        prefetch: { ready: pf?.ready ?? false, fetchedAt: pf?.fetchedAt ?? null, bytes: usage?.bytes ?? 0, capBytes: usage?.capBytes ?? DEFAULT_CACHE_CAP_BYTES },
      });
    } catch {
      publish({ ...snap, conn: conn().state(), pending: [], attention: [], conflicts: [], now: now() });
    }
  }
  const after = async <T>(v: T) => { await refresh(); return v; };

  const controller = {
    getSnapshot: () => snap,
    /** T0D-OFFLINE-3: the operation adapters once attached and unlocked, else null */
    flows: () => (parts?.flows && o.store.isUnlocked() ? parts.flows : null),
    subscribe(l: () => void) { subs.add(l); return () => { subs.delete(l); }; },
    refresh,
    async syncNow(): Promise<void> {
      const c = conn();
      if ((await c.check()) === 'online' && parts && o.store.isUnlocked()) {
        c.setSyncing(true);
        await refresh();
        try { await parts.engine.drain(); } catch { /* the next tick retries */ } finally { c.setSyncing(false); }
      }
      await refresh();
    },
    async retry(opId: string) {
      const p = ready();
      return after({ ok: (await p.outbox.release(opId)) !== null });
    },
    async discard(opId: string, reason: string) {
      const r = typeof reason === 'string' ? reason.trim() : '';
      if (!r) return reject('offline.reason_required');
      if (r.length > MAX_REASON) return reject('offline.reason_too_long');
      const p = ready();
      const item = (await p.outbox.needsAttention()).find((a) => a.op_id === opId);
      if (!item) return after({ ok: false });
      // the audit record names the operation; it never copies its payload (no personal data in the trail)
      const op = await p.outbox.release(opId, { op_type: DISCARD_OP_TYPE, payload: { discarded_op_id: opId, original_op_type: item.op_type, reason: r } });
      return after({ ok: op !== null });
    },
    async loadConflict(id: string): Promise<{ local_payload: unknown; server_payload: unknown } | null> {
      const res = await timedFetch(f, `${base}/v1/core/sync/conflicts/${encodeURIComponent(id)}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } }, 15_000);
      if (!res?.ok) return null;
      const b = (await res.json().catch(() => null)) as { local_payload?: unknown; server_payload?: unknown } | null;
      return b && 'local_payload' in b && 'server_payload' in b ? { local_payload: b.local_payload, server_payload: b.server_payload } : null;
    },
    async resolveConflict(id: string, body: ResolveBody): Promise<{ ok: boolean; code?: string }> {
      const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
      if (!RESOLUTIONS.includes(body?.resolution)) return reject('offline.resolution_invalid');
      if (!reason) return reject('offline.reason_required');
      if (reason.length > MAX_REASON) return reject('offline.reason_too_long');
      const merging = body.resolution === 'merge';
      if (merging && body.merged_payload === undefined) return reject('offline.merged_payload_required');
      if (!merging && body.merged_payload !== undefined) return reject('offline.merged_payload_not_allowed');
      const res = await timedFetch(f, `${base}/v1/core/sync/conflicts/${encodeURIComponent(id)}/resolve`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': globalThis.crypto.randomUUID() },
        body: JSON.stringify({ resolution: body.resolution, reason, ...(merging ? { merged_payload: body.merged_payload } : {}) }),
      }, 15_000);
      if (!res) return after({ ok: false });
      if (!res.ok) {
        const code = ((await res.json().catch(() => null)) as { code?: unknown } | null)?.code;
        return after(typeof code === 'string' ? { ok: false, code } : { ok: false });
      }
      try { await parts?.outbox.dropConflict(id); } catch { /* locked: the list catches up at the next refresh after unlock */ }
      return after({ ok: true });
    },
    async unlock(pin: string): Promise<UnlockResult> { return after(await o.store.unlock(pin)); },
    async setupPin(pin: string): Promise<{ ok: boolean }> {
      await o.store.setupPin(pin, { userId: o.userId });
      return after({ ok: (await o.store.unlock(pin)).ok });
    },
    changePin: (oldPin: string, newPin: string) => o.store.changePin(oldPin, newPin),
    /** background round (live wiring): sync, device status (revoke, remote wipe, clock skew), then the reference data prefetch */
    async tick(): Promise<void> {
      await controller.syncNow();
      const c = conn();
      if (c.state() === 'online' && parts?.deviceId) {
        const st = await c.refreshStatus().catch(() => null);
        if (st && st.device_status !== 'active') await pollDeviceStatus({ store: o.store, deviceId: parts.deviceId, baseUrl: base, fetch: f }).catch(() => undefined);
        if (o.store.isUnlocked()) await parts.prefetcher?.run();
        // T0D-OFFLINE-3 (LD-322 decision 1): top up the lab code and patient id blocks while online, from 20 percent left
        if (o.store.isUnlocked() && parts.numbers && o.permissions.includes('frontdesk.registration.create')) {
          for (const s of ['lab_code', 'patient_id'] as BlockSeries[]) if ((await parts.numbers.remaining(s)).warn) await parts.numbers.reserve(s).catch(() => undefined);
        }
      }
      await refresh();
    },
  };
  return controller;
}

export type OfflineController = ReturnType<typeof createOfflineController>;

const TICK_MS = 30_000;
const IDLE_MS = 30_000;

/** Browser wiring of the staff shell: opens the store, keeps the connection state fresh, drains the outbox and prefetches when idle.
 *  ponytail: one 30 s timer per tab; the engine's Web Lock keeps one batch in flight per device. */
export async function startLiveOffline(o: { userId: string; permissions: readonly string[]; appVersion?: string; baseUrl?: string }) {
  const store = await openOfflineStore();
  const baseUrl = o.baseUrl ?? '';
  let lastInput = 0;
  const onInput = () => { lastInput = Date.now(); };
  const connectivity = createConnectivity({ baseUrl });
  const controller = createOfflineController({
    store, connectivity, userId: o.userId, permissions: o.permissions, baseUrl,
    async attach() {
      const saved = await store.get<{ id: string }>('meta', 'device');
      const deviceId = saved?.id ?? (connectivity.state() === 'online' ? (await registerDevice({ store, baseUrl, deviceLabel: navigator.userAgent.slice(0, 60), appVersion: o.appVersion ?? 'web' })).id : null);
      if (!deviceId) return null;
      const c = createConnectivity({ baseUrl, deviceId });
      const outbox = createOutbox(store, { deviceId, userId: o.userId });
      const engine = createSyncEngine({ outbox, deviceId, baseUrl, onSyncing: (b) => c.setSyncing(b) });
      const prefetcher = createPrefetcher({ store, deviceId, baseUrl, permissions: o.permissions, isOnline: () => c.state() === 'online', isIdle: () => Date.now() - lastInput > IDLE_MS });
      const numbers = createNumbers({ store, deviceId, baseUrl });
      // T0D-OFFLINE-4 (LD-322): one flows object for the screens: part 1 flows, result entry / sign-off / print marker, daily cash close
      const flows = Object.assign(createOfflineFlows({ store, outbox, prefetcher, numbers, deviceId, permissions: o.permissions }),
        createLabFlows({ store, outbox, deviceId, userId: o.userId, permissions: o.permissions }), createCashFlows({ store, outbox, permissions: o.permissions }));
      await c.check();
      return { outbox, engine, prefetcher, connectivity: c, deviceId, numbers, flows };
    },
  });
  let signedIn = false; let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await controller.tick();
      const p = controller.getSnapshot();
      // the staff shell only renders behind a live session: an online load is an online sign in for the retention window
      if (p.conn === 'online' && (p.storeState === 'locked' || p.storeState === 'unlocked') && !signedIn) {
        signedIn = true;
        await store.markOnlineSignIn().catch(() => undefined);
      }
    } catch { /* never break the shell; the next tick retries */ } finally { running = false; }
  }
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  for (const e of ['pointerdown', 'keydown']) window.addEventListener(e, onInput, { passive: true });
  window.addEventListener('online', tick);
  void tick();
  return {
    controller,
    stop() {
      clearInterval(timer);
      for (const e of ['pointerdown', 'keydown']) window.removeEventListener(e, onInput);
      window.removeEventListener('online', tick);
      store.close();
    },
  };
}
