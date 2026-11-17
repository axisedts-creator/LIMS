// WorkerManifest of module instruments (02-TRD §9.2, §10; 08 A13 P-6). Cron entries live here, in code (REQ-ARCH-042).
// instruments.scan_attachment (§6.8, API-T11) is enqueued by E06, not cron-driven.
import type { ConsumerHandler, TaskHandler, WorkerManifest } from '../../core/manifest.js';
import { scanAttachment } from './scanAttachment.js';
import { publishReleaseConfigs } from './configs.js';
import { evaluateAgentHealth, exportAgentStateMetrics } from './health.js';
import { REFRESH_TASK, expireCredentialsAndCommands, onCatalogChanged, purgeArchive, refreshObservedCodeMapping } from './maintenance.js';

const t = (fn: (payload: any, ctx: any) => Promise<void>): TaskHandler => fn as TaskHandler;

export const manifest: WorkerManifest = {
  module: 'instruments',
  tasks: {
    'instruments.evaluate_agent_health': t(evaluateAgentHealth),
    'instruments.export_agent_state_metrics': t(exportAgentStateMetrics),
    'instruments.expire_credentials_and_commands': t(expireCredentialsAndCommands),
    'instruments.publish_release_configs': t(publishReleaseConfigs),
    'instruments.purge_archive': t(purgeArchive),
    [REFRESH_TASK]: t(refreshObservedCodeMapping),
    'instruments.scan_attachment': t(scanAttachment),
  },
  subscriptions: { 'catalog.changed.v1': onCatalogChanged as ConsumerHandler },
  crontab: [
    { identifier: 'instruments.evaluate_agent_health', schedule: '* * * * *', tenantScope: 'per_tenant', maxAttempts: 1 },
    { identifier: 'instruments.export_agent_state_metrics', schedule: '* * * * *', tenantScope: 'platform', maxAttempts: 1 },
    { identifier: 'instruments.expire_credentials_and_commands', schedule: '*/15 * * * *', tenantScope: 'per_tenant', maxAttempts: 3 },
    { identifier: 'instruments.publish_release_configs', schedule: '7,22,37,52 * * * *', tenantScope: 'per_tenant', maxAttempts: 3 },
    { identifier: 'instruments.purge_archive', schedule: '50 20 * * *', tenantScope: 'per_tenant', maxAttempts: 3 },
  ],
  maxAttempts: { [REFRESH_TASK]: 10, 'instruments.scan_attachment': 5 },
};
