import { toGrnSummaryDto } from './goodsReceipt.dto.js';
import { canReadCost, forbidden, live, pick, taxLine, type Row } from './_dto.js';

const SUMMARY = ['id', 'po_no', 'branch_id', 'store_id', 'supplier_id', 'status', 'source', 'expected_on', 'total_paisa', 'created_at', 'version'] as const;
const HEAD = ['id', 'po_no', 'branch_id', 'store_id', 'supplier_id', 'status', 'source', 'expected_on', 'notes', 'subtotal_paisa', 'discount_paisa', 'net_paisa', 'vat_paisa', 'total_paisa', 'approved_at', 'sent_at', 'sent_channel', 'sent_reference', 'cancelled_at', 'cancel_reason_code', 'cancel_reason_text', 'closed_at', 'close_reason_code', 'close_reason_text', 'created_at', 'version'] as const;
const LINE = ['id', 'line_no', 'item_id', 'pack_id', 'qty_packs', 'qty_base', 'unit_price_paisa', 'discount_paisa', 'tax_code', 'is_exempt', 'tax_rate_bp', 'net_paisa', 'vat_paisa', 'line_total_paisa', 'received_qty_base', 'open_qty_base', 'is_closed_short'] as const;
const PRINT = ['is_draft', 'tenant_display_name', 'branch_name', 'po_no', 'status', 'created_at', 'expected_on', 'subtotal_paisa', 'discount_paisa', 'net_paisa', 'vat_paisa', 'total_paisa'] as const;
const PRINT_SUPPLIER = ['supplier_code', 'name', 'pan_text', 'address_text'] as const;
const PRINT_LINE = ['line_no', 'item_code', 'item_name', 'pack_label', 'qty_packs', 'unit_price_paisa', 'discount_paisa', 'tax_code', 'is_exempt', 'line_total_paisa'] as const;

export const toPoSummaryDto = (row: Row, permissions: readonly string[]): Row => pick(row, SUMMARY, canReadCost(permissions));

export function toPoDto(row: Row, permissions: readonly string[]): Row {
  const cost = canReadCost(permissions);
  const out = pick(row, HEAD, cost);
  out['lines'] = live(row['lines']).map((l) => taxLine(l, LINE, cost));
  if (row['receipts'] !== undefined) out['receipts'] = (row['receipts'] as Row[]).map((g) => toGrnSummaryDto(g, permissions));
  return out;
}

/** #89: the print view is money-only (02-TRD §6.3): without inventory.cost.read it is auth.forbidden, never a stripped page. */
export function toPoPrintViewDto(row: Row, permissions: readonly string[]): Row {
  if (!canReadCost(permissions)) return forbidden();
  const out = pick(row, PRINT, true);
  out['supplier'] = pick(row['supplier'] ?? {}, PRINT_SUPPLIER, true);
  out['lines'] = live(row['lines']).map((l) => taxLine(l, PRINT_LINE, true));
  return out;
}
