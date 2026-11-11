// Gapless counter allocation (02-TRD §12; US-BL-01.1–.5; 04 L7; 08 A13 D-23/D-25). With counters.repo.ts the only code that names billing.fiscal_counters.
// Called LAST before the document insert, in the caller's transaction. The service never retries: the owner of the transaction does (D-25).
import type { IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import type { Tx } from '../../../core/db/tx.js';
import { LimsError } from '../../../core/errors.js';
import { loadBillingConfig } from '../config.js';
import { checkFiscalYear } from '../domain/fiscalYear.js';

export interface AllocateInput {
  readonly tenantId: string;
  /** `INV`, `CN`, `RC`, or `INV:<branch_code>` (invoice_series_scope = branch). */
  readonly series: string;
  /** Long form `YYYY/YY`. */
  readonly fiscalYearBs: string;
  readonly actorId: string;
  /** Required for `INV:<branch>`: must contain the `{branch}` token (D-23). */
  readonly invoiceNoPattern?: string;
  readonly timezone?: string;
}
export interface Allocation { readonly lastNo: number; readonly allocatedAt: string }
export interface CounterServiceDeps { readonly config?: { readonly counterLockTimeoutMs: number } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERIES = /^(INV|CN|RC)(:[A-Za-z0-9_-]{1,20})?$/; // = fiscal_counters__series__ck
const FY = /^[0-9]{4}\/[0-9]{2}$/; // = fiscal_counters__fy__ck

const SET_TIMEOUT = "SELECT set_config('lock_timeout', $1, true)"; // is_local = true: never leaks to the pooled connection
const RESET_TIMEOUT = "SELECT set_config('lock_timeout', '0', true)"; // review C4 #29
const BUMP = `UPDATE billing.fiscal_counters SET last_no = last_no + 1
    , updated_at = now(), updated_by = $4
  WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3 AND closed_at IS NULL AND is_active
  RETURNING last_no, clock_timestamp() AS allocated_at`;
const OPEN = `INSERT INTO billing.fiscal_counters (tenant_id, series, fiscal_year_bs, last_no, created_by, updated_by)
  VALUES ($1, $2, $3, 0, $4, $4) ON CONFLICT DO NOTHING`;

const invalid = () => new LimsError('common.validation_failed');
const busy = (detail?: string) => Object.assign(new LimsError('billing.counter_busy', detail), { retryAfterSeconds: 1 });
const isLockTimeout = (e: unknown) => (e as { code?: unknown } | null)?.code === '55P03';

export function createCounterService(deps: CounterServiceDeps = {}) {
  async function allocate(tx: Tx, input: AllocateInput): Promise<Allocation> {
    const { tenantId, series, fiscalYearBs, actorId, invoiceNoPattern } = input;
    if (!UUID.test(String(tenantId)) || !UUID.test(String(actorId)) || !SERIES.test(String(series)) || !FY.test(String(fiscalYearBs))) throw invalid();
    // step 0: nothing allocated, no SQL. A missing pattern fails closed.
    if (series.startsWith('INV:') && !(typeof invoiceNoPattern === 'string' && invoiceNoPattern.includes('{branch}'))) {
      throw new LimsError('billing.numbering_pattern_invalid');
    }
    const timeoutMs = (deps.config ?? loadBillingConfig()).counterLockTimeoutMs;
    const bump = async () => (await tx.query(BUMP, [tenantId, series, fiscalYearBs, actorId])).rows[0] as { last_no: number; allocated_at: Date | string } | undefined;

    await tx.query(SET_TIMEOUT, [`${timeoutMs}ms`]);
    let row;
    try {
      row = await bump();
      if (!row) {
        // missing row -> create at 0 (racing creators collapse on ON CONFLICT); still no row = closed. Retried once, never looped.
        await tx.query(OPEN, [tenantId, series, fiscalYearBs, actorId]);
        row = await bump();
      }
    } catch (e) {
      if (isLockTimeout(e)) throw busy(); // only from the counter statements; the aborted tx rolls the timeout back
      throw e; // 40P01 etc. propagate raw
    }
    await tx.query(RESET_TIMEOUT); // step 2a
    if (!row) throw new LimsError('billing.fiscal_year_closed');

    const allocatedAt = new Date(row.allocated_at).toISOString();
    // step 3: the caller's rollback undoes the bump, so no gap
    if (!checkFiscalYear(allocatedAt as IsoUtc, input.timezone ?? 'Asia/Kathmandu', fiscalYearBs).ok) throw busy('fiscal_year_rollover');
    return { lastNo: row.last_no, allocatedAt };
  }
  return { allocate };
}
export type CounterService = ReturnType<typeof createCounterService>;
