// T3 membership.state.ts — 03-APP-FLOW §2.2 M1–M6 (status) + L1–L2 (lock, orthogonal).
// Assumed API (pure): STATES, canTransition(from: Status | null, to: Status): boolean, canLockTransition(fromLocked: boolean, toLocked: boolean): boolean.
import { describe, expect, it } from 'vitest';
import { STATES, canTransition, canLockTransition } from '../membership.state.js';
import { checkStateTable, type Edge } from './state-table.helper.js';

const allowed: Edge[] = [
  [null, 'invited'], // M1
  ['invited', 'active'], // M2
  ['invited', 'deactivated'], // M3
  ['active', 'deactivated'], // M4
  ['deactivated', 'active'], // M5
  ['deactivated', 'invited'], // M6
];
checkStateTable('membership', STATES, ['invited', 'active', 'deactivated'], canTransition as never, allowed, true);

describe('membership lock (L1/L2)', () => {
  it('unlocked -> locked and locked -> unlocked allowed', () => {
    expect(canLockTransition(false, true)).toBe(true);
    expect(canLockTransition(true, false)).toBe(true);
  });
  it('no-op lock changes forbidden', () => {
    expect(canLockTransition(true, true)).toBe(false);
    expect(canLockTransition(false, false)).toBe(false);
  });
  it('lock is not a status value', () => {
    expect(STATES).not.toContain('locked');
  });
});
