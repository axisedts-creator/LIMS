import { toBalanceRowDto } from './balance.dto.js';
import { canReadCost, pick, type Row } from './_dto.js';

const KEYS = ['id', 'item_id', 'lot_no', 'expiry_on', 'manufactured_on', 'status', 'status_reason_code', 'version', 'last_receipt_unit_cost_paisa_x1e6'] as const;

export function toLotDto(row: Row, permissions: readonly string[]): Row {
  const out = pick(row, KEYS, canReadCost(permissions));
  if (row['balances'] !== undefined) out['balances'] = (row['balances'] as Row[]).map((b) => toBalanceRowDto(b, permissions));
  return out;
}
