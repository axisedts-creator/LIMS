import { toMovementDto } from './movement.dto.js';
import { canReadCost, pick, type Row } from './_dto.js';

const HEAD = ['id', 'doc_no', 'doc_kind', 'store_id', 'occurred_at', 'business_date', 'issued_to_kind', 'department_id', 'instrument_id', 'supplier_id', 'grn_id', 'container_id', 'reason_code', 'reason_text'] as const;
const LINE = ['id', 'line_no', 'item_id', 'lot_id', 'direction', 'qty_base', 'value_paisa', 'reason_code'] as const;

export function toStockDocumentDto(row: Row, permissions: readonly string[]): Row {
  const cost = canReadCost(permissions);
  const out = pick(row, HEAD, cost);
  out['lines'] = ((row['lines'] ?? []) as Row[]).map((l) => pick(l, LINE, cost));
  if (row['movements'] !== undefined) out['movements'] = (row['movements'] as Row[]).map((m) => toMovementDto(m, permissions));
  return out;
}
