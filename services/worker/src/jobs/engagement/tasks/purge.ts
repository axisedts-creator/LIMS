// C16 T-OPS1: crons engagement.purge_ephemeral (hourly :37 NPT) and engagement.purge_queue (daily 03:10 NPT); both per_tenant (08 A13 P-6).
// 05-SCHEMA §5.3: class-E deletes run as the system actor under `<t>__delete__tenant` (no DEFINER, 08 A17 P-18(c)); §6.4: the only two purge DEFINERs are
// engagement.purge_payment_requests() and engagement.purge_queue(), which set app.maintenance themselves — a task never touches that GUC.
// Tenant guard (REQ-SEC-024): acts only when payload.tenant_id is a uuid equal to the job's tenant; otherwise it resolves without running a statement.
// Any statement error propagates so the job is retried / dead-lettered (never swallowed).
import type { TaskHandler } from '../../../core/manifest.js';

export const PURGE_EPHEMERAL = 'engagement.purge_ephemeral';
export const PURGE_QUEUE = 'engagement.purge_queue';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ownTenant = (payload: Record<string, unknown> | undefined, ctx: { tenantId?: string }): string | undefined => {
  const t = payload?.tenant_id;
  return typeof t === 'string' && UUID.test(t) && ctx.tenantId === t ? t : undefined;
};

// 05-SCHEMA §9 retention. Each statement is idempotent: a rerun matches nothing new.
const CLASS_E = [
  `DELETE FROM engagement.otp_challenges WHERE tenant_id = $1 AND expires_at < now() - interval '24 hours'`,
  // a link_codes row referenced by a link is kept for the link lifetime
  `DELETE FROM engagement.link_codes WHERE tenant_id = $1 AND expires_at < now() - interval '90 days'
     AND NOT EXISTS (SELECT 1 FROM engagement.account_patient_links l WHERE l.tenant_id = link_codes.tenant_id AND l.link_code_id = link_codes.id)`,
  `DELETE FROM engagement.notifications WHERE tenant_id = $1 AND expires_at < now()`,
  // rate keys only; numbering keys have expires_at IS NULL
  `DELETE FROM engagement.number_counters WHERE tenant_id = $1 AND expires_at IS NOT NULL AND expires_at < now()`,
  // personal fields NULLed, row kept (B15); terminal rows only (queued rows must keep them: self_registrations__queued_fields__ck)
  `UPDATE engagement.self_registrations SET full_name = NULL, sex = NULL, birth_on = NULL, age_years = NULL
     WHERE tenant_id = $1 AND status <> 'queued' AND expires_at < now()
       AND (full_name IS NOT NULL OR sex IS NOT NULL OR birth_on IS NOT NULL OR age_years IS NOT NULL)`,
  // 03-APP-FLOW §4.5: closed_at is set with the status (enquiries__closed__ck)
  `UPDATE engagement.enquiries SET status = 'closed', closed_at = now(), version = version + 1, updated_at = now(), updated_by = $2
     WHERE tenant_id = $1 AND status IN ('open', 'answered') AND last_message_at < now() - interval '30 days'`,
] as const;

export const purgeEphemeral: TaskHandler = async (payload, ctx) => {
  const tenantId = ownTenant(payload, ctx);
  if (!tenantId) return;
  for (const sql of CLASS_E) await ctx.tx.query(sql, sql.includes('$2') ? [tenantId, ctx.actor.id] : [tenantId]);
  await ctx.tx.query('SELECT engagement.purge_payment_requests()');
};

export const purgeQueue: TaskHandler = async (payload, ctx) => {
  if (!ownTenant(payload, ctx)) return;
  await ctx.tx.query('SELECT engagement.purge_queue()');
};
