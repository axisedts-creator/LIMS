// billing.fiscal_counter_prepare (02-TRD §10): counter rows for the current FY (and the next FY from Ashadh 25 B.S. [CONV]) for INV, CN, RC;
// closed_at on counters of FYs that ended > 1 day ago. Creates rows / sets closed_at only — numbering is never written here.
// ponytail: per-branch INV series (scope = branch) not prepared; they are created on first allocation. Add when branch scope ships.
import { fiscalYearOf } from '../../../../../api/src/modules/billing/domain/fiscalYear.js';
import { instantToBs, type IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const FISCAL_COUNTER_PREPARE = 'billing.fiscal_counter_prepare';
const SERIES = ['INV', 'CN', 'RC'];
const DAY_MS = 86_400_000;

const nextFy = (long: string) => { const y = Number(long.slice(0, 4)) + 1; return `${y}/${String((y + 1) % 100).padStart(2, '0')}`; };

export const fiscalCounterPrepare: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'fiscal_counter_prepare_skipped', reason: 'bad_payload' });
    return;
  }
  const now = ctx.now() as IsoUtc;
  const cur = fiscalYearOf(now).long;
  const bs = instantToBs(now);
  const years = bs.month === 3 && bs.day >= 25 ? [cur, nextFy(cur)] : [cur];
  const actor = ctx.actor.id;
  for (const fy of years) {
    await ctx.tx.query(
      `INSERT INTO billing.fiscal_counters (tenant_id, series, fiscal_year_bs, created_by, updated_by)
       SELECT $1, s, $2, $3, $3 FROM unnest($4::text[]) AS s ON CONFLICT (tenant_id, series, fiscal_year_bs) DO NOTHING`,
      [tenantId, fy, actor, SERIES]);
  }
  // FY ended > 1 day ago = the FY of (now - 1 day) is later than the counter's FY. Numeric start-year compare (2099/00 vs 2100/01).
  const ended = Number(fiscalYearOf(new Date(Date.parse(now) - DAY_MS).toISOString() as IsoUtc).long.slice(0, 4));
  await ctx.tx.query(
    `UPDATE billing.fiscal_counters SET closed_at = $2, updated_at = $2, updated_by = $3
     WHERE tenant_id = $1 AND closed_at IS NULL AND left(fiscal_year_bs, 4)::int < $4`,
    [tenantId, now, actor, ended]);
};
