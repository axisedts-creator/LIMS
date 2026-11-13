// C14 T11 — library state table (03-APP-FLOW §1.1, 02-TRD §6): domain/library.state.ts. Unit: every allowed transition + every forbidden one.
// SEAMS (spec silent on the TypeScript shape): domain/library.state.ts exports
//   canTransition(from, to): boolean                       allowed pairs ONLY: draft->in_review, in_review->draft, in_review->approved, approved->retired
//   assertTransition(from, to): void                       throws LimsError('smartreport.library_invalid_transition') otherwise
//   assertEditable(status): void                           content edits only in `draft`; else LimsError('smartreport.library_invalid_transition')
// Fails now: ../library.state.js does not exist.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { assertEditable, assertTransition, canTransition } from '../library.state.js';

const STATUSES = ['draft', 'in_review', 'approved', 'retired'] as const;
const ALLOWED = new Set(['draft>in_review', 'in_review>draft', 'in_review>approved', 'approved>retired']);
const pairs = STATUSES.flatMap((a) => STATUSES.filter((b) => b !== a).map((b) => [a, b] as const));
const refused = (fn: () => void): string | undefined => { try { fn(); } catch (e) { return e instanceof LimsError ? e.code : `non-LimsError ${String(e)}`; } return undefined; };

describe('C14-T11 library state table (L2-L6)', () => {
  it.each(pairs)('%s -> %s', (from, to) => {
    const ok = ALLOWED.has(`${from}>${to}`);
    expect(canTransition(from, to)).toBe(ok);
    expect(refused(() => assertTransition(from, to))).toBe(ok ? undefined : 'smartreport.library_invalid_transition');
  });
  it.each([['draft', 'approved'], ['approved', 'draft'], ['retired', 'draft'], ['retired', 'in_review'], ['retired', 'approved']] as const)(
    'named forbidden transition %s -> %s -> smartreport.library_invalid_transition', (from, to) => {
      expect(refused(() => assertTransition(from, to))).toBe('smartreport.library_invalid_transition');
    });
  it.each(STATUSES)('assertEditable(%s): only draft may be edited', (s) => {
    expect(refused(() => assertEditable(s))).toBe(s === 'draft' ? undefined : 'smartreport.library_invalid_transition');
  });
  it('unknown status values are refused (fail closed)', () => {
    expect(canTransition('draft' as never, 'bogus' as never)).toBe(false);
    expect(refused(() => assertEditable('bogus' as never))).toBeDefined();
  });
});
