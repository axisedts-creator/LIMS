import { canReadCost, live, pick, type Row } from './_dto.js';

const HEAD = ['id', 'transfer_no', 'from_store_id', 'to_store_id', 'status', 'dispatched_at', 'received_at', 'cancelled_at', 'cancel_reason_text', 'notes', 'version'] as const;
const LINE = ['id', 'line_no', 'item_id', 'lot_id', 'qty_base', 'dispatched_value_paisa', 'received_qty_base', 'discrepancy_reason_code'] as const;

export function toTransferDto(row: Row, permissions: readonly string[]): Row {
  const cost = canReadCost(permissions);
  const out = pick(row, HEAD, cost);
  out['lines'] = live(row['lines']).map((l) => pick(l, LINE, cost));
  return out;
}
