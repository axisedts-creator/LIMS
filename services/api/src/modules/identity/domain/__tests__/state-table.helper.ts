// T3 shared helper: asserts a pure state table equals the 03-APP-FLOW §2 edge list exactly
// (every listed edge allowed, every other (from,to) pair forbidden). `null` = "(none)" (creation).
import { describe, expect, it } from 'vitest';

export type Edge = readonly [string | null, string];

export function checkStateTable(
  name: string,
  states: readonly string[],
  expectedStates: readonly string[],
  canTransition: (from: never, to: never) => boolean,
  allowed: readonly Edge[],
  withCreation: boolean,
): void {
  const can = canTransition as (f: string | null, t: string) => boolean;
  const key = (f: string | null, t: string) => `${f ?? '(none)'} -> ${t}`;
  const allowedKeys = new Set(allowed.map(([f, t]) => key(f, t)));
  const sources: (string | null)[] = withCreation ? [null, ...expectedStates] : [...expectedStates];
  const forbidden: Edge[] = [];
  for (const f of sources) for (const t of expectedStates) if (!allowedKeys.has(key(f, t))) forbidden.push([f, t]);

  describe(`${name} state table`, () => {
    it('STATES equals the schema CHECK set', () => {
      expect([...states].sort()).toEqual([...expectedStates].sort());
    });
    it.each(allowed.map((e) => [key(e[0], e[1]), e] as const))('allows %s', (_k, [f, t]) => {
      expect(can(f, t)).toBe(true);
    });
    it.each(forbidden.map((e) => [key(e[0], e[1]), e] as const))('forbids %s', (_k, [f, t]) => {
      expect(can(f, t)).toBe(false);
    });
  });
}
