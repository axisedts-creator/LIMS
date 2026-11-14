// `analytics.dispatch_schedules` (02-TRD §9.6; cron */15 * * * * per tenant; max_attempts 5): due schedules of ONE tenant -> one run per slot -> one C6 e-mail link per eligible
// ACTIVE recipient. Runs in the job's single system transaction: a failure rejects the task (rollback + cron retry); the same slot can never run twice (report_runs__slot__uq).
import { dispatchDueSchedules, type DispatchCtx } from '../../../../../api/src/modules/analytics/service/schedule.service.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { jobTenant } from './shared.js';

export const dispatchSchedulesTask: TaskHandler = async (payload, ctx) => {
  jobTenant(payload, ctx, 'analytics.dispatch_schedules');
  await dispatchDueSchedules(ctx as unknown as DispatchCtx);
};
