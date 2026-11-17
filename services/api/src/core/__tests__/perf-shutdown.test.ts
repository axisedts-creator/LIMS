// T0B-PERF-1 (LD-310) done_when 5 and 7: graceful shutdown finishes in-flight requests; main.ts boots lean and wires the shutdown.
// INTERFACE EXPECTED (writer may dispute a name in .orchestra/notes/T0B-PERF-1-dispute-*.md):
//   core/shutdown.ts  installShutdown(app, { graceMs?: number = 25000, proc?: { on(sig, fn): unknown }, exit?: (code: number) => void, signals?: string[] = ['SIGTERM','SIGINT'] })
//                       -> { shutdown(signal?: string): Promise<void>; readonly draining: boolean }
//     a signal on `proc` runs shutdown once (a second signal is ignored); shutdown stops accepting, lets in-flight requests finish,
//     closes the app (pool included), then exit(0); if requests are still running after graceMs it closes them anyway and exit(1).
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { installShutdown } from '../shutdown.js';
import { FIXTURES, SHARED_ROOT } from './helpers.js';

const open: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((a) => a.close().catch(() => undefined))); });

async function boot() {
  const app = await bootstrap({ config: loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_LOG_LEVEL: 'silent' }), repoRoot: SHARED_ROOT, modulesDir: join(FIXTURES, 'perf') } as any);
  open.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}
const rig = (over: Record<string, unknown> = {}) => {
  const proc = new EventEmitter();
  const exits: number[] = [];
  return { proc, exits, opts: { proc, exit: (c: number) => { exits.push(c); }, graceMs: 3000, ...over } as any };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('graceful shutdown', () => {
  it('an in-flight request finishes with 200 while shutdown runs; exit(0) comes after it', async () => {
    const { app, base } = await boot();
    const r = rig();
    const sd = installShutdown(app, r.opts);
    const inflight = fetch(`${base}/v1/catalog/things/slow`); // handler takes 400 ms
    await wait(100);
    const done = sd.shutdown('SIGTERM');
    expect(sd.draining).toBe(true);
    const res = await inflight;
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('slow');
    await done;
    expect(r.exits).toEqual([0]);
  });

  it('new work is refused while draining: connection error or 503, never a 200', async () => {
    const { app, base } = await boot();
    const r = rig();
    const sd = installShutdown(app, r.opts);
    const inflight = fetch(`${base}/v1/catalog/things/slow`);
    await wait(100);
    const done = sd.shutdown('SIGTERM');
    await wait(20);
    const late = await fetch(`${base}/v1/catalog/things/t1`).then((x) => x.status, () => 'refused' as const);
    expect(late === 'refused' || late === 503).toBe(true);
    await inflight; await done;
  });

  it('a request that outlives graceMs is cut and the process exits 1, within about graceMs', async () => {
    const { app, base } = await boot();
    const r = rig({ graceMs: 200 });
    const sd = installShutdown(app, r.opts);
    const hung = fetch(`${base}/v1/catalog/things/hang`).then(() => 'answered', () => 'cut');
    await wait(100);
    const t0 = Date.now();
    await sd.shutdown('SIGTERM');
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.exits).toEqual([1]);
    expect(await hung).toBe('cut');
  });

  it('SIGTERM and SIGINT on the process trigger it; a second signal is ignored (one close, one exit)', async () => {
    const { app } = await boot();
    const r = rig();
    installShutdown(app, r.opts);
    r.proc.emit('SIGTERM');
    r.proc.emit('SIGINT');
    r.proc.emit('SIGTERM');
    await wait(300);
    expect(r.exits).toEqual([0]);
  });

  it('listens for SIGTERM and SIGINT only by default (no stray listeners)', async () => {
    const { app } = await boot();
    const r = rig();
    installShutdown(app, r.opts);
    expect(r.proc.eventNames().map(String).sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('with nothing in flight it ends fast', async () => {
    const { app } = await boot();
    const r = rig();
    const t0 = Date.now();
    await installShutdown(app, r.opts).shutdown('SIGTERM');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.exits).toEqual([0]);
  });
});

describe('boot is lean and main.ts wires the shutdown (done_when 7)', () => {
  const main = readFileSync(join(import.meta.dirname, '..', '..', 'main.ts'), 'utf8');
  it('main.ts installs the shutdown handler', () => { expect(main).toMatch(/installShutdown\s*\(/); });
  it('between bootstrap(...) and listen(...) main.ts awaits nothing else (no migrations, seeds or warmup before the server listens)', () => {
    const a = main.indexOf('bootstrap(');
    const b = main.indexOf('.listen(');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    const between = main.slice(a, b).split('\n').slice(1).join('\n');
    expect(between.match(/\bawait\b/g) ?? []).toHaveLength(0);
  });
  it('anything that is not essential runs after listen: no warmup/seed/migrate call is made by main.ts before it', () => {
    const before = main.slice(0, main.indexOf('.listen('));
    expect(before).not.toMatch(/\b(migrate|seed|warm\w*)\s*\(/i);
  });
});
