// T0B-FILES-1 (LD-310, founder request 2026-11-17 04:54 NPT) done_when 5: parallel uploads (limit 3), retry up to 3 times with backoff, cancel, resume.
// Prescribed API (FileUpload/uploadQueue.ts, framework free, no DOM):
//   uploadQueue({ files, send, concurrency = 3, maxRetries = 3, backoffMs = (retry) => number, sleep = (ms, signal) => Promise<void>, resumable = (file) => boolean, onState })
//     -> { done: Promise<Array<{ name, status: 'done' | 'failed' | 'cancelled', attempts }>>, cancel(name?: string): void }
//   send(file, { attempt (1-based), signal, resumeFrom (bytes already stored, 0 unless resumable), onProgress(percent, ackedBytes?) }) -> Promise<void>
//   A thrown error with `retryable === false` (expired URL 403, 413, 415, create-only 412) is NOT retried. Anything else is retried up to maxRetries times (so at most 4 attempts).
//   onState(name, { status: 'queued' | 'uploading' | 'retrying' | 'done' | 'failed' | 'cancelled', percent, attempt })
import { describe, expect, it, vi } from 'vitest';
import { uploadQueue } from '../FileUpload/uploadQueue';

const f = (name: string, size = 10) => { const x = new File(['x'], name, { type: 'application/pdf' }); Object.defineProperty(x, 'size', { value: size }); return x; };
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const noSleep = (log: number[] = []) => async (ms: number) => { log.push(ms); };
const err = (msg: string, retryable?: boolean) => Object.assign(new Error(msg), retryable === undefined ? {} : { retryable });

describe('uploadQueue: parallel limit', () => {
  it('runs at most 3 uploads at once (default) and starts the next as soon as one finishes', async () => {
    const files = Array.from({ length: 7 }, (_, i) => f(`f${i}.pdf`));
    let live = 0, peak = 0; const gates = files.map(() => gate());
    const send = vi.fn(async (file: File) => { live++; peak = Math.max(peak, live); await gates[files.indexOf(file)]!.p; live--; });
    const q = uploadQueue({ files, send, sleep: noSleep() });
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(3);
    gates[0]!.open(); await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(4);
    gates.forEach((g) => g.open());
    const res = await q.done;
    expect(peak).toBe(3);
    expect(res.map((r) => r.status)).toEqual(Array(7).fill('done'));
    expect(res.map((r) => r.name)).toEqual(files.map((x) => x.name));
  });
  it('an explicit concurrency of 1 is honoured; zero or negative is clamped to 1, above 3 is clamped to 3', async () => {
    for (const [asked, expected] of [[1, 1], [0, 1], [-4, 1], [10, 3]] as const) {
      let live = 0, peak = 0;
      const q = uploadQueue({ files: Array.from({ length: 6 }, (_, i) => f(`c${i}.pdf`)), concurrency: asked, sleep: noSleep(), send: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 1)); live--; } });
      await q.done;
      expect(peak, `concurrency ${asked}`).toBe(expected);
    }
  });
});

describe('uploadQueue: retry with backoff (up to 3 retries)', () => {
  it('a transient failure is retried and the file ends done; attempts counted from 1', async () => {
    const attempts: number[] = []; const sleeps: number[] = [];
    const q = uploadQueue({ files: [f('a.pdf')], sleep: noSleep(sleeps), send: async (_f, c) => { attempts.push(c.attempt); if (c.attempt < 3) throw err('network'); } });
    expect(await q.done).toEqual([{ name: 'a.pdf', status: 'done', attempts: 3 }]);
    expect(attempts).toEqual([1, 2, 3]);
    expect(sleeps).toHaveLength(2);
  });
  it('gives up after 1 + 3 attempts and reports failed (not an endless loop)', async () => {
    const send = vi.fn(async () => { throw err('network'); }); const sleeps: number[] = [];
    const q = uploadQueue({ files: [f('a.pdf')], send, sleep: noSleep(sleeps) });
    expect(await q.done).toEqual([{ name: 'a.pdf', status: 'failed', attempts: 4 }]);
    expect(send).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3);
  });
  it('maxRetries is configurable; 0 means one attempt', async () => {
    const send = vi.fn(async () => { throw err('x'); });
    expect((await uploadQueue({ files: [f('a.pdf')], send, maxRetries: 0, sleep: noSleep() }).done)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('default backoff grows (each wait longer than the last), starts at 250 ms or more and is capped at 30 s', async () => {
    const sleeps: number[] = [];
    await uploadQueue({ files: [f('a.pdf')], send: async () => { throw err('x'); }, sleep: noSleep(sleeps) }).done;
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
    expect(sleeps[2]!).toBeGreaterThan(sleeps[1]!);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
  });
  it('a custom backoffMs gets the retry number (1, 2, 3)', async () => {
    const seen: number[] = [];
    await uploadQueue({ files: [f('a.pdf')], send: async () => { throw err('x'); }, sleep: noSleep(), backoffMs: (n) => { seen.push(n); return 1; } }).done;
    expect(seen).toEqual([1, 2, 3]);
  });
  it('errors marked retryable:false (expired URL, too large, wrong type, already exists) are not retried', async () => {
    const send = vi.fn(async () => { throw err('403 expired', false); });
    const q = uploadQueue({ files: [f('a.pdf')], send, sleep: noSleep() });
    expect(await q.done).toEqual([{ name: 'a.pdf', status: 'failed', attempts: 1 }]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('one failing file does not stop the others, and a failed file frees its slot', async () => {
    const files = [f('bad.pdf'), f('ok1.pdf'), f('ok2.pdf'), f('ok3.pdf')];
    const q = uploadQueue({ files, sleep: noSleep(), send: async (file) => { if (file.name === 'bad.pdf') throw err('x', false); } });
    expect((await q.done).map((r) => `${r.name}:${r.status}`)).toEqual(['bad.pdf:failed', 'ok1.pdf:done', 'ok2.pdf:done', 'ok3.pdf:done']);
  });
  it('reports states: queued -> uploading -> retrying -> uploading -> done, with percent from onProgress and the attempt number', async () => {
    const seen: string[] = [];
    await uploadQueue({
      files: [f('a.pdf')], sleep: noSleep(),
      send: async (_f, c) => { c.onProgress(40); if (c.attempt === 1) throw err('x'); c.onProgress(100); },
      onState: (n, s) => seen.push(`${n}:${s.status}:${s.percent}:${s.attempt}`),
    }).done;
    expect(seen[0]).toMatch(/^a\.pdf:(queued|uploading):0:/);
    expect(seen).toContain('a.pdf:retrying:40:1');
    expect(seen).toContain('a.pdf:uploading:40:1');
    expect(seen.at(-1)).toBe('a.pdf:done:100:2');
  });
  it('percent is clamped to 0..100 and never goes backwards within one attempt', async () => {
    const pcts: number[] = [];
    await uploadQueue({ files: [f('a.pdf')], send: async (_f, c) => { c.onProgress(-5); c.onProgress(50); c.onProgress(30); c.onProgress(180); }, onState: (_n, s) => pcts.push(s.percent) }).done;
    expect(Math.min(...pcts)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...pcts)).toBeLessThanOrEqual(100);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]!).toBeGreaterThanOrEqual(pcts[i - 1]!);
  });
});

describe('uploadQueue: cancel', () => {
  it('cancel(name) aborts that file signal, marks it cancelled, does not retry, and starts the next queued file', async () => {
    const files = [f('a.pdf'), f('b.pdf'), f('c.pdf'), f('d.pdf')]; const signals = new Map<string, AbortSignal>(); const started: string[] = [];
    const q = uploadQueue({
      files, sleep: noSleep(),
      send: (file, c) => { started.push(file.name); signals.set(file.name, c.signal); return new Promise<void>((res, rej) => { c.signal.addEventListener('abort', () => rej(err('aborted'))); if (file.name === 'd.pdf') res(); }); },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    q.cancel('a.pdf');
    await new Promise((r) => setTimeout(r, 0));
    expect(signals.get('a.pdf')!.aborted).toBe(true);
    expect(signals.get('b.pdf')!.aborted).toBe(false);
    expect(started).toEqual(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']);
    q.cancel();
    const res = await q.done;
    expect(res.find((r) => r.name === 'a.pdf')).toEqual({ name: 'a.pdf', status: 'cancelled', attempts: 1 });
    expect(res.find((r) => r.name === 'd.pdf')!.status).toBe('done');
    expect(res.filter((r) => r.status === 'cancelled').map((r) => r.name).sort()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });
  it('cancelling a queued file (not started) means it never starts; cancel() with no name cancels everything and leaves no pending work', async () => {
    const send = vi.fn((_f: File, c: { signal: AbortSignal }) => new Promise<void>((_res, rej) => c.signal.addEventListener('abort', () => rej(err('aborted')))));
    const q = uploadQueue({ files: Array.from({ length: 5 }, (_, i) => f(`q${i}.pdf`)), send, sleep: noSleep() });
    await new Promise((r) => setTimeout(r, 0));
    q.cancel();
    const res = await q.done;
    expect(res.map((r) => r.status)).toEqual(Array(5).fill('cancelled'));
    expect(send).toHaveBeenCalledTimes(3);
    expect(res.slice(3).map((r) => r.attempts)).toEqual([0, 0]);
  });
  it('cancel during the backoff wait stops the retry (the sleep is aborted through its signal)', async () => {
    let sleepSignal: AbortSignal | undefined;
    const send = vi.fn(async () => { throw err('x'); });
    const q = uploadQueue({ files: [f('a.pdf')], send, sleep: (_ms, signal) => { sleepSignal = signal; return new Promise<void>((_r, rej) => signal.addEventListener('abort', () => rej(err('aborted')))); } });
    await new Promise((r) => setTimeout(r, 0));
    q.cancel('a.pdf');
    expect(await q.done).toEqual([{ name: 'a.pdf', status: 'cancelled', attempts: 1 }]);
    expect(sleepSignal!.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('cancel of an unknown name or after completion is a no-op', async () => {
    const q = uploadQueue({ files: [f('a.pdf')], send: async () => {}, sleep: noSleep() });
    const res = await q.done;
    q.cancel('a.pdf'); q.cancel('nope.pdf');
    expect(res).toEqual([{ name: 'a.pdf', status: 'done', attempts: 1 }]);
  });
});

describe('uploadQueue: resume large files', () => {
  it('on a retry of a resumable file, send gets resumeFrom = the last acknowledged byte count; first attempt starts at 0', async () => {
    const from: number[] = [];
    await uploadQueue({
      files: [f('big.pdf', 20 * 1024 * 1024)], sleep: noSleep(), resumable: () => true,
      send: async (_f, c) => { from.push(c.resumeFrom); if (c.attempt === 1) { c.onProgress(25, 5 * 1024 * 1024); throw err('network'); } if (c.attempt === 2) { c.onProgress(60, 12 * 1024 * 1024); throw err('network'); } },
    }).done;
    expect(from).toEqual([0, 5 * 1024 * 1024, 12 * 1024 * 1024]);
  });
  it('a file that is not resumable restarts from 0 on every attempt', async () => {
    const from: number[] = [];
    await uploadQueue({ files: [f('a.pdf')], sleep: noSleep(), resumable: () => false, send: async (_f, c) => { from.push(c.resumeFrom); c.onProgress(50, 5); if (c.attempt < 3) throw err('x'); } }).done;
    expect(from).toEqual([0, 0, 0]);
  });
  it('resumeFrom never exceeds the file size', async () => {
    const from: number[] = [];
    await uploadQueue({ files: [f('a.pdf', 100)], sleep: noSleep(), resumable: () => true, send: async (_f, c) => { from.push(c.resumeFrom); if (c.attempt === 1) { c.onProgress(100, 5000); throw err('x'); } } }).done;
    expect(from[1]).toBeLessThanOrEqual(100);
  });
});

describe('uploadQueue: robustness', () => {
  it('an empty file list resolves to an empty result without calling send', async () => {
    const send = vi.fn();
    expect(await uploadQueue({ files: [], send, sleep: noSleep() }).done).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it('two files with the same name are tracked separately (results keep order and count)', async () => {
    const res = await uploadQueue({ files: [f('same.pdf'), f('same.pdf')], send: async () => {}, sleep: noSleep() }).done;
    expect(res).toHaveLength(2);
  });
  it('a send that throws a non-Error value is treated as a retryable failure, never as an unhandled rejection', async () => {
    const send = vi.fn(async () => { throw 'plain string'; });
    const res = await uploadQueue({ files: [f('a.pdf')], send, sleep: noSleep() }).done;
    expect(res[0]).toMatchObject({ status: 'failed', attempts: 4 });
  });
});
