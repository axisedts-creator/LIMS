// C15 TRD §7.3.4 Khalti lookup status -> GatewayOutcome (pure table). The body status is the only signal; HTTP code is never an input.
import {
  columnOf, COMPLETE_DIFFERS, COMPLETE_EQUAL, EXPIRE, fail, finding, hold, lookupRow, NO_ANSWER, REFUNDED, STAY,
  type Cells, type GatewayOutcome, type StatusInput,
} from './outcome.js';

const div = finding('status_divergence');
const CANCELLED: Cells = [fail('gateway_cancelled'), fail('gateway_cancelled'), STAY, STAY, div];

const ROWS: Readonly<Record<string, Cells>> = {
  Pending: [hold('gateway_pending'), hold('gateway_pending'), STAY, STAY, div],
  Initiated: [STAY, hold('gateway_initiated_after_expiry'), STAY, STAY, div], // CR-C15-001
  Refunded: REFUNDED,
  'Partially Refunded': REFUNDED,
  Expired: [EXPIRE, EXPIRE, STAY, STAY, div],
  'User canceled': CANCELLED,
  Canceled: CANCELLED,
  Failed: CANCELLED,
};
const UNKNOWN: Cells = [hold('gateway_status_unknown'), hold('gateway_status_unknown'), STAY, STAY, div];

export function mapKhaltiStatus(i: StatusInput): GatewayOutcome {
  if (i.statusRaw === null) return NO_ANSWER[0];
  const s = i.statusRaw.trim();
  const col = columnOf(i.intentStatus, i.beforeDeadline);
  if (s === 'Completed') return (i.amountMatches ? COMPLETE_EQUAL : COMPLETE_DIFFERS)[col];
  return (lookupRow(ROWS, s) ?? UNKNOWN)[col];
}
