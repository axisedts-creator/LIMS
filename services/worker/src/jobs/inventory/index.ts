// inventory worker manifest (02-TRD §9). All four consumers are real (T-16, T-17); the six tasks are real (T-15, T-18).
import type { WorkerManifest } from '../../core/manifest.js';
import { crontab } from './cron.js';
import { onResultVerified } from './consumers/lab.result.verified.v1.js';
import { onQcReceived } from './consumers/instruments.qc.received.v1.js';
import { onResultReceived } from './consumers/instruments.result.received.v1.js';
import { onCalibrationReceived } from './consumers/instruments.calibration.received.v1.js';
import { resolveUnresolved } from './tasks/inventory.resolve_unresolved.js';
import { balanceIntegrityCheck } from './tasks/inventory.balance_integrity_check.js';
import { dailyAlertScan } from './tasks/inventory.daily_alert_scan.js';
import { dailyFixedConsumption } from './tasks/inventory.daily_fixed_consumption.js';
import { purgeAlerts } from './tasks/inventory.purge_alerts.js';
import { reconciliationScan } from './tasks/inventory.reconciliation_scan.js';

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
    'lab.result.verified.v1': onResultVerified, // T-16
    'instruments.qc.received.v1': onQcReceived, // T-17
    'instruments.result.received.v1': onResultReceived, // T-17
    'instruments.calibration.received.v1': onCalibrationReceived, // T-17
  },
  crontab, // cron.ts: five entries, all per_tenant (08 A13 P-6, A17 D-72)
};
