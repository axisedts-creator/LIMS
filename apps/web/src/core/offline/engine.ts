// T0D-OFFLINE-1 (LD-322 decision 5; offline design section 7): the sync engine client for pushSyncBatch.
// One batch in flight per device: Web Locks elect one leader tab; without Web Locks a BroadcastChannel claim decides.
// Batches hold at most 50 operations and 1 MB, in creation order. Failures back off exponentially with full jitter,
// capped at 5 minutes; Retry-After is honoured. An operation leaves the outbox only when its own result arrives.
import type { Operation, Outbox, Settlement } from './outbox';

export const MAX_BATCH_OPERATIONS = 50;
export const MAX_BATCH_BYTES = 1_048_576;
export const MAX_BACKOFF_MS = 300_000;
const LOCK_NAME = 'lims-offline-sync';
const WIRE_KEYS = ['op_id', 'op_type', 'base_version', 'entity_id', 'payload', 'device_created_at', 'reserved_numbers'] as const; // reserved_numbers: T0D-OFFLINE-3

/** Full jitter: uniform in [0, min(cap, base * 2^attempt)), cap never above 5 minutes. */
export function backoffDelayMs(attempt: number, cfg: { baseMs: number; maxMs: number }, random: () => number = Math.random): number {
  const cap = Math.min(cfg.maxMs, MAX_BACKOFF_MS);
  const ceiling = Math.min(cap, cfg.baseMs * 2 ** Math.min(Math.max(0, attempt), 40));
  return Math.floor(random() * ceiling);
}

interface LockManagerLike { request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => unknown): Promise<unknown> }
interface SyncResult { op_id: string; status: string; error_code?: string; conflict_id?: string; number_mappings?: Settlement['mappings'] }
export interface SyncOutcome { sent: number; settled: number; skipped?: 'backoff' | 'not_leader' | 'closed' | 'error' | undefined }

export interface EngineOptions {
  outbox: Outbox;
  fetch?: typeof fetch;
  deviceId: string;
  baseUrl?: string;
  now?: () => number;
  random?: () => number;
  locks?: LockManagerLike | null;
  channelName?: string;
  baseDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
  claimWindowMs?: number;
  onSyncing?: (busy: boolean) => void;
}

function retryAfterMs(h: string | null, now: number): number {
  if (!h) return 0;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - now) : 0;
}

function toWire(op: Operation) {
  const o: Record<string, unknown> = {};
  for (const k of WIRE_KEYS) if (op[k] !== undefined) o[k] = op[k];
  return o;
}

export function createSyncEngine(o: EngineOptions) {
  const fetchFn = o.fetch ?? globalThis.fetch.bind(globalThis);
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const locks = o.locks === undefined ? ((globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks ?? null) : o.locks;
  const cfg = { baseMs: o.baseDelayMs ?? 1000, maxMs: o.maxDelayMs ?? MAX_BACKOFF_MS };
  const timeoutMs = o.requestTimeoutMs ?? 30_000;
  const enc = new TextEncoder();
  let attempt = 0; let nextAt: number | null = null; let closed = false;
  let flight: Promise<SyncOutcome> | null = null;

  // BroadcastChannel fallback: every contender posts a claim, waits a short window, and the lowest (time, id) wins.
  // A tab that is already sending answers 'busy' to late claims. ponytail: best effort only; Web Locks is the real guard.
  const me = globalThis.crypto.randomUUID();
  let channel: BroadcastChannel | null = null; let sending = false;
  let claim: { t: number; id: string; lost: boolean } | null = null;
  if (!locks && typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(o.channelName ?? LOCK_NAME);
    channel.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; t?: number; id?: string };
      if (m?.type === 'claim') {
        if (sending) channel?.postMessage({ type: 'busy' });
        else if (claim && (m.t! < claim.t || (m.t === claim.t && m.id! < claim.id))) claim.lost = true;
      } else if (m?.type === 'busy' && claim) claim.lost = true;
    };
  }
  async function asLeader(run: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
    if (locks) return (await locks.request(LOCK_NAME, { ifAvailable: true }, (l) => (l ? run() : { sent: 0, settled: 0, skipped: 'not_leader' }))) as SyncOutcome;
    if (!channel) return run();
    claim = { t: now(), id: me, lost: false };
    channel.postMessage({ type: 'claim', t: claim.t, id: me });
    await new Promise((r) => setTimeout(r, o.claimWindowMs ?? 50));
    const lost = claim.lost; claim = null;
    if (lost) return { sent: 0, settled: 0, skipped: 'not_leader' };
    sending = true;
    try { return await run(); } finally { sending = false; }
  }

  function fail(retryAfter = 0): SyncOutcome {
    nextAt = now() + Math.max(backoffDelayMs(attempt, cfg, random), retryAfter);
    attempt++;
    return { sent: 0, settled: 0, skipped: 'error' };
  }

  async function post(body: string): Promise<Response> {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_r, rej) => { timer = setTimeout(() => { ac?.abort(); rej(new Error('timeout')); }, timeoutMs); });
    try {
      return await Promise.race([fetchFn(`${o.baseUrl ?? ''}/v1/core/sync/batches`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, credentials: 'same-origin', signal: ac?.signal ?? null,
      }), timeout]);
    } finally { clearTimeout(timer); }
  }

  async function sendOneBatch(): Promise<SyncOutcome> {
    const pending = await o.outbox.pending(MAX_BATCH_OPERATIONS);
    if (pending.length === 0) return { sent: 0, settled: 0 };
    // fill up to 1 MB of body; the first operation always goes, even alone over the limit (the server then decides)
    const head = `{"device_id":${JSON.stringify(o.deviceId)},"operations":[`;
    let bytes = enc.encode(head).length + 2;
    const parts: string[] = []; const ids: string[] = [];
    for (const op of pending) {
      const s = JSON.stringify(toWire(op)); const b = enc.encode(s).length + (parts.length ? 1 : 0);
      if (parts.length && bytes + b > MAX_BATCH_BYTES) break;
      parts.push(s); ids.push(op.op_id); bytes += b;
    }
    o.onSyncing?.(true);
    let res: Response;
    try { res = await post(head + parts.join(',') + ']}'); } catch { return fail(); } finally { o.onSyncing?.(false); }
    if (!res.ok) return fail(retryAfterMs(res.headers.get('retry-after'), now()));
    const data = (await res.json().catch(() => null)) as { results?: SyncResult[] } | null;
    if (!data || !Array.isArray(data.results)) return fail();
    const mine = new Set(ids);
    const x: Required<Settlement> = { remove: [], attention: [], conflicts: [], mappings: [] };
    for (const r of data.results) {
      if (!r || !mine.has(r.op_id)) continue;
      mine.delete(r.op_id); // one result per op_id counts
      if (r.status === 'accepted' || r.status === 'duplicate') { x.remove.push(r.op_id); if (Array.isArray(r.number_mappings)) x.mappings.push(...r.number_mappings); }
      else if (r.status === 'rejected') x.attention.push({ opId: r.op_id, code: String(r.error_code ?? 'unknown') });
      else if (r.status === 'conflict' && r.conflict_id) x.conflicts.push({ opId: r.op_id, conflictId: r.conflict_id, code: r.error_code });
    }
    await o.outbox.settle(x);
    attempt = 0; nextAt = null;
    return { sent: ids.length, settled: x.remove.length + x.attention.length + x.conflicts.length };
  }

  const engine = {
    /** Sends at most one batch. Concurrent calls share the flight; inside the backoff window nothing is sent. */
    syncOnce(): Promise<SyncOutcome> {
      if (closed) return Promise.resolve({ sent: 0, settled: 0, skipped: 'closed' });
      if (nextAt !== null && now() < nextAt) return Promise.resolve({ sent: 0, settled: 0, skipped: 'backoff' });
      flight ??= asLeader(sendOneBatch).finally(() => { flight = null; });
      return flight;
    },
    /** Sends batches until the outbox is empty, a batch makes no progress, or the engine backs off. */
    async drain(): Promise<SyncOutcome> {
      const total: SyncOutcome = { sent: 0, settled: 0 };
      for (;;) {
        const r = await engine.syncOnce();
        total.sent += r.sent; total.settled += r.settled;
        if (r.sent === 0 || r.settled === 0) return { ...total, skipped: r.skipped };
      }
    },
    nextAttemptAt: () => nextAt,
    async close() { closed = true; await flight?.catch(() => undefined); channel?.close(); channel = null; },
  };
  return engine;
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
