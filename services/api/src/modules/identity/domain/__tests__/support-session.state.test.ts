// T3 support-session.state.ts — 03-APP-FLOW §2.4 SP1–SP10 (US-E4, AC-E4.4). Assumed API (pure): STATES, canTransition(from: Status | null, to: Status): boolean.
import { describe, expect, it } from 'vitest';
import { STATES, canTransition } from '../support-session.state.js';
import { checkStateTable, type Edge } from './state-table.helper.js';

const ALL = ['requested', 'approved', 'denied', 'active', 'ended', 'expired', 'revoked'];
const allowed: Edge[] = [
  [null, 'active'], // SP1 (notify)
  [null, 'requested'], // SP2 (approval_required)
  ['requested', 'approved'], // SP3
  ['requested', 'denied'], // SP4
  ['requested', 'expired'], // SP5 (24 h)
  ['approved', 'active'], // SP6
  ['approved', 'expired'], // SP7 (60 min)
  ['active', 'ended'], // SP8
  ['active', 'expired'], // SP9
  ['approved', 'revoked'], ['active', 'revoked'], // SP10
];
checkStateTable('support session', STATES, ALL, canTransition as never, allowed, true);

describe('support session AC-E4.4', () => {
  it('requested never jumps straight to active (needs approval)', () => {
    expect(canTransition('requested' as never, 'active' as never)).toBe(false);
  });
  it('denied / ended / expired / revoked are terminal', () => {
    for (const f of ['denied', 'ended', 'expired', 'revoked']) for (const t of ALL) expect(canTransition(f as never, t as never)).toBe(false);
  });
});
