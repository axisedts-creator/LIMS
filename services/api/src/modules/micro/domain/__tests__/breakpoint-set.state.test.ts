// C10-T02 breakpoint-set.state.ts (03-APP-FLOW §2.5 B1–B6; AC-13.5).
// Assumed API:
//   BREAKPOINT_STATUSES
//   canTransition(from: BpStatus | null, to: BpStatus): boolean
//   assertTransition(from, to): throws LimsError('micro.breakpoint_set_invalid_transition') (409)
//   assertFourEyes({ actorId, createdBy }): throws LimsError('micro.breakpoint_four_eyes_required') (403) when actor === creator
//   retireEffectiveTo(now: Date, effectiveFrom: Date): Date   = greatest(now, effectiveFrom)   (B5)
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { BREAKPOINT_STATUSES, assertFourEyes, assertTransition, canTransition, retireEffectiveTo } from '../breakpoint-set.state.js';

type S = 'uploaded' | 'validating' | 'validated' | 'invalid' | 'active' | 'retired' | 'discarded';
const ALLOWED: Record<string, S[]> = {
  null: ['uploaded'], // B1
  uploaded: ['validating', 'discarded'], // B2, B6
  validating: ['validated', 'invalid'], // B3 (no validating -> validating: retried job leaves status as is)
  validated: ['active', 'discarded'], // B4, B6
  invalid: ['discarded'], // B6
  active: ['retired'], // B5
  retired: [],
  discarded: [],
};
const bad = (f: () => unknown, code: string) => {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(LimsError); expect((e as LimsError).code).toBe(code); return; }
  throw new Error(`expected ${code}`);
};

describe('breakpoint set state table', () => {
  it('has exactly the seven DB states', () =>
    expect([...BREAKPOINT_STATUSES].sort()).toEqual(['active', 'discarded', 'invalid', 'retired', 'uploaded', 'validated', 'validating']));

  it('B1 null -> uploaded', () => expect(canTransition(null, 'uploaded')).toBe(true));
  it('B2 uploaded -> validating', () => expect(canTransition('uploaded', 'validating')).toBe(true));
  it.each(['validated', 'invalid'] as S[])('B3 validating -> %s', (to) => expect(canTransition('validating', to)).toBe(true));
  it('B4 validated -> active', () => expect(canTransition('validated', 'active')).toBe(true));
  it('B5 active -> retired', () => expect(canTransition('active', 'retired')).toBe(true));
  it.each(['uploaded', 'validated', 'invalid'] as S[])('B6 %s -> discarded', (f) => expect(canTransition(f, 'discarded')).toBe(true));

  const froms = [null, ...BREAKPOINT_STATUSES] as (S | null)[];
  const pairs = froms.flatMap((f) => BREAKPOINT_STATUSES.map((t) => [f, t] as const));
  it.each(pairs)('matrix %s -> %s', (from, to) => {
    const ok = ALLOWED[String(from)]!.includes(to as S);
    expect(canTransition(from as never, to as never)).toBe(ok);
    if (ok) expect(() => assertTransition(from as never, to as never)).not.toThrow();
    else bad(() => assertTransition(from as never, to as never), 'micro.breakpoint_set_invalid_transition');
  });

  describe('forbidden (one per rule)', () => {
    it('B1: nothing but uploaded can be created', () => expect(canTransition(null, 'active')).toBe(false));
    it('B2: retried job does not move validating -> validating', () => expect(canTransition('validating', 'validating')).toBe(false));
    it('B3: validating cannot skip to active', () => expect(canTransition('validating', 'active')).toBe(false));
    it('B4: invalid -> active (must be validated)', () => bad(() => assertTransition('invalid', 'active'), 'micro.breakpoint_set_invalid_transition'));
    it('B5: validated -> retired', () => expect(canTransition('validated', 'retired')).toBe(false));
    it('retired is terminal', () => BREAKPOINT_STATUSES.forEach((t) => expect(canTransition('retired', t)).toBe(false)));
    it('maps to HTTP 409', () => { try { assertTransition('retired', 'active'); } catch (e) { expect((e as LimsError).statusCode).toBe(409); } });
  });

  describe('AC-13.5 discard only from uploaded / validated / invalid', () => {
    it.each(['validating', 'active', 'retired', 'discarded'] as S[])('%s -> discarded is 409', (f) =>
      bad(() => assertTransition(f, 'discarded'), 'micro.breakpoint_set_invalid_transition'));
    it.each(['uploaded', 'validated', 'invalid'] as S[])('%s -> discarded is allowed', (f) => expect(() => assertTransition(f, 'discarded')).not.toThrow());
  });

  describe('B4 guard: actor must differ from created_by', () => {
    it('same user -> micro.breakpoint_four_eyes_required', () => bad(() => assertFourEyes({ actorId: 'u-1', createdBy: 'u-1' }), 'micro.breakpoint_four_eyes_required'));
    it('maps to HTTP 403', () => { try { assertFourEyes({ actorId: 'u-1', createdBy: 'u-1' }); } catch (e) { expect((e as LimsError).statusCode).toBe(403); } });
    it('different user passes', () => expect(() => assertFourEyes({ actorId: 'u-2', createdBy: 'u-1' })).not.toThrow());
  });

  describe('B5 effective_to = greatest(now, effective_from)', () => {
    const now = new Date('2026-11-12T10:00:00Z');
    it('past effective_from -> now', () => expect(retireEffectiveTo(now, new Date('2026-11-01T00:00:00Z'))).toEqual(now));
    it('future effective_from -> effective_from', () => {
      const future = new Date('2026-12-01T00:00:00Z');
      expect(retireEffectiveTo(now, future)).toEqual(future);
    });
  });

  it('rejects unknown / prototype statuses', () => {
    expect(canTransition('__proto__' as never, 'discarded')).toBe(false);
    expect(canTransition('uploaded', 'constructor' as never)).toBe(false);
  });
});
