// C12 #90 listInventoryAlerts query validation (contracts/openapi/inventory.yaml; 02-TRD §5.9). Strict like lots.schemas.ts: unknown key -> 400, runs before any DB access.
// `status` is a csv (style form, explode false), default open,acknowledged; #91 has no body.
import { isUuid } from '../repository/_base.js';
import { int, oneOf, parse, pat, type Obj, type Rule } from './items.schemas.js';
import type { PageQuery } from './masters.schemas.js';

const STATUSES = ['open', 'acknowledged', 'resolved'];
export const ALERT_KINDS = ['below_reorder', 'expiry_soon', 'expired_on_hand', 'open_stability_exceeded', 'negative_stock', 'unresolved_consumption', 'expired_lot_in_use', 'balance_drift', 'reconciliation_gap'];
const statusCsv: Rule = (v) => typeof v === 'string' && v.length <= 40 && v.split(',').length <= 3 && v.split(',').every((s) => STATUSES.includes(s));

export interface AlertListQuery extends PageQuery { status: string[]; alert_kind?: string; store_id?: string }
export function parseAlertList(query: unknown): AlertListQuery {
  const o: Obj = parse(query ?? {}, { status: statusCsv, alert_kind: oneOf(...ALERT_KINDS), store_id: isUuid, cursor: pat(/^[A-Za-z0-9_-]+$/, 512), limit: int(1, 200) });
  return {
    limit: o['limit'] ?? 50,
    ...(o['cursor'] === undefined ? {} : { cursor: o['cursor'] }),
    status: o['status'] === undefined ? ['open', 'acknowledged'] : [...new Set((o['status'] as string).split(','))],
    ...(o['alert_kind'] === undefined ? {} : { alert_kind: o['alert_kind'] }),
    ...(o['store_id'] === undefined ? {} : { store_id: o['store_id'] }),
  };
}
