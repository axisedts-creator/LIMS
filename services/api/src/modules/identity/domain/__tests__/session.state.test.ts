// T3 session.state.ts — 03-APP-FLOW §2.1 SS1–SS10. Assumed API (pure): STATES, canTransition(from: State | null, to: State): boolean.
import { describe, expect, it } from 'vitest';
import { STATES, canTransition } from '../session.state.js';
import { checkStateTable, type Edge } from './state-table.helper.js';

const ALL = ['password_setup', 'mfa_pending', 'mfa_enrolment_required', 'active', 'revoked', 'expired'];
const LIVE = ALL.slice(0, 4);
const allowed: Edge[] = [
  [null, 'password_setup'], [null, 'mfa_pending'], [null, 'mfa_enrolment_required'], [null, 'active'], // SS1–SS4
  ['mfa_pending', 'active'], // SS5
  ['mfa_enrolment_required', 'active'], // SS7
  ['password_setup', 'mfa_enrolment_required'], ['password_setup', 'active'], ['password_setup', 'mfa_pending'], // SS8
  ...LIVE.map((s): Edge => [s, 'revoked']), // SS6 + SS9
  ...LIVE.map((s): Edge => [s, 'expired']), // SS10
];
checkStateTable('session', STATES, ALL, canTransition as never, allowed, true);

describe('session spec examples (§2.1 "Forbidden examples")', () => {
  it.each([['active', 'mfa_pending'], ['revoked', 'active'], ['expired', 'active']])('%s -> %s forbidden', (f, t) => {
    expect(canTransition(f as never, t as never)).toBe(false);
  });
  it('terminal states have no exits', () => {
    for (const f of ['revoked', 'expired']) for (const t of ALL) expect(canTransition(f as never, t as never)).toBe(false);
  });
});
