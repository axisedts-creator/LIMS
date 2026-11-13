import { canReadCost, pick, type Row } from './_dto.js';

const KEYS = ['id', 'occurred_at', 'business_date', 'store_id', 'item_id', 'lot_id', 'lot_no', 'movement_kind', 'qty_base', 'balance_qty_after', 'value_paisa', 'value_basis', 'doc_type', 'doc_id', 'doc_no', 'instrument_id', 'attributed_test_id', 'rule_id', 'reason_code', 'created_by_display'] as const;

export const toMovementDto = (row: Row, permissions: readonly string[]): Row => pick(row, KEYS, canReadCost(permissions));
