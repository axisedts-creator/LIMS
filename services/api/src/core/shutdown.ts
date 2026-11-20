// T0B-PERF-1 (LD-310) done_when 5: graceful shutdown. On SIGTERM/SIGINT stop accepting (Fastify answers 503 to requests
// arriving while closing), let in-flight requests finish, close the app (onClose ends the pg pool), exit 0.
// Requests still running after graceMs are cut and the exit code is 1.
import type { FastifyInstance } from 'fastify';

export interface ShutdownOptions {
  readonly graceMs?: number;
  readonly proc?: { on(signal: string, fn: () => void): unknown };
  readonly exit?: (code: number) => void;
  readonly signals?: readonly string[];
}

export function installShutdown(app: FastifyInstance, o: ShutdownOptions = {}): { shutdown(signal?: string): Promise<void>; readonly draining: boolean } {
  const graceMs = o.graceMs ?? 25_000; // [CONV] under the 30 s SIGKILL default of container hosts
  const exit = o.exit ?? ((c: number) => process.exit(c));
  let running: Promise<void> | undefined;

  const shutdown = (signal?: string): Promise<void> => {
    running ??= (async () => {
      app.log.info({ event: 'shutdown_started', signal }, 'shutdown_started');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), graceMs); });
      const closing = app.close().then(() => 'closed' as const, () => 'failed' as const);
      // a keep-alive socket whose request just finished would hold close() for keepAliveTimeout (72 s): drop idle ones as they appear
      const sweep = setInterval(() => { app.server.closeIdleConnections(); }, 50);
      const outcome = await Promise.race([closing, late]);
      clearTimeout(timer);
      clearInterval(sweep);
      if (outcome === 'late') {
        app.server.closeAllConnections(); // cut what is still in flight; close() then completes
        await closing;
      }
      app.log.info({ event: 'shutdown_done', outcome }, 'shutdown_done');
      exit(outcome === 'closed' ? 0 : 1);
    })();
    return running;
  };

  for (const s of o.signals ?? ['SIGTERM', 'SIGINT']) (o.proc ?? process).on(s, () => { void shutdown(s); });
  return { shutdown, get draining() { return running !== undefined; } };
}
