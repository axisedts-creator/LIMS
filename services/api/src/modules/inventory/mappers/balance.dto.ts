import { canReadCost, pick, type Row } from './_dto.js';

const KEYS = ['store_id', 'item_id', 'item_code', 'item_name', 'lot_id', 'lot_no', 'expiry_on', 'lot_status', 'qty_base', 'available_qty_base', 'has_open_container', 'reorder_level_base', 'value_paisa', 'avg_unit_cost_paisa_x1e6'] as const;

export const toBalanceRowDto = (row: Row, permissions: readonly string[]): Row => pick(row, KEYS, canReadCost(permissions));
