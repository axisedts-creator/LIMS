// BL-T02 cashSession.state.ts (03-APP-FLOW §1.5; 05-SCHEMA cash_sessions__status__ck + lifecycle guard "open→closed only").
// Assumed API: CASH_SESSION_STATUSES, canTransition(from,to), isTerminal(status)
import { describe, expect, it } from 'vitest';
import { CASH_SESSION_STATUSES, canTransition, isTerminal } from '../cashSession.state.js';

const ALLOWED: Record<string, string[]> = { open: ['closed'], closed: [] };

describe('cash session state table', () => {
  it('has exactly open and closed', () => expect([...CASH_SESSION_STATUSES].sort()).toEqual(['closed', 'open']));
  const pairs = CASH_SESSION_STATUSES.flatMap((f) => CASH_SESSION_STATUSES.map((t) => [f, t] as const));
  it.each(pairs)('%s -> %s', (from, to) => expect(canTransition(from, to)).toBe(ALLOWED[from]!.includes(to)));
  it('forbidden: closed -> open (a closed shift is never reopened)', () => expect(canTransition('closed', 'open')).toBe(false));
  it('rejects unknown statuses', () => expect(canTransition('paused' as never, 'closed')).toBe(false));
  it('closed is terminal', () => {
    expect(isTerminal('closed')).toBe(true);
    expect(isTerminal('open')).toBe(false);
  });
});
