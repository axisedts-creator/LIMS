// API-T02 — AC-04.5, 03-APP-FLOW §2.1/§2.2/§2.3/§2.5. Every allowed transition + EVERY forbidden (state, action) pair per machine.
// Expected API (domain/*.ts, pure, throws an Error with .code === 'instruments.invalid_transition' on a forbidden move):
//   agent.state.ts       agentNext(from: AgentStatus | null, action: 'create'|'enrol'|'revoke'|'retire', guard?: { hasNonRetiredInstruments?: boolean }): AgentStatus
//   instrument.state.ts  instrumentNext(from: InstrumentState | null, action: 'create'|'startCommissioning'|'goLive'|'suspend'|'resume'|'retire'): InstrumentState
//   credential.state.ts  credentialNext(from: CredentialStatus, action: 'redeem'|'expire'|'revoke', kind: 'enrolment_code'|'device_token'): CredentialStatus
//   command.state.ts     commandNext(from: CommandState, action: 'deliver'|'complete'|'fail'|'expire'): CommandState
import { describe, expect, it } from 'vitest';
import { agentNext } from '../../domain/agent.state.js';
import { instrumentNext } from '../../domain/instrument.state.js';
import { credentialNext } from '../../domain/credential.state.js';
import { commandNext } from '../../domain/command.state.js';

function expectInvalid(fn: () => unknown): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected a throw').toBeInstanceOf(Error);
  expect((err as { code?: string }).code).toBe('instruments.invalid_transition');
}

type Row<S, A> = readonly [from: S | null, action: A, to: S];

describe('agent machine (§2.1)', () => {
  type S = 'pending_enrolment' | 'active' | 'revoked' | 'retired';
  type A = 'create' | 'enrol' | 'revoke' | 'retire';
  const STATES: (S | null)[] = [null, 'pending_enrolment', 'active', 'revoked', 'retired'];
  const ACTIONS: A[] = ['create', 'enrol', 'revoke', 'retire'];
  const allowed: Row<S, A>[] = [
    [null, 'create', 'pending_enrolment'],
    ['pending_enrolment', 'enrol', 'active'],
    ['active', 'enrol', 'active'],
    ['revoked', 'enrol', 'active'],
    ['pending_enrolment', 'revoke', 'revoked'],
    ['active', 'revoke', 'revoked'],
    ['pending_enrolment', 'retire', 'retired'],
    ['active', 'retire', 'retired'],
    ['revoked', 'retire', 'retired'],
  ];
  it.each(allowed)('%s --%s--> %s', (from, action, to) => {
    expect(agentNext(from, action)).toBe(to);
  });
  const forbidden = STATES.flatMap((s) => ACTIONS.map((a) => [s, a] as const)).filter(
    ([s, a]) => !allowed.some(([f, x]) => f === s && x === a),
  );
  it('forbidden set size (matrix sanity)', () => expect(forbidden.length).toBe(11));
  it.each(forbidden)('%s --%s--> 409 instruments.invalid_transition', (from, action) => {
    expectInvalid(() => agentNext(from, action));
  });
  it('spec example: revoke on retired is invalid_transition', () => expectInvalid(() => agentNext('retired', 'revoke')));
  it('A6 guard: retire with non-retired instruments is refused; without is allowed', () => {
    expect(() => agentNext('active', 'retire', { hasNonRetiredInstruments: true })).toThrow();
    expect(agentNext('active', 'retire', { hasNonRetiredInstruments: false })).toBe('retired');
  });
});

describe('instrument commissioning machine (§2.2)', () => {
  type S = 'draft' | 'commissioning' | 'live' | 'suspended' | 'retired';
  type A = 'create' | 'startCommissioning' | 'goLive' | 'suspend' | 'resume' | 'retire';
  const STATES: (S | null)[] = [null, 'draft', 'commissioning', 'live', 'suspended', 'retired'];
  const ACTIONS: A[] = ['create', 'startCommissioning', 'goLive', 'suspend', 'resume', 'retire'];
  const allowed: Row<S, A>[] = [
    [null, 'create', 'draft'],
    ['draft', 'startCommissioning', 'commissioning'],
    ['commissioning', 'goLive', 'live'],
    ['live', 'suspend', 'suspended'],
    ['suspended', 'resume', 'live'],
    ['draft', 'retire', 'retired'],
    ['commissioning', 'retire', 'retired'],
    ['live', 'retire', 'retired'],
    ['suspended', 'retire', 'retired'],
  ];
  it.each(allowed)('%s --%s--> %s', (from, action, to) => {
    expect(instrumentNext(from, action)).toBe(to);
  });
  const forbidden = STATES.flatMap((s) => ACTIONS.map((a) => [s, a] as const)).filter(
    ([s, a]) => !allowed.some(([f, x]) => f === s && x === a),
  );
  it('forbidden set size (matrix sanity)', () => expect(forbidden.length).toBe(27));
  it.each(forbidden)('%s --%s--> 409 instruments.invalid_transition', (from, action) => {
    expectInvalid(() => instrumentNext(from, action));
  });
  it('commissioning cannot go back to draft; draft cannot skip to live', () => {
    expectInvalid(() => instrumentNext('commissioning', 'create'));
    expectInvalid(() => instrumentNext('draft', 'goLive'));
  });
});

describe('credential machine (§2.3)', () => {
  type S = 'active' | 'used' | 'expired' | 'revoked';
  type A = 'redeem' | 'expire' | 'revoke';
  const ACTIONS: A[] = ['redeem', 'expire', 'revoke'];
  it.each([
    ['active', 'redeem', 'used'],
    ['active', 'expire', 'expired'],
    ['active', 'revoke', 'revoked'],
  ] as Row<S, A>[])('enrolment_code %s --%s--> %s', (from, action, to) => {
    expect(credentialNext(from as S, action, 'enrolment_code')).toBe(to);
  });
  it('device_token active --revoke--> revoked', () =>
    expect(credentialNext('active', 'revoke', 'device_token')).toBe('revoked'));
  it('expiry applies to enrolment codes only: device_token expire is invalid', () =>
    expectInvalid(() => credentialNext('active', 'expire', 'device_token')));
  it('only enrolment codes are redeemed: device_token redeem is invalid', () =>
    expectInvalid(() => credentialNext('active', 'redeem', 'device_token')));
  const terminal: S[] = ['used', 'expired', 'revoked'];
  it.each(terminal.flatMap((s) => ACTIONS.map((a) => [s, a] as const)))(
    'terminal %s --%s--> invalid_transition',
    (from, action) => {
      expectInvalid(() => credentialNext(from, action, 'enrolment_code'));
    },
  );
});

describe('agent command machine (§2.5)', () => {
  type S = 'queued' | 'delivered' | 'completed' | 'failed' | 'expired';
  type A = 'deliver' | 'complete' | 'fail' | 'expire';
  const STATES: S[] = ['queued', 'delivered', 'completed', 'failed', 'expired'];
  const ACTIONS: A[] = ['deliver', 'complete', 'fail', 'expire'];
  const allowed: Row<S, A>[] = [
    ['queued', 'deliver', 'delivered'],
    ['delivered', 'complete', 'completed'],
    ['delivered', 'fail', 'failed'],
    ['queued', 'expire', 'expired'],
    ['delivered', 'expire', 'expired'],
  ];
  it.each(allowed)('%s --%s--> %s', (from, action, to) => {
    expect(commandNext(from as S, action)).toBe(to);
  });
  // delivered --deliver--> delivered (re-send on each heartbeat) is deliberately left unspecified here.
  const forbidden = STATES.flatMap((s) => ACTIONS.map((a) => [s, a] as const))
    .filter(([s, a]) => !allowed.some(([f, x]) => f === s && x === a))
    .filter(([s, a]) => !(s === 'delivered' && a === 'deliver'));
  it('forbidden set size (matrix sanity)', () => expect(forbidden.length).toBe(14));
  it.each(forbidden)('%s --%s--> invalid_transition', (from, action) => {
    expectInvalid(() => commandNext(from, action));
  });
  it('a result cannot arrive for a command that was never delivered', () =>
    expectInvalid(() => commandNext('queued', 'complete')));
});
