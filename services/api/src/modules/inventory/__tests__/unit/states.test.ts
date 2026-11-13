// C12.T-02 — state tables of 03-APP-FLOW §3.1–§3.6 (AC-05.7, AC-10.4, AC-06.8; contracts/errors.yaml inventory.*_invalid_transition).
// Expected interface, one module per table (pure, like modules/anatomic/domain/case.state.ts):
//   domain/po.state.ts, grn.state.ts, transfer.state.ts, count.state.ts, container.state.ts each export
//     canTransition(from: State | null, to: State): boolean       (null = ∅, i.e. creation)
//     assertTransition(from: State | null, to: State): void       throws .code 'inventory.po_invalid_transition' (PO) or 'inventory.document_invalid_transition' (the rest)
//   domain/fact.state.ts exports canTransition(from, to, source) / assertTransition(from, to, source), source 'event'|'manual'|'cron';
//     posted → reversed is allowed for 'manual' only; for 'event'/'cron' it throws 'inventory.fact_not_reversible'; every other forbidden edge throws 'inventory.document_invalid_transition'.
// Oracle: the allowed-edge lists below are transcribed from 03-APP-FLOW §3 (rows P1–P9, G1–G4, T1–T4, K1–K4, §3.5, C2–C4). Everything else must be forbidden.
import { describe, expect, it } from 'vitest';
import * as count from '../../domain/count.state.js';
import * as container from '../../domain/container.state.js';
import * as fact from '../../domain/fact.state.js';
import * as grn from '../../domain/grn.state.js';
import * as po from '../../domain/po.state.js';
import * as transfer from '../../domain/transfer.state.js';
import { codeOf } from './helpers.js';

type Edge = readonly [from: string | null, to: string];

interface Machine {
  name: string;
  states: readonly string[];
  /** every allowed edge, including creation (null → initial) and the allowed self edges */
  allowed: readonly Edge[];
  /** self edges that are explicitly forbidden in the spec (checked in addition to every from ≠ to pair) */
  forbiddenSelf: readonly string[];
  /** a representative forbidden edge per state (done_when: "one forbidden per state") */
  forbiddenEach: readonly Edge[];
  can: (from: never, to: never) => boolean;
  assert: (from: never, to: never) => void;
  code: string;
}

const PO = 'inventory.po_invalid_transition';
const DOC = 'inventory.document_invalid_transition';

const MACHINES: Machine[] = [
  {
    name: 'purchase order (§3.1, AC-05.7)',
    states: ['draft', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled'],
    allowed: [
      [null, 'draft'], // P1
      ['draft', 'draft'], // P2 replace
      ['draft', 'approved'], // P3
      ['approved', 'sent'], // P4
      ['approved', 'partially_received'], ['approved', 'received'], ['sent', 'partially_received'], ['sent', 'received'], // P5
      ['partially_received', 'partially_received'], ['partially_received', 'received'], // P5
      ['draft', 'cancelled'], // P6
      ['approved', 'cancelled'], ['sent', 'cancelled'], // P7
      ['partially_received', 'closed'], // P8
      ['received', 'closed'], // P9
    ],
    forbiddenSelf: ['approved', 'sent', 'received', 'closed', 'cancelled'], // "approve twice" and every terminal/other self edge
    forbiddenEach: [
      ['draft', 'sent'], ['draft', 'received'], // explicit
      ['approved', 'draft'], ['approved', 'closed'], ['sent', 'approved'], ['sent', 'closed'],
      ['partially_received', 'cancelled'], ['received', 'cancelled'], // explicit
      ['received', 'partially_received'], ['closed', 'draft'], ['closed', 'cancelled'], ['cancelled', 'draft'], ['cancelled', 'approved'],
    ],
    can: po.canTransition as never,
    assert: po.assertTransition as never,
    code: PO,
  },
  {
    name: 'goods receipt (§3.2)',
    states: ['draft', 'posted', 'cancelled'],
    allowed: [[null, 'draft'], ['draft', 'draft'], ['draft', 'posted'], ['draft', 'cancelled']],
    forbiddenSelf: ['posted', 'cancelled'],
    forbiddenEach: [['posted', 'draft'], ['posted', 'cancelled'], ['cancelled', 'draft'], ['cancelled', 'posted']], // posted → *, cancelled → *
    can: grn.canTransition as never,
    assert: grn.assertTransition as never,
    code: DOC,
  },
  {
    name: 'transfer (§3.3, AC-10.4)',
    states: ['draft', 'dispatched', 'received', 'cancelled'],
    allowed: [[null, 'draft'], ['draft', 'draft'], ['draft', 'dispatched'], ['dispatched', 'received'], ['draft', 'cancelled']],
    forbiddenSelf: ['dispatched', 'received', 'cancelled'],
    forbiddenEach: [
      ['draft', 'received'], ['dispatched', 'cancelled'], ['dispatched', 'draft'], // explicit: stock in transit must be received
      ['received', 'dispatched'], ['received', 'cancelled'], ['received', 'draft'], // explicit: received → *
      ['cancelled', 'draft'], ['cancelled', 'dispatched'], ['cancelled', 'received'], // explicit: cancelled → *
    ],
    can: transfer.canTransition as never,
    assert: transfer.assertTransition as never,
    code: DOC,
  },
  {
    name: 'stock count (§3.4)',
    states: ['open', 'posted', 'cancelled'],
    allowed: [[null, 'open'], ['open', 'open'], ['open', 'posted'], ['open', 'cancelled']],
    forbiddenSelf: ['posted', 'cancelled'],
    forbiddenEach: [['posted', 'open'], ['posted', 'cancelled'], ['cancelled', 'open'], ['cancelled', 'posted']],
    can: count.canTransition as never,
    assert: count.assertTransition as never,
    code: DOC,
  },
  {
    name: 'opened container (§3.5)',
    states: ['open', 'finished', 'discarded'],
    allowed: [[null, 'open'], ['open', 'finished'], ['open', 'discarded']],
    forbiddenSelf: ['finished', 'discarded'],
    forbiddenEach: [['finished', 'open'], ['finished', 'discarded'], ['discarded', 'open'], ['discarded', 'finished']],
    can: container.canTransition as never,
    assert: container.assertTransition as never,
    code: DOC,
  },
];

const key = (e: Edge) => `${e[0]}→${e[1]}`;

describe.each(MACHINES)('$name', (m) => {
  const can = m.can as unknown as (f: string | null, t: string) => boolean;
  const assertT = m.assert as unknown as (f: string | null, t: string) => void;
  const allowed = new Set(m.allowed.map(key));

  it.each(m.allowed.map((e) => [key(e), e] as const))('allowed %s', (_k, [from, to]) => {
    expect(can(from, to)).toBe(true);
    expect(() => assertT(from, to)).not.toThrow();
  });

  it('every forbidden edge listed per state is rejected with the contract code', () => {
    expect(m.forbiddenEach.length).toBeGreaterThanOrEqual(m.states.length - 1);
    for (const [from, to] of m.forbiddenEach) {
      expect(allowed.has(key([from, to])), `oracle bug: ${from}→${to} is also allowed`).toBe(false);
      expect(can(from, to), `canTransition ${from}→${to}`).toBe(false);
      expect(codeOf(() => assertT(from, to)), `assertTransition ${from}→${to}`).toBe(m.code);
    }
  });

  it('EVERY pair of distinct states that is not an allowed edge is forbidden (the table is closed)', () => {
    const bad: string[] = [];
    for (const from of m.states) {
      for (const to of m.states) {
        if (from === to || allowed.has(key([from, to]))) continue;
        if (can(from, to) || codeOf(() => assertT(from, to)) !== m.code) bad.push(`${from}→${to}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('forbidden self edges are rejected', () => {
    for (const s of m.forbiddenSelf) {
      expect(can(s, s), `${s}→${s}`).toBe(false);
      expect(codeOf(() => assertT(s, s))).toBe(m.code);
    }
  });

  it('creation (∅ →) is allowed only into the initial state', () => {
    for (const to of m.states) {
      const ok = allowed.has(key([null, to]));
      expect(can(null, to), `∅→${to}`).toBe(ok);
      if (!ok) expect(codeOf(() => assertT(null, to))).toBe(m.code);
    }
  });

  it('unknown or hostile state names are rejected, never matched', () => {
    for (const bad of ['', 'bogus', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'DRAFT', 'draft ']) {
      expect(can(bad, m.states[0]!), `from ${JSON.stringify(bad)}`).toBe(false);
      expect(can(m.states[0]!, bad), `to ${JSON.stringify(bad)}`).toBe(false);
      expect(codeOf(() => assertT(bad, m.states[0]!))).toBe(m.code);
      expect(codeOf(() => assertT(m.states[0]!, bad))).toBe(m.code);
    }
  });
});

describe('PO specifics (AC-05.7): terminal states have no outgoing edge', () => {
  const states = ['draft', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled'];
  it.each(['closed', 'cancelled'])('%s → anything is 409 inventory.po_invalid_transition', (from) => {
    for (const to of states) expect(codeOf(() => po.assertTransition(from as never, to as never)), `${from}→${to}`).toBe(PO);
  });
  it('approve twice is forbidden', () => {
    expect(codeOf(() => po.assertTransition('approved', 'approved'))).toBe(PO);
  });
  it('a posted GRN (partially_received) can no longer be cancelled, only closed (AC-05.5)', () => {
    expect(po.canTransition('partially_received', 'cancelled')).toBe(false);
    expect(po.canTransition('partially_received', 'closed')).toBe(true);
  });
});

describe('consumption fact (§3.6 C2–C4; errors: fact_not_reversible, document_invalid_transition)', () => {
  const FACT_STATES = ['posted', 'no_rule', 'unresolved', 'dismissed', 'reversed'] as const;
  type FS = (typeof FACT_STATES)[number];
  const ALLOWED: Edge[] = [['unresolved', 'posted'], ['unresolved', 'dismissed'], ['posted', 'reversed']]; // C2, C3, C4
  const SOURCES = ['event', 'manual', 'cron'] as const;
  const call = (from: FS, to: FS, source: (typeof SOURCES)[number]) => codeOf(() => fact.assertTransition(from, to, source));

  it.each([['unresolved', 'posted'], ['unresolved', 'dismissed']] as const)('allowed %s→%s for every source', (from, to) => {
    for (const s of SOURCES) {
      expect(fact.canTransition(from, to, s)).toBe(true);
      expect(call(from, to, s)).toBe('<no throw>');
    }
  });
  it('allowed posted→reversed for a manual fact (AC-15.4)', () => {
    expect(fact.canTransition('posted', 'reversed', 'manual')).toBe(true);
    expect(call('posted', 'reversed', 'manual')).toBe('<no throw>');
  });
  it.each(['event', 'cron'] as const)('posted→reversed for a %s fact is 409 inventory.fact_not_reversible', (s) => {
    expect(fact.canTransition('posted', 'reversed', s)).toBe(false);
    expect(call('posted', 'reversed', s)).toBe('inventory.fact_not_reversible');
  });
  it('no_rule → * is forbidden (rules are not retroactive)', () => {
    for (const to of FACT_STATES) for (const s of SOURCES) expect(call('no_rule', to, s), `no_rule→${to} ${s}`).toBe(DOC);
  });
  it.each(['dismissed', 'reversed'] as const)('%s → * is forbidden', (from) => {
    for (const to of FACT_STATES) for (const s of SOURCES) expect(call(from, to, s), `${from}→${to} ${s}`).toBe(DOC);
  });
  it('every other pair is forbidden with document_invalid_transition (the table is closed)', () => {
    const allowed = new Set(ALLOWED.map(key));
    const bad: string[] = [];
    for (const from of FACT_STATES)
      for (const to of FACT_STATES) {
        if (from === to || allowed.has(key([from, to]))) continue;
        for (const s of SOURCES) if (call(from, to, s) !== DOC) bad.push(`${from}→${to} (${s})`);
      }
    expect(bad).toEqual([]);
  });
  it('a same-status write is not a transition and is forbidden here (value_paisa_total updates bypass the table)', () => {
    for (const s of FACT_STATES) expect(fact.canTransition(s, s, 'manual')).toBe(false);
  });
  it('unknown source or state never opens an edge', () => {
    expect(fact.canTransition('posted', 'reversed', 'bogus' as never)).toBe(false);
    expect(fact.canTransition('posted', 'reversed', undefined as never)).toBe(false);
    expect(fact.canTransition('__proto__' as never, 'posted', 'manual')).toBe(false);
  });
});
