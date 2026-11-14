import { canReadCost, pick, type Row } from './_dto.js';

const LINE = ['rule_id', 'item_id', 'qty_base', 'lot_id', 'est_value_paisa'] as const;

/** previewConsumption (#74): est_value_paisa only for inventory.cost.read. */
export function toConsumptionPreviewDto(resp: Row, permissions: readonly string[]): Row {
  const cost = canReadCost(permissions);
  return { ...pick(resp, ['store_id', 'store_resolution_step'], cost), lines: ((resp['lines'] ?? []) as Row[]).map((l) => pick(l, LINE, cost)) };
}
