// T3 tenant.state.ts — 03-APP-FLOW §2.3 T1–T5. Assumed API (pure): STATES, canTransition(from: Status | null, to: Status): boolean.
import { describe, expect, it } from 'vitest';
import { STATES, canTransition } from '../tenant.state.js';
import { checkStateTable, type Edge } from './state-table.helper.js';

const ALL = ['provisioning', 'active', 'suspended', 'offboarded'];
const allowed: Edge[] = [
  [null, 'provisioning'], // T1
  ['provisioning', 'active'], // T2
  ['active', 'suspended'], // T3
  ['suspended', 'active'], // T4
  ['provisioning', 'offboarded'], ['suspended', 'offboarded'], // T5
];
checkStateTable('tenant', STATES, ALL, canTransition as never, allowed, true);

describe('tenant spec "Forbidden" line', () => {
  it.each([['active', 'provisioning'], ['provisioning', 'suspended'], ['active', 'offboarded']])('%s -> %s forbidden', (f, t) => {
    expect(canTransition(f as never, t as never)).toBe(false);
  });
  it('offboarded -> * forbidden', () => {
    for (const t of ALL) expect(canTransition('offboarded' as never, t as never)).toBe(false);
  });
  it('old C2 names are not states (A3.3)', () => {
    expect(STATES).not.toContain('onboarding');
    expect(STATES).not.toContain('terminated');
  });
});
