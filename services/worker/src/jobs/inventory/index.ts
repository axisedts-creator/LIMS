// inventory worker manifest (02-TRD §9). Consumers are stubs that throw common.internal until T-16 / T-17 implement them; the six tasks are real (T-15, T-18).
import type { ConsumerHandler, WorkerManifest } from '../../core/manifest.js';
import { crontab } from './cron.js';
import { resolveUnresolved } from './tasks/inventory.resolve_unresolved.js';
import { balanceIntegrityCheck } from './tasks/inventory.balance_integrity_check.js';
import { dailyAlertScan } from './tasks/inventory.daily_alert_scan.js';
import { dailyFixedConsumption } from './tasks/inventory.daily_fixed_consumption.js';
import { purgeAlerts } from './tasks/inventory.purge_alerts.js';
import { reconciliationScan } from './tasks/inventory.reconciliation_scan.js';

const notImplemented = (name: string): ConsumerHandler => async () => {
  throw Object.assign(new Error(`inventory job ${name} is not implemented`), { code: 'common.internal' });
};

export const manifest: WorkerManifest = {
  module: 'inventory',
  tasks: {
    'inventory.resolve_unresolved': resolveUnresolved, // T-15
    'inventory.daily_fixed_consumption': dailyFixedConsumption,
    'inventory.daily_alert_scan': dailyAlertScan,
    'inventory.balance_integrity_check': balanceIntegrityCheck,
    'inventory.reconciliation_scan': reconciliationScan,
    'inventory.purge_alerts': purgeAlerts,
  },
  subscriptions: {
    'lab.result.verified.v1': notImplemented('onResultVerified'),
    'instruments.qc.received.v1': notImplemented('onQcReceived'),
    'instruments.result.received.v1': notImplemented('onResultReceived'),
    'instruments.calibration.received.v1': notImplemented('onCalibrationReceived'),
  },
  crontab, // cron.ts: five entries, all per_tenant (08 A13 P-6, A17 D-72)
};
