// Cron engagement.dispatch_due_reminders, every 5 min per tenant (02-TRD §4.11, §8.2): status='scheduled' AND due_at <= now, batch 500, FOR UPDATE SKIP LOCKED
// -> enqueue engagement.send_reminder {tenant_id, reminder_id} with job_key rem:<id> (a second tick collapses in the queue). Only enqueues: it never sends and
// never changes a reminder; the task re-reads the row, so a reminder cancelled after this tick is still not sent.
import type { TaskHandler } from '../../../core/manifest.js';

// Same statement as core/fanout.ts ENQUEUE_SQL; not imported because fanout pulls the queue runtime, which the API test package (reminder.handlers.test) cannot resolve.
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';   // (identifier, payload, job_key, run_at, max_attempts)
const SEND_REMINDER = 'engagement.send_reminder';
const SEND_MAX_ATTEMPTS = 8;   // TRD §8.1

export function createDispatchDueReminders(): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId;
    if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
      ctx.log?.warn?.({ event: 'dispatch_due_reminders_skipped', reason: 'bad_payload' });
      return;
    }
    // ponytail: one tick enqueues <= 500 reminders, oldest first; the rest follow on the next tick (5 min). Raise the batch if backlogs outlast that.
    const { rows } = await ctx.tx.query(
      `SELECT id FROM engagement.reminders WHERE tenant_id = $1 AND status = 'scheduled' AND due_at <= $2 ORDER BY due_at, id LIMIT 500 FOR UPDATE SKIP LOCKED`,
      [tenantId, ctx.now()]);
    for (const r of rows as { id: string }[]) {
      await ctx.tx.query(ENQUEUE_SQL, [SEND_REMINDER, JSON.stringify({ tenant_id: tenantId, reminder_id: r.id }), `rem:${r.id}`, null, SEND_MAX_ATTEMPTS]);
    }
  };
}
