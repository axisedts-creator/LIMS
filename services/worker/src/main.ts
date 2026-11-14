// Worker entry (02-TRD §7.1; LD-65): runtime deps from env, metrics + /health/live on LIMS_CORE_METRICS_PORT, Graphile run(),
// SIGTERM/SIGINT drain within LIMS_CORE_SHUTDOWN_GRACE_S (CR-C1-008).
import { createWorkerRuntime, startWorker } from './core/bootstrap.js';
import { manifest as instruments } from './jobs/instruments/index.js';
import { manifest as lab } from './jobs/lab/index.js';
import { manifest as reporting } from './jobs/reporting/index.js';

const env = process.env;
const rt = await createWorkerRuntime(env);
const metricsServer = await rt.startMetricsServer(Number(env.LIMS_CORE_METRICS_PORT ?? 9464));
const worker = await startWorker({
  deps: rt.deps, manifests: [instruments, lab, reporting], connectionString: rt.connectionString,
  concurrency: Number(env.LIMS_CORE_WORKER_CONCURRENCY ?? 10),
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const grace = setTimeout(() => process.exit(1), Number(env.LIMS_CORE_SHUTDOWN_GRACE_S ?? 55) * 1000);
  grace.unref();
  await worker.stop();
  await Promise.allSettled([rt.close(), metricsServer.close()]);
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
