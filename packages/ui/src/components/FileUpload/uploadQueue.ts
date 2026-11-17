// T0B-FILES-1 (LD-310; founder request 2026-11-17 04:54 NPT): parallel uploads (limit 3), retry up to 3 times with backoff,
// cancel, resume from the last acknowledged byte. Framework free; the transport (`send`) is the host's direct-to-storage PUT.
export type UploadStatus = 'queued' | 'uploading' | 'retrying' | 'done' | 'failed' | 'cancelled';
export interface UploadState { status: UploadStatus; percent: number; attempt: number }
export interface SendControl { attempt: number; signal: AbortSignal; resumeFrom: number; onProgress: (percent: number, ackedBytes?: number) => void }
export interface UploadResult { name: string; status: 'done' | 'failed' | 'cancelled'; attempts: number }
export interface UploadQueueOptions {
  files: readonly File[];
  send: (file: File, c: SendControl) => Promise<void> | void;
  concurrency?: number;
  maxRetries?: number;
  backoffMs?: (retry: number) => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  resumable?: (file: File) => boolean;
  /** `index` is the file's position in `files` (names may repeat). */
  onState?: (name: string, s: UploadState, index: number) => void;
}

export const defaultBackoffMs = (retry: number): number => Math.min(30_000, 250 * 2 ** (retry - 1));
const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
  if (signal.aborted) return rej(new Error('aborted'));
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
});
const clamp = (p: number) => (Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0);

export function uploadQueue(o: UploadQueueOptions): { done: Promise<UploadResult[]>; cancel(target?: string | number): void } {
  const limit = Math.min(3, Math.max(1, Math.floor(o.concurrency ?? 3) || 1));
  const maxRetries = Math.max(0, o.maxRetries ?? 3);
  const backoff = o.backoffMs ?? defaultBackoffMs;
  const sleep = o.sleep ?? defaultSleep;
  const items = o.files.map((file) => ({ file, ctl: new AbortController(), attempts: 0, status: 'queued' as UploadStatus, percent: 0, acked: 0 }));
  const emit = (i: number) => { const it = items[i]!; try { o.onState?.(it.file.name, { status: it.status, percent: it.percent, attempt: it.attempts }, i); } catch { /* host callback errors never stop the queue */ } };
  items.forEach((_, i) => emit(i));

  async function run(i: number): Promise<void> {
    const it = items[i]!;
    const canResume = (() => { try { return !!o.resumable?.(it.file); } catch { return false; } })();
    for (;;) {
      it.attempts++; it.status = 'uploading';
      if (!canResume) { it.percent = 0; it.acked = 0; }
      emit(i);
      const floor = it.percent;
      try {
        await o.send(it.file, {
          attempt: it.attempts, signal: it.ctl.signal, resumeFrom: canResume ? Math.min(it.acked, it.file.size) : 0,
          onProgress: (p, acked) => {
            if (it.status !== 'uploading') return;
            if (typeof acked === 'number' && acked > it.acked) it.acked = acked;
            const next = Math.max(floor, it.percent, clamp(p));
            if (next !== it.percent) { it.percent = next; emit(i); }
          },
        });
        if (it.ctl.signal.aborted) { it.status = 'cancelled'; emit(i); return; }
        it.status = 'done'; it.percent = 100; emit(i); return;
      } catch (e) {
        if (it.ctl.signal.aborted) { it.status = 'cancelled'; emit(i); return; }
        const retryable = !(e && typeof e === 'object' && (e as { retryable?: unknown }).retryable === false);
        if (!retryable || it.attempts > maxRetries) { it.status = 'failed'; emit(i); return; }
        it.status = 'retrying'; emit(i);
        try { await sleep(backoff(it.attempts), it.ctl.signal); } catch { /* aborted below */ }
        if (it.ctl.signal.aborted) { it.status = 'cancelled'; emit(i); return; }
      }
    }
  }

  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      if (items[i]!.status === 'cancelled') continue;
      await run(i);
    }
  }
  const done = Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    .then(() => items.map((it) => ({ name: it.file.name, status: it.status as UploadResult['status'], attempts: it.attempts })));

  return {
    done,
    cancel(target) {
      items.forEach((it, i) => {
        if (target !== undefined && (typeof target === 'number' ? i !== target : it.file.name !== target)) return;
        if (it.status === 'done' || it.status === 'failed' || it.status === 'cancelled') return;
        const queued = it.status === 'queued';
        it.ctl.abort();
        if (queued) { it.status = 'cancelled'; emit(i); }
      });
    },
  };
}
