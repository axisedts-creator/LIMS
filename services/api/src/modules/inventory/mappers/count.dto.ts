import { canReadCost, live, pick, type Row } from './_dto.js';

const HEAD = ['id', 'count_no', 'store_id', 'status', 'scope_category', 'snapshot_at', 'posted_at', 'cancelled_at', 'notes', 'version', 'lines_page'] as const;
const LINE = ['id', 'item_id', 'lot_id', 'book_qty_snapshot', 'counted_qty_base', 'counted_at', 'book_qty_at_count', 'variance_qty_base', 'variance_value_paisa', 'reason_code', 'version'] as const;

export function toCountDto(row: Row, permissions: readonly string[]): Row {
  const cost = canReadCost(permissions);
  const out = pick(row, HEAD, cost);
  out['lines'] = live(row['lines']).map((l) => pick(l, LINE, cost));
  return out;
}
