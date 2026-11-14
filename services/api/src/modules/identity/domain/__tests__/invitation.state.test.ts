// T3 invitation.state.ts — 03-APP-FLOW §2.6. Assumed API (pure): STATES, canTransition(from: Status, to: Status): boolean.
// (No creation row in §2.6, so no null source.)
import { describe, expect, it } from 'vitest';
import { STATES, canTransition } from '../invitation.state.js';
import { checkStateTable, type Edge } from './state-table.helper.js';

const ALL = ['pending', 'sent', 'accepted', 'expired', 'revoked', 'failed'];
const allowed: Edge[] = [
  ['pending', 'sent'], // job ok
  ['pending', 'failed'], ['sent', 'failed'], // job exhausted
  ['sent', 'sent'], // resend (attempt_no + 1)
  ['sent', 'accepted'],
  ['sent', 'expired'], // cron
  ['pending', 'revoked'], ['sent', 'revoked'], // deactivate
  ['expired', 'sent'], ['failed', 'sent'], // resend creates a new sent attempt
];
checkStateTable('invitation', STATES, ALL, canTransition as never, allowed, false);

describe('invitation terminals', () => {
  it('accepted and revoked have no exits', () => {
    for (const f of ['accepted', 'revoked']) for (const t of ALL) expect(canTransition(f as never, t as never)).toBe(false);
  });
});
