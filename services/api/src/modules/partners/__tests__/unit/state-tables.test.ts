// C13 T04 — the six partners state tables (03-APP-FLOW §2.1–2.6). done_when: every allowed transition + forbidden ones per state.
// Every table is checked as a FULL matrix: the allowed edge list below is the only set that may pass; every other (from,to) pair must fail.
// ACs: US-04.7 (non-draft edit -> manifest_not_editable), US-04.10 (withdraw after conversion -> manifest_invalid_transition),
//      US-04.9 (withdraw unavailable in on_submit). Pending-receipt definition = 03-APP-FLOW §2.1 (08 A19 D-104).
// SEAMS (spec fixes the tables and error codes, not the signatures). Each file under ../../domain/ exports:
//   <X>_STATES readonly tuple; canTransition(from: S | null, to: S): boolean (null = no row yet); assertTransition(from, to): void
//   -> throws LimsError(<code>). Files/consts/codes:
//   manifest.state.ts          MANIFEST_STATES          partners.manifest_invalid_transition
//   manifest-line.state.ts     MANIFEST_LINE_STATES     partners.manifest_line_invalid_transition
//   pickup.state.ts            PICKUP_STATES            partners.pickup_invalid_transition
//   partner.state.ts           PARTNER_STATUSES         partners.partner_invalid_transition
//   partner-user.state.ts      PARTNER_USER_STATUSES    partners.partner_user_invalid_transition
//   referrer-mapping.state.ts  REFERRER_MAPPING_STATES  partners.referrer_invalid_transition
//   manifest.state.ts also: assertEditable(state) -> partners.manifest_not_editable unless 'draft';
//     assertWithdrawable({ state, conversionMode, lineStates }) -> partners.manifest_invalid_transition;
//     isPendingReceipt(line: {state, sampleReceivedAt: string|null, sampleMissing: boolean}, mode): boolean;
//     stateAfterReceipt(mode, lines): 'partially_received' | 'received'.
// Fails now: the ../../domain/*.state.js modules do not exist.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { MANIFEST_STATES, assertEditable, assertTransition as assertManifest, assertWithdrawable, canTransition as canManifest,
  isPendingReceipt, stateAfterReceipt } from '../../domain/manifest.state.js';
import { MANIFEST_LINE_STATES, assertTransition as assertLine, canTransition as canLine } from '../../domain/manifest-line.state.js';
import { PICKUP_STATES, assertTransition as assertPickup, canTransition as canPickup } from '../../domain/pickup.state.js';
import { PARTNER_STATUSES, assertTransition as assertPartner, canTransition as canPartner } from '../../domain/partner.state.js';
import { PARTNER_USER_STATUSES, assertTransition as assertUser, canTransition as canUser } from '../../domain/partner-user.state.js';
import { REFERRER_MAPPING_STATES, assertTransition as assertRef, canTransition as canRef } from '../../domain/referrer-mapping.state.js';

type Edge = readonly [string | null, string, string];
interface Machine {
  name: string; states: readonly string[]; code: string; allowed: readonly Edge[];
  can: (f: any, t: any) => boolean; assert: (f: any, t: any) => void;
}

const MACHINES: readonly Machine[] = [
  {
    name: 'manifest 2.1', states: MANIFEST_STATES, code: 'partners.manifest_invalid_transition', can: canManifest, assert: assertManifest,
    allowed: [[null, 'draft', 'MS1'], ['draft', 'draft', 'MS2'], ['draft', 'submitted', 'MS3'], ['draft', 'discarded', 'MS4'],
      ['submitted', 'withdrawn', 'MS5'], ['submitted', 'partially_received', 'MS6'], ['submitted', 'received', 'MS7'],
      ['partially_received', 'received', 'MS7'], ['partially_received', 'partially_received', 'MS8']],
  },
  {
    name: 'manifest line 2.2', states: MANIFEST_LINE_STATES, code: 'partners.manifest_line_invalid_transition', can: canLine, assert: assertLine,
    allowed: [[null, 'draft', 'LS1'], ['draft', 'submitted', 'LS2'], ['draft', 'converting', 'LS2b'], ['submitted', 'converting', 'LS3'],
      ['submitted', 'not_received', 'LS4'], ['converting', 'converted', 'LS5'], ['converting', 'conversion_failed', 'LS6'],
      ['conversion_failed', 'converting', 'LS7'], ['conversion_failed', 'not_received', 'LS8'], ['converted', 'cancelled', 'LS9'],
      ['submitted', 'withdrawn', 'LS10'], ['draft', 'discarded', 'LS11']],
  },
  {
    name: 'pickup 2.3', states: PICKUP_STATES, code: 'partners.pickup_invalid_transition', can: canPickup, assert: assertPickup,
    allowed: [[null, 'requested', 'K1'], ['requested', 'scheduled', 'SP2'], ['scheduled', 'scheduled', 'SP2 reschedule'],
      ['requested', 'picked_up', 'SP3'], ['scheduled', 'picked_up', 'SP3'], ['requested', 'cancelled', 'K4/MS5'],
      ['scheduled', 'cancelled', 'K4/MS5'], ['requested', 'rejected', 'SP4'], ['scheduled', 'rejected', 'SP4']],
  },
  {
    name: 'partner 2.4', states: PARTNER_STATUSES, code: 'partners.partner_invalid_transition', can: canPartner, assert: assertPartner,
    allowed: [[null, 'active', 'SA2'], ['active', 'suspended', 'SA5'], ['suspended', 'active', 'SA6']],
  },
  {
    name: 'partner user 2.5', states: PARTNER_USER_STATUSES, code: 'partners.partner_user_invalid_transition', can: canUser, assert: assertUser,
    allowed: [[null, 'invited', 'U2/SA9'], ['invited', 'active', 'first request'], ['invited', 'deactivated', 'U4'], ['active', 'deactivated', 'U4'],
      ['deactivated', 'active', 'U5'], ['deactivated', 'invited', 'U5 (C2 status)'], ['invited', 'invited', 'U3/U6'], ['active', 'active', 'U3']],
  },
  {
    name: 'referrer mapping 2.6', states: REFERRER_MAPPING_STATES, code: 'partners.referrer_invalid_transition', can: canRef, assert: assertRef,
    allowed: [[null, 'unmapped', 'F2'], ['unmapped', 'mapped', 'SR2'], ['unmapped', 'rejected', 'SR3 reject'], ['mapped', 'unmapped', 'SR3 unmap'],
      ['rejected', 'unmapped', 'F3']],
  },
];

const EXPECTED_STATES: Record<string, readonly string[]> = {
  'manifest 2.1': ['draft', 'submitted', 'partially_received', 'received', 'withdrawn', 'discarded'], // 05-SCHEMA manifests__state__ck
  'manifest line 2.2': ['draft', 'submitted', 'converting', 'converted', 'conversion_failed', 'not_received', 'cancelled', 'withdrawn', 'discarded'],
  'pickup 2.3': ['requested', 'scheduled', 'picked_up', 'cancelled', 'rejected'],
  'partner 2.4': ['active', 'suspended'],
  'partner user 2.5': ['invited', 'active', 'deactivated'],
  'referrer mapping 2.6': ['unmapped', 'mapped', 'rejected'],
};

describe.each(MACHINES)('state table: $name', (m) => {
  it('declares exactly the spec states', () => {
    expect([...m.states].sort()).toEqual([...EXPECTED_STATES[m.name]!].sort());
  });

  it.each(m.allowed)('allows %s -> %s (%s)', (from, to) => {
    expect(m.can(from, to)).toBe(true);
    expect(() => m.assert(from, to)).not.toThrow();
  });

  it('forbids every other (from,to) pair — full matrix — with the module error code', () => {
    const allowed = new Set(m.allowed.map(([f, t]) => `${f}>${t}`));
    const froms: Array<string | null> = [null, ...m.states];
    let checked = 0;
    for (const f of froms) for (const t of m.states) {
      if (allowed.has(`${f}>${t}`)) continue;
      checked++;
      expect(m.can(f, t), `${f} -> ${t} must be forbidden`).toBe(false);
      let err: unknown;
      try { m.assert(f, t); } catch (e) { err = e; }
      expect(err, `${f} -> ${t} must throw`).toBeInstanceOf(LimsError);
      expect((err as LimsError).code).toBe(m.code);
      expect((err as LimsError).statusCode).toBe(409);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('every declared state is the target of at least one allowed edge (reachable)', () => {
    for (const s of m.states) expect(m.allowed.some(([, t]) => t === s), `${s} must be reachable`).toBe(true);
  });

  it('rejects an unknown state and prototype keys instead of treating them as allowed', () => {
    for (const bad of ['', 'DRAFT', '__proto__', 'constructor', 'toString', 'nonsense']) {
      expect(m.can(bad, m.states[0]!)).toBe(false);
      expect(m.can(m.states[0]!, bad)).toBe(false);
      expect(() => m.assert(bad, bad)).toThrow(LimsError);
    }
  });
});

describe('forbidden examples named in the spec (03-APP-FLOW §2.1/§2.2)', () => {
  it('manifest: submitted->draft, received/withdrawn/discarded -> anything, draft->withdrawn', () => {
    expect(canManifest('submitted', 'draft')).toBe(false);
    expect(canManifest('draft', 'withdrawn')).toBe(false);
    for (const from of ['received', 'withdrawn', 'discarded'] as const)
      for (const to of MANIFEST_STATES) expect(canManifest(from, to), `${from}->${to}`).toBe(false);
  });
  it('line: converted->converting and any exit from cancelled/withdrawn/discarded/not_received', () => {
    expect(canLine('converted', 'converting')).toBe(false);
    expect(() => assertLine('converted', 'converting')).toThrow(expect.objectContaining({ code: 'partners.manifest_line_invalid_transition' }));
    for (const from of ['cancelled', 'withdrawn', 'discarded', 'not_received'] as const)
      for (const to of MANIFEST_LINE_STATES) expect(canLine(from, to), `${from}->${to}`).toBe(false);
  });
  it('pickup: nothing leaves picked_up / cancelled / rejected', () => {
    for (const from of ['picked_up', 'cancelled', 'rejected'] as const)
      for (const to of PICKUP_STATES) expect(canPickup(from, to), `${from}->${to}`).toBe(false);
  });
});

describe('US-04.7: line/manifest edits on a non-draft manifest -> 409 partners.manifest_not_editable', () => {
  it('draft is editable', () => { expect(() => assertEditable('draft')).not.toThrow(); });
  it.each(['submitted', 'partially_received', 'received', 'withdrawn', 'discarded'] as const)('%s is not editable', (s) => {
    expect(() => assertEditable(s)).toThrow(expect.objectContaining({ code: 'partners.manifest_not_editable' }));
    try { assertEditable(s); } catch (e) { expect((e as LimsError).statusCode).toBe(409); }
  });
});

describe('US-04.9/US-04.10 withdraw guard (MS5)', () => {
  const ok = { state: 'submitted', conversionMode: 'on_receipt', lineStates: ['submitted', 'submitted'] } as const;
  const bad = (o: Partial<Parameters<typeof assertWithdrawable>[0]>) =>
    expect(() => assertWithdrawable({ ...ok, ...o } as any)).toThrow(expect.objectContaining({ code: 'partners.manifest_invalid_transition' }));

  it('allows a submitted on_receipt manifest with no converting/converted line', () => {
    expect(() => assertWithdrawable(ok)).not.toThrow();
    expect(() => assertWithdrawable({ ...ok, lineStates: ['submitted', 'not_received'] })).not.toThrow();
  });
  it('US-04.10: a converted line blocks withdraw', () => bad({ lineStates: ['submitted', 'converted'] }));
  it('a converting line blocks withdraw', () => bad({ lineStates: ['converting', 'submitted'] }));
  it('US-04.9: mode on_submit never allows withdraw', () => { bad({ conversionMode: 'on_submit' }); bad({ conversionMode: 'on_submit', lineStates: ['converting'] }); });
  it.each(['draft', 'partially_received', 'received', 'withdrawn', 'discarded'] as const)('manifest state %s cannot be withdrawn', (s) => bad({ state: s }));
});

describe('pending receipt + MS6/MS7/MS8 (03-APP-FLOW §2.1 definition, D-104)', () => {
  const L = (state: string, sampleReceivedAt: string | null = null, sampleMissing = false) => ({ state, sampleReceivedAt, sampleMissing }) as any;
  it('on_receipt: pending iff state = submitted', () => {
    expect(isPendingReceipt(L('submitted'), 'on_receipt')).toBe(true);
    for (const s of ['converting', 'converted', 'conversion_failed', 'not_received', 'withdrawn', 'cancelled'])
      expect(isPendingReceipt(L(s), 'on_receipt'), s).toBe(false);
  });
  it('on_submit: pending iff no receipt timestamp, not missing, and state converting/converted/conversion_failed', () => {
    for (const s of ['converting', 'converted', 'conversion_failed']) {
      expect(isPendingReceipt(L(s), 'on_submit'), s).toBe(true);
      expect(isPendingReceipt(L(s, '2026-11-13T08:00:00Z'), 'on_submit'), `${s} received`).toBe(false);
      expect(isPendingReceipt(L(s, null, true), 'on_submit'), `${s} missing`).toBe(false);
    }
    for (const s of ['submitted', 'draft', 'not_received', 'cancelled']) expect(isPendingReceipt(L(s), 'on_submit'), s).toBe(false);
  });
  it('MS6/MS8: some line still pending -> partially_received; MS7: none pending -> received', () => {
    expect(stateAfterReceipt('on_receipt', [L('converting'), L('submitted')])).toBe('partially_received');
    expect(stateAfterReceipt('on_receipt', [L('converting'), L('not_received')])).toBe('received');
    expect(stateAfterReceipt('on_submit', [L('converted', '2026-11-13T08:00:00Z'), L('converting')])).toBe('partially_received');
    expect(stateAfterReceipt('on_submit', [L('converted', '2026-11-13T08:00:00Z'), L('converting', null, true)])).toBe('received');
  });
});
