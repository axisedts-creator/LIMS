// T0D-OFFLINE-3 (LD-322 decision 1): blocks only for lab codes and patient ids; bill numbers are provisional until sync.
// A spent block falls back to a provisional code marked PENDING. Kept only in the encrypted 'counters' store.
import { timedFetch } from './connectivity';
import { uuidV7Factory } from './outbox';
import { OfflineError, type OfflineStore } from './store';

export type BlockSeries = 'lab_code' | 'patient_id';
const SERIES: Record<BlockSeries, string> = { lab_code: 'nb1', patient_id: 'nb2' }; // opaque record keys: keys sit in clear in IndexedDB
const DEFAULT_SIZES: Record<BlockSeries, number> = { lab_code: 200, patient_id: 100 };
const SUFFIX: Record<BlockSeries, string> = { lab_code: 'LC', patient_id: 'PT' };
export const WARN_RATIO = 0.2;

interface Blocks { blocks: Array<{ from: number; to: number }>; next: number; size: number }
export interface NextNumber { value: string; number: number | null; provisional: boolean; mark?: 'PENDING' }

/** Exactly services/api/src/core/sync/engine.ts provisionalNumber: the server maps this string to the final number. */
export const provisionalNumber = (deviceId: string, opId: string, doc: string) =>
  `OFF-${deviceId.replace(/-/g, '').slice(0, 8)}-${opId.replace(/-/g, '')}-${doc}`.toUpperCase();

export interface NumbersOptions { store: OfflineStore; deviceId: string; fetch?: typeof fetch; baseUrl?: string; now?: () => number; sizes?: Partial<Record<BlockSeries, number>> }

export function createNumbers(o: NumbersOptions) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const sizes = { ...DEFAULT_SIZES, ...o.sizes };
  const id = uuidV7Factory(o.now);
  let chain: Promise<unknown> = Promise.resolve();
  /** one read-modify-write at a time per tab: parallel screens never get the same number */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn); chain = r.catch(() => undefined); return r; };
  const check = (s: string): BlockSeries => { if (!(s in SERIES)) throw new OfflineError('offline.series_invalid'); return s as BlockSeries; };
  const read = async (s: BlockSeries): Promise<Blocks> => (await o.store.get<Blocks>('counters', SERIES[s])) ?? { blocks: [], next: 0, size: 0 };
  const left = (b: Blocks) => b.blocks.reduce((a, x) => a + Math.max(0, x.to - Math.max(x.from, b.next) + 1), 0);

  return {
    async reserve(series: string, opt: { centreId?: string } = {}): Promise<{ ok: true; remaining: number } | { ok: false; code?: string }> {
      const s = check(series);
      if (!o.store.isUnlocked()) throw new OfflineError('offline.locked');
      const body = { device_id: o.deviceId, series: s, size: sizes[s], ...(opt.centreId ? { centre_id: opt.centreId } : {}) };
      const res = await timedFetch(f, `${o.baseUrl ?? ''}/v1/core/sync/number-blocks`, {
        method: 'POST', credentials: 'same-origin', body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': globalThis.crypto.randomUUID() },
      }, 15_000);
      const data = (await res?.json().catch(() => null)) as { code?: unknown; block?: { from_value?: unknown; to_value?: unknown } } | null;
      if (!res?.ok) return typeof data?.code === 'string' ? { ok: false, code: data.code } : { ok: false };
      const from = Number(data?.block?.from_value); const to = Number(data?.block?.to_value);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) return { ok: false };
      return serial(async () => {
        const b = await read(s);
        b.blocks.push({ from, to }); b.blocks.sort((x, y) => x.from - y.from);
        b.size = to - from + 1;
        await o.store.put('counters', SERIES[s], b);
        return { ok: true as const, remaining: left(b) };
      });
    },
    /** the next block number, else a provisional code marked PENDING (never inside a block range) */
    next(series: string): Promise<NextNumber> {
      const s = check(series);
      return serial(async () => {
        const b = await read(s);
        const blk = b.blocks.find((x) => Math.max(x.from, b.next) <= x.to);
        if (!blk) return { value: provisionalNumber(o.deviceId, id(), SUFFIX[s]), number: null, provisional: true, mark: 'PENDING' as const };
        const n = Math.max(blk.from, b.next);
        b.next = n + 1;
        b.blocks = b.blocks.filter((x) => x.to >= b.next); // spent blocks leave
        await o.store.put('counters', SERIES[s], b);
        return { value: String(n), number: n, provisional: false };
      });
    },
    /** warn = at most 20 percent of the last reserved block is left */
    async remaining(series: string) {
      const b = await read(check(series));
      const l = left(b);
      return { left: l, size: b.size, warn: l <= b.size * WARN_RATIO };
    },
  };
}

export type Numbers = ReturnType<typeof createNumbers>;
