// inventory worker manifest (02-TRD §9). T-01: tasks and consumers are stubs that throw common.internal until T-0x implement them.
// ponytail: WorkerManifest is declared here because services/worker has no core yet; import it from the worker core when it lands.
import { resolveUnresolved } from './tasks/inventory.resolve_unresolved.js';

export type JobHandler = (payload: any, ctx: any) => Promise<void>;
export interface CronEntry {
  readonly identifier: string;
  readonly schedule: string;
  readonly tenantScope: 'per_tenant' | 'platform';
}
export interface WorkerManifest {
  readonly module: string;
  readonly tasks: Readonly<Record<string, JobHandler>>;
  readonly subscriptions: Readonly<Record<string, JobHandler>>;
  readonly crontab: readonly CronEntry[];
}

const notImplemented = (name: string): JobHandler => async () => {
  throw Object.assign(new Error(`inventory job ${name} is not implemented`), { code: 'common.internal' });
};

// Crons run on UTC (02-TRD §9; 15 19 * * * UTC = 01:00 Asia/Kathmandu) [CONV]; all per_tenant (08 A13 P-6).
const cron = (identifier: string, schedule: string): CronEntry => ({ identifier, schedule, tenantScope: 'per_tenant' });

export const manifest: WorkerManifest = {
  module: 'inventory',
  tasks: {
    'inventory.resolve_unresolved': resolveUnresolved, // T-15
    'inventory.daily_fixed_consumption': notImplemented('daily_fixed_consumption'),
    'inventory.daily_alert_scan': notImplemented('daily_alert_scan'),
    'inventory.balance_integrity_check': notImplemented('balance_integrity_check'),
    'inventory.reconciliation_scan': notImplemented('reconciliation_scan'),
    'inventory.purge_alerts': notImplemented('purge_alerts'),
  },
  subscriptions: {
    'lab.result.verified.v1': notImplemented('onResultVerified'),
    'instruments.qc.received.v1': notImplemented('onQcReceived'),
    'instruments.result.received.v1': notImplemented('onResultReceived'),
    'instruments.calibration.received.v1': notImplemented('onCalibrationReceived'),
  },
  crontab: [
    cron('inventory.daily_fixed_consumption', '15 19 * * *'),
    cron('inventory.daily_alert_scan', '30 19 * * *'),
    cron('inventory.balance_integrity_check', '45 19 * * *'),
    cron('inventory.reconciliation_scan', '0 20 * * *'),
    cron('inventory.purge_alerts', '0 21 * * 0'),
  ],
};
