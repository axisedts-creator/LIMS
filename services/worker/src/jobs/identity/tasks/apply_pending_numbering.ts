// identity.apply_pending_numbering (02-TRD §10 crontab, per_tenant 00:10 Asia/Kathmandu; 08 A13 P-6, A23.1; AC-C3.3).
// Under the job tenant's claims as the identity system actor: when the pending effective B.S. fiscal year (Shrawan 1, via bsdate) has started
// in Asia/Kathmandu at ctx.now(), move the pending patterns into the live columns, clear pending_*, bump version (tenant_settings__update__tenant).
import { fiscalYearBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { q, tenantOnly } from './shared.js';

export const APPLY_PENDING_NUMBERING = 'identity.apply_pending_numbering';
const NPT_OFFSET_MS = (5 * 60 + 45) * 60_000;   // Asia/Kathmandu = UTC+05:45, no DST

export interface PendingNumbering { version: number; pending_invoice_no_pattern: string | null; pending_credit_note_no_pattern: string | null; pending_effective_fy_bs: string | null }
export type NumberingChange = { invoice_no_pattern?: string; credit_note_no_pattern?: string };
export interface PendingNumberingRepo {
  loadPending(tx: unknown, tenantId: string): Promise<PendingNumbering | undefined>;
  apply(tx: unknown, tenantId: string, change: NumberingChange, actorId: string): Promise<void>;
}

export const pendingNumberingRepo: PendingNumberingRepo = {
  async loadPending(tx, tenantId) {
    return (await q(tx, `SELECT version, pending_invoice_no_pattern, pending_credit_note_no_pattern, pending_effective_fy_bs
      FROM identity.tenant_settings WHERE tenant_id = $1`, [tenantId]))[0] as PendingNumbering | undefined;
  },
  async apply(tx, tenantId, change, actorId) {
    // Fixed text: only the two whitelisted columns, values bound.
    await q(tx, `UPDATE identity.tenant_settings SET
        invoice_no_pattern = CASE WHEN $2::boolean THEN $3 ELSE invoice_no_pattern END,
        credit_note_no_pattern = CASE WHEN $4::boolean THEN $5 ELSE credit_note_no_pattern END,
        pending_invoice_no_pattern = NULL, pending_credit_note_no_pattern = NULL, pending_effective_fy_bs = NULL,
        version = version + 1, updated_at = now(), updated_by = $6
      WHERE tenant_id = $1 AND pending_effective_fy_bs IS NOT NULL`,
    [tenantId, 'invoice_no_pattern' in change, change.invoice_no_pattern ?? null, 'credit_note_no_pattern' in change, change.credit_note_no_pattern ?? null, actorId]);
  },
};

/** 'YYYY/YY' -> YYYY (start year), or NaN. */
const fyStart = (fy: unknown) => (typeof fy === 'string' && /^\d{4}\/\d{2}$/.test(fy) ? Number(fy.slice(0, 4)) : NaN);
const nptDate = (nowIso: string) => new Date(Date.parse(nowIso) + NPT_OFFSET_MS).toISOString().slice(0, 10) as IsoDate;

export function createApplyPendingNumbering(deps: { repo: PendingNumberingRepo }): TaskHandler {
  return async (payload, ctx) => {
    const tenantId = tenantOnly(APPLY_PENDING_NUMBERING, payload, ctx);
    const row = await deps.repo.loadPending(ctx.tx, tenantId);
    const effective = fyStart(row?.pending_effective_fy_bs);
    if (!row || Number.isNaN(effective)) return;
    const change: NumberingChange = {};
    if (row.pending_invoice_no_pattern != null) change.invoice_no_pattern = row.pending_invoice_no_pattern;
    if (row.pending_credit_note_no_pattern != null) change.credit_note_no_pattern = row.pending_credit_note_no_pattern;
    if (!Object.keys(change).length) return;
    if (fyStart(fiscalYearBs(nptDate(ctx.now())).long) < effective) return;      // that fiscal year has not started yet
    await deps.repo.apply(ctx.tx, tenantId, change, ctx.actor.id);
    ctx.log?.info?.({ event: APPLY_PENDING_NUMBERING, applied: Object.keys(change) });
  };
}

export const applyPendingNumbering = createApplyPendingNumbering({ repo: pendingNumberingRepo });
