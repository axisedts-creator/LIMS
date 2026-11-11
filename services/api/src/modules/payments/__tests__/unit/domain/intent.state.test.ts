// PG-T02 — TRD §4.1 intent transition table (I1–I14 + forbidden list). Spec is encoded independently here.
import { describe, expect, it } from 'vitest';
import {
  assertIntentTransition,
  INTENT_STATUSES,
  isIntentTransitionAllowed,
  OPEN_INTENT_STATUSES,
} from '../../../domain/intent.state.js';

const ALL = [
  'created', 'initiated', 'pending', 'settled', 'failed', 'expired', 'held_for_review', 'partially_refunded', 'refunded',
] as const;

// Every allowed (from -> to) pair, expanded from TRD §4.1 (I1 "(none) -> created" is not a pair).
const ALLOWED: ReadonlyArray<readonly [string, string, string]> = [
  ['I2', 'created', 'initiated'],
  ['I3', 'initiated', 'pending'],
  ['I4', 'initiated', 'settled'], ['I4', 'pending', 'settled'],
  ['I5', 'initiated', 'failed'], ['I5', 'pending', 'failed'],
  ['I6', 'initiated', 'expired'], ['I6', 'pending', 'expired'],
  ['I7', 'initiated', 'held_for_review'], ['I7', 'pending', 'held_for_review'],
  ['I8', 'held_for_review', 'settled'],
  ['I9', 'held_for_review', 'failed'],
  ['I10', 'settled', 'partially_refunded'],
  ['I11', 'settled', 'refunded'], ['I11', 'partially_refunded', 'refunded'],
  ['I12', 'partially_refunded', 'partially_refunded'],
  ['I13', 'failed', 'held_for_review'], ['I13', 'expired', 'held_for_review'],
  ['I14', 'created', 'failed'],
];

// Explicit "Forbidden" paragraph of §4.1 (one+ per state).
const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  ...ALL.map((to) => ['refunded', to] as const), // any transition out of refunded
  ['settled', 'failed'], ['settled', 'expired'], ['settled', 'held_for_review'],
  ['held_for_review', 'expired'],
  ...ALL.map((from) => [from, 'created'] as const), // any -> created
  ['failed', 'settled'], ['expired', 'settled'], // must pass held_for_review
];

describe('intent state table', () => {
  it('exposes the nine statuses and the open set (REQ-SEC-053)', () => {
    expect([...INTENT_STATUSES].sort()).toEqual([...ALL].sort());
    expect([...OPEN_INTENT_STATUSES].sort()).toEqual(['created', 'initiated', 'pending']);
  });

  it.each(ALLOWED)('%s: %s -> %s is allowed', (_id, from, to) => {
    expect(isIntentTransitionAllowed(from as never, to as never)).toBe(true);
    expect(() => assertIntentTransition(from as never, to as never)).not.toThrow();
  });

  it.each(FORBIDDEN)('forbidden: %s -> %s', (from, to) => {
    expect(isIntentTransitionAllowed(from as never, to as never)).toBe(false);
  });

  it('allowed set is EXACTLY the table: every other of the 81 pairs is forbidden', () => {
    const allowed = new Set(ALLOWED.map(([, f, t]) => `${f}>${t}`));
    for (const f of ALL) for (const t of ALL) {
      expect(isIntentTransitionAllowed(f, t), `${f} -> ${t}`).toBe(allowed.has(`${f}>${t}`));
    }
  });

  it('every state has at least one forbidden exit tested', () => {
    for (const s of ALL) expect(FORBIDDEN.some(([f]) => f === s) || ALL.some((t) => !isIntentTransitionAllowed(s, t))).toBe(true);
  });

  it('assertIntentTransition throws payments.intent_invalid_transition (409, CR-C15-006)', () => {
    for (const [from, to] of [['refunded', 'settled'], ['settled', 'failed'], ['failed', 'settled'], ['pending', 'created']] as const) {
      let err: { code?: string; statusCode?: number } | undefined;
      try { assertIntentTransition(from, to); } catch (e) { err = e as never; }
      expect(err?.code, `${from} -> ${to}`).toBe('payments.intent_invalid_transition');
      expect(err?.statusCode).toBe(409);
    }
  });

  it('unknown status strings are not allowed (fail closed)', () => {
    expect(isIntentTransitionAllowed('bogus' as never, 'settled')).toBe(false);
    expect(isIntentTransitionAllowed('initiated', 'bogus' as never)).toBe(false);
  });
});
