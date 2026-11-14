// C13 T21 — task partners.redact_expired_lines (02-TRD §8.1, 3 attempts; cron 02:40 NPT, per_tenant — 08 A13 P-6; 05-SCHEMA §6, §8).
// 1. Lines (and the order_reports panel names) older than the tenant's retentionYears: ONLY through the owner function
//    partners.redact_lines(tenant, cutoff). The DEFINER sets app.maintenance = 'partners_redact_lines' itself (08 A10.5, A12.2, A19 P-41); this task never touches the GUC or a role.
// 2. download_counters past expires_at: plain system-actor DELETE in the same task (08 A17 P-18(c)); not part of the DEFINER.
// retentionYears comes from IdentityPort and is validated BEFORE any write: a bad value rejects (fail closed; precedent analytics.purge).
// No logging of DB / port errors (they can echo row values): they just surface for the retry. A 42501 'redaction_scope' from the DEFINER propagates.
import type { TaskHandler } from '../../../core/manifest.js';

const MAX_YEARS = 100;   // sanity ceiling, as analytics.purge

export const redactExpiredLines: TaskHandler = async (payload, ctx) => {
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) throw new Error('partners.redact_expired_lines: payload tenant differs from the job tenant context');   // REQ-SEC-024
  const settings = await (ctx as any).ports.IdentityPort.getTenantSettings(ctx, { keys: ['retentionYears'] });
  const years = settings?.retentionYears;
  if (typeof years !== 'number' || !Number.isInteger(years) || years < 1 || years > MAX_YEARS) throw new RangeError('partners.redact_expired_lines: tenant setting retentionYears must be an integer >= 1');
  const cutoff = new Date(ctx.now());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);   // 29 Feb rolls to 1 Mar: at most a day late, never early

  await ctx.tx.query('SELECT partners.redact_lines($1, $2::timestamptz)', [tenantId, cutoff.toISOString()]);
  await ctx.tx.query('DELETE FROM partners.download_counters WHERE tenant_id = $1 AND expires_at < now()', [tenantId]);
};
