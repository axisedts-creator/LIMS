// C13 T21 — task partners.expire_drafts (02-TRD §8.1, 3 attempts; cron 01:40 NPT, per_tenant — 08 A13 P-6; 05-SCHEMA §6 / §10.2 draft_ttl_days, default 30).
// Drafts whose updated_at is older than the tenant's draft_ttl_days: manifest + lines draft -> discarded, and the lines' patient block is redacted in the
// same statement (is_redacted = true). Plain system-actor UPDATEs of rows still in 'draft' (guard_line_update lets draft rows through); the owner
// function partners.redact_lines is the retention path only and is NOT used here. No logging of DB errors (they can echo row values): they just surface for the retry.
import type { TaskHandler } from '../../../core/manifest.js';

const DAY_MS = 86_400_000;
const DEFAULT_TTL_DAYS = 30;   // 05-SCHEMA partners.settings.draft_ttl_days DEFAULT 30 (lazy settings row, A17 P-22)

export const expireDrafts: TaskHandler = async (payload, ctx) => {
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) throw new Error('partners.expire_drafts: payload tenant differs from the job tenant context');   // REQ-SEC-024
  const q = ctx.tx.query.bind(ctx.tx);

  const s = await q('SELECT draft_ttl_days FROM partners.settings WHERE tenant_id = $1', [tenantId]);
  const raw = (s.rows[0] as { draft_ttl_days?: unknown } | undefined)?.draft_ttl_days;
  const ttl = raw === undefined ? DEFAULT_TTL_DAYS : raw;
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > 90) throw new RangeError('partners.expire_drafts: draft_ttl_days must be an integer 1..90');
  const cutoff = new Date(Date.parse(ctx.now()) - ttl * DAY_MS).toISOString();

  // lines first: they select their drafts through the manifest state, which the second statement changes
  await q(
    `UPDATE partners.manifest_lines SET state = 'discarded', patient_full_name = NULL, patient_sex = NULL, patient_birth_on = NULL,
            patient_age_years = NULL, patient_phone_e164 = NULL, clinical_note = NULL, orderables_snapshot = '[]'::jsonb,
            is_redacted = true, redacted_at = now(), updated_at = now(), updated_by = $2, version = version + 1
      WHERE tenant_id = $1 AND state = 'draft'
        AND manifest_id IN (SELECT id FROM partners.manifests WHERE tenant_id = $1 AND state = 'draft' AND updated_at < $3::timestamptz)`,
    [tenantId, ctx.actor.id, cutoff]);
  await q(
    `UPDATE partners.manifests SET state = 'discarded', discarded_at = now(), updated_at = now(), updated_by = $2, version = version + 1
      WHERE tenant_id = $1 AND state = 'draft' AND updated_at < $3::timestamptz`,
    [tenantId, ctx.actor.id, cutoff]);
};
