import { toMovementDto } from './movement.dto.js';
import { canReadCost, live, pick, taxLine, type Row } from './_dto.js';

const SUMMARY = ['id', 'grn_no', 'kind', 'store_id', 'supplier_id', 'po_id', 'status', 'received_at', 'posted_at', 'total_paisa', 'version'] as const;
const HEAD = ['id', 'grn_no', 'kind', 'store_id', 'supplier_id', 'po_id', 'status', 'received_at', 'supplier_invoice_no', 'supplier_invoice_on', 'supplier_invoice_total_paisa', 'invoice_total_mismatch_paisa', 'subtotal_paisa', 'discount_paisa', 'net_paisa', 'vat_paisa', 'total_paisa', 'posted_at', 'cancelled_at', 'cancel_reason_text', 'notes', 'version'] as const;
const LINE = ['id', 'line_no', 'item_id', 'pack_id', 'qty_packs', 'qty_base', 'unit_price_paisa', 'discount_paisa', 'tax_code', 'is_exempt', 'tax_rate_bp', 'net_paisa', 'vat_paisa', 'line_total_paisa', 'po_line_id', 'lot_no', 'expiry_on', 'manufactured_on', 'lot_id', 'capitalised_value_paisa'] as const;

export const toGrnSummaryDto = (row: Row, permissions: readonly string[]): Row => pick(row, SUMMARY, canReadCost(permissions));

export function toGrnDto(row: Row, permissions: readonly string[]): Row {
  const cost = canReadCost(permissions);
  const out = pick(row, HEAD, cost);
  out['lines'] = live(row['lines']).map((l) => taxLine(l, LINE, cost));
  if (row['movements'] !== undefined) out['movements'] = (row['movements'] as Row[]).map((m) => toMovementDto(m, permissions));
  return out;
}
