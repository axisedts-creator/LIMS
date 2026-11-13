import { toMovementDto } from './movement.dto.js';
import { canReadCost, pick, type Row } from './_dto.js';

const HEAD = ['id', 'fact_kind', 'source', 'status', 'instrument_id', 'test_id', 'analyte_id', 'occurred_at', 'business_date', 'multiplier', 'store_id', 'rules_applied', 'value_paisa_total', 'reason_code', 'note', 'version'] as const;

export function toFactDto(row: Row, permissions: readonly string[]): Row {
  const out = pick(row, HEAD, canReadCost(permissions));
  if (row['movements'] !== undefined) out['movements'] = (row['movements'] as Row[]).map((m) => toMovementDto(m, permissions));
  return out;
}
