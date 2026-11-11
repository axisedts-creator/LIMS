// Shared GatewayOutcome shape + column selection for the status mapping tables (TRD §7.2.4 / §7.3.4). Pure.
import { OPEN_INTENT_STATUSES, type IntentStatus } from './intent.state.js';

export type GatewayOutcome =
  | { readonly kind: 'settle' | 'stay' | 'to_pending' | 'expire' | 'retry' | 'ok' }
  | { readonly kind: 'fail' | 'hold'; readonly reason: string }
  | { readonly kind: 'finding'; readonly finding: string };

export interface StatusInput {
  /** Raw gateway status; null = no answer (code 0, 5xx, timeout, network) -> retry in every column. */
  readonly statusRaw: string | null;
  readonly amountMatches: boolean;
  readonly beforeDeadline: boolean;
  readonly intentStatus: IntentStatus;
}

/** Column order of the TRD tables: open before deadline, open after deadline, held, failed/expired, settled/refunded. */
export type Cells = readonly [GatewayOutcome, GatewayOutcome, GatewayOutcome, GatewayOutcome, GatewayOutcome];

export const SETTLE: GatewayOutcome = Object.freeze({ kind: 'settle' });
export const STAY: GatewayOutcome = Object.freeze({ kind: 'stay' });
export const RETRY: GatewayOutcome = Object.freeze({ kind: 'retry' });
export const EXPIRE: GatewayOutcome = Object.freeze({ kind: 'expire' });
export const OK: GatewayOutcome = Object.freeze({ kind: 'ok' });
export const hold = (reason: string): GatewayOutcome => Object.freeze({ kind: 'hold', reason });
export const fail = (reason: string): GatewayOutcome => Object.freeze({ kind: 'fail', reason });
export const finding = (f: string): GatewayOutcome => Object.freeze({ kind: 'finding', finding: f });

export const NO_ANSWER: Cells = [RETRY, RETRY, RETRY, RETRY, RETRY];

/** Same rows in both gateways. */
export const COMPLETE_EQUAL: Cells = [SETTLE, SETTLE, SETTLE, hold('late_payment_found'), OK];
export const COMPLETE_DIFFERS: Cells = [
  hold('amount_mismatch'), hold('amount_mismatch'), STAY, hold('amount_mismatch'), finding('amount_mismatch'),
];
export const REFUNDED: Cells = [
  hold('gateway_refunded_before_settle'), hold('gateway_refunded_before_settle'), STAY, STAY, finding('gateway_refund_unrecorded'),
];

export function columnOf(s: IntentStatus, beforeDeadline: boolean): 0 | 1 | 2 | 3 | 4 {
  if (OPEN_INTENT_STATUSES.includes(s)) return beforeDeadline ? 0 : 1;
  if (s === 'held_for_review') return 2;
  if (s === 'failed' || s === 'expired') return 3;
  return 4; // settled, partially_refunded, refunded
}

/** Trim, then exact case-sensitive lookup. Own keys only (no prototype hits such as "constructor"). */
export function lookupRow(rows: Readonly<Record<string, Cells>>, statusRaw: string): Cells | undefined {
  const k = statusRaw.trim();
  return Object.hasOwn(rows, k) ? rows[k] : undefined;
}
