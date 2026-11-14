// inventory.balance_integrity_check (02-TRD §9, §10 invariant 1; 08 A13 P-6 per_tenant): compares stock_balances with the sum of stock_movements per (store, item, lot) (qty AND value; a balance
// without movements and movements without a balance row count); every difference raises ONE open `balance_drift` alert. NEVER auto-corrects: it reads the ledger and writes alerts only.
// ponytail: the lims_inventory_balance_drift_rows gauge needs a metrics seam JobContext does not have yet; the count is logged (event balance_integrity_done) until C0-0D adds deps.metrics per .orchestra/cr/C12.T-18.md (CR-C12-018).
import type { TaskHandler } from '../../../core/manifest.js';
import { query } from '../../../../../api/src/modules/inventory/repository/_base.js';
import { jobScope, raiseAlerts } from './_shared.js';

export const BALANCE_INTEGRITY_CHECK = 'inventory.balance_integrity_check';
const NO_LOT = '00000000-0000-0000-0000-000000000000'; // hashable stand-in for lot_id IS NULL in the join

const DRIFT = `WITH m AS (SELECT store_id, item_id, lot_id, sum(qty_base) AS q, sum(value_paisa) AS v FROM inventory.stock_movements WHERE tenant_id = $1 GROUP BY store_id, item_id, lot_id),
  b AS (SELECT store_id, item_id, lot_id, qty_base AS q, value_paisa AS v FROM inventory.stock_balances WHERE tenant_id = $1)
SELECT coalesce(b.store_id, m.store_id) AS store_id, coalesce(b.item_id, m.item_id) AS item_id, coalesce(b.lot_id, m.lot_id) AS lot_id,
       coalesce(b.q, 0)::text AS balance_qty, coalesce(m.q, 0)::text AS movement_qty, coalesce(b.v, 0)::text AS balance_value, coalesce(m.v, 0)::text AS movement_value
  FROM b FULL JOIN m ON m.store_id = b.store_id AND m.item_id = b.item_id AND coalesce(m.lot_id, '${NO_LOT}'::uuid) = coalesce(b.lot_id, '${NO_LOT}'::uuid)
 WHERE coalesce(b.q, 0) <> coalesce(m.q, 0) OR coalesce(b.v, 0) <> coalesce(m.v, 0)
 ORDER BY 1, 2, 3`;

export const balanceIntegrityCheck: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const rc = jobScope('balance_integrity_check', payload, jobCtx);
  if (rc === null) return;
  const rows = await query(rc, DRIFT);
  await raiseAlerts(rc, 'balance_drift', rows.map((r) => ({
    store_id: r['store_id'], item_id: r['item_id'], lot_id: r['lot_id'], key: `balance_drift:${r['store_id']}:${r['item_id']}:${r['lot_id'] ?? 'none'}`,
    details: { balance_qty: r['balance_qty'], movement_qty: r['movement_qty'], balance_value_paisa: r['balance_value'], movement_value_paisa: r['movement_value'] },
  })));
  ctx.log?.[rows.length > 0 ? 'warn' : 'info']?.({ event: 'balance_integrity_done', drift_rows: rows.length });
};
