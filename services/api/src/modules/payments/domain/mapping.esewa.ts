// C15 TRD §7.2.4 eSewa status -> GatewayOutcome (pure table). `AMBIGIOUS` is eSewa's documented misspelling.
import {
  columnOf, COMPLETE_DIFFERS, COMPLETE_EQUAL, EXPIRE, fail, finding, hold, lookupRow, NO_ANSWER, REFUNDED, RETRY, STAY,
  type Cells, type GatewayOutcome, type StatusInput,
} from './outcome.js';

const div = finding('status_divergence');
const AMBIGUOUS: Cells = [hold('gateway_ambiguous'), hold('gateway_ambiguous'), STAY, hold('gateway_ambiguous'), div];
const CANCELED: Cells = [fail('gateway_cancelled'), fail('gateway_cancelled'), STAY, STAY, div];

const ROWS: Readonly<Record<string, Cells>> = {
  AMBIGUOUS,
  AMBIGIOUS: AMBIGUOUS,
  FULL_REFUND: REFUNDED,
  PARTIAL_REFUND: REFUNDED,
  NOT_FOUND: [STAY, EXPIRE, STAY, STAY, div],
  CANCELED,
};
// PENDING: column 0 (open before deadline) is special-cased below (initiated -> to_pending, pending -> stay).
const PENDING: Cells = [STAY, hold('gateway_pending_after_expiry'), STAY, STAY, div];
// Unknown status: open -> retry (service counts <=3 then holds gateway_status_unknown); not open -> stay / finding.
const UNKNOWN: Cells = [RETRY, RETRY, STAY, STAY, div];

export function mapEsewaStatus(i: StatusInput): GatewayOutcome {
  if (i.statusRaw === null) return NO_ANSWER[0];
  const s = i.statusRaw.trim();
  const col = columnOf(i.intentStatus, i.beforeDeadline);
  if (s === 'COMPLETE') return (i.amountMatches ? COMPLETE_EQUAL : COMPLETE_DIFFERS)[col];
  if (s === 'PENDING') {
    if (col === 0) return i.intentStatus === 'initiated' ? { kind: 'to_pending' } : STAY; // I3
    return PENDING[col];
  }
  return (lookupRow(ROWS, s) ?? UNKNOWN)[col];
}
