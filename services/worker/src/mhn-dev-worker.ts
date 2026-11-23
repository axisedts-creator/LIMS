import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lims-async-kek-'));
const file = join(dir, 'kek.json');
writeFileSync(file, JSON.stringify({ keys: { k1: randomBytes(32).toString('base64') }, active: 'k1' }));
process.env.LIMS_CORE_ENV = 'dev';
process.env.LIMS_CORE_DATABASE_URL = process.env.LIMS_CORE_DATABASE_URL || 'postgres://lims_api:lims_api_dev_password@127.0.0.1:5433/postgres';
process.env.LIMS_PAYMENTS_PUBLIC_BASE_URL = 'https://api.example.invalid';
process.env.LIMS_PAYMENTS_KEK_FILE = file;
process.env.LIMS_PAYMENTS_ESEWA_FORM_URL = 'https://uat.esewa.com.np/api/epay/main/v2/form';
process.env.LIMS_PAYMENTS_RETURN_URL_ALLOWLIST = 'https://staff.example.invalid/,https://portal.example.invalid/';
process.env.LIMS_CORE_METRICS_PORT = '9466';

import { frontdeskPort } from '../../api/src/modules/frontdesk/ports/FrontdeskPort.impl.js';
import { manifest as identityManifest } from '../../api/src/modules/identity/index.js';
import { manifest as engagementManifest } from './jobs/engagement/index.js';
import { createWorkerRuntime, startWorker } from './core/bootstrap.js';
import type { WorkerDeps } from './core/tasklist.js';

const env = process.env;
const rt = await createWorkerRuntime(env);
const NotificationPort = {
  sendSms: async () => ({ status: 'queued' }),
  sendWhatsAppTemplate: async () => ({ status: 'queued' }),
  sendEmailLink: async () => ({ status: 'queued' }),
};
const ReportingPort = {
  getReleasedReports: async () => ({ items: [], nextCursor: undefined }),
};
const deps: WorkerDeps = {
  ...rt.deps,
  ports: {
    FrontdeskPort: frontdeskPort,
    IdentityPort: identityManifest.ports?.IdentityPort,
    NotificationPort,
    ReportingPort,
  },
};
const metricsServer = await rt.startMetricsServer(Number(env.LIMS_CORE_METRICS_PORT ?? 9466));
const worker = await startWorker({
  deps,
  manifests: [engagementManifest],
  connectionString: rt.connectionString,
  concurrency: Number(env.LIMS_CORE_WORKER_CONCURRENCY ?? 5),
});

console.log('MHN Worker started successfully and listening for jobs');

const shutdown = async () => {
  console.log('Worker shutting down...');
  await worker.stop();
  await Promise.allSettled([rt.close(), metricsServer.close()]);
  process.exit(0);
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
